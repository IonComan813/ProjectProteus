// 网页版登录 GitHub 用的本机代理（只在网页版需要；电脑版和安卓版不需要）。
//
// GitHub 的设备登录（Device Flow）有两个地址不允许网页直接访问（跨域限制）：
//   https://github.com/login/device/code        申请验证码
//   https://github.com/login/oauth/access_token 轮询登录结果
// 这个脚本在本机 127.0.0.1:8787 上转发这两个地址，并加上允许跨域的响应头。只转发这两个地址，其他一律拒绝；
// 只监听本机，别的设备连不上。登录以后读写仓库用的 api.github.com 本身允许跨域，不经过这里。
//
// 用法（需要 Node.js 18 或更新的版本）：
//   node scripts/github-login-proxy.js            默认端口 8787
//   node scripts/github-login-proxy.js 9000       换一个端口（网页版也要改：js/sync.js 的 GITHUB_LOGIN_PROXY）
// 登录完成后可以按 Ctrl + C 关掉，读写仓库不需要它。

const http = require('http');

const PORT = Number(process.argv[2]) || 8787;
const PATHS = new Set(['/login/device/code', '/login/oauth/access_token']);
const MAX_BODY = 16 * 1024;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, accept',
  // Chrome 的「私有网络访问」检查：从网页（包括本地文件打开的网页）访问本机地址时要有这个
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
};

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method !== 'POST' || !PATHS.has(path)) {
    res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    try {
      const r = await fetch('https://github.com' + path, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: Buffer.concat(chunks),
      });
      const text = await r.text();
      res.writeHead(r.status, { ...cors, 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_failed', error_description: e.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Proteus GitHub login proxy: http://127.0.0.1:${PORT} (Ctrl + C to stop)`);
});
