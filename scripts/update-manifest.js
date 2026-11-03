// 生成更新服务器上一个频道的 version.json（见 js/update.js 开头的说明）。
// 用法：node scripts/update-manifest.js <安装包所在目录> <版本标签> <输出文件> [服务器上现有的 version.json] [更新说明 JSON]
// 按文件名认出各平台的安装包。服务器上现有的版本比这次的新时（例如重新打包了一个旧版本），
// 不生成文件、以退出码 3 结束，这个频道保持不变。
// 更新说明 JSON 是 scripts/release-notes.js collect 的输出。version.json 里的 notes 是这个版本的说明
// （{ 'zh-CN': [...], 'zh-TW': [...], en: [...], ja: [...] }），history 是这个频道最近几个版本的说明（最新的在前），
// 用户跳过了几个版本时，软件可以显示中间版本的说明。history 接着服务器上现有的 version.json 往下记
const fs = require('fs');
const path = require('path');
const { compareVersions } = require('../js/update.js');

const [dir, tag, out, existing, changesFile] = process.argv.slice(2);
const version = tag.replace(/^v/, '');
const HISTORY_SIZE = 10; // history 最多记几个版本

let old = null;
if (existing && fs.existsSync(existing)) {
  try {
    old = JSON.parse(fs.readFileSync(existing, 'utf8'));
    if (compareVersions(old.version, version) > 0) {
      console.log(`The server already has ${old.version}, newer than ${version}: leaving this channel as it is.`);
      process.exit(3);
    }
  } catch (_) { old = null; /* 现有的文件读不懂：直接覆盖 */ }
}

// 这个版本的更新说明（四种语言都没有内容时不写）
let notes = null;
if (changesFile && fs.existsSync(changesFile)) {
  try {
    const n = JSON.parse(fs.readFileSync(changesFile, 'utf8')).notes || {};
    if (Object.values(n).some((list) => Array.isArray(list) && list.length)) notes = n;
  } catch (_) { /* 读不懂：不写说明 */ }
}
// 说明历史：服务器上现有的 history（旧格式只有 notes 时用它）里比这个版本旧的，加上这个版本的
const oldHistory = old ? (Array.isArray(old.history) ? old.history : old.notes ? [{ version: old.version, notes: old.notes }] : []) : [];
// 重新打包同一个版本、这次没收集到说明（例如读取 PR 时出错）：沿用服务器上已有的这个版本的说明
if (!notes) {
  const same = oldHistory.find((e) => e && e.notes && compareVersions(e.version, version) === 0);
  if (same) notes = same.notes;
}
const history = [
  ...(notes ? [{ version, notes }] : []),
  ...oldHistory.filter((e) => e && e.notes && compareVersions(e.version, version) < 0),
].sort((a, b) => compareVersions(b.version, a.version)).slice(0, HISTORY_SIZE);

const PATTERNS = {
  'win-setup': /^Proteus-Setup-.*-win-x64\.exe$/,
  'win-zip': /^Proteus-.*-win-x64\.zip$/,
  'mac-arm64': /^Proteus-.*-mac-arm64\.dmg$/,
  'mac-x64': /^Proteus-.*-mac-x64\.dmg$/,
  linux: /^Proteus-.*-linux-(x86_64|x64)\.AppImage$/,
  android: /^Proteus-.*-android\.apk$/,
};
const names = fs.readdirSync(dir);
const files = {};
for (const [key, re] of Object.entries(PATTERNS)) {
  const name = names.find((n) => re.test(n));
  if (name) files[key] = name;
  else console.log(`::warning::No ${key} file among the installers`);
}
const repo = process.env.GITHUB_REPOSITORY || 'IonComan813/ProjectProteus';
const manifest = {
  version,
  tag,
  date: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || null,
  release: `https://github.com/${repo}/releases/tag/${tag}`,
  files,
  ...(notes ? { notes } : {}),
  history,
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
