// 主程序：界面、对话管理、上下文拼装。

const DEFAULT_SYSTEM_PROMPT = `你是一名角色扮演叙事者。根据下方的世界观设定推进剧情，扮演世界中除用户角色以外的所有角色，并描写环境与事件。
- 始终与世界观设定保持一致。
- 不要替用户角色说话、行动或做决定。
- 每次回复描写场景、其他角色的言行与事件发展，篇幅适中，结尾给用户留出行动的空间。
- 使用中文写作。`;

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 40;

const DEFAULT_SETTINGS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  worldText: '',
  persona: '',
  rounds: 12,
  artWidth: null,      // 左栏宽度（像素），null = 自动
  inputHeight: 88,     // 输入框高度（像素）
  provider: 'anthropic',
  apiKeys: {},
  baseUrls: {},
  models: { anthropic: PROVIDERS.anthropic.defaultModel },
  maxTokens: { anthropic: 16000, custom_anthropic: 16000 },
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

const $ = (id) => document.getElementById(id);
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

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function safeFilename(s) {
  return (s || '剧情').replace(/[\\/:*?"<>|\n]/g, '_').slice(0, 60);
}

const msgText = (m) => m.versions[m.cur] || '';

// ---------------- 设定的保存 ----------------

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.set('settings', state.settings), 300);
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
// 顺序：System Prompt → 世界观 → 用户角色人设

function buildSystem() {
  const s = state.settings;
  const parts = [];
  if (s.systemPrompt.trim()) parts.push(s.systemPrompt.trim());
  if (s.worldText.trim()) parts.push('【世界观设定】\n' + s.worldText.trim());
  if (s.persona.trim()) parts.push('【用户角色人设】\n' + s.persona.trim());
  return parts.join('\n\n');
}

// 开场白和用户第一条消息合在一起，作为发给模型的第一条消息
function withGreeting(greeting, text) {
  return `【开场白】\n${greeting}\n\n【用户】\n${text}`;
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

function newConversation() {
  const now = Date.now();
  return { id: uid(), title: '新对话', greeting: null, greetingSend: true, createdAt: now, updatedAt: now, messages: [] };
}

async function saveConv(conv = state.conv) {
  conv.updatedAt = Date.now();
  await DB.putConversation(conv);
  renderConvSelect();
}

async function switchConv(id) {
  if (state.generating) return toast('请先停止当前生成');
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.conv = conv;
  state.editingId = null;
  exitGreetingMode();
  state.settings.activeConvId = id;
  saveSettingsSoon();
  showError('');
  renderConvSelect();
  renderMessages();
  scrollToBottom();
}

function renderConvSelect() {
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  els.convSelect.innerHTML = '';
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.title}　·　${c.messages.length} 条　·　${fmtTime(c.updatedAt)}`;
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
  return plain.slice(0, 20) || '新对话';
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
    hint.innerHTML = gm
      ? '正在编辑开场白。写好后点右下角的“重载”可以在这里预览效果。'
      : `在下方写下第一条消息，开始故事；也可以先点“添加开场白”。<br>
      <span class="small">消息支持 Markdown 和 HTML/CSS 美化，开场白还可以使用 JS。<br>
      右侧可以设置 System Prompt、世界观、你的角色和模型。</span>`;
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
    d.textContent = `↑ 以上${sentGreeting(conv) != null ? '开场白和' : ''} ${cutoff} 条消息超出记忆长度，模型看不到`;
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
    row.append(sendBox, ' 发送给模型（和你发送的第一条消息合并，作为第一条消息）');
    el.appendChild(row);
  }
  el.appendChild(actions);
  return { el, label, holder, actions, sendBox, frame: null, editor: null, shownText: null };
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
  v.label.textContent = it.greeting ? '开场白' : it.preview ? '开场白（预览，尚未保存）' : m.role === 'user' ? '你' : '剧情';
  if (isGen) v.label.textContent += ' · 生成中……';
  if (v.sendBox) v.sendBox.checked = conv.greetingSend !== false;

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

  // 内容。只有开场白（和它的预览）允许运行 JS
  const scripts = !!(it.greeting || it.preview);
  if (isGen) {
    if (!v.frame) { v.frame = Render.create('', { scripts }); v.holder.appendChild(v.frame); }
    v.shownText = null; // 生成结束后用完整内容再显示一次
    if (!text) Render.stream(v.frame, '', Render.thinkingHtml('等待模型回复……'));
  } else if (v.shownText !== text) {
    if (!v.frame) { v.frame = Render.create(text, { scripts }); v.holder.appendChild(v.frame); }
    else Render.set(v.frame, text);
    v.shownText = text;
  }

  // 操作按钮
  v.actions.innerHTML = '';
  if (editing || it.preview) return;
  if (it.greeting) {
    v.actions.append(
      button('复制', () => copyText(conv.greeting)),
      button('编辑', () => startEdit(GREETING_ID, conv.greeting)),
      disabled(button('删除开场白', deleteGreeting), busy),
    );
    return;
  }
  const isLast = it.i === conv.messages.length - 1;
  if (m.role === 'assistant' && m.versions.length > 1) {
    const sw = document.createElement('span');
    sw.className = 'swipe';
    const n = document.createElement('span');
    n.textContent = `${m.cur + 1}/${m.versions.length}`;
    sw.append(
      disabled(button('‹', () => switchVersion(m, -1)), busy, '上一个版本'),
      n,
      disabled(button('›', () => switchVersion(m, 1)), busy, '下一个版本'),
    );
    v.actions.appendChild(sw);
  }
  v.actions.appendChild(button('复制', () => copyText(msgText(m))));
  v.actions.appendChild(disabled(button('编辑', () => startEdit(m.id, msgText(m))), isGen));
  if (m.role === 'assistant' && isLast) {
    v.actions.appendChild(disabled(button('重新生成', () => regenerate(m)), busy, '生成一个新版本，旧版本会保留，可用 ‹ › 切换'));
  }
  if (m.role === 'assistant' && m.versions.length > 1) {
    v.actions.appendChild(disabled(button('删除此版本', () => deleteVersion(m)), busy));
  }
  v.actions.appendChild(disabled(button('回退到此前', () => rollback(it.i)), busy, '删除这条消息以及之后的所有消息'));
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
  row.append(button('取消', cancelEdit, 'btn btn-small btn-ghost'), button('保存（Ctrl+Enter）', saveEdit, 'btn btn-small btn-primary'));
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
  // “添加开场白”只在对话完全为空时出现
  els.btnAddGreeting.hidden = busy || gm || conv.greeting != null || msgs.length > 0;
  els.btnGreetingReload.hidden = !gm;
  els.btnGreetingConfirm.hidden = !gm;
  els.btnGreetingCancel.hidden = !gm;
  els.composer.classList.toggle('greeting-mode', gm);
  els.input.placeholder = gm
    ? '在这里编辑开场白，支持 Markdown、HTML、CSS 和 JS。点“重载”在上方预览，点“确认”保存。（Ctrl + Enter = 重载）'
    : '写下你的行动或对话……支持 Markdown 和 HTML（Ctrl + Enter 发送）';
  updateStatus();
}

function updateStatus() {
  if (state.generating) { els.status.textContent = '生成中……可以随时向上滚动阅读，点“停止”可中断。'; return; }
  if (state.greetingMode) { els.status.textContent = '正在编辑开场白：确认之前不会保存，也不会发给模型。'; return; }
  const s = state.settings;
  const sys = estimateTokens(buildSystem());
  els.status.textContent = `记忆：最近 ${s.rounds} 轮　·　每次固定发送设定约 ${sys.toLocaleString()} token（粗略估计）　·　模型：${s.models[s.provider] || '未设置'}`;
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

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已复制'); }
  catch (_) { toast('复制失败，请手动选择文字复制'); }
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
      if (!confirm('开场白为空，要删除开场白吗？')) return;
      state.conv.greeting = null;
    } else {
      state.conv.greeting = draft;
    }
  } else {
    const m = state.conv.messages.find((x) => x.id === id);
    if (m) m.versions[m.cur] = draft;
  }
  state.editingId = null;
  renderMessages();
  await saveConv();
  toast('已保存修改');
}

async function deleteGreeting() {
  if (!confirm('删除本对话的开场白？')) return;
  state.conv.greeting = null;
  if (state.editingId === GREETING_ID) state.editingId = null;
  renderMessages();
  await saveConv();
}

async function switchVersion(m, delta) {
  const n = m.versions.length;
  m.cur = (m.cur + delta + n) % n;
  renderMessages();
  await saveConv();
}

async function deleteVersion(m) {
  if (!confirm('删除当前显示的这个版本？')) return;
  m.versions.splice(m.cur, 1);
  m.cur = Math.min(m.cur, m.versions.length - 1);
  renderMessages();
  await saveConv();
}

async function rollback(i) {
  const msgs = state.conv.messages;
  const count = msgs.length - i;
  if (!confirm(`将删除这条消息以及之后的共 ${count} 条消息（包括它们的所有版本），确定吗？`)) return;
  const removed = msgs.splice(i);
  // 如果回退的是自己的消息，把它放回输入框方便修改后重发
  if (removed[0].role === 'user' && !els.input.value.trim()) els.input.value = msgText(removed[0]);
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
  if (state.conv) renderMessages();
}

// 重载：在聊天区显示渲染后的开场白，输入框内容不动
function reloadGreetingPreview() {
  if (!state.greetingMode) return;
  const text = els.input.value;
  if (!text.trim()) return toast('输入框还是空的');
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
  if (!text) return toast('输入框还是空的');
  const send = await choose('开场白', '开场白是否发送给模型？\n\n'
    + '· 发送：你之后发送的第一条消息会和开场白合并，作为第一条消息发给模型。\n'
    + '· 不发送：开场白只显示在聊天区，模型看不到它；你之后发送的第一条消息就是第一条消息。\n\n'
    + '之后也可以随时用开场白下方的勾选框更改。', [
    { label: '取消', value: null, ghost: true },
    { label: '不发送', value: 'no' },
    { label: '发送给模型', value: 'yes', primary: true },
  ]);
  if (!send || conv !== state.conv || !state.greetingMode) return;
  conv.greeting = text;
  conv.greetingSend = send === 'yes';
  if (conv.title === '新对话') conv.title = titleFrom(text);
  state.greetingMode = null;
  els.input.value = '';
  renderMessages();
  els.messages.scrollTop = 0;
  await saveConv();
  toast('开场白已保存');
}

async function send() {
  if (state.generating || state.greetingMode) return;
  const text = els.input.value.trim();
  if (!text) return;
  const conv = state.conv;

  conv.messages.push({ id: uid(), role: 'user', versions: [text], cur: 0 });
  if (conv.title === '新对话') conv.title = titleFrom(text);
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
  renderMessages();
  scrollToBottom();

  const ver = m.cur;
  let result = null;
  let error = null;
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

  try {
    result = await streamChat(providerCfg(), buildSystem(), windowOf(context, sentGreeting(conv)), {
      signal: controller.signal,
      onText: (t) => {
        m.versions[ver] += t;
        if (!pendingPaint) { pendingPaint = true; requestAnimationFrame(paint); }
      },
      onThinking: () => {
        const f = frame();
        if (f && !m.versions[ver]) Render.stream(f, '', Render.thinkingHtml('模型思考中……'));
      },
    });
  } catch (e) {
    if (e.name !== 'AbortError') error = e;
  }

  state.generating = null;
  const text = m.versions[ver];

  if (result && result.stopReason === 'refusal') {
    error = new Error('模型拒绝了这次请求（被安全机制拦截）。可以修改上一条消息后重试，或换一个模型。');
    m.versions[ver] = '';
  }

  // 没有生成出任何文字时，撤掉这个空版本
  if (!m.versions[ver]) {
    m.versions.splice(ver, 1);
    if (!m.versions.length) conv.messages.splice(conv.messages.indexOf(m), 1);
    else m.cur = m.versions.length - 1;
  }

  if (state.conv === conv) renderMessages();
  await saveConv(conv);

  if (error) showError(error.message);
  else if (result && (result.stopReason === 'max_tokens' || result.stopReason === 'length')) {
    showError('提示：回复达到了“最大输出长度”被截断。可以在右侧调大这个数值。');
  } else if (!text) toast('已停止');
}

function stop() {
  if (state.generating) state.generating.controller.abort();
}

// ---------------- 预览将要发送的内容 ----------------

function preview() {
  const msgs = state.conv.messages.slice();
  const pending = els.input.value.trim();
  const last = msgs[msgs.length - 1];
  let note;
  if (pending) {
    msgs.push({ role: 'user', versions: [pending], cur: 0 });
    note = '（包含输入框里尚未发送的内容）';
  } else if (last && last.role === 'user') {
    note = '（点击“生成回复”时发送的内容）';
  } else {
    msgs.push({ role: 'user', versions: ['<你下一次的回复>'], cur: 0 });
    note = '（最后一条用占位符代替你下一次的回复）';
  }
  const win = windowOf(msgs);
  const dropped = msgs.length - win.length;
  const system = buildSystem();
  const lines = [];
  lines.push(`说明 ${note}`);
  lines.push(`记忆长度 ${state.settings.rounds} 轮：发送最近 ${win.length} 条消息，${dropped > 0 ? `更早的 ${dropped} 条${sentGreeting(state.conv) != null ? '和开场白' : ''}不发送。` : '目前全部消息都在范围内。'}`);
  lines.push(`粗略估计共约 ${(estimateTokens(system) + win.reduce((a, m) => a + estimateTokens(m.content), 0)).toLocaleString()} token。`);
  lines.push('');
  lines.push('════════ system ════════');
  lines.push(system || '（空）');
  for (const m of win) {
    lines.push('');
    lines.push(`════════ ${m.role === 'user' ? 'user（你）' : 'assistant（模型）'} ════════`);
    lines.push(m.content);
  }
  showModal('下一次将发送给模型的内容', lines.join('\n'));
}

// ---------------- 艺术图 ----------------

async function loadArt() {
  const blob = await DB.get('art');
  if (state.artUrl) URL.revokeObjectURL(state.artUrl);
  state.artUrl = blob ? URL.createObjectURL(blob) : null;
  els.artImage.hidden = !blob;
  els.artPlaceholder.hidden = !!blob;
  if (blob) els.artImage.src = state.artUrl;
  else els.artImage.removeAttribute('src');
}

async function setArt(file) {
  if (!file || !file.type.startsWith('image/')) return toast('请选择图片文件');
  await DB.set('art', file);
  await loadArt();
  toast('艺术图已更新');
}

// ---------------- 导出与备份 ----------------

// 导出剧情：开场白 + 全部消息，不含 system 部分和艺术图
function exportText(markdown) {
  const conv = state.conv;
  if (!conv.messages.length && conv.greeting == null) return toast('当前对话还没有内容');
  const out = [];
  out.push(markdown ? `# ${conv.title}` : conv.title);
  out.push(markdown ? `*导出时间：${new Date().toLocaleString()}*` : `导出时间：${new Date().toLocaleString()}`);
  out.push('');
  if (conv.greeting != null) {
    out.push(markdown ? '### 开场白' : '【开场白】');
    out.push(conv.greeting);
    out.push('');
  }
  for (const m of conv.messages) {
    const who = m.role === 'user' ? '你' : '剧情';
    out.push(markdown ? `### ${who}` : `【${who}】`);
    out.push(msgText(m));
    out.push('');
  }
  download(`${safeFilename(conv.title)}.${markdown ? 'md' : 'txt'}`, out.join('\n'));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 世界卡：System Prompt、世界观、当前对话的开场白和艺术图（图片以文本形式存进 JSON）。
// 不含用户人设和剧情，方便分享或带着同一个世界重新开始。
async function exportWorldCard() {
  const s = state.settings;
  const conv = state.conv;
  const name = prompt('世界卡名称：', conv.title !== '新对话' ? conv.title : '');
  if (name === null) return;
  const art = await DB.get('art');
  const data = {
    app: 'proteus',
    type: 'worldcard',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: name.trim() || '未命名世界',
    systemPrompt: s.systemPrompt,
    worldText: s.worldText,
    greeting: conv.greeting != null ? conv.greeting : null,
    greetingSend: conv.greetingSend !== false,
    art: art ? await blobToDataURL(art) : null,
  };
  download(`${safeFilename(data.name)}-世界卡.json`, JSON.stringify(data, null, 2), 'application/json');
}

// 完整备份：所有设定（不含 API Key）、所有对话和艺术图
async function backup() {
  const settings = { ...state.settings, apiKeys: {} };
  const art = await DB.get('art');
  const data = {
    app: 'proteus',
    type: 'backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    conversations: state.conversations,
    art: art ? await blobToDataURL(art) : null,
  };
  download(`proteus-完整备份-${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function exportMenu() {
  const choice = await choose('导出 / 备份', '· 导出剧情：当前对话的开场白和全部消息，不含 System Prompt、世界观、人设和艺术图。\n'
    + '· 世界卡：System Prompt、世界观、当前对话的开场白和艺术图，不含用户人设和剧情。适合分享，或带着同一个世界重新开始。\n'
    + '· 完整备份：所有设定、所有对话和艺术图（不含 API Key），用于换电脑或防止数据丢失。', [
    { label: '取消', value: null, ghost: true },
    { label: '剧情（TXT）', value: 'txt' },
    { label: '剧情（Markdown）', value: 'md' },
    { label: '世界卡', value: 'card' },
    { label: '完整备份', value: 'full', primary: true },
  ]);
  if (choice === 'txt') exportText(false);
  else if (choice === 'md') exportText(true);
  else if (choice === 'card') await exportWorldCard();
  else if (choice === 'full') await backup();
}

async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

// 读取世界卡或完整备份（剧情导出是 TXT/Markdown，不能读回）
async function restore(file) {
  if (state.generating) return toast('请先停止当前生成');
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { return toast('文件不是有效的 JSON'); }
  if (!data || data.app !== 'proteus') return toast('文件不是 Proteus 的世界卡或备份');

  if (data.type === 'worldcard') {
    if (!confirm(`读取世界卡「${data.name || '未命名世界'}」：\n\n`
      + '· 替换当前的 System Prompt、世界观和艺术图（所有对话共用这一套设定）\n'
      + '· 用卡里的开场白新建一个对话\n'
      + '· 用户人设和已有对话保留不变\n\n确定吗？')) return;
    const s = state.settings;
    s.systemPrompt = typeof data.systemPrompt === 'string' ? data.systemPrompt : s.systemPrompt;
    s.worldText = typeof data.worldText === 'string' ? data.worldText : '';
    await DB.set('settings', s);
    if (data.art) await DB.set('art', await dataURLToBlob(data.art));
    else await DB.del('art');
    const c = newConversation();
    if (typeof data.greeting === 'string') {
      c.greeting = data.greeting;
      c.greetingSend = data.greetingSend !== false;
    }
    c.title = data.name || (c.greeting ? titleFrom(c.greeting) : '新对话');
    state.conversations.push(c);
    await DB.putConversation(c);
    fillSettingsForm();
    await loadArt();
    await switchConv(c.id);
    els.messages.scrollTop = 0;
    toast('世界卡已读取');
    return;
  }

  if (!Array.isArray(data.conversations)) return toast('文件不是 Proteus 的世界卡或备份');
  if (!confirm(`备份里有 ${data.conversations.length} 个对话。恢复会替换当前所有对话和设定（API Key 保留不变），确定吗？`)) return;
  const keys = state.settings.apiKeys;
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings, apiKeys: keys };
  await DB.set('settings', state.settings);
  await DB.clearConversations();
  for (const c of data.conversations) await DB.putConversation(c);
  if (data.art) await DB.set('art', await dataURLToBlob(data.art));
  else await DB.del('art');
  await boot();
  toast('已从备份恢复');
}

// ---------------- 布局：拖动调整左栏宽度和输入框高度 ----------------

function artBounds() {
  const w = window.innerWidth;
  // 最宽不超过窗口的 45%，并且给聊天区留出至少 480px
  return { min: 160, max: Math.max(160, Math.min(w * 0.45, w - 340 - 480)) };
}

function inputBounds() {
  const h = els.chatPane.getBoundingClientRect().height || window.innerHeight;
  return { min: 48, max: Math.max(48, h - 220) };
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

function bindLayout() {
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

function fillSettingsForm() {
  const s = state.settings;
  els.systemPrompt.value = s.systemPrompt;
  els.worldText.value = s.worldText;
  els.persona.value = s.persona;
  els.rounds.value = s.rounds;
  els.provider.value = s.provider;
  els.effort.value = s.effort;
  els.useTemperature.checked = s.useTemperature;
  els.temperature.value = s.temperature;
  fillProviderFields();
  updateWorldCount();
}

function fillProviderFields() {
  const s = state.settings;
  const p = PROVIDERS[s.provider];
  els.baseUrl.value = s.baseUrls[s.provider] || '';
  els.baseUrl.placeholder = p.baseUrl || '例如 https://api.deepseek.com/v1';
  els.apiKey.value = s.apiKeys[s.provider] || '';
  els.model.value = s.models[s.provider] || '';
  els.maxTokens.value = s.maxTokens[s.provider] || '';
  els.maxTokens.placeholder = p.format === 'anthropic' ? '默认 8192' : '留空 = 接口默认';
  els.modelList.innerHTML = p.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  els.anthropicOptions.hidden = p.format !== 'anthropic';
  els.openaiOptions.hidden = p.format !== 'openai';
  els.temperature.disabled = !s.useTemperature;
}

function updateWorldCount() {
  const t = state.settings.worldText;
  els.worldCount.textContent = t ? `${t.length.toLocaleString()} 字 · 约 ${estimateTokens(t).toLocaleString()} token` : '';
}

function bindSettings() {
  const s = () => state.settings;
  const onInput = (el, fn) => el.addEventListener('input', () => { fn(el); saveSettingsSoon(); updateStatus(); });

  onInput(els.systemPrompt, (el) => { s().systemPrompt = el.value; });
  onInput(els.worldText, (el) => { s().worldText = el.value; updateWorldCount(); });
  onInput(els.persona, (el) => { s().persona = el.value; });
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
  onInput(els.baseUrl, (el) => { s().baseUrls[s().provider] = el.value.trim(); });
  onInput(els.apiKey, (el) => { s().apiKeys[s().provider] = el.value.trim(); });
  onInput(els.model, (el) => { s().models[s().provider] = el.value.trim(); });
  onInput(els.maxTokens, (el) => { s().maxTokens[s().provider] = el.value ? Number(el.value) : ''; });
  onInput(els.temperature, (el) => { s().temperature = Number(el.value); });
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

  els.btnResetSystem.addEventListener('click', () => {
    if (!confirm('把 System Prompt 恢复为默认内容？')) return;
    s().systemPrompt = DEFAULT_SYSTEM_PROMPT;
    els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
    saveSettingsSoon();
    updateStatus();
  });

  els.btnUploadWorld.addEventListener('click', () => els.fileWorld.click());
  els.fileWorld.addEventListener('change', async () => {
    const f = els.fileWorld.files[0];
    els.fileWorld.value = '';
    if (!f) return;
    if (!/\.(txt|md)$/i.test(f.name)) return toast('只支持 .txt 或 .md 纯文本文件');
    const text = await f.text();
    if (s().worldText.trim() && !confirm('用这个文件替换当前的世界观内容？')) return;
    s().worldText = text;
    els.worldText.value = text;
    updateWorldCount();
    saveSettingsSoon();
    updateStatus();
    toast(`已载入 ${f.name}`);
  });
  els.btnClearWorld.addEventListener('click', () => {
    if (!s().worldText || !confirm('清空世界观内容？')) return;
    s().worldText = '';
    els.worldText.value = '';
    updateWorldCount();
    saveSettingsSoon();
    updateStatus();
  });

  els.btnToggleKey.addEventListener('click', () => {
    const show = els.apiKey.type === 'password';
    els.apiKey.type = show ? 'text' : 'password';
    els.btnToggleKey.textContent = show ? '隐藏' : '显示';
  });

  els.btnFetchModels.addEventListener('click', async () => {
    els.btnFetchModels.disabled = true;
    try {
      const list = await fetchModels(providerCfg());
      els.modelList.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      toast(`获取到 ${list.length} 个模型，点击模型输入框即可选择`);
    } catch (e) {
      showModal('获取模型列表失败', e.message);
    } finally {
      els.btnFetchModels.disabled = false;
    }
  });

  els.btnPreview.addEventListener('click', preview);

  const pickArt = () => els.fileArt.click();
  els.artPane.addEventListener('click', pickArt);
  els.btnUploadArt.addEventListener('click', pickArt);
  els.fileArt.addEventListener('change', async () => {
    const f = els.fileArt.files[0];
    els.fileArt.value = '';
    if (f) await setArt(f);
  });
  els.btnRemoveArt.addEventListener('click', async () => {
    await DB.del('art');
    await loadArt();
  });

  els.btnExport.addEventListener('click', exportMenu);
  els.btnRestore.addEventListener('click', () => els.fileRestore.click());
  els.fileRestore.addEventListener('change', async () => {
    const f = els.fileRestore.files[0];
    els.fileRestore.value = '';
    if (f) await restore(f);
  });
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
  els.btnNewConv.addEventListener('click', async () => {
    if (state.generating) return toast('请先停止当前生成');
    const c = newConversation();
    state.conversations.push(c);
    await DB.putConversation(c);
    await switchConv(c.id);
    els.input.focus();
  });
  els.btnRenameConv.addEventListener('click', async () => {
    const t = prompt('对话名称：', state.conv.title);
    if (t === null || !t.trim()) return;
    state.conv.title = t.trim();
    await saveConv();
  });
  els.btnDeleteConv.addEventListener('click', async () => {
    if (state.generating) return toast('请先停止当前生成');
    if (!confirm(`删除对话「${state.conv.title}」？此操作无法撤销。`)) return;
    await DB.deleteConversation(state.conv.id);
    state.conversations = state.conversations.filter((c) => c !== state.conv);
    if (!state.conversations.length) {
      const c = newConversation();
      state.conversations.push(c);
      await DB.putConversation(c);
    }
    const next = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    await switchConv(next.id);
  });

  els.btnModalClose.addEventListener('click', () => { els.modal.hidden = true; });
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.modal.hidden = true; });

  window.addEventListener('beforeunload', (e) => {
    if (state.generating) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------------- 启动 ----------------

async function boot() {
  const saved = (await DB.get('settings')) || {};
  state.settings = { ...DEFAULT_SETTINGS, ...saved };
  for (const k of ['apiKeys', 'baseUrls', 'models', 'maxTokens']) {
    state.settings[k] = { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) };
  }
  if (!PROVIDERS[state.settings.provider]) state.settings.provider = 'anthropic';
  state.settings.rounds = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Number(state.settings.rounds) || 12));

  state.conversations = await DB.listConversations();
  if (!state.conversations.length) {
    const c = newConversation();
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
  fillSettingsForm();
  renderConvSelect();
  renderMessages();
  scrollToBottom();
  await loadArt();
}

function init() {
  for (const el of document.querySelectorAll('[id]')) els[el.id] = el;
  els.provider.innerHTML = Object.entries(PROVIDERS)
    .map(([k, p]) => `<option value="${k}">${escapeHtml(p.label)}</option>`).join('');
  bindSettings();
  bindChat();
  bindLayout();
  // 消息高度变化时（内容载入、图片加载、展开 <details> 等），如果停留在底部就继续贴底
  Render.onResize(() => { if (state.follow) els.messages.scrollTop = els.messages.scrollHeight; });
  boot().catch((e) => {
    console.error(e);
    showError('读取本地数据失败：' + e.message + '\n如果是在隐私/无痕模式下打开，浏览器可能禁止了本地存储。');
  });
}

document.addEventListener('DOMContentLoaded', init);
