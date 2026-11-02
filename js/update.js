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

// 启动时调用，不等读取数据：version 是取得当前版本号（写进 state.version）的 Promise，booted 是读取数据的 Promise。
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
  const current = state.version;
  if (!current) return;
  const z = saved && saved.updateSnooze && typeof saved.updateSnooze === 'object' ? saved.updateSnooze : {};
  if (z.until && Date.now() < z.until) return;
  const today = localDay();
  if (saved && saved.updateCheckedDay === today) return;
  const skip = z.skip || {};
  let [stable, beta] = await Promise.all([fetchUpdateManifest('stable'), fetchUpdateManifest('beta')]);
  try { await booted; } catch (_) { return; }
  const failed = stable === 'error' || beta === 'error';
  if (stable === 'error') stable = null;
  if (beta === 'error') beta = null;
  const wanted = (m) => m && m.files[key] && compareVersions(m.version, current) > 0
    && !(skip[m.channel] && !(compareVersions(m.version, skip[m.channel]) > 0));
  const offers = [];
  if (wanted(stable)) offers.push(stable);
  // 测试版还要比最新的正式版新（不论正式版是否被跳过）
  if (wanted(beta) && (!stable || compareVersions(beta.version, stable.version) > 0)) offers.push(beta);
  if (!offers.length) {
    if (!failed) {
      state.settings.updateCheckedDay = today;
      saveSettingsSoon();
    }
    return;
  }

  const choice = await showUpdateDialog(current, offers);
  if (!choice) return;
  if (choice.remindDays) {
    setUpdateSnooze({ ...updateSnooze(), until: Date.now() + choice.remindDays * 24 * 3600 * 1000 });
    toast(t('update.remindSet', { days: choice.remindDays }));
  } else if (choice.skip) {
    const skipNow = { ...(updateSnooze().skip || {}) };
    for (const m of offers) skipNow[m.channel] = m.version;
    setUpdateSnooze({ ...updateSnooze(), until: 0, skip: skipNow });
    state.settings.updateCheckedDay = today; // 跳过以后也是第二天再检查
    saveSettingsSoon();
    toast(t('update.skipped'));
  } else if (choice.manifest) {
    const started = await downloadUpdate(`${UPDATE_BASE_URL}/${choice.manifest.channel}/${encodeURIComponent(choice.manifest.files[key])}`);
    // 开始下载了：今天不再检查（装好新版本后再打开也是第二天才检查）；取消了保存就下次启动再提示
    if (started) {
      state.settings.updateCheckedDay = today;
      saveSettingsSoon();
    }
  }
}

// 本机日期（年-月-日），用来判断今天是否已经检查过
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 更新提示窗口。按钮依次是：下载测试版 / 下载正式版（有哪个显示哪个）/「一天后提醒」（旁边的 ▾ 打开菜单：三天后提醒、跳过此版本）。
// 返回 { manifest } / { remindDays } / { skip: true }。必须选一个，不能用 Esc 或点窗口外面关闭。
// 用自己的窗口（#updateDialog），盖在其他窗口和弹窗上面；关闭后下面的东西保持原样，焦点回到原来的位置
function showUpdateDialog(current, offers) {
  const lines = offers.map((m) => t(m.channel === 'beta' ? 'update.lineBeta' : 'update.lineStable', { version: m.version }));
  const message = t('update.message', { current, list: lines.join('\n') })
    + (offers.some((m) => m.channel === 'beta') ? '\n\n' + t('update.betaNote') : '');
  return new Promise((resolve) => {
    els.updateTitle.textContent = t('update.title');
    els.updateMessage.textContent = message;
    els.updateButtons.innerHTML = '';
    const prevFocus = document.activeElement;
    let menu = null;
    const close = (value) => {
      els.updateDialog.hidden = true;
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const closeMenu = () => { if (menu) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } };
    // 这个窗口必须选一个按钮才能关闭：Esc 只收起 ▾ 菜单，点窗口外面也不关闭。
    // Esc 在 window 的捕获阶段最先处理并且不再传下去：窗口下面已经打开的弹窗、列表、放大窗口、设置面板等都不会被它关掉
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (menu && !menu.hidden) { closeMenu(); toggle.focus(); }
    };
    // 菜单打开时，点它以外的任何地方（包括这个窗口里的其他位置）都收起它；再点一次 ▾ 也收起
    const onOutside = (e) => { if (menu && !menu.hidden && !split.contains(e.target)) closeMenu(); };

    for (const m of offers.slice().reverse()) {
      const label = t(m.channel === 'beta' ? 'update.getBeta' : 'update.getStable', { version: m.version });
      els.updateButtons.appendChild(button(label, () => close({ manifest: m }), 'btn' + (m.channel === 'stable' ? ' btn-primary' : '')));
    }

    // 「一天后提醒 ▾」：左边直接选一天后提醒，右边的 ▾ 打开菜单
    const split = document.createElement('div');
    split.className = 'split-btn update-remind';
    split.appendChild(button(t('update.remind1'), () => close({ remindDays: 1 }), 'btn'));
    const toggle = button('', () => {
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
      const item = button(label, () => close(value), 'split-item');
      item.setAttribute('role', 'menuitem');
      menu.appendChild(item);
    }
    split.appendChild(menu);
    els.updateButtons.appendChild(split);

    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    els.updateDialog.hidden = false; // 安卓的返回键也不能关掉它（见 bindBackButton）
    // 焦点放在窗口本身、不放在按钮上：窗口可能在用户打字时突然出现，空格、回车不会误按到「下载」。按 Tab 进入按钮
    els.updateBox.focus({ preventScroll: true });
  });
}

// 下载安装包，开始下载了返回 true。电脑版：在软件里下载，先选择保存位置，完成后问是否关闭软件并运行安装程序（electron/main.js）。
// 安卓版：交给系统浏览器下载，下载完成后点通知安装
let updateProgressBound = false;
async function downloadUpdate(url) {
  const desktop = window.proteusDesktop;
  if (desktop && desktop.downloadUpdate) {
    if (!updateProgressBound) {
      updateProgressBound = true;
      desktop.onUpdateDownload((info) => {
        if (info.state === 'progress') toast(info.percent == null ? t('update.progressUnknown') : t('update.progress', { percent: info.percent }));
        else if (info.state === 'done') toast(t('update.downloaded'));
      });
    }
    const result = await desktop.downloadUpdate(url);
    if (result === 'cancelled') { toast(t('update.saveCancelled')); return false; } // 下次检查时再提示
    if (result) return true;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(t('update.downloading'));
  return true;
}
