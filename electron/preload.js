// 给页面提供的少数几个原生功能（页面本身仍然没有 Node.js，只能调用这里列出的）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proteusDesktop', {
  // 下载更新的安装包：先让用户选择保存位置，选好后才开始下载，完成后问是否关闭软件并运行安装程序。
  // 返回 'started'、'cancelled'（取消了保存）或 false（没有开始）
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  // 停止正在进行的下载（进度条上的 ×，或者太久没有收到数据）
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  // 下载进度和结果：callback({ state: 'progress', received, total }) / ({ state: 'done' | 'failed' | 'aborted' })
  onUpdateDownload: (callback) => {
    ipcRenderer.on('update-download', (_e, info) => callback(info));
  },
});
