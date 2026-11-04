// 更新说明：仓库里的 .github/next-release.md 记着「上一个版本以来、用户能感觉到的改动」，
// 发布版本时打包工作流读取它，写进 Release 页面（中英双语）和更新服务器上的 version.json（软件的更新提示里显示，四种语言）。
//
// .github/next-release.md 的格式：
//
//   基准版本: v0.5.0
//
//   - zh-CN: 修复了特定窗口无法按照预期关闭的问题
//     zh-TW: 修復了特定視窗無法按照預期關閉的問題
//     en: Fixed some windows not closing as expected
//     ja: 一部のウィンドウが想定どおりに閉じない問題を修正しました
//
// 「基准版本」是上一个发布的版本：文件里是这之后的改动。每一条以「- 语言:」开头，同一条的其他语言缩进写在下面。
// zh-CN 和 en 必须有（Release 页面是中英双语）；zh-TW、ja 缺了时分别用 zh-CN、en 代替。<!-- --> 里的是注释，空行可以随便加。
//
// 每个 PR 都要维护这个文件：
//   - 有用户能感觉到的改动：在文件里加条目；和以前的条目冲突的（例如这次改掉、撤销了以前加的功能），删掉或改成最新的说法。
//     这样到发布时，文件里就是干净准确的这个版本的更新说明
//   - 发布了新版本以后的第一个 PR：清空文件里的条目，把基准版本改成刚发布的版本
// PR 正文的开头必须有这样一段（检查只看结构，第二行写一句做了什么即可）：
//
//   ## 更新说明文件
//   - 已更新：加入 1 条；删去和它冲突的「……」
//
// 没有改这个文件时写「- 无需更新」（后面可以加原因）。PR 检查会核对：改了文件就要写「已更新」，没改就要写「无需更新」；
// 文件格式正确；基准版本是最新发布的版本（不是的话说明刚发布过版本、还没有清空）。
// PR 正文的其他部分只写详细的改动说明，不再收集。
//
// 用法：
//   node scripts/release-notes.js check <PR 事件的 JSON 文件>
//     检查 PR 正文开头的那一段和这个文件（.github/workflows/pr-notes-check.yml 用；要有完整的提交历史和标签）
//   node scripts/release-notes.js collect <版本标签> <输出的 JSON 文件>
//     读取这个文件，写出这个版本的更新说明（.github/workflows/build.yml 用）。出错时只给出警告、输出空的说明，不让发布失败
//   node scripts/release-notes.js apply <Release 说明的 Markdown 文件> <collect 输出的 JSON 文件>
//     把说明写成中英双语的一段，放在 Release 说明的最前面（替换掉以前写过的那一段）
const fs = require('fs');
const { execFileSync } = require('child_process');

const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja'];
const FALLBACK = { 'zh-TW': 'zh-CN', ja: 'en' };
const NOTES_FILE = '.github/next-release.md';
// 用固定位置的 git（GitHub 的 Ubuntu 运行环境里在这里），不按 PATH 去找；本机没有时才按 PATH 找
const GIT = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const START = '<!-- proteus-changes -->';
const END = '<!-- /proteus-changes -->';
const VERSION_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// 解析 .github/next-release.md。返回 { base, entries: [{ 语言: 文字 }], errors: [], warnings: [] }
function parseFile(text) {
  const result = { base: null, entries: [], errors: [], warnings: [] };
  // 去掉注释（可以跨行）：换成同样多的空行，报错时的行号不变
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')).split('\n');
  let cur = null;
  lines.forEach((raw, i) => {
    const at = `第 ${i + 1} 行`;
    if (!raw.trim()) return;
    let m;
    if ((m = /^基准版本\s*[:：]\s*(\S+)\s*$/.exec(raw.trim()))) {
      if (result.base) result.errors.push(`${at}：基准版本写了两次。`);
      else if (!VERSION_TAG.test(m[1])) result.errors.push(`${at}：基准版本应该是版本标签，例如 v0.5.0。`);
      else result.base = m[1];
      cur = null;
    } else if ((m = /^[-*]\s*(zh-CN|zh-TW|en|ja)\s*[:：]\s*(\S.*)$/.exec(raw))) {
      cur = { [m[1]]: m[2].trim() };
      result.entries.push(cur);
    } else if ((m = /^\s+(zh-CN|zh-TW|en|ja)\s*[:：]\s*(\S.*)$/.exec(raw)) && cur) {
      if (cur[m[1]]) result.errors.push(`${at}：同一条里 ${m[1]} 写了两次。`);
      else cur[m[1]] = m[2].trim();
    } else {
      result.errors.push(`${at}：认不出这一行：${raw.trim()}`);
    }
  });
  if (!result.base) result.errors.push('缺少「基准版本: vX.Y.Z」一行。');
  result.entries.forEach((e, i) => {
    const name = `第 ${i + 1} 条（${(e['zh-CN'] || e.en || Object.values(e)[0]).slice(0, 20)}…）`;
    for (const lang of ['zh-CN', 'en']) if (!e[lang]) result.errors.push(`${name}缺少 ${lang}（Release 页面是中英双语）。`);
    for (const lang of ['zh-TW', 'ja']) if (!e[lang]) result.warnings.push(`${name}没有 ${lang}，软件里会用 ${FALLBACK[lang]} 的代替。`);
  });
  return result;
}

// 条目按四种语言整理（缺的语言用 FALLBACK 代替）：{ 语言: [文字] }
function notesOf(entries) {
  const out = Object.fromEntries(LANGS.map((l) => [l, []]));
  for (const e of entries) {
    for (const lang of LANGS) {
      const text = e[lang] || e[FALLBACK[lang]];
      if (text) out[lang].push(text);
    }
  }
  return out;
}

// PR 正文开头的「## 更新说明文件」一段。返回 { found, updated, errors: [] }（updated：true 已更新 / false 无需更新）
function parseBlock(body) {
  const result = { found: false, updated: null, errors: [] };
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !/^#{2,3}\s*更新说明文件\s*$/.test(lines[i].trim())) {
    result.errors.push('PR 正文的第一行应该是「## 更新说明文件」。');
    return result;
  }
  result.found = true;
  const items = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#/.test(line) || /^-{3,}$/.test(line)) break;
    if (line) items.push(line);
  }
  if (items.length !== 1) {
    result.errors.push(`「## 更新说明文件」下面应该正好有一行（「- 已更新：……」或「- 无需更新」），现在有 ${items.length} 行。`);
    return result;
  }
  if (/^[-*]\s*已更新/.test(items[0])) result.updated = true;
  else if (/^[-*]\s*无需更新/.test(items[0])) result.updated = false;
  else result.errors.push(`认不出这一行：${items[0]}（应该以「- 已更新」或「- 无需更新」开头）`);
  return result;
}

const git = (args) => execFileSync(GIT, args, { encoding: 'utf8' });

// 最新发布的版本标签（v 开头的标签里版本号最大的）；没有时为 null
function latestTag() {
  const { compareVersions } = require('../js/update.js');
  let best = null;
  for (const t of git(['tag', '--list', 'v*']).split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (Number.isNaN(compareVersions(t, t))) continue; // 认不出的标签
    if (!best || compareVersions(t, best) > 0) best = t;
  }
  return best;
}

function check(eventFile) {
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const pr = event.pull_request || {};
  const errors = [];
  const warnings = [];

  const block = parseBlock(pr.body);
  errors.push(...block.errors);

  let file = null;
  if (!fs.existsSync(NOTES_FILE)) errors.push(`仓库里没有 ${NOTES_FILE}。`);
  else {
    file = parseFile(fs.readFileSync(NOTES_FILE, 'utf8'));
    errors.push(...file.errors.map((e) => `${NOTES_FILE}：${e}`));
    warnings.push(...file.warnings.map((w) => `${NOTES_FILE}：${w}`));
  }

  // 这个 PR 有没有改这个文件（和目标分支的分叉点比）
  if (block.updated !== null && pr.base && pr.head) {
    let changed = null;
    try {
      changed = !!git(['diff', '--name-only', `${pr.base.sha}...${pr.head.sha}`, '--', NOTES_FILE]).trim();
    } catch (e) {
      warnings.push(`没能比较这个 PR 的改动（${e.message.split('\n')[0]}），跳过「已更新 / 无需更新」的核对。`);
    }
    if (changed === true && !block.updated) errors.push(`这个 PR 改了 ${NOTES_FILE}，「## 更新说明文件」下面应该写「- 已更新：……」。`);
    if (changed === false && block.updated) errors.push(`这个 PR 没有改 ${NOTES_FILE}，却写了「已更新」。`);
  }

  // 基准版本应该是最新发布的版本：不是的话，说明发布过新版本、文件还没有清空
  if (file && file.base) {
    let latest = null;
    try { latest = latestTag(); } catch (e) { warnings.push(`没能读取版本标签（${e.message.split('\n')[0]}），跳过基准版本的核对。`); }
    if (latest && latest !== file.base) {
      errors.push(`已经发布了 ${latest}，${NOTES_FILE} 的基准版本还是 ${file.base}：请清空文件里的条目（它们已经在 ${latest} 里发布了），把基准版本改成 ${latest}，再写这个 PR 的条目。`);
    }
  }

  for (const w of warnings) console.log(`::warning::${w}`);
  if (errors.length) {
    for (const e of errors) console.log(`::error::${e}`);
    console.log('\n规则见 scripts/release-notes.js 开头的说明。PR 正文开头例如：\n\n## 更新说明文件\n- 已更新：加入 1 条\n\n没有改那个文件时写「- 无需更新」。');
    process.exit(1);
  }
  console.log(`${NOTES_FILE}：基准版本 ${file.base}，${file.entries.length} 条。这个 PR：${block.updated ? '已更新' : '无需更新'}`);
}

function collect(tag, out) {
  const version = tag.replace(/^v/, '');
  const result = { version, tag, from: null, notes: Object.fromEntries(LANGS.map((l) => [l, []])) };
  try {
    if (!fs.existsSync(NOTES_FILE)) throw new Error(`${NOTES_FILE} does not exist`);
    const file = parseFile(fs.readFileSync(NOTES_FILE, 'utf8'));
    for (const w of [...file.errors, ...file.warnings]) console.log(`::warning::${NOTES_FILE}: ${w}`);
    result.from = file.base;
    result.notes = notesOf(file.entries.filter((e) => e['zh-CN'] && e.en));
    if (file.base === tag) console.log(`::warning::${NOTES_FILE} is based on ${tag} itself: were the notes cleared already?`);
    console.log(`Release notes for ${tag} (changes since ${file.base || '?'}), ${result.notes['zh-CN'].length} entries:`);
  } catch (e) {
    console.log(`::warning::Could not read the release notes: ${e.message}`);
  }
  console.log(JSON.stringify(result.notes, null, 2));
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
}

// Release 说明里的中英双语一段：没有说明时为空
function releaseSection(changes) {
  const zh = (changes.notes && changes.notes['zh-CN']) || [];
  const en = (changes.notes && changes.notes.en) || [];
  if (!zh.length && !en.length) return '';
  const list = (items) => items.map((s) => `- ${s}`).join('\n');
  return `${START}\n### 更新内容\n${list(zh)}\n\n### What's changed\n${list(en)}\n${END}\n\n`;
}

function apply(mdFile, changesFile) {
  let body = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  const changes = fs.existsSync(changesFile) ? JSON.parse(fs.readFileSync(changesFile, 'utf8')) : {};
  // 去掉以前写过的那一段（重新打包时会再运行一次）
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s >= 0 && e > s) body = body.slice(0, s) + body.slice(e + END.length).replace(/^\s*\n/, '');
  fs.writeFileSync(mdFile, releaseSection(changes) + body.replace(/^\s+/, ''));
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'check') check(args[0]);
  else if (cmd === 'collect') collect(args[0], args[1]);
  else if (cmd === 'apply') apply(args[0], args[1]);
  else {
    console.error('usage: release-notes.js check <event.json> | collect <tag> <out.json> | apply <notes.md> <changes.json>');
    process.exit(2);
  }
}

module.exports = { parseFile, parseBlock, notesOf, releaseSection, LANGS, NOTES_FILE };
