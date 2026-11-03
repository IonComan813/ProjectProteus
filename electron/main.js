// Windows / macOS / Linux 原生应用（Electron）的入口：用自带的 Chromium 内核打开 index.html。
// 页面本身和浏览器版完全相同；这里只负责窗口、安全设置，以及去掉跨域限制。

const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
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

// ---- 下载更新 ----
// 页面（js/update.js）请求下载某个安装包时：先让用户选择保存位置，选好后才开始下载，任务栏显示进度，
// 下载完成后按安装包的类型问用户：关闭软件并运行安装程序（Windows 安装版）、打开 dmg（macOS）、
// 启动新的 AppImage（Linux），或者打开所在文件夹（Windows 免安装版的 zip，需要自己解压替换）。
const UPDATE_TEXT = {
  'zh-CN': {
    save: '保存更新安装包', later: '稍后',
    exe: ['安装程序已下载。现在关闭 Proteus 并运行安装程序吗？', '关闭并安装'],
    dmg: ['安装包已下载。现在关闭 Proteus 并打开它吗？打开后把 Proteus 拖进「应用程序」文件夹，替换旧版本即可。', '关闭并打开'],
    appimage: ['新版本已下载。现在关闭 Proteus 并启动新版本吗？之后可以删除旧的 AppImage 文件。', '关闭并启动新版本'],
    zip: ['免安装版已下载。关闭 Proteus 后解压，用新的文件夹替换旧的即可，对话和设定不受影响。', '打开所在文件夹'],
  },
  'zh-TW': {
    save: '儲存更新安裝檔', later: '稍後',
    exe: ['安裝程式已下載。現在關閉 Proteus 並執行安裝程式嗎？', '關閉並安裝'],
    dmg: ['安裝檔已下載。現在關閉 Proteus 並開啟它嗎？開啟後把 Proteus 拖進「應用程式」檔案夾，取代舊版本即可。', '關閉並開啟'],
    appimage: ['新版本已下載。現在關閉 Proteus 並啟動新版本嗎？之後可以刪除舊的 AppImage 檔案。', '關閉並啟動新版本'],
    zip: ['免安裝版已下載。關閉 Proteus 後解壓縮，用新的資料夾取代舊的即可，對話和設定不受影響。', '開啟所在資料夾'],
  },
  en: {
    save: 'Save the update', later: 'Later',
    exe: ['The installer has been downloaded. Close Proteus and run it now?', 'Close and install'],
    dmg: ['The installer has been downloaded. Close Proteus and open it now? Then drag Proteus into the Applications folder to replace the old version.', 'Close and open'],
    appimage: ['The new version has been downloaded. Close Proteus and start the new version now? You can delete the old AppImage afterwards.', 'Close and start'],
    zip: ['The portable version has been downloaded. After closing Proteus, unzip it and replace the old folder with the new one; your conversations and settings are not affected.', 'Show in folder'],
  },
  ja: {
    save: '更新ファイルを保存', later: 'あとで',
    exe: ['インストーラーをダウンロードしました。Proteus を閉じてインストーラーを実行しますか？', '閉じてインストール'],
    dmg: ['インストーラーをダウンロードしました。Proteus を閉じて開きますか？開いたら Proteus を「アプリケーション」フォルダにドラッグして、古いバージョンと置き換えてください。', '閉じて開く'],
    appimage: ['新しいバージョンをダウンロードしました。Proteus を閉じて新しいバージョンを起動しますか？古い AppImage はあとで削除できます。', '閉じて起動'],
    zip: ['ポータブル版をダウンロードしました。Proteus を閉じてから展開し、古いフォルダを新しいフォルダに置き換えてください。会話と設定はそのまま残ります。', 'フォルダを表示'],
  },
};
const updateText = () => UPDATE_TEXT[pageLang] || UPDATE_TEXT['zh-CN'];

const pendingUpdates = new Map(); // 页面请求下载、还没开始的安装包：地址 → 用户选好的保存位置
const stoppedUpdates = new Set(); // 还没开始下载就被停止的安装包地址：之后开始了也立刻取消
let activeUpdate = null; // 正在下载的安装包（DownloadItem）
let updateFinished = true; // 这次下载是否已经把结果告诉了页面（每次下载只告诉一次）

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
  sendUpdateState({ state });
}

// 下载完成后问是否关闭软件并运行安装程序。运行失败时不提示（安全软件一般会自己提示），软件也不关闭，
// 用户可以自己到保存的文件夹里打开安装包
async function afterUpdateDownload(file) {
  const text = updateText();
  const ext = path.extname(file).toLowerCase();
  const kind = ext === '.exe' ? 'exe' : ext === '.dmg' ? 'dmg' : ext === '.appimage' ? 'appimage' : 'zip';
  const [message, action] = text[kind];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', message, buttons: [action, text.later], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;
  if (kind === 'zip') {
    shell.showItemInFolder(file);
    return;
  }
  try {
    if (kind === 'appimage') {
      fs.chmodSync(file, 0o700); // 只给自己读、写、运行的权限：启动新版本不需要让其他用户也能运行
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const error = await shell.openPath(file);
      if (error) return;
    }
  } catch (_) {
    return;
  }
  app.quit();
}

function setupUpdateDownloads() {
  // 先让用户选好保存位置，再开始下载（不用 Electron 默认的做法：那样会一边弹“另存为”一边已经在下载）。
  // 返回 'started'（开始下载）、'cancelled'（用户取消了保存）或 false（请求不合规定）。
  // 下载的进度和结果通过 update-download 消息告诉页面：progress（已收到 / 总字节数）、done、failed、aborted
  ipcMain.handle('download-update', async (e, url) => {
    // 只接受这个窗口的请求（preload 只在主页面里运行，消息显示用的沙箱小窗口调用不到），而且只下载 https 地址上的安装包
    if (!win || e.sender.id !== win.webContents.id) return false;
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+\.(exe|zip|dmg|AppImage)$/i.test(url)) return false;
    if (!updateFinished) return false; // 同一时间只下载一个
    let name;
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch (_) { return false; }
    const ext = path.extname(name).slice(1);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: updateText().save,
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: ext, extensions: [ext] }],
    });
    if (canceled || !filePath) return 'cancelled';
    pendingUpdates.clear();
    stoppedUpdates.delete(url);
    pendingUpdates.set(url, filePath);
    updateFinished = false;
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

  session.defaultSession.on('will-download', (_e, item) => {
    const url = item.getURLChain()[0] || item.getURL();
    if (stoppedUpdates.delete(url)) { item.cancel(); return; } // 页面已经停止的那次下载（停止时还没开始）
    if (!pendingUpdates.has(url)) return; // 其他下载（例如导出备份）照常处理
    item.setSavePath(pendingUpdates.get(url)); // 用户已经选好的位置：不再弹“另存为”
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
        finishUpdate('done', item);
        void afterUpdateDownload(item.getSavePath());
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
