// 读取酒馆（SillyTavern）的角色卡和世界书。只读取，不导出。
//
// 支持的文件：
//   - PNG 角色卡：图片的 tEXt（或未压缩的 iTXt）块里存着卡的 JSON（UTF-8 再 base64）。
//     V1 / V2 卡的块名是 chara，V3 卡是 ccv3；两个都有时用 ccv3。
//   - JSON 角色卡：V2 / V3 是 { spec: 'chara_card_v2' | 'chara_card_v3', data: {…} }，V1 的字段直接在最外层。
//   - 单独的世界书 JSON：酒馆导出的格式是 { entries: { "0": { key, content, comment, constant, order, disable, … } } }；
//     也接受角色卡里内嵌世界书（character_book）的格式 { name, entries: [ { keys, content, name, comment, constant,
//     insertion_order, enabled, … } ] }。
// 世界书只是全文读取：Proteus 不按关键词触发条目。
const STCard = (() => {
  const str = (x) => (typeof x === 'string' ? x : '');

  // ---- PNG ----

  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function isPng(bytes) {
    return bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b);
  }

  // 单字节编码（tEXt 块是 Latin-1；base64 文字都在 ASCII 范围内）
  function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
  }

  const utf8 = (bytes) => new TextDecoder().decode(bytes);

  // 取出 PNG 里名为 chara / ccv3 的文字块：{ chara?: string, ccv3?: string }
  function pngTexts(bytes) {
    const out = {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 8;
    while (p + 12 <= bytes.length) {
      const len = view.getUint32(p);
      const type = latin1(bytes.subarray(p + 4, p + 8));
      const start = p + 8;
      const end = start + len;
      if (end + 4 > bytes.length) break;
      if (type === 'tEXt' || type === 'iTXt') {
        const data = bytes.subarray(start, end);
        const z = data.indexOf(0);
        const key = z > 0 ? latin1(data.subarray(0, z)).toLowerCase() : '';
        if (key === 'chara' || key === 'ccv3') {
          if (type === 'tEXt') {
            out[key] = latin1(data.subarray(z + 1));
          } else if (data[z + 1] === 0) {
            // iTXt：关键字 \0 压缩标志 压缩方法 语言 \0 翻译后的关键字 \0 文字（UTF-8）。只读未压缩的
            const a = data.indexOf(0, z + 3);
            const b = a < 0 ? -1 : data.indexOf(0, a + 1);
            if (b >= 0) out[key] = utf8(data.subarray(b + 1));
          }
        }
      }
      if (type === 'IEND') break;
      p = end + 4; // 跳过 CRC
    }
    return out;
  }

  // 文字块的内容：通常是 base64，少数工具直接写 JSON
  function decodePayload(text) {
    const s = text.trim();
    if (s.startsWith('{')) return JSON.parse(s);
    const bin = atob(s.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(utf8(bytes));
  }

  // PNG 角色卡里的 JSON；没有或读不出来时返回 null
  function fromPng(bytes) {
    const texts = pngTexts(bytes);
    for (const key of ['ccv3', 'chara']) {
      if (texts[key] == null) continue;
      try {
        const obj = decodePayload(texts[key]);
        if (detect(obj)) return obj;
      } catch (_) { /* 换另一个块试试 */ }
    }
    return null;
  }

  // ---- 识别 ----

  const CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
  const looksLikeCard = (o) => !!o && typeof o === 'object' && typeof o.name === 'string'
    && CARD_FIELDS.some((k) => typeof o[k] === 'string');
  const looksLikeBook = (o) => !!o && typeof o === 'object' && !!o.entries && typeof o.entries === 'object';

  // { kind: 'card', card } 或 { kind: 'book', book }；都不是时返回 null
  function detect(obj) {
    if (!obj || typeof obj !== 'object' || obj.app === 'proteus') return null;
    if (looksLikeCard(obj.data) && (/^chara_card_v[23]$/.test(str(obj.spec)) || !looksLikeCard(obj))) {
      return { kind: 'card', card: normalizeCard(obj.data) };
    }
    // 世界书要先于 V1 角色卡判断：有的世界书（例如从 Chub 导出的）最外层也有 name 和 description，
    // 而角色卡的世界书都嵌在 character_book 里，最外层不会有 entries
    if (looksLikeBook(obj)) return { kind: 'book', book: obj };
    if (looksLikeCard(obj)) return { kind: 'card', card: normalizeCard(obj) };
    return null;
  }

  function normalizeCard(d) {
    return {
      name: str(d.name),
      description: str(d.description),
      personality: str(d.personality),
      scenario: str(d.scenario),
      first_mes: str(d.first_mes),
      mes_example: str(d.mes_example),
      creator_notes: str(d.creator_notes),
      system_prompt: str(d.system_prompt),
      post_history_instructions: str(d.post_history_instructions),
      alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter((x) => typeof x === 'string') : [],
      character_book: looksLikeBook(d.character_book) ? d.character_book : null,
    };
  }

  // ---- 世界书 ----

  // 可用的条目，按发送顺序排好：常驻条目在前，其余按插入顺序（数字小的在前），相同时保持原来的顺序。
  // 禁用的和内容为空的跳过
  function lorebookEntries(book) {
    const raw = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
    return raw
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e && typeof e === 'object' && str(e.content).trim() && e.enabled !== false && e.disable !== true)
      .map(({ e, i }) => ({
        title: str(e.comment).trim() || str(e.name).trim(),
        content: str(e.content).trim(),
        constant: e.constant === true,
        order: num(e.insertion_order !== undefined ? e.insertion_order : e.order, 100),
        i,
      }))
      .sort((a, b) => (b.constant - a.constant) || (a.order - b.order) || (a.i - b.i));
  }

  // 条目拼成一段文字：有名称（或备注）的条目以名称作小标题，条目之间空一行
  function lorebookText(entries) {
    return entries.map((x) => (x.title ? `### ${x.title}\n${x.content}` : x.content)).join('\n\n');
  }

  // ---- 宏 ----

  // 导入时的处理：删掉作者注释 {{// …}}；老卡的 <USER> 改成 {{user}}，<BOT>、<CHAR>、{{charIfNotGroup}} 改成 {{char}}。
  // {{user}} 和 {{char}} 本身保留，显示和发送时再换成 {{user}} 的值和角色卡的名字
  function importMacros(s) {
    return str(s)
      .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
      .replace(/<user>/gi, '{{user}}')
      .replace(/\{\{charIfNotGroup\}\}|<bot>|<char>/gi, '{{char}}');
  }

  // {{original}}：卡的 System Prompt 里表示“用户原来的 System Prompt 放在这里”
  function replaceOriginal(s, value) {
    return str(s).replace(/\{\{original\}\}/gi, () => value);
  }

  return { isPng, fromPng, detect, lorebookEntries, lorebookText, importMacros, replaceOriginal };
})();
