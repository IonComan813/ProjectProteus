// Electron 桌面版的入口：用自带的 Chromium 内核打开 index.html。
// 页面本身和浏览器版完全相同；这里只负责窗口、安全设置，以及去掉跨域限制。

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 只允许打开一个窗口：再次启动时把已有窗口调到前面
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Proteus',
    backgroundColor: '#15161a',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      // 页面里不需要 Node.js，全部关掉，和普通网页一样安全
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(ROOT, 'index.html'));

  // 消息里的链接、底部的项目网址：用系统默认浏览器打开，不在软件窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    if (isWebUrl(url)) shell.openExternal(url);
  });

  // F12 打开开发者工具（排查问题用）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('closed', () => { win = null; });
}

// 去掉跨域限制：浏览器会拦截不允许网页直接访问的接口（部分中转站就是这样）。
// 桌面版里，主页面发出的请求一律放行。消息显示用的沙箱小窗口不在此列。
const CORS_HEADERS = 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, '
  + 'anthropic-dangerous-direct-browser-access, x-title, http-referer';

function fromMainPage(details) {
  return !!win && details.webContentsId === win.webContents.id
    && (!details.frame || details.frame === win.webContents.mainFrame);
}

function allowCors() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!fromMainPage(details)) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!k.toLowerCase().startsWith('access-control-allow-')) headers[k] = v;
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = [CORS_HEADERS];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
    const result = { responseHeaders: headers };
    // 跨域预检请求（OPTIONS）如果被接口拒绝，也当作通过
    if (details.method === 'OPTIONS' && (details.statusCode < 200 || details.statusCode >= 300)) {
      result.statusLine = 'HTTP/1.1 204 No Content';
    }
    callback(result);
  });
}

// macOS 需要“编辑”菜单，复制粘贴快捷键才能用；其他系统不显示菜单栏
function setupMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  setupMenu();
  allowCors();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
