// 主程序：界面、对话管理、上下文拼装。

const DEFAULT_SYSTEM_PROMPT = `你是一名角色扮演叙事者。根据下方的世界观设定推进剧情，扮演世界中除用户角色以外的所有角色，并描写环境与事件。
- 始终与世界观设定保持一致。
- 不要替用户角色说话、行动或做决定。
- 每次回复描写场景、其他角色的言行与事件发展，篇幅适中，结尾给用户留出行动的空间。
- 使用中文写作。`;

const DEFAULT_SETTINGS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  worldText: '',
  persona: '',
  rounds: 12,
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

// 简单排版：**粗体**、*斜体*（常用来写动作）
function formatText(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
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

// 从一串消息中取出要发送的部分：最后一条（用户这次的回复）+ 之前的 N 轮（2N 条）
function windowOf(messages) {
  const keep = state.settings.rounds * 2 + 1;
  return messages.slice(-keep).map((m) => ({ role: m.role, content: msgText(m) }));
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
  return { id: uid(), title: '新对话', createdAt: now, updatedAt: now, messages: [] };
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

// ---------------- 消息渲染 ----------------

function renderMessages() {
  const box = els.messages;
  box.innerHTML = '';
  const msgs = state.conv.messages;
  if (!msgs.length) {
    box.innerHTML = `<div class="empty-hint">在下方写下第一条消息，开始故事。<br>
      <span class="small">右侧可以设置 System Prompt、世界观、你的角色和模型。</span></div>`;
    updateComposer();
    return;
  }
  const cutoff = memoryCutoff();
  msgs.forEach((m, i) => {
    if (i === cutoff && cutoff > 0) {
      const d = document.createElement('div');
      d.className = 'memory-divider';
      d.textContent = `↑ 以上 ${cutoff} 条超出记忆长度，模型看不到`;
      box.appendChild(d);
    }
    const el = renderMessage(m, i);
    if (i < cutoff) el.classList.add('forgotten');
    box.appendChild(el);
  });
  updateComposer();
}

function renderMessage(m, i) {
  const msgs = state.conv.messages;
  const isLast = i === msgs.length - 1;
  const busy = !!state.generating;
  const isGen = busy && state.generating.msgId === m.id;

  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  el.dataset.id = m.id;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = m.role === 'user' ? '你' : '剧情';
  el.appendChild(label);

  if (state.editingId === m.id) {
    el.classList.add('editing');
    const wrap = document.createElement('div');
    wrap.className = 'msg-edit';
    const ta = document.createElement('textarea');
    ta.value = state.editDraft;
    ta.addEventListener('input', () => { state.editDraft = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); saveEdit(m); }
      if (e.key === 'Escape') cancelEdit();
    });
    const row = document.createElement('div');
    row.className = 'row';
    row.append(button('取消', cancelEdit, 'btn btn-small btn-ghost'), button('保存（Ctrl+Enter）', () => saveEdit(m), 'btn btn-small btn-primary'));
    wrap.append(ta, row);
    el.appendChild(wrap);
    setTimeout(() => { ta.focus(); ta.style.height = Math.min(ta.scrollHeight + 4, window.innerHeight * 0.6) + 'px'; }, 0);
    return el;
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  const text = msgText(m);
  if (isGen && !text) {
    body.innerHTML = '<span class="thinking">等待模型回复……</span>';
    body.classList.add('pending');
  } else {
    body.innerHTML = formatText(text);
    if (isGen) body.classList.add('pending');
  }
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (m.role === 'assistant' && m.versions.length > 1) {
    const sw = document.createElement('span');
    sw.className = 'swipe';
    const prev = button('‹', () => switchVersion(m, -1));
    const next = button('›', () => switchVersion(m, 1));
    prev.title = '上一个版本';
    next.title = '下一个版本';
    prev.disabled = next.disabled = busy;
    const n = document.createElement('span');
    n.textContent = `${m.cur + 1}/${m.versions.length}`;
    sw.append(prev, n, next);
    actions.appendChild(sw);
  }

  actions.appendChild(button('复制', () => copyText(msgText(m))));
  const edit = button('编辑', () => startEdit(m));
  edit.disabled = isGen;
  actions.appendChild(edit);
  if (m.role === 'assistant' && isLast) {
    const regen = button('重新生成', () => regenerate(m));
    regen.disabled = busy;
    regen.title = '生成一个新版本，旧版本会保留，可用 ‹ › 切换';
    actions.appendChild(regen);
  }
  if (m.role === 'assistant' && m.versions.length > 1) {
    const delVer = button('删除此版本', () => deleteVersion(m));
    delVer.disabled = busy;
    actions.appendChild(delVer);
  }
  const back = button('回退到此前', () => rollback(i));
  back.disabled = busy;
  back.title = '删除这条消息以及之后的所有消息';
  actions.appendChild(back);

  el.appendChild(actions);
  return el;
}

function button(text, onClick, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function bodyOf(msgId) {
  return els.messages.querySelector(`.msg[data-id="${CSS.escape(msgId)}"] .msg-body`);
}

function updateComposer() {
  const busy = !!state.generating;
  els.btnSend.hidden = busy;
  els.btnStop.hidden = !busy;
  const msgs = state.conv.messages;
  const last = msgs[msgs.length - 1];
  els.btnReply.hidden = busy || !(last && last.role === 'user');
  updateStatus();
}

function updateStatus() {
  if (state.generating) { els.status.textContent = '生成中……可以随时向上滚动阅读，点“停止”可中断。'; return; }
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

function startEdit(m) {
  state.editingId = m.id;
  state.editDraft = msgText(m);
  renderMessages();
}

function cancelEdit() {
  state.editingId = null;
  renderMessages();
}

async function saveEdit(m) {
  m.versions[m.cur] = state.editDraft;
  state.editingId = null;
  renderMessages();
  await saveConv();
  toast('已保存修改');
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

async function send() {
  if (state.generating) return;
  const text = els.input.value.trim();
  if (!text) return;
  const conv = state.conv;
  conv.messages.push({ id: uid(), role: 'user', versions: [text], cur: 0 });
  if (conv.title === '新对话') conv.title = text.replace(/\s+/g, ' ').slice(0, 20);
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
  let pendingRender = false;

  const paint = () => {
    pendingRender = false;
    if (state.conv !== conv) return;
    const body = bodyOf(m.id);
    if (!body) return;
    body.innerHTML = formatText(m.versions[ver]);
    // 只有用户停留在底部时才跟随滚动；向上翻阅时不打扰
    if (state.follow) els.messages.scrollTop = els.messages.scrollHeight;
  };

  try {
    result = await streamChat(providerCfg(), buildSystem(), windowOf(context), {
      signal: controller.signal,
      onText: (t) => {
        m.versions[ver] += t;
        if (!pendingRender) { pendingRender = true; requestAnimationFrame(paint); }
      },
      onThinking: () => {
        const body = bodyOf(m.id);
        if (body && !m.versions[ver]) body.innerHTML = '<span class="thinking">模型思考中……</span>';
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
  if (state.follow) scrollToBottom();
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
  lines.push(`记忆长度 ${state.settings.rounds} 轮：发送最近 ${win.length} 条消息，${dropped > 0 ? `更早的 ${dropped} 条不发送。` : '目前全部消息都在范围内。'}`);
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

function exportText(markdown) {
  const conv = state.conv;
  if (!conv.messages.length) return toast('当前对话还没有内容');
  const out = [];
  out.push(markdown ? `# ${conv.title}` : conv.title);
  out.push(markdown ? `*导出时间：${new Date().toLocaleString()}*` : `导出时间：${new Date().toLocaleString()}`);
  out.push('');
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

async function backup() {
  const settings = { ...state.settings, apiKeys: {} }; // 不导出 API Key
  const art = await DB.get('art');
  const data = {
    app: 'proteus',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    conversations: state.conversations,
    art: art ? await blobToDataURL(art) : null,
  };
  const d = new Date();
  download(`proteus-备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`,
    JSON.stringify(data, null, 2), 'application/json');
}

async function restore(file) {
  if (state.generating) return toast('请先停止当前生成');
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { return toast('文件不是有效的备份'); }
  if (!data || data.app !== 'proteus' || !Array.isArray(data.conversations)) return toast('文件不是有效的 Proteus 备份');
  if (!confirm(`备份里有 ${data.conversations.length} 个对话。恢复会替换当前所有对话和设定（API Key 保留不变），确定吗？`)) return;
  const keys = state.settings.apiKeys;
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings, apiKeys: keys };
  await DB.set('settings', state.settings);
  await DB.clearConversations();
  for (const c of data.conversations) await DB.putConversation(c);
  if (data.art) {
    const blob = await (await fetch(data.art)).blob();
    await DB.set('art', blob);
  } else {
    await DB.del('art');
  }
  await boot();
  toast('已从备份恢复');
}

// ---------------- 右侧设置面板 ----------------

function fillSettingsForm() {
  const s = state.settings;
  els.systemPrompt.value = s.systemPrompt;
  els.worldText.value = s.worldText;
  els.persona.value = s.persona;
  els.rounds.value = s.rounds;
  els.roundsValue.textContent = s.rounds;
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
  onInput(els.rounds, (el) => {
    s().rounds = Number(el.value);
    els.roundsValue.textContent = el.value;
    if (!state.editingId) renderMessages();
  });
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

  els.btnExportTxt.addEventListener('click', () => exportText(false));
  els.btnExportMd.addEventListener('click', () => exportText(true));
  els.btnBackup.addEventListener('click', backup);
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
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send(); }
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

  state.conversations = await DB.listConversations();
  if (!state.conversations.length) {
    const c = newConversation();
    state.conversations.push(c);
    await DB.putConversation(c);
  }
  state.conv = state.conversations.find((c) => c.id === state.settings.activeConvId)
    || [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  state.settings.activeConvId = state.conv.id;

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
  boot().catch((e) => {
    console.error(e);
    showError('读取本地数据失败：' + e.message + '\n如果是在隐私/无痕模式下打开，浏览器可能禁止了本地存储。');
  });
}

document.addEventListener('DOMContentLoaded', init);
