// 和各家模型接口通信。服务商的显示名称在 i18n.js 里（provider.<键名>）。支持两种格式：
//   - Anthropic 格式（Claude 官方，以及兼容它的中转站）
//   - OpenAI 格式（OpenAI 官方、Gemini、OpenRouter、DeepSeek 和大多数中转站）
// 所有请求都用流式输出，文字会一边生成一边显示。
//
// 内置的服务商（PROVIDERS）接口地址固定，界面上只显示、不能改；用户自己添加的服务商（relay:<id>）地址自己填。
// 内置服务商的字段：
//   format       请求格式
//   baseUrl      接口地址
//   claudeFormat 模型名里有 claude 时改用的格式（Command Code、Vertex：Claude 模型只有 Anthropic 格式的接口）
//   claudeBase   这时用的接口地址（Command Code）
//   modelsUrls   获取模型列表时，标准位置取不到再试的地址（OpenCode 的列表不在 /models）
//   listFormat   获取模型列表用的格式（Command Code 的列表在 OpenAI 格式的 /models，包括 Claude 模型）
//   auth         'google'：没有 API Key，用导入的 Google 服务账号 JSON 换访问令牌（Vertex，见下面的 GoogleAuth）

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
    format: 'openai', // 使用 Gemini（Google AI Studio）提供的 OpenAI 兼容接口
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  // Google Vertex AI：Gemini 走 Vertex 的 OpenAI 兼容接口（模型名要带 google/ 前缀，没写时自动加），
  // Claude 走 Anthropic 格式的 streamRawPredict（地址里写模型名，请求体里不写 model，写 anthropic_version）。
  // 地点固定为 global；项目 ID 来自导入的服务账号 JSON
  vertex: {
    format: 'openai',
    claudeFormat: 'anthropic',
    auth: 'google',
  },
  // OpenRouter：所有模型（包括 Claude、Gemini）都走同一个 OpenAI 兼容接口，模型名带厂商前缀（anthropic/claude-…）。
  // 特色设置：思考深度（统一的 reasoning.effort，各家模型由 OpenRouter 换算）、按价格 / 吞吐 / 延迟选上游、不用会保存数据的上游
  openrouter: {
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  // OpenCode（Console / Zen）：OpenAI 兼容接口，所有模型都可以用（平台自动转换）。模型列表在 /inference/v1/models
  opencode: {
    format: 'openai',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    modelsUrls: ['https://opencode.ai/inference/v1/models'],
  },
  // Command Code（Provider API）：其他模型用 OpenAI 格式，Claude 模型只有 Anthropic 格式（/provider/v1/messages）
  commandcode: {
    format: 'openai',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    claudeFormat: 'anthropic',
    claudeBase: 'https://api.commandcode.ai/provider',
    listFormat: 'openai',
  },
};

const OPENROUTER_REFERER = 'https://github.com/IonComan813/ProjectProteus';
const isBuiltinProvider = (key) => Object.prototype.hasOwnProperty.call(PROVIDERS, key);
const isClaudeModel = (model) => /claude/i.test(model || '');

// 用户自己添加的服务商（中转站）：设置里的 relays = [{ id, name, format }]，键名是 relay:<id>，
// 接口地址、Key、模型等和官方服务商一样按键名存。由 app.js 在读取设置和增删改之后调用 setCustomProviders 登记
const RELAY_PREFIX = 'relay:';
let customProviders = {};

function setCustomProviders(relays) {
  customProviders = {};
  for (const r of relays || []) customProviders[RELAY_PREFIX + r.id] = { format: r.format === 'anthropic' ? 'anthropic' : 'openai', baseUrl: '' };
}

// 服务商的格式和默认地址，没有这个服务商时为 null
function providerOf(key) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key]
    : Object.prototype.hasOwnProperty.call(customProviders, key) ? customProviders[key] : null;
}

// 请求用的格式：cfg.format（添加服务商的窗口里，还没保存时）或者服务商的格式。
// Command Code、Vertex 按模型名自动切换：Claude 模型用 Anthropic 格式
function formatOf(cfg) {
  if (cfg.format) return cfg.format;
  const p = providerOf(cfg.provider);
  if (!p) return 'openai';
  if (p.claudeFormat && isClaudeModel(cfg.model)) return p.claudeFormat;
  return p.format;
}

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

// 实际使用的接口地址。内置服务商用固定的地址（不看设置里填的），用户添加的服务商用填的地址
function baseOf(cfg) {
  const p = providerOf(cfg.provider);
  if (p && isBuiltinProvider(cfg.provider) && !cfg.format) {
    if (p.auth === 'google') return vertexBase(cfg);
    if (p.claudeBase && isClaudeModel(cfg.model)) return p.claudeBase;
    return p.baseUrl;
  }
  return trimSlash(cfg.baseUrl || (p ? p.baseUrl : ''));
}

// ---- Google Vertex AI ----
// 服务账号 JSON（导入时只留下要用的字段，存在 apiKeys.vertex 里，和 API Key 一样受「记住 API Key」控制）：
//   { type: 'service_account', project_id, client_email, private_key, private_key_id }
// 它不是 API Key：里面是服务账号的 RSA 私钥。用它签一个 JWT（RS256），到 Google 换一个 1 小时有效的访问令牌，
// 请求时带 Authorization: Bearer <令牌>；快过期时重新换。换令牌的地址固定，不用 JSON 里写的 token_uri
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_HOST = 'https://aiplatform.googleapis.com';

// 解析导入的服务账号 JSON，认不出时为 null
function parseServiceAccount(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return null; }
  if (!j || j.type !== 'service_account') return null;
  const ok = ['project_id', 'client_email', 'private_key'].every((k) => typeof j[k] === 'string' && j[k]);
  if (!ok || !/-----BEGIN PRIVATE KEY-----/.test(j.private_key)) return null;
  return { type: 'service_account', project_id: j.project_id, client_email: j.client_email, private_key: j.private_key,
    private_key_id: typeof j.private_key_id === 'string' ? j.private_key_id : '' };
}

function vertexBase(cfg) {
  const sa = parseServiceAccount(cfg.apiKey);
  const project = sa ? encodeURIComponent(sa.project_id) : '{project}';
  const root = `${VERTEX_HOST}/v1/projects/${project}/locations/global`;
  return isClaudeModel(cfg.model) ? `${root}/publishers/anthropic/models` : `${root}/endpoints/openapi`;
}

// Gemini 走 OpenAI 兼容接口时模型名要带 google/ 前缀
const vertexModel = (model) => (model.includes('/') ? model : 'google/' + model);

const GoogleAuth = (() => {
  const cache = new Map(); // client_email + private_key_id → { token, until }
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); // = 只会出现在结尾（补位）
  const b64urlText = (s) => b64url(new TextEncoder().encode(s));

  async function sign(sa, input) {
    const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  }

  // 访问令牌（缓存到过期前 5 分钟）
  async function token(saText) {
    const sa = parseServiceAccount(saText);
    if (!sa) throw new Error(t('api.vertexNeedJson'));
    const id = sa.client_email + '\n' + sa.private_key_id;
    const hit = cache.get(id);
    if (hit && hit.until > Date.now()) return hit.token;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    if (sa.private_key_id) header.kid = sa.private_key_id;
    const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 };
    const input = b64urlText(JSON.stringify(header)) + '.' + b64urlText(JSON.stringify(claims));
    let jwt;
    try { jwt = input + '.' + b64url(await sign(sa, input)); } catch (e) {
      throw new Error(t('api.vertexBadKey') + '\n' + e.message);
    }
    let res;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      });
    } catch (e) {
      throw new Error(t('api.connectFailedShort') + e.message);
    }
    const text = await res.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* 下面报错 */ }
    if (!res.ok || !j || !j.access_token) throw new Error(t('api.vertexTokenFailed') + '\n' + (j && (j.error_description || j.error) || text || res.status));
    cache.set(id, { token: j.access_token, until: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000 });
    return j.access_token;
  }

  return { token };
})();

// 请求要带的认证头：Vertex 用访问令牌，其他服务商的已经在 buildRequest 里写好
async function authHeaders(cfg) {
  const p = providerOf(cfg.provider);
  if (!p || p.auth !== 'google' || cfg.format) return {};
  return { authorization: 'Bearer ' + (await GoogleAuth.token(cfg.apiKey)) };
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
  const format = formatOf(cfg);
  const base = baseOf(cfg);
  if (!base) throw new Error(t('api.needBaseUrl'));
  if (!cfg.model) throw new Error(t('api.needModel'));
  const msgs = finalMessages(format, messages);

  const google = !cfg.format && (providerOf(cfg.provider) || {}).auth === 'google';
  if (format === 'anthropic' && google) {
    // Vertex 上的 Claude：地址里写模型名，请求体里不写 model，anthropic_version 写在请求体里；认证头由 authHeaders 补上
    const body = { anthropic_version: 'vertex-2023-10-16', max_tokens: cfg.maxTokens || 8192, stream: true, messages: msgs };
    if (system) body.system = system;
    if (cfg.effort) body.output_config = { effort: cfg.effort };
    const headers = { 'content-type': 'application/json', authorization: 'Bearer <Google access token>' };
    return { format: 'anthropic', base, url: `${base}/${encodeURIComponent(cfg.model)}:streamRawPredict`, headers, body };
  }

  if (format === 'anthropic') {
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
    model: google ? vertexModel(cfg.model) : cfg.model,
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
  const openrouter = /^https:\/\/openrouter\.ai\//i.test(base);
  if (openrouter) {
    // OpenRouter 的特色设置（只在内置的 OpenRouter 服务商里能设）
    if (cfg.provider === 'openrouter' && cfg.effort) body.reasoning = { effort: cfg.effort };
    const route = {};
    if (cfg.openrouterSort) route.sort = cfg.openrouterSort;
    if (cfg.openrouterNoData) route.data_collection = 'deny';
    if (cfg.provider === 'openrouter' && Object.keys(route).length) body.provider = route;
  }
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + (google ? '<Google access token>' : cfg.apiKey),
  };
  // OpenRouter（内置的，或者用户自己按地址添加的）：带上应用的网址和名称（OpenRouter 的应用归属，两个要一起发）
  if (openrouter) {
    headers['HTTP-Referer'] = OPENROUTER_REFERER;
    headers['X-OpenRouter-Title'] = 'Proteus';
  }
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
  if (!cfg.apiKey) throw new Error(t((providerOf(cfg.provider) || {}).auth === 'google' ? 'api.vertexNeedJson' : 'api.needKey'));
  const log = lastExchange = { time: new Date(), request: { method: 'POST', url: req.url, headers: req.headers, body: req.body }, response: null, error: null };
  const auth = await authHeaders(cfg); // Vertex：换访问令牌（日志里的认证头仍是占位文字）
  const sendHeaders = { ...req.headers, ...auth };
  const record = (s) => { if (log.response.body.length < LOG_MAX) log.response.body += s; };
  const post = async (body) => {
    try {
      const sent = await postChat(req.url, { method: 'POST', headers: sendHeaders, body: JSON.stringify(body), signal }, signal);
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
    // 用量可能分几次报告（Anthropic：开头报告输入，结尾报告输出），每项保留最后一次非零的值。
    // inputOnly：Anthropic 开头的 message_start 里也有 output_tokens，但那只是占位（一般是 1），不当作输出用量；
    // 回复中途断开（网络、停止）时收不到结尾的输出用量，输出就是 0（界面上写“未接收到输出 token 报告”）
    const usage = { input: 0, output: 0 };
    const gotUsage = (u, inputOnly = false) => {
      const x = usageOf(u, req.format);
      if (x && inputOnly) x.output = 0;
      if (!x || (!x.input && !x.output)) return;
      if (x.input) usage.input = x.input;
      if (x.output) usage.output = x.output;
      if (onUsage) onUsage({ ...usage });
    };
    const onEvent = req.format === 'anthropic'
      ? (ev) => {
        if (ev.type === 'message_start' && ev.message) gotUsage(ev.message.usage, true);
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
        else if (d.reasoning_content || d.reasoning || (Array.isArray(d.reasoning_details) && d.reasoning_details.length)) onThinking && onThinking(); // OpenRouter 用 reasoning_details
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

// 获取模型列表。先试标准位置，取不到（出错、连不上或列表是空的）再换几个常见的位置试：
//   OpenAI 格式：<地址>/models → 服务商指定的地址 → 去掉 /v1 前一段路径（…/inference/openai/v1 → …/inference/v1/models）
//                → 去掉结尾的 /v1 再加 /v1/models → <域名>/v1/models
//   Anthropic 格式：<地址>/v1/models → <地址>/models
// 都取不到时报第一个错误
async function fetchModels(cfg) {
  const p = providerOf(cfg.provider) || {};
  if (p.auth === 'google' && !cfg.format) return fetchVertexModels(cfg);
  const lc = p.listFormat && !cfg.format ? { ...cfg, format: p.listFormat } : cfg;
  const base = baseOf(p.listFormat && !cfg.format ? { ...cfg, model: '' } : cfg);
  if (!base) throw new Error(t('api.needBaseUrl'));
  const anthropic = formatOf(lc) === 'anthropic';
  const headers = anthropic
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
    : (cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {});
  return firstModelList(modelListUrls(base, anthropic, p.modelsUrls || []), headers);
}

function modelListUrls(base, anthropic, extra) {
  const urls = [];
  const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  if (anthropic) {
    add(base + '/v1/models?limit=100');
    add(base + '/models?limit=100');
    return urls;
  }
  add(base + '/models');
  for (const u of extra) add(u);
  let u;
  try { u = new URL(base); } catch (_) { return urls; }
  const path = trimSlash(u.pathname);
  const m = /^(.*)\/[^/]+\/v1$/.exec(path);
  if (m) add(u.origin + m[1] + '/v1/models');
  if (/\/v1$/.test(path)) add(u.origin + path.slice(0, -3) + '/v1/models');
  else add(u.origin + path + '/v1/models');
  add(u.origin + '/v1/models');
  return urls;
}

async function firstModelList(urls, headers) {
  let firstError = null;
  for (const url of urls) {
    try {
      let res;
      try { res = await fetch(url, { headers }); } catch (e) {
        throw new Error(t('api.connectFailedShort') + e.message);
      }
      if (!res.ok) throw await readError(res);
      const list = modelNames(await res.json());
      if (list.length) return list;
      throw new Error(t('api.noModels'));
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  throw firstError || new Error(t('api.noModels'));
}

// 各家模型列表的格式：{ data: [{ id }] }（OpenAI、Anthropic）、{ models: [{ name: 'models/…' }] }（Gemini）、
// { publisherModels: [{ name: 'publishers/google/models/…' }] }（Vertex）
function modelNames(j) {
  const items = (j && (j.data || j.models || j.publisherModels)) || [];
  return items.map((m) => (m && (m.id || m.name)) || '').filter((x) => typeof x === 'string' && x)
    .map((id) => id.replace(/^models\//, '')) // Gemini 的模型名带有 models/ 前缀，去掉后也能用
    .sort((a, b) => a.localeCompare(b));
}

// Vertex 的模型列表：Model Garden 的发布者模型列表（publishers.models.list，v1beta1），Google 和 Anthropic 各取一次，
// 按 nextPageToken 翻页（最多 5 页）。只留对话模型：Google 的 gemini-…（前面加 google/），Anthropic 的 claude-…。
// global 地址取不到时改用 us-central1。都取不到时可以直接输入模型名（Gemini 写 google/gemini-…，Claude 写 claude-…）
async function fetchVertexModels(cfg) {
  const headers = await authHeaders(cfg);
  const out = [];
  let firstError = null;
  for (const [publisher, prefix, keep] of [['google', 'google/', /^gemini-/], ['anthropic', '', /^claude-/]]) {
    let got = null;
    for (const host of [VERTEX_HOST, 'https://us-central1-aiplatform.googleapis.com']) {
      try {
        got = await listPublisherModels(host, publisher, headers);
        break;
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }
    for (const name of got || []) {
      const id = name.replace(/^publishers\/[^/]+\/models\//, '');
      if (keep.test(id)) out.push(prefix + id);
    }
  }
  if (!out.length) throw firstError || new Error(t('api.noModels'));
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

async function listPublisherModels(host, publisher, headers) {
  const names = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const url = `${host}/v1beta1/publishers/${publisher}/models?pageSize=200${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
    let res;
    try { res = await fetch(url, { headers }); } catch (e) {
      throw new Error(t('api.connectFailedShort') + e.message);
    }
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    for (const m of (j && j.publisherModels) || []) if (m && typeof m.name === 'string') names.push(m.name);
    token = j && j.nextPageToken;
    if (!token) break;
  }
  return names;
}
