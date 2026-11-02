// 打包前把更新服务器的地址写进 js/update.js（仓库里是空的，表示不检查更新）。
// 用法：node scripts/set-update-url.js <地址>，地址为空时不改动。地址结尾的 / 会去掉。
const fs = require('fs');
const path = require('path');

const url = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!url) {
  console.log('No update server address: the app will not check for updates.');
  process.exit(0);
}
if (!/^https:\/\/[^\s'"\\]+$/.test(url)) {
  console.error(`Not an https address: ${url}`);
  process.exit(1);
}
const file = path.join(__dirname, '..', 'js', 'update.js');
const src = fs.readFileSync(file, 'utf8');
const line = "const UPDATE_BASE_URL = '';";
if (!src.includes(line)) {
  console.error(`js/update.js has no line ${line}`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(line, `const UPDATE_BASE_URL = '${url}';`));
console.log(`Update server: ${url}`);
