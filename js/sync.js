// GitHub 同步：把对话、服务商设置（包括 API Key）和 token 校准数据备份到用户自己的私有仓库，在其他设备上下载。
//
// 登录：GitHub 的设备登录（Device Flow，OAuth App，权限 repo）。软件显示验证码，用户在浏览器里打开 GitHub 的网页输入，
//   软件在这期间轮询登录结果。登录接口（github.com/login/...）不允许网页直接访问（跨域）：
//   电脑版由 electron/main.js 放行，安卓版的 fetch 本来就是原生请求，网页版经过本机代理 scripts/github-login-proxy.js。
//   读写仓库用的 api.github.com 允许跨域，三个版本都直接访问。
// 登录凭据（token）不进设置、不进任何导出和备份，单独存在本机（DB 的 githubToken），并且加密：
//   电脑版用系统的钥匙串（Electron safeStorage）；系统不提供时、以及安卓版和网页版，用浏览器生成的一把“不可导出”的密钥
//   （存在 IndexedDB，页面脚本只能拿它加解密，读不出密钥本身）。都不需要用户输入密码。
// repo 权限能读写用户的全部仓库，所以只操作两种仓库：有标记文件 proteus-sync.json 的（海神建的或用过的），
//   以及空仓库（或者只有 README、LICENSE、.gitignore）。其他仓库拒绝使用，免得误改用户的代码。
//
// 仓库里的文件：
//   proteus-sync.json         标记和设置：{ app: 'proteus', type: 'sync', version, encryptSettings, encryptKeys, check }
//                             check 是同步密码的校验值（和本地导出加密时的密码一样，只用来解锁查看，见 crypto.js）
//   index.json                每个对话的标题、轮数、时间：列出仓库内容时只读这一个文件
//   conversations/<id>.json   和本地「完整备份（当前对话）」格式相同，可以直接在「读取世界卡 / 备份 / 酒馆卡」里读取
//   settings.json             LLM 设置（服务商、接口地址、模型、API Key……）。本地也可以读取（覆盖本机的 LLM 设置）
//   calibration.json          token 校准数据。本地也可以读取（和本机的合并）
// 加密和本地导出一样：选了「加密设定」时，角色扮演对话的设定（System Prompt、世界观、NPC角色、重点指令、开场白）和艺术图
//   用软件内置的密钥加密，同步密码只用来解锁查看；助理模式和酒馆兼容对话不加密；来自加密世界卡的对话保持原来的锁。
//   「加密 API Key」用同一个密码。剧情（对话记录）不加密。私有仓库的访问权限本身就是门禁。
// 艺术图：每个对话自己决定是否同步（conv.syncArt，没有时按全局设定 settings.sync.artDefault）。
//   不同步的对话，上传的文件里没有 art；下载时也不动本机的艺术图。
// 每次操作只生成一个提交（Git Data API：blob → tree → commit → 移动分支）。
//
// 操作（覆盖就是字面意思：强制覆盖；增量只看对话 id，id 相同的跳过，即使改过）：
//   全量备份（覆盖）   仓库变成和本机一样：上传全部对话，删掉仓库里本机没有的对话，LLM 设置和校准数据也覆盖
//   增量备份           只上传仓库里没有（按 id）的对话；本机有、仓库没有的服务商加进仓库的 LLM 设置
//   下载到本地（覆盖） 本机变成和仓库一样：本机多出来的对话删掉，LLM 设置覆盖，校准数据换成仓库的
//   下载到本地（增量） 只下载本机没有（按 id）的对话；仓库有、本机没有的服务商加进来，校准数据合并
//   此对话：备份（覆盖） / 从仓库下载（覆盖）

const GITHUB_CLIENT_ID = 'Ov23lidZjw3FERIq4ppl';
const GITHUB_SCOPE = 'repo';
const GITHUB_API = 'https://api.github.com';
const GITHUB_LOGIN_PROXY = 'http://127.0.0.1:8787'; // 网页版：scripts/github-login-proxy.js
const SYNC_DEFAULT_REPO = 'proteus_sync';
const SYNC_MARKER = 'proteus-sync.json';
const SYNC_INDEX = 'index.json';
const SYNC_SETTINGS = 'settings.json';
const SYNC_CALIB = 'calibration.json';
const SYNC_CONV_RE = /^conversations\/([\w-]{1,100})\.json$/;
const SYNC_HARMLESS = new Set(['README.md', 'LICENSE', '.gitignore', '.gitattributes']); // 新建仓库时 GitHub 可能自动加的
const SYNC_LLM_KEYS = ['provider', 'relays', 'baseUrls', 'models', 'maxTokens', 'modelLists', 'modelInfo', 'effort', 'useTemperature', 'temperature', 'openrouterSort', 'openrouterNoData'];
const SYNC_PER_PROVIDER = ['apiKeys', 'baseUrls', 'models', 'maxTokens', 'modelLists', 'modelInfo'];

const syncIsObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const syncConvPath = (id) => `conversations/${id}.json`;
const syncSafeId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const isWebPage = () => !NATIVE && !window.proteusDesktop;
const syncSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 提交说明：「Proteus · 时间 · 做了什么」，时间是本机时间（带时区），文字按界面语言
function commitMessage(key, vars = {}) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const tz = `UTC${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${off % 60 ? ':' + p(Math.abs(off) % 60) : ''}`;
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${tz})`;
  return `Proteus · ${time} · ${t(key, vars)}`;
}

class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// ---------------- 登录凭据 ----------------

const TokenVault = (() => {
  const KEY = 'githubToken';
  const LOCAL_KEY = 'githubTokenKey';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // 本机的“不可导出”密钥：第一次用时生成，存在 IndexedDB
  async function localKey(create) {
    let k = await DB.get(LOCAL_KEY);
    if (!k && create) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await DB.set(LOCAL_KEY, k);
    }
    return k || null;
  }

  async function save(token) {
    const desktop = window.proteusDesktop;
    if (desktop && desktop.secureEncrypt) {
      const data = await desktop.secureEncrypt(token).catch(() => null);
      if (data) return DB.set(KEY, { kind: 'os', data });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await localKey(true), enc.encode(token));
    await DB.set(KEY, { kind: 'local', iv: b64(iv), data: b64(data) });
  }

  async function load() {
    const box = await DB.get(KEY);
    if (!box) return null;
    try {
      if (box.kind === 'os') return window.proteusDesktop ? (await window.proteusDesktop.secureDecrypt(box.data)) || null : null;
      if (box.kind === 'local') {
        const k = await localKey(false);
        return k ? dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.data))) : null;
      }
    } catch (_) { /* 解不开就当作没有登录 */ }
    return null;
  }

  async function clear() {
    await DB.del(KEY);
    await DB.del(LOCAL_KEY);
  }

  return { save, load, clear };
})();

// ---------------- 网络 ----------------

// 设备登录的两个接口（表单格式，回复 JSON）
async function githubLoginPost(path, params) {
  const url = (isWebPage() ? GITHUB_LOGIN_PROXY : 'https://github.com') + path;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new SyncError(isWebPage() ? t('sync.proxyNeeded') : t('sync.netFailed', { msg: e.message }));
  }
  let j = null;
  try { j = await res.json(); } catch (_) { /* 下面报错 */ }
  if (!syncIsObj(j)) throw new SyncError(t('sync.badReply', { status: res.status }));
  return j;
}

let ghToken = null;

// GitHub API。raw 为 true 时读取文件的原文（最大 100 MB）。401：登录失效，退出登录
async function gh(method, path, body, raw = false) {
  if (!ghToken) ghToken = await TokenVault.load();
  if (!ghToken) throw new SyncError(t('sync.notLoggedIn'), 401);
  const headers = { authorization: 'Bearer ' + ghToken, accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(GITHUB_API + path, { method, cache: 'no-store', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new SyncError(t('sync.netFailed', { msg: e.message }));
  }
  if (res.status === 401) {
    await syncSignedOut();
    throw new SyncError(t('sync.expired'), 401);
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (_) { /* 没有说明 */ }
    throw new SyncError(t('sync.apiFailed', { status: res.status, msg }), res.status);
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

const repoApi = (r) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
const repoLabel = (r) => `${r.owner}/${r.name}`;
const repoUrl = (r) => `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;

function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// 仓库里的全部文件 Map(路径 → sha)；空仓库（还没有提交）为 null
async function readTree(r) {
  try {
    const j = await gh('GET', `${repoApi(r)}/git/trees/${encodeURIComponent(r.branch)}?recursive=1`);
    return new Map(j.tree.filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]));
  } catch (e) {
    if (e.status === 409 || e.status === 404) return null;
    throw e;
  }
}

// 读取一个 JSON 文件；没有这个文件或不是 JSON 时为 null
async function readJson(r, path) {
  let text;
  try {
    text = await gh('GET', `${repoApi(r)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(r.branch)}`, undefined, true);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  try { return JSON.parse(text); } catch (_) { return null; }
}

// 一次提交写入多个文件。files：{ 路径: 文字内容，或 null（删除） }
async function commitFiles(r, files, message, onProgress) {
  const git = `${repoApi(r)}/git`;
  const ref = await gh('GET', `${git}/ref/heads/${encodeURIComponent(r.branch)}`);
  const head = ref.object.sha;
  const commit = await gh('GET', `${git}/commits/${head}`);
  const paths = Object.keys(files);
  const tree = [];
  let done = 0;
  for (const path of paths) {
    const content = files[path];
    if (content === null) tree.push({ path, mode: '100644', type: 'blob', sha: null });
    else {
      const blob = await gh('POST', `${git}/blobs`, { content, encoding: 'utf-8' });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (onProgress) onProgress(++done, paths.length);
  }
  const newTree = await gh('POST', `${git}/trees`, { base_tree: commit.tree.sha, tree });
  const next = await gh('POST', `${git}/commits`, { message, tree: newTree.sha, parents: [head] });
  await gh('PATCH', `${git}/refs/heads/${encodeURIComponent(r.branch)}`, { sha: next.sha });
}

// ---------------- 仓库内容 ----------------

function cleanMarker(m) {
  if (!syncIsObj(m) || m.app !== 'proteus' || m.type !== 'sync') return null;
  const check = syncIsObj(m.check) && typeof m.check.salt === 'string' && typeof m.check.hash === 'string'
    && Number.isInteger(m.check.iterations) ? { salt: m.check.salt, iterations: m.check.iterations, hash: m.check.hash } : null;
  return { app: 'proteus', type: 'sync', version: 1, encryptSettings: !!m.encryptSettings && !!check, encryptKeys: !!m.encryptKeys && !!check, check };
}

// 看看仓库里有什么。foreign：有别的文件、不是海神的同步仓库
async function inspectRepo(r) {
  const tree = await readTree(r);
  if (!tree) return { empty: true, tree: new Map(), marker: null, ids: [], meta: {} };
  const marker = tree.has(SYNC_MARKER) ? cleanMarker(await readJson(r, SYNC_MARKER)) : null;
  if (!marker && [...tree.keys()].some((p) => !SYNC_HARMLESS.has(p))) return { foreign: true };
  const ids = [];
  for (const p of tree.keys()) {
    const m = SYNC_CONV_RE.exec(p);
    if (m) ids.push(m[1]);
  }
  const index = tree.has(SYNC_INDEX) ? await readJson(r, SYNC_INDEX) : null;
  const meta = index && syncIsObj(index.conversations) ? index.conversations : {};
  return { empty: false, tree, marker, ids, meta };
}

// ---------------- 对话、设置的文件 ----------------

const syncArtOf = (c) => (typeof c.syncArt === 'boolean' ? c.syncArt : state.settings.sync.artDefault !== false);

function indexEntry(c) {
  return { title: c.title || '', rounds: roundsOf(c), updatedAt: c.updatedAt || null, activeAt: c.activeAt || null, kind: kindOf(c) };
}

// 一个对话的文件：和本地「完整备份（当前对话）」一样。不同步艺术图的对话不写 art
async function convFile(c, marker) {
  const encrypt = !!c.lock || (!!marker.encryptSettings && !!marker.check && canEncrypt(c));
  let conv;
  if (c.lock || !encrypt) conv = storable(c);
  else conv = storable({ ...c, lock: await Locker.relock(lockedFields(c), marker.check) });
  const data = { app: 'proteus', type: 'conversation', version: 1, exportedAt: new Date().toISOString(), conversation: conv };
  if (syncArtOf(c)) data.art = await artForExport(c.id, encrypt);
  return JSON.stringify(data, null, 2);
}

// LLM 设置（深拷贝）
function localLlm() {
  const s = state.settings;
  const out = {};
  for (const k of SYNC_LLM_KEYS) out[k] = s[k];
  return JSON.parse(JSON.stringify(out));
}

async function settingsFile(llm, apiKeys, marker) {
  const data = { app: 'proteus', type: 'settings', version: 1, exportedAt: new Date().toISOString(), llm };
  if (marker.encryptKeys && marker.check) data.apiKeysLocked = await Locker.relock(apiKeys, marker.check);
  else data.apiKeys = apiKeys;
  return JSON.stringify(data, null, 2);
}

function calibFile() {
  return JSON.stringify({ app: 'proteus', type: 'calibration', version: 1, exportedAt: new Date().toISOString(),
    tokenCalib: TokenCalib.exportData(new Set(state.conversations.map((c) => c.id))) }, null, 2);
}

// 读到的 LLM 设置：只留认得出的部分
function cleanLlm(x) {
  if (!syncIsObj(x)) return null;
  const out = {};
  if (typeof x.provider === 'string') out.provider = x.provider;
  out.relays = Array.isArray(x.relays) ? x.relays.filter((r) => syncIsObj(r) && typeof r.id === 'string' && r.id) : [];
  for (const k of ['baseUrls', 'models', 'maxTokens', 'modelLists', 'modelInfo']) out[k] = syncIsObj(x[k]) ? x[k] : {};
  if (typeof x.effort === 'string') out.effort = x.effort;
  if (typeof x.useTemperature === 'boolean') out.useTemperature = x.useTemperature;
  if (typeof x.temperature === 'number' && Number.isFinite(x.temperature)) out.temperature = x.temperature;
  if (['', 'price', 'throughput', 'latency'].includes(x.openrouterSort)) out.openrouterSort = x.openrouterSort;
  if (typeof x.openrouterNoData === 'boolean') out.openrouterNoData = x.openrouterNoData;
  return out;
}

const cleanKeys = (k) => (syncIsObj(k) ? Object.fromEntries(Object.entries(k).filter(([, v]) => typeof v === 'string')) : {});

// settings.json 里的 API Key：{ keys, locked }。加密的要先解锁（unlocked 为 true）才给 keys；
// force 为 true 时不管密码直接解出（增量备份时把仓库里原有的 Key 原样带回去，不显示给用户）
async function keysOf(file, unlocked, force = false) {
  if (syncIsObj(file.apiKeysLocked)) {
    if (!unlocked && !force) return { keys: null, locked: true };
    try { return { keys: cleanKeys(await Locker.open(file.apiKeysLocked)), locked: true }; } catch (_) { return { keys: null, locked: true }; }
  }
  return { keys: cleanKeys(file.apiKeys), locked: false };
}

// 把 extra 里的、base 没有的服务商（按 id）加进 base（连同它的地址、模型等和 Key）。返回加了几个
function addMissingRelays(base, baseKeys, extra, extraKeys) {
  const have = new Set(base.relays.map((r) => r.id));
  let n = 0;
  for (const r of extra.relays) {
    if (have.has(r.id)) continue;
    base.relays.push(r);
    const key = RELAY_PREFIX + r.id;
    for (const k of ['baseUrls', 'models', 'maxTokens', 'modelLists', 'modelInfo']) if (extra[k][key] !== undefined) base[k][key] = extra[k][key];
    if (baseKeys && extraKeys && extraKeys[key] !== undefined) baseKeys[key] = extraKeys[key];
    n++;
  }
  return n;
}

// 把读到的 LLM 设置放进本机（覆盖）。keys 为 null 时本机的 Key 不变
function applyLlm(llm, keys) {
  const s = state.settings;
  for (const k of SYNC_LLM_KEYS) if (llm[k] !== undefined) s[k] = llm[k];
  if (keys) s.apiKeys = { ...keys };
}

// ---------------- 下载后写进本机 ----------------

function validConvFile(f) {
  return syncIsObj(f) && f.app === 'proteus' && f.type === 'conversation' && validBackupConv(f.conversation) && syncSafeId(f.conversation.id);
}

// 写入一个下载的对话（保持原来的 id 和修改时间）。unlockCheck：用户输入了同步密码时，用这个密码加的锁直接解开。
// local：本机原来的这个对话（不同步艺术图时不动本机的艺术图）
async function storeDownloaded(file, unlockCheck, local) {
  const c = { createdAt: Date.now(), ...file.conversation };
  await openLock(c);
  normalizeConv(c);
  const has = Object.prototype.hasOwnProperty.call(file, 'art');
  let art = has ? file.art : null;
  if (unlockCheck && c.lock && Locker.sameCheck(c.lock, unlockCheck)) {
    delete c.lock;
    if (art && typeof art === 'object') art = await Locker.decryptBlob(art);
  }
  const keepLocalArt = !has || (local && syncArtOf(local) === false); // 艺术图不跟着下载：本机的图和它的展示方式都不动
  if (keepLocalArt) {
    if (local && local.artMode) c.artMode = local.artMode;
    else delete c.artMode;
  }
  await DB.putConversation(storable(c));
  if (keepLocalArt) return c;
  if (art instanceof Blob) await DB.set(artKey(c.id), art);
  else if (art && validArt(art)) await importArt(c.id, art);
  else await DB.del(artKey(c.id));
  return c;
}

// 下载的内容里有用同步密码加的锁时，问一次密码（取消则保持锁定，以后可以逐个解锁）。返回用户解锁了没有
async function askSyncUnlock(marker, needed) {
  if (!needed || !marker || !marker.check) return false;
  for (;;) {
    const pw = await askPassword(t('sync.unlockTitle'), t('sync.unlockMessage'), false);
    if (pw === null) return false;
    if (await Locker.checkPassword(marker.check, pw)) return true;
    toast(t('lock.wrongPw'));
  }
}

// ---------------- 同步对话框 ----------------
// 一个居中的窗口，登录、选择仓库、执行操作都在里面。按 Esc、点窗口外面都不关闭，只能点里面的按钮

let syncFlow = 0;     // 每打开一次加一：关掉窗口后，还在进行的轮询等发现编号变了就停下
let syncBusy = false; // 正在执行同步操作

function syncDialogOpen(title) {
  syncFlow++;
  els.syncDialogTitle.textContent = title;
  els.syncBody.replaceChildren();
  els.syncButtons.replaceChildren();
  els.syncDialog.hidden = false;
  return syncFlow;
}

function syncDialogClose() {
  syncFlow++;
  els.syncDialog.hidden = true;
}

const syncAlive = (flow) => flow === syncFlow && !els.syncDialog.hidden;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function syncSetBody(...nodes) {
  els.syncBody.replaceChildren(...nodes.filter(Boolean));
}

function syncSetButtons(list) {
  els.syncButtons.replaceChildren(...list.map((b) => button(b.label, b.onClick, 'btn' + (b.primary ? ' btn-primary' : b.danger ? ' btn-danger' : b.ghost ? ' btn-ghost' : ''))));
}

const syncMessage = (text, error = false) => el('div', 'sync-message' + (error ? ' error' : ''), text);

// 显示一句话和按钮，等用户点一个。返回按钮的 value（窗口被关掉则为 null）
function syncAsk(flow, nodes, options) {
  return new Promise((resolve) => {
    if (!syncAlive(flow)) return resolve(null);
    syncSetBody(...nodes);
    syncSetButtons(options.map((o) => ({ ...o, onClick: () => resolve(o.value) })));
  });
}

// 出错：显示原因和「重试」「取消」。返回是否重试
async function syncFailRetry(flow, message) {
  const r = await syncAsk(flow, [syncMessage(message, true)], [
    { label: t('btn.cancel'), value: false, ghost: true },
    { label: t('sync.retry'), value: true, primary: true },
  ]);
  if (r !== true) syncDialogClose();
  return r === true;
}

// 显示结果和「关闭」
function syncShowDone(flow, message, error = false) {
  if (!syncAlive(flow)) return;
  syncSetBody(syncMessage(message, error));
  syncSetButtons([{ label: t('modal.close'), primary: true, onClick: syncDialogClose }]);
}

// ---------------- 登录 ----------------

// 网页版：本机的登录代理开着没有
async function syncProxyUp() {
  try {
    const res = await fetch(GITHUB_LOGIN_PROXY + '/ping', { cache: 'no-store' });
    const j = await res.json();
    return !!j && j.app === 'proteus-login-proxy';
  } catch (_) {
    return false;
  }
}

// 网页版：登录前先确认本机代理已经开启（网页不能自己启动本机程序）。没开时说明怎么开，开好后继续。返回是否继续
async function syncWaitForProxy(flow) {
  if (await syncProxyUp()) return true;
  const cmd = 'node scripts/github-login-proxy.js';
  const status = syncMessage('');
  for (;;) {
    const r = await syncAsk(flow, [syncMessage(t('sync.proxyIntro')), el('pre', 'sync-cmd', cmd), syncMessage(t('sync.proxyAfter')), status], [
      { label: t('btn.cancel'), value: 'cancel', ghost: true },
      { label: t('sync.copyCommand'), value: 'copy' },
      { label: t('sync.proxyReady'), value: 'ready', primary: true },
    ]);
    if (r === 'copy') {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(() => toast(t('sync.commandCopied')), () => {});
      continue;
    }
    if (r !== 'ready') { syncDialogClose(); return false; }
    status.textContent = t('sync.proxyChecking');
    if (await syncProxyUp()) return true;
    status.textContent = t('sync.proxyStillDown');
    status.classList.add('error');
  }
}

async function syncLogin() {
  const flow = syncDialogOpen(t('sync.loginTitle'));
  for (;;) {
    // 网页版每次（包括重试）都先确认代理开着：登录成功后它会自己关掉
    if (isWebPage() && !(await syncWaitForProxy(flow))) return;
    syncSetBody(syncMessage(t('sync.requestingCode')));
    syncSetButtons([{ label: t('btn.cancel'), ghost: true, onClick: syncDialogClose }]);
    let code;
    try {
      code = await githubLoginPost('/login/device/code', { client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPE });
      if (!code.device_code) throw new SyncError(code.error_description || code.error || t('sync.badReply', { status: '' }));
    } catch (e) {
      if (!syncAlive(flow) || !(await syncFailRetry(flow, e.message))) return;
      continue;
    }
    if (!syncAlive(flow)) return;
    const result = await syncPoll(flow, code);
    if (!syncAlive(flow)) return;
    if (result.token) {
      try {
        await TokenVault.save(result.token);
        ghToken = result.token;
        const user = await gh('GET', '/user');
        state.settings.sync.login = user.login;
        saveSettingsSoon();
        renderSyncCard();
      } catch (e) {
        if (!(await syncFailRetry(flow, e.message))) return;
        continue;
      }
      return syncRepoStep(flow, true);
    }
    if (!(await syncFailRetry(flow, result.error))) return;
  }
}

// 显示验证码，轮询登录结果。返回 { token } 或 { error: 说明 }
async function syncPoll(flow, code) {
  const expires = Date.now() + (Number(code.expires_in) || 900) * 1000;
  let interval = Math.max(5, Number(code.interval) || 5);
  const status = el('div', 'sync-message muted');
  const codeBox = el('div', 'sync-code', code.user_code);
  const uri = el('div', 'sync-uri', code.verification_uri);
  syncSetBody(syncMessage(t('sync.codeHint')), codeBox, uri, status);
  syncSetButtons([
    { label: t('btn.cancel'), ghost: true, onClick: syncDialogClose },
    { label: t('sync.copyAndOpen'), primary: true, onClick: () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.user_code).then(() => toast(t('sync.codeCopied')), () => {});
      openExternal(code.verification_uri);
    } },
  ]);
  const tick = () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    status.textContent = t('sync.waiting', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
  };
  tick();
  const timer = setInterval(tick, 1000);
  let failures = 0;
  try {
    for (;;) {
      await syncSleep(interval * 1000);
      if (!syncAlive(flow)) return { error: '' };
      if (Date.now() > expires) return { error: t('sync.codeExpired') };
      let j;
      try {
        j = await githubLoginPost('/login/oauth/access_token', {
          client_id: GITHUB_CLIENT_ID, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        failures = 0;
      } catch (e) {
        if (++failures >= 3) return { error: e.message }; // 偶尔连不上就继续等，连续三次才算失败
        continue;
      }
      if (j.access_token) return { token: j.access_token };
      if (j.error === 'authorization_pending') continue;
      if (j.error === 'slow_down') { interval = Math.max(interval + 5, Number(j.interval) || 0); continue; }
      if (j.error === 'expired_token') return { error: t('sync.codeExpired') };
      if (j.error === 'access_denied') return { error: t('sync.denied') };
      return { error: j.error_description || j.error || t('sync.badReply', { status: '' }) };
    }
  } finally {
    clearInterval(timer);
  }
}

// 登录失效（401）或退出登录：删掉本机的凭据
async function syncSignedOut() {
  ghToken = null;
  await TokenVault.clear();
  const s = state.settings.sync;
  s.login = null;
  s.repo = null;
  s.marker = null;
  s.repoPublic = false;
  saveSettingsSoon();
  renderSyncCard();
}

async function syncLogout() {
  if (!(await ask(t('sync.logoutConfirm'), { ok: t('sync.logout') }))) return;
  await syncSignedOut();
  showModal(t('sync.logout'), t('sync.loggedOut'));
}

// ---------------- 选择或创建仓库 ----------------

// fresh：刚登录，先看看有没有 proteus_sync 仓库，有就直接用
async function syncRepoStep(flow, fresh) {
  const login = state.settings.sync.login;
  if (fresh) {
    syncSetBody(syncMessage(t('sync.loggedIn', { login })), syncMessage(t('sync.lookingForRepo')));
    syncSetButtons([]);
    try {
      const info = await gh('GET', `/repos/${encodeURIComponent(login)}/${SYNC_DEFAULT_REPO}`);
      // 公开的同名仓库不用：任何人都能看到里面的设定和聊天记录，请用户先在 GitHub 上改为私有
      if (!info.private) return syncChooseRepo(flow, t('sync.defaultRepoPublic', { name: info.full_name }));
      return syncUseRepo(flow, info);
    } catch (e) {
      if (e.status !== 404) return syncShowDone(flow, e.message, true);
    }
  }
  return syncChooseRepo(flow, fresh ? t('sync.noDefaultRepo', { login, name: SYNC_DEFAULT_REPO }) : '');
}

function syncChooseRepo(flow, intro) {
  if (!syncAlive(flow)) return;
  const err = el('div', 'sync-message error');
  const field = (label, input) => { const l = el('label', 'field'); l.append(el('span', '', label), input); return l; };
  const input = (value, ph) => { const i = el('input'); i.type = 'text'; i.spellcheck = false; i.autocomplete = 'off'; i.value = value; if (ph) i.placeholder = ph; return i; };

  // 已有的仓库：列出账号自己的私有仓库（最近更新的在前），点一个就用它；仓库多时可以输入文字筛选
  const filter = input('', t('sync.repoFilter'));
  const list = el('div', 'sync-repo-list');
  list.append(el('div', 'sync-list-item', t('sync.loadingRepos')));
  const sec1 = el('div', 'sync-section');
  sec1.append(el('div', 'sync-section-title', t('sync.useExisting')), filter, list);
  let repos = null;
  const show = () => {
    if (!repos) return;
    const f = filter.value.trim().toLowerCase();
    const items = repos.filter((r) => !f || r.full_name.toLowerCase().includes(f));
    list.replaceChildren();
    if (!items.length) list.append(el('div', 'sync-list-item', t(repos.length ? 'sync.noRepoMatch' : 'sync.noRepos')));
    for (const info of items) {
      const b = el('button', 'sync-repo-item');
      b.type = 'button';
      b.append(el('span', 'sync-repo-name', info.full_name));
      if (info.updated_at) b.title = new Date(info.updated_at).toLocaleString();
      b.addEventListener('click', () => {
        err.textContent = t('sync.checking');
        void syncUseRepo(flow, info, err).catch((e) => { if (syncAlive(flow)) err.textContent = e.message; });
      });
      list.append(b);
    }
  };
  filter.addEventListener('input', show);
  syncListRepos().then((r) => { repos = r; if (syncAlive(flow)) show(); }, (e) => {
    if (!syncAlive(flow)) return;
    list.replaceChildren(el('div', 'sync-list-item error', e.message));
  });

  const name = input(SYNC_DEFAULT_REPO);
  const desc = input(t('sync.repoDescDefault'));
  const createBtn = button(t('sync.createRepo'), () => void syncCreateRepo(flow, name.value, desc.value, err), 'btn btn-small btn-primary');
  const sec2 = el('div', 'sync-section');
  sec2.append(el('div', 'sync-section-title', t('sync.createNew')), field(t('sync.repoName'), name), field(t('sync.repoDesc'), desc),
    el('p', 'hint', t('sync.privateHint')), createBtn);

  syncSetBody(intro ? syncMessage(intro) : null, sec1, sec2, err);
  syncSetButtons([{ label: t('sync.later'), ghost: true, onClick: syncDialogClose }]);
}

// 账号自己的私有仓库，最近更新的在前。不列公开仓库（任何人都能看到里面的内容），也不列作为协作者、所在组织的
// （一般不会拿别人的仓库存自己的设定和聊天记录）和已归档的（不能写入）。最多读 10 页（1000 个）
async function syncListRepos() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh('GET', `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner&visibility=private`);
    if (!Array.isArray(batch)) break;
    out.push(...batch.filter((r) => r && r.private && !r.archived && r.permissions && r.permissions.push));
    if (batch.length < 100) break;
  }
  return out;
}

async function syncCreateRepo(flow, name, desc, err) {
  name = name.trim();
  if (!/^[\w.-]{1,100}$/.test(name)) { err.textContent = t('sync.badRepoName'); return; }
  err.textContent = t('sync.creating');
  try {
    const info = await gh('POST', '/user/repos', { name, description: desc.trim(), private: true, auto_init: true });
    await syncUseRepo(flow, info, err, true);
  } catch (e) {
    if (syncAlive(flow)) err.textContent = e.status === 422 ? t('sync.repoExists', { name }) : e.message;
  }
}

// 用这个仓库：检查能不能写、是不是海神的同步仓库，记下来。然后按仓库里有没有对话给出操作
async function syncUseRepo(flow, info, err, created = false) {
  const fail = (msg) => { if (err) err.textContent = msg; else syncChooseRepo(flow, msg); };
  if (!info.permissions || !info.permissions.push) return fail(t('sync.noPush', { name: info.full_name }));
  const r = { owner: info.owner.login, name: info.name, branch: info.default_branch || 'main' };
  let insp;
  try { insp = await inspectRepo(r); } catch (e) { return fail(e.message); }
  if (!syncAlive(flow)) return;
  if (insp.foreign) return fail(t('sync.foreignRepo', { name: info.full_name }));
  const s = state.settings.sync;
  s.repo = r;
  s.marker = insp.marker;
  s.repoPublic = !info.private;
  saveSettingsSoon();
  renderSyncCard();
  const head = [syncMessage(t(created ? 'sync.repoCreated' : 'sync.repoSelected', { name: repoLabel(r) }))];
  if (!insp.ids.length) {
    const go = await syncAsk(flow, [...head, syncMessage(t('sync.askFullBackup'))], [
      { label: t('sync.later'), value: false, ghost: true },
      { label: t('sync.pushAll'), value: true, primary: true },
    ]);
    if (go === true) return syncRun(flow, 'pushAll', true);
    return syncDialogClose();
  }
  const list = el('div', 'sync-list');
  if (insp.ids.length <= 5) {
    for (const id of insp.ids) {
      const m = syncIsObj(insp.meta[id]) ? insp.meta[id] : {};
      const time = typeof m.activeAt === 'number' ? fmtTime(m.activeAt) : typeof m.updatedAt === 'number' ? fmtTime(m.updatedAt) : '';
      list.append(el('div', 'sync-list-item', t('conv.option', {
        title: m.title || t('conv.untitled'), rounds: roundsText(Number.isInteger(m.rounds) ? m.rounds : 0), time, sep: ' · ',
      })));
    }
  }
  const pick = await syncAsk(flow, [...head, syncMessage(t('sync.repoHas', { n: insp.ids.length })), list], [
    { label: t('sync.later'), value: null, ghost: true },
    { label: t('sync.pullNew'), value: 'pullNew' },
    { label: t('sync.pullAll'), value: 'pullAll' },
    { label: t('sync.pushNew'), value: 'pushNew' },
    { label: t('sync.pushAll'), value: 'pushAll' },
  ]);
  if (!pick) return syncDialogClose();
  return syncRun(flow, pick, true);
}

// ---------------- 第一次上传：问加密和艺术图 ----------------

// 仓库还没有标记文件时问三件事，返回标记（取消则为 null）。同时按选择设置全局的艺术图同步
async function syncFirstPushQuestions(flow) {
  const box = (label, checked) => {
    const l = el('label', 'field-inline sync-check');
    const i = el('input');
    i.type = 'checkbox';
    i.checked = checked;
    l.append(i, el('span', '', label));
    return { l, i };
  };
  const enc = box(t('sync.qEncryptSettings'), false);
  const keys = box(t('sync.qEncryptKeys'), false);
  const art = box(t('sync.qUploadArt'), state.settings.sync.artDefault !== false);
  const ok = await syncAsk(flow, [syncMessage(t('sync.firstPush')), enc.l, keys.l, art.l, el('p', 'hint sync-first-hint', t('sync.firstPushHint'))], [
    { label: t('btn.cancel'), value: false, ghost: true },
    { label: t('sync.continue'), value: true, primary: true },
  ]);
  if (ok !== true) return null;
  let check = null;
  if (enc.i.checked || keys.i.checked) {
    const pw = await askPassword(t('sync.setPwTitle'), t('sync.setPwMessage'), true);
    if (pw === null) return null;
    check = await Locker.makeCheck(pw);
  }
  await setSyncArtAll(art.i.checked);
  return { app: 'proteus', type: 'sync', version: 1, encryptSettings: enc.i.checked, encryptKeys: keys.i.checked, check };
}

// ---------------- 执行操作 ----------------

const SYNC_OPS = ['pushAll', 'pushNew', 'pullAll', 'pullNew', 'pushConv', 'pullConv'];

// 在同步窗口里执行一个操作。inDialog：窗口已经打开（选择仓库之后）
async function syncRun(flow, op, inDialog = false) {
  if (!SYNC_OPS.includes(op) || syncBusy) return;
  if (!inDialog) flow = syncDialogOpen(t('sync.op.' + op));
  else els.syncDialogTitle.textContent = t('sync.op.' + op);
  const status = syncMessage(t('sync.working'));
  const progress = (text) => { status.textContent = text; };
  syncSetBody(status);
  syncSetButtons([]);
  syncBusy = true;
  renderSyncCard();
  try {
    const msg = await SYNC_IMPL[op](flow, progress, inDialog);
    if (msg === null) return syncDialogClose(); // 用户取消
    if (msg === 'reload') return; // 已经重新载入（boot 后显示了结果）
    syncShowDone(flow, msg);
  } catch (e) {
    console.error(e);
    syncShowDone(flow, e.message, true);
  } finally {
    syncBusy = false;
    renderSyncCard();
  }
}

// 仓库和标记：没有选仓库、仓库不是海神的，都报错。needMarker：上传前没有标记时问三件事
// confirm(insp)：看过仓库里有什么之后、问加密之前，让用户确认这次操作（返回 false 则取消）
async function syncPrepare(flow, needMarker, confirm) {
  const r = state.settings.sync.repo;
  if (!r) throw new SyncError(t('sync.noRepo'));
  const insp = await inspectRepo(r);
  if (insp.foreign) throw new SyncError(t('sync.foreignRepo', { name: repoLabel(r) }));
  await checkRepoPublic(r);
  if (confirm && !(await confirm(insp))) return null;
  let marker = insp.marker;
  let newMarker = false;
  if (!marker && needMarker) {
    marker = await syncFirstPushQuestions(flow);
    if (!marker) return null;
    newMarker = true;
    syncSetBody(syncMessage(t('sync.working')));
    syncSetButtons([]);
  }
  state.settings.sync.marker = marker;
  saveSettingsSoon();
  // 空仓库（还没有任何提交）：先用普通的文件接口写入标记文件，有了第一个提交才能用 Git Data API
  if (insp.empty && marker) {
    await gh('PUT', `${repoApi(r)}/contents/${SYNC_MARKER}`, { message: commitMessage('sync.commit.setup'), content: utf8ToB64(JSON.stringify(marker, null, 2)) });
    newMarker = false;
  }
  return { r, insp, marker, newMarker };
}

// 以前选的仓库可能是公开的（那时还能选公开仓库），或者后来在 GitHub 上改成了公开：照常同步，只在同步卡片上提示。
// 查不到时不影响同步
async function checkRepoPublic(r) {
  let info;
  try { info = await gh('GET', repoApi(r)); } catch (_) { return; }
  const pub = !!info && info.private === false;
  if (state.settings.sync.repoPublic === pub) return;
  state.settings.sync.repoPublic = pub;
  saveSettingsSoon();
  renderSyncCard();
}

// 确认这次操作：显示说明和「取消」「操作名」。确认后窗口回到「正在处理…」
async function syncConfirm(flow, op, message, danger = false) {
  const ok = await syncAsk(flow, [syncMessage(message, danger)], [
    { label: t('btn.cancel'), value: false, ghost: true },
    { label: t('sync.op.' + op), value: true, primary: !danger, danger },
  ]);
  if (ok !== true) return false;
  syncSetBody(syncMessage(t('sync.working')));
  syncSetButtons([]);
  return true;
}

function indexFile(meta) {
  return JSON.stringify({ app: 'proteus', type: 'sync-index', version: 1, conversations: meta }, null, 2);
}

// confirmed：在选择仓库的窗口里刚选了这个操作，不用再确认
async function syncPush(flow, progress, mode, confirmed) {
  await flushConvSave();
  const confirm = confirmed ? null : (insp) => {
    const local = state.conversations.filter((c) => syncSafeId(c.id));
    const repo = repoLabel(state.settings.sync.repo);
    if (mode === 'all') {
      const mine = new Set(local.map((c) => c.id));
      const remove = insp.ids.filter((id) => !mine.has(id)).length;
      return syncConfirm(flow, 'pushAll', t('sync.pushAllConfirm', { n: local.length, repo, remove }), remove > 0);
    }
    const remote = new Set(insp.ids);
    return syncConfirm(flow, 'pushNew', t('sync.pushNewConfirm', { n: local.filter((c) => !remote.has(c.id)).length, repo }));
  };
  const p = await syncPrepare(flow, true, confirm);
  if (!p) return null;
  const { r, insp, marker } = p;
  const files = {};
  if (p.newMarker) files[SYNC_MARKER] = JSON.stringify(marker, null, 2);
  const remote = new Set(insp.ids);
  const meta = mode === 'all' ? {} : { ...insp.meta };
  const local = state.conversations.filter((c) => syncSafeId(c.id));
  const upload = mode === 'all' ? local : local.filter((c) => !remote.has(c.id));
  let n = 0;
  for (const c of upload) {
    progress(t('sync.preparing', { n: ++n, total: upload.length }));
    files[syncConvPath(c.id)] = await convFile(c, marker);
    meta[c.id] = indexEntry(c);
  }
  let deleted = 0;
  if (mode === 'all') {
    const mine = new Set(local.map((c) => c.id));
    for (const id of insp.ids) if (!mine.has(id)) { files[syncConvPath(id)] = null; deleted++; }
  }
  for (const id of Object.keys(meta)) if (!remote.has(id) && !upload.some((c) => c.id === id)) delete meta[id]; // 索引里多余的
  files[SYNC_INDEX] = indexFile(meta);
  // LLM 设置
  let relaysAdded = 0;
  if (mode === 'all' || !insp.tree.has(SYNC_SETTINGS)) {
    files[SYNC_SETTINGS] = await settingsFile(localLlm(), { ...state.settings.apiKeys }, marker);
  } else {
    const file = await readJson(r, SYNC_SETTINGS);
    const llm = file && cleanLlm(file.llm);
    if (!llm) files[SYNC_SETTINGS] = await settingsFile(localLlm(), { ...state.settings.apiKeys }, marker);
    else {
      const { keys } = await keysOf(file, false, true);
      const remoteKeys = keys || {};
      relaysAdded = addMissingRelays(llm, remoteKeys, localLlm(), state.settings.apiKeys);
      if (relaysAdded) files[SYNC_SETTINGS] = await settingsFile(llm, remoteKeys, marker);
    }
  }
  if (mode === 'all' || !insp.tree.has(SYNC_CALIB)) files[SYNC_CALIB] = calibFile();
  if (mode !== 'all' && !upload.length && !relaysAdded && !p.newMarker && insp.tree.has(SYNC_CALIB) && insp.tree.has(SYNC_SETTINGS)) {
    return t('sync.nothingNew');
  }
  await commitFiles(r, files, mode === 'all' ? commitMessage('sync.commit.pushAll', { n: upload.length, deleted }) : commitMessage('sync.commit.pushNew', { n: upload.length, relays: relaysAdded }),
    (i, total) => progress(t('sync.uploading', { n: i, total })));
  return mode === 'all' ? t('sync.pushedAll', { n: upload.length, deleted }) : t('sync.pushedNew', { n: upload.length, relays: relaysAdded });
}

async function syncPull(flow, progress, mode, confirmed) {
  if (state.generating) throw new SyncError(t('conv.stopFirst'));
  await flushConvSave();
  const p = await syncPrepare(flow, false);
  if (!p) return null;
  const { r, insp, marker } = p;
  if (!insp.ids.length && !insp.tree.has(SYNC_SETTINGS)) return t('sync.repoEmpty');
  const localIds = new Set(state.conversations.map((c) => c.id));
  const want = mode === 'all' ? insp.ids : insp.ids.filter((id) => !localIds.has(id));
  if (mode !== 'all' && !confirmed && !(await syncConfirm(flow, 'pullNew', t('sync.pullNewConfirm', { n: want.length, repo: repoLabel(r) })))) return null;
  if (mode === 'all') {
    const remove = state.conversations.filter((c) => !insp.ids.includes(c.id)).length;
    const ok = await syncAsk(flow, [syncMessage(t('sync.pullAllConfirm', { n: insp.ids.length, local: state.conversations.length, remove }), true)], [
      { label: t('btn.cancel'), value: false, ghost: true },
      { label: t('sync.pullAll'), value: true, danger: true },
    ]);
    if (ok !== true) return null;
    syncSetBody(syncMessage(t('sync.working')));
    syncSetButtons([]);
  }
  // 先全部下载、检查，再写进本机：中途出错时本机不变
  const files = [];
  let n = 0;
  for (const id of want) {
    progress(t('sync.downloading', { n: ++n, total: want.length }));
    const f = await readJson(r, syncConvPath(id));
    if (validConvFile(f) && f.conversation.id === id) files.push(f);
  }
  const settings = insp.tree.has(SYNC_SETTINGS) ? await readJson(r, SYNC_SETTINGS) : null;
  const calib = insp.tree.has(SYNC_CALIB) ? await readJson(r, SYNC_CALIB) : null;
  const llm = settings && cleanLlm(settings.llm);
  // 用同步密码加的锁（对话的设定、API Key）：问一次密码
  const needPw = files.some((f) => f.conversation.lock && Locker.sameCheck(f.conversation.lock, marker && marker.check))
    || !!(llm && syncIsObj(settings.apiKeysLocked));
  const unlocked = await askSyncUnlock(marker, needPw);
  const unlockCheck = unlocked ? marker.check : null;
  syncSetBody(syncMessage(t('sync.saving')));
  // 写进本机
  const byId = new Map(state.conversations.map((c) => [c.id, c]));
  if (mode === 'all') {
    for (const c of state.conversations) {
      if (insp.ids.includes(c.id)) continue;
      await DB.deleteConversation(c.id);
      await DB.del(artKey(c.id));
    }
  }
  for (const f of files) await storeDownloaded(f, unlockCheck, byId.get(f.conversation.id) || null);
  let relaysAdded = 0;
  if (llm) {
    const { keys } = await keysOf(settings, unlocked);
    if (mode === 'all') applyLlm(llm, keys);
    else {
      const s = state.settings;
      const mine = { relays: s.relays, baseUrls: s.baseUrls, models: s.models, maxTokens: s.maxTokens, modelLists: s.modelLists, modelInfo: s.modelInfo };
      relaysAdded = addMissingRelays(mine, s.apiKeys, llm, keys);
    }
  }
  if (calib && syncIsObj(calib.tokenCalib)) {
    if (mode === 'all') TokenCalib.forget();
    TokenCalib.importData(calib.tokenCalib);
  }
  const keepConv = state.conv && (mode !== 'all' || insp.ids.includes(state.conv.id)) ? state.conv.id : null;
  state.settings.activeConvId = keepConv;
  await DB.set('settings', storableSettings());
  await boot();
  const msg = mode === 'all' ? t('sync.pulledAll', { n: files.length }) : t('sync.pulledNew', { n: files.length, relays: relaysAdded });
  syncShowDone(flow, msg + (needPw && !unlocked ? '\n' + t('sync.stillLocked') : ''));
  return 'reload';
}

async function syncPushConv(flow, progress) {
  await flushConvSave();
  const c = state.conv;
  if (!syncSafeId(c.id)) throw new SyncError(t('sync.badId'));
  const p = await syncPrepare(flow, true, (insp) => syncConfirm(flow, 'pushConv',
    t(insp.ids.includes(c.id) ? 'sync.pushConvConfirm' : 'sync.pushConvConfirmNew', { title: convTitle(c), repo: repoLabel(state.settings.sync.repo) })));
  if (!p) return null;
  const { r, insp, marker } = p;
  const files = {};
  if (p.newMarker) files[SYNC_MARKER] = JSON.stringify(marker, null, 2);
  files[syncConvPath(c.id)] = await convFile(c, marker);
  files[SYNC_INDEX] = indexFile({ ...insp.meta, [c.id]: indexEntry(c) });
  if (!insp.tree.has(SYNC_SETTINGS)) files[SYNC_SETTINGS] = await settingsFile(localLlm(), { ...state.settings.apiKeys }, marker);
  await commitFiles(r, files, commitMessage('sync.commit.pushConv', { title: convTitle(c) }), (i, total) => progress(t('sync.uploading', { n: i, total })));
  return t('sync.pushedConv', { title: convTitle(c) });
}

async function syncPullConv(flow, progress) {
  if (state.generating) throw new SyncError(t('conv.stopFirst'));
  await flushConvSave();
  const c = state.conv;
  const p = await syncPrepare(flow, false);
  if (!p) return null;
  const { r, insp, marker } = p;
  if (!insp.ids.includes(c.id)) return t('sync.convNotInRepo', { title: convTitle(c) });
  const ok = await syncAsk(flow, [syncMessage(t('sync.pullConvConfirm', { title: convTitle(c) }), true)], [
    { label: t('btn.cancel'), value: false, ghost: true },
    { label: t('sync.op.pullConv'), value: true, danger: true },
  ]);
  if (ok !== true) return null;
  syncSetBody(syncMessage(t('sync.working')));
  syncSetButtons([]);
  progress(t('sync.downloading', { n: 1, total: 1 }));
  const f = await readJson(r, syncConvPath(c.id));
  if (!validConvFile(f) || f.conversation.id !== c.id) throw new SyncError(t('restore.invalid'));
  const needPw = !!f.conversation.lock && Locker.sameCheck(f.conversation.lock, marker && marker.check);
  const unlocked = await askSyncUnlock(marker, needPw);
  await storeDownloaded(f, unlocked ? marker.check : null, c);
  state.settings.activeConvId = c.id;
  await DB.set('settings', storableSettings());
  await boot();
  syncShowDone(flow, t('sync.pulledConv', { title: convTitle(state.conv) }) + (needPw && !unlocked ? '\n' + t('sync.stillLocked') : ''));
  return 'reload';
}

const SYNC_IMPL = {
  pushAll: (flow, progress, confirmed) => syncPush(flow, progress, 'all', confirmed),
  pushNew: (flow, progress, confirmed) => syncPush(flow, progress, 'new', confirmed),
  pullAll: (flow, progress, confirmed) => syncPull(flow, progress, 'all', confirmed),
  pullNew: (flow, progress, confirmed) => syncPull(flow, progress, 'new', confirmed),
  pushConv: syncPushConv,
  pullConv: syncPullConv,
};

// ---------------- 艺术图、加密的设置 ----------------

// 全局的「同步艺术图」：改了就应用到所有对话（每个对话之后还可以单独改）
async function setSyncArtAll(on) {
  state.settings.sync.artDefault = !!on;
  saveSettingsSoon();
  for (const c of state.conversations) {
    if (c.syncArt === !!on) continue;
    c.syncArt = !!on;
    await DB.putConversation(storable(c));
  }
  renderSyncConv();
}

// 改仓库里的加密设置（下次上传时生效，已经上传的文件不变）
async function changeSyncEncryption(patch, checkbox) {
  const s = state.settings.sync;
  if (syncBusy || !s.repo) { checkbox.checked = !checkbox.checked; return; }
  syncBusy = true;
  try {
    const insp = await inspectRepo(s.repo);
    if (insp.foreign || !insp.marker) throw new SyncError(t('sync.noMarkerYet'));
    const m = { ...insp.marker, ...patch };
    if ((m.encryptSettings || m.encryptKeys) && !m.check) {
      const pw = await askPassword(t('sync.setPwTitle'), t('sync.setPwMessage'), true);
      if (pw === null) { checkbox.checked = !checkbox.checked; return; }
      m.check = await Locker.makeCheck(pw);
    }
    await commitFiles(s.repo, { [SYNC_MARKER]: JSON.stringify(m, null, 2) }, commitMessage('sync.commit.encryption'));
    s.marker = m;
    saveSettingsSoon();
    toast(t('sync.encryptionSaved'));
  } catch (e) {
    checkbox.checked = !checkbox.checked;
    showError(e.message);
  } finally {
    syncBusy = false;
    renderSyncCard();
  }
}

// ---------------- 设置区 ----------------

function renderSyncCard() {
  if (!state.settings || !els.syncCard) return;
  const s = state.settings.sync;
  const loggedIn = !!s.login;
  els.syncLoggedOut.hidden = loggedIn;
  els.syncLoggedIn.hidden = !loggedIn;
  if (loggedIn) {
    els.syncAccount.textContent = t('sync.account', { login: s.login });
    els.syncRepoLink.hidden = !s.repo;
    if (s.repo) { els.syncRepoLink.textContent = repoLabel(s.repo); els.syncRepoLink.href = repoUrl(s.repo); }
    els.syncPublicWarning.hidden = !s.repo || !s.repoPublic;
    els.syncNoRepo.hidden = !!s.repo;
    els.btnSyncChangeRepo.hidden = !s.repo;
    els.syncOps.hidden = !s.repo;
    els.syncArtAll.checked = s.artDefault !== false;
    const m = s.marker;
    els.syncEncryptRow.hidden = !m;
    if (m) {
      els.syncEncSettings.checked = !!m.encryptSettings;
      els.syncEncKeys.checked = !!m.encryptKeys;
    }
    for (const b of els.syncOps.querySelectorAll('button, input')) b.disabled = syncBusy;
  }
  renderSyncConv();
}

// 右侧艺术图里「此对话的艺术图同步到 GitHub 仓库」：登录并选好仓库后才显示
function renderSyncConv() {
  if (!state.settings || !state.conv || !els.syncArtConvRow) return;
  const s = state.settings.sync;
  const show = !!s.login && !!s.repo;
  els.syncArtConvRow.hidden = !show;
  if (show) els.syncArtConv.checked = syncArtOf(state.conv);
}

function bindSync() {
  els.btnSyncLogin.addEventListener('click', () => void syncLogin());
  els.btnSyncLogout.addEventListener('click', () => void syncLogout());
  els.btnSyncSetup.addEventListener('click', () => { const flow = syncDialogOpen(t('sync.chooseRepoTitle')); syncChooseRepo(flow, ''); });
  els.btnSyncChangeRepo.addEventListener('click', () => { const flow = syncDialogOpen(t('sync.chooseRepoTitle')); syncChooseRepo(flow, ''); });
  for (const op of SYNC_OPS) {
    const b = els['btnSync_' + op];
    if (b) b.addEventListener('click', () => void syncRun(0, op));
  }
  els.syncArtAll.addEventListener('change', () => void setSyncArtAll(els.syncArtAll.checked));
  els.syncArtConv.addEventListener('change', () => {
    state.conv.syncArt = els.syncArtConv.checked;
    saveConvSoon();
  });
  els.syncEncSettings.addEventListener('change', () => void changeSyncEncryption({ encryptSettings: els.syncEncSettings.checked }, els.syncEncSettings));
  els.syncEncKeys.addEventListener('change', () => void changeSyncEncryption({ encryptKeys: els.syncEncKeys.checked }, els.syncEncKeys));
  // 同步窗口不能用 Esc 关闭（和添加服务商的窗口一样）
  document.addEventListener('keydown', (e) => {
    if (els.syncDialog.hidden || e.key !== 'Escape') return;
    // 窗口上面还打开着确认框、密码框时，让它们自己处理
    if (!els.dialog.hidden || !els.pwDialog.hidden) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

// ---------------- 本地读取 settings.json / calibration.json ----------------

// restore() 读到 type 为 settings 的文件：覆盖本机的 LLM 设置。返回 true 表示处理了
async function restoreSyncFile(data) {
  if (data.type === 'calibration') {
    if (!syncIsObj(data.tokenCalib)) return toast(t('restore.invalid')), true;
    if (!(await ask(t('restore.calibConfirm')))) return true;
    TokenCalib.importData(data.tokenCalib);
    toast(t('restore.calibDone'));
    if (state.conv) updateEstimate();
    return true;
  }
  if (data.type !== 'settings') return false;
  const llm = cleanLlm(data.llm);
  if (!llm) return toast(t('restore.invalid')), true;
  if (!(await ask(t('restore.settingsConfirm'), { ok: t('restore.settingsOk') }))) return true;
  let keys = null;
  if (syncIsObj(data.apiKeysLocked)) {
    for (;;) {
      const pw = await askPassword(t('sync.unlockTitle'), t('restore.settingsKeysPw'), false);
      if (pw === null) break;
      if (await Locker.checkPassword(data.apiKeysLocked, pw)) { keys = (await keysOf(data, true)).keys; break; }
      toast(t('lock.wrongPw'));
    }
  } else keys = cleanKeys(data.apiKeys);
  applyLlm(llm, keys);
  await DB.set('settings', storableSettings());
  await boot();
  toast(t(keys ? 'restore.settingsDone' : 'restore.settingsDoneNoKeys'));
  return true;
}
