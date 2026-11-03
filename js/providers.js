// 和各家模型接口通信。服务商的显示名称在 i18n.js 里（provider.<键名>）。支持两种格式：
//   - Anthropic 格式（Claude 官方，以及兼容它的中转站）
//   - OpenAI 格式（OpenAI 官方、Gemini、OpenRouter、DeepSeek 和大多数中转站）
// 所有请求都用流式输出，文字会一边生成一边显示。

const PROVIDERS = {
  anthropic: {
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  },
  openai: {
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    format: 'openai', // 使用 Gemini 提供的 OpenAI 兼容接口
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  custom_openai: {
    format: 'openai',
    baseUrl: '',
  },
  custom_anthropic: {
    format: 'anthropic',
    baseUrl: '',
  },
};

const ANTHROPIC_VERSION = '2026-10-21';
// 这些 Claude 模型在官方接口上支持“被安全分类器拒绝时自动换模型重试”。
const ANTHROPIC_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

function trimSlash(url) {
  // 不用正则 /\/+$/：很多个 / 后面不是结尾时，它会反复回溯
  let s = (url || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// 把可能出现的“连续两条同一角色”的消息合并，避免接口报错。
function mergeSameRole(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

// 实际使用的接口地址（没填时用服务商的默认地址）
function baseOf(cfg) {
  return trimSlash(cfg.baseUrl || PROVIDERS[cfg.provider].baseUrl);
}

// 最终发送的消息列表：合并连续同一角色的消息；Anthropic 要求第一条必须是用户消息，开头不是时补“前情省略”
function finalMessages(format, messages) {
  const msgs = mergeSameRole(messages);
  if (format === 'anthropic' && msgs.length && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: t('greet.omitted') });
  return msgs;
}

// ---- 用量 ----
// OpenAI 格式的流式回复默认不带用量，要在请求里加 stream_options.include_usage。
// 个别接口不认这个参数会报错：这时去掉它重发一次，成功就记住这个接口地址，以后不再加
const NO_USAGE_OPTION_KEY = 'proteus.noStreamOptions';
const noUsageOption = new Set();
try { for (const b of JSON.parse(localStorage.getItem(NO_USAGE_OPTION_KEY) || '[]')) noUsageOption.add(b); } catch (_) { /* 读不到就从头记 */ }

function rememberNoUsageOption(base) {
  if (noUsageOption.has(base)) return;
  noUsageOption.add(base);
  try { localStorage.setItem(NO_USAGE_OPTION_KEY, JSON.stringify([...noUsageOption])); } catch (_) { /* 只在这次打开期间记住 */ }
}

function forgetNoUsageOption() {
  noUsageOption.clear();
  try { localStorage.removeItem(NO_USAGE_OPTION_KEY); } catch (_) { /* 本来就没存 */ }
}

// 接口报告的用量 → { input, output }（没有的项为 0）。
// Anthropic 格式的 input_tokens 不含缓存部分，要加上写入和读取缓存的 token；OpenAI 格式的 prompt_tokens 已经包含缓存
function usageOf(u, format) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  if (format === 'anthropic') {
    return {
      input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
      output: n(u.output_tokens),
    };
  }
  // 有的中转站在 OpenAI 格式里也用 input_tokens / output_tokens 的名字
  return { input: n(u.prompt_tokens) || n(u.input_tokens), output: n(u.completion_tokens) || n(u.output_tokens) };
}

// 组装真正发给接口的请求（不发送，只返回 url / headers / body），方便“预览”功能复用。
function buildRequest(cfg, system, messages) {
  const provider = PROVIDERS[cfg.provider];
  const base = baseOf(cfg);
  if (!base) throw new Error(t('api.needBaseUrl'));
  if (!cfg.model) throw new Error(t('api.needModel'));
  const msgs = finalMessages(provider.format, messages);

  if (provider.format === 'anthropic') {
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens || 8192,
      stream: true,
      messages: msgs,
    };
    if (system) body.system = system;
    if (cfg.effort) body.output_config = { effort: cfg.effort };
    const headers = {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // 允许浏览器直接调用接口（否则会被浏览器的跨域限制拦下）
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const official = base === PROVIDERS.anthropic.baseUrl;
    if (official && ANTHROPIC_FALLBACK_MODELS.includes(cfg.model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    return { format: 'anthropic', base, url: base + '/v1/messages', headers, body };
  }

  // OpenAI 格式
  const body = {
    model: cfg.model,
    stream: true,
    messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs,
  };
  if (!noUsageOption.has(base)) body.stream_options = { include_usage: true };
  if (cfg.maxTokens) {
    // OpenAI 官方的新模型用 max_completion_tokens，其他兼容接口大多仍用 max_tokens
    if (cfg.provider === 'openai') body.max_completion_tokens = cfg.maxTokens;
    else body.max_tokens = cfg.maxTokens;
  }
  if (cfg.useTemperature) body.temperature = Number(cfg.temperature);
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + cfg.apiKey,
  };
  // OpenRouter 没有单独的选项，按接口地址认出来，带上应用名
  if (/^https:\/\/openrouter\.ai\//i.test(base)) headers['X-Title'] = 'Proteus';
  return { format: 'openai', base, url: base + '/chat/completions', headers, body };
}

async function readError(res) {
  return errorFrom(res.status, await res.text().catch(() => ''));
}

// 由状态码和接口返回的原文组成错误信息
function errorFrom(status, text) {
  let msg = text;
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0] || {}; // Gemini 的错误信息包在数组里
    msg = (j.error && (j.error.message || j.error.type)) || j.message || text;
  } catch (_) { /* 不是 JSON，直接用原文 */ }
  const hint = [400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 504, 529].includes(status) ? t('api.' + status) : '';
  return new Error(`HTTP ${status}${hint ? ' — ' + hint : ''}\n${String(msg).slice(0, 600)}`);
}

// 逐行读取服务器推送的流（SSE），每拿到一个 data 就回调一次；onRaw 收到原始文字（记日志用）。
// 返回是否读到过 data 行（没有的话可能是非流式回复）
async function readSSE(res, onData, onRaw) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let seen = false;
  // 处理一行，返回 true 表示流已结束
  const handle = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) return false; // 忽略 event: 行、注释行、空行
    const data = line.slice(5).trim();
    if (!data) return false;
    seen = true;
    if (data === '[DONE]') return true;
    let json;
    try { json = JSON.parse(data); } catch (_) { return false; }
    onData(json);
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (onRaw) onRaw(chunk);
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (handle(line)) return seen;
      }
    }
    // 最后一行后面可能没有换行
    const tail = decoder.decode();
    if (onRaw && tail) onRaw(tail);
    buf += tail;
    if (buf) handle(buf);
    return seen;
  } finally {
    // 提前结束（[DONE] 或接口返回错误）时断开连接，不在后台继续接收
    reader.cancel().catch(() => {});
  }
}

// 最近一次对话请求的记录：实际发送的请求和收到的原始回复，供导出日志用。只在内存里，不保存
let lastExchange = null;
const LOG_MAX = 4 * 1024 * 1024; // 原始回复最多记 4 MB

// 非流式回复：从完整的 JSON 里取出正文和用量，返回结束原因
function readWhole(j, onText, onUsage) {
  if (j.error) throw new Error(t('api.errorEvent') + (j.error.message || JSON.stringify(j.error)));
  const join = (parts) => parts.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  const anthropic = Array.isArray(j.content);
  const usage = usageOf(j.usage, anthropic ? 'anthropic' : 'openai');
  if (usage && onUsage) onUsage(usage);
  if (anthropic) { // Anthropic 格式
    const text = join(j.content);
    if (text) onText(text);
    return j.stop_reason || null;
  }
  const choice = j.choices && j.choices[0]; // OpenAI 格式
  if (!choice) return null;
  const content = choice.message && choice.message.content;
  const text = Array.isArray(content) ? join(content) : content;
  if (typeof text === 'string' && text) onText(text);
  return choice.finish_reason || null;
}

// ---- 安卓版：绕过跨域限制 ----
// 安卓版开启了 Capacitor 的原生请求（capacitor.config.json 里的 CapacitorHttp）：window.fetch 被换成由
// 原生代码发请求的版本，不受跨域限制，但要等整个回复生成完才一次性返回，也不理会“停止”。
// 原来的 WebView fetch 保存在 window.CapacitorWebFetch。
// 所以对话请求先用 WebView 发（文字边生成边显示）；连不上（跨域被拦就是这样）时改用原生请求重发一次，
// 并记住这个接口地址，以后直接用原生请求。获取模型列表直接用原生请求（它本来就不是流式的）。
const NATIVE_ORIGINS_KEY = 'proteus.nativeHttpOrigins';
const nativeOrigins = new Set();
try { for (const o of JSON.parse(localStorage.getItem(NATIVE_ORIGINS_KEY) || '[]')) nativeOrigins.add(o); } catch (_) { /* 读不到就从头记 */ }

function rememberNativeOrigin(origin) {
  if (nativeOrigins.has(origin)) return;
  nativeOrigins.add(origin);
  try { localStorage.setItem(NATIVE_ORIGINS_KEY, JSON.stringify([...nativeOrigins])); } catch (_) { /* 只在这次打开期间记住 */ }
}

// 忘掉记住的接口地址（“清除软件数据”时调用）
function forgetNativeOrigins() {
  nativeOrigins.clear();
  try { localStorage.removeItem(NATIVE_ORIGINS_KEY); } catch (_) { /* 本来就没存 */ }
}

// 原生请求不理会 signal：点“停止”时不再等它，直接按中止处理（原生请求在后台结束，结果丢弃）
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// 发送对话请求，返回 { res, native }。native 表示用的是原生请求（回复一次性返回）
async function postChat(url, init, signal) {
  if (!window.CapacitorWebFetch) return { res: await fetch(url, init), native: false };
  const origin = new URL(url).origin;
  if (!nativeOrigins.has(origin)) {
    try {
      return { res: await window.CapacitorWebFetch(url, init), native: false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 连不上：可能是跨域被拦，也可能是网络问题。用原生请求再试一次，成功才记住
    }
  }
  const res = await abortable(fetch(url, init), signal);
  rememberNativeOrigin(origin);
  return { res, native: true };
}

// 发送一次对话请求。onText(增量文字) 会被多次调用；onUsage({ input, output }) 在收到接口报告的用量时调用
// （可能多次，以最后一次为准；中途停止或出错时也可能已经收到了输入用量）。
// 返回 { stopReason }。
async function streamChat(cfg, system, messages, { signal, onText, onThinking, onUsage }) {
  const req = buildRequest(cfg, system, messages);
  if (!cfg.apiKey) throw new Error(t('api.needKey'));
  const log = lastExchange = { time: new Date(), request: { method: 'POST', url: req.url, headers: req.headers, body: req.body }, response: null, error: null };
  const record = (s) => { if (log.response.body.length < LOG_MAX) log.response.body += s; };
  const post = async (body) => {
    try {
      const sent = await postChat(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body), signal }, signal);
      if (sent.native) log.request.via = 'native';
      return sent.res;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(t('api.connectFailed') + '\n' + e.message);
    }
  };
  try {
    let res = await post(req.body);
    // 请求里加了 stream_options 而接口说请求有误：可能是不认这个参数，去掉再发一次
    if (!res.ok && req.body.stream_options && (res.status === 400 || res.status === 422)) {
      // 日志里记下第一次的回复，便于排查
      log.request.retry = { status: res.status, text: (await res.text().catch(() => '')).slice(0, 2000) };
      const body = { ...req.body };
      delete body.stream_options;
      res = await post(body);
      log.request.body = body;
      if (res.ok) rememberNoUsageOption(req.base);
    }
    const type = res.headers.get('content-type') || '';
    log.response = { status: res.status, contentType: type, body: '' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      record(text);
      throw errorFrom(res.status, text);
    }

    let stopReason = null;
    // 用量可能分几次报告（Anthropic：开头报告输入，结尾报告输出），每项保留最后一次非零的值
    const usage = { input: 0, output: 0 };
    const gotUsage = (u) => {
      const x = usageOf(u, req.format);
      if (!x || (!x.input && !x.output)) return;
      if (x.input) usage.input = x.input;
      if (x.output) usage.output = x.output;
      if (onUsage) onUsage({ ...usage });
    };
    const onEvent = req.format === 'anthropic'
      ? (ev) => {
        if (ev.type === 'message_start' && ev.message) gotUsage(ev.message.usage);
        else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') onThinking && onThinking();
        else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
        else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          gotUsage(ev.usage);
        } else if (ev.type === 'error') throw new Error(t('api.errorEvent') + ((ev.error && ev.error.message) || JSON.stringify(ev)));
      }
      : (ev) => {
        if (ev.error) throw new Error(t('api.errorEvent') + (ev.error.message || JSON.stringify(ev.error)));
        gotUsage(ev.usage); // 一般在最后一块（choices 为空），有的接口每一块都带
        const choice = ev.choices && ev.choices[0];
        if (!choice) return;
        const d = choice.delta || {};
        if (d.content) onText(d.content);
        else if (d.reasoning_content || d.reasoning) onThinking && onThinking();
        if (choice.finish_reason) stopReason = choice.finish_reason;
      };
    // 请求的是流式回复；有的中转站不支持流式，直接回一整段 JSON（非流式回复），这时整段解析
    let streamed = false;
    if (/application\/json/i.test(type)) record(await res.text());
    else streamed = await readSSE(res, onEvent, record);
    if (!streamed) {
      let j = null;
      try { j = JSON.parse(log.response.body); } catch (_) { /* 不是 JSON：当作没有内容 */ }
      if (j && typeof j === 'object') stopReason = readWhole(j, onText, onUsage);
    }
    return { stopReason };
  } catch (e) {
    log.error = e.name === 'AbortError' ? 'AbortError' : e.message;
    throw e;
  }
}

// 获取模型列表
async function fetchModels(cfg) {
  const provider = PROVIDERS[cfg.provider];
  const base = baseOf(cfg);
  if (!base) throw new Error(t('api.needBaseUrl'));
  let url, headers;
  if (provider.format === 'anthropic') {
    url = base + '/v1/models?limit=100';
    headers = {
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  } else {
    url = base + '/models';
    headers = cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {};
  }
  let res;
  try { res = await fetch(url, { headers }); } catch (e) {
    throw new Error(t('api.connectFailedShort') + e.message);
  }
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  const list = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
    .map((id) => id.replace(/^models\//, '')); // Gemini 的模型名带有 models/ 前缀，去掉后也能用
  return list.sort();
}
