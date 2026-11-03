// 更新说明：每个 PR 的正文开头写一段简短的更新说明，发布版本时自动收集，
// 写进 Release 页面（中英双语）和更新服务器上的 version.json（软件的更新提示里显示，四种界面语言）。
//
// PR 正文开头的格式（第一行就是这个标题；每条一行，一种语言一行，几条就重复几次）：
//
//   ## 更新说明
//   - zh-CN: 修复了特定窗口无法按照预期关闭的问题
//   - zh-TW: 修復了特定視窗無法按照預期關閉的問題
//   - en: Fixed some windows not closing as expected
//   - ja: 一部のウィンドウが想定どおりに閉じない問題を修正しました
//
// zh-CN 和 en 必须有（Release 页面是中英双语）；zh-TW、ja 缺了时分别用 zh-CN、en 代替。
// 用户感觉不到的改动（例如只改了打包流程）写成一行「- 无」（或「- none」），这个 PR 就不进更新说明。
// 标题下面到下一个标题（# 开头）或分隔线（---）为止都算说明块，块里只能有上面这几种行（空行可以）。
//
// 用法：
//   node scripts/release-notes.js check <PR 事件的 JSON 文件>
//     检查 PR 正文开头有没有合格的更新说明（.github/workflows/pr-notes-check.yml 用）
//   node scripts/release-notes.js collect <版本标签> <输出的 JSON 文件>
//     收集这个版本和上一个版本之间合并的 PR 的更新说明（.github/workflows/build.yml 用）。
//     上一个版本：正式版找上一个正式版（中间的测试版的改动也算进来），测试版找上一个版本（正式版或测试版）。
//     需要环境变量 GH_TOKEN（或 GITHUB_TOKEN）和 GITHUB_REPOSITORY；要有完整的提交历史和标签。
//     出错时只给出警告、输出空的说明，不让发布失败
//   node scripts/release-notes.js apply <Release 说明的 Markdown 文件> <collect 输出的 JSON 文件>
//     把收集到的说明写成中英双语的一段，放在 Release 说明的最前面（替换掉以前写过的那一段）
const fs = require('fs');
const { execFileSync } = require('child_process');

const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja'];
const FALLBACK = { 'zh-TW': 'zh-CN', ja: 'en' };
const START = '<!-- proteus-changes -->';
const END = '<!-- /proteus-changes -->';

// 解析 PR 正文。返回 { found, none, notes: { 语言: [条目] }, errors: [], warnings: [] }
function parseNotes(body) {
  const result = { found: false, none: false, notes: {}, errors: [], warnings: [] };
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !/^#{2,3}\s*更新说明\s*$/.test(lines[i].trim())) {
    result.errors.push('PR 正文的第一行应该是「## 更新说明」。');
    return result;
  }
  result.found = true;
  for (i++; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#/.test(line) || /^-{3,}$/.test(line)) break;
    if (!line) continue;
    let m;
    if ((m = /^[-*]\s*(zh-CN|zh-TW|en|ja)\s*[:：]\s*(\S.*)$/.exec(line))) {
      (result.notes[m[1]] = result.notes[m[1]] || []).push(m[2].trim());
    } else if (/^[-*]\s*(无|none)\s*$/i.test(line)) {
      result.none = true;
    } else {
      result.errors.push(`更新说明里有认不出的行：${line}`);
    }
  }
  const count = Object.values(result.notes).reduce((n, list) => n + list.length, 0);
  if (result.none && count) result.errors.push('写了「- 无」就不能再写说明条目。');
  if (!result.none) {
    if (!count) result.errors.push('更新说明是空的：写说明条目，或者写一行「- 无」。');
    for (const lang of ['zh-CN', 'en']) {
      if (count && !result.notes[lang]) result.errors.push(`缺少 ${lang} 的说明（Release 页面是中英双语）。`);
    }
    for (const lang of ['zh-TW', 'ja']) {
      if (count && !result.notes[lang]) result.warnings.push(`没有 ${lang} 的说明，软件里会用 ${FALLBACK[lang]} 的代替。`);
    }
    const counts = LANGS.filter((l) => result.notes[l]).map((l) => `${l} ${result.notes[l].length}`);
    if (new Set(LANGS.filter((l) => result.notes[l]).map((l) => result.notes[l].length)).size > 1) {
      result.warnings.push(`各语言的条数不一样（${counts.join('，')}），请确认没有漏写。`);
    }
  }
  return result;
}

// 某个 PR 的说明按四种语言补齐（缺的语言用 FALLBACK 代替）；没有说明时返回 null
function completeNotes(parsed) {
  if (!parsed.found || parsed.none || parsed.errors.length) return null;
  const out = {};
  for (const lang of LANGS) out[lang] = parsed.notes[lang] || parsed.notes[FALLBACK[lang]] || [];
  return out;
}

function check(eventFile) {
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const pr = event.pull_request || {};
  const parsed = parseNotes(pr.body);
  for (const w of parsed.warnings) console.log(`::warning::${w}`);
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.log(`::error::${e}`);
    console.log('\n格式见 scripts/release-notes.js 开头的说明，例如：\n\n## 更新说明\n- zh-CN: 修复了……\n- zh-TW: 修復了……\n- en: Fixed …\n- ja: ……を修正しました\n\n用户感觉不到的改动写一行「- 无」。');
    process.exit(1);
  }
  console.log(parsed.none ? '这个 PR 标明没有用户能感觉到的改动。' : `更新说明：${JSON.stringify(parsed.notes, null, 2)}`);
}

// 上一个版本的标签：正式版找比它旧的最新正式版，测试版找比它旧的最新版本
function previousTag(tag) {
  const { compareVersions } = require('../js/update.js');
  const stable = !tag.includes('-');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  let best = null;
  for (const t of tags) {
    if (stable && t.includes('-')) continue;
    if (!(compareVersions(t, tag) < 0)) continue; // 认不出的标签（NaN）也跳过
    if (!best || compareVersions(t, best) > 0) best = t;
  }
  return best;
}

async function api(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(base + path, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function collect(tag, out) {
  const version = tag.replace(/^v/, '');
  const result = { version, tag, from: null, prs: [], notes: Object.fromEntries(LANGS.map((l) => [l, []])) };
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
    const prev = previousTag(tag);
    result.from = prev;
    // 这两个版本之间的提交（第一个版本：最多看最近 300 个提交）
    const range = prev ? [`${prev}..${tag}`] : ['--max-count=300', tag];
    const commits = execFileSync('git', ['rev-list', ...range], { encoding: 'utf8' }).split('\n').filter(Boolean);
    // 每个提交属于哪些已合并的 PR（普通合并、压缩合并、变基合并都查得到）
    const prs = new Map();
    for (const sha of commits) {
      for (const pr of await api(`/repos/${repo}/commits/${sha}/pulls`)) {
        if (pr.merged_at && !prs.has(pr.number)) prs.set(pr.number, pr);
      }
    }
    const sorted = [...prs.values()].sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));
    for (const pr of sorted) {
      const parsed = parseNotes(pr.body);
      const notes = completeNotes(parsed);
      result.prs.push({ number: pr.number, notes: !!notes });
      if (!notes) {
        if (!parsed.none) console.log(`::warning::PR #${pr.number} has no usable release notes: ${parsed.errors.join(' ')}`);
        continue;
      }
      for (const lang of LANGS) result.notes[lang].push(...notes[lang]);
    }
    console.log(`Release notes for ${tag} (since ${prev || 'the beginning'}), from PRs ${result.prs.map((p) => '#' + p.number).join(' ') || '(none)'}:`);
  } catch (e) {
    console.log(`::warning::Could not collect release notes: ${e.message}`);
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

module.exports = { parseNotes, completeNotes, releaseSection, LANGS };
