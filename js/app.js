// 主程序：界面、对话管理、上下文拼装。
//
// 数据分两类：
//   - 每个对话各自保存：System Prompt、世界观、NPC角色（npcText）和 {{char}} 的值（charName）、用户人设、{{user}} 的值（userName）、重点指令（postHistory）、
//     开场白（可以有多个版本：greetings 和当前版本的序号 greetingCur，greeting 是当前版本）、剧情，
//     以及艺术图（存在 art:<对话id>）。新建对话时复制当前对话的设定和开场白，之后互不影响。
//   - 来自加密世界卡的对话带有 conv.lock：System Prompt、世界观、重点指令、开场白和艺术图只以密文保存，
//     在内存里解密后使用，界面上不能查看或修改，输入密码解锁后变回普通对话。
//   - 酒馆兼容对话（带 conv.tavern = { char, book }）：导入酒馆（SillyTavern）的角色卡或世界书得到的角色扮演对话。
//     char 是读取的角色卡的名字（还没有角色卡时为 null），book 是世界书的名字（还没有世界书时为 null），
//     用来判断还能不能把酒馆的内容加入这个对话。读取角色卡时 {{char}} 的值（charName）也填上这个名字，之后可以改。
//   - 助理模式的对话（conv.mode === 'assistant'）：普通的 LLM 对话，只发送 System Prompt 和对话记录。
//     世界观、用户人设、{{user}} 的值、重点指令、开场白都不使用（保持为空），也不加密；艺术图照常可用。没有 mode 的就是角色扮演对话，
//     所以存储和备份格式与角色扮演对话相同。
//   - 软件设置（所有对话共用）：界面语言、记忆长度、模型与接口（包括用户添加的服务商）、API Key、布局。

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 40;

const DEFAULT_SETTINGS = {
  lang: null,          // null = 按系统语言自动选择（不支持的语言用英语）
  rememberKeys: true,  // false = API Key 只在本次打开期间有效，不写入本机存储（公用电脑）
  rounds: 12,
  artWidth: null,      // 左栏宽度（像素），null = 自动
  panelKey: 'F2',      // 横屏艺术图时收起 / 显示右侧设置区的快捷键（Ctrl+Shift+K 这样的写法）
  inputHeight: 88,     // 输入框高度（像素）
  provider: 'anthropic', // 官方服务商的键名（anthropic / openai / gemini），或者用户添加的服务商 relay:<id>
  relays: [],          // 用户添加的服务商（中转站）：[{ id, name, format: 'openai' | 'anthropic' }]，按添加的顺序
  apiKeys: {},
  baseUrls: {},
  models: {},          // 各服务商的模型名。没有预填：模型名要用户自己获取列表后选，或直接输入
  maxTokens: { anthropic: 16000 }, // 新添加的 Anthropic 兼容服务商也从 16000 开始（saveRelayDialog）
  effort: '',
  useTemperature: false,
  temperature: 1,
  openrouterSort: '',      // OpenRouter：按什么选上游（'' 默认均衡、price、throughput、latency）
  openrouterNoData: false, // OpenRouter：不用会保存请求数据的上游（provider.data_collection = deny）
  activeConvId: null,
  // GitHub 同步（js/sync.js）：login 是登录的账号名，repo 是同步用的仓库 { owner, name, branch }，
  // marker 是仓库里标记文件的副本（加密设置），artDefault 是全局的「同步艺术图」，repoPublic 是仓库是否公开（只用来提示）。
  // 登录凭据不在这里（DB 的 githubToken）
  sync: { login: null, repo: null, marker: null, artDefault: true, repoPublic: false },
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
  // 本次打开期间「获取列表」得到的模型：{ 服务商: { models, info } }，info 是附加信息 { 模型名: { in, out, call, status, tags } }
  // （providers.js 的 modelInfoOf）。不保存：服务商的模型会更新，每次打开软件重新获取；上次选的模型名照样保存、可用
  modelLists: {},
};

const els = {};

// ---------------- 工具函数 ----------------

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID 只在安全上下文（https、本机文件）里有；其他情况用同样来自安全随机数的 16 字节
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// 点窗口以外的地方（遮罩）关闭。按下和松开都要在遮罩上：在窗口里按下鼠标拖选文字、到窗口外才松开时，
// click 落在遮罩上，但不是要关闭
function closeOnBackdrop(backdrop, close) {
  let downOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && downOnBackdrop) close();
    downOnBackdrop = false;
  });
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
const LOCKED_FIELDS = ['systemPrompt', 'worldText', 'npcText', 'charName', 'postHistory', 'greeting', 'greetings', 'greetingSend'];
function storable(conv) {
  if (!conv.lock) return conv;
  const out = { ...conv };
  for (const k of LOCKED_FIELDS) delete out[k];
  return out;
}
const lockedFields = (c) => ({
  systemPrompt: c.systemPrompt, worldText: c.worldText, npcText: c.npcText, charName: c.charName, postHistory: c.postHistory,
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
// 整数并限制在 min…max 之间；不是数字时为 min
function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

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
    openrouterSort: s.openrouterSort,
    openrouterNoData: s.openrouterNoData,
  };
}

// token 校准按“中转站（接口地址）→ 模型”记录（tokens.js）。当前服务商对应的中转站、模型和系数
function calibKey(cfg = providerCfg()) {
  return { relay: TokenCalib.relayOf(baseOf(cfg)), model: cfg.model };
}
function currentCoef() {
  const k = calibKey();
  return TokenCalib.coefOf(k.relay, k.model);
}

// 一段文字大约多少 token：按当前中转站和模型的实际用量校准过（没有数据时就是粗略估算）
function tokensOf(text, coef = currentCoef()) {
  return TokenCalib.textTokens(text, coef);
}

// ---------------- 上下文拼装 ----------------
// 顺序：System Prompt → 世界观 → NPC角色 → 用户角色人设（都取自当前对话，空的整段省略）。重点指令加在这一次的用户消息末尾。
// 最后把所有内容里的 {{user}} 换成 {{user}} 的值（没填时原样保留）

function buildSystem(conv = state.conv) {
  // 助理模式只发送 System Prompt，不带世界观、人设和它们的标签
  if (isAssistant(conv)) return conv.systemPrompt.trim();
  const parts = [];
  if (conv.systemPrompt.trim()) parts.push(conv.systemPrompt.trim());
  if (conv.worldText.trim()) parts.push(t('sys.world') + '\n' + conv.worldText.trim());
  if (conv.npcText.trim()) parts.push(t('sys.npc') + '\n' + conv.npcText.trim());
  if (conv.persona.trim()) parts.push(t('sys.persona') + '\n' + conv.persona.trim());
  return parts.join('\n\n');
}

// 显示和发送时替换的宏（不区分大小写）。存着的内容不变；没有值时原样保留：
//   {{user}} → {{user}} 的值（用户角色人设上方）；{{char}} → {{char}} 的值（NPC角色上方）
const USER_MACRO = /\{\{user\}\}/gi;
const CHAR_MACRO = /\{\{char\}\}/gi;
function withMacros(text, conv = state.conv) {
  if (!text || !conv || isAssistant(conv)) return text;
  const user = (conv.userName || '').trim();
  const char = (conv.charName || '').trim();
  let out = text;
  if (user) out = out.replace(USER_MACRO, () => user);
  if (char) out = out.replace(CHAR_MACRO, () => char);
  return out;
}

// 加在这一次的用户消息末尾的重点指令：标签、一句说明（告诉模型这是剧情之外直接对它说的，界面上不显示），然后是重点指令全文；
// 没有内容时为空
function postHistoryBlock(conv) {
  const text = !isAssistant(conv) && conv.postHistory ? conv.postHistory.trim() : '';
  return text ? `${t('sys.postHistory')}\n${t('sys.postHistoryIntro')}\n${text}` : '';
}

// 剧情备忘：设为发送、有内容时，放在这一次的用户消息前面（最后一条模型回复之后），带标签和说明
function memoBlock(conv) {
  const text = !isAssistant(conv) && conv.memoSend !== false && conv.memo ? conv.memo.trim() : '';
  return text ? `${t('sys.memo')}\n${t('sys.memoIntro')}\n${text}\n${t('sys.memoEnd')}` : '';
}

// 真正发给模型的内容：system 部分和记忆范围内的消息（context 的最后一条是这一次的用户消息）。
// memoUpdate：更新剧情备忘的请求（最后一条是更新的指令，里面已经有现在的备忘）：不加剧情备忘和重点指令
function requestOf(conv, context, { memoUpdate = false } = {}) {
  const greeting = sentGreeting(conv);
  const messages = windowOf(context, greeting);
  const memo = memoUpdate ? '' : memoBlock(conv);
  const block = memoUpdate ? '' : postHistoryBlock(conv);
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    // 剧情备忘在前，后面的消息加上「【用户】」标签；这一条已经和开场白合在一起时（对话的第一条消息）本来就有这个标签
    const greeted = context.length === 1 && !!greeting;
    if (memo) last.content = memo + '\n\n' + (greeted ? '' : t('greet.user') + '\n') + last.content;
    if (block) last.content += '\n\n' + block;
  }
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

// 导出时可以选择加密的对话：只有角色扮演对话。助理模式不加密；酒馆兼容对话的设定来自酒馆卡的作者，
// 作者没有选择锁定，不能由读卡的人加上锁，所以也不加密。（以前的测试版导出过加密的酒馆兼容对话，那些照常读取、保持锁定）
const canEncrypt = (conv) => !isAssistant(conv) && !isTavern(conv);

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
    const c = {
      id: uid(),
      title: '',
      mode: 'assistant',
      systemPrompt: isAssistant(from) ? from.systemPrompt : t('defaultAssistantPrompt'),
      worldText: '',
      npcText: '',
      charName: '',
      persona: '',
      userName: '',
      postHistory: '',
      greeting: null,
      greetings: [],
      greetingCur: 0,
      greetingSend: true,
      memo: '',
      memoSend: true,
      memoEvery: 0,
      memoRound: 0,
      createdAt: now,
      updatedAt: now,
      activeAt: now,
      messages: [],
    };
    if (from && from.artMode) c.artMode = from.artMode; // 艺术图从 from 复制过来时，展示方式也一样
    return c;
  }
  if (isAssistant(from)) from = null;
  const c = {
    id: uid(),
    title: '',
    systemPrompt: from ? from.systemPrompt : t('defaultSystemPrompt'),
    worldText: from ? from.worldText : '',
    npcText: from ? from.npcText : '',
    charName: from ? from.charName : '',
    persona: from ? from.persona : '',
    userName: from ? from.userName : '',
    postHistory: from ? from.postHistory : '',
    greeting: from ? from.greeting : null,
    greetings: from ? from.greetings.slice() : [],
    greetingCur: from ? from.greetingCur : 0,
    greetingSend: from ? from.greetingSend !== false : true,
    memo: '', // 剧情备忘属于剧情，不复制；是否发送、每几轮自动更新是设置，复制
    memoSend: from ? from.memoSend !== false : true,
    memoEvery: from ? from.memoEvery || 0 : 0,
    memoRound: 0,
    createdAt: now,
    updatedAt: now,
    activeAt: now,
    messages: [],
  };
  if (from && from.lock) c.lock = from.lock;
  if (isTavern(from)) c.tavern = { ...from.tavern };
  if (from && from.artMode) c.artMode = from.artMode;
  return c;
}

// 补齐旧版本数据缺少的字段
function normalizeConv(c, legacy) {
  if (c.title === '新对话') c.title = '';
  if (c.artMode !== 'landscape') delete c.artMode; // 艺术图的展示方式：只记横屏，没有就是竖屏
  // 剧情备忘（助理模式不用）：内容、是否发送、每几轮自动更新（0 = 关闭）、上次更新时是第几轮
  if (typeof c.memo !== 'string' || isAssistant(c)) c.memo = '';
  c.memoSend = c.memoSend !== false;
  c.memoEvery = isAssistant(c) ? 0 : clampInt(c.memoEvery, 0, MEMO_EVERY_MAX);
  c.memoRound = clampInt(c.memoRound, 0, Infinity);
  if (isAssistant(c)) {
    // 助理模式：只有 System Prompt 和对话记录，其他保持为空；不加密
    delete c.lock;
    delete c.tavern;
    if (typeof c.systemPrompt !== 'string') c.systemPrompt = t('defaultAssistantPrompt');
    c.worldText = '';
    c.npcText = '';
    c.charName = '';
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
  if (typeof c.npcText !== 'string') c.npcText = '';
  if (typeof c.persona !== 'string') c.persona = (legacy && legacy.persona) || '';
  if (typeof c.userName !== 'string') c.userName = '';
  normalizeTavern(c);
  // 这一版之前的酒馆兼容对话没有 charName：用读取的角色卡的名字
  if (typeof c.charName !== 'string') c.charName = (c.tavern && c.tavern.char) || '';
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
  closePreview();
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
  // 不自动把光标放进输入框（手机上会弹出键盘）：用户自己点输入框
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

// 对话名称、轮数和时间之间的分隔：手机布局只有一个圆点（屏幕窄），电脑布局圆点两边各一个空格
const convLabel = (c) => KIND_EMOJI[kindOf(c)] + ' ' + (c.lock ? '🔒 ' : '')
  + t('conv.option', { title: convTitle(c), rounds: roundsText(roundsOf(c)), time: fmtTime(c.activeAt), sep: isMobileLayout() ? '·' : ' · ' });

// 对话列表（顶部）。按最近一次活动的时间排序
function renderConvSelect() {
  els.convCurrent.textContent = state.conv ? convLabel(state.conv) : '';
  if (!els.convMenu.hidden) fillConvMenu();
  if (!els.allConvBox.hidden) fillAllConvs(); // 在「全部对话」窗口里重命名、删除后跟着更新
}

// 对话列表只列出最近活动的 CONV_MENU_SIZE 个对话（按最近一次活动的时间，旧对话有了新消息也会排到前面）；
// 更多时最后一项是「…」，点开「全部对话」窗口。convMenu.items 是列出的对话，active 是选中的位置（「…」排在最后）
const CONV_MENU_SIZE = 9;
const convMenu = { items: [], active: -1, more: false };

const sortedConvs = () => [...state.conversations].sort((a, b) => b.activeAt - a.activeAt);

function fillConvMenu() {
  const all = sortedConvs();
  convMenu.items = all.slice(0, CONV_MENU_SIZE);
  convMenu.more = all.length > CONV_MENU_SIZE;
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
    addLongPress(item, (x, y) => {
      highlightConv(i, false);
      openConvCtxMenu(c, x, y);
    });
    els.convMenu.appendChild(item);
  });
  if (convMenu.more) {
    const more = document.createElement('div');
    more.className = 'combo-item conv-more';
    more.setAttribute('role', 'option');
    more.textContent = '…';
    more.title = t('conv.allTitle');
    more.setAttribute('aria-label', t('conv.allTitle'));
    more.addEventListener('click', openAllConvs);
    more.addEventListener('contextmenu', (e) => e.preventDefault());
    more.addEventListener('mousemove', () => highlightConv(convMenu.items.length, false));
    els.convMenu.appendChild(more);
  }
  const n = convMenu.items.length + (convMenu.more ? 1 : 0);
  if (convMenu.active >= n) convMenu.active = n - 1;
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

// 「全部对话」窗口：所有对话按最近活动的时间排列。电脑上点一下选中一个对话，再点一次或双击切换过去（键盘按 Enter 直接切换）；
// 触屏上点一下直接切换。右键（触屏上长按）重命名或删除，点窗口以外的地方或按 Esc 关闭。
// 可以选中多个对话一起删除：
//   电脑：按住 Ctrl（Mac 上是 ⌘）点击，选中或取消选中一个；按住 Shift 点击，选中从上次点的那个到这个之间的全部
//         （同时按住 Ctrl 时加到已选中的里面）。右键任一选中的对话弹出删除。
//   触屏：每个对话最右边有一个勾选框；长按任一勾选的对话弹出删除。
// 选中两个以上时菜单里只有删除（不能一起重命名）。不按 Ctrl / Shift 右键（触屏上长按）一个没有选中的对话时，
// 原来选中的全部取消，菜单只对这一个对话（重命名、删除）。
// 选中的对话记在 allSel（对话 id），allAnchor 是 Shift 选择的起点
const allSel = new Set();
let allAnchor = null;

function openAllConvs() {
  closeConvMenu();
  allSel.clear();
  allAnchor = null;
  fillAllConvs();
  els.allConvBox.hidden = false;
  const cur = els.allConvList.querySelector('.current .all-conv-item');
  if (cur) { cur.scrollIntoView({ block: 'center' }); cur.focus({ preventScroll: true }); }
}

function closeAllConvs() {
  closeConvCtxMenu();
  els.allConvBox.hidden = true;
  allSel.clear();
  allAnchor = null;
}

// 选中的对话（按列表里的顺序）
const selectedConvs = () => sortedConvs().filter((c) => allSel.has(c.id));

function fillAllConvs() {
  const top = els.allConvList.scrollTop; // 重新列出后保持滚动位置（勾选、改名、删除时列表不跳回顶部）
  els.allConvList.innerHTML = '';
  const list = sortedConvs();
  // 已经删掉的对话不再算选中
  const ids = new Set(list.map((c) => c.id));
  for (const id of [...allSel]) if (!ids.has(id)) allSel.delete(id);
  if (allAnchor && !ids.has(allAnchor)) allAnchor = null;
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'all-conv-row' + (c === state.conv ? ' current' : '');
    row.dataset.id = c.id;
    const item = button(convLabel(c), (e) => {
      if (e.shiftKey) return selectConvRange(c, e.ctrlKey || e.metaKey);
      if (e.ctrlKey || e.metaKey) return toggleConvSelected(c);
      // 电脑上：点一下只选中这一个，再点一次（或双击）才切换过去。键盘的 Enter / 空格（detail 为 0）和触屏的点按直接切换
      const open = e.detail === 0 || isTouchList() || e.detail > 1 || (allSel.size === 1 && allSel.has(c.id));
      if (!open) return selectOnlyConv(c);
      closeAllConvs();
      if (c !== state.conv) void switchConv(c.id);
    }, 'all-conv-item');
    item.title = convLabel(c);
    // 触屏上的勾选框（电脑上由 CSS 隐藏）
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'all-conv-check';
    box.setAttribute('aria-label', t('conv.select', { title: convTitle(c) }));
    box.addEventListener('change', () => toggleConvSelected(c));
    row.append(item, box);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openAllConvCtxMenu(c, e.clientX, e.clientY);
    });
    addLongPress(row, (x, y) => openAllConvCtxMenu(c, x, y));
    els.allConvList.appendChild(row);
  }
  els.allConvList.scrollTop = top;
  showConvSelection();
}

// 按 allSel 更新每一行的选中样式和勾选框（不重新列出，长按、点击中的那一行不会被换掉）
function showConvSelection() {
  for (const row of els.allConvList.children) {
    const on = allSel.has(row.dataset.id);
    row.classList.toggle('selected', on);
    row.querySelector('.all-conv-item').setAttribute('aria-pressed', String(on));
    row.querySelector('.all-conv-check').checked = on;
  }
}

// 触屏（没有鼠标悬停）：和 CSS 里显示勾选框的条件相同
const isTouchList = () => window.matchMedia('(hover: none)').matches;

// 电脑上不按 Ctrl / Shift 点击：只选中这一个，它也是 Shift 选择的起点
function selectOnlyConv(c) {
  allSel.clear();
  allSel.add(c.id);
  allAnchor = c.id;
  closeConvCtxMenu();
  showConvSelection();
  focusAllConv(c);
}

function toggleConvSelected(c) {
  if (allSel.has(c.id)) allSel.delete(c.id); else allSel.add(c.id);
  allAnchor = c.id;
  closeConvCtxMenu();
  showConvSelection();
  focusAllConv(c);
}

// Shift + 点击：选中起点（上次 Ctrl 点击或 Shift 点击时的起点；还没有时是当前对话）到 c 之间的全部。
// keep 为 true（同时按住 Ctrl）时保留原来选中的，否则只留这一段
function selectConvRange(c, keep) {
  const list = sortedConvs();
  let a = list.findIndex((x) => x.id === allAnchor);
  if (a < 0) a = Math.max(0, list.indexOf(state.conv));
  allAnchor = list[a].id;
  const b = list.indexOf(c);
  if (!keep) allSel.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) allSel.add(list[i].id);
  closeConvCtxMenu();
  showConvSelection();
  focusAllConv(c);
}

function focusAllConv(c) {
  const i = sortedConvs().indexOf(c);
  const el = els.allConvList.querySelectorAll('.all-conv-item')[i];
  if (el) el.focus({ preventScroll: true });
}

// 「全部对话」窗口里的右键菜单（触屏上长按）：点中的是选中的对话、并且选中了两个以上时，只有「删除 N 个对话」；
// 点中的是没有选中的对话时，原来选中的全部取消，和对话列表里一样对这一个对话重命名或删除
function openAllConvCtxMenu(c, x, y) {
  if (!allSel.has(c.id) && allSel.size) {
    allSel.clear();
    allAnchor = null;
    showConvSelection();
  }
  const sel = selectedConvs();
  if (sel.length > 1) openConvCtxMenu(sel, x, y);
  else openConvCtxMenu(c, x, y);
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

// 触屏上长按（约半秒、手指没有移动）调用 onPress(x, y)，代替鼠标右键：安卓 WebView 不一定把长按当作右键。
// 长按以后松手不算一次点击（不会切换对话）。手指移动超过 10 像素（在滚动）就取消
function addLongPress(el, onPress) {
  let timer = null;
  let fired = false;
  let x0 = 0;
  let y0 = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchstart', (e) => {
    cancel();
    fired = false;
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      if (navigator.vibrate) navigator.vibrate(15);
      onPress(x0, y0);
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const p = e.touches[0];
    if (timer && Math.hypot(p.clientX - x0, p.clientY - y0) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    cancel();
    if (fired && e.cancelable) e.preventDefault(); // 不产生随后的点击
  });
  el.addEventListener('touchcancel', cancel);
  // 长按时系统也可能发出右键（contextmenu）事件：已经由上面处理过，不再重复打开
  el.addEventListener('contextmenu', (e) => { if (fired) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
}

// 右键菜单（触屏上长按）：重命名、删除，对象是右键点中的那个对话（不一定是当前对话）。
// target 是一组对话时（「全部对话」窗口里选中了多个），菜单里只有「删除 N 个对话」
let ctxConv = null;

function openConvCtxMenu(target, x, y) {
  ctxConv = target;
  const many = Array.isArray(target);
  els.btnCtxRename.hidden = many;
  els.btnCtxDelete.textContent = many ? t('conv.deleteN', { n: target.length }) : t('conv.delete');
  const m = els.convCtxMenu;
  m.hidden = false;
  // 出现在光标右下方；靠近窗口边缘时往回收，不超出窗口
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4)) + 'px';
  (many ? els.btnCtxDelete : els.btnCtxRename).focus();
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
      // 手机上屏幕窄，前两句在逗号处换行（文字里的 \n），写法也和电脑上不同
      const m = isMobileLayout() ? 'Mobile' : '';
      const lines = (key) => t(key).split('\n').flatMap((line, i) => (i ? [document.createElement('br'), line] : [line]));
      hint.append(...lines('msg.empty' + m), document.createElement('br'));
      const sub = document.createElement('span');
      sub.className = 'small';
      sub.append(...lines('msg.emptySub1' + m), document.createElement('br'), t('msg.emptySub2' + m));
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
  // 用户消息下方常驻的说明：这个版本为什么没得到回复（见 runGeneration）
  const note = document.createElement('div');
  note.className = 'msg-error';
  note.hidden = true;
  el.append(note, actions);
  return { el, label, holder, note, actions, sendBox, sendText, frame: null, editor: null, shownText: null };
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

  const note = m && m.role === 'user' && !editing && Array.isArray(m.errors) && typeof m.errors[m.cur] === 'string' ? m.errors[m.cur] : '';
  v.note.textContent = note;
  v.note.hidden = !note;

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
  els.btnStop.textContent = t(busy && state.generating.memo ? 'memo.stop' : 'btn.stop');
  els.btnReply.hidden = busy || gm || !(last && last.role === 'user');
  els.btnUpdateMemo.disabled = busy || gm || !canUpdateMemo(conv);
  renderMemoStatus();
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

// 记忆长度下方：下一次请求大约多少输入 token。总数和「查看下一轮将发送的内容」顶部的总数是同一个：
// 用同一份内容（nextEstimate：输入框里的文字算作这一次的消息、合并连续同一角色的消息、补“前情省略”）。
// 校准从第一次请求起就逐步进行（tokens.js：岭回归，没有数据时系数为 1、加值为 0，就是粗略估算），所以提示文字不分“粗略 / 已校准”。
// 这个对话上一次请求（同一中转站和模型）有记录时，下面再显示两行：发送时的估算，以及接口报告的实际用量和偏差
function updateEstimate() {
  const { estimate, last } = nextEstimate();
  let text = t('set.tokenEstimate', { tokens: estimate.total.toLocaleString() });
  if (last) {
    if (last.est !== null) text += '\n' + t('set.tokenLastEst', { tokens: last.est.toLocaleString() });
    if (last.input === null) text += '\n' + t('set.tokenLastNone');
    else {
      let line = t('set.tokenLastIn', { input: last.input.toLocaleString() });
      if (last.est !== null) line += t('set.tokenLastBias', { bias: biasText(last.est, last.input) });
      line += last.output !== null ? t('set.tokenLastOut', { output: last.output.toLocaleString() }) : t('set.tokenLastOutNone');
      text += '\n' + line;
    }
  }
  els.tokenEstimate.textContent = text;
}

// 偏差 =（估值 − 实际）÷ 实际，带正负号：负数是估少了。例如 −8.9%
function biasText(est, actual) {
  const p = Math.round(((est - actual) / actual) * 1000) / 10;
  const n = Math.abs(p).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (p > 0 ? '+' : p < 0 ? '−' : '') + n + '%';
}

// ---- 安装更新时保留输入框里的文字 ----
// 安装更新会关闭软件：安装前把输入框里没发送的文字存起来（update.js 的 startInstall），下次启动时放回同一个对话。
// 只放回 10 分钟以内存的；放回后（或者过期）就删掉
const INPUT_DRAFT_KEY = 'proteus.inputDraft';
const INPUT_DRAFT_MAX_AGE = 10 * 60 * 1000;

function saveInputDraft() {
  const text = els.input.value;
  if (!text.trim() || state.greetingMode || !state.conv) return;
  try { localStorage.setItem(INPUT_DRAFT_KEY, JSON.stringify({ conv: state.conv.id, text, t: Date.now() })); } catch (_) { /* 存不了就算了 */ }
}

function forgetInputDraft() {
  try { localStorage.removeItem(INPUT_DRAFT_KEY); } catch (_) { /* 本来就没存 */ }
}

function restoreInputDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(INPUT_DRAFT_KEY) || 'null'); } catch (_) { /* 认不出就不放回 */ }
  forgetInputDraft();
  if (!d || typeof d.text !== 'string' || !(Date.now() - d.t < INPUT_DRAFT_MAX_AGE)) return;
  if (state.conv && state.conv.id === d.conv && !els.input.value) {
    els.input.value = d.text;
    updateEstimateSoon();
  }
}

// 在输入框里打字时稍等一下再更新
let estimateTimer = null;
function updateEstimateSoon() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => { if (state.conv) updateEstimate(); }, 250);
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

// 点击是否落在确认框、输入框或信息弹窗里：这些窗口盖在其他东西上面，在里面点击不应该关掉下面打开的菜单和窗口
const insideDialog = (el) => !!(el && el.closest && el.closest('#dialog, #textDialog, #pwDialog, #modal, #updateDialog, #relayDialog, #syncDialog'));

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
  const msg = { id: uid(), role: 'user', versions: [text], cur: 0 };
  const sent = { msg, text, title: conv.title }; // 一个字回复都没有时退回输入框用（见 runGeneration）
  conv.messages.push(msg);
  if (!conv.title) conv.title = titleFrom(text);
  els.input.value = '';
  await saveConv();
  await generateReply(sent);
}

// sent：刚用「发送」发出的消息（send 传入）。「生成回复」、编辑用户消息后重新生成时没有
async function generateReply(sent = null) {
  const msgs = state.conv.messages;
  const context = msgs.slice();
  const m = { id: uid(), role: 'assistant', versions: [''], cur: 0 };
  msgs.push(m);
  await runGeneration(m, context, sent);
}

async function regenerate(m) {
  const msgs = state.conv.messages;
  const idx = msgs.indexOf(m);
  m.versions.push('');
  m.cur = m.versions.length - 1;
  await runGeneration(m, msgs.slice(0, idx));
}

async function runGeneration(m, context, sent = null) {
  const conv = state.conv;
  const controller = new AbortController();
  state.generating = { controller, msgId: m.id };
  // 这次回复的是哪条用户消息（context 的最后一条）。它这个版本以前没得到回复时记下的原因（见下面）先清掉
  const owner = context[context.length - 1] && context[context.length - 1].role === 'user' ? context[context.length - 1] : null;
  if (owner && Array.isArray(owner.errors)) owner.errors[owner.cur] = null;
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
  const cfg = providerCfg();
  // 这次请求的中转站、模型和内容的特征，收到实际用量后用来校准 token 估算；
  // est 是发送时的估算（用发送时的系数算这次实际发出的内容，通常就是发送前界面上显示的那个数），之后显示为“上一次请求输入 token 估值”
  let calib = null;
  let usage = null;
  try {
    const req = requestOf(conv, context);
    const k = calibKey(cfg);
    const sent = finalMessages(formatOf(cfg), req.messages);
    const est = TokenCalib.estimate(k.relay, k.model, systemBlocks(conv).map((b) => b.text), sent.map((m) => m.content)).total;
    calib = { ...k, x: TokenCalib.requestFeatures(req.system, sent), est };
    result = await streamChat(cfg, req.system, req.messages, {
      signal: controller.signal,
      onUsage: (u) => { usage = u; },
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
  // 接口报告了输入用量（中途停止或出错时也可能已经报告了）：记下来校准以后的估算。
  // 记忆长度下方的“上一次请求”只在这次留下了回复时才换成这一次：一个字都没有时（请求出错、停止）回复会被撤掉，
  // 界面上看不到这次请求，“上一次请求”还是之前那一次（用量照样用来校准，数字是真的）。
  // 留下了回复却没收到用量（中途断开、停止，或接口不报告用量）时，记下“没收到”
  const replied = !!m.versions[ver];
  if (calib && usage && usage.input) TokenCalib.observe(calib.relay, calib.model, calib.x, usage.input, usage.output, replied ? conv.id : null, calib.est);
  else if (calib && replied) TokenCalib.observeNone(calib.relay, calib.model, conv.id, calib.est);

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
  // 刚用「发送」发出的消息一个字回复都没有（出错、被拦截、停止）：把它退回输入框，对话回到上一次回复为止，
  // 改一改再点「发送」就是重试。还在这个对话里、它仍是最后一条时才退回（切到了别的对话就留在原处）。
  // 输入框里这期间又写了字的话，接在退回的文字后面。编辑用户消息后重新生成的不退回（那条消息有多个版本，留在原处）
  // 一个字都没有时说明原因。还没出字就点了停止写「用户手动中断」；已经出了一部分再停止的不提示（看得出结尾是断的）
  let noReply = null;
  if (!kept) {
    if (error) noReply = error.message;
    else if (blocked) noReply = t('gen.' + blocked);
    else if (failed) noReply = t('gen.errorEnded');
    else if (truncated) noReply = t('gen.truncatedEmpty');
    else if (aborted) noReply = t('gen.userStopped');
    // 正常结束却一个字都没有：例如接口把正文放进了思考字段，没法判断哪些是正文
    else noReply = t('gen.empty');
  }
  let rolledBack = false;
  if (!kept && sent && state.conv === conv && conv.messages[conv.messages.length - 1] === sent.msg) {
    conv.messages.pop();
    conv.title = sent.title;
    const typed = els.input.value.trim();
    els.input.value = typed ? sent.text + '\n\n' + typed : sent.text;
    renderConvSelect(); // 标题可能退回了
    rolledBack = true;
  }
  // 没退回输入框、这条用户消息的这个版本也就没有任何回复时（编辑用户消息后重新生成、点「生成回复」）：
  // 原因记在这个版本上，常驻显示在消息下方；切到别的版本再切回来还在，下次给这个版本生成回复时清掉。
  // 其他情况（退回了输入框、重新生成时还有以前的回复版本）显示在输入框上方的红框里
  let noteOnMsg = false;
  if (!kept && !rolledBack && owner && conv.messages.includes(owner)) {
    const next = conv.messages[conv.messages.indexOf(owner) + 1];
    if (!next || next.role !== 'assistant') {
      if (!Array.isArray(owner.errors)) owner.errors = [];
      owner.errors[owner.cur] = noReply;
      noteOnMsg = true;
    }
  }

  if (state.conv === conv) renderMessages();
  await saveConv(conv);
  if (kept) maybeAutoMemo(conv);

  // 只要有输出就照常显示和保存；回复没写完就结束的（出错、被拦截、达到最大输出长度），弹窗说明一下
  if (kept) {
    if (error || failed) showModal(t('gen.interruptedTitle'), t('gen.interrupted') + (error ? '\n\n' + error.message : ''));
    else if (blocked) showModal(t('gen.blockedTitle'), t('gen.' + blocked + 'Partial'));
    else if (truncated) showModal(t('gen.truncatedTitle'), t('gen.truncated'));
  } else if (!noteOnMsg && state.conv === conv) showError(noReply);
}

function stop() {
  if (state.generating) state.generating.controller.abort();
}

// ---------------- 剧情备忘 ----------------
// 长剧情里模型会忘掉记忆范围以外的前文：让模型把剧情进展写成备忘，之后每次请求放在这一次的消息前面（memoBlock）。
// 「更新备忘」发出的请求和平时一样（System Prompt、世界观等，记忆长度内的剧情），只是最后一条用户消息换成更新的指令，
// 里面附上现在的备忘；模型返回更新后的完整备忘，覆盖原来的（也可以手动编辑）。不保留上一版。
// 每 N 轮自动更新（每个对话自己设置，默认关闭）：第 N 轮的回复写完后自动发出；更新期间发送按钮变为「停止」，输入框照常可以编辑
const MEMO_EVERY_MAX = 99;

function memoUpdateRequest(conv) {
  const current = (conv.memo || '').trim();
  const instruction = `${t('memo.instruction')}\n\n${t('memo.current')}\n${current || t('memo.none')}\n${t('memo.currentEnd')}`;
  return requestOf(conv, conv.messages.concat([{ role: 'user', versions: [instruction], cur: 0 }]), { memoUpdate: true });
}

// 模型有时会把标签也抄回来：去掉开头、结尾的标签行
function cleanMemo(text) {
  const tags = new Set([t('memo.current'), t('memo.currentEnd'), t('sys.memo'), t('sys.memoEnd')]);
  const lines = text.trim().split('\n');
  while (lines.length && tags.has(lines[0].trim())) lines.shift();
  while (lines.length && tags.has(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').trim();
}

const canUpdateMemo = (conv) => !isAssistant(conv) && conv.messages.length > 0;

// 第 N 轮的回复写完后（这个对话还是当前对话时）自动更新。删掉了消息、轮数比上次更新时少的，从现在的轮数重新算
function maybeAutoMemo(conv) {
  if (conv !== state.conv || !conv.memoEvery || !canUpdateMemo(conv) || state.generating || state.greetingMode) return;
  const rounds = roundsOf(conv);
  if (conv.memoRound > rounds) conv.memoRound = rounds;
  if (rounds - conv.memoRound >= conv.memoEvery) void updateMemo(true);
}

async function updateMemo(auto = false) {
  const conv = state.conv;
  if (state.generating || state.greetingMode || !canUpdateMemo(conv)) return;
  if (expandSource === els.memo) closeExpand();
  await flushConvSave();
  const controller = new AbortController();
  state.generating = { controller, msgId: null, memo: conv.id };
  // 输入框上方的绿框：显示到收到完整的返回为止（换到别的对话也一直显示：发送按钮仍是「停止备忘更新」）
  els.memoBar.textContent = t(auto ? 'memo.autoBar' : 'memo.bar');
  els.memoBar.hidden = false;
  let out = '';
  let result = null;
  let error = null;
  let aborted = false;
  let usage = null;
  let calib = null;
  showError('');
  renderMessages(); // 发送按钮变为「停止」
  renderMemo();
  logConv = conv;
  const cfg = providerCfg();
  try {
    const req = memoUpdateRequest(conv);
    const k = calibKey(cfg);
    const sent = finalMessages(formatOf(cfg), req.messages);
    const est = TokenCalib.estimate(k.relay, k.model, systemBlocks(conv).map((b) => b.text), sent.map((m) => m.content)).total;
    calib = { ...k, x: TokenCalib.requestFeatures(req.system, sent), est };
    result = await streamChat(cfg, req.system, req.messages, {
      signal: controller.signal,
      onUsage: (u) => { usage = u; },
      onText: (text) => {
        out += text;
        state.generating.thinking = false;
        if (state.conv === conv) { els.memo.value = out; els.memo.scrollTop = els.memo.scrollHeight; renderMemoStatus(); }
      },
      onThinking: () => {
        if (out) return;
        state.generating.thinking = true;
        if (state.conv === conv) renderMemoStatus();
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else error = e;
  }
  // 用量照样用来校准估算；不算作这个对话的「上一次请求」（那里说的是剧情回复）
  if (calib && usage && usage.input) TokenCalib.observe(calib.relay, calib.model, calib.x, usage.input, usage.output, null, calib.est);
  state.generating = null;
  els.memoBar.hidden = true;

  const reason = result && result.stopReason;
  const memo = cleanMemo(out);
  let problem = null; // 没有更新的原因（停止的不提示）
  if (error) problem = error.message;
  else if (!aborted && (reason === 'refusal' || reason === 'content_filter')) problem = t('gen.' + (reason === 'refusal' ? 'refused' : 'filtered'));
  else if (!aborted && (reason === 'max_tokens' || reason === 'length')) problem = t('memo.truncated');
  else if (!aborted && (reason === 'error' || !memo)) problem = t('memo.empty');
  const ok = !aborted && !problem;
  if (ok) {
    conv.memo = memo;
    conv.memoRound = roundsOf(conv);
  }
  await saveConv(conv);
  if (state.conv === conv) {
    renderMessages();
    renderMemo();
    updateEstimate();
  }
  if (ok) toast(t('memo.updated'));
  else if (aborted) toast(t('memo.stopped'));
  else showModal(t('memo.failedTitle'), t('memo.failed') + '\n\n' + problem);
}

// 右侧剧情备忘：内容、是否发送、每几轮自动更新、状态
function renderMemo() {
  const conv = state.conv;
  const busy = !!state.generating && state.generating.memo === conv.id;
  if (!busy) els.memo.value = conv.memo || '';
  els.memo.readOnly = busy;
  els.memoSend.checked = conv.memoSend !== false;
  els.memoEvery.value = conv.memoEvery || 0;
  els.btnUpdateMemo.disabled = !!state.generating || !canUpdateMemo(conv);
  els.btnExpandMemo.disabled = busy;
  renderMemoStatus();
}

// 备忘下方的状态：正在更新（模型还在思考时写「思考中」），或者上次更新以后又过了几轮
function renderMemoStatus() {
  const conv = state.conv;
  const g = state.generating;
  if (g && g.memo === conv.id) {
    els.memoStatus.textContent = g.thinking ? t('memo.thinking') : t('memo.updating');
    return;
  }
  const rounds = roundsOf(conv);
  els.memoStatus.textContent = (conv.memo || '').trim() ? t('memo.since', { n: rounds - Math.min(conv.memoRound, rounds) }) : '';
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
  applyArtMode();
}

async function setArt(file) {
  if (state.conv.lock) return toast(t('lock.artLocked'));
  if (!file || !file.type.startsWith('image/')) return toast(t('art.notImage'));
  const conv = state.conv;
  let pick = { mode: 'portrait', fit: {} };
  if (artModesAvailable()) {
    const size = await imageSize(file);
    if (!size) return toast(t('art.notImage'));
    pick = await chooseArtMode(size);
    if (!pick || conv !== state.conv || conv.lock) return;
  }
  await DB.set(artKey(conv.id), file);
  setConvArtMode(conv, pick.mode);
  await saveConv(conv);
  await applyArtFit(pick.fit);
  await loadArt();
  toast(t('art.updated'));
}

async function removeArt() {
  const conv = state.conv;
  if (conv.lock) return;
  await DB.del(artKey(conv.id));
  if (conv.artMode) {
    setConvArtMode(conv, 'portrait');
    await saveConv(conv);
  }
  await loadArt();
}

// ---- 艺术图的展示方式（电脑布局） ----
// 竖屏（默认）：显示在左栏，图片宽度撑满左栏。
// 横屏（conv.artMode = 'landscape'）：铺满整个窗口作背景，聊天区居中、半透明；右侧设置区默认收起，
// 按快捷键（settings.panelKey，默认 F2）显示或收起。手机布局（包括安卓版）里艺术图总是铺满背景，不区分这两种。
// 原则是不拉伸图片：上传时看比例，和窗口（横屏）或左栏（竖屏）差一点时问要不要自动调整，
// 横屏差得多时直接说不支持（硬放的话会裁掉很多或者留很宽的黑边）
const ART_LANDSCAPE_MIN = 1.5;  // 横屏展示要求宽高比至少 3:2：中间被聊天区挡住，太窄的图两侧露不出多少
const ART_PORTRAIT_WIDE = 1.25; // 竖屏展示比这更宽的图：上下黑边很大，提示效果可能不好
const ART_FIT_OK = 0.02;        // 比例相差不到 2%：不用调整
const ART_CROP_MAX = 0.12;      // 横屏：比例相差不超过 12% 时铺满窗口（裁掉一点），更多时完整显示（留黑边）；
                                // 不能自动调整窗口时，相差超过这个就不支持
const ART_RESIZE_MAX = 0.25;    // 自动调整窗口：宽、高最多改变 25%，再多就不调整

const artModesAvailable = () => !NATIVE && !isMobileLayout();
const ratioGap = (a, b) => 1 - Math.min(a, b) / Math.max(a, b);
const isLandscapeArt = () => document.body.classList.contains('art-landscape');

function setConvArtMode(conv, mode) {
  if (mode === 'landscape') conv.artMode = 'landscape';
  else delete conv.artMode;
}

// 图片的原始尺寸 { w, h }；不是能显示的图片时为 null
function imageSize(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (size) => { URL.revokeObjectURL(url); resolve(size); };
    img.onload = () => done(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

// 只有一个按钮的提示（等用户关掉再继续）
const notice = (message) => choose(t('art.modeTitle'), message, [{ label: t('btn.ok'), value: true, primary: true }]);
async function askAdjust(message) {
  return (await choose(t('art.modeTitle'), message, [
    { label: t('art.noAdjust'), value: false, ghost: true },
    { label: t('art.adjust'), value: true, primary: true },
  ])) === true;
}

// 上传后选择展示方式，并检查比例。返回 { mode, fit }，取消时为 null。
// 选了某种方式但这张图不合适（用户放弃）时回到选择
async function chooseArtMode(size) {
  const wide = size.w / size.h >= ART_LANDSCAPE_MIN;
  for (;;) {
    const mode = await choose(t('art.modeTitle'), t('art.modeAsk', { w: size.w, h: size.h, key: state.settings.panelKey }), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('art.modePortrait'), value: 'portrait', primary: !wide },
      { label: t('art.modeLandscape'), value: 'landscape', primary: wide },
    ]);
    if (!mode) return null;
    const fit = await artModeFit(mode, size);
    if (fit) return { mode, fit };
  }
}

// 检查比例：返回要做的调整 { artWidth } / { window: { w, h } } / {}（不用调整），不合适时为 null
const artModeFit = (mode, size) => (mode === 'landscape' ? landscapeFit(size) : portraitFit(size));

// 竖屏时左栏的宽度（现在是横屏时，算的是换成竖屏后的宽度）：和 CSS 的 --art-w 一样
function portraitPaneWidth() {
  const s = state.settings;
  if (s.artWidth) return clamp(s.artWidth, artBounds());
  return Math.min(Math.max(220, window.innerHeight * 2 / 3), window.innerWidth * 0.28);
}

async function portraitFit(size) {
  const a = size.w / size.h;
  if (a > ART_PORTRAIT_WIDE) {
    const go = await choose(t('art.modeTitle'), t('art.portraitWide'), [
      { label: t('art.chooseAgain'), value: false, ghost: true },
      { label: t('art.useAnyway'), value: true, primary: true },
    ]);
    if (go !== true) return null;
  }
  // 左栏宽度改成「窗口高度 × 图片宽高比」，图片正好放满左栏（在左栏能拖到的范围内才调）
  const h = window.innerHeight;
  const target = Math.round(h * a);
  const b = artBounds();
  if (ratioGap(portraitPaneWidth() / h, a) > ART_FIT_OK && target >= b.min && target <= b.max
    && (await askAdjust(t('art.fitPaneAsk')))) return { artWidth: target };
  return {};
}

async function landscapeFit(size) {
  const a = size.w / size.h;
  if (a < ART_LANDSCAPE_MIN) {
    await notice(t('art.landscapeNarrow'));
    return null;
  }
  const gap = ratioGap(window.innerWidth / window.innerHeight, a);
  if (gap <= ART_FIT_OK) return {};
  const win = windowFitFor(a);
  if (win) return (await askAdjust(t('art.fitWindowAsk', { w: win.w, h: win.h }))) ? { window: win } : {};
  if (gap <= ART_CROP_MAX) return {}; // 差得不多：铺满窗口，裁掉一点
  await notice(t(window.proteusDesktop ? 'art.landscapeUnsupported' : 'art.landscapeUnsupportedWeb'));
  return null;
}

// 桌面版：让窗口内容区正好是图片比例的尺寸。保持高度改宽度、保持宽度改高度两种里选改动小的；
// 要放得进屏幕、不小于窗口的最小尺寸，改动不超过 ART_RESIZE_MAX。没有合适的（或不是桌面版）时为 null
function windowFitFor(a) {
  const desk = window.proteusDesktop;
  if (!desk || !desk.fitWindow) return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const fw = Math.max(0, window.outerWidth - W);  // 边框、标题栏
  const fh = Math.max(0, window.outerHeight - H);
  const maxW = window.screen.availWidth - fw;
  const maxH = window.screen.availHeight - fh;
  const minW = 1000 - fw; // 窗口最小 1000 × 600（electron/main.js）
  const minH = 600 - fh;
  return [{ w: Math.round(H * a), h: H }, { w: W, h: Math.round(W / a) }]
    .filter((c) => c.w >= minW && c.w <= maxW && c.h >= minH && c.h <= maxH)
    .map((c) => ({ ...c, change: Math.max(Math.abs(c.w - W) / W, Math.abs(c.h - H) / H) }))
    .filter((c) => c.change <= ART_RESIZE_MAX)
    .sort((x, y) => x.change - y.change)[0] || null;
}

async function applyArtFit(fit) {
  if (fit.artWidth) {
    state.settings.artWidth = fit.artWidth;
    applyLayout();
    saveSettingsSoon();
  }
  if (fit.window && !(await window.proteusDesktop.fitWindow(fit.window.w, fit.window.h))) toast(t('art.fitWindowFailed'));
}

// 按当前对话的艺术图切换布局（横屏：body.art-landscape），并更新右侧艺术图里的展示方式、快捷键
function applyArtMode() {
  const on = !!state.artUrl && state.conv.artMode === 'landscape';
  const was = isLandscapeArt();
  document.body.classList.toggle('art-landscape', on);
  if (on !== was) setPanelShown(false); // 刚换成横屏：右侧设置区先收起
  fitArt();
  renderArtModeFields();
}

// 横屏：比例和窗口差得不多时铺满窗口（裁掉一点），否则完整显示（留黑边）。窗口大小变化时重新判断
function fitArt() {
  const img = els.artImage;
  const a = img.naturalWidth / img.naturalHeight;
  img.classList.toggle('cover', isLandscapeArt() && a > 0 && ratioGap(window.innerWidth / window.innerHeight, a) <= ART_CROP_MAX);
}

function renderArtModeFields() {
  const conv = state.conv;
  const has = !!state.artUrl && !NATIVE;
  els.artModeRow.hidden = !has;
  els.artMode.value = conv.artMode === 'landscape' ? 'landscape' : 'portrait';
  els.artMode.disabled = !!conv.lock;
  els.artKeyRow.hidden = !has || conv.artMode !== 'landscape';
  if (!panelKeyRecording) {
    els.panelKeyLabel.textContent = state.settings.panelKey;
    els.btnPanelKey.textContent = t('art.keyChange');
  }
}

// 右侧艺术图里换展示方式：和上传时一样检查比例，不合适或用户放弃时改回去
async function changeArtMode() {
  const conv = state.conv;
  const mode = els.artMode.value;
  if (conv.lock) return renderArtModeFields();
  const blob = await artBlobOf(conv);
  const size = blob && (await imageSize(blob));
  const fit = size && (await artModeFit(mode, size));
  if (!fit || conv !== state.conv) return renderArtModeFields();
  setConvArtMode(conv, mode);
  await saveConv(conv);
  await applyArtFit(fit);
  applyArtMode();
}

// ---- 横屏时收起 / 显示右侧设置区的快捷键 ----

function setPanelShown(on) {
  document.body.classList.toggle('panel-shown', on);
  // 收起时光标还在设置区里：放回输入框，免得按键打到看不见的地方
  if (!on && els.settingsPane.contains(document.activeElement)) els.input.focus();
}

// 按键的名称：Ctrl+Shift+K、F2 这样；只按了修饰键时为 null
function keyName(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(e.key)) return null;
  let k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+');
}

// 能用的快捷键：F1–F12（单独或加修饰键），或者 Ctrl / Alt / Meta 加一个键。
// 不能用：F5、F11、F12（刷新、全屏、开发者工具）、常用的编辑和窗口快捷键、单独的字母等（打字时会误触）
const RESERVED_KEYS = new Set(['F5', 'F11', 'F12', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z',
  'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+W', 'Ctrl+Shift+I', 'Ctrl+Q', 'Alt+F4', 'Ctrl+F4',
  'Meta+A', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+Z', 'Meta+Shift+Z', 'Meta+R', 'Meta+W', 'Meta+Q', 'Meta+H', 'Meta+M']);
function validPanelKey(name) {
  if (!name || RESERVED_KEYS.has(name)) return false;
  const parts = name.split('+');
  const key = parts.pop();
  if (/^F([1-9]|1[0-2])$/.test(key)) return true;
  if (['Tab', 'Escape', 'Enter', 'Backspace', 'Delete'].includes(key)) return false;
  return parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Meta');
}

// 点「更改」后按下的下一个键就是新的快捷键；Esc 或点别处取消
let panelKeyRecording = null;
function recordPanelKey() {
  if (panelKeyRecording) return panelKeyRecording();
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return done();
    const name = keyName(e);
    if (!name) return;
    if (!validPanelKey(name)) return toast(t('art.keyInvalid', { key: name }));
    state.settings.panelKey = name;
    saveSettingsSoon();
    done();
    toast(t('art.keySet', { key: name }));
  };
  const done = () => {
    document.removeEventListener('keydown', onKey, true);
    els.btnPanelKey.removeEventListener('blur', done);
    els.btnPanelKey.classList.remove('recording');
    panelKeyRecording = null;
    renderArtModeFields();
  };
  panelKeyRecording = done;
  els.btnPanelKey.textContent = t('art.keyPress');
  els.btnPanelKey.classList.add('recording');
  document.addEventListener('keydown', onKey, true);
  els.btnPanelKey.addEventListener('blur', done);
}

function bindArtMode() {
  els.artMode.addEventListener('change', () => void changeArtMode());
  els.btnPanelKey.addEventListener('click', recordPanelKey);
  els.artImage.addEventListener('load', fitArt);
  window.addEventListener('resize', fitArt);
  // 只在软件（页面）有焦点时收到按键。弹窗打开时不响应
  document.addEventListener('keydown', (e) => {
    if (e.repeat || !isLandscapeArt() || isMobileLayout()) return;
    if (keyName(e) !== state.settings.panelKey) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    e.preventDefault();
    setPanelShown(!document.body.classList.contains('panel-shown'));
  });
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
  if (!(await Locker.checkPassword(conv.lock, pw))) return toast(t('lock.wrongPw'));
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

// 备份里的对话：先整体检查，有不合格的就整个不读取
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
  } else if (canEncrypt(conv)) {
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
  if (data.art && conv.artMode) data.artMode = conv.artMode; // 艺术图的展示方式（不是受保护的内容，不加密）
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
  } else if (canEncrypt(conv)) {
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

// 完整备份（全部对话）：所有对话（各自的设定、剧情、艺术图）+ token 校准数据。不含任何软件设置
// （记忆长度、界面语言、布局、模型与接口等都可以随时调整；API Key 也不该出现在备份里）。
// 选择加密时，每个普通对话的 System Prompt、世界观、开场白和艺术图加密，剧情和人设仍是明文；
// 已经锁定的对话始终保持原来的密文和密码（先提醒一下）。全部都是锁定对话时不再问是否加密。
async function backup() {
  const lockedN = state.conversations.filter((c) => c.lock).length;
  if (lockedN && !(await confirmLockedExport(t('export.full'), t('export.lockedAll', { n: lockedN })))) return;
  let password = null;
  // 助理模式和酒馆兼容对话不加密：只有还有未锁定的角色扮演对话时才问
  if (state.conversations.some((c) => !c.lock && canEncrypt(c))) {
    const enc = await askEncrypt(t('export.full'), t('export.fullEncryptMessage'), false);
    if (!enc) return;
    password = enc.password;
  }
  await flushConvSave();
  const conversations = [];
  const arts = {};
  for (const c of state.conversations) {
    // 助理模式和酒馆兼容对话（和它们的艺术图）不加密；已经锁定的保持原来的密文
    const encrypt = !!c.lock || (canEncrypt(c) && password !== null);
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
    conversations,
    tokenCalib: TokenCalib.exportData(new Set(state.conversations.map((c) => c.id))), // token 校准数据，换设备后接着用
    arts,
  };
  download(`${t('export.backupPrefix')}-${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// 日志：最近一次请求模型时实际发送的请求和收到的原始回复，用于排查问题（只记在内存里，不保存）。
// API Key 隐藏；请求来自还没解锁的加密世界卡时，受保护的设定也隐藏
let logConv = null;

// 锁定的对话：把一段文字里受保护的设定换成“受保护的内容”（日志、下一轮预览里用）。
// 发出去的内容里 {{user}} {{char}} 已经换成了它们的值，换之前和换之后的都要隐藏
function hideProtected(text, conv) {
  if (!conv.lock || !text) return text;
  const secrets = [...new Set([conv.systemPrompt, conv.worldText, conv.npcText, conv.postHistory, ...conv.greetings]
    .filter((v) => v && v.trim()).flatMap((v) => [v, v.trim()]).flatMap((v) => [v, withMacros(v, conv)]))]
    .sort((a, b) => b.length - a.length);
  return secrets.reduce((out, sec) => out.split(sec).join(t('lock.protected')), text);
}

function exportLog() {
  const x = lastExchange;
  if (!x) return toast(t('export.noLog'));
  const headers = { ...x.request.headers };
  if (headers['x-api-key']) headers['x-api-key'] = '***';
  if (headers.authorization) headers.authorization = 'Bearer ***';
  let body = x.request.body;
  if (logConv && logConv.lock) body = JSON.parse(JSON.stringify(body, (k, v) => (typeof v === 'string' ? hideProtected(v, logConv) : v)));
  const out = [
    `Proteus log · ${x.time.toLocaleString()}`,
    '',
    '===== REQUEST =====',
    `${x.request.method} ${x.request.url}`,
    // 安卓版改用原生请求发出时注明（不受跨域限制，回复一次性返回）
    ...(x.request.via === 'native' ? ['(sent by the Android app\'s native HTTP client)'] : []),
    // 带 stream_options 的第一次请求被拒绝、去掉它重发过时注明第一次的回复
    ...(x.request.retry ? [`(first sent with stream_options and got HTTP ${x.request.retry.status}; resent without it)`, x.request.retry.text] : []),
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
// 读取的结果是酒馆兼容对话（conv.tavern）。世界书放进「世界观」，角色设定放进「NPC角色」。规则：
//   - 当前不是酒馆兼容对话，或者是锁定的、已经开始聊天（发出过消息）的酒馆兼容对话：新建一个对话
//   - 当前是还没开始聊天的酒馆兼容对话：
//       世界书：当前还没有世界书就加进来；已经有了就新建对话（两个世界观不能放在同一个对话里）
//       角色卡：当前还没有角色就加进来（自带世界书、而当前已经有世界书的卡除外，它新建对话）；
//               已经有角色时 Proteus 不支持群聊，问是否新建对话
//     加进来时覆盖对应的那一栏；那一栏里有你自己写的内容时先问
// {{char}} 和 {{user}} 保留在内容里，显示和发送时再换成角色卡的名字和 {{user}} 的值

const baseName = (filename) => String(filename || '').replace(/\.[^.]*$/, '');

// 角色卡的字段拼成「NPC角色」的内容：角色名作标题，下面是描述、性格、场景、对话示例，各有一个小标题（跟随界面语言）
function charSection(name, card) {
  const parts = [
    ['st.description', card.description],
    ['st.personality', card.personality],
    ['st.scenario', card.scenario],
    ['st.examples', card.mes_example],
  ].map(([k, v]) => [k, STCard.importMacros(v).trim()]).filter(([, v]) => v).map(([k, v]) => `### ${t(k)}\n${v}`);
  return parts.length ? `## ${t('st.character', { name })}\n\n${parts.join('\n\n')}` : '';
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
    npc: charSection(name, card),
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

// 用角色卡新建一个酒馆兼容对话
async function createCardConv(x) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const c = newConversation();
  const defaultPrompt = t('defaultSystemPrompt');
  c.title = x.name;
  c.tavern = { char: x.name, book: x.bookName };
  // 卡的 System Prompt：空的用默认值；{{original}} 换成默认值（作者在默认值的基础上追加内容）
  c.systemPrompt = x.systemPrompt ? STCard.replaceOriginal(x.systemPrompt, defaultPrompt).trim() : defaultPrompt;
  c.worldText = x.bookText;
  c.npcText = x.npc;
  c.charName = x.name;
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
  if (x.entries.length) message += '\n\n' + t('restore.stBookNote', { n: x.entries.length, tokens: tokensOf(x.bookText).toLocaleString() });
  if (reason) message = t(reason) + '\n\n' + message;
  if (!(await ask(message + '\n\n' + t('restore.continue')))) return;
  await createCardConv(x);
}

// 用世界书新建一个酒馆兼容对话
async function importBookAsNew(b, reason) {
  let message = t('restore.stBookConfirm', { name: b.name, n: b.n, tokens: tokensOf(b.text).toLocaleString() });
  if (reason) message = t(reason) + '\n\n' + message;
  if (!(await ask(message))) return;
  if (state.generating) return toast(t('conv.stopFirst'));
  const c = newConversation();
  c.title = b.name;
  c.worldText = b.text;
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

// 要覆盖的那一栏里已经有内容（你自己写的）：先问，取消就不读取了。可以继续返回 true
async function confirmReplaceBlock(text, messageKey) {
  if (!text.trim()) return true;
  return (await choose(t('restore.stConflictTitle'), t(messageKey), [
    { label: t('btn.cancel'), value: null, ghost: true },
    { label: t('restore.overwrite'), value: 'yes', primary: true },
  ])) === 'yes';
}

// 世界书加入当前对话：放进「世界观」
async function mergeBook(conv, b) {
  if (!(await ask(t('restore.stBookMerge', { name: b.name, n: b.n, tokens: tokensOf(b.text).toLocaleString() })))) return;
  if (!canMergeInto(conv) || conv.tavern.book != null) return;
  if (!(await confirmReplaceBlock(conv.worldText, 'restore.stReplaceWorld'))) return;
  if (!canMergeInto(conv) || conv.tavern.book != null) return;
  conv.worldText = b.text;
  conv.tavern.book = b.name;
  await refreshAfterMerge(conv);
  toast(t('restore.stBookMergeDone'));
}

// 角色卡加入当前对话：角色设定放进「NPC角色」，开场白加进开场白的版本；
// 卡里的 System Prompt、重点指令和你改过的内容冲突时，问是否覆盖
async function mergeCard(conv, x) {
  const hasArt = !!(await DB.get(artKey(conv.id)));
  const art = x.art && !hasArt;
  if (!(await ask(t('restore.stCardMerge', { name: x.name, greetings: x.greetings.length, art: art ? t('restore.stCardArt') : '' })
    + '\n\n' + t('restore.continue')))) return;
  if (!canMergeInto(conv) || conv.tavern.char != null) return;
  // 「NPC角色」（包括 {{char}} 的值）里已经有你自己写的内容：先问
  if (!(await confirmReplaceBlock(conv.npcText + conv.charName, 'restore.stReplaceNpc'))) return;
  // 卡自带世界书（只有当前对话还没有世界书时才会走到这里）：一起放进「世界观」
  const withBook = x.bookName != null && conv.tavern.book == null;
  if (withBook && !(await confirmReplaceBlock(conv.worldText, 'restore.stReplaceWorld'))) return;

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
  conv.npcText = x.npc;
  conv.charName = x.name;
  conv.tavern.char = x.name;
  if (withBook) {
    conv.worldText = x.bookText;
    conv.tavern.book = x.bookName;
  }
  if (x.greetings.length) {
    if (!conv.greetings.length) conv.greetingSend = true;
    conv.greetingCur = conv.greetings.length;
    conv.greetings = conv.greetings.concat(x.greetings);
    syncGreeting(conv);
  }
  if (art) {
    await DB.set(artKey(conv.id), x.art);
    setConvArtMode(conv, 'portrait');
  }
  await refreshAfterMerge(conv);
  toast(t('restore.stCardMergeDone'));
  showCreatorNotes(x, conv);
}

async function importST(st, artBlob, filename) {
  const cur = state.conv;
  const tavern = isTavern(cur) && !cur.lock; // 现在酒馆兼容对话不能加密；以前的测试版导出的加密文件读进来仍是锁定的
  const started = tavern && cur.messages.length > 0; // 发出过消息：读取的设定可能和已有的剧情冲突
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
    // 已经有角色了：不支持群聊，问是否新建对话（需要世界书的话，在新对话里再读取）
    const go = await choose(t('restore.stGroupTitle'), t('restore.stGroupChat', { char: cur.tavern.char, name: x.name }), [
      { label: t('btn.cancel'), value: null, ghost: true },
      { label: t('restore.stNewConv'), value: 'new', primary: true },
    ]);
    if (!go || cur !== state.conv) return;
    return createCardConv(x);
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
  // GitHub 同步仓库里的 settings.json（LLM 设置）和 calibration.json（token 校准数据），见 js/sync.js
  if (await restoreSyncFile(data)) return;

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
    c.npcText = typeof fields.npcText === 'string' ? fields.npcText : '';
    c.charName = typeof fields.charName === 'string' ? fields.charName : '';
    c.postHistory = typeof fields.postHistory === 'string' ? fields.postHistory : '';
    c.persona = '';
    c.userName = '';
    c.greeting = typeof fields.greeting === 'string' ? fields.greeting : null;
    c.greetings = fields.greetings;
    c.greetingCur = data.greetingCur;
    c.greetingSend = fields.greetingSend !== false;
    normalizeGreetings(c);
    if (data.tavern) { c.tavern = data.tavern; normalizeTavern(c); }
    if (data.artMode === 'landscape' && validArt(data.art)) c.artMode = 'landscape';
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
  if (!(await ask(t('restore.fullConfirm', { n: data.conversations.length })))) return;
  if (state.generating) return toast(t('conv.stopFirst'));
  // 备份里的对话全部加到现有对话里（现有的不动；和现有的相同也照样加，重复的由用户自己删）。
  // 软件设置不动：以前的版本做的备份里带着设置的，也不用。
  // 读完后仍停在读取前的对话里。先把还没写入的改动存好
  await flushConvSave();
  const arts = data.arts && typeof data.arts === 'object' ? data.arts : {};
  const existing = new Map(state.conversations.map((c) => [c.id, c]));
  const idMap = {}; // 和现有对话 id 相同的（例如同一份备份读了两次）：换一个新的 id 加进来
  let added = 0;
  try {
    for (const c of data.conversations) {
      try { await openLock(c); } catch (_) { continue; } // 解不开的锁定对话跳过
      normalizeConv(c);
      const oldId = c.id;
      if (existing.has(oldId)) {
        c.id = uid();
        idMap[oldId] = c.id;
      }
      existing.set(c.id, c);
      await DB.putConversation(storable(c));
      await importArt(c.id, arts[oldId]);
      added++;
    }
    // 读完后重新载入时打开的还是现在这个对话
    state.settings.activeConvId = state.conv.id;
    await DB.set('settings', storableSettings());
    // token 校准数据和本机的合并（换了 id 的对话，“上一次请求”跟着换）
    TokenCalib.importData(data.tokenCalib, idMap);
  } catch (e) {
    console.error(e);
    await boot();
    showError(t('restore.failed', { msg: e.message }));
    return;
  }
  await boot();
  toast(t('restore.fullDone', { added }));
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

// 安卓返回键：先关掉打开着的弹窗或设置面板，都没有时才退出。
// 退出要连按两次：第一次在屏幕中间提示「再按一次退出海神」，提示显示期间（EXIT_HINT_MS）再按一次才退出
const EXIT_HINT_MS = 2000;
let exitHintAt = 0;
let exitHintTimer = null;

function showExitHint() {
  exitHintAt = Date.now();
  els.exitHint.textContent = t('app.backAgainToExit');
  els.exitHint.classList.add('show');
  clearTimeout(exitHintTimer);
  exitHintTimer = setTimeout(() => { els.exitHint.classList.remove('show'); exitHintAt = 0; }, EXIT_HINT_MS);
}

function bindBackButton() {
  if (!NATIVE) return;
  nativePlugin('App').addListener('backButton', () => {
    // 正在下载或安装更新（软件锁定，见 update.js 的 lockApp）：返回键什么都不做
    if (!els.updateProgress.hidden) return;
    // 更新提示（以及下载失败、手动中止的提示）盖在所有东西上面，而且必须选一个按钮：
    // 返回键只收起它里面的 ▾ 菜单（由它自己的 Esc 处理），不关掉窗口
    if (!els.updateDialog.hidden) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    // 添加服务商的窗口：返回键不关闭（和 Esc 一样，免得丢掉填好的内容），只能点「取消」
    if (!els.relayDialog.hidden) return;
    for (const id of ['pwDialog', 'textDialog', 'dialog']) {
      if (!els[id].hidden) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        els[id].hidden = true;
        return;
      }
    }
    // GitHub 同步的窗口：返回键不关闭（和 Esc 一样），只能点里面的按钮
    if (!els.syncDialog.hidden) return;
    if (!els.convCtxMenu.hidden) return closeConvCtxMenu();
    if (!els.allConvBox.hidden && allSel.size) { allSel.clear(); return showConvSelection(); } // 先取消勾选，再按一次关闭窗口
    if (!els.allConvBox.hidden) return closeAllConvs();
    // 信息弹窗直接关掉：它没有自己的 Escape 处理，派发 Escape 会连设置面板一起关掉
    if (!els.modal.hidden) { els.modal.hidden = true; return; }
    if (!els.modelListBox.hidden) return closeModelList();
    if (expandSource) return closeExpand();
    if (!els.previewBox.hidden) return closePreview();
    if (document.body.classList.contains('settings-open')) return closeSettings();
    if (state.editingId) return cancelEdit();
    if (state.greetingMode) return exitGreetingMode();
    if (exitHintAt && Date.now() - exitHintAt < EXIT_HINT_MS) return nativePlugin('App').exitApp();
    showExitHint();
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
  // 助理模式：右栏不显示世界观、NPC角色、用户人设和重点指令
  els.settingsPane.classList.toggle('assistant', assistant);
  renderSyncConv(); // 艺术图下面的「此对话的艺术图同步到 GitHub 仓库」
  els.systemPrompt.value = locked ? '' : c.systemPrompt;
  els.worldText.value = locked ? '' : c.worldText;
  els.npcText.value = locked ? '' : c.npcText;
  els.charName.value = locked ? '' : c.charName;
  els.persona.value = c.persona;
  els.userName.value = c.userName;
  els.postHistory.value = locked ? '' : c.postHistory;
  renderMemo();
  // 助理模式：世界观、用户人设、{{user}} 的值和重点指令空白、不能编辑（不是受保护，是这个模式不用）；艺术图照常可用
  els.worldText.disabled = assistant;
  els.npcText.disabled = assistant;
  els.charName.disabled = assistant;
  els.btnExpandNpc.disabled = assistant;
  els.persona.disabled = assistant;
  els.userName.disabled = assistant;
  els.postHistory.disabled = assistant;
  els.worldText.placeholder = t(assistant ? 'assistant.worldUnused' : 'set.worldPlaceholder');
  els.npcText.placeholder = t(assistant ? 'assistant.npcUnused' : 'set.npcPlaceholder');
  els.charName.placeholder = t(assistant ? 'assistant.charNameUnused' : 'set.charNamePlaceholder');
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
  sizeRoundsInput();
  els.provider.value = s.provider;
  els.effort.value = s.effort;
  els.openrouterSort.value = s.openrouterSort || '';
  els.openrouterNoData.checked = !!s.openrouterNoData;
  els.useTemperature.checked = s.useTemperature;
  els.temperature.value = s.temperature;
  els.langSelect.value = LANG;
  els.rememberKeys.checked = s.rememberKeys !== false;
  fillProviderFields();
}

// 服务商下拉框：三家官方、用户添加的服务商（显示它的名称），最后是「＋ 添加服务商…」
const ADD_RELAY = '__add__';
function fillProviderSelect() {
  const opt = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  els.provider.innerHTML = Object.keys(PROVIDERS).map((k) => opt(k, t('provider.' + k))).join('')
    + state.settings.relays.map((r) => opt(RELAY_PREFIX + r.id, r.name)).join('')
    + opt(ADD_RELAY, t('relay.addOption'));
  els.provider.value = state.settings.provider;
}

// 当前选的是用户添加的服务商时，返回它（{ id, name, format }），否则为 null
function currentRelay() {
  const p = state.settings.provider;
  return p.startsWith(RELAY_PREFIX) ? state.settings.relays.find((r) => RELAY_PREFIX + r.id === p) || null : null;
}

function fillProviderFields() {
  const s = state.settings;
  const p = providerOf(s.provider);
  const relay = currentRelay();
  els.provider.value = s.provider;
  els.relayOptions.hidden = !relay;
  els.relayDeleteRow.hidden = !relay;
  if (relay) {
    if (document.activeElement !== els.relayEditName) els.relayEditName.value = relay.name;
    els.relayEditFormat.value = relay.format;
  }
  // 内置服务商的地址固定：只显示，不能改；用户添加的服务商才能填
  const builtin = isBuiltinProvider(s.provider);
  els.baseUrl.readOnly = builtin;
  els.baseUrl.placeholder = builtin ? '' : t('set.baseUrlExample');
  if (!builtin) els.baseUrl.value = s.baseUrls[s.provider] || '';
  const note = PROVIDER_NOTES[s.provider];
  els.providerNote.hidden = !note;
  if (note) els.providerNote.textContent = t(note);
  // Vertex 没有 API Key：换成导入服务账号 JSON 的按钮
  const google = p.auth === 'google';
  els.apiKeyField.hidden = google;
  els.vertexKeyField.hidden = !google;
  if (google) renderVertexKey();
  else els.apiKey.value = s.apiKeys[s.provider] || '';
  els.model.value = s.models[s.provider] || '';
  els.maxTokens.value = s.maxTokens[s.provider] || '';
  closeModelMenu();
  updateFetchButton();
  els.temperature.disabled = !s.useTemperature;
  updateFormatFields();
}

// 内置服务商的说明（地址下面一行）
const PROVIDER_NOTES = { vertex: 'set.note.vertex', openrouter: 'set.note.openrouter', opencode: 'set.note.opencode', commandcode: 'set.note.commandcode' };

// 跟着模型变化的部分：Command Code、Vertex 按模型名（是不是 Claude）切换格式和地址，
// 所以显示的地址、最大输出长度的提示、思考深度 / temperature 选项在改模型时也要更新
function updateFormatFields() {
  const cfg = providerCfg();
  const format = formatOf(cfg);
  if (isBuiltinProvider(cfg.provider)) els.baseUrl.value = baseOf(cfg);
  els.maxTokens.placeholder = t(format === 'anthropic' ? 'set.maxTokensAnthropic' : 'set.maxTokensOpenai');
  // 思考深度：Anthropic 格式，以及 OpenRouter（统一的 reasoning.effort）
  els.anthropicOptions.hidden = format !== 'anthropic' && cfg.provider !== 'openrouter';
  els.openaiOptions.hidden = format !== 'openai';
  els.openrouterOptions.hidden = cfg.provider !== 'openrouter';
}

// Vertex：导入的服务账号
function renderVertexKey() {
  const sa = parseServiceAccount(state.settings.apiKeys.vertex || '');
  els.vertexKeyStatus.textContent = sa ? t('set.vertexStatus', { email: sa.client_email, project: sa.project_id }) : t('set.vertexNone');
  els.btnImportVertex.textContent = t(sa ? 'set.vertexReimport' : 'set.vertexImport');
}

async function importVertexKey(file) {
  let text = '';
  try { text = await file.text(); } catch (_) { /* 下面报错 */ }
  const sa = parseServiceAccount(text);
  if (!sa) return showModal(t('set.vertexKey'), t('set.vertexInvalid'));
  state.settings.apiKeys.vertex = JSON.stringify(sa);
  saveSettingsSoon();
  renderVertexKey();
  updateFormatFields();
  updateEstimate();
  toast(t('set.vertexImported', { email: sa.client_email }));
}

// ---- 用户添加的服务商 ----

// 读取设置时：只留认得出的条目；以前的「其他 OpenAI / Anthropic 兼容格式」填过地址或 Key 的，各变成一个用户添加的服务商。
// 迁移了以前的设置时返回 true（要马上保存，否则下次打开又迁移一次）
function migrateRelays(s) {
  let migrated = false;
  const seen = new Set();
  s.relays = (Array.isArray(s.relays) ? s.relays : []).filter((r) => r && typeof r.id === 'string' && r.id && !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({ id: r.id, name: String(r.name || '').trim() || hostName(s.baseUrls[RELAY_PREFIX + r.id]) || t('relay.unnamed'), format: r.format === 'anthropic' ? 'anthropic' : 'openai' }));
  for (const [old, format] of [['custom_openai', 'openai'], ['custom_anthropic', 'anthropic']]) {
    const used = (s.baseUrls[old] || '').trim() || (s.apiKeys[old] || '').trim();
    const key = used ? RELAY_PREFIX + uid() : null;
    if (key) {
      const id = key.slice(RELAY_PREFIX.length);
      s.relays.push({ id, name: uniqueRelayName(hostName(s.baseUrls[old]) || t('relay.formatShort.' + format), s), format });
    }
    for (const k of ['apiKeys', 'baseUrls', 'models', 'maxTokens']) {
      if (key && s[k][old] !== undefined) s[k][key] = s[k][old];
      delete s[k][old];
    }
    if (s.provider === old) s.provider = key || 'anthropic';
    if (key) migrated = true;
  }
  // 内置服务商的地址现在固定、不能改。以前给三家官方服务商改过地址的（多半是填了中转站），
  // 那一套设置（地址、Key、模型等）搬成一个用户添加的服务商，免得升级后连不上
  for (const k of ['anthropic', 'openai', 'gemini']) {
    const url = trimSlash(s.baseUrls[k] || '');
    if (url && url !== PROVIDERS[k].baseUrl) {
      const id = uid();
      const key = RELAY_PREFIX + id;
      s.relays.push({ id, name: uniqueRelayName(hostName(url) || t('relay.formatShort.' + PROVIDERS[k].format), s), format: PROVIDERS[k].format });
      s.baseUrls[key] = url;
      for (const f of ['apiKeys', 'models', 'maxTokens']) {
        if (s[f][k] !== undefined) { s[f][key] = s[f][k]; delete s[f][k]; }
      }
      if (s.provider === k) s.provider = key;
      migrated = true;
    }
  }
  for (const k of Object.keys(PROVIDERS)) delete s.baseUrls[k];
  // OpenRouter 现在是内置服务商：以前按地址添加的 OpenRouter（https://openrouter.ai/api/v1），内置的还没填 Key 时，
  // 把 Key、模型等搬过去，删掉那个自己添加的（选着它的改选内置的）。内置的已经有 Key 时两个都留着
  const orRelay = s.relays.find((r) => trimSlash(s.baseUrls[RELAY_PREFIX + r.id] || '') === PROVIDERS.openrouter.baseUrl);
  if (orRelay && !(s.apiKeys.openrouter || '').trim()) {
    const key = RELAY_PREFIX + orRelay.id;
    for (const f of ['apiKeys', 'models', 'maxTokens']) {
      if (s[f][key] !== undefined) s[f].openrouter = s[f][key];
    }
    for (const f of ['apiKeys', 'baseUrls', 'models', 'maxTokens']) delete s[f][key];
    s.relays = s.relays.filter((r) => r !== orRelay);
    if (s.provider === key) s.provider = 'openrouter';
    migrated = true;
  }
  return migrated;
}

// 接口地址的域名（认不出时为 ''）：迁移以前的设置时用作名称
function hostName(url) {
  try { return new URL((url || '').trim()).hostname; } catch (_) { return ''; }
}

// 和已有的名称重复时加上 (2)、(3)……（只在迁移时用；添加窗口里重名直接提示）
function uniqueRelayName(name, s = state.settings) {
  const taken = (n) => s.relays.some((r) => r.name === n) || Object.keys(PROVIDERS).some((k) => t('provider.' + k) === n);
  if (!taken(name)) return name;
  let i = 2;
  while (taken(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function removeRelay(relay) {
  const s = state.settings;
  const key = RELAY_PREFIX + relay.id;
  s.relays = s.relays.filter((r) => r !== relay);
  for (const k of ['apiKeys', 'baseUrls', 'models', 'maxTokens']) delete s[k][key];
  delete state.modelLists[key];
  if (s.provider === key) s.provider = 'anthropic';
  setCustomProviders(s.relays);
  fillProviderSelect();
  fillProviderFields();
  saveSettingsSoon();
  updateEstimate();
  toast(t('relay.deleted', { name: relay.name }));
}

// 「添加服务商」窗口。relayDraft 是窗口打开期间的状态：models 是获取到的模型列表，info 是同时得到的附加信息（保存后本次打开期间
// 在设置区的「完整列表」里看，这个窗口里只有简单的下拉框），fetching 是正在获取的那一次（关掉窗口后作废）
let relayDraft = null;

function openRelayDialog() {
  relayDraft = { models: null, info: null, fetching: null };
  els.relayName.value = '';
  els.relayFormat.value = '';
  els.relayUrl.value = '';
  els.relayKey.value = '';
  els.relayKey.type = 'password';
  els.btnRelayToggleKey.textContent = t('set.show');
  els.relayRemember.checked = state.settings.rememberKeys !== false;
  fillRelayModels();
  setRelayStatus('');
  updateRelaySave();
  els.relayDialog.hidden = false;
  els.relayName.focus();
}

function closeRelayDialog() {
  els.relayDialog.hidden = true;
  relayDraft = null;
}

// 模型：和设置区一样的输入框 + 下拉列表（空着 = 暂不选择）。只有简单的列表，不能打开「完整列表」
let relayModelCombo = null;
function fillRelayModels() {
  els.relayModel.value = '';
  relayModelCombo.close();
}

function setRelayStatus(text, error = false) {
  els.relayStatus.textContent = text;
  els.relayStatus.classList.toggle('error', error);
}

// 填了名称、选了兼容模式、填了接口地址才能保存
function updateRelaySave() {
  els.relaySave.disabled = !els.relayName.value.trim() || !els.relayFormat.value || !els.relayUrl.value.trim();
  els.btnRelayFetch.disabled = !els.relayFormat.value || !els.relayUrl.value.trim() || !!(relayDraft && relayDraft.fetching);
}

async function fetchRelayModels() {
  const draft = relayDraft;
  if (!draft || draft.fetching) return;
  const cfg = { provider: '', format: els.relayFormat.value, baseUrl: els.relayUrl.value.trim(), apiKey: els.relayKey.value.trim() };
  const run = {};
  draft.fetching = run;
  updateRelaySave();
  setRelayStatus(t('relay.fetching'));
  try {
    const { models: list, info } = await fetchModels(cfg);
    if (relayDraft !== draft || draft.fetching !== run) return;
    draft.models = list;
    draft.info = info;
    setRelayStatus(t(list.length ? 'relay.fetched' : 'relay.fetchedNone', { n: list.length }));
  } catch (e) {
    if (relayDraft !== draft || draft.fetching !== run) return;
    setRelayStatus(t('relay.fetchFailed', { error: e.message }), true);
  } finally {
    if (relayDraft === draft && draft.fetching === run) draft.fetching = null;
    if (relayDraft === draft) updateRelaySave();
  }
}

async function saveRelayDialog() {
  const s = state.settings;
  const name = els.relayName.value.trim();
  const format = els.relayFormat.value;
  const url = els.relayUrl.value.trim();
  if (!name || !format || !url) return;
  const taken = s.relays.some((r) => r.name === name) || Object.keys(PROVIDERS).some((k) => t('provider.' + k) === name);
  if (taken) {
    setRelayStatus(t('relay.nameTaken', { name }), true);
    return els.relayName.focus();
  }
  const id = uid();
  const key = RELAY_PREFIX + id;
  s.relays.push({ id, name, format: format === 'anthropic' ? 'anthropic' : 'openai' });
  s.baseUrls[key] = url;
  s.apiKeys[key] = els.relayKey.value.trim();
  if (els.relayModel.value.trim()) s.models[key] = els.relayModel.value.trim();
  if (relayDraft && relayDraft.models) storeModelList(key, relayDraft.models, relayDraft.info); // 设置区的按钮直接是「完整列表」
  if (format === 'anthropic') s.maxTokens[key] = 16000;
  s.provider = key;
  s.rememberKeys = els.relayRemember.checked;
  closeRelayDialog();
  setCustomProviders(s.relays);
  fillProviderSelect();
  fillSettingsForm();
  clearTimeout(saveTimer);
  await DB.set('settings', storableSettings());
  updateEstimate();
  toast(t('relay.saved', { name }));
}

function bindRelayDialog() {
  for (const el of [els.relayName, els.relayUrl]) el.addEventListener('input', () => { setRelayStatus(''); updateRelaySave(); });
  els.relayFormat.addEventListener('change', updateRelaySave);
  // 改了地址、Key 或兼容模式后，之前获取的列表不一定还对，但仍然留着可选（用户自己知道）；重新获取会替换它
  els.btnRelayToggleKey.addEventListener('click', () => {
    const show = els.relayKey.type === 'password';
    els.relayKey.type = show ? 'text' : 'password';
    els.btnRelayToggleKey.textContent = t(show ? 'set.hide' : 'set.show');
  });
  els.btnRelayFetch.addEventListener('click', () => void fetchRelayModels());
  relayModelCombo = modelCombo({
    input: els.relayModel,
    toggle: els.btnRelayModelMenu,
    menu: els.relayModelMenu,
    options: () => (relayDraft && relayDraft.models ? chatModelList(relayDraft.models) : null),
    hint: () => t('set.needModelList'),
    onPick: () => {},
  });
  els.relayCancel.addEventListener('click', closeRelayDialog);
  els.relaySave.addEventListener('click', () => void saveRelayDialog());
  // 不能用 Esc 关闭：拦下来，免得关掉窗口后面的设置面板、列表等。Enter 也不当作保存（容易误按）
  document.addEventListener('keydown', (e) => {
    if (els.relayDialog.hidden || e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    relayModelCombo.close(); // 模型列表开着时只收起它
  }, true);
}

// ---- 模型下拉列表 ----
// 浏览器自带的输入建议（datalist）会按输入框里已有的文字过滤，样式也改不了，所以自己画一个。
// 设置区和「添加服务商」窗口各有一个，都是输入框 + ▾ + 列表（modelCombo）：可以直接输入模型名，输入时列表按文字筛选
// （包含这段文字，不分大小写），也可以点 ▾ 看全部。还没获取列表时点 ▾（或按 ↓）只显示一条提示，不能选；边输入边筛选时不显示。
// opts：input、toggle、menu 三个元素；options() 可选的模型（null = 还没获取列表）；onPick(m) 选中后；
// hint() 没有列表时的提示文字

function modelCombo({ input, toggle, menu, options, onPick, hint }) {
  const st = { items: [], active: -1 };

  function close() {
    menu.hidden = true;
  }

  function highlight(i, scroll) {
    st.active = i;
    const els = menu.querySelectorAll('.combo-item');
    els.forEach((el, j) => el.classList.toggle('active', j === i));
    if (els[i] && scroll) els[i].scrollIntoView({ block: 'nearest' });
  }

  function pick(m) {
    input.value = m;
    close();
    onPick(m);
  }

  // filter 为空时显示全部；否则只显示包含这段文字的
  function open(filter) {
    const f = (filter || '').trim().toLowerCase();
    const current = input.value.trim();
    const all = options();
    menu.innerHTML = '';
    if (!all) {
      st.items = [];
      st.active = -1;
      if (f) return close();
      const item = document.createElement('div');
      item.className = 'combo-item combo-hint';
      item.textContent = hint();
      item.addEventListener('mousedown', (e) => e.preventDefault());
      menu.appendChild(item);
      menu.hidden = false;
      return;
    }
    st.items = all.filter((m) => !f || m.toLowerCase().includes(f));
    // 没有匹配的：不打开（输入的名字照样可以用）
    if (!st.items.length) return close();
    st.items.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'combo-item' + (m === current ? ' current' : '');
      item.textContent = m;
      item.title = m;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); pick(m); });
      item.addEventListener('mousemove', () => highlight(i, false));
      menu.appendChild(item);
    });
    menu.hidden = false;
    highlight(st.items.indexOf(current), true);
  }

  toggle.addEventListener('mousedown', (e) => e.preventDefault()); // 不让输入框失去焦点
  toggle.addEventListener('click', () => {
    if (menu.hidden) { open(''); input.focus(); } else close();
  });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('blur', close);
  // 列表不是从输入框打开的（例如点「获取列表」后自动展开）时输入框没有焦点，不会触发 blur：
  // 点在列表、输入框和 ▾ 以外的任何地方都收起
  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden) return;
    if ([menu, input, toggle].some((el) => el.contains(e.target))) return;
    close();
  }, true);
  input.addEventListener('keydown', (e) => {
    const n = st.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) return open('');
      if (!n) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      highlight((st.active + d + n) % n, true);
    } else if (e.key === 'Enter' && !menu.hidden && st.active >= 0) {
      e.preventDefault();
      pick(st.items[st.active]);
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation(); // 只收起列表，不顺带关闭设置面板
      close();
    }
  });
  return { open, close };
}

// 设置区的模型：可选的只有本次打开期间点「获取列表」从接口拿到的。没有预设的列表：预设的名字不一定能用，容易误解成都可以用
function modelOptions() {
  const l = state.modelLists[state.settings.provider];
  return l ? chatModelList(l.models) : [];
}

let settingsModelCombo = null;
const openModelMenu = (filter) => settingsModelCombo.open(filter);
const closeModelMenu = () => { if (settingsModelCombo) settingsModelCombo.close(); };

function bindModelMenu() {
  settingsModelCombo = modelCombo({
    input: els.model,
    toggle: els.btnModelMenu,
    menu: els.modelMenu,
    options: () => (hasModelList() ? modelOptions() : null),
    hint: () => t('set.needModelList'),
    onPick: (m) => {
      state.settings.models[state.settings.provider] = m;
      updateFormatFields();
      saveSettingsSoon();
      updateEstimate();
    },
  });
}

// 「完整列表」里点一行：和在下拉列表里选一样
function pickModel(m) {
  els.model.value = m;
  state.settings.models[state.settings.provider] = m;
  updateFormatFields();
  saveSettingsSoon();
  updateEstimate();
  closeModelMenu();
}

// ---- 完整模型列表 ----
// 本次打开期间获取过模型列表后（在设置区，或者添加服务商的时候），设置区的「获取列表」变成「完整列表」，打开这个窗口：
// 列出所有对话模型和服务商给的费用、状态、标签（大多数服务商只给名称，没有的显示 —）。
// 点表头排序：第一次升序，再点一次降序。名称用和下拉列表一样的排序规则（compareModels），费用按数值，没有价格的总在最后；
// 名称、标签各有一个筛选框：逗号（中英文都可以）隔开几个条件，要同时满足；文字 = 包含它，!文字 = 不包含它，不分大小写。
// 点一行选用这个模型。重新获取列表也在这里。「添加服务商」窗口里的模型下拉框不进这个窗口

const modelList = { sort: 'name', desc: false, fetching: null };

const hasModelList = () => !!state.modelLists[state.settings.provider];

// 记下获取到的列表和附加信息（只在本次打开期间）
function storeModelList(provider, models, info) {
  state.modelLists[provider] = { models, info: info || {} };
}

// 改的是 data-i18n：切换界面语言时按现在的状态重新翻译
function updateFetchButton() {
  const b = els.btnFetchModels;
  const full = hasModelList();
  b.dataset.i18n = full ? 'set.fullList' : 'set.fetchModels';
  b.dataset.i18nTitle = full ? 'set.fullListTitle' : 'set.fetchModelsTitle';
  b.textContent = t(b.dataset.i18n);
  b.title = t(b.dataset.i18nTitle);
}

function openModelList() {
  closeModelMenu();
  renderModelList();
  els.modelListBox.hidden = false;
  const cur = els.modelTable.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
  // 触屏上不放焦点（会弹出键盘盖住列表）
  if (!window.matchMedia('(hover: none)').matches) els.modelFilterName.focus({ preventScroll: true });
}

function closeModelList() {
  els.modelListBox.hidden = true;
}

// 筛选条件：[{ not, v }]，都是小写。「gemini, !flash」= 包含 gemini 而且不包含 flash
function parseModelFilter(text) {
  return text.toLowerCase().split(/[,，]/)
    .map((w) => w.trim())
    .map((w) => (w[0] === '!' || w[0] === '！' ? { not: true, v: w.slice(1).trim() } : { not: false, v: w }))
    .filter((c) => c.v);
}
// hay 里有一项包含 v 就算包含
const modelFilterHit = (conds, hay) => conds.every((c) => hay.some((h) => h.includes(c.v)) !== c.not);

// 每百万 token 的价格：最多 4 位有效数字
function fmtModelPrice(n) {
  return typeof n === 'number' ? String(Number(n.toPrecision(4))) : '';
}

function modelStatusClass(st) {
  if (/^(ok|active|available|online|up|normal|healthy|enabled|operational|live)$/i.test(st)) return 'ok';
  if (/down|offline|unavailable|disabled|error|fail|outage|deprecated|retired|maintenance|inactive/i.test(st)) return 'bad';
  return 'warn';
}

function sortModelRows(rows) {
  const { sort, desc } = modelList;
  const byName = (a, b) => compareModels(a.name, b.name);
  if (sort === 'name') {
    rows.sort(byName);
    if (desc) rows.reverse();
    return rows;
  }
  return rows.sort((a, b) => {
    const x = a.info[sort];
    const y = b.info[sort];
    const nx = typeof x !== 'number';
    const ny = typeof y !== 'number';
    if (nx || ny) return nx === ny ? byName(a, b) : nx ? 1 : -1;
    return (desc ? y - x : x - y) || byName(a, b);
  });
}

function renderModelList() {
  const s = state.settings;
  const relay = currentRelay();
  els.modelListTitle.textContent = t('models.title', { name: relay ? relay.name : t('provider.' + s.provider) });
  const infoMap = (state.modelLists[s.provider] || {}).info || {};
  const all = modelOptions().map((name) => ({ name, info: infoMap[name] || {} }));
  // 第一列的标题：服务商提供了标签时是「名称（含标签）」
  els.modelColName.dataset.i18n = all.some((r) => r.info.tags) ? 'models.colNameTags' : 'models.colName';
  els.modelColName.textContent = t(els.modelColName.dataset.i18n);
  const nameConds = parseModelFilter(els.modelFilterName.value);
  const tagConds = parseModelFilter(els.modelFilterTag.value);
  const rows = sortModelRows(all.filter((r) => modelFilterHit(nameConds, [r.name.toLowerCase()])
    && modelFilterHit(tagConds, (r.info.tags || []).map((x) => x.toLowerCase()))));

  for (const b of els.modelListHead.querySelectorAll('[data-sort]')) {
    const on = b.dataset.sort === modelList.sort;
    b.querySelector('.sort-mark').textContent = on ? (modelList.desc ? '▼' : '▲') : '';
    b.setAttribute('aria-sort', on ? (modelList.desc ? 'descending' : 'ascending') : 'none');
  }

  const current = els.model.value.trim();
  const top = els.modelTable.scrollTop;
  els.modelTable.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'model-row' + (r.name === current ? ' current' : '');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const cell = (cls, text, title) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      if (title) el.title = title;
      row.appendChild(el);
      return el;
    };
    const name = cell('model-name', '');
    const id = document.createElement('div');
    id.className = 'model-id';
    id.textContent = r.name;
    id.title = r.name;
    name.appendChild(id);
    if (r.info.tags) {
      const tags = document.createElement('div');
      tags.className = 'model-tags';
      for (const tg of r.info.tags) {
        const chip = document.createElement('span');
        chip.className = 'model-tag';
        chip.textContent = tg;
        tags.appendChild(chip);
      }
      name.appendChild(tags);
    }
    const perCall = typeof r.info.in !== 'number' && typeof r.info.call === 'number';
    const pin = perCall ? t('models.perCall', { p: fmtModelPrice(r.info.call) }) : fmtModelPrice(r.info.in);
    const pout = fmtModelPrice(r.info.out);
    const st = r.info.status || '';
    cell('model-price' + (perCall ? ' per-call' : '') + (pin ? '' : ' no-value'), pin || '—');
    cell('model-price' + (pout ? '' : ' no-value'), pout || '—');
    cell('model-status ' + (st ? modelStatusClass(st) : 'no-value'), st || '—', st);
    row.addEventListener('click', () => { pickModel(r.name); closeModelList(); });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pickModel(r.name);
      closeModelList();
    });
    els.modelTable.appendChild(row);
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty muted';
    empty.textContent = t(all.length ? 'models.noMatch' : 'models.empty');
    els.modelTable.appendChild(empty);
  }
  els.modelTable.scrollTop = top;

  const anyInfo = all.some((r) => Object.keys(r.info).length);
  els.modelListFoot.textContent = t('models.count', { shown: rows.length, total: all.length }) + ' · '
    + t(anyInfo ? 'models.priceNote' : 'models.noInfo');
}

async function refetchModelList() {
  if (modelList.fetching) return;
  const provider = state.settings.provider;
  const run = {};
  modelList.fetching = run;
  els.btnRefetchModels.disabled = true;
  els.btnRefetchModels.textContent = t('models.refetching');
  try {
    const { models, info } = await fetchModels(providerCfg());
    storeModelList(provider, models, info);
    if (!els.modelListBox.hidden) renderModelList();
    toast(t('models.refetched', { n: models.length }));
  } catch (e) {
    showModal(t('set.fetchModelsFailed'), e.message);
  } finally {
    modelList.fetching = null;
    els.btnRefetchModels.disabled = false;
    els.btnRefetchModels.textContent = t('models.refetch');
  }
}

function bindModelList() {
  for (const el of [els.modelFilterName, els.modelFilterTag]) el.addEventListener('input', () => {
    els.modelTable.scrollTop = 0;
    renderModelList();
  });
  for (const b of els.modelListHead.querySelectorAll('[data-sort]')) {
    b.addEventListener('click', () => {
      if (modelList.sort === b.dataset.sort) modelList.desc = !modelList.desc;
      else { modelList.sort = b.dataset.sort; modelList.desc = false; }
      renderModelList();
    });
  }
  els.btnRefetchModels.addEventListener('click', () => void refetchModelList());
  closeOnBackdrop(els.modelListBox, closeModelList);
  // Esc 只关这个窗口，不顺带关闭设置面板。上面盖着出错提示时先关提示（它自己处理）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || els.modelListBox.hidden || !els.modal.hidden) return;
    e.stopPropagation();
    e.preventDefault();
    closeModelList();
  }, true);
}

// ---- 查看下一轮将发送的内容 ----
// 逻辑上的内容（不是接口请求的原始格式）：按发送的顺序列出每一块，带标签的原文全文和预估 token。
// 输入框里有文字时当作你这一次要发送的消息；锁定的对话里受保护的设定显示为“受保护的内容”

function nextRequestBlocks() {
  const conv = state.conv;
  const msgs = conv.messages;
  const last = msgs[msgs.length - 1];
  const typed = state.greetingMode ? '' : els.input.value.trim(); // 正在编辑开场白时，输入框里的不是消息
  let pending = false; // 输入框是空的，最后一条用户消息还没写
  let list = msgs;
  if (typed) list = msgs.concat([{ role: 'user', versions: [typed], cur: 0 }]);
  else if (!last || last.role !== 'user') {
    list = msgs.concat([{ role: 'user', versions: [''], cur: 0 }]);
    pending = true;
  }
  const req = requestOf(conv, list);

  const system = systemBlocks(conv);

  // 消息：和真正发出时一样合并连续同一角色的消息，Anthropic 格式开头补“前情省略”
  const messages = finalMessages(formatOf(providerCfg()), req.messages); // Command Code、Vertex 的格式随模型变化
  return { system, messages, pending };
}

// system 部分：和 buildSystem 的顺序、标签相同，拆成一块一块（「查看下一轮将发送的内容」里的各块；发送时也按它估算）
function systemBlocks(conv) {
  const system = [];
  const add = (title, text) => { if (text) system.push({ title, text: withMacros(text, conv) }); };
  add('System Prompt', conv.systemPrompt.trim());
  if (!isAssistant(conv)) {
    if (conv.worldText.trim()) add(t('set.world'), t('sys.world') + '\n' + conv.worldText.trim());
    if (conv.npcText.trim()) add(t('set.npc'), t('sys.npc') + '\n' + conv.npcText.trim());
    if (conv.persona.trim()) add(t('set.persona'), t('sys.persona') + '\n' + conv.persona.trim());
  }
  return system;
}

// 下一次请求的内容和预估的 token 数（tokens.js 的 estimate：各块 + 加值 = 总数），以及这个对话上一次请求的记录
function nextEstimate() {
  const blocks = nextRequestBlocks();
  const k = calibKey();
  const estimate = TokenCalib.estimate(k.relay, k.model, blocks.system.map((b) => b.text), blocks.messages.map((m) => m.content));
  return { ...blocks, estimate, last: TokenCalib.lastOf(k.relay, k.model, state.conv.id) };
}

function openPreview() {
  const conv = state.conv;
  const { system, messages, pending, estimate } = nextEstimate();
  const body = els.previewBody;
  body.replaceChildren();
  const group = (title) => {
    const g = document.createElement('div');
    g.className = 'preview-group';
    g.textContent = title;
    body.appendChild(g);
  };
  const block = (title, text, tokens, note) => {
    const b = document.createElement('div');
    b.className = 'preview-block';
    const head = document.createElement('div');
    head.className = 'preview-block-head';
    const name = document.createElement('span');
    name.textContent = title;
    const count = document.createElement('span');
    count.textContent = t('preview.tokens', { tokens: tokens.toLocaleString() });
    head.append(name, count);
    b.appendChild(head);
    if (note) {
      const n = document.createElement('div');
      n.className = 'preview-note';
      n.textContent = note;
      b.appendChild(n);
    }
    const pre = document.createElement('pre');
    pre.textContent = hideProtected(text, conv);
    b.appendChild(pre);
    body.appendChild(b);
  };
  if (system.length) {
    group(t('preview.system'));
    system.forEach((x, i) => block(x.title, x.text, estimate.system[i]));
  }
  group(t(isAssistant(conv) ? 'preview.chat' : 'preview.story'));
  const reply = t(isAssistant(conv) ? 'msg.assistant' : 'msg.story');
  messages.forEach((m, i) => {
    const lastOne = i === messages.length - 1;
    block(m.role === 'user' ? t('msg.you') : reply, m.content, estimate.messages[i], lastOne && pending ? t('preview.emptyInput') : '');
  });
  // 各块都乘了校准的系数（空的块是 0）。总数和设置面板里的一样，写成“各块之和 + 加值 = 总数”：
  // 加值是校准的固定加值（tokens.js 的 c，例如中转站自己加的内容、消息格式的开销），可能是负数
  const { extra, total } = estimate;
  const sum = total - extra;
  const expr = sum.toLocaleString() + (extra < 0 ? ' − ' : ' + ') + Math.abs(extra).toLocaleString();
  els.previewTotal.textContent = t('preview.total', { sum: expr, tokens: total.toLocaleString() });
  els.previewBox.hidden = false;
  placeExpand(els.previewBox);
  body.scrollTop = 0;
}

function closePreview() {
  els.previewBox.hidden = true;
}

// 记忆长度的数字框按位数调整宽度，让“数字 + 轮”整体在外框里居中
function sizeRoundsInput() {
  els.rounds.style.width = Math.max(1, String(els.rounds.value).length) + 0.3 + 'ch';
}

// ---- 放大窗口：盖一个大的输入框编辑 System Prompt、世界观或 NPC角色，内容和右侧的输入框同步 ----

let expandSource = null; // 正在放大编辑的那个右侧输入框

// 放大窗口的位置：电脑布局盖在聊天区上（标题栏以下，占大半个聊天区）；
// 手机布局盖在设置面板上（手机上是点 ⚙ 打开设置面板来编辑，聊天区被它盖住）
function placeExpand(el = els.expandBox) {
  const box = el.style;
  let top, left, width, bottom;
  if (isMobileLayout()) {
    const r = els.settingsPane.getBoundingClientRect();
    top = els.settingsPane.querySelector('.settings-head').getBoundingClientRect().bottom + 8;
    left = r.left + 8;
    width = r.width - 16;
    bottom = r.bottom - r.height * 0.15;
  } else {
    const r = els.chatPane.getBoundingClientRect();
    top = els.chatPane.querySelector('.chat-header').getBoundingClientRect().bottom + 10;
    left = r.left + r.width * 0.04;
    width = r.width * 0.92;
    bottom = r.top + r.height * 0.78;
  }
  box.top = top + 'px';
  box.left = left + 'px';
  box.width = width + 'px';
  box.height = Math.max(160, bottom - top) + 'px';
}

function openExpand(source, titleKey) {
  // 锁定的对话里受保护的设定（unlockable）不能放大编辑；剧情备忘、用户人设等不受保护的照常可以
  if (source.disabled || source.readOnly || (state.conv.lock && source.classList.contains('unlockable'))) return;
  expandSource = source;
  els.expandTitle.textContent = t(titleKey);
  els.expandText.value = source.value;
  els.expandText.placeholder = source.placeholder;
  els.expandBox.hidden = false;
  placeExpand();
  els.expandText.focus();
  els.expandText.setSelectionRange(0, 0); // 从开头显示
  els.expandText.scrollTop = 0;
}

function closeExpand() {
  if (!expandSource) return;
  expandSource = null;
  els.expandBox.hidden = true;
}

// 世界观和 NPC角色下方的字数
function updateWorldCount() {
  const count = (text) => (text ? t('set.worldCount', { chars: text.length.toLocaleString(), tokens: tokensOf(text).toLocaleString() }) : '');
  els.worldCount.textContent = count(state.conv.worldText);
  els.npcCount.textContent = count(state.conv.npcText);
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

// 网页版：从 js/version.js 读出这份代码来自哪次提交（只有用「Download ZIP」下载的才有）。
// 返回 { tag, commit, date }，tag 只在这次提交正好是某个版本标签时才有；没有替换过的占位符当作没有
function sourceInfo() {
  if (typeof SOURCE_INFO === 'undefined') return null;
  const val = (s) => (typeof s === 'string' && s && !s.includes('$Format') ? s.trim() : '');
  const commit = val(SOURCE_INFO.commit);
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
  const date = val(SOURCE_INFO.date);
  // git describe --tags：正好在标签上时就是标签本身（v0.4.0），之后的提交是 v0.4.0-3-gabc1234
  const describe = val(SOURCE_INFO.describe);
  const tag = /^v\d/.test(describe) && !/-\d+-g[0-9a-f]+$/i.test(describe) ? describe : '';
  return { tag, commit, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' };
}

// 输入框下方的开源与免责声明（网址做成链接，后面跟着当前版本）
function renderFooter() {
  const src = state.version ? null : sourceInfo();
  const version = state.version ? t('footer.version', { version: state.version })
    : src ? t(src.tag ? 'footer.versionWebTag' : 'footer.versionWebCommit', {
      tag: src.tag, commit: src.commit, date: src.date ? t('footer.versionDate', { date: src.date }) : '',
    })
      : t('footer.versionWeb');
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
  renderSyncCard();
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
  onConv(els.npcText, (el) => { if (!c().lock && !isAssistant(c())) { c().npcText = el.value; updateWorldCount(); } });
  onConv(els.persona, (el) => { if (!isAssistant(c())) c().persona = el.value; });
  onConv(els.postHistory, (el) => { if (!c().lock && !isAssistant(c())) c().postHistory = el.value; });
  // 剧情备忘：不受锁定保护（属于剧情），更新期间（只读）不会触发
  onConv(els.memo, (el) => { if (!isAssistant(c()) && !el.readOnly) { c().memo = el.value; renderMemoStatus(); } });
  els.memoSend.addEventListener('change', () => { c().memoSend = els.memoSend.checked; saveConvSoon(); updateEstimate(); });
  els.memoEvery.addEventListener('change', () => {
    c().memoEvery = clampInt(els.memoEvery.value, 0, MEMO_EVERY_MAX);
    els.memoEvery.value = c().memoEvery;
    saveConvSoon();
  });
  els.btnUpdateMemo.addEventListener('click', () => void updateMemo());
  // {{user}} 和 {{char}} 的值改了：聊天区里显示的内容跟着变（稍等一下再重画，开场白的窗口重画时会重新载入）
  let macroTimer = null;
  const redrawSoon = () => {
    clearTimeout(macroTimer);
    macroTimer = setTimeout(() => { if (state.conv) renderMessages(); }, 300);
  };
  onConv(els.userName, (el) => {
    if (isAssistant(c())) return;
    c().userName = el.value;
    redrawSoon();
  });
  onConv(els.charName, (el) => {
    if (isAssistant(c()) || c().lock) return;
    c().charName = el.value;
    redrawSoon();
  });

  // 记忆轮数：可以直接输入，也可以点 − / +，范围 1–40
  const setRounds = (n) => {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) n = s().rounds;
    n = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n));
    els.rounds.value = n;
    sizeRoundsInput();
    if (n === s().rounds) return;
    s().rounds = n;
    saveSettingsSoon();
    updateEstimate();
    renderMessages();
  };
  els.rounds.addEventListener('change', () => setRounds(els.rounds.value));
  els.rounds.addEventListener('input', sizeRoundsInput);
  els.rounds.addEventListener('keydown', (e) => { if (e.key === 'Enter') setRounds(els.rounds.value); });
  els.btnRoundsMinus.addEventListener('click', () => setRounds(s().rounds - 1));
  els.btnRoundsPlus.addEventListener('click', () => setRounds(s().rounds + 1));

  onSetting(els.baseUrl, (el) => { if (!isBuiltinProvider(s().provider)) s().baseUrls[s().provider] = el.value.trim(); });
  onSetting(els.apiKey, (el) => { s().apiKeys[s().provider] = el.value.trim(); });
  onSetting(els.model, (el) => { s().models[s().provider] = el.value.trim(); updateFormatFields(); });
  els.btnImportVertex.addEventListener('click', () => els.fileVertex.click());
  els.fileVertex.addEventListener('change', () => {
    const f = els.fileVertex.files[0];
    els.fileVertex.value = '';
    if (f) void importVertexKey(f);
  });
  onSetting(els.maxTokens, (el) => { s().maxTokens[s().provider] = el.value ? Number(el.value) : ''; });
  onSetting(els.temperature, (el) => { s().temperature = Number(el.value); });
  els.effort.addEventListener('change', () => { s().effort = els.effort.value; saveSettingsSoon(); });
  els.openrouterSort.addEventListener('change', () => { s().openrouterSort = els.openrouterSort.value; saveSettingsSoon(); });
  els.openrouterNoData.addEventListener('change', () => { s().openrouterNoData = els.openrouterNoData.checked; saveSettingsSoon(); });
  els.useTemperature.addEventListener('change', () => {
    s().useTemperature = els.useTemperature.checked;
    els.temperature.disabled = !s().useTemperature;
    saveSettingsSoon();
  });
  els.provider.addEventListener('change', () => {
    if (els.provider.value === ADD_RELAY) {
      els.provider.value = s().provider; // 下拉框先回到当前的服务商；保存后才切换到新的
      return void openRelayDialog();
    }
    s().provider = els.provider.value;
    fillProviderFields();
    saveSettingsSoon();
    updateEstimate();
  });
  // 用户添加的服务商：改名称、兼容模式马上保存。名称清空时不保存，离开输入框后恢复原来的名称
  els.relayEditName.addEventListener('input', () => {
    const relay = currentRelay();
    const name = els.relayEditName.value.trim();
    if (!relay || !name) return;
    relay.name = name;
    const opt = [...els.provider.options].find((o) => o.value === RELAY_PREFIX + relay.id);
    if (opt) opt.textContent = name;
    saveSettingsSoon();
  });
  els.relayEditName.addEventListener('blur', () => {
    const relay = currentRelay();
    if (relay) els.relayEditName.value = relay.name;
  });
  els.relayEditFormat.addEventListener('change', () => {
    const relay = currentRelay();
    if (!relay) return;
    relay.format = els.relayEditFormat.value === 'anthropic' ? 'anthropic' : 'openai';
    setCustomProviders(s().relays);
    fillProviderFields();
    saveSettingsSoon();
    updateEstimate();
  });
  els.btnDeleteRelay.addEventListener('click', async () => {
    const relay = currentRelay();
    if (!relay || !(await ask(t('relay.deleteConfirm', { name: relay.name }), { ok: t('relay.delete'), danger: true }))) return;
    removeRelay(relay);
  });
  bindRelayDialog();
  bindSync();
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

  // 还没获取过列表时是「获取列表」；获取过（包括添加服务商时就获取了）是「完整列表」，打开大窗口，在那里重新获取
  els.btnFetchModels.addEventListener('click', async () => {
    if (hasModelList()) return openModelList();
    els.btnFetchModels.disabled = true;
    try {
      const { models: list, info } = await fetchModels(providerCfg());
      storeModelList(s().provider, list, info);
      updateFetchButton();
      toast(t('set.fetchedModels', { n: list.length }));
      openModelMenu('');
      // 电脑上把光标放进模型输入框，可以直接用方向键和回车选；触屏上不放（会弹出键盘盖住列表）
      if (!els.modelMenu.hidden && !window.matchMedia('(hover: none)').matches) els.model.focus();
    } catch (e) {
      showModal(t('set.fetchModelsFailed'), e.message);
    } finally {
      els.btnFetchModels.disabled = false;
    }
  });


  const pickArt = () => { if (!state.conv.lock) els.fileArt.click(); };
  // 手机布局里、横屏展示时艺术图是背景，点它不打开上传
  els.artPane.addEventListener('click', () => { if (!isMobileLayout() && !isLandscapeArt()) pickArt(); });
  els.artPane.addEventListener('contextmenu', (e) => { if (state.conv.lock) e.preventDefault(); });
  els.btnUploadArt.addEventListener('click', pickArt);
  els.btnDownloadArt.addEventListener('click', downloadArt);
  els.btnUnlock.addEventListener('click', unlockConv);
  els.fileArt.addEventListener('change', async () => {
    const f = els.fileArt.files[0];
    els.fileArt.value = '';
    if (f) await setArt(f);
  });
  els.btnRemoveArt.addEventListener('click', () => void removeArt());
  bindArtMode();

  // 公用设备：不记住 API Key；清除软件数据
  els.rememberKeys.addEventListener('change', async () => {
    s().rememberKeys = els.rememberKeys.checked;
    clearTimeout(saveTimer);
    await DB.set('settings', storableSettings());
  });
  els.btnClearAll.addEventListener('click', async () => {
    if (state.generating) return toast(t('conv.stopFirst'));
    if (!(await ask(t('set.clearAllConfirm', pageVars()), { ok: t('set.clearAll'), danger: true }))) return;
    if (state.generating) return toast(t('conv.stopFirst'));
    clearTimeout(saveTimer);
    clearTimeout(convSaveTimer);
    convSavePending = null;
    await DB.destroy();
    forgetCachedLang();
    forgetNativeOrigins();
    forgetNoUsageOption();
    forgetInputDraft();
    TokenCalib.forget();
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
  els.btnExpandNpc.addEventListener('click', () => openExpand(els.npcText, 'set.npc'));
  els.btnExpandMemo.addEventListener('click', () => openExpand(els.memo, 'memo.title'));
  window.addEventListener('resize', () => {
    if (expandSource) placeExpand();
    if (!els.previewBox.hidden) placeExpand(els.previewBox);
  });

  // 查看下一轮将发送的内容
  els.btnPreviewNext.addEventListener('click', openPreview);
  // 「点在外面就关闭」都用 pointerdown：点在不可用的输入框上（例如助理模式下的世界观）时浏览器不发 mousedown 和 click
  document.addEventListener('pointerdown', (e) => { if (!els.previewBox.hidden && !els.previewBox.contains(e.target) && !insideDialog(e.target)) closePreview(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.previewBox.hidden) { e.stopPropagation(); closePreview(); }
  }, true);
  els.expandText.addEventListener('input', () => {
    if (!expandSource) return;
    expandSource.value = els.expandText.value;
    expandSource.dispatchEvent(new Event('input')); // 和直接在右侧输入一样保存、更新字数
  });
  // 点在放大窗口以外的地方就关闭（按 Esc 也可以）
  document.addEventListener('pointerdown', (e) => { if (expandSource && !els.expandBox.contains(e.target) && !insideDialog(e.target)) closeExpand(); }, true);
  // 点在消息内容上：每条消息显示在一个 iframe 里，外层页面收不到里面的鼠标事件，但焦点会移进那个 iframe、页面失去焦点。
  // 这时也算点在外面，关闭放大窗口和预览窗口。切到别的程序时页面也会失去焦点，但焦点不在 iframe 上，不关闭（切回来还能接着编辑）
  window.addEventListener('blur', () => setTimeout(() => {
    const f = document.activeElement;
    if (!f || f.tagName !== 'IFRAME') return;
    if (!els.previewBox.hidden && !els.previewBox.contains(f)) closePreview();
    if (expandSource && !els.expandBox.contains(f)) closeExpand();
  }, 0));
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
  await removeConvs([gone]);
}

// 一次删除多个对话（「全部对话」窗口里选中的）。只有一个时和 deleteConv 一样
async function deleteConvs(list) {
  list = list.filter((c) => state.conversations.includes(c));
  if (list.length <= 1) return list.length ? deleteConv(list[0]) : undefined;
  if (state.generating && list.includes(state.conv)) return toast(t('conv.stopFirst'));
  if (!(await ask(t('conv.deleteManyConfirm', { n: list.length }), { ok: t('conv.deleteN', { n: list.length }), danger: true }))) return;
  list = list.filter((c) => state.conversations.includes(c)); // 确认期间可能已经被删掉
  if (!list.length) return;
  if (state.generating && list.includes(state.conv)) return toast(t('conv.stopFirst'));
  await removeConvs(list);
}

async function removeConvs(list) {
  const gone = new Set(list);
  if (gone.has(convSavePending)) convSavePending = null;
  state.conversations = state.conversations.filter((c) => !gone.has(c));
  if (!state.conversations.length) {
    // 删掉了全部对话时，新建一个空对话并沿用被删对话（当前对话在其中时用当前对话）的设定、开场白和艺术图
    const from = gone.has(state.conv) ? state.conv : list[0];
    const c = newConversation(from);
    state.conversations.push(c);
    await DB.putConversation(storable(c));
    const art = await DB.get(artKey(from.id));
    if (art) await DB.set(artKey(c.id), art);
  }
  for (const c of list) {
    allSel.delete(c.id);
    await DB.deleteConversation(c.id);
    await DB.del(artKey(c.id));
  }
  if (!gone.has(state.conv)) return renderConvSelect();
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
  els.input.addEventListener('input', updateEstimateSoon);
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

  // 对话列表：点击展开；键盘 ↑ ↓ 选择、Enter 切换（选中「…」时打开「全部对话」）、Esc 收起，
  // 菜单键或 Shift + F10 打开右键菜单
  els.convSelect.addEventListener('click', () => { if (els.convMenu.hidden) openConvMenu(); else closeConvMenu(); });
  els.convSelect.addEventListener('keydown', (e) => {
    const open = !els.convMenu.hidden;
    const n = convMenu.items.length + (convMenu.more ? 1 : 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openConvMenu();
      closeConvCtxMenu();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      highlightConv(convMenu.active < 0 ? 0 : (convMenu.active + d + n) % n, true);
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (convMenu.items[convMenu.active]) pickConv(convMenu.items[convMenu.active]);
      else if (convMenu.more && convMenu.active === convMenu.items.length) openAllConvs();
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
  // 重命名、删除后对话列表保持打开，可以接着改别的对话（只收起右键菜单）
  els.btnCtxRename.addEventListener('click', () => {
    const c = ctxConv;
    closeConvCtxMenu();
    if (c && !Array.isArray(c)) void renameConv(c); // 不用等：输入框和保存由 renameConv 自己完成
  });
  els.btnCtxDelete.addEventListener('click', () => {
    const c = ctxConv;
    closeConvCtxMenu();
    // 不用等：确认框和删除由 deleteConv / deleteConvs 自己完成
    if (Array.isArray(c)) void deleteConvs(c);
    else if (c) void deleteConv(c);
  });
  // 有输入框或确认框打开时（例如正在重命名），对话列表不受点击、Esc 和窗口大小变化影响
  const dialogOpen = () => !els.dialog.hidden || !els.textDialog.hidden || !els.pwDialog.hidden || !els.modal.hidden || !els.updateDialog.hidden || !els.relayDialog.hidden || !els.syncDialog.hidden || !els.modelListBox.hidden;
  // 点在列表和右键菜单以外：都收起；点在列表里（右键菜单以外）：只收起右键菜单。
  // 用 pointerdown：点在不可用的输入框上时浏览器不发 mousedown
  document.addEventListener('pointerdown', (e) => {
    if (els.convCtxMenu.contains(e.target) || dialogOpen()) return;
    closeConvCtxMenu();
    if (!els.convPicker.contains(e.target)) closeConvMenu();
  });
  // 点在消息内容上（每条消息显示在一个 iframe 里，外层页面收不到里面的鼠标事件）或者切到软件窗口以外时，
  // 页面会失去焦点：也收起对话列表、右键菜单和「＋ 新对话」菜单。有输入框或确认框打开时不收起（同上）
  window.addEventListener('blur', () => {
    if (dialogOpen()) return;
    closeConvMenu();
    closeNewConvMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dialogOpen()) return;
    if (!els.convCtxMenu.hidden) { e.stopPropagation(); closeConvCtxMenu(); if (els.allConvBox.hidden) els.convSelect.focus(); }
    else if (!els.convMenu.hidden) { e.stopPropagation(); closeConvMenu(); els.convSelect.focus(); }
    else if (!els.allConvBox.hidden && allSel.size) { e.stopPropagation(); allSel.clear(); showConvSelection(); } // 先取消选中
    else if (!els.allConvBox.hidden) { e.stopPropagation(); closeAllConvs(); els.convSelect.focus(); }
  }, true);
  // 窗口变宽变窄时收起列表；只是高度变化（手机上弹出、收起键盘）时不收起
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    closeConvMenu();
  });
  // 点「全部对话」窗口以外的地方关闭它
  closeOnBackdrop(els.allConvBox, closeAllConvs);
  // 电脑和手机布局的对话名称写法不同（手机上更紧凑），切换布局时重新显示
  window.matchMedia('(max-width: 999px)').addEventListener('change', renderConvSelect);
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
  // 点在菜单以外就收起。用 pointerdown：点在不可用的输入框上时浏览器不发 click
  document.addEventListener('pointerdown', (e) => { if (!els.newConvGroup.contains(e.target) && !insideDialog(e.target)) closeNewConvMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.newConvMenu.hidden) { e.stopPropagation(); closeNewConvMenu(); els.btnNewConv.focus(); }
  }, true);
  els.btnRenameConv.addEventListener('click', () => renameConv());
  els.btnDeleteConv.addEventListener('click', () => deleteConv());

  els.btnModalClose.addEventListener('click', () => { els.modal.hidden = true; });
  closeOnBackdrop(els.modal, () => { els.modal.hidden = true; });
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
  for (const k of ['apiKeys', 'baseUrls', 'models', 'maxTokens', 'sync']) {
    state.settings[k] = { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) };
  }
  // 以前的版本把获取到的模型列表存在设置里（modelLists、modelInfo）：现在每次打开重新获取，删掉
  if ('modelLists' in state.settings || 'modelInfo' in state.settings) {
    delete state.settings.modelLists;
    delete state.settings.modelInfo;
    saveSettingsSoon();
  }
  if (sessionKeys) state.settings.apiKeys = sessionKeys; // 不记住 Key 时，本次打开期间填过的 Key 继续有效
  // （很早的版本单列过 OpenRouter，键名也是 openrouter：现在它又是内置服务商，那时的 Key 和模型直接接着用）
  state.settings.rounds = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Number(state.settings.rounds) || 12));
  setLang(state.settings.lang || detectLang());
  if (migrateRelays(state.settings)) saveSettingsSoon(); // 迁移时可能要用界面语言的文字当名称，所以在 setLang 之后
  setCustomProviders(state.settings.relays);
  if (!providerOf(state.settings.provider)) state.settings.provider = 'anthropic';

  // 旧版本把 System Prompt、世界观、人设和艺术图放在全局，迁移到每个对话里
  const legacy = { systemPrompt: saved.systemPrompt, worldText: saved.worldText, persona: saved.persona };
  const legacyArt = await DB.get('art');
  state.conversations = [];
  for (const c of await DB.listConversations()) {
    try { await openLock(c); } catch (e) { console.error('无法解密对话', c.id, e); continue; }
    state.conversations.push(c);
    const fields = () => JSON.stringify([c.title, c.mode, c.tavern, c.systemPrompt, c.worldText, c.npcText, c.charName, c.persona, c.userName, c.postHistory,
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

// 首次打开时的开源协议说明。AGPL v3 不要求同意才能使用（第 9 条：接收和运行本软件不需要接受协议，
// 修改或分发本软件即表示接受协议），所以这里只让用户阅读：一个「我已知晓」按钮，没有拒绝。
// 窗口不能用返回键、Esc 或点外面关闭，点「我已知晓」后记在数据库里，以后不再显示（清除软件数据后会再显示）。
// Windows 安装版第一次安装时，安装程序里已经显示过协议（build/installer.nsh），不再显示；
// 其他版本（网页版、安卓、macOS、Linux、Windows 免安装版）都显示
async function showLicenseNotice() {
  if (IN_NATIVE_APP && updateFileKey() === 'win-setup') return;
  if (await DB.get('licenseAcknowledged')) return;
  const desktop = window.proteusDesktop;
  let text = '';
  try {
    text = desktop && desktop.licenseText ? await desktop.licenseText() : await (await fetch('LICENSE')).text();
  } catch (_) { /* 只显示说明和网址 */ }
  // 读不到原文时（例如网页版直接打开本地的 index.html），告诉用户全文在哪里
  const dlg = openMandatoryDialog(t('license.title'), t('license.intro', { url: PROJECT_URL }) + '\n\n' + (text ? text.trim() : t('license.fullTextAt')));
  els.updateButtons.append(button(t('license.acknowledge'), () => dlg.close(), 'btn btn-primary'));
  els.updateMessage.scrollTop = 0;
  dlg.show();
  await dlg.done;
  await DB.set('licenseAcknowledged', true);
}

function init() {
  for (const el of document.querySelectorAll('[id]')) els[el.id] = el;
  els.langSelect.innerHTML = Object.entries(LANGS).map(([k, name]) => `<option value="${k}">${name}</option>`).join('');
  bindSettings();
  bindChat();
  bindLayout();
  bindModelMenu();
  bindModelList();
  bindBackButton();
  // 消息高度变化时（内容载入、图片加载、展开 <details> 等），如果停留在底部就继续贴底
  Render.onResize(() => { if (state.follow) els.messages.scrollTop = els.messages.scrollHeight; });
  const version = detectVersion().then((v) => { state.version = v; renderFooter(); }); // detectVersion 自己处理出错
  const booted = boot().catch((e) => {
    console.error(e);
    showError(t('boot.failed', { msg: e.message }));
    throw e;
  });
  booted.then(restoreInputDraft, () => {});
  // 第一次打开时先显示开源协议说明（见 showLicenseNotice）
  const licensed = booted.then(showLicenseNotice);
  // 拉取其他用户共享的 token 校准数据，推送本机还没推送的（静默，见 tokens.js。共享目前关闭，这里什么都不做）
  booted.then(() => TokenCalib.sync(() => { if (state.conv) updateEstimate(); }), () => {});
  // 启动时立刻检查更新（只在原生应用里），和读取数据同时进行；有要提示的版本时等数据读完、
  // 开源协议说明关掉后再显示（读取数据失败时不显示）
  void checkForUpdates(version, licensed);
}

document.addEventListener('DOMContentLoaded', init);
