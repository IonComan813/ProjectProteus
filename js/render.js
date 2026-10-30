// 消息渲染：把 Markdown / HTML / CSS 放进“沙箱 iframe”里显示，样式不会影响聊天区以外的界面。
// 两种模式：
//   - 开场白（scripts: true）：允许运行 JS。脚本被隔离在独立的小窗口里，读不到本页面的数据
//     （例如 API Key），也不能弹窗或跳转页面。
//   - 其他消息（scripts: false）：完全禁用 JS，只用 Markdown / HTML / CSS 美化。
const Render = (() => {
  marked.setOptions({ gfm: true, breaks: true });

  const BASE_CSS = `
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    body {
      display: flow-root;
      color: #e6e4df;
      font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif;
      font-size: 16px;
      line-height: 1.85;
      word-break: break-word;
    }
    #root { overflow-x: auto; }
    #root > :first-child { margin-top: 0; }
    #root > :last-child { margin-bottom: 0; }
    p { margin: 0 0 .8em; }
    em { color: #b9b4a8; }
    strong { color: #f1e6cf; }
    a { color: #c9a96e; }
    img, video { max-width: 100%; height: auto; }
    h1, h2, h3, h4 { line-height: 1.4; margin: .6em 0 .4em; }
    pre { overflow: auto; background: #0f1013; padding: 10px 12px; border-radius: 6px; line-height: 1.5; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: .88em; }
    blockquote { margin: 0 0 .8em; padding-left: 12px; border-left: 3px solid #4a4c55; color: #b5b2ab; }
    table { border-collapse: collapse; margin: 0 0 .8em; }
    th, td { border: 1px solid #3a3c44; padding: 4px 10px; }
    details { border: 1px solid #3a3c44; border-radius: 6px; padding: 4px 12px; margin: 0 0 .8em; }
    summary { cursor: pointer; color: #c9a96e; }
    hr { border: none; border-top: 1px solid #3a3c44; margin: 1em 0; }
    .proteus-thinking { color: #8d8f98; font-style: italic; }
  `;

  // 开场白窗口内部的辅助脚本：汇报内容高度
  const HELPER = `(function () {
    var last = -1;
    function report() {
      var h = Math.ceil(document.body.getBoundingClientRect().height);
      if (h !== last) { last = h; parent.postMessage({ proteus: 'height', h: h }, '*'); }
    }
    new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report);
    report();
  })();`;

  const heightCache = new Map(); // 内容 → 上次测得的高度，减少重新显示时的跳动
  let onResize = null;

  function toHtml(text) {
    try { return marked.parse(text || ''); }
    catch (_) { return '<pre>' + escapeHtml(text || '') + '</pre>'; }
  }

  function buildDoc(html, scripts) {
    return '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">'
      + '<style>' + BASE_CSS + '</style></head><body><div id="root">' + html + '</div>'
      + (scripts ? '<script>' + HELPER + '</' + 'script>' : '')
      + '</body></html>';
  }

  function setHeight(f, h) {
    h = Math.max(0, Math.min(Number(h) || 0, 100000));
    if (f.style.height === h + 'px') return;
    f.style.height = h + 'px';
    if (f._text != null) heightCache.set(f._text, h);
    if (onResize) onResize(f);
  }

  // ---- 禁用脚本的模式：主页面直接读写窗口内容 ----

  function safeDoc(f) {
    try { return f.contentDocument; } catch (_) { return null; }
  }

  function measure(f) {
    const d = safeDoc(f);
    if (d && d.body) setHeight(f, Math.ceil(d.body.getBoundingClientRect().height));
  }

  function applySafe(f) {
    const d = safeDoc(f);
    const root = d && d.getElementById('root');
    if (!root || f._pending == null) return;
    root.innerHTML = f._pending;
    f._pending = null;
    measure(f);
  }

  // ---- 对外接口 ----

  // 新建一个显示消息的 iframe
  function create(text, { scripts = false } = {}) {
    const f = document.createElement('iframe');
    f.className = 'msg-frame';
    f._scripts = scripts;
    f.setAttribute('sandbox', scripts
      ? 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
      : 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('scrolling', 'no');
    f.style.height = (heightCache.get(text) || 0) + 'px';
    if (!scripts) {
      f._text = text;
      f._pending = toHtml(text);
      f.addEventListener('load', () => {
        const d = safeDoc(f);
        if (!d || !d.body) return;
        new ResizeObserver(() => measure(f)).observe(d.body);
        applySafe(f);
      });
      f.srcdoc = buildDoc('', false);
    } else {
      set(f, text);
    }
    return f;
  }

  // 显示完整内容。开场白窗口会重新加载，里面的脚本重新运行。
  function set(f, text) {
    f._text = text;
    if (f._scripts) {
      f.srcdoc = buildDoc(toHtml(text), true);
    } else {
      f._pending = toHtml(text);
      applySafe(f);
    }
  }

  // 流式输出时更新内容（只用于禁用脚本的消息）
  function stream(f, text, rawHtml) {
    f._text = null;
    f._pending = rawHtml != null ? rawHtml : toHtml(text);
    applySafe(f);
  }

  // 开场白窗口里的脚本通过 postMessage 汇报高度
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.proteus !== 'height') return;
    for (const el of document.querySelectorAll('iframe.msg-frame')) {
      if (el._scripts && el.contentWindow === e.source) { setHeight(el, e.data.h); break; }
    }
  });

  return {
    create,
    set,
    stream,
    thinkingHtml: (label) => '<p class="proteus-thinking">' + escapeHtml(label) + '</p>',
    onResize: (fn) => { onResize = fn; },
  };
})();
