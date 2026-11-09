// Windows / macOS / Linux 原生应用（Electron）的入口：用自带的 Chromium 内核打开 index.html。
// 页面本身和浏览器版完全相同；这里只负责窗口、安全设置，以及去掉跨域限制。

const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 数据文件夹固定叫 Proteus，不跟随程序显示名（海神Proteus）变化，以后改名也不会“丢”数据。
// 启动时用 --user-data-dir 指定了别的文件夹（例如便携使用）时，以指定的为准。
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Proteus'));
}

// 只允许打开一个窗口：再次启动时把已有窗口调到前面（见文件末尾的 second-instance）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let pageLang = 'zh-CN'; // 页面当前的界面语言，用于下面的确认框

// 生成回复时页面会拦下关闭（beforeunload）。浏览器会弹确认框，Electron 不会，
// 点关闭就毫无反应，所以由这里来问。
const LEAVE_TEXT = {
  'zh-CN': { message: '模型正在生成回复，关闭后这条回复会丢失。', buttons: ['仍要关闭', '取消'] },
  'zh-TW': { message: '模型正在產生回覆，關閉後這則回覆會遺失。', buttons: ['仍要關閉', '取消'] },
  en: { message: 'The model is still writing a reply. It will be lost if you close now.', buttons: ['Close anyway', 'Cancel'] },
  ja: { message: 'モデルが返信を生成中です。閉じるとこの返信は失われます。', buttons: ['閉じる', 'キャンセル'] },
};

// 操作系统的首选语言（例如 zh-Hans-CN、en-US、ja-JP）。比 Chromium 内核自己的语言设置更准确
function systemLanguage() {
  const langs = app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages() : [];
  return langs[0] || app.getLocale() || '';
}

// 检查更新时要知道下载哪个安装包：处理器架构（Apple 芯片上用 Rosetta 运行 Intel 版时也算 arm64）
function cpuArch() {
  return process.arch === 'x64' && app.runningUnderARM64Translation ? 'arm64' : process.arch;
}

// Windows 免安装版（zip）：安装版的程序目录里有卸载程序 Uninstall 海神Proteus.exe，免安装版没有
function isPortable() {
  if (process.platform !== 'win32') return false;
  try {
    return !fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .*\.exe$/i.test(f));
  } catch (_) {
    return false;
  }
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: '海神Proteus', // 页面载入后换成当前语言的“Proteus角色扮演”
    backgroundColor: '#15161a',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      // 页面里不需要 Node.js，全部关掉，和普通网页一样安全
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'), // 只提供下载更新这一个原生功能
    },
  });

  // 版本号通过网址参数传给页面，显示在输入框下方的开源声明里。
  // 系统语言也一起传过去：还没在设置里选过界面语言时，页面按它自动选择
  win.loadFile(path.join(ROOT, 'index.html'), {
    query: {
      version: app.getVersion(),
      syslang: systemLanguage(),
      platform: process.platform,
      arch: cpuArch(),
      portable: isPortable() ? '1' : '',
    },
  });

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

  win.webContents.on('will-prevent-unload', (e) => {
    const text = LEAVE_TEXT[pageLang] || LEAVE_TEXT['zh-CN'];
    const choice = dialog.showMessageBoxSync(win, { type: 'question', message: text.message, buttons: text.buttons, defaultId: 1, cancelId: 1 });
    if (choice === 0) e.preventDefault(); // 忽略页面的拦截，照常关闭
  });
  // 切换界面语言时页面标题会变，顺便记下当前语言
  win.webContents.on('page-title-updated', () => {
    win.webContents.executeJavaScript('document.documentElement.lang').then((l) => { pageLang = l; }).catch(() => {});
  });

  // F12 打开开发者工具（排查问题用）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('closed', () => { win = null; });
}

// 去掉跨域限制：浏览器会拦截不允许网页直接访问的接口（部分中转站就是这样）。
// 原生应用里，主页面发出的请求一律放行。消息显示用的沙箱小窗口不在此列。
const CORS_HEADERS = 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, '
  + 'anthropic-dangerous-direct-browser-access, x-title, http-referer, x-openrouter-title';

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
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS']; // GitHub 同步要用 PATCH（js/sync.js）
    const result = { responseHeaders: headers };
    // 跨域预检请求（OPTIONS）如果被接口拒绝，也当作通过
    if (details.method === 'OPTIONS' && (details.statusCode < 200 || details.statusCode >= 300)) {
      result.statusLine = 'HTTP/1.1 204 No Content';
    }
    callback(result);
  });
}

// ---- 下载更新 ----
// 页面（js/update.js）请求下载某个安装包时直接开始下载，不问保存位置：
//   Windows 安装版（exe）、Linux（AppImage）放在软件数据文件夹的 updates 里，装好后（下次启动时）删掉；
//   macOS（dmg）和 Windows 免安装版（zip）要用户自己替换，放在「下载」文件夹里。
// 任务栏显示进度。下载完成后告诉页面，页面在没有正在生成的回复时调用 install-update：
//   Windows 安装版：关闭软件，静默运行安装程序（/S --updated --force-run）。安装程序按注册表里上次的安装位置和方式
//     （只给自己 / 所有用户）安装到原来的文件夹，不再显示协议和选项页面，装好后自动启动新版本。
//     装在「所有用户」时 Windows 仍会弹出管理员权限确认。
//   Linux（AppImage）：用新文件替换正在运行的 AppImage（同一个路径），启动新版本后关闭软件。
//   macOS（dmg）：打开安装包后关闭软件，由用户把 Proteus 拖进「应用程序」替换旧版本。
//   Windows 免安装版（zip）：打开所在文件夹，由用户关闭软件后解压替换。
// 运行安装程序失败时不提示（安全软件一般会自己提示），软件也不关闭。
const pendingUpdates = new Map(); // 页面请求下载、还没开始的安装包：地址 → 保存位置
const stoppedUpdates = new Set(); // 还没开始下载就被停止的安装包地址：之后开始了也立刻取消
let activeUpdate = null; // 正在下载的安装包（DownloadItem）
let updateFinished = true; // 这次下载是否已经把结果告诉了页面（每次下载只告诉一次）
let downloadedUpdate = null; // 下载好、等着安装的文件

const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const updateKind = (file) => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.exe' ? 'exe' : ext === '.dmg' ? 'dmg' : ext === '.appimage' ? 'appimage' : 'zip';
};

function sendUpdateState(info) {
  if (win) win.webContents.send('update-download', info);
}

// 这次下载结束：清掉任务栏进度，把结果（done / failed / aborted）告诉页面。
// item 是发出结果的那个下载：已经不是当前这次的（例如停止后才收到它的结束事件）就不理会
function finishUpdate(state, item = activeUpdate) {
  if (updateFinished || item !== activeUpdate) return;
  updateFinished = true;
  activeUpdate = null;
  if (win) win.setProgressBar(-1);
  sendUpdateState(state === 'done' ? { state, kind: updateKind(downloadedUpdate) } : { state });
}

// 启动一个程序（不等它结束）。真正启动了返回 true；被拦下（例如安全软件不让运行）返回 false，不会让主进程出错
function launch(file, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      child.once('spawn', () => { child.unref(); resolve(true); });
      child.once('error', () => resolve(false));
    } catch (_) {
      resolve(false);
    }
  });
}

// 安装下载好的更新（见上面的说明）。返回 true 表示已经开始安装（免安装版是已经打开文件夹），软件马上关闭；
// 返回 false 表示没能开始（不提示，软件也不关闭）
async function installDownloadedUpdate() {
  const file = downloadedUpdate;
  if (!file || !fs.existsSync(file)) return false;
  const kind = updateKind(file);
  if (kind === 'zip') {
    shell.showItemInFolder(file);
    return true; // 免安装版：软件不关闭，用户自己关闭后解压替换
  }
  let started = false;
  if (kind === 'exe') {
    started = await launch(file, ['--updated', '/S', '--force-run']);
  } else if (kind === 'dmg') {
    started = !(await shell.openPath(file));
  } else {
    const current = process.env.APPIMAGE; // 正在运行的 AppImage 的路径
    let target = file;
    if (current && fs.existsSync(current)) {
      try {
        // 先复制到同一个文件夹，再改名替换（改名是一步完成的；正在运行的旧文件不受影响）
        const next = current + '.new';
        fs.copyFileSync(file, next);
        fs.chmodSync(next, (fs.statSync(current).mode & 0o777) | 0o700);
        fs.renameSync(next, current);
        fs.rmSync(file, { force: true });
        target = current;
      } catch (_) {
        target = file; // 原来的文件夹写不进去：直接运行下载的新版本
      }
    }
    try { if (target === file) fs.chmodSync(file, 0o700); } catch (_) { /* 运行时会失败 */ }
    started = await launch(target, []);
  }
  if (!started) return false;
  downloadedUpdate = null;
  setTimeout(() => app.quit(), 300);
  return true;
}

// 启动后清理 updates 文件夹里上次留下的安装包（安装程序可能还没退出，删不掉就等下次）
function cleanUpdates() {
  setTimeout(() => {
    if (!updateFinished || downloadedUpdate) return;
    let names = [];
    try { names = fs.readdirSync(updatesDir()); } catch (_) { return; }
    for (const name of names) {
      try { fs.rmSync(path.join(updatesDir(), name), { force: true }); } catch (_) { /* 下次再删 */ }
    }
  }, 20000);
}

function setupUpdateDownloads() {
  cleanUpdates();
  // 开始下载。返回 'started' 或 false（请求不合规定、已经在下载）。
  // 下载的进度和结果通过 update-download 消息告诉页面：progress（已收到 / 总字节数）、done（附带安装包类型）、failed、aborted
  ipcMain.handle('download-update', (e, url) => {
    // 只接受这个窗口的请求（preload 只在主页面里运行，消息显示用的沙箱小窗口调用不到），而且只下载 https 地址上的安装包
    if (!win || e.sender.id !== win.webContents.id) return false;
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+\.(exe|zip|dmg|AppImage)$/i.test(url)) return false;
    if (!updateFinished) return false; // 同一时间只下载一个
    let name;
    try { name = path.basename(decodeURIComponent(new URL(url).pathname)); } catch (_) { return false; }
    const kind = updateKind(name);
    const dir = kind === 'exe' || kind === 'appimage' ? updatesDir() : app.getPath('downloads');
    const filePath = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(filePath, { force: true });
    } catch (_) {
      return false;
    }
    pendingUpdates.clear();
    stoppedUpdates.delete(url);
    pendingUpdates.set(url, filePath);
    updateFinished = false;
    downloadedUpdate = null;
    win.webContents.downloadURL(url);
    return 'started';
  });

  // 停止下载：用户点了进度条上的 ×，或者页面判断太久没有收到数据（超时）。
  // 还没真正开始下载（服务器一直没有回应）时也算停止：之后就算开始了也立刻取消
  ipcMain.handle('cancel-update', (e) => {
    if (!win || e.sender.id !== win.webContents.id) return;
    for (const url of pendingUpdates.keys()) stoppedUpdates.add(url);
    pendingUpdates.clear();
    const item = activeUpdate;
    finishUpdate('aborted');
    if (item) item.cancel();
  });

  // 开源协议的原文（首次打开时的协议说明用；页面是 file:// 打开的，自己读不了文件）
  ipcMain.handle('license-text', (e) => {
    if (!win || e.sender.id !== win.webContents.id) return '';
    try { return fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'); } catch (_) { return ''; }
  });

  // GitHub 同步的登录凭据：用系统的钥匙串（Windows DPAPI、macOS 钥匙串、Linux 的密钥服务）加密后由页面保存。
  // 系统不提供时返回 null，页面改用自己的办法（js/sync.js 的 TokenVault）
  ipcMain.handle('secure-encrypt', (e, text) => {
    if (!win || e.sender.id !== win.webContents.id || typeof text !== 'string') return null;
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null; } catch (_) { return null; }
  });
  ipcMain.handle('secure-decrypt', (e, b64) => {
    if (!win || e.sender.id !== win.webContents.id || typeof b64 !== 'string') return null;
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch (_) { return null; }
  });

  // 横屏艺术图：按图片比例调整窗口内容区的大小（页面先问过用户）。全屏时不调整；最大化时先还原。
  // 调整后窗口超出屏幕的工作区时移回来。返回 true 表示已经调整
  ipcMain.handle('fit-window', (e, width, height) => {
    if (!win || e.sender.id !== win.webContents.id) return false;
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!(w >= 200 && w <= 20000 && h >= 200 && h <= 20000)) return false;
    if (win.isFullScreen()) return false;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w, h);
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    const x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
    const y = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
    if (x !== b.x || y !== b.y) win.setPosition(x, y);
    return true;
  });

  // 安装下载好的更新：页面显示「下载完成，正在启动安装程序…」，等没有正在生成的回复、保存好对话后调用
  ipcMain.handle('install-update', (e) => {
    if (!win || e.sender.id !== win.webContents.id) return false;
    return installDownloadedUpdate();
  });

  session.defaultSession.on('will-download', (_e, item) => {
    const url = item.getURLChain()[0] || item.getURL();
    if (stoppedUpdates.delete(url)) { item.cancel(); return; } // 页面已经停止的那次下载（停止时还没开始）
    if (!pendingUpdates.has(url)) return; // 其他下载（例如导出备份）照常处理
    item.setSavePath(pendingUpdates.get(url)); // 不弹「另存为」
    pendingUpdates.delete(url);
    activeUpdate = item;
    item.on('updated', (_ev, state) => {
      // 网络出错时内核会自动重试几次，都失败后停在 interrupted（不会发出 done）：当作下载失败，删掉没下完的文件
      if (state === 'interrupted') {
        finishUpdate('failed', item); // 先记下失败：cancel() 会马上发出 done（cancelled）
        item.cancel();
        return;
      }
      if (state !== 'progressing' || updateFinished || item !== activeUpdate) return;
      const total = item.getTotalBytes();
      const received = item.getReceivedBytes();
      if (win) win.setProgressBar(total ? received / total : 2); // 2 = 不确定进度
      sendUpdateState({ state: 'progress', received, total });
    });
    item.once('done', (_ev, state) => {
      if (state === 'completed') {
        downloadedUpdate = item.getSavePath();
        finishUpdate('done', item);
      } else {
        finishUpdate(state === 'cancelled' ? 'aborted' : 'failed', item); // 例如服务器或安全软件拒绝（HTTP 403）
      }
    });
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

// 已经有一个在运行时，这个实例直接退出，不再建窗口
if (gotLock) {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    setupMenu();
    allowCors();
    setupUpdateDownloads();
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
