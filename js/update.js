// 检查更新（只在原生应用里：电脑版和安卓版）。
//
// 打包工作流在发布版本时，把安装包和一个 version.json 上传到更新服务器（Cloudflare R2），分两个频道：
//   <UPDATE_BASE_URL>/stable/version.json   正式版（标签不带后缀，例如 v0.4.0）
//   <UPDATE_BASE_URL>/beta/version.json     测试版（标签带后缀，例如 v0.4.0-beta.1）
// 两个频道各自只保留最新的一个版本，互不覆盖。version.json 的内容：
//   { version, tag, date, release（GitHub Release 页面）, files: { 'win-setup', 'win-zip', 'mac-arm64', 'mac-x64', 'linux', 'android' } }
// files 里是安装包的文件名，和 version.json 放在同一个目录里。
//
// 软件启动时立刻读取这两个文件：正式版比当前版本新就提示；测试版比当前版本新、也比正式版新才提示。
// 两个都有时在同一个窗口里列出，由用户选择下载哪个、稍后提醒或跳过这些版本。
// 提示窗口一拿到版本信息就显示，盖在其他窗口和弹窗上面；正在生成回复时也显示，回复照常继续。
// 电脑版在软件里下载（可以选择保存位置，完成后问是否关闭软件并运行安装程序）；安卓版用系统浏览器下载。
// 网页版不检查（没有安装包可更新）。

// 更新服务器的地址（结尾不带 /）。仓库里是空的（不检查更新）；打包工作流用仓库变量 UPDATE_BASE_URL 填进来
const UPDATE_BASE_URL = '';

// 比较两个版本号（语义化版本，开头的 v 可有可无）：a 比 b 新返回正数，旧返回负数，相同返回 0。
// 带后缀的是预发布版，比同一个版本号的正式版旧：0.4.0-beta.2 < 0.4.0 < 0.4.1-beta.1。
// 后缀按 . 分段比较：都是数字的按数值（beta.10 比 beta.9 新），否则按字符；数字段比文字段旧；前面都相同时段数少的旧。
// 认不出的版本号返回 NaN
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
    return m && { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // 没有后缀的（正式版）更新
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

// 打包工作流（node）也用这个函数比较版本号
if (typeof module !== 'undefined' && module.exports) module.exports = { compareVersions };

// 这台设备该下载哪个安装包（version.json 里 files 的键名）；不认识的平台返回 null
function updateFileKey() {
  if (typeof NATIVE !== 'undefined' && NATIVE) return 'android';
  // 电脑版：主进程通过网址参数告诉页面操作系统、处理器架构和是不是免安装版
  const q = new URLSearchParams(location.search);
  const platform = q.get('platform');
  if (platform === 'win32') return q.get('portable') ? 'win-zip' : 'win-setup';
  if (platform === 'darwin') return q.get('arch') === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return 'linux';
  return null;
}

async function fetchUpdateManifest(channel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // 加上时间参数，避免读到缓存里的旧文件
    const res = await fetch(`${UPDATE_BASE_URL}/${channel}/version.json?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    if (res.status === 404) return null; // 这个频道还没有发布过
    if (!res.ok) return 'error';
    const m = await res.json();
    return m && typeof m.version === 'string' && m.files && typeof m.files === 'object' ? { ...m, channel } : 'error';
  } catch (_) {
    return 'error'; // 连不上、超时或者内容不对
  } finally {
    clearTimeout(timer);
  }
}

// 稍后提醒和跳过的版本，保存在软件设置里：
//   updateSnooze.until：这个时间之前不提示（「一天后提醒」「三天后提醒」），期间出了更新的版本也不提示
//   updateSnooze.skip：{ stable, beta } 各频道跳过的版本（「跳过此版本」），只有更新的版本才再提示
// 另外 updateCheckedDay 记下最近一次「检查过、没有要提示的更新」是哪一天（本机日期，例如 2026-11-02）：
// 同一天里再启动软件不再检查，第二天第一次启动时再检查（按日期，不是满 24 小时），以减少对更新服务器的请求。
// 连不上服务器时不记，下次启动再试
function updateSnooze() {
  const z = state.settings.updateSnooze;
  return z && typeof z === 'object' ? z : {};
}
function setUpdateSnooze(z) {
  state.settings.updateSnooze = z;
  saveSettingsSoon();
}

// 启动时调用，不等读取数据：version 是取得当前版本号（写进 state.version）的 Promise，
// booted 是读取数据（第一次打开时还要同意开源协议）的 Promise。
// 是否需要检查（稍后提醒、今天是否已经检查过）直接从数据库里的设置判断，和读取数据同时请求更新服务器；
// 要显示提示、记下检查日期时才等数据读完（读取失败就不提示）
async function checkForUpdates(version, booted) {
  if (!UPDATE_BASE_URL || !IN_NATIVE_APP) return;
  const key = updateFileKey();
  if (!key) return;
  let saved;
  try {
    [saved] = await Promise.all([DB.get('settings'), version]);
  } catch (_) {
    return;
  }
  if (!state.version) return;
  const z = saved && saved.updateSnooze && typeof saved.updateSnooze === 'object' ? saved.updateSnooze : {};
  if (z.until && Date.now() < z.until) return;
  if (saved && saved.updateCheckedDay === localDay()) return;
  const found = await findUpdates(key, z.skip || {});
  try { await booted; } catch (_) { return; }
  if (!found.offers.length) {
    if (!found.failed) markUpdateChecked();
    return;
  }
  await offerUpdates(found.offers, key);
}

// 读取两个频道，返回 { offers: 要提示的版本, failed: 是否有频道没读到 }
async function findUpdates(key, skip) {
  const current = state.version;
  let [stable, beta] = await Promise.all([fetchUpdateManifest('stable'), fetchUpdateManifest('beta')]);
  const failed = stable === 'error' || beta === 'error';
  if (stable === 'error') stable = null;
  if (beta === 'error') beta = null;
  const wanted = (m) => m && m.files[key] && compareVersions(m.version, current) > 0
    && !(skip[m.channel] && !(compareVersions(m.version, skip[m.channel]) > 0));
  const offers = [];
  if (wanted(stable)) offers.push(stable);
  // 测试版还要比最新的正式版新（不论正式版是否被跳过）
  if (wanted(beta) && (!stable || compareVersions(beta.version, stable.version) > 0)) offers.push(beta);
  return { offers, failed };
}

// 记下今天已经检查过：同一天里再启动软件不再检查
function markUpdateChecked() {
  state.settings.updateCheckedDay = localDay();
  saveSettingsSoon();
}

// 显示更新提示，按用户的选择稍后提醒、跳过或下载
async function offerUpdates(offers, key) {
  const choice = await showUpdateDialog(state.version, offers);
  if (choice.remindDays) {
    setUpdateSnooze({ ...updateSnooze(), until: Date.now() + choice.remindDays * 24 * 3600 * 1000 });
    toast(t('update.remindSet', { days: choice.remindDays }));
  } else if (choice.skip) {
    const skipNow = { ...(updateSnooze().skip || {}) };
    for (const m of offers) skipNow[m.channel] = m.version;
    setUpdateSnooze({ ...updateSnooze(), until: 0, skip: skipNow });
    markUpdateChecked(); // 跳过以后也是第二天再检查
    toast(t('update.skipped'));
  } else if (choice.manifest) {
    await installUpdate(choice.manifest, key);
  }
}

// 下载选中的版本。下载完成（或交给了浏览器）：今天不再检查，装好新版本后当天再打开也不检查。
// 下载失败、超时或者用户点了 ×：弹窗让用户选择
//   再次检查更新：重新读取版本信息、再显示一次更新提示
//   前往 GitHub Release 页面手动下载：打开这个版本的 Release 页面，今天不再检查
//   下次启动时再检查更新：什么都不做
async function installUpdate(m, key) {
  const result = await downloadUpdate(`${UPDATE_BASE_URL}/${m.channel}/${encodeURIComponent(m.files[key])}`, m.version);
  if (result === 'done' || result === 'browser') return markUpdateChecked();
  const next = await showDownloadStopped(result === 'aborted');
  if (next === 'retry') {
    const found = await findUpdates(key, updateSnooze().skip || {});
    if (found.offers.length) return offerUpdates(found.offers, key);
    toast(t(found.failed ? 'update.recheckFailed' : 'update.upToDate'));
    if (!found.failed) markUpdateChecked();
  } else if (next === 'release') {
    openExternal(/^https:\/\//.test(m.release || '') ? m.release : `${PROJECT_URL}/releases`);
    markUpdateChecked();
  }
}

// 本机日期（年-月-日），用来判断今天是否已经检查过
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 必须选一个按钮才能关闭的窗口（#updateDialog）：更新提示和下载失败、中止的提示都用它。
// 盖在其他窗口和弹窗上面，不能操作下面的东西；Esc、点窗口外面、安卓返回键都关不掉它（Esc 只交给 onEsc，例如收起菜单）。
// Esc 在 window 的捕获阶段最先处理并且不再传下去：窗口下面已经打开的弹窗、列表、放大窗口、设置面板等都不会被它关掉。
// 关闭后下面的东西保持原样，焦点回到原来的位置。返回 close(value) 和 done（选好后 resolve(value) 的 Promise）
function openMandatoryDialog(title, message, onEsc) {
  els.updateTitle.textContent = title;
  els.updateMessage.textContent = message;
  els.updateMessage.hidden = !message;
  els.updateButtons.innerHTML = '';
  els.updateButtons.classList.remove('stacked');
  const prevFocus = document.activeElement;
  const cleanup = [];
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (onEsc) onEsc();
  };
  window.addEventListener('keydown', onKey, true);
  cleanup.push(() => window.removeEventListener('keydown', onKey, true));
  const close = (value) => {
    els.updateDialog.hidden = true;
    for (const f of cleanup) f();
    if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
    resolve(value);
  };
  const show = () => {
    els.updateDialog.hidden = false; // 安卓的返回键也不能关掉它（见 bindBackButton）
    // 焦点放在窗口本身、不放在按钮上：窗口可能在用户打字时突然出现，空格、回车不会误按到按钮。按 Tab 进入按钮
    els.updateBox.focus({ preventScroll: true });
  };
  return { close, done, show, cleanup };
}

// 更新提示窗口。按钮依次是：下载测试版 / 下载正式版（有哪个显示哪个）/「一天后提醒」（旁边的 ▾ 打开菜单：三天后提醒、跳过此版本）。
// 返回 { manifest } / { remindDays } / { skip: true }
function showUpdateDialog(current, offers) {
  const lines = offers.map((m) => t(m.channel === 'beta' ? 'update.lineBeta' : 'update.lineStable', { version: m.version }));
  const message = t('update.message', { current, list: lines.join('\n') })
    + (offers.some((m) => m.channel === 'beta') ? '\n\n' + t('update.betaNote') : '');
  let menu = null;
  let toggle = null;
  const closeMenu = () => { if (menu && !menu.hidden) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } };
  const dlg = openMandatoryDialog(t('update.title'), message, closeMenu);

  for (const m of offers.slice().reverse()) {
    const label = t(m.channel === 'beta' ? 'update.getBeta' : 'update.getStable', { version: m.version });
    els.updateButtons.appendChild(button(label, () => dlg.close({ manifest: m }), 'btn' + (m.channel === 'stable' ? ' btn-primary' : '')));
  }

  // 「一天后提醒 ▾」：左边直接选一天后提醒，右边的 ▾ 打开菜单
  const split = document.createElement('div');
  split.className = 'split-btn update-remind';
  split.appendChild(button(t('update.remind1'), () => dlg.close({ remindDays: 1 }), 'btn'));
  toggle = button('', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // 往下展开；下面放不下（例如手机横屏）时改为往上
    menu.classList.remove('drop-up');
    const below = window.innerHeight - split.getBoundingClientRect().bottom;
    menu.classList.toggle('drop-up', below < menu.offsetHeight + 8);
    menu.querySelector('.split-item').focus();
  }, 'btn split-toggle');
  toggle.innerHTML = '<span class="caret"></span>';
  toggle.title = t('update.remindMore');
  toggle.setAttribute('aria-label', t('update.remindMore'));
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  split.appendChild(toggle);
  menu = document.createElement('div');
  menu.className = 'split-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const [label, value] of [[t('update.remind3'), { remindDays: 3 }], [t('update.skip'), { skip: true }]]) {
    const item = button(label, () => dlg.close(value), 'split-item');
    item.setAttribute('role', 'menuitem');
    menu.appendChild(item);
  }
  split.appendChild(menu);
  els.updateButtons.appendChild(split);

  // 菜单打开时，点它以外的任何地方（包括这个窗口里的其他位置）都收起它；再点一次 ▾ 也收起
  const onOutside = (e) => { if (menu && !menu.hidden && !split.contains(e.target)) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } };
  document.addEventListener('pointerdown', onOutside, true);
  dlg.cleanup.push(() => document.removeEventListener('pointerdown', onOutside, true));
  dlg.show();
  return dlg.done;
}

// 下载失败、超时（标题「下载失败」）或者用户点了 ×（标题「下载手动中止」）后的窗口，必须选一个按钮。
// 返回 'retry'（再次检查更新）/ 'release'（前往 GitHub Release 页面手动下载）/ 'later'（下次启动时再检查更新）
function showDownloadStopped(byUser) {
  const dlg = openMandatoryDialog(t(byUser ? 'update.abortedTitle' : 'update.failedTitle'), byUser ? '' : t('update.failedMessage'));
  els.updateButtons.classList.add('stacked');
  for (const [label, value, cls] of [['update.retry', 'retry', ' btn-primary'], ['update.openRelease', 'release', ''], ['update.nextLaunch', 'later', ' btn-ghost']]) {
    els.updateButtons.appendChild(button(t(label), () => dlg.close(value), 'btn' + cls));
  }
  dlg.show();
  return dlg.done;
}

// 用系统浏览器打开网址（电脑版由 electron/main.js 交给系统浏览器，安卓版由 Capacitor 交给系统浏览器）
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- 下载安装包 ----
// 电脑版：在软件里下载，不问保存位置（electron/main.js）。
// 安卓版：在软件里下载到应用自己的缓存文件夹（UpdateDownloaderPlugin.java）。
// 都没有时（例如旧的安卓外壳）交给系统浏览器下载。
// 下载时屏幕上方显示进度条，右边的 × 可以停止下载。连续 UPDATE_STALL_MS 没有收到任何数据就当作超时、停止下载；
// 只是下载得慢（数据一直在来）不算超时。
// 下载完成后进度条那里显示「下载完成，正在启动安装程序…」，直接安装（见 startInstall），不再询问。
// 返回 'done'（下载完成）/ 'browser'（交给了浏览器）/ 'failed'（中断或超时）/ 'aborted'（用户点了 ×）
const UPDATE_STALL_MS = 60 * 1000;
let updateDownloader = null; // 正在进行的下载（watchDownload 返回的对象）
let desktopProgressBound = false;

async function downloadUpdate(url, version) {
  const desktop = window.proteusDesktop;
  const android = typeof NATIVE !== 'undefined' && NATIVE ? nativePlugin('UpdateDownloader') : null;
  if (desktop && desktop.downloadUpdate) {
    // 结果由主进程的 update-download 消息告诉页面：先注册好，再开始下载
    let finish;
    const ended = new Promise((r) => { finish = r; });
    let kind = 'exe';
    if (!desktopProgressBound) {
      desktopProgressBound = true;
      desktop.onUpdateDownload((info) => { if (updateDownloader) updateDownloader.onEvent(info); });
    }
    const dl = watchDownload(version, () => desktop.cancelUpdate(), (r, info) => { if (info && info.kind) kind = info.kind; finish(r); });
    updateDownloader = dl;
    if (await desktop.downloadUpdate(url) === 'started') {
      dl.begin();
      const result = await ended;
      if (result === 'done') void startInstall(kind, () => desktop.installUpdate());
      return result;
    }
    dl.stop();
  } else if (android && url.endsWith('.apk')) {
    let finish;
    const ended = new Promise((r) => { finish = r; });
    const dl = watchDownload(version, () => android.cancel(), finish);
    updateDownloader = dl;
    dl.begin();
    let listener = null;
    try {
      listener = await android.addListener('progress', (p) => dl.onEvent({ state: 'progress', received: p.received, total: p.total }));
      android.download({ url, fileName: decodeURIComponent(url.split('/').pop()) })
        .then((r) => dl.onEvent({ state: r && r.state === 'done' ? 'done' : r && r.state === 'aborted' ? 'aborted' : 'failed' }),
          () => dl.onEvent({ state: 'failed' }));
      const result = await ended;
      if (result === 'done') void startInstall('apk', () => android.install().then(() => true, () => false));
      return result;
    } catch (_) {
      dl.stop(); // 没有这个原生功能（旧的安卓外壳）：交给浏览器
    } finally {
      if (listener) listener.remove();
    }
  }
  openExternal(url);
  toast(t('update.downloading'));
  return 'browser';
}

// 下载完成后安装：进度条那里显示「下载完成，正在启动安装程序…」（按安装包类型），
// 等正在生成的回复写完、保存好对话，再开始安装。Windows 安装版、Linux、macOS 安装开始后软件随即关闭；
// 安卓版安装时系统会关闭软件。没能开始安装（例如被安全软件拦下）时不提示，过一会儿收起进度条
async function startInstall(kind, install) {
  const text = kind === 'dmg' ? 'update.openingDmg' : kind === 'zip' ? 'update.zipReady' : kind === 'apk' ? 'update.installingAndroid' : 'update.installing';
  while (state.generating) {
    showUpdateMessage(t('update.installAfterReply'));
    await new Promise((r) => setTimeout(r, 1000));
  }
  showUpdateMessage(t(text));
  await flushConvSave();
  await new Promise((r) => setTimeout(r, 800)); // 让用户看到这句话
  let ok = false;
  try { ok = await install(); } catch (_) { /* 不提示 */ }
  setTimeout(hideUpdateProgress, ok && kind !== 'zip' ? 20000 : 12000);
}

// 显示进度条、监视下载有没有卡住。cancel() 让下载停下（停下后由下载那边发出 aborted），finish(结果, 消息) 在结束时调用。
// begin() 开始显示进度条和计时（电脑版在「另存为」选好以后）；onEvent 处理 progress / done / failed / aborted
function watchDownload(version, cancel, finish) {
  let lastBytes = -1;
  let lastChange = Date.now();
  let timedOut = false;
  let finished = false;
  let timer = null;
  let grace = null;
  const end = (state, info) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(grace);
    if (state !== 'done') hideUpdateProgress(); // 下载完成时进度条留着，显示「正在启动安装程序…」
    if (updateDownloader === dl) updateDownloader = null;
    finish(state === 'aborted' && timedOut ? 'failed' : state, info);
  };
  const stopNow = (byTimeout) => {
    if (finished || grace) return; // 已经在停了
    clearInterval(timer);
    timedOut = byTimeout;
    Promise.resolve().then(cancel).catch(() => {});
    // 下载那边一直没有回应时，过几秒也当作已经停下
    grace = setTimeout(() => end('aborted'), 5000);
  };
  const dl = {
    begin() {
      lastChange = Date.now();
      timer = setInterval(() => {
        if (Date.now() - lastChange > UPDATE_STALL_MS) stopNow(true);
      }, 2000);
      if (lastBytes < 0) showUpdateProgress(version, 0, 0, true);
      els.updateProgressStop.onclick = () => stopNow(false);
    },
    onEvent(info) {
      if (finished) return;
      if (info.state === 'progress') {
        if (info.received !== lastBytes) { lastBytes = info.received; lastChange = Date.now(); }
        showUpdateProgress(version, info.received, info.total);
      } else if (info.state === 'done' || info.state === 'failed' || info.state === 'aborted') {
        end(info.state, info);
      }
    },
    stop() { finished = true; clearInterval(timer); hideUpdateProgress(); if (updateDownloader === dl) updateDownloader = null; },
  };
  return dl;
}

// 屏幕上方的下载进度条：「正在下载 0.5.0-beta.1… 42%」和已下载 / 总大小，右边是停止下载的 ×
function showUpdateProgress(version, received, total, waiting) {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null;
  els.updateProgressText.textContent = percent == null
    ? t('update.progressUnknown', { version })
    : t('update.progress', { version, percent });
  els.updateProgressSize.textContent = waiting ? '' : total > 0 ? t('update.progressSize', { received: mb(received), total: mb(total) }) : t('update.progressSizeUnknown', { received: mb(received) });
  els.updateProgressBar.classList.toggle('indeterminate', percent == null);
  els.updateProgressFill.style.width = percent == null ? '' : percent + '%';
  els.updateProgressStop.title = t('update.stop');
  els.updateProgressStop.setAttribute('aria-label', t('update.stop'));
  els.updateProgressStop.hidden = false;
  els.updateProgress.classList.remove('message');
  els.updateProgress.hidden = false;
}

// 下载完成后，进度条那里只显示一句话（进度条满格，没有 ×）
function showUpdateMessage(text) {
  els.updateProgressText.textContent = text;
  els.updateProgressSize.textContent = '';
  els.updateProgressBar.classList.remove('indeterminate');
  els.updateProgressFill.style.width = '100%';
  els.updateProgressStop.hidden = true;
  els.updateProgress.classList.add('message');
  els.updateProgress.hidden = false;
}

function hideUpdateProgress() {
  els.updateProgress.hidden = true;
}
