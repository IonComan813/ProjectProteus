// 给页面提供的少数几个原生功能（页面本身仍然没有 Node.js，只能调用这里列出的）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proteusDesktop', {
  // 下载更新的安装包：先让用户选择保存位置，选好后才开始下载，完成后问是否关闭软件并运行安装程序。
  // 返回 'started'、'cancelled'（取消了保存）或 false（没有开始）
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  // 下载进度：callback({ state: 'progress' | 'done' | 'failed' | 'cancelled', percent })
  onUpdateDownload: (callback) => {
    ipcRenderer.on('update-download', (_e, info) => callback(info));
  },
});
