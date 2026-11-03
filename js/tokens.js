// token 估算，并按接口实际报告的用量自动校准。
//
// 粗略估算：中日韩文字约 1 字 1 token，其他约 4 个字符 1 token（estimateTokens）。
// 不同模型、不同中转站的实际计数和它有出入，所以每次请求后读取接口报告的输入用量，自动修正：
//
//   - 按“中转站 → 模型”分两级记录。中转站按接口地址区分（不按兼容模式：同一个兼容模式下可以换用不同的中转站），
//     同一个中转站在 Anthropic 和 OpenAI 两种兼容模式下填的地址常常只差结尾的 /v1，算作同一个中转站。
//     官方接口也各算一个“中转站”。不同中转站、以及中转站和官方接口的同名模型分开计算。
//   - 每一级用加权的线性回归：实际输入 ≈ a × 中日韩字数 + b × 其他部分的粗略估算 + c。
//     a、b 分别是两类文字的系数（不同语言换算成 token 的比例不同），c 是固定的额外开销（例如中转站自己加的内容）。
//     没有数据时 a = b = 1、c = 0，就是粗略估算；模型级以中转站级的结果为起点，所以中转站里新用的模型也能直接沿用。
//     旧的数据逐次减少权重，计数方式变了（例如中转站换了上游）也能跟上。
//   - 同一个对话里相邻两次请求的内容大部分相同，所以下一次请求 = 这个对话上一次的实际用量 + 两次之间变化部分的估算
//     （用回归算上一次的估算和实际值的差，加到这一次的估算上）。“上一次”按对话、中转站和模型分别记，
//     同一个对话换着用不同的接口或模型时互不覆盖。
//
// 只记录数字（字数、token 数），不记录任何对话内容。存在 localStorage，“清除软件数据”时一起删除。

// 中日韩标点、假名、汉字、韩文音节、全角符号
const CJK_RE = /[　-鿿가-힯＀-￯]/g;

function cjkCount(s) {
  return s ? (s.match(CJK_RE) || []).length : 0;
}

// 粗略估算一段文字的 token 数（不校准）
function estimateTokens(s) {
  if (!s) return 0;
  const cjk = cjkCount(s);
  return Math.round(cjk + (s.length - cjk) / 4);
}

const TokenCalib = (() => {
  const STORE_KEY = 'proteus.tokenCalib';
  const MSG_OVERHEAD = 4;      // 每条消息（角色标记等）大约多出的 token
  const DECAY = 0.9;           // 每来一次新数据，旧数据的权重乘以它
  const PRIOR_COEF = 1;        // a、b 起点的权重（相当于约一次请求的数据）
  const PRIOR_CONST = 1 / (1500 * 1500); // c 的起点 0 的权重：c 通常在几千以内
  const MIN_WEIGHT_SIZE = 300; // 很小的请求格式开销占比大，按至少这么大计算权重，免得它们左右系数
  const MAX_ANCHORS = 300;     // 最多记住多少个“对话 + 中转站 + 模型”的上一次请求

  // ---- 读写 ----
  // { relays: { 中转站: { s: 统计, models: { 模型名: { s: 统计 } } } },
  //   anchors: { anchorKey(对话id, 中转站, 模型): { x: 特征, y: 实际输入, out: 实际输出, t: 时间 } } }
  let store = null;
  function load() {
    if (store) return store;
    try { store = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { store = null; }
    if (!store || typeof store !== 'object' || !store.relays || !store.anchors) store = { relays: {}, anchors: {} };
    return store;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* 存不下就只在这次打开期间有效 */ }
  }
  function forget() {
    store = { relays: {}, anchors: {} };
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* 本来就没存 */ }
  }

  // 接口地址 → 中转站。只看协议、主机、端口和路径；去掉结尾的 / 和 /v1
  function relayOf(base) {
    let s = (base || '').trim();
    if (!s) return '';
    try { const u = new URL(s); s = u.origin + u.pathname; } catch (_) { s = s.toLowerCase(); }
    while (s.endsWith('/')) s = s.slice(0, -1);
    if (/\/v1$/i.test(s)) s = s.slice(0, -3);
    return s;
  }

  // ---- 特征 ----
  // 一段文字：[中日韩字数, 其他部分的粗略估算]
  function textFeatures(s) {
    if (!s) return [0, 0];
    const cjk = cjkCount(s);
    return [cjk, (s.length - cjk) / 4];
  }

  // 一次请求（system 文字 + 最终发送的消息列表）：[中日韩字数, 其他部分 + 每条消息的开销, 1]
  function requestFeatures(system, messages) {
    let cjk = 0;
    let rest = 0;
    let n = 0;
    const add = (s) => { const [c, r] = textFeatures(s); cjk += c; rest += r; n++; };
    if (system) add(system);
    for (const m of messages) add(m.content);
    return [cjk, rest + n * MSG_OVERHEAD, 1];
  }

  // ---- 回归 ----
  // 统计量 s = { A: 3×3（按行展开）, b: 3, n: 加权后的数据量 }。求解 (A + P) θ = b + P μ，P 是起点 μ 的权重
  const emptyStats = () => ({ A: [0, 0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0], n: 0 });
  const DEFAULT_THETA = [1, 1, 0];
  const PRIOR = [PRIOR_COEF, PRIOR_COEF, PRIOR_CONST];

  function addTo(s, x, y) {
    const w = 1 / Math.pow(Math.max(y, MIN_WEIGHT_SIZE), 2); // 按相对误差拟合：大请求和小请求同样重要
    for (let i = 0; i < 9; i++) s.A[i] *= DECAY;
    for (let i = 0; i < 3; i++) s.b[i] *= DECAY;
    s.n = s.n * DECAY + 1;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) s.A[i * 3 + j] += w * x[i] * x[j];
      s.b[i] += w * x[i] * y;
    }
  }

  // 3×3 线性方程组（高斯消元，选主元）
  function solve3(M, v) {
    const a = [[M[0], M[1], M[2], v[0]], [M[3], M[4], M[5], v[1]], [M[6], M[7], M[8], v[2]]];
    for (let col = 0; col < 3; col++) {
      let p = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[p][col])) p = r;
      if (!a[p][col]) return null;
      [a[col], a[p]] = [a[p], a[col]];
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = a[r][col] / a[col][col];
        for (let k = col; k < 4; k++) a[r][k] -= f * a[col][k];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  }

  function thetaOf(s, mu) {
    if (!s || !s.n) return mu;
    const M = s.A.slice();
    const v = s.b.slice();
    for (let i = 0; i < 3; i++) { M[i * 4] += PRIOR[i]; v[i] += PRIOR[i] * mu[i]; }
    const th = solve3(M, v);
    if (!th || !th.every(Number.isFinite)) return mu;
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    return [clamp(th[0], 0.1, 10), clamp(th[1], 0.1, 10), clamp(th[2], -5000, 50000)];
  }

  const dot = (th, x) => th[0] * x[0] + th[1] * x[1] + th[2] * x[2];
  const anchorKey = (convId, relay, model) => JSON.stringify([convId, relay, model]);

  // ---- 对外 ----

  // 这个中转站 + 模型的系数。calibrated 表示有实际数据（模型自己的，或者同一中转站其他模型的）
  function coefOf(relay, model) {
    const r = relay && load().relays[relay];
    const m = r && model && r.models[model];
    const relayTheta = thetaOf(r && r.s, DEFAULT_THETA);
    return { theta: thetaOf(m && m.s, relayTheta), calibrated: !!((r && r.s.n) || (m && m.s.n)) };
  }

  // 一段文字校准后的 token 数（不含消息开销和固定开销）
  function textTokens(text, coef) {
    const [c, r] = textFeatures(text);
    const th = coef ? coef.theta : DEFAULT_THETA;
    return Math.max(0, Math.round(th[0] * c + th[1] * r));
  }

  // 一次请求的预估输入 token。convId 给出时，用这个对话上一次请求的实际用量修正。
  // 返回 { tokens, calibrated, last }；last 是这个对话上一次请求（同一中转站和模型）的实际用量 { input, output }
  function predict(relay, model, x, convId) {
    const coef = coefOf(relay, model);
    let tokens = dot(coef.theta, x);
    const a = convId && relay && model ? load().anchors[anchorKey(convId, relay, model)] : null;
    const anchored = !!a;
    if (anchored) tokens += a.y - dot(coef.theta, a.x);
    return {
      tokens: Math.max(0, Math.round(tokens)),
      calibrated: coef.calibrated || anchored,
      last: anchored ? { input: a.y, output: a.out } : null,
    };
  }

  // 记录一次请求的实际用量。x 是发送时算的特征，input / output 是接口报告的输入、输出 token
  function observe(relay, model, x, input, output, convId) {
    if (!relay || !model || !(input > 0)) return;
    const st = load();
    if (convId) {
      st.anchors[anchorKey(convId, relay, model)] = { x, y: input, out: output > 0 ? output : null, t: Date.now() };
      const ids = Object.keys(st.anchors);
      if (ids.length > MAX_ANCHORS) {
        ids.sort((p, q) => st.anchors[p].t - st.anchors[q].t);
        for (const id of ids.slice(0, ids.length - MAX_ANCHORS)) delete st.anchors[id];
      }
    }
    // 和粗略估算差得离谱的（例如接口只报告了没命中缓存的部分），只用来修正这个对话，不进回归
    const rough = dot(DEFAULT_THETA, x);
    const ratio = input / Math.max(rough, 1);
    if (ratio >= 0.2 && ratio <= 5) {
      const r = st.relays[relay] || (st.relays[relay] = { s: emptyStats(), models: {} });
      const m = r.models[model] || (r.models[model] = { s: emptyStats() });
      addTo(r.s, x, input);
      addTo(m.s, x, input);
    }
    save();
  }

  return { relayOf, requestFeatures, coefOf, textTokens, predict, observe, forget };
})();
