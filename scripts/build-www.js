// 把网页文件复制到 www/，供安卓版（Capacitor）打包使用。
// 网页本身就在仓库根目录，这里只挑出需要的文件，避免把 node_modules 等打进去。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');
const ITEMS = ['index.html', 'css', 'js', 'LICENSE'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const item of ITEMS) {
  fs.cpSync(path.join(ROOT, item), path.join(OUT, item), { recursive: true });
}
console.log('www/ ready:', ITEMS.join(', '));
