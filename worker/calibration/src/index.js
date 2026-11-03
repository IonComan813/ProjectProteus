// Proteus 共享 token 校准数据的服务器（Cloudflare Worker + R2）。客户端见 js/tokens.js。
//
//   GET  /v1/calibration.json   汇总后的公开数据：{ v: 1, updated, relays: { 域名: { 模型名: { a, b, c, k } } } }
//                               a、b、c 是 token 估算的系数（某一项的数据不够时不写），k 是有多少个来源
//   POST /v1/contribute         客户端推送本机稳定下来的系数：{ v: 1, client, entries: [{ relay, model, a, b, c, wa, wb, n }] }
//                               relay 是中转站的域名（可以带端口），wa / wb 是 a / b 的数据量，n 是请求次数，
//                               client 是客户端随机生成的设备编号
//
// 存储桶里的内容（和放安装包的存储桶分开）：
//   votes/<sha256(域名 \n 模型名)>.json   这个模型收到的数据：{ relay, model, votes: { IP 哈希: { a, b, c, wa, wb, n, client, t } } }
//   public/v1.json                         每小时由定时任务汇总一次
//
// 防止乱推的数据影响别人：
//   - 每个 IP 对每个模型只算一票（IP 只以加盐的哈希保存）；同一个设备编号换了 IP 也只保留最新的一票
//   - 至少 3 票才公开（私人的中转站域名只有自己在用，不会出现在公开数据里），取中位数，少数离谱的值不起作用
//   - 每一项系数单独统计，只用这一项数据量够的票（例如只聊中文的数据不参与其他文字系数 b 的统计）
//   - 系数限制在合理范围内；客户端只把公开数据当作起点，有了自己的数据就以自己的为主
//   - 180 天没有更新的票不再计入；每个模型最多保留 100 票（新的优先）

const MIN_VOTERS = 3;
const MAX_VOTES = 100;
const VOTE_TTL_MS = 180 * 24 * 3600 * 1000;
const MAX_BODY = 32 * 1024;
const MAX_ENTRIES = 20;
const SUPPORT_MIN = 0.3;
const PUBLIC_KEY = 'public/v1.json';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
});
const empty = (status) => new Response(null, { status, headers: CORS });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => finite(v) && v >= lo && v <= hi;

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 和客户端（js/tokens.js 的 hostOf）同样的规则：要有点、不是 IP 地址、不是本机和内网域名
export function validHost(h) {
  if (typeof h !== 'string' || h.length > 260) return false;
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?$/.exec(h);
  if (!m) return false;
  if (/^[\d.]+$/.test(m[1])) return false;
  if (/(^|\.)(localhost|local|lan|internal|intranet|home|corp|test|example|invalid|arpa)$/.test(m[1])) return false;
  return !m[2] || Number(m[2]) <= 65535;
}

// 模型名：1–200 个字符，没有控制字符，也不能是会碰到对象原型的键名
export function validModel(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s)
    && s !== '__proto__' && s !== 'constructor' && s !== 'prototype';
}

export function validEntry(e) {
  return !!e && typeof e === 'object' && validHost(e.relay) && validModel(e.model)
    && inRange(e.a, 0.1, 10) && inRange(e.b, 0.1, 10) && inRange(e.c, -5000, 50000)
    && inRange(e.wa, 0, 1e6) && inRange(e.wb, 0, 1e6) && Number.isInteger(e.n) && e.n >= 1 && e.n <= 1e7;
}

async function contribute(request, env) {
  if (!env.IP_SALT) return empty(503); // 没有配置机密 IP_SALT：不接收
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (env.PUSH_LIMIT) {
    const { success } = await env.PUSH_LIMIT.limit({ key: ip || 'unknown' });
    if (!success) return empty(429);
  }
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return empty(413);
  const text = await request.text();
  if (text.length > MAX_BODY) return empty(413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return empty(400); }
  if (!body || body.v !== 1 || typeof body.client !== 'string' || !/^[0-9a-f]{32}$/.test(body.client)
    || !Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) return empty(400);
  const ipHash = (await sha256Hex(env.IP_SALT + '\n' + ip)).slice(0, 32);
  const now = Date.now();
  const seen = new Set();
  for (const e of body.entries) {
    if (!validEntry(e)) continue;
    const id = await sha256Hex(e.relay + '\n' + e.model);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = `votes/${id}.json`;
    const obj = await env.CALIB.get(key);
    let doc = null;
    try { doc = obj ? await obj.json() : null; } catch (_) { doc = null; }
    if (!doc || typeof doc.votes !== 'object' || !doc.votes) doc = { relay: e.relay, model: e.model, votes: {} };
    const votes = Object.create(null);
    for (const [h, v] of Object.entries(doc.votes)) {
      // 同一个设备换了 IP：去掉它以前的票；太旧的票也去掉
      if (h === ipHash || !v || v.client === body.client || !(now - v.t < VOTE_TTL_MS)) continue;
      votes[h] = v;
    }
    votes[ipHash] = { a: e.a, b: e.b, c: e.c, wa: e.wa, wb: e.wb, n: e.n, client: body.client, t: now };
    const kept = Object.entries(votes).sort((p, q) => q[1].t - p[1].t).slice(0, MAX_VOTES);
    doc.votes = Object.fromEntries(kept);
    await env.CALIB.put(key, JSON.stringify(doc), { httpMetadata: { contentType: 'application/json' } });
  }
  return empty(204);
}

function median(xs) {
  const s = xs.slice().sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 一个模型的票 → 公开的系数（某一项不够 MIN_VOTERS 票时不写），一项都没有时返回 null
export function aggregate(votes, now = Date.now()) {
  const live = Object.values(votes || {}).filter((v) => v && now - v.t < VOTE_TTL_MS
    && inRange(v.a, 0.1, 10) && inRange(v.b, 0.1, 10) && inRange(v.c, -5000, 50000));
  if (live.length < MIN_VOTERS) return null;
  const out = {};
  const a = live.filter((v) => v.wa >= SUPPORT_MIN).map((v) => v.a);
  const b = live.filter((v) => v.wb >= SUPPORT_MIN).map((v) => v.b);
  if (a.length >= MIN_VOTERS) out.a = Math.round(median(a) * 1e4) / 1e4;
  if (b.length >= MIN_VOTERS) out.b = Math.round(median(b) * 1e4) / 1e4;
  if (!('a' in out) && !('b' in out)) return null;
  out.c = Math.round(median(live.map((v) => v.c)));
  out.k = live.length;
  return out;
}

async function rebuild(env) {
  const relays = {};
  let cursor;
  do {
    const page = await env.CALIB.list({ prefix: 'votes/', cursor, limit: 1000 });
    for (const o of page.objects) {
      const obj = await env.CALIB.get(o.key);
      let doc = null;
      try { doc = obj ? await obj.json() : null; } catch (_) { doc = null; }
      if (!doc || !validHost(doc.relay) || !validModel(doc.model)) continue;
      const agg = aggregate(doc.votes);
      if (agg) (relays[doc.relay] || (relays[doc.relay] = {}))[doc.model] = agg;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const data = { v: 1, updated: new Date().toISOString(), relays };
  await env.CALIB.put(PUBLIC_KEY, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
  return data;
}

async function published(request, env, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/v1/calibration.json', request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const obj = await env.CALIB.get(PUBLIC_KEY);
  const res = new Response(obj ? obj.body : JSON.stringify({ v: 1, relays: {} }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600', ...CORS },
  });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return empty(204);
    if (pathname === '/v1/calibration.json' && request.method === 'GET') return published(request, env, ctx);
    if (pathname === '/v1/contribute' && request.method === 'POST') return contribute(request, env);
    return json({ error: 'not found' }, 404);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(rebuild(env));
  },
};

export { rebuild, contribute };
