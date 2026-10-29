// 消息渲染：把 Markdown / HTML / CSS / JS 放进“沙箱 iframe”里显示。
// 沙箱的作用：
//   - 消息里的样式和脚本只在这个小窗口里生效，不会影响聊天区以外的界面；
//   - 脚本无法读取本页面的数据（例如 API Key），也无法弹窗或跳转页面。
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

  // iframe 内部的辅助脚本：汇报内容高度，接收流式更新
  const HELPER = `(function () {
    var last = -1;
    function report() {
      var h = Math.ceil(document.body.getBoundingClientRect().height);
      if (h !== last) { last = h; parent.postMessage({ proteus: 'height', h: h }, '*'); }
    }
    new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report);
    window.addEventListener('message', function (e) {
      if (e.source !== parent || !e.data || e.data.proteus !== 'set') return;
      var root = document.getElementById('root');
      if (root) root.innerHTML = e.data.html;
      report();
    });
    parent.postMessage({ proteus: 'ready' }, '*');
    report();
  })();`;

  const heightCache = new Map(); // 内容 → 上次测得的高度，减少重新显示时的跳动
  let onResize = null;

  function toHtml(text) {
    try { return marked.parse(text || ''); }
    catch (_) { return '<pre>' + escapeHtml(text || '') + '</pre>'; }
  }

  function buildDoc(html) {
    return '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">'
      + '<style>' + BASE_CSS + '</style></head><body><div id="root">' + html + '</div>'
      + '<script>' + HELPER + '</' + 'script></body></html>';
  }

  // 新建一个显示消息的 iframe
  function create(text) {
    const f = document.createElement('iframe');
    f.className = 'msg-frame';
    f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('scrolling', 'no');
    f.style.height = (heightCache.get(text) || 0) + 'px';
    set(f, text);
    return f;
  }

  // 用完整内容重新显示（消息里的脚本会在这时运行）
  function set(f, text) {
    f._text = text;
    f._ready = false;
    f._pending = null;
    f.srcdoc = buildDoc(toHtml(text));
  }

  // 流式输出时只替换内容，不重新加载（脚本暂不运行，生成结束后再完整显示）
  function stream(f, text, rawHtml) {
    f._text = null;
    f._pending = rawHtml != null ? rawHtml : toHtml(text);
    if (f._ready) flush(f);
  }

  function flush(f) {
    if (f._pending == null || !f.contentWindow) return;
    f.contentWindow.postMessage({ proteus: 'set', html: f._pending }, '*');
    f._pending = null;
  }

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data.proteus !== 'string') return;
    let f = null;
    for (const el of document.querySelectorAll('iframe.msg-frame')) {
      if (el.contentWindow === e.source) { f = el; break; }
    }
    if (!f) return;
    if (e.data.proteus === 'ready') {
      f._ready = true;
      flush(f);
    } else if (e.data.proteus === 'height') {
      const h = Math.max(0, Math.min(Number(e.data.h) || 0, 100000));
      f.style.height = h + 'px';
      if (f._text != null) heightCache.set(f._text, h);
      if (onResize) onResize(f);
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
