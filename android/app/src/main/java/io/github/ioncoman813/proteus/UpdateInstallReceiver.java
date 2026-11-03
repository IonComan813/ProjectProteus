package io.github.ioncoman813.proteus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/**
 * 接收系统安装更新（UpdateDownloaderPlugin.install）的结果。
 * 需要用户确认时（第一次由海神自己安装、安卓 12 以下，或者还没允许海神「安装未知应用」），打开系统的确认界面。
 * 安装成功时系统会关闭并替换软件；失败或用户取消时不提示（软件照常运行，用户可以到 GitHub Release 页面手动下载）。
 */
public class UpdateInstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) return;
        Intent confirm = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
            : intent.getParcelableExtra(Intent.EXTRA_INTENT);
        if (confirm == null) return;
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(confirm);
        } catch (Exception ignored) {
            // 打不开确认界面：不提示
        }
    }
}
