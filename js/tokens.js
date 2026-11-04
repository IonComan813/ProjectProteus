// token 估算，并按接口实际报告的用量自动校准。
//
// 粗略估算：中日韩文字约 1 字 1 token，其他约 4 个字符 1 token（estimateTokens）。
// 不同模型、不同中转站的实际计数和它有出入，所以每次请求后读取接口报告的输入用量，自动修正：
//
//   - 按“中转站 → 模型”分两级记录。中转站按接口地址区分（不按兼容模式：同一个兼容模式下可以换用不同的中转站），
//     同一个中转站在 Anthropic 和 OpenAI 两种兼容模式下填的地址常常只差结尾的 /v1，算作同一个中转站。
//     官方接口（Anthropic、OpenAI、Gemini）也各算一个“中转站”。不同中转站、以及中转站和官方接口的同名模型分开计算。
//   - 每一级用加权的线性回归：实际输入 ≈ a × 中日韩字数 + b × 其他部分的粗略估算 + c。
//     a、b 分别是两类文字的系数（不同语言换算成 token 的比例不同），c 是固定的额外开销（例如中转站自己加的内容）。
//     没有数据时 a = b = 1、c = 0，就是粗略估算。模型级的起点：有共享数据时用共享数据，否则用中转站级的结果，
//     所以中转站里新用的模型也能直接沿用。旧的数据逐次减少权重，计数方式变了（例如中转站换了上游）也能跟上。
//   - 估算按块给出（estimate）：每块 = a × 中日韩字数 + b × 其他部分的粗略估算（空的块就是 0），总数 = 各块之和 + c。
//     每条消息的格式开销（角色标记等）不单独算：记忆长度固定时消息条数基本不变，这部分由 c 学到。
//     界面上写成「各块之和 + 加值 = 总数」，加值就是 c。不再按这个对话上一次的实际用量修正，总数严格按这个式子算。
//   - 每个对话记下上一次请求（按对话、中转站和模型分别记）发送时的估算和接口报告的实际用量，只用来显示，不参与估算。
//
// 共享校准数据（**目前关闭**：CALIB_SHARING 为 false 时不拉取、不推送、也不使用以前拉到的共享数据，只在本机校准。
// 代码保留，以后要打开时：把 CALIB_SHARING 改成 true，部署 worker/calibration，在仓库变量 CALIB_BASE_URL 填 Worker 地址，
// 并在设置里加回「匿名共享 token 校准数据」的勾选框（调用 setSharing）。打开后的行为如下，只在打包的原生应用里）：
//   - 启动时从 <CALIB_BASE_URL>/v1/calibration.json 拉取其他用户共享的系数（按中转站的域名和模型名），存在本机，
//     拉取失败时沿用上次拉到的。共享的系数只作为起点，有了本机的数据就以本机为主。
//   - 本机某个模型的校准稳定后（至少 2 次请求，并且最近一次的估算误差在 10% 以内；或者已经有 5 次请求），
//     如果共享数据里还没有它，或者和共享数据差得多，推送到 <CALIB_BASE_URL>/v1/contribute。同一个模型 7 天内最多推送一次。
//     推送的只有：中转站的域名（不含路径和端口以外的部分）、模型名、系数和数据量，以及一个随机的设备编号
//     （只用来让同一台设备的数据替换而不是叠加）。不推送 API Key、接口路径和任何对话内容。
//     IP 地址、localhost、内网域名（.local、.lan、.internal 等）和非 https 的地址不推送。设置里可以关掉推送（setSharing）。
//   - 拉取和推送都静默进行，成功失败都不提示；没有共享数据时只用本机的数据。服务器端见 worker/calibration。
//
// 只记录数字（字数、token 数），不记录任何对话内容。存在 localStorage，“清除软件数据”时一起删除；
// 完整备份（全部对话）里带上本机的校准数据（不含共享数据和设备编号），读取备份时合并进来。

// 是否共享校准数据（见上面的说明）。目前关闭
const CALIB_SHARING = false;
// 共享校准数据的服务器地址（结尾不带 /）。仓库里是空的（不共享）；打包工作流用仓库变量 CALIB_BASE_URL 填进来
const CALIB_BASE_URL = '';
// 两个条件都满足才共享
const CALIB_ENABLED = CALIB_SHARING && !!CALIB_BASE_URL;

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
  const DECAY = 0.9;           // 每来一次新数据，旧数据的权重乘以它
  const PRIOR_COEF = 1;        // a、b 起点的权重（相当于约一次请求的数据）
  const PRIOR_CONST = 1 / (1500 * 1500); // c 的起点的权重：c 通常在几千以内
  const CLOUD_PRIOR_SCALE = 2; // 起点来自共享数据（多人的数据）时，权重加倍
  const MIN_WEIGHT_SIZE = 300; // 很小的请求固定开销占比大，按至少这么大计算权重，免得它们左右系数
  const MAX_ANCHORS = 300;     // 最多记住多少个“对话 + 中转站 + 模型”的上一次请求
  // 实际值 ÷ 粗略估算超出这个范围的不进回归（只显示出来），原因见 observe
  const RATIO_MIN = 0.2;
  const RATIO_MAX = 50;
  // 已经校准过的模型碰到大偏差（见 observe）：
  const JUMP_MIN_K = 3;        // 至少有这么多次数据，才有可信的估算可以比较
  const JUMP_ERR = 0.3;        // 实际值和估算相差这么多以上算大偏差
  const JUMP_WEIGHT = 0.3;     // 第一次大偏差只按这个权重计入
  const COEF_MIN = 0.1;
  const COEF_MAX = 10;
  const CONST_MIN = -5000;
  const CONST_MAX = 50000;
  // 共享
  const STABLE_MIN = 2;        // 至少几次请求
  const STABLE_ERR = 0.1;      // 并且最近一次估算误差在这以内
  const STABLE_ANYWAY = 5;     // 或者至少这么多次请求
  const SUPPORT_MIN = 0.3;     // a（或 b）的数据量至少这么多才算可信（约等于一次主要是这类文字的请求的三分之一）
  const DIFF_PUSH = 0.15;      // 和共享数据差这么多以上才推送（共享数据里已经有这个模型时）
  const REPUSH_MS = 7 * 24 * 3600 * 1000;
  const PUSH_GAP_MS = 60 * 1000; // 两次推送至少间隔
  const NET_TIMEOUT_MS = 10000;
  const MAX_PUSH_ENTRIES = 20;

  // ---- 读写 ----
  // { relays: { 中转站: { s: 统计, models: { 模型名: { s: 统计, k: 进回归的请求次数, err: 最近一次估算的相对误差,
  //                                                     jump: 上一次的大偏差 { x, y, dir }，或已确认的变化 { dir, confirmed }（见 observe） } } } },
  //   anchors: { anchorKey(对话id, 中转站, 模型): { x: 特征, y: 实际输入, out: 实际输出, est: 发送时的估算（界面上显示的那个数）, t: 时间 } }
  //              （这个对话的上一次请求，只用来显示。没收到接口报告的用量时 y、out 为 null，也没有 x；没收到输出用量时 out 为 null）,
  //   cloud: { t: 拉取时间, relays: { 域名: { 模型名: { a, b, c } } } }（共享数据，没有的系数不写）,
  //   client: 随机的设备编号, pushed: { 域名\n模型名: { t: 推送时间, th: 推送的系数 } } }
  let store = null;
  const fresh = () => ({ relays: {}, anchors: {}, cloud: null, client: null, pushed: {} });
  function load() {
    if (store) return store;
    try { store = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { store = null; }
    if (!store || typeof store !== 'object' || !isObj(store.relays) || !isObj(store.anchors)) store = fresh();
    if (!isObj(store.pushed)) store.pushed = {};
    return store;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* 存不下就只在这次打开期间有效 */ }
  }
  function forget() {
    store = fresh();
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* 本来就没存 */ }
  }

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // 中转站、模型名都用作对象的键：这几个会碰到对象原型，不能用（来自共享数据、备份文件或者用户输入的模型名）
  const safeKey = (k) => typeof k === 'string' && !!k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

  // 接口地址 → 中转站。只看协议、主机、端口和路径；去掉结尾的 / 和 /v1
  function relayOf(base) {
    let s = (base || '').trim();
    if (!s) return '';
    try { const u = new URL(s); s = u.origin + u.pathname; } catch (_) { s = s.toLowerCase(); }
    while (s.endsWith('/')) s = s.slice(0, -1);
    if (/\/v1$/i.test(s)) s = s.slice(0, -3);
    return s;
  }

  // 中转站 → 共享数据里用的域名（含端口）。不能共享的（不是 https、IP 地址、本机和内网域名）返回 ''
  function hostOf(relay) {
    let u;
    try { u = new URL(relay); } catch (_) { return ''; }
    if (u.protocol !== 'https:') return '';
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h)) return '';
    if (/(^|\.)(localhost|local|lan|internal|intranet|home|corp|test|example|invalid|arpa)$/.test(h)) return '';
    return u.host.toLowerCase();
  }

  // ---- 特征 ----
  // 一段文字：[中日韩字数, 其他部分的粗略估算]
  function textFeatures(s) {
    if (!s) return [0, 0];
    const cjk = cjkCount(s);
    return [cjk, (s.length - cjk) / 4];
  }

  // 一次请求（system 文字 + 最终发送的消息列表）：[中日韩字数, 其他部分的粗略估算, 1]。
  // 以前的版本在第二项里加了每条消息 4 的格式开销；那时记下的数据照样能用（差别由 c 吸收，旧数据也会逐次衰减）
  function requestFeatures(system, messages) {
    let cjk = 0;
    let rest = 0;
    const add = (s) => { const [c, r] = textFeatures(s); cjk += c; rest += r; };
    if (system) add(system);
    for (const m of messages) add(m.content);
    return [cjk, rest, 1];
  }

  // ---- 回归 ----
  // 统计量 s = { A: 3×3（按行展开）, b: 3, n: 加权后的数据量 }。求解 (A + P) θ = b + P μ，P 是起点 μ 的权重
  const emptyStats = () => ({ A: [0, 0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0], n: 0 });
  const DEFAULT_THETA = [1, 1, 0];
  const PRIOR = [PRIOR_COEF, PRIOR_COEF, PRIOR_CONST];
  const CLOUD_PRIOR = PRIOR.map((p) => p * CLOUD_PRIOR_SCALE);

  // 加入一次请求的数据。weight 是这次数据的权重（默认 1）；decay 为 false 时旧数据不衰减（补记以前少算的权重时用）
  function addTo(s, x, y, weight = 1, decay = true) {
    const w = weight / Math.pow(Math.max(y, MIN_WEIGHT_SIZE), 2); // 按相对误差拟合：大请求和小请求同样重要
    if (decay) {
      for (let i = 0; i < 9; i++) s.A[i] *= DECAY;
      for (let i = 0; i < 3; i++) s.b[i] *= DECAY;
      s.n *= DECAY;
    }
    s.n += weight;
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

  const clampTheta = (th) => [clamp(th[0], COEF_MIN, COEF_MAX), clamp(th[1], COEF_MIN, COEF_MAX), clamp(th[2], CONST_MIN, CONST_MAX)];

  function thetaOf(s, mu, prior = PRIOR) {
    if (!s || !s.n) return mu;
    const M = s.A.slice();
    const v = s.b.slice();
    for (let i = 0; i < 3; i++) { M[i * 4] += prior[i]; v[i] += prior[i] * mu[i]; }
    const th = solve3(M, v);
    if (!th || !th.every(Number.isFinite)) return mu;
    return clampTheta(th);
  }

  const dot = (th, x) => th[0] * x[0] + th[1] * x[1] + th[2] * x[2];
  const anchorKey = (convId, relay, model) => JSON.stringify([convId, relay, model]);

  // 共享数据里这个中转站 + 模型的系数（没有的系数为 undefined），没有时为 null
  function cloudOf(relay, model) {
    if (!CALIB_ENABLED) return null; // 共享关闭时，以前拉到的共享数据也不用
    const c = load().cloud;
    const host = c && hostOf(relay);
    const byModel = host && own(c.relays, host) ? c.relays[host] : null;
    return byModel && own(byModel, model) ? byModel[model] : null;
  }

  // ---- 对外：估算 ----

  // 这个中转站 + 模型的系数。source：'local'（有本机的数据）、'cloud'（只有共享数据）或 null（粗略估算）
  function coefOf(relay, model) {
    const r = relay && own(load().relays, relay) ? load().relays[relay] : null;
    const m = r && model && own(r.models, model) ? r.models[model] : null;
    const relayTheta = thetaOf(r && r.s, DEFAULT_THETA);
    const cloud = relay && model ? cloudOf(relay, model) : null;
    let mu = relayTheta;
    if (cloud) mu = [finite(cloud.a) ? cloud.a : mu[0], finite(cloud.b) ? cloud.b : mu[1], finite(cloud.c) ? cloud.c : mu[2]];
    const source = m && m.s.n ? 'local' : cloud ? 'cloud' : r && r.s.n ? 'local' : null;
    return { theta: thetaOf(m && m.s, mu, cloud ? CLOUD_PRIOR : PRIOR), source };
  }

  // 一段文字校准后的 token 数（不含消息开销和固定开销）
  function textTokens(text, coef) {
    const [c, r] = textFeatures(text);
    const th = coef ? coef.theta : DEFAULT_THETA;
    return Math.max(0, Math.round(th[0] * c + th[1] * r));
  }

  // 一次请求的预估输入 token，按块给出。systemTexts：system 部分的各块；messageTexts：最终发送的各条消息。
  // 每块 = a × 中日韩字数 + b × 其他部分的粗略估算，四舍五入（空的块是 0）；
  // 加值 = c（四舍五入）；总数 = 各块之和 + 加值，严格相等（总数不会小于 0：c 是负数且各块很小时，加值相应调整）。
  // 返回 { system: [各块], messages: [各块], extra: 加值, total: 总数 }
  function estimate(relay, model, systemTexts, messageTexts) {
    const th = coefOf(relay, model).theta;
    const one = (text) => {
      const [c, r] = textFeatures(text);
      return Math.max(0, Math.round(th[0] * c + th[1] * r));
    };
    const system = systemTexts.map(one);
    const messages = messageTexts.map(one);
    const sum = system.reduce((p, q) => p + q, 0) + messages.reduce((p, q) => p + q, 0);
    const extra = Math.max(Math.round(th[2]), -sum);
    return { system, messages, extra, total: sum + extra };
  }

  // 这个对话上一次请求（同一中转站和模型）：{ input: 实际输入, output: 实际输出, est: 发送时的估算 }，没有时为 null。
  // 没收到的项为 null（input 为 null：没收到接口报告的用量；output 为 null：没收到输出用量）；以前的数据没有 est，为 null
  function lastOf(relay, model, convId) {
    const a = convId && relay && model ? load().anchors[anchorKey(convId, relay, model)] : null;
    if (!a) return null;
    return { input: finite(a.y) && a.y > 0 ? a.y : null, output: finite(a.out) && a.out > 0 ? a.out : null, est: finite(a.est) ? a.est : null };
  }

  // 记下这个对话的这次请求没收到接口报告的用量（回复中途断开、停止，或接口不报告用量）。只用来显示，不进回归
  function observeNone(relay, model, convId, est) {
    if (!safeKey(relay) || !safeKey(model) || !convId) return;
    const st = load();
    st.anchors[anchorKey(convId, relay, model)] = { y: null, out: null, est: finite(est) && est >= 0 ? est : null, t: Date.now() };
    trimAnchors(st.anchors);
    save();
  }

  // 记录一次请求的实际用量。x 是发送时算的特征，input / output 是接口报告的输入、输出 token，
  // est 是发送时的估算（estimate 的总数，只用来显示上一次估得准不准；回归始终用粗略估算的特征 x，不用它）
  function observe(relay, model, x, input, output, convId, est) {
    if (!safeKey(relay) || !safeKey(model) || !(input > 0)) return;
    const st = load();
    // 不进回归（只显示出来）的情况：
    //   实际值不到粗略估算的 1/5：几乎都是接口只报告了没命中缓存的部分（缓存命中后输入看起来只剩几十个 token），
    //     或者报告的是假数字（0、1、固定值）。真实的分词差异不会差到这个程度
    //   实际值超过粗略估算的 50 倍：报告的数字和内容已经没有关系了。
    //     （中转站偷偷加了很长的 system prompt 时，短对话的实际值也会是估算的十几二十倍，这是真实的，要进回归，由 c 学到）
    const ratio = input / Math.max(dot(DEFAULT_THETA, x), 1);
    const odd = !(ratio >= RATIO_MIN && ratio <= RATIO_MAX);
    if (!odd) {
      const r = st.relays[relay] || (st.relays[relay] = { s: emptyStats(), models: {} });
      const m = r.models[model] || (r.models[model] = { s: emptyStats(), k: 0, err: null });
      // 更新之前，回归估得准不准：用来判断校准是否已经稳定，以及这次是不是大偏差
      const before = dot(coefOf(relay, model).theta, x);
      m.err = Math.abs(before - input) / input;
      // 已经校准过的模型碰到大偏差：可能是偶发的怪数字，也可能是情况真的变了（中转站换了上游、模型名指向了新模型、
      // 开始加隐藏的提示词，或者换了一种粗略公式估得不准的语言）。
      //   第一次：只按 JUMP_WEIGHT 计入，记下来（m.jump）
      //   下一次又往同一个方向偏差很大：认定情况变了，把上次少算的权重补上，这次按正常权重计入；
      //     之后回归赶上来之前（还是同一个方向的大偏差）也都按正常权重计入
      //   下一次正常，或者往反方向偏：上次是偶发的，只留下 JUMP_WEIGHT 的影响
      const dir = Math.sign(input - before);
      const jump = (m.k || 0) >= JUMP_MIN_K && Math.abs(input - before) / Math.max(before, 1) > JUMP_ERR;
      const prev = m.jump;
      delete m.jump;
      let weight = 1;
      if (jump && prev && prev.dir === dir) {
        // 补上次少算的权重（已经确认过的不用补）。那次已经过去一次请求，这次计入时会对所有旧数据再衰减一次
        if (!prev.confirmed && validX(prev.x) && finite(prev.y)) {
          addTo(r.s, prev.x, prev.y, 1 - JUMP_WEIGHT, false);
          addTo(m.s, prev.x, prev.y, 1 - JUMP_WEIGHT, false);
        }
        m.jump = { dir, confirmed: true };
      } else if (jump) {
        weight = JUMP_WEIGHT;
        m.jump = { x, y: input, dir };
      }
      m.k = (m.k || 0) + 1;
      addTo(r.s, x, input, weight);
      addTo(m.s, x, input, weight);
    }
    if (convId) {
      const anchor = { x, y: input, out: output > 0 ? output : null, est: finite(est) && est >= 0 ? est : null, t: Date.now() };
      st.anchors[anchorKey(convId, relay, model)] = anchor;
      trimAnchors(st.anchors);
    }
    save();
    schedulePush();
  }

  function trimAnchors(anchors) {
    const ids = Object.keys(anchors);
    if (ids.length <= MAX_ANCHORS) return;
    ids.sort((p, q) => anchors[p].t - anchors[q].t);
    for (const id of ids.slice(0, ids.length - MAX_ANCHORS)) delete anchors[id];
  }

  // ---- 共享 ----

  let sharing = false; // 设置里的勾选框打开时由 setSharing 设为 true（勾选框目前去掉了）
  let pushTimer = null;
  let pushing = false;
  let lastPushAt = 0;

  // 设置里的“共享 token 校准数据”（只管推送；拉取别人的数据始终进行）
  function setSharing(on) {
    sharing = !!on;
    if (sharing) schedulePush();
  }

  async function request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
    try {
      return await fetch(CALIB_BASE_URL + path, { cache: 'no-store', ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // 共享数据：只留认得出、范围合理的系数
  function cleanCloud(j) {
    if (!isObj(j) || !isObj(j.relays)) return null;
    const relays = {};
    for (const host of Object.keys(j.relays)) {
      const models = j.relays[host];
      if (!safeKey(host) || !isObj(models) || host.length > 255) continue;
      for (const model of Object.keys(models)) {
        const e = models[model];
        if (!safeKey(model) || !isObj(e) || model.length > 200) continue;
        const out = {};
        if (finite(e.a)) out.a = clamp(e.a, COEF_MIN, COEF_MAX);
        if (finite(e.b)) out.b = clamp(e.b, COEF_MIN, COEF_MAX);
        if (finite(e.c)) out.c = clamp(e.c, CONST_MIN, CONST_MAX);
        if (!Object.keys(out).length) continue;
        (relays[host] || (relays[host] = {}))[model] = out;
      }
    }
    return relays;
  }

  // 启动时调用：拉取共享数据，再推送还没推送的。onCloud 在拉到新数据后调用（刷新界面上的估算）
  async function sync(onCloud) {
    if (!CALIB_ENABLED) return;
    try {
      const res = await request('/v1/calibration.json');
      if (res.ok) {
        const relays = cleanCloud(await res.json());
        if (relays) {
          load().cloud = { t: Date.now(), relays };
          save();
          if (onCloud) onCloud();
        }
      }
    } catch (_) { /* 静默：没有共享数据就只用本机的 */ }
    schedulePush();
  }

  // 本机已经稳定、值得推送的条目
  function pendingEntries() {
    const st = load();
    const now = Date.now();
    const byKey = new Map();
    for (const relay of Object.keys(st.relays)) {
      const host = hostOf(relay);
      if (!host) continue;
      const r = st.relays[relay];
      for (const model of Object.keys(r.models)) {
        const m = r.models[model];
        const k = m.k || 0;
        if (!model || model.length > 200 || k < STABLE_MIN) continue;
        if (k < STABLE_ANYWAY && !(m.err !== null && m.err <= STABLE_ERR)) continue;
        // 推送的系数只用本机的数据算（起点是粗略估算），不掺进共享数据，免得共享数据自己证明自己
        const th = thetaOf(m.s, DEFAULT_THETA);
        const entry = { relay: host, model, a: th[0], b: th[1], c: th[2], wa: m.s.A[0], wb: m.s.A[4], n: k };
        const key = host + '\n' + model;
        const prev = byKey.get(key);
        if (prev && prev.n >= k) continue; // 同一个域名下有几个地址时，用数据多的那个
        const pushed = st.pushed[key];
        const cloud = cloudOf(relay, model);
        const differs = (p) => {
          if (!p) return true;
          const d = (x, y, w) => w >= SUPPORT_MIN && finite(y) && Math.abs(x - y) / y > DIFF_PUSH;
          return d(th[0], p.a, entry.wa) || d(th[1], p.b, entry.wb);
        };
        if (pushed && now - pushed.t < REPUSH_MS) continue;
        if (cloud && !differs(cloud)) continue;
        if (pushed && !differs({ a: pushed.th[0], b: pushed.th[1] })) continue; // 和上次推送的差不多
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()].slice(0, MAX_PUSH_ENTRIES);
  }

  function schedulePush() {
    if (!CALIB_ENABLED || !sharing || pushTimer) return;
    const wait = Math.max(5000, lastPushAt + PUSH_GAP_MS - Date.now());
    pushTimer = setTimeout(() => { pushTimer = null; void push(); }, wait);
  }

  async function push() {
    if (!CALIB_ENABLED || !sharing || pushing) return;
    const entries = pendingEntries();
    if (!entries.length) return;
    const st = load();
    if (!st.client) {
      st.client = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      save();
    }
    pushing = true;
    lastPushAt = Date.now();
    try {
      const res = await request('/v1/contribute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, client: st.client, entries }),
      });
      if (res.ok) {
        const now = Date.now();
        for (const e of entries) st.pushed[e.relay + '\n' + e.model] = { t: now, th: [e.a, e.b, e.c] };
        save();
      }
    } catch (_) { /* 静默：下次再试 */ } finally {
      pushing = false;
    }
  }

  // ---- 完整备份 ----

  // 导出本机的校准数据：中转站和模型的统计量，以及 convIds 里这些对话的“上一次请求”。不含共享数据和设备编号
  function exportData(convIds) {
    const st = load();
    const anchors = {};
    for (const key of Object.keys(st.anchors)) {
      let id = null;
      try { id = JSON.parse(key)[0]; } catch (_) { /* 认不出的跳过 */ }
      if (convIds.has(id)) anchors[key] = st.anchors[key];
    }
    return { v: 1, relays: st.relays, anchors };
  }

  const validStats = (s) => isObj(s) && Array.isArray(s.A) && s.A.length === 9 && s.A.every(finite)
    && Array.isArray(s.b) && s.b.length === 3 && s.b.every(finite) && finite(s.n) && s.n >= 0;
  const validX = (x) => Array.isArray(x) && x.length === 3 && x.every(finite);

  // 读取完整备份时合并：同一个中转站 / 模型保留数据多的那份，同一个“上一次请求”保留新的那份。
  // idMap：备份里换了 id 才加进来的对话 { 旧 id: 新 id }，它们的“上一次请求”跟着换
  function importData(d, idMap = {}) {
    if (!isObj(d) || !isObj(d.relays)) return;
    const st = load();
    for (const relay of Object.keys(d.relays)) {
      const r = d.relays[relay];
      if (!safeKey(relay) || !isObj(r) || !validStats(r.s) || !isObj(r.models)) continue;
      const mine = own(st.relays, relay) ? st.relays[relay] : (st.relays[relay] = { s: emptyStats(), models: {} });
      if (r.s.n > mine.s.n) mine.s = r.s;
      for (const model of Object.keys(r.models)) {
        const m = r.models[model];
        if (!safeKey(model) || !isObj(m) || !validStats(m.s)) continue;
        const cur = own(mine.models, model) ? mine.models[model] : null;
        if (cur && cur.s.n >= m.s.n) continue;
        mine.models[model] = { s: m.s, k: Number.isInteger(m.k) && m.k >= 0 ? m.k : 0, err: finite(m.err) ? m.err : null };
      }
    }
    if (isObj(d.anchors)) {
      for (const oldKey of Object.keys(d.anchors)) {
        const a = d.anchors[oldKey];
        let key = oldKey;
        try {
          const [convId, relay, model] = JSON.parse(oldKey);
          if (own(idMap, convId)) key = anchorKey(idMap[convId], relay, model);
        } catch (_) { continue; } // 认不出的跳过
        if (!safeKey(key) || !isObj(a) || !finite(a.t)) continue;
        const got = finite(a.y) && a.y > 0; // 收到了接口报告的用量；没收到的（observeNone）只有 est
        if (got ? !validX(a.x) : a.y !== null) continue;
        const cur = own(st.anchors, key) ? st.anchors[key] : null;
        if (cur && cur.t >= a.t) continue;
        const est = finite(a.est) && a.est >= 0 ? a.est : null;
        const copy = got ? { x: a.x, y: a.y, out: finite(a.out) && a.out > 0 ? a.out : null, est, t: a.t } : { y: null, out: null, est, t: a.t };
        st.anchors[key] = copy;
      }
      trimAnchors(st.anchors);
    }
    save();
    schedulePush();
  }

  return {
    relayOf, requestFeatures, coefOf, textTokens, estimate, lastOf, observe, observeNone, forget,
    setSharing, sync, exportData, importData,
    _test: { hostOf, pendingEntries, push },
  };
})();
