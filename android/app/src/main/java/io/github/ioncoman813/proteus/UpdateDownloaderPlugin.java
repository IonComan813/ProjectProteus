package io.github.ioncoman813.proteus;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 在软件里下载更新的安装包（apk），下载完成后直接安装。
 * 页面（js/update.js）调用：
 *   download({ url, fileName }) → { state: 'done' | 'failed' | 'aborted' }，下载过程中发出 progress 事件 { received, total }
 *   cancel()   停止正在进行的下载（进度条上的 ×，或者页面判断太久没有收到数据）
 *   install()  用系统的 PackageInstaller 安装刚下载好的 apk。安装包交给系统后马上删掉。
 *              安卓 12 及以上：海神自己装过一次以后（第一次是从浏览器或文件管理器装的，需要用户在系统界面确认），
 *              之后的更新不再需要确认，直接安装。需要确认时系统会弹出安装界面（UpdateInstallReceiver）；
 *              还没允许海神「安装未知应用」时，系统会先引导用户去允许。安装时系统会关闭软件。
 * 安装包放在应用自己的缓存文件夹里（cache/updates），每次下载前和每次启动时清掉旧的。只接受 https 地址。
 */
@CapacitorPlugin(name = "UpdateDownloader")
public class UpdateDownloaderPlugin extends Plugin {

    private volatile boolean cancelled = false;
    private volatile HttpURLConnection connection = null;
    private volatile boolean running = false;
    private File downloaded = null;

    @Override
    public void load() {
        // 启动时清掉上次留下的安装包
        File[] old = updatesDir().listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    private File updatesDir() {
        return new File(getContext().getCacheDir(), "updates");
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "update.apk");
        if (url == null || !url.startsWith("https://") || !fileName.matches("[A-Za-z0-9._-]+\\.apk")) {
            call.reject("bad request");
            return;
        }
        if (running) {
            call.reject("busy");
            return;
        }
        running = true;
        cancelled = false;
        downloaded = null;
        new Thread(() -> {
            File dir = updatesDir();
            File part = new File(dir, fileName + ".part");
            File target = new File(dir, fileName);
            String state;
            try {
                // 清掉以前下载的安装包
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("cannot create " + dir);

                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                connection = c;
                c.setConnectTimeout(30000);
                c.setReadTimeout(60000);
                c.setInstanceFollowRedirects(true);
                if (cancelled) throw new Exception("cancelled");
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                long total = c.getContentLengthLong();
                long received = 0;
                long lastSent = 0;
                byte[] buf = new byte[64 * 1024];
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (cancelled) throw new Exception("cancelled");
                        out.write(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent >= 300) { // 不要太频繁地通知页面
                            lastSent = now;
                            sendProgress(received, total);
                        }
                    }
                }
                if (cancelled) throw new Exception("cancelled");
                if (total > 0 && received != total) throw new Exception("incomplete");
                sendProgress(received, total);
                if (!part.renameTo(target)) throw new Exception("rename failed");
                downloaded = target;
                state = "done";
            } catch (Exception e) {
                part.delete();
                state = cancelled ? "aborted" : "failed";
            } finally {
                HttpURLConnection c = connection;
                connection = null;
                if (c != null) c.disconnect();
                running = false;
            }
            JSObject result = new JSObject();
            result.put("state", state);
            call.resolve(result);
        }).start();
    }

    private void sendProgress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", total > 0 ? total : 0);
        notifyListeners("progress", p);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        // 断开连接，让卡在连接或读取上的下载线程马上结束
        HttpURLConnection c = connection;
        if (c != null) new Thread(c::disconnect).start();
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        File f = downloaded;
        if (f == null || !f.isFile()) {
            call.reject("no file");
            return;
        }
        Context ctx = getContext();
        PackageInstaller.Session session = null;
        try {
            PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(ctx.getPackageName());
            if (Build.VERSION.SDK_INT >= 31) {
                // 海神是上一个版本的安装者（或者正在更新自己）时，不需要用户确认
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            }
            int id = installer.createSession(params);
            session = installer.openSession(id);
            try (InputStream in = new FileInputStream(f); OutputStream out = session.openWrite("base.apk", 0, f.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                session.fsync(out);
            }
            Intent result = new Intent(ctx, UpdateInstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(ctx, id, result, flags);
            session.commit(pending.getIntentSender());
            session.close();
            session = null;
            // 安装包已经整个交给系统，可以删了
            f.delete();
            downloaded = null;
            call.resolve();
        } catch (Exception e) {
            if (session != null) session.abandon();
            call.reject(e.getMessage());
        }
    }
}
