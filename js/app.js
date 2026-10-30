// 主程序：界面、对话管理、上下文拼装。
//
// 数据分两类：
//   - 每个对话各自保存：System Prompt、世界观、用户人设、开场白、剧情，以及艺术图（存在 art:<对话id>）。
//     新建对话时复制当前对话的设定和开场白，之后互不影响。
//   - 来自加密世界卡的对话带有 conv.lock：System Prompt、世界观、开场白和艺术图只以密文保存，
//     在内存里解密后使用，界面上不能查看或修改，输入密码解锁后变回普通对话。
//   - 软件设置（所有对话共用）：界面语言、记忆长度、模型与接口、API Key、布局。

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 40;

const DEFAULT_SETTINGS = {
  lang: null,          // null = 按浏览器语言
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
  if (NATIVE) return shareFile(filename, blob);
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

// 要写入本机存储（和备份）的对话：锁定的对话不保存明文，那几项只在 conv.lock 里以密文存在
const LOCKED_FIELDS = ['systemPrompt', 'worldText', 'greeting', 'greetingSend'];
function storable(conv) {
  if (!conv.lock) return conv;
  const out = { ...conv };
  for (const k of LOCKED_FIELDS) delete out[k];
  return out;
}
const lockedFields = (c) => ({ systemPrompt: c.systemPrompt, worldText: c.worldText, greeting: c.greeting, greetingSend: c.greetingSend !== false });

// 锁定的对话在读取后解密到内存
async function openLock(conv) {
  if (conv.lock) Object.assign(conv, await Locker.open(conv.lock));
  return conv;
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
// 顺序：System Prompt → 世界观 → 用户角色人设（都取自当前对话）

function buildSystem(conv = state.conv) {
  const parts = [];
  if (conv.systemPrompt.trim()) parts.push(conv.systemPrompt.trim());
  if (conv.worldText.trim()) parts.push(t('sys.world') + '\n' + conv.worldText.trim());
  if (conv.persona.trim()) parts.push(t('sys.persona') + '\n' + conv.persona.trim());
  return parts.join('\n\n');
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

// 新建对话。from 是要复制设定和开场白的对话（不复制剧情）；锁定状态也一起复制
function newConversation(from) {
  const now = Date.now();
  const c = {
    id: uid(),
    title: '',
    systemPrompt: from ? from.systemPrompt : t('defaultSystemPrompt'),
    worldText: from ? from.worldText : '',
    persona: from ? from.persona : '',
    greeting: from ? from.greeting : null,
    greetingSend: from ? from.greetingSend !== false : true,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  if (from && from.lock) c.lock = from.lock;
  return c;
}

// 补齐旧版本数据缺少的字段
function normalizeConv(c, legacy) {
  if (c.title === '新对话') c.title = '';
  if (typeof c.systemPrompt !== 'string') c.systemPrompt = legacy && typeof legacy.systemPrompt === 'string' ? legacy.systemPrompt : t('defaultSystemPrompt');
  if (typeof c.worldText !== 'string') c.worldText = (legacy && legacy.worldText) || '';
  if (typeof c.persona !== 'string') c.persona = (legacy && legacy.persona) || '';
  if (c.greeting === undefined) c.greeting = null;
  if (c.greetingSend === undefined) c.greetingSend = true;
  if (!Array.isArray(c.messages)) c.messages = [];
  return c;
}

async function switchConv(id) {
  if (state.generating) return toast(t('conv.stopFirst'));
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  await flushConvSave();
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

// 新建一个对话，复制当前对话的设定、开场白和艺术图
async function createConversation() {
  if (state.generating) return toast(t('conv.stopFirst'));
  await flushConvSave();
  const from = state.conv;
  const c = newConversation(from);
  state.conversations.push(c);
  await DB.putConversation(storable(c));
  const art = from && (await DB.get(artKey(from.id)));
  if (art) await DB.set(artKey(c.id), art);
  await switchConv(c.id);
  els.input.focus();
}

function renderConvSelect() {
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  els.convSelect.innerHTML = '';
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = (c.lock ? '🔒 ' : '') + t('conv.option', { title: convTitle(c), n: c.messages.length, time: fmtTime(c.updatedAt) });
    if (state.conv && c.id === state.conv.id) o.selected = true;
    els.convSelect.appendChild(o);
  }
}

// 从一段可能含 Markdown/HTML 的文字里提取对话标题
function titleFrom(text) {
  const plain = text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
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
  if (conv.greeting != null) items.push({ id: GREETING_ID, greeting: true });
  else if (gm && gm.preview != null) items.push({ id: PREVIEW_ID, preview: true });
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
  const text = it.greeting ? conv.greeting : it.preview ? state.greetingMode.preview : msgText(m);

  v.el.className = 'msg ' + role + (it.preview ? ' preview' : '');
  v.el.dataset.id = it.id;
  v.el.classList.toggle('generating', isGen);
  v.label.textContent = it.greeting ? t('msg.greeting') : it.preview ? t('msg.greetingPreview') : m.role === 'user' ? t('msg.you') : t('msg.story');
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
  v.holder.hidden = editing;

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
  if (locked) {
    const tag = document.createElement('span');
    tag.className = 'lock-tag';
    tag.textContent = t('lock.greetingTag');
    v.actions.appendChild(tag);
    return;
  }
  if (it.greeting) {
    v.actions.append(button(t('msg.copy'), () => copyText(conv.greeting)));
    // 对话开始后开场白锁定：要换开场白请新建对话
    if (!conv.messages.length) {
      v.actions.append(
        disabled(button(t('msg.edit'), () => startEdit(GREETING_ID, conv.greeting)), busy),
        disabled(button(t('msg.deleteGreeting'), deleteGreeting), busy),
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
    const sw = document.createElement('span');
    sw.className = 'swipe';
    const n = document.createElement('span');
    n.textContent = `${m.cur + 1}/${m.versions.length}`;
    sw.append(
      disabled(button('‹', () => switchVersion(m, -1)), busy, t('msg.prevVersion')),
      n,
      disabled(button('›', () => switchVersion(m, 1)), busy, t('msg.nextVersion')),
    );
    v.actions.appendChild(sw);
  }
  v.actions.appendChild(button(t('msg.copy'), () => copyText(msgText(m))));
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
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') cancelEdit();
  });
  const row = document.createElement('div');
  row.className = 'row';
  row.append(button(t('msg.cancel'), cancelEdit, 'btn btn-small btn-ghost'), button(t('msg.save'), saveEdit, 'btn btn-small btn-primary'));
  wrap.append(ta, row);
  setTimeout(() => { ta.focus(); ta.style.height = Math.min(ta.scrollHeight + 4, window.innerHeight * 0.6) + 'px'; }, 0);
  return wrap;
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
  els.btnAddGreeting.hidden = busy || gm || conv.greeting != null || msgs.length > 0 || !!conv.lock;
  els.btnGreetingReload.hidden = !gm;
  els.btnGreetingConfirm.hidden = !gm;
  els.btnGreetingCancel.hidden = !gm;
  els.composer.classList.toggle('greeting-mode', gm);
  // 手机上没有 Ctrl + Enter，提示里不提它
  const mobile = isMobileLayout() ? 'Mobile' : '';
  els.input.placeholder = t((gm ? 'input.greetingPlaceholder' : 'input.placeholder') + mobile);
  updateStatus();
}

function updateStatus() {
  if (state.generating) { els.status.textContent = t('status.generating'); return; }
  if (state.greetingMode) { els.status.textContent = t('status.greetingMode'); return; }
  const s = state.settings;
  els.status.textContent = t(isMobileLayout() ? 'status.idleShort' : 'status.idle', {
    rounds: s.rounds,
    tokens: estimateNextRequest().toLocaleString(),
    sys: estimateTokens(buildSystem()).toLocaleString(),
    model: s.models[s.provider] || t('status.noModel'),
  });
}

// 粗略估计下一次请求的总 token 数（固定设定 + 记忆范围内的消息，不含你还没写的下一条回复）
function estimateNextRequest() {
  const msgs = state.conv.messages;
  const last = msgs[msgs.length - 1];
  const list = last && last.role === 'user' ? msgs : msgs.concat([{ role: 'user', versions: [''], cur: 0 }]);
  return estimateTokens(buildSystem()) + windowOf(list).reduce((a, x) => a + estimateTokens(x.content), 0);
}

// ---------------- 滚动 ----------------

function nearBottom() {
  const b = els.messages;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 60;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  state.follow = true;
  els.btnJumpBottom.hidden = true;
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
    if (!draft.trim()) {
      if (!confirm(t('msg.emptyGreetingConfirm'))) return;
      state.conv.greeting = null;
    } else {
      state.conv.greeting = draft;
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

async function deleteGreeting() {
  if (!confirm(t('msg.deleteGreetingConfirm'))) return;
  state.conv.greeting = null;
  if (state.editingId === GREETING_ID) state.editingId = null;
  renderMessages();
  await saveConv();
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
  if (!confirm(t('msg.deleteVersionConfirm'))) return;
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
  if (!confirm(t('msg.rollbackConfirm', { n }))) return;
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
      els.dialogButtons.appendChild(button(o.label, () => close(o.value), 'btn' + (o.primary ? ' btn-primary' : o.ghost ? ' btn-ghost' : '')));
    }
    document.addEventListener('keydown', onKey, true);
    els.dialog.hidden = false;
    els.dialogButtons.querySelector('.btn-primary')?.focus();
  });
}

// ---- 开场白编辑模式（借用下方的输入框） ----

function enterGreetingMode() {
  if (state.generating) return;
  state.greetingMode = { preview: null };
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

// 确认：保存开场白、清空输入框，再询问是否发送给模型
async function confirmGreeting() {
  const conv = state.conv;
  const text = els.input.value.trim();
  if (!state.greetingMode) return;
  if (!text) return toast(t('greeting.empty'));
  const send = await choose(t('greeting.dialogTitle'), t('greeting.dialogMessage'), [
    { label: t('btn.cancel'), value: null, ghost: true },
    { label: t('greeting.noSend'), value: 'no' },
    { label: t('greeting.send'), value: 'yes', primary: true },
  ]);
  if (!send || conv !== state.conv || !state.greetingMode) return;
  conv.greeting = text;
  conv.greetingSend = send === 'yes';
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
    if (f) Render.stream(f, m.versions[ver]);
  };

  logConv = conv;
  try {
    result = await streamChat(providerCfg(), buildSystem(conv), windowOf(context, sentGreeting(conv)), {
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
  if (conv.greeting != null) section(t('msg.greeting'), conv.lock ? t('lock.protected') : conv.greeting);
  for (const m of conv.messages) section(m.role === 'user' ? t('msg.you') : t('msg.story'), msgText(m));
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

// 世界卡：当前对话的 System Prompt、世界观、开场白和艺术图，不含用户人设和剧情。
// 可以加密：直接打开文件只能看到乱码，在 Proteus 里读取后这些内容被锁定。
async function exportWorldCard() {
  const conv = state.conv;
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
    version: 2,
    exportedAt: new Date().toISOString(),
    name: name.trim() || t('export.unnamedWorld'),
  };
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
  if (lockedN < state.conversations.length) {
    const enc = await askEncrypt(t('export.full'), t('export.fullEncryptMessage'), false);
    if (!enc) return;
    password = enc.password;
  }
  await flushConvSave();
  const conversations = [];
  const arts = {};
  for (const c of state.conversations) {
    const encrypt = !!c.lock || password !== null;
    if (c.lock || password === null) conversations.push(storable(c));
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
    const secrets = [...new Set([logConv.systemPrompt, logConv.worldText, logConv.greeting]
      .filter((v) => v && v.trim()).flatMap((v) => [v, v.trim()]))].sort((a, b) => b.length - a.length);
    const hide = (v) => secrets.reduce((out, sec) => out.split(sec).join(t('lock.protected')), v);
    body = JSON.parse(JSON.stringify(body, (k, v) => (typeof v === 'string' ? hide(v) : v)));
  }
  const out = [
    `Proteus log · ${x.time.toLocaleString()}`,
    '',
    '===== REQUEST =====',
    `${x.request.method} ${x.request.url}`,
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
  const choice = await choose(t('export.menuTitle'), t('export.menuMessage'), [
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

// 读取世界卡或完整备份（当前对话 / 全部对话）。剧情导出是 TXT/Markdown，不能读回
async function restore(file) {
  if (state.generating) return toast(t('conv.stopFirst'));
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { return toast(t('restore.notJson')); }
  if (!data || data.app !== 'proteus') return toast(t('restore.invalid'));

  if (data.type === 'worldcard') {
    const name = data.name || t('export.unnamedWorld');
    if (!confirm(t(data.locked ? 'restore.cardConfirmLocked' : 'restore.cardConfirm', { name }))) return;
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
    c.persona = '';
    if (typeof fields.greeting === 'string') {
      c.greeting = fields.greeting;
      c.greetingSend = fields.greetingSend !== false;
    }
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
    if (!confirm(t(src.lock ? 'restore.convConfirmLocked' : 'restore.convConfirm', { name: convTitle(src) }))) return;
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
  if (!confirm(t('restore.fullConfirm', { n: data.conversations.length }))) return;
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
  els.settingsPane.classList.toggle('locked', locked);
  els.systemPrompt.value = locked ? '' : c.systemPrompt;
  els.worldText.value = locked ? '' : c.worldText;
  els.persona.value = c.persona;
  els.btnUploadArt.disabled = locked;
  els.btnRemoveArt.disabled = locked;
  els.artPane.classList.toggle('locked', locked);
  updateWorldCount();
  updateStatus();
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
  updateStatus();
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

function updateWorldCount() {
  const text = state.conv.worldText;
  els.worldCount.textContent = text ? t('set.worldCount', { chars: text.length.toLocaleString(), tokens: estimateTokens(text).toLocaleString() }) : '';
}

// 输入框下方的开源与免责声明（网址做成链接）
function renderFooter() {
  const [before, after] = t('footer.license').split('{url}');
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
    if (!state.conv.lock && isDefaultSystemPrompt(state.conv.systemPrompt) && state.conv.systemPrompt !== t('defaultSystemPrompt')) {
      state.conv.systemPrompt = t('defaultSystemPrompt');
      els.systemPrompt.value = state.conv.systemPrompt;
      saveConvSoon();
    }
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
  const onSetting = (el, fn) => el.addEventListener('input', () => { fn(el); saveSettingsSoon(); updateStatus(); });
  const onConv = (el, fn) => el.addEventListener('input', () => { fn(el); saveConvSoon(); updateStatus(); });

  // 属于当前对话的设定
  onConv(els.systemPrompt, (el) => { if (!c().lock) c().systemPrompt = el.value; });
  onConv(els.worldText, (el) => { if (!c().lock) { c().worldText = el.value; updateWorldCount(); } });
  onConv(els.persona, (el) => { c().persona = el.value; });

  // 记忆轮数：可以直接输入，也可以点 − / +，范围 1–40
  const setRounds = (n) => {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) n = s().rounds;
    n = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n));
    els.rounds.value = n;
    if (n === s().rounds) return;
    s().rounds = n;
    saveSettingsSoon();
    updateStatus();
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
    updateStatus();
  });
  els.langSelect.addEventListener('change', () => {
    s().lang = els.langSelect.value;
    saveSettingsSoon();
    applyLang(s().lang);
  });

  els.btnResetSystem.addEventListener('click', () => {
    if (c().lock || !confirm(t('set.resetConfirm'))) return;
    c().systemPrompt = t('defaultSystemPrompt');
    els.systemPrompt.value = c().systemPrompt;
    saveConvSoon();
    updateStatus();
  });

  els.btnUploadWorld.addEventListener('click', () => els.fileWorld.click());
  els.fileWorld.addEventListener('change', async () => {
    const f = els.fileWorld.files[0];
    els.fileWorld.value = '';
    if (!f) return;
    if (c().lock) return;
    if (!/\.(txt|md)$/i.test(f.name)) return toast(t('set.worldOnlyText'));
    const text = await f.text();
    if (c().worldText.trim() && !confirm(t('set.worldReplace'))) return;
    c().worldText = text;
    els.worldText.value = text;
    updateWorldCount();
    saveConvSoon();
    updateStatus();
    toast(t('set.worldLoaded', { name: f.name }));
  });
  els.btnClearWorld.addEventListener('click', () => {
    if (c().lock || !c().worldText || !confirm(t('set.worldClear'))) return;
    c().worldText = '';
    els.worldText.value = '';
    updateWorldCount();
    saveConvSoon();
    updateStatus();
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
    if (!confirm(t('set.clearAllConfirm'))) return;
    clearTimeout(saveTimer);
    clearTimeout(convSaveTimer);
    convSavePending = null;
    await DB.destroy();
    location.reload();
  });

  els.btnExport.addEventListener('click', exportMenu);
  els.btnRestore.addEventListener('click', () => els.fileRestore.click());
  els.fileRestore.addEventListener('change', async () => {
    const f = els.fileRestore.files[0];
    els.fileRestore.value = '';
    if (f) await restore(f);
  });
}

async function renameConv() {
  const name = await askText(t('conv.rename'), t('conv.renamePrompt'), state.conv.title);
  if (name === null || !name.trim()) return;
  state.conv.title = name.trim();
  await saveConv();
}

async function deleteConv() {
  if (state.generating) return toast(t('conv.stopFirst'));
  if (!confirm(t('conv.deleteConfirm', { title: convTitle(state.conv) }))) return;
  const gone = state.conv;
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
  const next = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  await switchConv(next.id);
}

function bindChat() {
  els.btnSend.addEventListener('click', send);
  els.btnStop.addEventListener('click', stop);
  els.btnReply.addEventListener('click', () => { if (!state.generating) generateReply(); });
  els.btnAddGreeting.addEventListener('click', enterGreetingMode);
  els.btnGreetingReload.addEventListener('click', reloadGreetingPreview);
  els.btnGreetingConfirm.addEventListener('click', confirmGreeting);
  els.btnGreetingCancel.addEventListener('click', exitGreetingMode);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      if (state.greetingMode) reloadGreetingPreview();
      else send();
    }
  });

  els.messages.addEventListener('scroll', () => {
    state.follow = nearBottom();
    els.btnJumpBottom.hidden = state.follow;
  });
  els.btnJumpBottom.addEventListener('click', scrollToBottom);

  els.convSelect.addEventListener('change', () => switchConv(els.convSelect.value));
  els.btnNewConv.addEventListener('click', createConversation);
  els.btnRenameConv.addEventListener('click', renameConv);
  els.btnRenameConv2.addEventListener('click', renameConv);
  els.btnDeleteConv.addEventListener('click', deleteConv);
  els.btnDeleteConv2.addEventListener('click', deleteConv);

  els.btnModalClose.addEventListener('click', () => { els.modal.hidden = true; });
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.modal.hidden = true; });

  window.addEventListener('beforeunload', (e) => {
    if (convSavePending) flushConvSave();
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
    const before = JSON.stringify([c.title, c.systemPrompt, c.worldText, c.persona, c.greeting, c.greetingSend]);
    normalizeConv(c, legacy);
    if (JSON.stringify([c.title, c.systemPrompt, c.worldText, c.persona, c.greeting, c.greetingSend]) !== before) await DB.putConversation(storable(c));
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
    || [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
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
  boot().catch((e) => {
    console.error(e);
    showError(t('boot.failed', { msg: e.message }));
  });
}

document.addEventListener('DOMContentLoaded', init);
