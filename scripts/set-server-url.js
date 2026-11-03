// 打包前把服务器地址写进网页代码（仓库里都是空的，表示不使用）：
//   node scripts/set-server-url.js update <地址>   更新服务器 → js/update.js 的 UPDATE_BASE_URL（空的时候不检查更新）
//   node scripts/set-server-url.js calib <地址>    共享 token 校准数据的服务器（worker/calibration）→ js/tokens.js 的 CALIB_BASE_URL
//                                                  （空的时候不共享校准数据）
// 地址为空时不改动。地址结尾的 / 会去掉。
const fs = require('fs');
const path = require('path');

const TARGETS = {
  update: { file: 'js/update.js', name: 'UPDATE_BASE_URL', label: 'Update server', none: 'the app will not check for updates' },
  calib: { file: 'js/tokens.js', name: 'CALIB_BASE_URL', label: 'Calibration server', none: 'the app will not share token calibration data' },
};

const target = TARGETS[process.argv[2]];
if (!target) {
  console.error('Usage: node scripts/set-server-url.js <update|calib> <address>');
  process.exit(1);
}
// 去掉结尾的 /（不用正则 /\/+$/：很多个 / 后面不是结尾时，它会反复回溯）
let url = (process.argv[3] || '').trim();
while (url.endsWith('/')) url = url.slice(0, -1);
if (!url) {
  console.log(`No ${target.label.toLowerCase()} address: ${target.none}.`);
  process.exit(0);
}
if (!/^https:\/\/[^\s'"\\]+$/.test(url)) {
  console.error(`Not an https address: ${url}`);
  process.exit(1);
}
const file = path.join(__dirname, '..', target.file);
const src = fs.readFileSync(file, 'utf8');
const line = `const ${target.name} = '';`;
if (!src.includes(line)) {
  console.error(`${target.file} has no line ${line}`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(line, `const ${target.name} = '${url}';`));
console.log(`${target.label}: ${url}`);
