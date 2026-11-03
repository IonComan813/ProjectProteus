package io.github.ioncoman813.proteus;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用自己的原生功能：在软件里下载更新并打开安装界面（UpdateDownloaderPlugin）
        registerPlugin(UpdateDownloaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
