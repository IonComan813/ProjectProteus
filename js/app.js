// 主程序：界面、对话管理、上下文拼装。
//
// 数据分两类：
//   - 每个对话各自保存：System Prompt、世界观、用户人设、{{user}} 的值（userName）、重点指令（postHistory）、
//     开场白（可以有多个版本：greetings 和当前版本的序号 greetingCur，greeting 是当前版本）、剧情，
//     以及艺术图（存在 art:<对话id>）。新建对话时复制当前对话的设定和开场白，之后互不影响。
//   - 来自加密世界卡的对话带有 conv.lock：System Prompt、世界观、重点指令、开场白和艺术图只以密文保存，
//     在内存里解密后使用，界面上不能查看或修改，输入密码解锁后变回普通对话。
//   - 酒馆兼容对话（带 conv.tavern = { char, book }）：导入酒馆（SillyTavern）的角色卡或世界书得到的角色扮演对话。
//     char 是角色卡的名字（还没有角色卡时为 null），book 是世界书的名字（还没有世界书时为 null）。
//     内容里的 {{char}} 在显示和发送时换成 char。
//   - 助理模式的对话（conv.mode === 'assistant'）：普通的 LLM 对话，只发送 System Prompt 和对话记录。
//     世界观、用户人设、{{user}} 的值、重点指令、开场白都不使用（保持为空），也不加密；艺术图照常可用。没有 mode 的就是角色扮演对话，
//     所以存储和备份格式与角色扮演对话相同。
//   - 软件设置（所有对话共用）：界面语言、记忆长度、模型与接口、API Key、布局。

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 40;

const DEFAULT_SETTINGS = {
  lang: null,          // null = 按系统语言自动选择（不支持的语言用英语）
  rememberKeys: true,  // false = API Key 只在本次打开期间有效，不写入本机存储（公用电脑）
  rounds: 12,
  artWidth: null,      // 左栏宽度（像素），null = 自动
  inputHeight: 88,     // 输入框高度（像素）
  provider: 'anthropic',
  apiKeys: {},
  baseUrls: {},
  models: { anthropic: PROVIDERS.anthropic.defaultModel },
  maxTokens: { anthropic: 16000, custom_anthropic: 16000 },
  modelLists: {},      // 各服务商“获取列表”得到的模型名，记下来供下拉选择
  effort: '',
  useTemperature: false,
  temperature: 1,
  activeConvId: null,
};

const state = {
  settings: null,
  conversations: [],   // 所有对话（完整数据都放在内存里）
  conv: null,          // 当前对话
  generating: null,    // { controller, msgId }
  editingId: null,
  editDraft: '',
  follow: true,        // 生成时是否自动滚到底部
  artUrl: null,
  views: new Map(),    // 消息 id → 界面元素
  renderedConvId: null,
  greetingMode: null,  // 正在用输入框编辑开场白时为 { preview }
  version: null,       // 当前运行的版本号（网页版为 null）
};

const els = {};

// ---------------- 工具函数 ----------------

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 粗略估算 token 数：中日韩文字约 1 字 1 token，其他约 4 个字符 1 token
function estimateTokens(s) {
  if (!s) return 0;
  const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

function showError(msg) {
  els.errorBar.textContent = msg;
  els.errorBar.hidden = !msg;
}

function showModal(title, body) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = body;
  els.modal.hidden = false;
}

// 安卓版（Capacitor）里网页不能直接下载文件，改为写入临时文件后弹出系统分享菜单（可存到“文件”、网盘或发给别人）
const NATIVE = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? window.Capacitor : null;
function nativePlugin(name) {
  return (NATIVE.Plugins && NATIVE.Plugins[name]) || NATIVE.registerPlugin(name);
}

async function shareFile(filename, blob) {
  try {
    const data = (await blobToDataURL(blob)).split(',')[1];
    const file = await nativePlugin('Filesystem').writeFile({ path: filename, data, directory: 'CACHE' });
    await nativePlugin('Share').share({ title: filename, files: [file.uri] });
  } catch (e) {
    if (!/cancel/i.test(String(e && e.message))) showError(t('export.shareFailed') + '\n' + (e && e.message || e));
  }
}

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
  // 安卓版：用系统分享菜单。不用等它完成，出错和取消都由 shareFile 自己处理
  if (NATIVE) {
    void shareFile(filename, blob);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function safeFilename(s) {
  return (s || 'proteus').replace(/[\\/:*?"<>|\n]/g, '_').slice(0, 60);
}

const msgText = (m) => m.versions[m.cur] || '';
const convTitle = (c) => c.title || t('conv.untitled');
const artKey = (id) => 'art:' + id;

// ---------------- 保存 ----------------

// 要写入本机存储的软件设置：不记住 API Key 时把它去掉
function storableSettings() {
  const s = state.settings;
  return s.rememberKeys === false ? { ...s, apiKeys: {} } : s;
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.set('settings', storableSettings()), 300);
}

// 要写入本机存储（和备份）的对话：锁定的对话不保存明文，那几项只在 conv.lock 里以密文存在。
// 开场白当前是第几个版本（greetingCur）不是受保护的内容，保存在锁外面：锁定的对话在开始前也可以切换开场白
const LOCKED_FIELDS = ['systemPrompt', 'worldText', 'postHistory', 'greeting', 'greetings', 'greetingSend'];
function storable(conv) {
  if (!conv.lock) return conv;
  const out = { ...conv };
  for (const k of LOCKED_FIELDS) delete out[k];
  return out;
}
const lockedFields = (c) => ({
  systemPrompt: c.systemPrompt, worldText: c.worldText, postHistory: c.postHistory,
  greeting: c.greeting, greetings: c.greetings.slice(), greetingSend: c.greetingSend !== false,
});

// 锁定的对话在读取后解密到内存
async function openLock(conv) {
  if (conv.lock) Object.assign(conv, await Locker.open(conv.lock));
  return conv;
}

// 对话列表里显示的时间，也按它排序。只在重要变化时更新：新建对话、保存开场白（新增、修改、删除）、
// 向模型发出请求（发送、重新生成、编辑用户消息后重新生成、补一条回复），不论回复是否成功。
// 其他改动（右侧设定和人设、改写模型回复、切换或删除版本、回退、重命名……）照常保存，不更新这个时间。
// updatedAt 仍是最后一次保存的时间
function touchConv(conv) {
  conv.activeAt = Date.now();
}

// 轮数：用户的一条消息加上它的模型回复算一轮，所以就是用户消息的条数。
// 开场白不单独计数；回复失败、还没有回复的也算一轮，之后生成出回复不再加；重新生成、编辑用户消息不增加
function roundsOf(conv) {
  return conv.messages.filter((m) => m.role === 'user').length;
}

async function saveConv(conv = state.conv) {
  conv.updatedAt = Date.now();
  await DB.putConversation(storable(conv));
  renderConvSelect();
}

// 右侧设定改动频繁，稍等一下再保存；切换对话前会先存掉
let convSaveTimer = null;
let convSavePending = null;
function saveConvSoon() {
  convSavePending = state.conv;
  clearTimeout(convSaveTimer);
  convSaveTimer = setTimeout(flushConvSave, 400);
}
async function flushConvSave() {
  clearTimeout(convSaveTimer);
  const c = convSavePending;
  convSavePending = null;
  if (c) await saveConv(c);
}

function providerCfg() {
  const s = state.settings;
  const p = s.provider;
  return {
    provider: p,
    apiKey: (s.apiKeys[p] || '').trim(),
    baseUrl: s.baseUrls[p] || '',
    model: (s.models[p] || '').trim(),
    maxTokens: Number(s.maxTokens[p]) || 0,
    effort: s.effort,
    useTemperature: s.useTemperature,
    temperature: s.temperature,
  };
}

// ---------------- 上下文拼装 ----------------
// 顺序：System Prompt → 世界观 → 用户角色人设（都取自当前对话）。重点指令加在这一次的用户消息末尾。
// 最后把所有内容里的 {{user}} 换成 {{user}} 的值（没填时原样保留）

function buildSystem(conv = state.conv) {
  // 助理模式只发送 System Prompt，不带世界观、人设和它们的标签
  if (isAssistant(conv)) return conv.systemPrompt.trim();
  const parts = [];
  if (conv.systemPrompt.trim()) parts.push(conv.systemPrompt.trim());
  if (conv.worldText.trim()) parts.push(t('sys.world') + '\n' + conv.worldText.trim());
  if (conv.persona.trim()) parts.push(t('sys.persona') + '\n' + conv.persona.trim());
  return parts.join('\n\n');
}

// 显示和发送时替换的宏（不区分大小写）。存着的内容不变；没有值时原样保留：
//   {{user}} → {{user}} 的值；{{char}} → 酒馆兼容对话里角色卡的名字
const USER_MACRO = /\{\{user\}\}/gi;
const CHAR_MACRO = /\{\{char\}\}/gi;
function withMacros(text, conv = state.conv) {
  if (!text || !conv || isAssistant(conv)) return text;
  const user = (conv.userName || '').trim();
  const char = conv.tavern && conv.tavern.char ? conv.tavern.char.trim() : '';
  let out = text;
  if (user) out = out.replace(USER_MACRO, () => user);
  if (char) out = out.replace(CHAR_MACRO, () => char);
  return out;
}

// 加在这一次的用户消息末尾的重点指令（带标签）；没有内容时为空
function postHistoryBlock(conv) {
  const text = !isAssistant(conv) && conv.postHistory ? conv.postHistory.trim() : '';
  return text ? `${t('sys.postHistory')}\n${text}` : '';
}

// 真正发给模型的内容：system 部分和记忆范围内的消息（context 的最后一条是这一次的用户消息）
function requestOf(conv, context) {
  const messages = windowOf(context, sentGreeting(conv));
  const block = postHistoryBlock(conv);
  const last = messages[messages.length - 1];
  if (block && last && last.role === 'user') last.content += '\n\n' + block;
  return {
    system: withMacros(buildSystem(conv), conv),
    messages: messages.map((m) => ({ role: m.role, content: withMacros(m.content, conv) })),
    postHistory: withMacros(block, conv),
  };
}

// 开场白和用户第一条消息合在一起，作为发给模型的第一条消息
function withGreeting(greeting, text) {
  return `${t('greet.header')}\n${greeting}\n${t('greet.footer')}\n\n${t('greet.user')}\n${text}`;
}

// 要发给模型的开场白：没有开场白或设为“不发送”时为 null
function sentGreeting(conv) {
  return conv.greeting != null && conv.greetingSend !== false ? conv.greeting : null;
}

// messages 是从对话开头算起的一串消息，最后一条是用户这次的回复。
// 取出最后一条 + 之前的 N 轮（2N 条）。如果对话的第一条消息还在范围内，就把开场白拼进去。
function windowOf(messages, greeting = sentGreeting(state.conv)) {
  const keep = state.settings.rounds * 2 + 1;
  const start = Math.max(0, messages.length - keep);
  return messages.slice(start).map((m, i) => {
    let content = msgText(m);
    if (start + i === 0 && greeting && m.role === 'user') content = withGreeting(greeting, content);
    return { role: m.role, content };
  });
}

// 当前对话里，从第几条开始在下一次请求的记忆范围内
function memoryCutoff() {
  const msgs = state.conv.messages;
  const last = msgs[msgs.length - 1];
  const lastIsUser = last && last.role === 'user';
  return msgs.length - state.settings.rounds * 2 - (lastIsUser ? 1 : 0);
}

// ---------------- 对话管理 ----------------

const isAssistant = (conv) => !!conv && conv.mode === 'assistant';
const isTavern = (conv) => !!conv && !isAssistant(conv) && !!conv.tavern;

// 对话的类型：roleplay（角色扮演）、assistant（助理模式）、tavern（酒馆兼容）。对话列表里名称前的 emoji 也按它
const kindOf = (conv) => (isAssistant(conv) ? 'assistant' : isTavern(conv) ? 'tavern' : 'roleplay');
const KIND_EMOJI = { roleplay: '🎭', assistant: '🤖', tavern: '🍺' };

// 这种模式的默认 System Prompt
const defaultPromptOf = (conv) => t(isAssistant(conv) ? 'defaultAssistantPrompt' : 'defaultSystemPrompt');

// 新建对话。from 是要复制设定和开场白的对话（不复制剧情）；锁定状态也一起复制。
// assistant = true 时新建助理模式的对话：只复制助理模式对话的 System Prompt，其他全部为空（艺术图由调用方复制）
function newConversation(from, assistant = isAssistant(from)) {
  const now = Date.now();
  if (assistant) {
    return {
      id: uid(),
      title: '',
      mode: 'assistant',
      systemPrompt: isAssistant(from) ? from.systemPrompt : t('defaultAssistantPrompt'),
      worldText: '',
      persona: '',
      userName: '',
      postHistory: '',
      greeting: null,
      greetings: [],
      greetingCur: 0,
      greetingSend: true,
      createdAt: now,
      updatedAt: now,
      activeAt: now,
      messages: [],
    };
  }
  if (isAssistant(from)) from = null;
  const c = {
    id: uid(),
    title: '',
    systemPrompt: from ? from.systemPrompt : t('defaultSystemPrompt'),
    worldText: from ? from.worldText : '',
    persona: from ? from.persona : '',
    userName: from ? from.userName : '',
    postHistory: from ? from.postHistory : '',
    greeting: from ? from.greeting : null,
    greetings: from ? from.greetings.slice() : [],
    greetingCur: from ? from.greetingCur : 0,
    greetingSend: from ? from.greetingSend !== false : true,
    createdAt: now,
    updatedAt: now,
    activeAt: now,
    messages: [],
  };
  if (from && from.lock) c.lock = from.lock;
  if (isTavern(from)) c.tavern = { ...from.tavern };
  return c;
}

// 补齐旧版本数据缺少的字段
function normalizeConv(c, legacy) {
  if (c.title === '新对话') c.title = '';
  if (isAssistant(c)) {
    // 助理模式：只有 System Prompt 和对话记录，其他保持为空；不加密
    delete c.lock;
    delete c.tavern;
    if (typeof c.systemPrompt !== 'string') c.systemPrompt = t('defaultAssistantPrompt');
    c.worldText = '';
    c.persona = '';
    c.userName = '';
    c.postHistory = '';
    c.greeting = null;
    c.greetings = [];
    c.greetingCur = 0;
    c.greetingSend = true;
    if (!Array.isArray(c.messages)) c.messages = [];
    if (typeof c.activeAt !== 'number') c.activeAt = c.updatedAt || c.createdAt || Date.now();
    return c;
  }
  if (c.mode !== undefined) delete c.mode;
  if (typeof c.systemPrompt !== 'string') c.systemPrompt = legacy && typeof legacy.systemPrompt === 'string' ? legacy.systemPrompt : t('defaultSystemPrompt');
  // 还是旧版本的默认 System Prompt（没改过）就换成新的默认值；锁定的对话不能改
  if (!c.lock && isPreviousDefaultSystemPrompt(c.systemPrompt)) c.systemPrompt = t('defaultSystemPrompt');
  if (typeof c.worldText !== 'string') c.worldText = (legacy && legacy.worldText) || '';
  if (typeof c.persona !== 'string') c.persona = (legacy && legacy.persona) || '';
  if (typeof c.userName !== 'string') c.userName = '';
  normalizeTavern(c);
  if (typeof c.postHistory !== 'string') c.postHistory = '';
  normalizeGreetings(c);
  if (c.greetingSend === undefined) c.greetingSend = true;
  if (!Array.isArray(c.messages)) c.messages = [];
  // 旧版本没有 activeAt：用最后一次保存的时间代替
  if (typeof c.activeAt !== 'number') c.activeAt = c.updatedAt || c.createdAt || Date.now();
  return c;
}

// 酒馆兼容对话的标签：{ char, book }，各自是字符串或 null
function normalizeTavern(c) {
  if (c.tavern === undefined) return;
  const x = c.tavern;
  if (!x || typeof x !== 'object') { delete c.tavern; return; }
  c.tavern = { char: typeof x.char === 'string' ? x.char : null, book: typeof x.book === 'string' ? x.book : null };
}

// 开场白的多个版本：greetings 是全部版本，greetingCur 是当前版本的序号，greeting 是当前版本（没有开场白时为 null）。
// 保留 greeting 是为了兼容旧版本：旧版本只认 greeting，读到新文件时也能拿到当前的开场白。
function syncGreeting(c) {
  const n = c.greetings.length;
  c.greetingCur = n ? Math.min(Math.max(0, c.greetingCur), n - 1) : 0;
  c.greeting = n ? c.greetings[c.greetingCur] : null;
}

function normalizeGreetings(c) {
  const list = Array.isArray(c.greetings) && c.greetings.length && c.greetings.every((x) => typeof x === 'string');
  if (!Number.isInteger(c.greetingCur)) c.greetingCur = 0;
  if (c.lock) {
    // 锁定的对话：版本都在锁里；旧版本做的锁里只有 greeting
    if (!list) c.greetings = typeof c.greeting === 'string' ? [c.greeting] : [];
  } else if (typeof c.greeting !== 'string') {
    c.greetings = []; // 没有开场白（也可能是旧版本删掉了它）
  } else if (!list) {
    c.greetings = [c.greeting];
    c.greetingCur = 0;
  } else {
    // 旧版本改过开场白时，greeting 和当前版本对不上：以 greeting 为准
    c.greetingCur = Math.min(Math.max(0, c.greetingCur), c.greetings.length - 1);
    if (c.greetings[c.greetingCur] !== c.greeting) c.greetings[c.greetingCur] = c.greeting;
  }
  syncGreeting(c);
}

async function switchConv(id) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  await flushConvSave();
  closeExpand();
  state.conv = conv;
  state.editingId = null;
  state.greetingMode = null;
  state.settings.activeConvId = id;
  saveSettingsSoon();
  showError('');
  fillConvFields();
  renderConvSelect();
  renderMessages();
  scrollToBottom();
  await loadArt();
}

// 新建一个对话。kind 是要新建的类型（roleplay / assistant / tavern），默认和当前对话相同。
// 设定、开场白和艺术图复制自这种类型最近使用的对话（就是当前对话时复制当前对话）；还没有这种对话时用默认值。
// 助理模式只复制 System Prompt 和艺术图。
// 酒馆兼容对话：在酒馆兼容对话里新建时复制当前对话的全部设定（剧情除外）；在其他对话里新建时要先选择酒馆的文件读取
async function createConversation(kind = kindOf(state.conv)) {
  closeNewConvMenu();
  if (state.generating) return toast(t('conv.stopFirst'));
  if (kind === 'tavern' && !isTavern(state.conv)) {
    const go = await choose(t('conv.newTavern'), t('conv.tavernNeedsImport'), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('conv.pickTavernFile'), value: true, primary: true },
    ]);
    if (go) els.fileTavern.click();
    return;
  }
  await flushConvSave();
  const from = kindOf(state.conv) === kind ? state.conv
    : [...state.conversations].filter((x) => kindOf(x) === kind).sort((a, b) => b.activeAt - a.activeAt)[0];
  const c = newConversation(from, kind === 'assistant');
  state.conversations.push(c);
  await DB.putConversation(storable(c));
  const art = from && (await DB.get(artKey(from.id)));
  if (art) await DB.set(artKey(c.id), art);
  await switchConv(c.id);
  els.input.focus();
}

// “＋ 新对话”的菜单：🎭 角色扮演、🤖 助理模式、🍺 酒馆兼容
const newConvItems = () => [els.btnNewRoleplay, els.btnNewAssistant, els.btnNewTavern];

function openNewConvMenu() {
  closeConvMenu();
  els.newConvMenu.hidden = false;
  els.btnNewConv.setAttribute('aria-expanded', 'true');
  els.btnNewRoleplay.focus();
}

function closeNewConvMenu() {
  if (els.newConvMenu.hidden) return;
  els.newConvMenu.hidden = true;
  els.btnNewConv.setAttribute('aria-expanded', 'false');
}

const roundsText = (n) => t(n === 1 ? 'conv.round1' : 'conv.rounds', { n });

const convLabel = (c) => KIND_EMOJI[kindOf(c)] + ' ' + (c.lock ? '🔒 ' : '') + t('conv.option', { title: convTitle(c), rounds: roundsText(roundsOf(c)), time: fmtTime(c.activeAt) });

// 对话列表（顶部）。按最近一次活动的时间排序
function renderConvSelect() {
  els.convCurrent.textContent = state.conv ? convLabel(state.conv) : '';
  if (!els.convMenu.hidden) fillConvMenu();
}

const convMenu = { items: [], active: -1 };

function fillConvMenu() {
  convMenu.items = [...state.conversations].sort((a, b) => b.activeAt - a.activeAt);
  els.convMenu.innerHTML = '';
  convMenu.items.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'combo-item' + (c === state.conv ? ' current' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(c === state.conv));
    item.textContent = item.title = convLabel(c);
    item.addEventListener('click', () => pickConv(c));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      highlightConv(i, false);
      openConvCtxMenu(c, e.clientX, e.clientY);
    });
    item.addEventListener('mousemove', () => highlightConv(i, false));
    els.convMenu.appendChild(item);
  });
  if (convMenu.active >= convMenu.items.length) convMenu.active = convMenu.items.length - 1;
  highlightConv(convMenu.active, false);
}

function openConvMenu() {
  closeNewConvMenu();
  convMenu.active = -1;
  fillConvMenu();
  els.convMenu.hidden = false;
  els.convSelect.setAttribute('aria-expanded', 'true');
  highlightConv(convMenu.items.indexOf(state.conv), true);
}

function closeConvMenu() {
  closeConvCtxMenu();
  if (els.convMenu.hidden) return;
  els.convMenu.hidden = true;
  els.convSelect.setAttribute('aria-expanded', 'false');
}

function highlightConv(i, scroll) {
  convMenu.active = i;
  const items = els.convMenu.querySelectorAll('.combo-item');
  items.forEach((el, j) => el.classList.toggle('active', j === i));
  if (items[i] && scroll) items[i].scrollIntoView({ block: 'nearest' });
}

function pickConv(c) {
  closeConvMenu();
  // 不用等切换完成：switchConv 自己处理“生成中不能切换”等情况
  if (c !== state.conv) void switchConv(c.id);
}

// 右键菜单：只有“删除”，删除的是右键点中的那个对话（不一定是当前对话）
let ctxConv = null;

function openConvCtxMenu(conv, x, y) {
  ctxConv = conv;
  const m = els.convCtxMenu;
  m.hidden = false;
  // 出现在光标右下方；靠近窗口边缘时往回收，不超出窗口
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4)) + 'px';
  els.btnCtxRename.focus();
}

function closeConvCtxMenu() {
  els.convCtxMenu.hidden = true;
  ctxConv = null;
}

// 从一段可能含 Markdown/HTML 的文字里提取对话标题
function titleFrom(text) {
  const plain = text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ') // 不跨过下一个 <：避免很多 < 却没有 > 时反复扫描到结尾
    .replace(/[#*_`>~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 20);
}

// ---------------- 消息渲染 ----------------
// 每条消息对应一个“视图”（state.views），内容没变时不重新加载里面的 iframe，
// 这样切换版本、调记忆长度等操作时页面不会闪动或跳动。

const GREETING_ID = '__greeting';
const PREVIEW_ID = '__greeting_preview';

function renderMessages() {
  const box = els.messages;
  const conv = state.conv;
  if (state.renderedConvId !== conv.id) {
    box.innerHTML = '';
    state.views.clear();
    state.renderedConvId = conv.id;
  }

  const items = [];
  const gm = state.greetingMode;
  // 新增开场白版本时，预览代替当前的开场白显示
  if (gm && gm.preview != null) items.push({ id: PREVIEW_ID, preview: true });
  else if (conv.greeting != null) items.push({ id: GREETING_ID, greeting: true });
  conv.messages.forEach((m, i) => items.push({ id: m.id, m, i }));

  box.querySelectorAll('.empty-hint, .memory-divider').forEach((el) => el.remove());
  const ids = new Set(items.map((it) => it.id));
  for (const [id, v] of state.views) {
    if (!ids.has(id)) { v.el.remove(); state.views.delete(id); }
  }

  if (!items.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    if (gm) {
      hint.textContent = t('msg.emptyGreetingMode');
    } else if (isAssistant(conv)) {
      hint.append(t('msg.emptyAssistant'), document.createElement('br'));
      const sub = document.createElement('span');
      sub.className = 'small';
      sub.append(t('msg.emptyAssistantSub1'), document.createElement('br'), t(isMobileLayout() ? 'msg.emptyAssistantSub2Mobile' : 'msg.emptyAssistantSub2'));
      hint.appendChild(sub);
    } else {
      hint.append(t('msg.empty'), document.createElement('br'));
      const sub = document.createElement('span');
      sub.className = 'small';
      sub.append(t('msg.emptySub1'), document.createElement('br'), t(isMobileLayout() ? 'msg.emptySub2Mobile' : 'msg.emptySub2'));
      hint.appendChild(sub);
    }
    box.appendChild(hint);
    updateComposer();
    return;
  }

  const cutoff = memoryCutoff();
  let prev = null;
  for (const it of items) {
    let v = state.views.get(it.id);
    if (!v) { v = createView(it); state.views.set(it.id, v); }
    updateView(v, it);
    // 只有新建的视图才需要插入；已有的保持原位（移动 iframe 会让它重新加载）
    if (!v.el.parentNode) box.insertBefore(v.el, prev ? prev.nextSibling : box.firstChild);
    prev = v.el;
  }

  if (cutoff > 0) {
    const d = document.createElement('div');
    d.className = 'memory-divider';
    d.textContent = t(sentGreeting(conv) != null ? 'msg.memoryDividerGreeting' : 'msg.memoryDivider', { n: cutoff });
    box.insertBefore(d, state.views.get(conv.messages[cutoff].id).el);
  }
  updateComposer();
}

function createView(it) {
  const el = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'msg-label';
  const holder = document.createElement('div');
  holder.className = 'msg-body';
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  el.append(label, holder);
  let sendBox = null;
  let sendText = null;
  if (it.greeting) {
    // 开场白下方常驻的勾选框：是否发给模型
    const row = document.createElement('label');
    row.className = 'greeting-send';
    sendBox = document.createElement('input');
    sendBox.type = 'checkbox';
    sendBox.addEventListener('change', async () => {
      state.conv.greetingSend = sendBox.checked;
      renderMessages();
      await saveConv();
    });
    sendText = document.createElement('span');
    row.append(sendBox, sendText);
    el.appendChild(row);
  }
  el.appendChild(actions);
  return { el, label, holder, actions, sendBox, sendText, frame: null, editor: null, shownText: null };
}

function updateView(v, it) {
  const conv = state.conv;
  const m = it.m;
  const role = it.greeting || it.preview ? 'greeting' : m.role;
  const busy = !!state.generating;
  const isGen = busy && m && state.generating.msgId === m.id;
  // 显示的内容：{{user}} 换成 {{user}} 的值（存着的内容不变，编辑框里也是原文）
  const text = withMacros(it.greeting ? conv.greeting : it.preview ? state.greetingMode.preview : msgText(m), conv);

  v.el.className = 'msg ' + role + (it.preview ? ' preview' : '');
  v.el.dataset.id = it.id;
  v.el.classList.toggle('generating', isGen);
  v.label.textContent = it.greeting ? t('msg.greeting') : it.preview ? t('msg.greetingPreview') : m.role === 'user' ? t('msg.you') : t(isAssistant(conv) ? 'msg.assistant' : 'msg.story');
  if (isGen) v.label.textContent += t('msg.generating');
  if (v.sendBox) {
    v.sendBox.checked = conv.greetingSend !== false;
    // 锁定的世界卡、或者对话已经开始后，开场白的设置不能再改
    v.sendBox.disabled = !!conv.lock || conv.messages.length > 0 || !!state.generating;
    v.sendText.textContent = ' ' + t('msg.greetingSend');
  }

  // 编辑状态：隐藏显示区域，换成文本框
  const editing = state.editingId === it.id;
  v.el.classList.toggle('editing', editing);
  if (editing && !v.editor) {
    v.editor = buildEditor(it.id);
    v.el.insertBefore(v.editor, v.holder);
  } else if (!editing && v.editor) {
    v.editor.remove();
    v.editor = null;
  }
  // 不能用 hidden（display: none）：开场白窗口隐藏期间如果重新载入，Electron 里新文档会一直处在
  // “窗口不显示”的状态，量出来高度是 0，保存后显示空白。所以只是把显示区域收起来，窗口照常布局
  v.holder.classList.toggle('stashed', editing);

  // 内容。只有开场白（和它的预览）允许运行 JS；锁定的开场白不能选中复制
  const scripts = !!(it.greeting || it.preview);
  const locked = !!(it.greeting && conv.lock);
  if (isGen) {
    if (!v.frame) { v.frame = Render.create('', { scripts }); v.holder.appendChild(v.frame); }
    v.shownText = null; // 生成结束后用完整内容再显示一次
    if (!text) Render.stream(v.frame, '', Render.thinkingHtml(t('msg.waiting')));
  } else if (v.shownText !== text || v.shownLocked !== locked) {
    if (!v.frame) { v.frame = Render.create(text, { scripts, locked }); v.holder.appendChild(v.frame); }
    else Render.set(v.frame, text, { locked });
    v.shownText = text;
    v.shownLocked = locked;
  }

  // 操作按钮
  v.actions.innerHTML = '';
  if (editing || it.preview) return;
  if (it.greeting) {
    const open = !conv.messages.length; // 对话还没开始
    const frozen = busy || !!state.greetingMode;
    const n = conv.greetings.length;
    // 多个版本：对话开始前可以切换（锁定的对话也可以）；开始后当前版本定下来
    if (open && n > 1) v.actions.appendChild(swipe(conv.greetingCur, n, (d) => switchGreeting(d), frozen));
    if (locked) {
      const tag = document.createElement('span');
      tag.className = 'lock-tag';
      tag.textContent = t('lock.greetingTag');
      v.actions.appendChild(tag);
      return;
    }
    v.actions.append(button(t('msg.copy'), () => copyText(withMacros(conv.greeting, conv))));
    // 对话开始后开场白锁定：要换开场白请新建对话
    if (open) {
      v.actions.append(
        disabled(button(t('msg.edit'), () => startEdit(GREETING_ID, conv.greeting)), frozen),
        disabled(button(t('msg.addGreetingVersion'), () => enterGreetingMode(true)), frozen, t('msg.addGreetingVersionTitle')),
        disabled(button(t(n > 1 ? 'msg.deleteVersion' : 'msg.deleteGreeting'), deleteGreeting), frozen),
      );
    } else {
      const tag = document.createElement('span');
      tag.className = 'lock-tag';
      tag.textContent = t('msg.greetingStarted');
      v.actions.append(tag);
    }
    return;
  }
  const isLast = it.i === conv.messages.length - 1;
  // 只能编辑最近一次的用户消息和最近一次的模型回复
  const latestOfRole = conv.messages.findLastIndex((x) => x.role === m.role) === it.i;
  // 切换、删除版本也只在最后一组（最新的用户消息和最后一条模型回复）上，否则后面的剧情会接不上。
  // 更早消息的其他版本仍然保存着，回退到那里后又可以切换
  const tail = m.role === 'user' ? latestOfRole : isLast;
  if (tail && m.versions.length > 1) {
    v.actions.appendChild(swipe(m.cur, m.versions.length, (d) => switchVersion(m, d), busy));
  }
  v.actions.appendChild(button(t('msg.copy'), () => copyText(withMacros(msgText(m), conv))));
  if (latestOfRole) {
    v.actions.appendChild(disabled(button(t('msg.edit'), () => startEdit(m.id, msgText(m))), busy,
      m.role === 'user' ? t('msg.editUserTitle') : t('msg.editStoryTitle')));
  }
  if (m.role === 'assistant' && isLast) {
    v.actions.appendChild(disabled(button(t('msg.regenerate'), () => regenerate(m)), busy, t('msg.regenerateTitle')));
  }
  if (m.role === 'assistant' && tail && m.versions.length > 1) {
    v.actions.appendChild(disabled(button(t('msg.deleteVersion'), () => deleteVersion(m)), busy));
  }
  // 回退只出现在模型回复上（回退到用户消息就要重新生成，直接编辑那条用户消息即可）
  if (m.role === 'assistant') {
    v.actions.appendChild(disabled(button(t('msg.rollback'), () => rollback(it.i)), busy || isLast, t('msg.rollbackTitle')));
  }
}

function buildEditor(id) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-edit';
  const ta = document.createElement('textarea');
  ta.value = state.editDraft;
  ta.addEventListener('input', () => { state.editDraft = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void saveEdit(); }
    if (e.key === 'Escape') cancelEdit();
  });
  const row = document.createElement('div');
  row.className = 'row';
  row.append(button(t('msg.cancel'), cancelEdit, 'btn btn-small btn-ghost'), button(t('msg.save'), saveEdit, 'btn btn-small btn-primary'));
  wrap.append(ta, row);
  setTimeout(() => { ta.focus(); ta.style.height = Math.min(ta.scrollHeight + 4, window.innerHeight * 0.6) + 'px'; }, 0);
  return wrap;
}

// 版本切换：‹ 2/3 ›
function swipe(cur, n, onSwitch, isDisabled) {
  const sw = document.createElement('span');
  sw.className = 'swipe';
  const label = document.createElement('span');
  label.textContent = `${cur + 1}/${n}`;
  sw.append(
    disabled(button('‹', () => onSwitch(-1)), isDisabled, t('msg.prevVersion')),
    label,
    disabled(button('›', () => onSwitch(1)), isDisabled, t('msg.nextVersion')),
  );
  return sw;
}

function button(text, onClick, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function disabled(b, isDisabled, title) {
  b.disabled = !!isDisabled;
  if (title) b.title = title;
  return b;
}

function updateComposer() {
  const busy = !!state.generating;
  const gm = !!state.greetingMode;
  const conv = state.conv;
  const msgs = conv.messages;
  const last = msgs[msgs.length - 1];
  els.btnSend.hidden = busy || gm;
  els.btnStop.hidden = !busy;
  els.btnReply.hidden = busy || gm || !(last && last.role === 'user');
  // “添加开场白”只在对话完全为空时出现（锁定的对话不能添加）
  els.btnAddGreeting.hidden = busy || gm || conv.greeting != null || msgs.length > 0 || !!conv.lock || isAssistant(conv);
  els.btnGreetingReload.hidden = !gm;
  els.btnGreetingConfirm.hidden = !gm;
  els.btnGreetingCancel.hidden = !gm;
  els.composer.classList.toggle('greeting-mode', gm);
  // 手机上没有 Ctrl + Enter，提示里不提它
  const mobile = isMobileLayout() ? 'Mobile' : '';
  els.input.placeholder = t((gm ? 'input.greetingPlaceholder' : isAssistant(conv) ? 'input.assistantPlaceholder' : 'input.placeholder') + mobile);
  updateEstimate();
}

// 记忆长度下方：下一次请求大约多少 token
// 粗略估计下一次请求的 token 数：总数（固定设定 + 记忆范围内的消息，不含你还没写的下一条回复），
// 和其中固定设定（system 部分和重点指令）的部分
function updateEstimate() {
  const msgs = state.conv.messages;
  const last = msgs[msgs.length - 1];
  const list = last && last.role === 'user' ? msgs : msgs.concat([{ role: 'user', versions: [''], cur: 0 }]);
  const req = requestOf(state.conv, list);
  els.tokenEstimate.textContent = t('set.tokenEstimate', {
    tokens: (estimateTokens(req.system) + req.messages.reduce((a, x) => a + estimateTokens(x.content), 0)).toLocaleString(),
    sys: (estimateTokens(req.system) + estimateTokens(req.postHistory)).toLocaleString(),
  });
}

// ---------------- 滚动 ----------------

function nearBottom() {
  const b = els.messages;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 60;
}

function nearTop() {
  return els.messages.scrollTop < 60;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  state.follow = true;
  els.btnJumpBottom.hidden = true;
  els.btnJumpTop.hidden = true;
}

function scrollToTop() {
  els.messages.scrollTop = 0;
  state.follow = nearBottom();
  els.btnJumpTop.hidden = true;
  els.btnJumpBottom.hidden = true;
}

// 滚动时按方向显示快捷按钮：往下滚显示“回到底部”，往上滚显示“回到顶部”，两个不同时出现；
// 已经在底部（顶部）时不显示
let lastScrollTop = 0;
function onMessagesScroll() {
  const top = els.messages.scrollTop;
  const delta = top - lastScrollTop;
  lastScrollTop = top;
  state.follow = nearBottom();
  if (delta > 0) {
    els.btnJumpTop.hidden = true;
    els.btnJumpBottom.hidden = state.follow;
  } else if (delta < 0) {
    els.btnJumpBottom.hidden = true;
    els.btnJumpTop.hidden = nearTop();
  }
}

// ---------------- 消息操作 ----------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('msg.copied'));
  } catch (_) {
    // 部分安卓 WebView 不允许 navigator.clipboard，退回到老办法
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(t(ok ? 'msg.copied' : 'msg.copyFailed'));
  }
}

function startEdit(id, text) {
  state.editingId = id;
  state.editDraft = text;
  renderMessages();
}

function cancelEdit() {
  state.editingId = null;
  renderMessages();
}

async function saveEdit() {
  const id = state.editingId;
  const draft = state.editDraft;
  if (id === GREETING_ID) {
    const conv = state.conv;
    if (!draft.trim()) {
      // 只删掉当前这个版本；只剩一个版本时就是删掉开场白
      const several = conv.greetings.length > 1;
      if (!(await ask(t(several ? 'msg.emptyGreetingVersionConfirm' : 'msg.emptyGreetingConfirm'), { ok: t('conv.delete'), danger: true }))) return;
      if (conv !== state.conv || state.editingId !== id || state.generating) return;
      removeGreetingVersion(conv);
      touchConv(conv);
    } else {
      if (draft !== conv.greeting) touchConv(conv);
      conv.greetings[conv.greetingCur] = draft;
      syncGreeting(conv);
    }
  } else {
    const m = state.conv.messages.find((x) => x.id === id);
    if (!m) return cancelEdit();
    const changed = m.versions[m.cur] !== draft;
    state.editingId = null;
    // 编辑用户消息：存成这条消息的新版本，按新内容生成回复。
    // 旧版本和它的那一组回复都保留，切回旧版本时一起回来
    if (m.role === 'user' && changed && !state.generating) {
      stashReplies(m);
      m.versions.push(draft);
      m.cur = m.versions.length - 1;
      renderMessages();
      await saveConv();
      await generateReply();
      return;
    }
    // 编辑模型回复：直接改这个版本（相当于你改写了剧情），不重新生成
    m.versions[m.cur] = draft;
    renderMessages();
    await saveConv();
    toast(t('msg.saved'));
    return;
  }
  state.editingId = null;
  renderMessages();
  await saveConv();
  toast(t('msg.saved'));
}

// 删掉当前显示的开场白版本（只剩一个版本时就是删掉开场白）
function removeGreetingVersion(conv) {
  conv.greetings.splice(conv.greetingCur, 1);
  syncGreeting(conv);
}

async function deleteGreeting() {
  const conv = state.conv;
  const several = conv.greetings.length > 1;
  if (!(await ask(t(several ? 'msg.deleteGreetingVersionConfirm' : 'msg.deleteGreetingConfirm'), { ok: t('conv.delete'), danger: true }))) return;
  if (conv !== state.conv || state.generating || conv.messages.length || conv.lock || state.greetingMode) return;
  removeGreetingVersion(conv);
  touchConv(conv);
  if (state.editingId === GREETING_ID) state.editingId = null;
  renderMessages();
  await saveConv();
}

// 切换开场白版本：只在对话开始前（锁定的对话也可以）
async function switchGreeting(delta) {
  const conv = state.conv;
  const n = conv.greetings.length;
  if (n < 2 || conv.messages.length || state.generating || state.greetingMode) return;
  if (state.editingId === GREETING_ID) state.editingId = null;
  conv.greetingCur = (conv.greetingCur + delta + n) % n;
  syncGreeting(conv);
  renderMessages();
  await saveConv(conv);
}

async function switchVersion(m, delta) {
  const n = m.versions.length;
  const to = (m.cur + delta + n) % n;
  if (m.role === 'user') switchUserVersion(m, to);
  else m.cur = to;
  renderMessages();
  await saveConv();
}

// 用户消息的每个版本各有自己的一组模型回复：当前版本的那一组就是紧跟在后面的模型回复，
// 其他版本的存在 m.replies[版本序号] 里（{ id, versions, cur }，没有回复时为 null）。
// 只有最新的用户消息能切换版本，所以它后面最多只有一条模型回复。

// 把紧跟在后面的模型回复收进当前版本名下，并从对话里拿掉
function stashReplies(m) {
  const msgs = state.conv.messages;
  const next = msgs[msgs.indexOf(m) + 1];
  const hasReply = next && next.role === 'assistant';
  if (!m.replies) m.replies = [];
  m.replies[m.cur] = hasReply ? { id: next.id, versions: next.versions, cur: next.cur } : null;
  if (hasReply) msgs.splice(msgs.indexOf(next), 1);
}

// 切换到第 to 个版本，换上它那一组回复
function switchUserVersion(m, to) {
  stashReplies(m);
  m.cur = to;
  const set = m.replies[to];
  m.replies[to] = null;
  if (set) {
    const msgs = state.conv.messages;
    msgs.splice(msgs.indexOf(m) + 1, 0, { id: set.id, role: 'assistant', versions: set.versions, cur: set.cur });
  }
}

async function deleteVersion(m) {
  if (!(await ask(t('msg.deleteVersionConfirm'), { ok: t('conv.delete'), danger: true }))) return;
  if (state.generating || !state.conv.messages.includes(m) || m.versions.length < 2) return;
  m.versions.splice(m.cur, 1);
  m.cur = Math.min(m.cur, m.versions.length - 1);
  renderMessages();
  await saveConv();
}

// 回退到当前：保留第 i 条，删除它之后的所有消息
async function rollback(i) {
  const msgs = state.conv.messages;
  const n = msgs.length - i - 1;
  if (n <= 0) return;
  if (!(await ask(t('msg.rollbackConfirm', { n }), { ok: t('msg.rollback'), danger: true }))) return;
  if (state.generating || msgs !== state.conv.messages || msgs.length - i - 1 !== n) return;
  msgs.splice(i + 1);
  state.editingId = null;
  showError('');
  renderMessages();
  await saveConv();
}

// ---------------- 发送与生成 ----------------

// 带多个按钮的确认框，返回所选按钮的 value（关闭则为 null）
function choose(title, message, options) {
  return new Promise((resolve) => {
    els.dialogTitle.textContent = title;
    els.dialogMessage.textContent = message;
    els.dialogButtons.innerHTML = '';
    const close = (value) => {
      els.dialog.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    for (const o of options) {
      els.dialogButtons.appendChild(button(o.label, () => close(o.value),
        'btn' + (o.danger ? ' btn-danger' : o.primary ? ' btn-primary' : o.ghost ? ' btn-ghost' : '')));
    }
    document.addEventListener('keydown', onKey, true);
    els.dialog.hidden = false;
    els.dialogButtons.querySelector('.btn-primary, .btn-danger')?.focus();
  });
}

// 确认框（代替浏览器的 confirm()：系统对话框的“确定 / 取消”跟随系统语言，不跟随软件的界面语言）。
// ok 是确认按钮的文字；danger 表示删除、清空这类无法撤销的操作，确认按钮显示为红色。确认返回 true
async function ask(message, { ok = t('btn.ok'), danger = false } = {}) {
  const r = await choose(t('dialog.confirmTitle'), message, [
    { label: t('btn.cancel'), value: false, ghost: true },
    { label: ok, value: true, primary: !danger, danger },
  ]);
  return r === true;
}

// ---- 开场白编辑模式（借用下方的输入框） ----

// adding = true：已经有开场白，再写一个新版本
function enterGreetingMode(adding = false) {
  const conv = state.conv;
  if (state.generating || isAssistant(conv)) return;
  if (adding && (conv.lock || conv.messages.length || conv.greeting == null)) return;
  state.editingId = null;
  state.greetingMode = { preview: null, adding: !!adding };
  renderMessages();
  els.input.focus();
}

function exitGreetingMode() {
  if (!state.greetingMode) return;
  state.greetingMode = null;
  renderMessages();
}

// 重载：在聊天区显示渲染后的开场白，输入框内容不动
function reloadGreetingPreview() {
  if (!state.greetingMode) return;
  const text = els.input.value;
  if (!text.trim()) return toast(t('greeting.empty'));
  state.greetingMode.preview = text;
  const v = state.views.get(PREVIEW_ID);
  if (v) v.shownText = null; // 内容相同也重新加载，让里面的脚本重新运行
  renderMessages();
  els.messages.scrollTop = 0;
}

// 确认：保存开场白、清空输入框，再询问是否发送给模型。
// 新增版本时不再询问：是否发送给模型对所有版本都一样，沿用原来的设置
async function confirmGreeting() {
  const conv = state.conv;
  const text = els.input.value.trim();
  const gm = state.greetingMode;
  if (!gm) return;
  if (!text) return toast(t('greeting.empty'));
  if (gm.adding) {
    if (conv.lock || conv.messages.length) return;
    conv.greetings.push(text);
    conv.greetingCur = conv.greetings.length - 1;
  } else {
    const send = await choose(t('greeting.dialogTitle'), t('greeting.dialogMessage'), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('greeting.noSend'), value: 'no' },
      { label: t('greeting.send'), value: 'yes', primary: true },
    ]);
    if (!send || conv !== state.conv || state.greetingMode !== gm) return;
    conv.greetings = [text];
    conv.greetingCur = 0;
    conv.greetingSend = send === 'yes';
  }
  syncGreeting(conv);
  touchConv(conv);
  // 标题不取自开场白（开场白可能被加密保护，标题是明文），等第一条消息再定
  state.greetingMode = null;
  els.input.value = '';
  renderMessages();
  els.messages.scrollTop = 0;
  await saveConv();
  toast(t('greeting.saved'));
}

async function send() {
  if (state.generating || state.greetingMode) return;
  const text = els.input.value.trim();
  if (!text) return;
  const conv = state.conv;
  conv.messages.push({ id: uid(), role: 'user', versions: [text], cur: 0 });
  if (!conv.title) conv.title = titleFrom(text);
  els.input.value = '';
  await saveConv();
  await generateReply();
}

async function generateReply() {
  const msgs = state.conv.messages;
  const context = msgs.slice();
  const m = { id: uid(), role: 'assistant', versions: [''], cur: 0 };
  msgs.push(m);
  await runGeneration(m, context);
}

async function regenerate(m) {
  const msgs = state.conv.messages;
  const idx = msgs.indexOf(m);
  m.versions.push('');
  m.cur = m.versions.length - 1;
  await runGeneration(m, msgs.slice(0, idx));
}

async function runGeneration(m, context) {
  const conv = state.conv;
  const controller = new AbortController();
  state.generating = { controller, msgId: m.id };
  // 发出请求的时间（回复结束后随对话一起保存）
  touchConv(conv);
  renderConvSelect();
  showError('');
  await flushConvSave();
  renderMessages();
  scrollToBottom();

  const ver = m.cur;
  let result = null;
  let error = null;
  let aborted = false; // 你点了“停止”
  let pendingPaint = false;

  const frame = () => {
    const v = state.conv === conv && state.views.get(m.id);
    return v && v.frame;
  };
  const paint = () => {
    pendingPaint = false;
    const f = frame();
    if (f) Render.stream(f, withMacros(m.versions[ver], conv));
  };

  logConv = conv;
  try {
    const req = requestOf(conv, context);
    result = await streamChat(providerCfg(), req.system, req.messages, {
      signal: controller.signal,
      onText: (text) => {
        m.versions[ver] += text;
        if (!pendingPaint) { pendingPaint = true; requestAnimationFrame(paint); }
      },
      onThinking: () => {
        const f = frame();
        if (f && !m.versions[ver]) Render.stream(f, '', Render.thinkingHtml(t('msg.thinking')));
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else error = e;
  }

  state.generating = null;
  const text = m.versions[ver];
  const kept = !!text;
  const reason = result && result.stopReason;
  const truncated = reason === 'max_tokens' || reason === 'length';
  const failed = reason === 'error'; // 部分接口（如 OpenRouter）用 finish_reason 报告中途出错
  // 被拦截：模型的安全机制拒绝（Anthropic 的 refusal），或接口的内容过滤（OpenAI 格式的 content_filter）
  const blocked = reason === 'refusal' ? 'refused' : reason === 'content_filter' ? 'filtered' : null;

  // 没有生成出任何文字时，撤掉这个空版本
  if (!kept) {
    m.versions.splice(ver, 1);
    if (!m.versions.length) conv.messages.splice(conv.messages.indexOf(m), 1);
    else m.cur = m.versions.length - 1;
  }

  if (state.conv === conv) renderMessages();
  await saveConv(conv);

  // 只要有输出就照常显示和保存；回复没写完就结束的（出错、被拦截、达到最大输出长度），弹窗说明一下
  if (kept) {
    if (error || failed) showModal(t('gen.interruptedTitle'), t('gen.interrupted') + (error ? '\n\n' + error.message : ''));
    else if (blocked) showModal(t('gen.blockedTitle'), t('gen.' + blocked + 'Partial'));
    else if (truncated) showModal(t('gen.truncatedTitle'), t('gen.truncated'));
  } else if (error) showError(error.message);
  else if (blocked) showError(t('gen.' + blocked));
  else if (failed) showError(t('gen.errorEnded'));
  else if (truncated) showError(t('gen.truncatedEmpty'));
  else if (aborted) toast(t('gen.stopped'));
  // 正常结束却一个字都没有：例如接口把正文放进了思考字段，没法判断哪些是正文
  else showError(t('gen.empty'));
}

function stop() {
  if (state.generating) state.generating.controller.abort();
}

// ---------------- 艺术图（每个对话一张） ----------------
// 本机存储里，普通对话的艺术图是 Blob；锁定对话的是加密盒 { iv, data, type }。

async function artBlobOf(conv) {
  const raw = await DB.get(artKey(conv.id));
  if (!raw) return null;
  if (raw instanceof Blob) return raw;
  try { return await Locker.decryptBlob(raw); } catch (_) { return null; }
}

async function loadArt() {
  const conv = state.conv;
  const blob = await artBlobOf(conv);
  if (conv !== state.conv) return;
  if (state.artUrl) URL.revokeObjectURL(state.artUrl);
  state.artUrl = blob ? URL.createObjectURL(blob) : null;
  els.artImage.hidden = !blob;
  els.artPlaceholder.hidden = !!blob;
  if (blob) els.artImage.src = state.artUrl;
  else els.artImage.removeAttribute('src');
  els.btnDownloadArt.disabled = !blob || !!conv.lock;
}

async function setArt(file) {
  if (state.conv.lock) return toast(t('lock.artLocked'));
  if (!file || !file.type.startsWith('image/')) return toast(t('art.notImage'));
  await DB.set(artKey(state.conv.id), file);
  await loadArt();
  toast(t('art.updated'));
}

async function downloadArt() {
  const conv = state.conv;
  if (conv.lock) return toast(t('lock.artLocked'));
  const blob = await artBlobOf(conv);
  if (!blob) return toast(t('art.none'));
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  download(`${safeFilename(convTitle(conv))}.${ext}`, blob);
}

// ---------------- 密码 ----------------

// 密码输入框。confirm = true 时要输入两次（设置新密码）。返回密码，取消则为 null
function askPassword(title, message, confirm) {
  return new Promise((resolve) => {
    els.pwTitle.textContent = title;
    els.pwMessage.textContent = message;
    els.pw1.value = '';
    els.pw2.value = '';
    els.pw2Row.hidden = !confirm;
    els.pwError.textContent = '';
    els.pwDialog.hidden = false;
    els.pw1.focus();
    const done = (value) => {
      els.pwDialog.hidden = true;
      els.pwOk.removeEventListener('click', ok);
      els.pwCancel.removeEventListener('click', cancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const ok = () => {
      const pw = els.pw1.value;
      const len = [...pw].length;
      if (len < 4 || len > 16) { els.pwError.textContent = t('pw.length'); return; }
      if (confirm && pw !== els.pw2.value) { els.pwError.textContent = t('pw.mismatch'); return; }
      done(pw);
    };
    const cancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); }
    };
    els.pwOk.addEventListener('click', ok);
    els.pwCancel.addEventListener('click', cancel);
    document.addEventListener('keydown', onKey, true);
  });
}

// 文字输入框（代替浏览器的 prompt()，Electron 里不支持 prompt）。返回输入的文字，取消则为 null
function askText(title, message, value) {
  return new Promise((resolve) => {
    els.textTitle.textContent = title;
    els.textMessage.textContent = message;
    els.textInput.value = value || '';
    els.textDialog.hidden = false;
    els.textInput.focus();
    els.textInput.select();
    const done = (result) => {
      els.textDialog.hidden = true;
      els.textOk.removeEventListener('click', ok);
      els.textCancel.removeEventListener('click', cancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const ok = () => done(els.textInput.value);
    const cancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); }
    };
    els.textOk.addEventListener('click', ok);
    els.textCancel.addEventListener('click', cancel);
    document.addEventListener('keydown', onKey, true);
  });
}

// 输入密码解锁当前对话：变回普通对话，可以查看、修改和明文导出
async function unlockConv() {
  const conv = state.conv;
  if (!conv.lock) return;
  const pw = await askPassword(t('lock.unlockTitle'), t('lock.unlockMessage'), false);
  if (pw === null) return;
  if (!(await Locker.checkPassword(conv.lock, pw))) return toast(t('lock.wrongPassword'));
  const art = await artBlobOf(conv);
  delete conv.lock;
  if (art) await DB.set(artKey(conv.id), art);
  await saveConv(conv);
  fillConvFields();
  renderMessages();
  await loadArt();
  toast(t('lock.unlocked'));
}

// ---------------- 导出与备份 ----------------

// 导出剧情：开场白 + 全部消息，不含 system 部分和艺术图
function exportText(markdown) {
  const conv = state.conv;
  if (!conv.messages.length && conv.greeting == null) return toast(t('export.noContent'));
  const out = [];
  const time = t('export.time', { time: new Date().toLocaleString() });
  out.push(markdown ? `# ${convTitle(conv)}` : convTitle(conv));
  out.push(markdown ? `*${time}*` : time);
  out.push('');
  const section = (label, text) => {
    out.push(markdown ? `### ${label}` : `【${label}】`);
    out.push(text);
    out.push('');
  };
  // 和聊天区显示的一样：{{user}} 换成 {{user}} 的值
  if (conv.greeting != null) section(t('msg.greeting'), conv.lock ? t('lock.protected') : withMacros(conv.greeting, conv));
  const replyLabel = t(isAssistant(conv) ? 'msg.assistant' : 'msg.story');
  for (const m of conv.messages) section(m.role === 'user' ? t('msg.you') : replyLabel, withMacros(msgText(m), conv));
  download(`${safeFilename(convTitle(conv))}.${markdown ? 'md' : 'txt'}`, out.join('\n'));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 艺术图写进 JSON：普通图片为 data URL 文本，加密的为加密盒
async function artForExport(convId, encrypt) {
  const raw = await DB.get(artKey(convId));
  if (!raw) return null;
  if (!(raw instanceof Blob)) return raw;
  return encrypt ? Locker.encryptBlob(raw) : blobToDataURL(raw);
}

// JSON 里的艺术图只接受 data:image/ 文本或加密盒，不去请求任意网址
function validArt(art) {
  if (typeof art === 'string') return /^data:image\//i.test(art);
  return !!art && typeof art === 'object' && typeof art.iv === 'string' && typeof art.data === 'string';
}

// 从 JSON 读回艺术图，存进本机
async function importArt(convId, art) {
  if (!validArt(art)) return;
  await DB.set(artKey(convId), typeof art === 'string' ? await dataURLToBlob(art) : art);
}

// 备份里的对话：先整体检查，不合格就不读取（读取完整备份会先清空现有数据）
function validVersions(x) {
  return !!x && Array.isArray(x.versions) && x.versions.length > 0 && x.versions.every((v) => typeof v === 'string')
    && Number.isInteger(x.cur) && x.cur >= 0 && x.cur < x.versions.length;
}

function validMessage(m) {
  return !!m && (m.role === 'user' || m.role === 'assistant') && validVersions(m)
    && (m.replies === undefined || (Array.isArray(m.replies) && m.replies.every((x) => x == null || (typeof x.id === 'string' && validVersions(x)))));
}

function validBackupConv(c) {
  return !!c && typeof c === 'object' && typeof c.id === 'string' && !!c.id
    && (c.messages === undefined || (Array.isArray(c.messages) && c.messages.every(validMessage)));
}

// 问是否加密：返回 { password }（不加密时 password 为 null），取消则返回 null
async function askEncrypt(title, message, suggestEncrypt) {
  const choice = await choose(title, message, [
    { label: t('btn.cancel'), value: null, ghost: true },
    { label: t('export.noEncrypt'), value: 'plain' },
    { label: t('export.encrypt'), value: 'lock', primary: suggestEncrypt },
  ]);
  if (!choice) return null;
  if (choice === 'plain') return { password: null };
  const password = await askPassword(t('pw.setTitle'), t('pw.setMessage'), true);
  return password === null ? null : { password };
}

// 导出还没解锁的对话：不能选择是否加密（原样导出密文、沿用原来的密码），只提醒一下。确认则返回 true
async function confirmLockedExport(title, message) {
  return (await choose(title, message, [
    { label: t('btn.cancel'), value: null, ghost: true },
    { label: t('btn.confirm'), value: 'ok', primary: true },
  ])) === 'ok';
}

// 世界卡：当前对话的 System Prompt、世界观、重点指令、开场白（全部版本）和艺术图，不含用户人设、{{user}} 的值和剧情。
// 可以加密：直接打开文件只能看到乱码，在 Proteus 里读取后这些内容被锁定。
async function exportWorldCard() {
  const conv = state.conv;
  if (isAssistant(conv)) return;
  let password = null;
  if (conv.lock) {
    if (!(await confirmLockedExport(t('export.card'), t('export.lockedCard')))) return;
  } else {
    const enc = await askEncrypt(t('export.card'), t('export.cardEncryptMessage'), true);
    if (!enc) return;
    password = enc.password;
  }
  const name = await askText(t('export.card'), t('export.cardName'), conv.title || '');
  if (name === null) return;
  const data = {
    app: 'proteus',
    type: 'worldcard',
    version: 3,
    exportedAt: new Date().toISOString(),
    name: name.trim() || t('export.unnamedWorld'),
    greetingCur: conv.greetingCur, // 当前是第几个开场白（不是受保护的内容，不加密）
  };
  if (isTavern(conv)) data.tavern = { ...conv.tavern }; // 酒馆兼容对话：读回来仍是酒馆兼容对话
  if (conv.lock) {
    // 本来就是锁定的：原样导出密文，沿用原来的密码
    data.locked = conv.lock;
    data.art = await artForExport(conv.id, true);
  } else if (password !== null) {
    data.locked = await Locker.lock(lockedFields(conv), password);
    data.art = await artForExport(conv.id, true);
  } else {
    Object.assign(data, lockedFields(conv));
    data.art = await artForExport(conv.id, false);
  }
  download(`${safeFilename(data.name)}-${t('export.cardSuffix')}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// 完整备份（当前对话）：这个对话的全部内容（设定、用户人设、开场白、剧情、艺术图），不含软件设置。
// 读取时新建一个对话，已有对话不受影响。锁定的对话原样导出密文，沿用原来的密码。
async function backupConv() {
  const conv = state.conv;
  if (isAssistant(conv)) return;
  let lock = conv.lock || null;
  if (lock) {
    if (!(await confirmLockedExport(t('export.conv'), t('export.lockedConv')))) return;
  } else {
    const enc = await askEncrypt(t('export.conv'), t('export.convEncryptMessage'), false);
    if (!enc) return;
    if (enc.password !== null) lock = await Locker.lock(lockedFields(conv), enc.password);
  }
  await flushConvSave();
  const data = {
    app: 'proteus',
    type: 'conversation',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversation: storable(lock ? { ...conv, lock } : conv),
    art: await artForExport(conv.id, !!lock),
  };
  download(`${safeFilename(convTitle(conv))}-${t('export.convSuffix')}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// 完整备份（全部对话）：所有对话（各自的设定、剧情、艺术图）+ 软件设置（不含 API Key）。
// 选择加密时，每个普通对话的 System Prompt、世界观、开场白和艺术图加密，剧情和人设仍是明文；
// 已经锁定的对话始终保持原来的密文和密码（先提醒一下）。全部都是锁定对话时不再问是否加密。
async function backup() {
  const lockedN = state.conversations.filter((c) => c.lock).length;
  if (lockedN && !(await confirmLockedExport(t('export.full'), t('export.lockedAll', { n: lockedN })))) return;
  let password = null;
  // 助理模式的对话不加密：只有还有未锁定的角色扮演对话时才问
  if (state.conversations.some((c) => !c.lock && !isAssistant(c))) {
    const enc = await askEncrypt(t('export.full'), t('export.fullEncryptMessage'), false);
    if (!enc) return;
    password = enc.password;
  }
  await flushConvSave();
  const conversations = [];
  const arts = {};
  for (const c of state.conversations) {
    // 助理模式的对话（和它的艺术图）不加密
    const encrypt = !isAssistant(c) && (!!c.lock || password !== null);
    if (!encrypt || c.lock) conversations.push(storable(c));
    else conversations.push(storable({ ...c, lock: await Locker.lock(lockedFields(c), password) }));
    const art = await artForExport(c.id, encrypt);
    if (art) arts[c.id] = art;
  }
  const data = {
    app: 'proteus',
    type: 'backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: { ...state.settings, apiKeys: {} },
    conversations,
    arts,
  };
  download(`${t('export.backupPrefix')}-${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// 日志：最近一次请求模型时实际发送的请求和收到的原始回复，用于排查问题（只记在内存里，不保存）。
// API Key 隐藏；请求来自还没解锁的加密世界卡时，受保护的设定也隐藏
let logConv = null;

function exportLog() {
  const x = lastExchange;
  if (!x) return toast(t('export.noLog'));
  const headers = { ...x.request.headers };
  if (headers['x-api-key']) headers['x-api-key'] = '***';
  if (headers.authorization) headers.authorization = 'Bearer ***';
  let body = x.request.body;
  if (logConv && logConv.lock) {
    // 发出去的内容里 {{user}} 已经换成了它的值，换之前和换之后的都要隐藏
    const secrets = [...new Set([logConv.systemPrompt, logConv.worldText, logConv.postHistory, ...logConv.greetings]
      .filter((v) => v && v.trim()).flatMap((v) => [v, v.trim()]).flatMap((v) => [v, withMacros(v, logConv)]))]
      .sort((a, b) => b.length - a.length);
    const hide = (v) => secrets.reduce((out, sec) => out.split(sec).join(t('lock.protected')), v);
    body = JSON.parse(JSON.stringify(body, (k, v) => (typeof v === 'string' ? hide(v) : v)));
  }
  const out = [
    `Proteus log · ${x.time.toLocaleString()}`,
    '',
    '===== REQUEST =====',
    `${x.request.method} ${x.request.url}`,
    // 安卓版改用原生请求发出时注明（不受跨域限制，回复一次性返回）
    ...(x.request.via === 'native' ? ['(sent by the Android app\'s native HTTP client)'] : []),
    JSON.stringify(headers, null, 2),
    '',
    JSON.stringify(body, null, 2),
    '',
    '===== RESPONSE =====',
  ];
  if (x.response) out.push(`HTTP ${x.response.status}`, `content-type: ${x.response.contentType}`, '', x.response.body);
  else out.push('(no response)');
  if (x.error) out.push('', '===== ERROR =====', x.error);
  const p = (n) => String(n).padStart(2, '0');
  const tm = `${p(x.time.getHours())}${p(x.time.getMinutes())}${p(x.time.getSeconds())}`;
  download(`proteus-log-${dateStamp()}-${tm}.txt`, out.join('\n'));
}

async function exportMenu() {
  // 助理模式：只有对话记录、完整备份（全部对话）和日志；世界卡和完整备份（当前对话）不显示
  const choice = isAssistant(state.conv)
    ? await choose(t('export.menuTitle'), t('export.menuMessageAssistant'), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('export.chatTxt'), value: 'txt' },
      { label: t('export.chatMd'), value: 'md', primary: true },
      { label: t('export.full'), value: 'full' },
      { label: t('export.log'), value: 'log' },
    ])
    : await choose(t('export.menuTitle'), t('export.menuMessage'), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('export.storyTxt'), value: 'txt' },
      { label: t('export.storyMd'), value: 'md' },
      { label: t('export.card'), value: 'card' },
      { label: t('export.conv'), value: 'conv', primary: true },
      { label: t('export.full'), value: 'full' },
      { label: t('export.log'), value: 'log' },
    ]);
  if (choice === 'txt') exportText(false);
  else if (choice === 'md') exportText(true);
  else if (choice === 'card') await exportWorldCard();
  else if (choice === 'conv') await backupConv();
  else if (choice === 'full') await backup();
  else if (choice === 'log') exportLog();
}

// ---- 读取酒馆（SillyTavern）的角色卡和世界书（解析见 js/stcard.js） ----
// 读取的结果是酒馆兼容对话（conv.tavern）。规则：
//   - 当前不是酒馆兼容对话，或者是锁定的、已经开始聊天的酒馆兼容对话：新建一个对话
//   - 当前是还没开始聊天的酒馆兼容对话：
//       世界书：当前还没有世界书就加进来（放在世界观最前面）；已经有了就新建对话（两个世界观不能放在同一个对话里）
//       角色卡：当前还没有角色就加进来（接在世界观后面）；已经有角色时 Proteus 不支持群聊，问是否新建对话，
//               当前有世界书（而新卡没有自带世界书）时再问是否把世界书复制过去
// {{char}} 和 {{user}} 保留在内容里，显示和发送时再换成角色卡的名字和 {{user}} 的值

const baseName = (filename) => String(filename || '').replace(/\.[^.]*$/, '');
const joinParts = (...parts) => parts.filter((x) => x && x.trim()).map((x) => x.trim()).join('\n\n');

// 世界观里世界书那一段的小标题（跟随读取时的界面语言）
const bookSection = (text) => `## ${t('st.lorebook')}\n\n${text}`;

// 角色卡的字段拼成世界观里角色那一段：描述、性格、场景、对话示例，各有一个小标题（跟随界面语言）
function charSection(name, card) {
  const parts = [
    ['st.description', card.description],
    ['st.personality', card.personality],
    ['st.scenario', card.scenario],
    ['st.examples', card.mes_example],
  ].map(([k, v]) => [k, STCard.importMacros(v).trim()]).filter(([, v]) => v).map(([k, v]) => `### ${t(k)}\n${v}`);
  return parts.length ? `## ${t('st.character', { name })}\n\n${parts.join('\n\n')}` : '';
}

// 当前世界观里世界书那一段：从世界书的小标题（任何一种界面语言的）到下一个二级标题之前。
// 找不到小标题时（例如被删掉了）就是整个世界观
function lorebookPart(worldText) {
  const heads = Object.keys(I18N).map((l) => '## ' + I18N[l]['st.lorebook']);
  const lines = worldText.split('\n');
  const start = lines.findIndex((l) => heads.includes(l.trim()));
  if (start < 0) return worldText.trim();
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

// 角色卡里要读取的内容
function cardContent(card, artBlob, filename) {
  const name = card.name.trim() || baseName(filename) || t('export.unnamedWorld');
  const book = card.character_book;
  const entries = book ? STCard.lorebookEntries(book) : [];
  return {
    name,
    entries,
    bookText: STCard.importMacros(STCard.lorebookText(entries)).trim(),
    bookName: entries.length ? ((typeof book.name === 'string' && book.name.trim()) || name) : null,
    greetings: [card.first_mes, ...card.alternate_greetings].map((g) => STCard.importMacros(g).trim()).filter(Boolean),
    systemPrompt: STCard.importMacros(card.system_prompt).trim(), // 可能含 {{original}}；空的就是卡里没有
    // 重点指令里的 {{original}} 指用户自己的全局重点指令，Proteus 没有，直接去掉
    postHistory: STCard.replaceOriginal(STCard.importMacros(card.post_history_instructions), '').trim(),
    notes: STCard.importMacros(card.creator_notes).trim(),
    section: charSection(name, card),
    art: artBlob,
  };
}

// 作者备注不发给模型，读取后给用户看一下
function showCreatorNotes(x, conv) {
  if (x.notes) showModal(t('restore.stNotesTitle', { name: x.name }), t('restore.stNotesIntro') + '\n\n' + withMacros(x.notes, conv));
}

// 新建一个对话放读取的内容，切换过去
async function addImportedConv(c, artBlob) {
  await flushConvSave();
  state.conversations.push(c);
  await DB.putConversation(storable(c));
  if (artBlob) await DB.set(artKey(c.id), artBlob);
  await switchConv(c.id);
  els.messages.scrollTop = 0;
}

// 读取到当前对话后：保存并刷新界面
async function refreshAfterMerge(conv) {
  await saveConv(conv);
  if (conv !== state.conv) return;
  fillConvFields();
  state.renderedConvId = null;
  renderMessages();
  els.messages.scrollTop = 0;
  await loadArt();
}

// 用角色卡新建一个酒馆兼容对话。copied 是从当前对话复制过来的世界书 { book, text }（没有时为 null）
async function createCardConv(x, copied) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const c = newConversation();
  const defaultPrompt = t('defaultSystemPrompt');
  c.title = x.name;
  c.tavern = { char: x.name, book: x.bookName != null ? x.bookName : copied ? copied.book : null };
  // 卡的 System Prompt：空的用默认值；{{original}} 换成默认值（作者在默认值的基础上追加内容）
  c.systemPrompt = x.systemPrompt ? STCard.replaceOriginal(x.systemPrompt, defaultPrompt).trim() : defaultPrompt;
  c.worldText = joinParts(x.bookText ? bookSection(x.bookText) : copied ? copied.text : '', x.section);
  c.postHistory = x.postHistory;
  c.greetings = x.greetings.slice();
  c.greetingCur = 0;
  c.greetingSend = true;
  syncGreeting(c);
  await addImportedConv(c, x.art);
  toast(t('restore.stCardDone'));
  showCreatorNotes(x, c);
}

// 先确认，再用角色卡新建对话。reason 是为什么没有加入当前对话（i18n 键名，没有时为 null）
async function importCardAsNew(x, reason) {
  let message = t('restore.stCardConfirm', { name: x.name, greetings: x.greetings.length, art: x.art ? t('restore.stCardArt') : '' });
  if (x.entries.length) message += '\n\n' + t('restore.stBookNote', { n: x.entries.length, tokens: estimateTokens(x.bookText).toLocaleString() });
  if (reason) message = t(reason) + '\n\n' + message;
  if (!(await ask(message + '\n\n' + t('restore.continue')))) return;
  await createCardConv(x, null);
}

// 用世界书新建一个酒馆兼容对话
async function importBookAsNew(b, reason) {
  let message = t('restore.stBookConfirm', { name: b.name, n: b.n, tokens: estimateTokens(b.text).toLocaleString() });
  if (reason) message = t(reason) + '\n\n' + message;
  if (!(await ask(message))) return;
  if (state.generating) return toast(t('conv.stopFirst'));
  const c = newConversation();
  c.title = b.name;
  c.worldText = bookSection(b.text);
  c.tavern = { char: null, book: b.name };
  await addImportedConv(c, null);
  toast(t('restore.stBookDone'));
}

// 当前对话还能加入酒馆的内容吗（确认框弹出期间可能已经变了）
const canMergeInto = (conv) => conv === state.conv && isTavern(conv) && !conv.lock && !conv.messages.length && !state.generating;

// 覆盖用户改过的设定之前先问一下，弹窗里显示将要改成的内容。确认覆盖返回 true
async function askOverwrite(message, next) {
  return (await choose(t('restore.stConflictTitle'), message + '\n\n' + next, [
    { label: t('restore.keepMine'), value: 'keep' },
    { label: t('restore.overwrite'), value: 'yes', primary: true },
  ])) === 'yes';
}

// 世界书加入当前对话：放在世界观最前面
async function mergeBook(conv, b) {
  if (!(await ask(t('restore.stBookMerge', { name: b.name, n: b.n, tokens: estimateTokens(b.text).toLocaleString() })))) return;
  if (!canMergeInto(conv) || conv.tavern.book != null) return;
  conv.worldText = joinParts(bookSection(b.text), conv.worldText);
  conv.tavern.book = b.name;
  await refreshAfterMerge(conv);
  toast(t('restore.stBookMergeDone'));
}

// 角色卡加入当前对话：角色设定接在世界观后面，开场白加进开场白的版本；
// 卡里的 System Prompt、重点指令和你改过的内容冲突时，问是否覆盖
async function mergeCard(conv, x) {
  const hasArt = !!(await DB.get(artKey(conv.id)));
  const art = x.art && !hasArt;
  if (!(await ask(t('restore.stCardMerge', { name: x.name, greetings: x.greetings.length, art: art ? t('restore.stCardArt') : '' })
    + '\n\n' + t('restore.continue')))) return;
  if (!canMergeInto(conv) || conv.tavern.char != null) return;

  // System Prompt：卡里的 {{original}} 换成当前的 System Prompt。当前还是默认内容就直接用卡里的，改过的先问
  let systemPrompt = conv.systemPrompt;
  if (x.systemPrompt) {
    const next = STCard.replaceOriginal(x.systemPrompt, conv.systemPrompt.trim()).trim();
    const isDefault = !conv.systemPrompt.trim() || isDefaultSystemPrompt(conv.systemPrompt) || isPreviousDefaultSystemPrompt(conv.systemPrompt);
    if (isDefault || (next !== conv.systemPrompt.trim() && (await askOverwrite(t('restore.stSpConflict'), next)))) systemPrompt = next;
  }
  // 重点指令：当前是空的就直接用卡里的，有内容的先问
  let postHistory = conv.postHistory;
  if (x.postHistory) {
    const cur = conv.postHistory.trim();
    if (!cur || (x.postHistory !== cur && (await askOverwrite(t('restore.stPhConflict'), x.postHistory)))) postHistory = x.postHistory;
  }
  if (!canMergeInto(conv) || conv.tavern.char != null) return;

  conv.systemPrompt = systemPrompt;
  conv.postHistory = postHistory;
  conv.worldText = joinParts(conv.worldText, x.section);
  conv.tavern.char = x.name;
  if (x.greetings.length) {
    if (!conv.greetings.length) conv.greetingSend = true;
    conv.greetingCur = conv.greetings.length;
    conv.greetings = conv.greetings.concat(x.greetings);
    syncGreeting(conv);
  }
  if (art) await DB.set(artKey(conv.id), x.art);
  await refreshAfterMerge(conv);
  toast(t('restore.stCardMergeDone'));
  showCreatorNotes(x, conv);
}

async function importST(st, artBlob, filename) {
  const cur = state.conv;
  const tavern = isTavern(cur) && !cur.lock;
  const started = tavern && cur.messages.length > 0;
  const open = tavern && !started; // 可以加入当前对话

  if (st.kind === 'book') {
    const entries = STCard.lorebookEntries(st.book);
    if (!entries.length) return toast(t('restore.stBookEmpty'));
    const b = {
      name: (typeof st.book.name === 'string' && st.book.name.trim()) || baseName(filename) || t('export.unnamedWorld'),
      text: STCard.importMacros(STCard.lorebookText(entries)).trim(),
      n: entries.length,
    };
    if (open && cur.tavern.book == null) return mergeBook(cur, b);
    return importBookAsNew(b, started ? 'restore.stStarted' : open ? 'restore.stHasBook' : null);
  }

  const x = cardContent(st.card, artBlob, filename);
  if (!open) return importCardAsNew(x, started ? 'restore.stStarted' : null);
  if (cur.tavern.char != null) {
    // 已经有角色了：不支持群聊，问是否新建对话
    const go = await choose(t('restore.stGroupTitle'), t('restore.stGroupChat', { char: cur.tavern.char, name: x.name }), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('restore.stNewConv'), value: 'new', primary: true },
    ]);
    if (!go || cur !== state.conv) return;
    let copied = null;
    if (cur.tavern.book != null && x.bookName == null) {
      const copy = await choose(t('restore.stGroupTitle'), t('restore.stCopyBook', { book: cur.tavern.book }), [
        { label: t('btn.cancel'), value: null, ghost: true },
        { label: t('restore.stNoCopy'), value: 'no' },
        { label: t('restore.stCopy'), value: 'yes', primary: true },
      ]);
      if (!copy || cur !== state.conv) return;
      if (copy === 'yes') copied = { book: cur.tavern.book, text: lorebookPart(cur.worldText) };
    }
    return createCardConv(x, copied);
  }
  // 卡自带世界书，当前对话也已经有世界书：两个世界观不能放在同一个对话里
  if (cur.tavern.book != null && x.bookName != null) return importCardAsNew(x, 'restore.stHasBook');
  return mergeCard(cur, x);
}

// 读取文件：Proteus 的世界卡或备份 → { proteus }；酒馆的角色卡或世界书 → { st, art }；不认识 → { error: i18n 键名 }
async function readImportFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (STCard.isPng(bytes)) {
    const obj = STCard.fromPng(bytes);
    return obj ? { st: STCard.detect(obj), art: new Blob([bytes], { type: 'image/png' }) } : { error: 'restore.pngNoCard' };
  }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return { error: 'restore.notJson' }; }
  if (data && data.app === 'proteus') return { proteus: data };
  const st = STCard.detect(data);
  return st ? { st, art: null } : { error: 'restore.invalid' };
}

// “🍺 新建酒馆兼容对话”选择的文件：只接受酒馆的角色卡和世界书
async function importTavernFile(file) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const r = await readImportFile(file);
  if (r.st) return importST(r.st, r.art, file.name);
  return toast(t(r.error === 'restore.pngNoCard' ? r.error : 'restore.notTavern'));
}

// 读取世界卡、完整备份（当前对话 / 全部对话），或者酒馆的角色卡（PNG / JSON）、世界书（JSON）。
// 剧情导出是 TXT/Markdown，不能读回
async function restore(file) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const r = await readImportFile(file);
  if (r.error) return toast(t(r.error));
  if (r.st) return importST(r.st, r.art, file.name);
  const data = r.proteus;

  if (data.type === 'worldcard') {
    const name = data.name || t('export.unnamedWorld');
    if (!(await ask(t(data.locked ? 'restore.cardConfirmLocked' : 'restore.cardConfirm', { name })))) return;
    if (state.generating) return toast(t('conv.stopFirst'));
    await flushConvSave();
    // 新对话：用卡里的设定和开场白，用户人设为空；已有对话不受影响
    const c = newConversation();
    let fields = data;
    if (data.locked) {
      try { fields = await Locker.open(data.locked); } catch (_) { return toast(t('restore.invalid')); }
      c.lock = data.locked;
    }
    if (typeof fields.systemPrompt === 'string') c.systemPrompt = fields.systemPrompt;
    c.worldText = typeof fields.worldText === 'string' ? fields.worldText : '';
    c.postHistory = typeof fields.postHistory === 'string' ? fields.postHistory : '';
    c.persona = '';
    c.userName = '';
    c.greeting = typeof fields.greeting === 'string' ? fields.greeting : null;
    c.greetings = fields.greetings;
    c.greetingCur = data.greetingCur;
    c.greetingSend = fields.greetingSend !== false;
    normalizeGreetings(c);
    if (data.tavern) { c.tavern = data.tavern; normalizeTavern(c); }
    c.title = name;
    state.conversations.push(c);
    await DB.putConversation(storable(c));
    await importArt(c.id, data.art);
    await switchConv(c.id);
    els.messages.scrollTop = 0;
    toast(t('restore.cardDone'));
    return;
  }

  if (data.type === 'conversation') {
    const src = data.conversation;
    if (!validBackupConv(src)) return toast(t('restore.invalid'));
    if (!(await ask(t(src.lock ? 'restore.convConfirmLocked' : 'restore.convConfirm', { name: convTitle(src) })))) return;
    if (state.generating) return toast(t('conv.stopFirst'));
    await flushConvSave();
    // 新对话：内容和备份时一样，换一个新的 id，已有对话（包括备份它的那个）不受影响
    const c = { createdAt: Date.now(), ...src, id: uid() };
    try { await openLock(c); } catch (_) { return toast(t('restore.invalid')); }
    normalizeConv(c);
    state.conversations.push(c);
    await saveConv(c);
    await importArt(c.id, data.art);
    await switchConv(c.id);
    toast(t('restore.convDone'));
    return;
  }

  if (data.type !== 'backup' || !Array.isArray(data.conversations) || !data.conversations.every(validBackupConv)) return toast(t('restore.invalid'));
  if (!(await ask(t('restore.fullConfirm', { n: data.conversations.length }), { danger: true }))) return;
  if (state.generating) return toast(t('conv.stopFirst'));
  // 还没写入的改动作废：现有对话马上要被替换，晚到的保存会把旧对话写回去
  clearTimeout(convSaveTimer);
  convSavePending = null;
  clearTimeout(saveTimer);
  const saved = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const arts = data.arts && typeof data.arts === 'object' ? data.arts : {};
  // API Key 不在备份里，保留本机的；“记住 API Key”也跟着本机
  const settings = { ...DEFAULT_SETTINGS, ...saved, apiKeys: state.settings.apiKeys, rememberKeys: state.settings.rememberKeys };
  try {
    state.settings = settings;
    await DB.set('settings', storableSettings());
    // 清掉现有的对话和艺术图
    for (const c of state.conversations) await DB.del(artKey(c.id));
    await DB.clearConversations();
    for (const c of data.conversations) {
      try { await openLock(c); } catch (_) { continue; } // 解不开的锁定对话跳过
      await DB.putConversation(storable(normalizeConv(c)));
      await importArt(c.id, arts[c.id]);
    }
  } catch (e) {
    console.error(e);
    await boot();
    showError(t('restore.failed', { msg: e.message }));
    return;
  }
  await boot();
  toast(t('restore.fullDone'));
}

// ---------------- 布局：拖动调整左栏宽度和输入框高度 ----------------

function artBounds() {
  const w = window.innerWidth;
  // 最宽不超过窗口的 45%，并且给聊天区留出至少 480px
  return { min: 160, max: Math.max(160, Math.min(w * 0.45, w - 340 - 480)) };
}

// 输入框最高时，聊天区仍至少留出 180px
function inputBounds() {
  const pane = els.chatPane.getBoundingClientRect().height || window.innerHeight;
  const header = els.chatPane.querySelector('.chat-header').getBoundingClientRect().height;
  const composerOther = els.composer.getBoundingClientRect().height - els.input.getBoundingClientRect().height;
  return { min: 48, max: Math.max(48, pane - header - composerOther - 180) };
}

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

function applyLayout() {
  const s = state.settings;
  if (s.artWidth) document.documentElement.style.setProperty('--art-w', clamp(s.artWidth, artBounds()) + 'px');
  else document.documentElement.style.removeProperty('--art-w');
  els.input.style.height = clamp(s.inputHeight || 88, inputBounds()) + 'px';
}

// 通用拖动：按住把手移动鼠标，onMove 收到相对起点的位移
function makeDraggable(handle, onStart, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = onStart();
    const x0 = e.clientX;
    const y0 = e.clientY;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing'); // 拖动经过消息窗口时不被它们“吃掉”鼠标
    const move = (ev) => onMove(start, ev.clientX - x0, ev.clientY - y0);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      saveSettingsSoon();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ---- 手机布局的设置面板 ----

const isMobileLayout = () => window.matchMedia('(max-width: 999px)').matches;

function openSettings() {
  document.body.classList.add('settings-open');
}

function closeSettings() {
  document.body.classList.remove('settings-open');
  closeModelMenu();
}

// 安卓返回键：先关掉打开着的弹窗或设置面板，都没有时才退出
function bindBackButton() {
  if (!NATIVE) return;
  nativePlugin('App').addListener('backButton', () => {
    for (const id of ['pwDialog', 'textDialog', 'dialog']) {
      if (!els[id].hidden) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        els[id].hidden = true;
        return;
      }
    }
    // 信息弹窗直接关掉：它没有自己的 Escape 处理，派发 Escape 会连设置面板一起关掉
    if (!els.modal.hidden) { els.modal.hidden = true; return; }
    if (expandSource) return closeExpand();
    if (document.body.classList.contains('settings-open')) return closeSettings();
    if (state.editingId) return cancelEdit();
    if (state.greetingMode) return exitGreetingMode();
    nativePlugin('App').exitApp();
  });
}

function bindLayout() {
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsBackdrop.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
  // 拉宽窗口切回电脑布局时，收起设置面板的状态
  window.matchMedia('(max-width: 999px)').addEventListener('change', (e) => {
    if (!e.matches) closeSettings();
    if (state.conv) renderMessages(); // 提示文字和状态栏有手机版、电脑版两种写法
  });

  makeDraggable(els.artResizer, () => els.artPane.getBoundingClientRect().width, (w0, dx) => {
    state.settings.artWidth = Math.round(clamp(w0 + dx, artBounds()));
    applyLayout();
  });
  // 把手在左栏里面，阻止点击冒泡，否则松开鼠标时会触发“上传艺术图”
  els.artResizer.addEventListener('click', (e) => e.stopPropagation());
  els.artResizer.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    state.settings.artWidth = null; // 双击恢复默认宽度
    applyLayout();
    saveSettingsSoon();
  });
  makeDraggable(els.composerResizer, () => els.input.getBoundingClientRect().height, (h0, dx, dy) => {
    const atBottom = nearBottom();
    state.settings.inputHeight = Math.round(clamp(h0 - dy, inputBounds()));
    applyLayout();
    if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
  });
  window.addEventListener('resize', () => { if (state.settings) applyLayout(); });
}

// ---------------- 右侧设置面板 ----------------

// 当前对话的设定（System Prompt、世界观、人设）。锁定的对话不把 System Prompt 和世界观放进编辑框
function fillConvFields() {
  const c = state.conv;
  const locked = !!c.lock;
  const assistant = isAssistant(c);
  els.settingsPane.classList.toggle('locked', locked);
  els.systemPrompt.value = locked ? '' : c.systemPrompt;
  els.worldText.value = locked ? '' : c.worldText;
  els.persona.value = c.persona;
  els.userName.value = c.userName;
  els.postHistory.value = locked ? '' : c.postHistory;
  // 助理模式：世界观、用户人设、{{user}} 的值和重点指令空白、不能编辑（不是受保护，是这个模式不用）；艺术图照常可用
  els.worldText.disabled = assistant;
  els.persona.disabled = assistant;
  els.userName.disabled = assistant;
  els.postHistory.disabled = assistant;
  els.worldText.placeholder = t(assistant ? 'assistant.worldUnused' : 'set.worldPlaceholder');
  els.persona.placeholder = t(assistant ? 'assistant.personaUnused' : 'set.personaPlaceholder');
  els.userName.placeholder = t(assistant ? 'assistant.userNameUnused' : 'set.userNamePlaceholder');
  els.postHistory.placeholder = t(assistant ? 'assistant.postHistoryUnused' : 'set.postHistoryPlaceholder');
  els.btnUploadWorld.disabled = assistant;
  els.btnClearWorld.disabled = assistant;
  els.btnExpandWorld.disabled = assistant;
  els.btnUploadArt.disabled = locked;
  els.btnRemoveArt.disabled = locked;
  els.artPane.classList.toggle('locked', locked);
  updateWorldCount();
  updateEstimate();
}

// 软件设置
function fillSettingsForm() {
  const s = state.settings;
  els.rounds.value = s.rounds;
  els.provider.value = s.provider;
  els.effort.value = s.effort;
  els.useTemperature.checked = s.useTemperature;
  els.temperature.value = s.temperature;
  els.langSelect.value = LANG;
  els.rememberKeys.checked = s.rememberKeys !== false;
  fillProviderFields();
}

function fillProviderSelect() {
  els.provider.innerHTML = Object.keys(PROVIDERS)
    .map((k) => `<option value="${k}">${escapeHtml(t('provider.' + k))}</option>`).join('');
}

function fillProviderFields() {
  const s = state.settings;
  const p = PROVIDERS[s.provider];
  els.provider.value = s.provider;
  els.baseUrl.value = s.baseUrls[s.provider] || '';
  els.baseUrl.placeholder = p.baseUrl || t('set.baseUrlExample');
  els.apiKey.value = s.apiKeys[s.provider] || '';
  els.model.value = s.models[s.provider] || '';
  els.maxTokens.value = s.maxTokens[s.provider] || '';
  els.maxTokens.placeholder = t(p.format === 'anthropic' ? 'set.maxTokensAnthropic' : 'set.maxTokensOpenai');
  closeModelMenu();
  els.anthropicOptions.hidden = p.format !== 'anthropic';
  els.openaiOptions.hidden = p.format !== 'openai';
  els.temperature.disabled = !s.useTemperature;
}

// ---- 模型下拉列表 ----
// 浏览器自带的输入建议（datalist）会按输入框里已有的文字过滤，样式也改不了，所以自己画一个。

const modelMenu = { items: [], active: -1 };

// 可选的模型：优先用“获取列表”得到的，没有就用预设的几个
function modelOptions() {
  const p = state.settings.provider;
  const fetched = state.settings.modelLists[p];
  return fetched && fetched.length ? fetched : PROVIDERS[p].models;
}

// filter 为空时显示全部；否则只显示包含这段文字的
function openModelMenu(filter) {
  const f = (filter || '').trim().toLowerCase();
  const current = els.model.value.trim();
  modelMenu.items = modelOptions().filter((m) => !f || m.toLowerCase().includes(f));
  modelMenu.active = modelMenu.items.indexOf(current);
  els.modelMenu.innerHTML = '';
  if (!modelMenu.items.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = t(f ? 'set.modelNoMatch' : 'set.modelListEmpty');
    els.modelMenu.appendChild(empty);
  }
  modelMenu.items.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'combo-item' + (m === current ? ' current' : '');
    item.textContent = m;
    item.title = m;
    item.addEventListener('mousedown', (e) => { e.preventDefault(); pickModel(m); });
    item.addEventListener('mousemove', () => highlightModel(i, false));
    els.modelMenu.appendChild(item);
  });
  els.modelMenu.hidden = false;
  highlightModel(modelMenu.active, true);
}

function closeModelMenu() {
  els.modelMenu.hidden = true;
}

function highlightModel(i, scroll) {
  modelMenu.active = i;
  els.modelMenu.querySelectorAll('.combo-item').forEach((el, j) => el.classList.toggle('active', j === i));
  const el = els.modelMenu.querySelectorAll('.combo-item')[i];
  if (el && scroll) el.scrollIntoView({ block: 'nearest' });
}

function pickModel(m) {
  els.model.value = m;
  state.settings.models[state.settings.provider] = m;
  saveSettingsSoon();
  updateEstimate();
  closeModelMenu();
}

function bindModelMenu() {
  els.btnModelMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 不让输入框失去焦点
  els.btnModelMenu.addEventListener('click', () => {
    if (els.modelMenu.hidden) { openModelMenu(''); els.model.focus(); } else closeModelMenu();
  });
  els.model.addEventListener('input', () => openModelMenu(els.model.value));
  els.model.addEventListener('blur', closeModelMenu);
  els.model.addEventListener('keydown', (e) => {
    const n = modelMenu.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (els.modelMenu.hidden) return openModelMenu('');
      if (!n) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      highlightModel((modelMenu.active + d + n) % n, true);
    } else if (e.key === 'Enter' && !els.modelMenu.hidden && modelMenu.active >= 0) {
      e.preventDefault();
      pickModel(modelMenu.items[modelMenu.active]);
    } else if (e.key === 'Escape' && !els.modelMenu.hidden) {
      e.stopPropagation(); // 只收起列表，不顺带关闭设置面板
      closeModelMenu();
    }
  });
}

// ---- 放大窗口：在聊天区上盖一个大的输入框编辑 System Prompt 或世界观，内容和右侧的输入框同步 ----

let expandSource = null; // 正在放大编辑的那个右侧输入框

function openExpand(source, titleKey) {
  if (source.disabled || state.conv.lock) return;
  if (isMobileLayout()) closeSettings(); // 手机布局：设置面板会盖住聊天区，先收起来
  expandSource = source;
  els.expandTitle.textContent = t(titleKey);
  els.expandText.value = source.value;
  els.expandText.placeholder = source.placeholder;
  els.expandBox.hidden = false;
  els.expandText.focus();
  els.expandText.setSelectionRange(0, 0); // 从开头显示
  els.expandText.scrollTop = 0;
}

function closeExpand() {
  if (!expandSource) return;
  expandSource = null;
  els.expandBox.hidden = true;
}

function updateWorldCount() {
  const text = state.conv.worldText;
  els.worldCount.textContent = text ? t('set.worldCount', { chars: text.length.toLocaleString(), tokens: estimateTokens(text).toLocaleString() }) : '';
}

// 当前运行的版本号：Windows / macOS / Linux 原生应用由 electron/main.js 通过网址参数传进来，
// 安卓原生应用读应用信息；直接运行源代码的网页版没有版本号
async function detectVersion() {
  const v = new URLSearchParams(location.search).get('version');
  if (v) return v;
  if (NATIVE) {
    try { return (await nativePlugin('App').getInfo()).version || null; } catch (_) { return null; }
  }
  return null;
}

// 输入框下方的开源与免责声明（网址做成链接，后面跟着当前版本）
function renderFooter() {
  const version = state.version ? t('footer.version', { version: state.version }) : t('footer.versionWeb');
  const [before, after] = t('footer.license', { version }).split('{url}');
  const a = document.createElement('a');
  a.href = PROJECT_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = PROJECT_URL;
  els.footer.replaceChildren(before, a, after || '');
}

// 切换界面语言。当前对话的 System Prompt 如果还是某种语言的默认内容，也换成新语言的默认内容
function applyLang(lang) {
  setLang(lang);
  fillProviderSelect();
  fillProviderFields();
  renderFooter();
  els.btnToggleKey.textContent = t(els.apiKey.type === 'password' ? 'set.show' : 'set.hide');
  if (state.conv) {
    const conv = state.conv;
    const isDefault = isAssistant(conv) ? isDefaultAssistantPrompt : isDefaultSystemPrompt;
    if (!conv.lock && isDefault(conv.systemPrompt) && conv.systemPrompt !== defaultPromptOf(conv)) {
      conv.systemPrompt = defaultPromptOf(conv);
      els.systemPrompt.value = conv.systemPrompt;
      saveConvSoon();
    }
    fillConvFields(); // 世界观、人设的占位文字
    updateWorldCount();
    renderConvSelect();
    // 消息标签、按钮等需要重画：清掉视图重新生成
    state.renderedConvId = null;
    renderMessages();
  }
}

function bindSettings() {
  const s = () => state.settings;
  const c = () => state.conv;
  const onSetting = (el, fn) => el.addEventListener('input', () => { fn(el); saveSettingsSoon(); updateEstimate(); });
  const onConv = (el, fn) => el.addEventListener('input', () => { fn(el); saveConvSoon(); updateEstimate(); });

  // 属于当前对话的设定
  onConv(els.systemPrompt, (el) => { if (!c().lock) c().systemPrompt = el.value; });
  onConv(els.worldText, (el) => { if (!c().lock && !isAssistant(c())) { c().worldText = el.value; updateWorldCount(); } });
  onConv(els.persona, (el) => { if (!isAssistant(c())) c().persona = el.value; });
  onConv(els.postHistory, (el) => { if (!c().lock && !isAssistant(c())) c().postHistory = el.value; });
  // {{user}} 的值改了：聊天区里显示的内容跟着变（稍等一下再重画，开场白的窗口重画时会重新载入）
  let userNameTimer = null;
  onConv(els.userName, (el) => {
    if (isAssistant(c())) return;
    c().userName = el.value;
    clearTimeout(userNameTimer);
    userNameTimer = setTimeout(() => { if (state.conv) renderMessages(); }, 300);
  });

  // 记忆轮数：可以直接输入，也可以点 − / +，范围 1–40
  const setRounds = (n) => {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) n = s().rounds;
    n = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n));
    els.rounds.value = n;
    if (n === s().rounds) return;
    s().rounds = n;
    saveSettingsSoon();
    updateEstimate();
    renderMessages();
  };
  els.rounds.addEventListener('change', () => setRounds(els.rounds.value));
  els.rounds.addEventListener('keydown', (e) => { if (e.key === 'Enter') setRounds(els.rounds.value); });
  els.btnRoundsMinus.addEventListener('click', () => setRounds(s().rounds - 1));
  els.btnRoundsPlus.addEventListener('click', () => setRounds(s().rounds + 1));

  onSetting(els.baseUrl, (el) => { s().baseUrls[s().provider] = el.value.trim(); });
  onSetting(els.apiKey, (el) => { s().apiKeys[s().provider] = el.value.trim(); });
  onSetting(els.model, (el) => { s().models[s().provider] = el.value.trim(); });
  onSetting(els.maxTokens, (el) => { s().maxTokens[s().provider] = el.value ? Number(el.value) : ''; });
  onSetting(els.temperature, (el) => { s().temperature = Number(el.value); });
  els.effort.addEventListener('change', () => { s().effort = els.effort.value; saveSettingsSoon(); });
  els.useTemperature.addEventListener('change', () => {
    s().useTemperature = els.useTemperature.checked;
    els.temperature.disabled = !s().useTemperature;
    saveSettingsSoon();
  });
  els.provider.addEventListener('change', () => {
    s().provider = els.provider.value;
    const p = PROVIDERS[s().provider];
    if (!s().models[s().provider] && p.defaultModel) s().models[s().provider] = p.defaultModel;
    fillProviderFields();
    saveSettingsSoon();
    updateEstimate();
  });
  els.langSelect.addEventListener('change', () => {
    s().lang = els.langSelect.value;
    saveSettingsSoon();
    applyLang(s().lang);
  });

  els.btnResetSystem.addEventListener('click', async () => {
    const conv = c();
    if (conv.lock || !(await ask(t('set.resetConfirm'), { ok: t('set.resetDefault') }))) return;
    if (conv !== c()) return;
    c().systemPrompt = defaultPromptOf(conv);
    els.systemPrompt.value = c().systemPrompt;
    saveConvSoon();
    updateEstimate();
  });

  els.btnUploadWorld.addEventListener('click', () => els.fileWorld.click());
  els.fileWorld.addEventListener('change', async () => {
    const f = els.fileWorld.files[0];
    els.fileWorld.value = '';
    if (!f) return;
    if (c().lock || isAssistant(c())) return;
    if (!/\.(txt|md)$/i.test(f.name)) return toast(t('set.worldOnlyText'));
    const text = await f.text();
    const conv = c();
    if (conv.worldText.trim() && !(await ask(t('set.worldReplace')))) return;
    if (conv !== c() || conv.lock) return;
    c().worldText = text;
    els.worldText.value = text;
    updateWorldCount();
    saveConvSoon();
    updateEstimate();
    toast(t('set.worldLoaded', { name: f.name }));
  });
  els.btnClearWorld.addEventListener('click', async () => {
    const conv = c();
    if (conv.lock || isAssistant(conv) || !conv.worldText || !(await ask(t('set.worldClear'), { ok: t('set.clear'), danger: true }))) return;
    if (conv !== c()) return;
    c().worldText = '';
    els.worldText.value = '';
    updateWorldCount();
    saveConvSoon();
    updateEstimate();
  });

  els.btnToggleKey.addEventListener('click', () => {
    const show = els.apiKey.type === 'password';
    els.apiKey.type = show ? 'text' : 'password';
    els.btnToggleKey.textContent = t(show ? 'set.hide' : 'set.show');
  });

  els.btnFetchModels.addEventListener('click', async () => {
    els.btnFetchModels.disabled = true;
    try {
      const list = await fetchModels(providerCfg());
      s().modelLists[s().provider] = list;
      saveSettingsSoon();
      toast(t('set.fetchedModels', { n: list.length }));
      openModelMenu('');
    } catch (e) {
      showModal(t('set.fetchModelsFailed'), e.message);
    } finally {
      els.btnFetchModels.disabled = false;
    }
  });


  const pickArt = () => { if (!state.conv.lock) els.fileArt.click(); };
  // 手机布局里艺术图是背景，点它不打开上传
  els.artPane.addEventListener('click', () => { if (!isMobileLayout()) pickArt(); });
  els.artPane.addEventListener('contextmenu', (e) => { if (state.conv.lock) e.preventDefault(); });
  els.btnUploadArt.addEventListener('click', pickArt);
  els.btnDownloadArt.addEventListener('click', downloadArt);
  els.btnUnlock.addEventListener('click', unlockConv);
  els.fileArt.addEventListener('change', async () => {
    const f = els.fileArt.files[0];
    els.fileArt.value = '';
    if (f) await setArt(f);
  });
  els.btnRemoveArt.addEventListener('click', async () => {
    if (state.conv.lock) return;
    await DB.del(artKey(state.conv.id));
    await loadArt();
  });

  // 公用电脑：不记住 API Key；清除本机所有数据
  els.rememberKeys.addEventListener('change', async () => {
    s().rememberKeys = els.rememberKeys.checked;
    clearTimeout(saveTimer);
    await DB.set('settings', storableSettings());
  });
  els.btnClearAll.addEventListener('click', async () => {
    if (state.generating) return toast(t('conv.stopFirst'));
    if (!(await ask(t('set.clearAllConfirm'), { ok: t('set.clearAll'), danger: true }))) return;
    if (state.generating) return toast(t('conv.stopFirst'));
    clearTimeout(saveTimer);
    clearTimeout(convSaveTimer);
    convSavePending = null;
    await DB.destroy();
    forgetNativeOrigins();
    location.reload();
  });

  els.fileTavern.addEventListener('change', async () => {
    const f = els.fileTavern.files[0];
    els.fileTavern.value = '';
    if (f) await importTavernFile(f);
  });

  // 放大窗口：System Prompt 和世界观
  els.btnExpandSystem.addEventListener('click', () => openExpand(els.systemPrompt, 'set.systemPrompt'));
  els.btnExpandWorld.addEventListener('click', () => openExpand(els.worldText, 'set.world'));
  els.expandText.addEventListener('input', () => {
    if (!expandSource) return;
    expandSource.value = els.expandText.value;
    expandSource.dispatchEvent(new Event('input')); // 和直接在右侧输入一样保存、更新字数
  });
  // 点在放大窗口以外的地方就关闭（按 Esc 也可以）
  document.addEventListener('mousedown', (e) => { if (expandSource && !els.expandBox.contains(e.target)) closeExpand(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expandSource) { e.stopPropagation(); closeExpand(); }
  }, true);

  els.btnExport.addEventListener('click', exportMenu);
  els.btnRestore.addEventListener('click', () => els.fileRestore.click());
  els.fileRestore.addEventListener('change', async () => {
    const f = els.fileRestore.files[0];
    els.fileRestore.value = '';
    if (f) await restore(f);
  });
}

// 重命名：默认是当前对话，也可以是对话列表里右键点中的对话
async function renameConv(target = state.conv) {
  const name = await askText(t('conv.rename'), t('conv.renamePrompt'), target.title);
  if (name === null || !name.trim() || !state.conversations.includes(target)) return;
  target.title = name.trim();
  await saveConv(target);
}

// 删除对话：默认是当前对话，也可以是对话列表里右键点中的对话。
// 生成回复时不能删除当前对话（其他对话可以）
async function deleteConv(gone = state.conv) {
  if (state.generating && gone === state.conv) return toast(t('conv.stopFirst'));
  if (!(await ask(t('conv.deleteConfirm', { title: convTitle(gone) }), { ok: t('conv.delete'), danger: true }))) return;
  if (!state.conversations.includes(gone) || (state.generating && gone === state.conv)) return;
  if (convSavePending === gone) convSavePending = null;
  state.conversations = state.conversations.filter((c) => c !== gone);
  if (!state.conversations.length) {
    // 删掉最后一个对话时，新建一个空对话并沿用被删对话的设定、开场白和艺术图
    const c = newConversation(gone);
    state.conversations.push(c);
    await DB.putConversation(storable(c));
    const art = await DB.get(artKey(gone.id));
    if (art) await DB.set(artKey(c.id), art);
  }
  await DB.deleteConversation(gone.id);
  await DB.del(artKey(gone.id));
  if (gone !== state.conv) return renderConvSelect();
  const next = [...state.conversations].sort((a, b) => b.activeAt - a.activeAt)[0];
  await switchConv(next.id);
}

function bindChat() {
  els.btnSend.addEventListener('click', send);
  els.btnStop.addEventListener('click', stop);
  els.btnReply.addEventListener('click', () => { if (!state.generating) void generateReply(); });
  els.btnAddGreeting.addEventListener('click', () => enterGreetingMode());
  els.btnGreetingReload.addEventListener('click', reloadGreetingPreview);
  els.btnGreetingConfirm.addEventListener('click', confirmGreeting);
  els.btnGreetingCancel.addEventListener('click', exitGreetingMode);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      if (state.greetingMode) reloadGreetingPreview();
      else void send();
    }
  });

  els.messages.addEventListener('scroll', onMessagesScroll);
  els.btnJumpBottom.addEventListener('click', scrollToBottom);
  els.btnJumpTop.addEventListener('click', scrollToTop);

  // 对话列表：点击展开；键盘 ↑ ↓ 选择、Enter 切换、Esc 收起，菜单键或 Shift + F10 打开右键菜单
  els.convSelect.addEventListener('click', () => { if (els.convMenu.hidden) openConvMenu(); else closeConvMenu(); });
  els.convSelect.addEventListener('keydown', (e) => {
    const open = !els.convMenu.hidden;
    const n = convMenu.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openConvMenu();
      closeConvCtxMenu();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      highlightConv(convMenu.active < 0 ? 0 : (convMenu.active + d + n) % n, true);
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (convMenu.items[convMenu.active]) pickConv(convMenu.items[convMenu.active]);
    } else if (open && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      const el = els.convMenu.querySelectorAll('.combo-item')[convMenu.active];
      if (!el) return;
      const r = el.getBoundingClientRect();
      openConvCtxMenu(convMenu.items[convMenu.active], r.left + 24, r.bottom);
    } else if (open && e.key === 'Tab') {
      closeConvMenu();
    }
  });
  els.btnCtxRename.addEventListener('click', () => {
    const c = ctxConv;
    closeConvMenu();
    if (c) void renameConv(c); // 不用等：输入框和保存由 renameConv 自己完成
  });
  els.btnCtxDelete.addEventListener('click', () => {
    const c = ctxConv;
    closeConvMenu();
    if (c) void deleteConv(c); // 不用等：确认框和删除由 deleteConv 自己完成
  });
  // 点在列表和右键菜单以外：都收起；点在列表里（右键菜单以外）：只收起右键菜单
  document.addEventListener('mousedown', (e) => {
    if (els.convCtxMenu.contains(e.target)) return;
    closeConvCtxMenu();
    if (!els.convPicker.contains(e.target)) closeConvMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.convCtxMenu.hidden) { e.stopPropagation(); closeConvCtxMenu(); els.convSelect.focus(); }
    else if (!els.convMenu.hidden) { e.stopPropagation(); closeConvMenu(); els.convSelect.focus(); }
  }, true);
  window.addEventListener('resize', closeConvMenu);
  els.btnNewConv.addEventListener('click', (e) => {
    e.stopPropagation();
    if (els.newConvMenu.hidden) openNewConvMenu(); else closeNewConvMenu();
  });
  els.btnNewRoleplay.addEventListener('click', () => createConversation('roleplay'));
  els.btnNewAssistant.addEventListener('click', () => createConversation('assistant'));
  els.btnNewTavern.addEventListener('click', () => createConversation('tavern'));
  // 菜单里用 ↑ ↓ 移动
  els.newConvMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = newConvItems();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener('click', (e) => { if (!els.newConvGroup.contains(e.target)) closeNewConvMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.newConvMenu.hidden) { e.stopPropagation(); closeNewConvMenu(); els.btnNewConv.focus(); }
  }, true);
  els.btnRenameConv.addEventListener('click', () => renameConv());
  els.btnRenameConv2.addEventListener('click', () => renameConv());
  els.btnDeleteConv.addEventListener('click', () => deleteConv());
  els.btnDeleteConv2.addEventListener('click', () => deleteConv());

  els.btnModalClose.addEventListener('click', () => { els.modal.hidden = true; });
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.modal.hidden = true; });

  window.addEventListener('beforeunload', (e) => {
    if (convSavePending) void flushConvSave(); // 页面正在关闭，等不了；尽量写入
    if (state.generating) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------------- 启动 ----------------

async function boot() {
  const saved = (await DB.get('settings')) || {};
  const sessionKeys = state.settings && state.settings.rememberKeys === false ? state.settings.apiKeys : null;
  state.settings = { ...DEFAULT_SETTINGS, ...saved };
  for (const k of ['apiKeys', 'baseUrls', 'models', 'maxTokens', 'modelLists']) {
    state.settings[k] = { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) };
  }
  if (sessionKeys) state.settings.apiKeys = sessionKeys; // 不记住 Key 时，本次打开期间填过的 Key 继续有效
  // OpenRouter 不再单列，归到“其他 OpenAI 兼容格式”：之前选的是它时，把 Key 和模型搬过去（那边还空着时）
  if (state.settings.provider === 'openrouter') {
    const s = state.settings;
    if (!s.apiKeys.custom_openai && !s.baseUrls.custom_openai) {
      s.apiKeys.custom_openai = s.apiKeys.openrouter || '';
      s.baseUrls.custom_openai = 'https://openrouter.ai/api/v1';
      s.models.custom_openai = s.models.openrouter || '';
    }
    s.provider = 'custom_openai';
  }
  if (!PROVIDERS[state.settings.provider]) state.settings.provider = 'anthropic';
  state.settings.rounds = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Number(state.settings.rounds) || 12));
  setLang(state.settings.lang || detectLang());

  // 旧版本把 System Prompt、世界观、人设和艺术图放在全局，迁移到每个对话里
  const legacy = { systemPrompt: saved.systemPrompt, worldText: saved.worldText, persona: saved.persona };
  const legacyArt = await DB.get('art');
  state.conversations = [];
  for (const c of await DB.listConversations()) {
    try { await openLock(c); } catch (e) { console.error('无法解密对话', c.id, e); continue; }
    state.conversations.push(c);
    const fields = () => JSON.stringify([c.title, c.mode, c.tavern, c.systemPrompt, c.worldText, c.persona, c.userName, c.postHistory,
      c.greeting, c.greetings, c.greetingCur, c.greetingSend, c.activeAt, !!c.lock]);
    const before = fields();
    normalizeConv(c, legacy);
    if (fields() !== before) await DB.putConversation(storable(c));
    if (legacyArt && !(await DB.get(artKey(c.id)))) await DB.set(artKey(c.id), legacyArt);
  }
  if (legacyArt) await DB.del('art');
  if ('systemPrompt' in saved || 'worldText' in saved || 'persona' in saved) {
    delete state.settings.systemPrompt;
    delete state.settings.worldText;
    delete state.settings.persona;
    await DB.set('settings', storableSettings());
  }

  if (!state.conversations.length) {
    // 没有任何对话：新建一个，旧版本留下的全局设定（如果有）沿用到它身上
    const c = normalizeConv({ ...newConversation(), systemPrompt: undefined, worldText: undefined, persona: undefined }, legacy);
    state.conversations.push(c);
    await DB.putConversation(c);
  }
  state.conv = state.conversations.find((c) => c.id === state.settings.activeConvId)
    || [...state.conversations].sort((a, b) => b.activeAt - a.activeAt)[0];
  state.settings.activeConvId = state.conv.id;
  state.renderedConvId = null;
  state.editingId = null;
  state.greetingMode = null;

  applyLayout();
  applyLang(LANG);
  fillSettingsForm();
  fillConvFields();
  renderConvSelect();
  renderMessages();
  scrollToBottom();
  await loadArt();
}

function init() {
  for (const el of document.querySelectorAll('[id]')) els[el.id] = el;
  els.langSelect.innerHTML = Object.entries(LANGS).map(([k, name]) => `<option value="${k}">${name}</option>`).join('');
  bindSettings();
  bindChat();
  bindLayout();
  bindModelMenu();
  bindBackButton();
  // 消息高度变化时（内容载入、图片加载、展开 <details> 等），如果停留在底部就继续贴底
  Render.onResize(() => { if (state.follow) els.messages.scrollTop = els.messages.scrollHeight; });
  void detectVersion().then((v) => { state.version = v; renderFooter(); }); // detectVersion 自己处理出错
  boot().catch((e) => {
    console.error(e);
    showError(t('boot.failed', { msg: e.message }));
  });
}

document.addEventListener('DOMContentLoaded', init);
