// 生成更新服务器上一个频道的 version.json（见 js/update.js 开头的说明）。
// 用法：node scripts/update-manifest.js <安装包所在目录> <版本标签> <输出文件> [服务器上现有的 version.json]
// 按文件名认出各平台的安装包。服务器上现有的版本比这次的新时（例如重新打包了一个旧版本），
// 不生成文件、以退出码 3 结束，这个频道保持不变。
const fs = require('fs');
const path = require('path');
const { compareVersions } = require('../js/update.js');

const [dir, tag, out, existing] = process.argv.slice(2);
const version = tag.replace(/^v/, '');

if (existing && fs.existsSync(existing)) {
  try {
    const old = JSON.parse(fs.readFileSync(existing, 'utf8'));
    if (compareVersions(old.version, version) > 0) {
      console.log(`The server already has ${old.version}, newer than ${version}: leaving this channel as it is.`);
      process.exit(3);
    }
  } catch (_) { /* 现有的文件读不懂：直接覆盖 */ }
}

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
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
