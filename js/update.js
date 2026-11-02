// 检查更新（只在原生应用里：电脑版和安卓版）。
//
// 打包工作流在发布版本时，把安装包和一个 version.json 上传到更新服务器（Cloudflare R2），分两个频道：
//   <UPDATE_BASE_URL>/stable/version.json   正式版（标签不带后缀，例如 v0.4.0）
//   <UPDATE_BASE_URL>/beta/version.json     测试版（标签带后缀，例如 v0.4.0-beta.1）
// 两个频道各自只保留最新的一个版本，互不覆盖。version.json 的内容：
//   { version, tag, date, release（GitHub Release 页面）, files: { 'win-setup', 'win-zip', 'mac-arm64', 'mac-x64', 'linux', 'android' } }
// files 里是安装包的文件名，和 version.json 放在同一个目录里。
//
// 软件启动后读取这两个文件：正式版比当前版本新就提示；测试版比当前版本新、也比正式版新才提示。
// 两个都有时在同一个窗口里列出，由用户选择下载哪个，或者都不更新。选择后用浏览器下载对应平台的安装包。
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
    if (!res.ok) return null;
    const m = await res.json();
    return m && typeof m.version === 'string' && m.files && typeof m.files === 'object' ? { ...m, channel } : null;
  } catch (_) {
    return null; // 连不上、超时或者内容不对：这次不提示
  } finally {
    clearTimeout(timer);
  }
}

// 等到没有别的弹窗、也没有在生成回复时再提示（同一时间只能显示一个弹窗）
function updateDialogFree() {
  return els.dialog.hidden && els.pwDialog.hidden && els.textDialog.hidden && els.modal.hidden && !state.generating;
}

async function checkForUpdates() {
  if (!UPDATE_BASE_URL || !IN_NATIVE_APP || !state.version) return;
  const key = updateFileKey();
  if (!key) return;
  const current = state.version;
  const [stable, beta] = await Promise.all([fetchUpdateManifest('stable'), fetchUpdateManifest('beta')]);
  const offers = [];
  if (stable && stable.files[key] && compareVersions(stable.version, current) > 0) offers.push(stable);
  if (beta && beta.files[key] && compareVersions(beta.version, current) > 0
    && (!stable || compareVersions(beta.version, stable.version) > 0)) offers.push(beta);
  if (!offers.length) return;

  for (let waited = 0; !updateDialogFree(); waited += 2000) {
    if (waited > 10 * 60 * 1000) return; // 一直没空就算了，下次启动再提示
    await new Promise((r) => setTimeout(r, 2000));
  }

  const lines = offers.map((m) => t(m.channel === 'beta' ? 'update.lineBeta' : 'update.lineStable', { version: m.version }));
  const message = t('update.message', { current, list: lines.join('\n') })
    + (offers.some((m) => m.channel === 'beta') ? '\n\n' + t('update.betaNote') : '');
  const choice = await choose(t('update.title'), message, [
    { label: t('update.later'), value: null, ghost: true },
    ...offers.slice().reverse().map((m) => ({
      label: t(m.channel === 'beta' ? 'update.getBeta' : 'update.getStable', { version: m.version }),
      value: m,
      primary: m.channel === 'stable',
    })),
  ]);
  if (!choice) return;
  // 用浏览器下载：电脑版由主进程交给系统浏览器，安卓版由 WebView 交给系统浏览器
  const a = document.createElement('a');
  a.href = `${UPDATE_BASE_URL}/${choice.channel}/${encodeURIComponent(choice.files[key])}`;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(t('update.downloading'));
}
