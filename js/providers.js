// 和各家模型接口通信。服务商的显示名称在 i18n.js 里（provider.<键名>）。支持两种格式：
//   - Anthropic 格式（Claude 官方，以及兼容它的中转站）
//   - OpenAI 格式（OpenAI 官方、Gemini、OpenRouter、DeepSeek 和大多数中转站）
// 所有请求都用流式输出，文字会一边生成一边显示。

const PROVIDERS = {
  anthropic: {
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
  },
  openai: {
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    defaultModel: '',
  },
  gemini: {
    format: 'openai', // 使用 Gemini 提供的 OpenAI 兼容接口
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // 免费额度下较大的模型常常繁忙（503）或长时间排队，默认用最稳定的 3.5-flash-lite
    models: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.1-pro-preview'],
    defaultModel: 'gemini-3.5-flash-lite',
  },
  custom_openai: {
    format: 'openai',
    baseUrl: '',
    models: [],
    defaultModel: '',
  },
  custom_anthropic: {
    format: 'anthropic',
    baseUrl: '',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: '',
  },
};

const ANTHROPIC_VERSION = '2026-10-21';
// 这些 Claude 模型在官方接口上支持“被安全分类器拒绝时自动换模型重试”。
const ANTHROPIC_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

function trimSlash(url) {
  return (url || '').trim().replace(/\/+$/, '');
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

// 组装真正发给接口的请求（不发送，只返回 url / headers / body），方便“预览”功能复用。
function buildRequest(cfg, system, messages) {
  const provider = PROVIDERS[cfg.provider];
  const base = trimSlash(cfg.baseUrl || provider.baseUrl);
  if (!base) throw new Error(t('api.needBaseUrl'));
  if (!cfg.model) throw new Error(t('api.needModel'));
  let msgs = mergeSameRole(messages);

  if (provider.format === 'anthropic') {
    // Anthropic 要求第一条必须是用户消息
    if (msgs.length && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: t('greet.omitted') });
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
    return { format: 'anthropic', url: base + '/v1/messages', headers, body };
  }

  // OpenAI 格式
  const body = {
    model: cfg.model,
    stream: true,
    messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs,
  };
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
  return { format: 'openai', url: base + '/chat/completions', headers, body };
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  let msg = text;
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0] || {}; // Gemini 的错误信息包在数组里
    msg = (j.error && (j.error.message || j.error.type)) || j.message || text;
  } catch (_) { /* 不是 JSON，直接用原文 */ }
  const hint = [400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 504, 529].includes(res.status) ? t('api.' + res.status) : '';
  return new Error(`HTTP ${res.status}${hint ? ' — ' + hint : ''}\n${String(msg).slice(0, 600)}`);
}

// 逐行读取服务器推送的流（SSE），每拿到一个 data 就回调一次
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // 处理一行，返回 true 表示流已结束
  const handle = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) return false; // 忽略 event: 行、注释行、空行
    const data = line.slice(5).trim();
    if (!data) return false;
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
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (handle(line)) return;
      }
    }
    // 最后一行后面可能没有换行
    buf += decoder.decode();
    if (buf) handle(buf);
  } finally {
    // 提前结束（[DONE] 或接口返回错误）时断开连接，不在后台继续接收
    reader.cancel().catch(() => {});
  }
}

// 发送一次对话请求。onText(增量文字) 会被多次调用。
// 返回 { stopReason }。
async function streamChat(cfg, system, messages, { signal, onText, onThinking }) {
  const req = buildRequest(cfg, system, messages);
  if (!cfg.apiKey) throw new Error(t('api.needKey'));
  let res;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(t('api.connectFailed') + '\n' + e.message);
  }
  if (!res.ok) throw await readError(res);

  let stopReason = null;
  if (req.format === 'anthropic') {
    await readSSE(res, (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') onThinking && onThinking();
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
      else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      else if (ev.type === 'error') throw new Error(t('api.errorEvent') + ((ev.error && ev.error.message) || JSON.stringify(ev)));
    });
  } else {
    await readSSE(res, (ev) => {
      if (ev.error) throw new Error(t('api.errorEvent') + (ev.error.message || JSON.stringify(ev.error)));
      const choice = ev.choices && ev.choices[0];
      if (!choice) return;
      const d = choice.delta || {};
      if (d.content) onText(d.content);
      else if (d.reasoning_content || d.reasoning) onThinking && onThinking();
      if (choice.finish_reason) stopReason = choice.finish_reason;
    });
  }
  return { stopReason };
}

// 获取模型列表
async function fetchModels(cfg) {
  const provider = PROVIDERS[cfg.provider];
  const base = trimSlash(cfg.baseUrl || provider.baseUrl);
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
