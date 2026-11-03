package io.github.ioncoman813.proteus;

import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 在软件里下载更新的安装包（apk），下载完成后打开系统的安装界面。
 * 页面（js/update.js）调用：
 *   download({ url, fileName }) → { state: 'done' | 'failed' | 'aborted' }，下载过程中发出 progress 事件 { received, total }
 *   cancel()   停止正在进行的下载（进度条上的 ×，或者页面判断太久没有收到数据）
 *   install()  打开系统的安装界面，安装刚下载好的 apk
 * 安装包放在应用自己的缓存文件夹里（cache/updates），每次下载前清掉旧的。只接受 https 地址。
 */
@CapacitorPlugin(name = "UpdateDownloader")
public class UpdateDownloaderPlugin extends Plugin {

    private volatile boolean cancelled = false;
    private volatile HttpURLConnection connection = null;
    private volatile boolean running = false;
    private File downloaded = null;

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
            File dir = new File(getContext().getCacheDir(), "updates");
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
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
