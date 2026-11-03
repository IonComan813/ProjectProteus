// 给页面提供的少数几个原生功能（页面本身仍然没有 Node.js，只能调用这里列出的）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proteusDesktop', {
  // 下载更新的安装包（不问保存位置）。返回 'started' 或 false（没有开始）
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  // 停止正在进行的下载（进度条上的 ×，或者太久没有收到数据）
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  // 安装下载好的更新（Windows 安装版静默安装后启动新版本，软件随即关闭）。返回 true 表示已经开始
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // 下载进度和结果：callback({ state: 'progress', received, total }) / ({ state: 'done', kind }) / ({ state: 'failed' | 'aborted' })
  onUpdateDownload: (callback) => {
    ipcRenderer.on('update-download', (_e, info) => callback(info));
  },
});
