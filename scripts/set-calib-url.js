// 打包前把共享 token 校准数据的服务器地址写进 js/tokens.js（仓库里是空的，表示不拉取也不推送）。
// 用法：node scripts/set-calib-url.js <地址>，地址为空时不改动。地址结尾的 / 会去掉。服务器见 worker/calibration
const fs = require('fs');
const path = require('path');

const url = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!url) {
  console.log('No calibration server address: the app will not share token calibration data.');
  process.exit(0);
}
if (!/^https:\/\/[^\s'"\\]+$/.test(url)) {
  console.error(`Not an https address: ${url}`);
  process.exit(1);
}
const file = path.join(__dirname, '..', 'js', 'tokens.js');
const src = fs.readFileSync(file, 'utf8');
const line = "const CALIB_BASE_URL = '';";
if (!src.includes(line)) {
  console.error(`js/tokens.js has no line ${line}`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(line, `const CALIB_BASE_URL = '${url}';`));
console.log(`Calibration server: ${url}`);
