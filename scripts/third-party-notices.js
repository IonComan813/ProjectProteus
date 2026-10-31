// 生成第三方声明（THIRD_PARTY_NOTICES.txt），同时检查打包进去的第三方组件的许可证都能和 AGPL v3 一起分发。
//
//   node scripts/third-party-notices.js desktop <输出文件>
//   node scripts/third-party-notices.js android <输出文件> [依赖清单]
//
// 两个版本都有：网页里内置的 marked（js/vendor），以及 package.json 里的运行时依赖（目前没有）。
// 桌面版：Electron 和 Chromium 自己的声明（LICENSE.electron.txt、LICENSES.chromium.html）由打包工具放在程序旁边，这里只指明。
// 安卓版：再加上 Capacitor 模块（许可证读自 node_modules）和 Gradle 打进 APK 的依赖。依赖清单由
//   android 里的 listReleaseDependencies 任务生成，默认 android/app/build/release-dependencies.txt；
//   许可证读自 Gradle 缓存里的 POM（Gradle 解析依赖时已经下载好了）。
// 遇到不认识或不在允许清单里的许可证时报错退出，CI 就会停下来，等人工确认后再登记。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 可以和 AGPL v3 一起分发、且不附加额外义务（除保留声明外）的许可证
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0']);

// POM 里许可证写得不规范（例如只有链接）的 Maven 依赖：按项目仓库里的 LICENSE 文件人工登记。
// MIT 等许可证要求保留版权声明，所以非 Apache-2.0 的 Maven 依赖都要在这里写明版权行。
const MAVEN_OVERRIDES = {
  'io.ionic.libs:ionfilesystem-android': {
    license: 'MIT',
    copyright: 'Copyright (c) 2025 Ionic',
    url: 'https://github.com/ionic-team/ion-android-filesystem',
  },
};

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const problems = [];
const read = (p) => fs.readFileSync(p, 'utf8');

// SPDX 表达式里只要有一个可选的许可证在允许清单里就行（例如 "(MIT OR CC0-1.0)"）
function allowed(spdx) {
  return String(spdx || '').replace(/[()]/g, ' ').split(/\s+OR\s+/i).some((x) => ALLOWED.has(x.trim()));
}

// ---------- 内置在网页里的第三方代码 ----------

function vendored() {
  const head = read(path.join(ROOT, 'js/vendor/marked.min.js')).slice(0, 300);
  const version = (head.match(/marked v([\d.]+)/) || [])[1] || '?';
  return [{
    name: 'marked', version, license: 'MIT', url: 'https://github.com/markedjs/marked',
    text: read(path.join(ROOT, 'js/vendor/marked.LICENSE.md')).trim(),
  }];
}

// ---------- npm 包 ----------

function licenseFile(dir) {
  const f = fs.readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? read(path.join(dir, f)).trim() : null;
}

function npmPackage(dir) {
  const pkg = JSON.parse(read(path.join(dir, 'package.json')));
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || null;
  const text = licenseFile(dir);
  if (!allowed(license)) problems.push(`${pkg.name}@${pkg.version}: license "${license}" is not on the allow list`);
  if (!text) problems.push(`${pkg.name}@${pkg.version}: no LICENSE file in ${dir}`);
  const url = pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  return { name: pkg.name, version: pkg.version, license, url: String(url).replace(/^git\+/, ''), text };
}

// package.json 的运行时依赖（dependencies，不含开发依赖）会被打进桌面版，逐个检查
function npmRuntime() {
  const lock = JSON.parse(read(path.join(ROOT, 'package-lock.json')));
  return Object.entries(lock.packages)
    .filter(([key, p]) => key.startsWith('node_modules/') && !p.dev && !p.devOptional)
    .map(([key]) => npmPackage(path.join(ROOT, key)));
}

// ---------- 安卓：Capacitor 模块 ----------

// android/capacitor.settings.gradle 里写着每个模块在哪个目录
function capacitorProjects() {
  const settings = read(path.join(ROOT, 'android/capacitor.settings.gradle'));
  const dirs = {};
  for (const m of settings.matchAll(/project\('([^']+)'\)\.projectDir = new File\('([^']+)'\)/g)) {
    dirs[m[1]] = path.resolve(ROOT, 'android', m[2]);
  }
  dirs[':capacitor-cordova-android-plugins'] = path.join(ROOT, 'android/capacitor-cordova-android-plugins');
  return dirs;
}

function projectComponent(projectPath, dirs) {
  const dir = dirs[projectPath];
  if (!dir) { problems.push(`Gradle module ${projectPath}: unknown directory`); return null; }
  // Capacitor 生成的 Cordova 插件模块：没有装 Cordova 插件时是空的，不含第三方代码
  if (projectPath === ':capacitor-cordova-android-plugins') {
    const code = walk(path.join(dir, 'src')).filter((f) => !f.endsWith('.gitkeep') && !f.endsWith('AndroidManifest.xml'));
    if (code.length) problems.push(`${projectPath} contains Cordova plugin code; register its licenses: ${code.slice(0, 5).join(', ')}`);
    return null;
  }
  // 往上找模块所属的 npm 包
  for (let d = dir; d.startsWith(path.join(ROOT, 'node_modules')); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return npmPackage(d);
  }
  problems.push(`Gradle module ${projectPath}: no npm package found above ${dir}`);
  return null;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------- 安卓：Maven 依赖 ----------

const GRADLE_FILES = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'caches/modules-2/files-2.1');

function pomOf(group, artifact, version) {
  const base = path.join(GRADLE_FILES, group, artifact, version);
  if (!fs.existsSync(base)) return null;
  for (const hash of fs.readdirSync(base)) {
    const f = path.join(base, hash, `${artifact}-${version}.pom`);
    if (fs.existsSync(f)) return read(f);
  }
  return null;
}

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`)); return m ? m[1].trim() : null; };
const strip = (xml, ...names) => names.reduce((x, n) => x.replace(new RegExp(`<${n}>[\\s\\S]*?</${n}>`, 'g'), ''), xml);

// 读 POM 里的许可证和项目网址；没写的往父 POM 里找
function pomInfo(group, artifact, version, depth = 0) {
  const pom = pomOf(group, artifact, version);
  if (!pom) return null;
  const licensesXml = tag(pom, 'licenses');
  const licenses = licensesXml ? [...licensesXml.matchAll(/<license>([\s\S]*?)<\/license>/g)].map((m) => ({ name: tag(m[1], 'name') || '', url: tag(m[1], 'url') || '' })) : [];
  const url = tag(strip(pom, 'licenses', 'scm', 'developers', 'organization', 'parent', 'distributionManagement', 'dependencies', 'dependencyManagement', 'issueManagement', 'mailingLists', 'build', 'profiles'), 'url');
  if (licenses.length && url) return { licenses, url };
  const parent = tag(pom, 'parent');
  if (parent && depth < 5) {
    const up = pomInfo(tag(parent, 'groupId'), tag(parent, 'artifactId'), tag(parent, 'version'), depth + 1);
    if (up) return { licenses: licenses.length ? licenses : up.licenses, url: url || up.url };
  }
  return { licenses, url };
}

function spdxOf({ name, url }) {
  const s = `${name} ${url}`;
  if (/apache.*2\.0|apache-2\.0|licenses\/LICENSE-2\.0/i.test(s)) return 'Apache-2.0';
  if (/\bMIT\b|opensource\.org\/licenses\/mit/i.test(s)) return 'MIT';
  if (/BSD[ -]?3|new bsd|revised bsd/i.test(s)) return 'BSD-3-Clause';
  if (/BSD[ -]?2|simplified bsd/i.test(s)) return 'BSD-2-Clause';
  return null;
}

function mavenComponent(coord) {
  const [group, artifact, version] = coord.split(':');
  const key = `${group}:${artifact}`;
  const info = pomInfo(group, artifact, version);
  const override = MAVEN_OVERRIDES[key];
  if (override) {
    return { name: key, version, license: override.license, url: override.url, text: `${override.copyright}\n\n${MIT_TEXT}` };
  }
  if (!info) { problems.push(`${coord}: POM not found in the Gradle cache (${GRADLE_FILES})`); return null; }
  const spdx = [...new Set(info.licenses.map(spdxOf))];
  if (!spdx.length || spdx.includes(null)) {
    problems.push(`${coord}: unrecognised license ${JSON.stringify(info.licenses)}; register it in MAVEN_OVERRIDES`);
    return null;
  }
  // Apache-2.0 只需附上一份许可证全文；其他许可证要保留各自的版权声明，必须人工登记
  if (spdx.some((x) => x !== 'Apache-2.0')) {
    problems.push(`${coord}: ${spdx.join(' / ')} needs its copyright line; register it in MAVEN_OVERRIDES`);
    return null;
  }
  return { name: key, version, license: 'Apache-2.0', url: info.url || '' };
}

function android(listFile) {
  if (!fs.existsSync(listFile)) {
    problems.push(`${listFile} not found: run "./gradlew listReleaseDependencies" in android/ first`);
    return [];
  }
  const dirs = capacitorProjects();
  return read(listFile).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (l.startsWith('project:') ? projectComponent(l.slice('project:'.length), dirs) : mavenComponent(l)))
    .filter(Boolean);
}

// ---------- 输出 ----------

function render(target, components) {
  const app = JSON.parse(read(path.join(ROOT, 'package.json')));
  const version = process.env.APP_VERSION || app.version; // 安卓的自动构建从标签取版本号，不改 package.json
  const out = [];
  out.push(`Third-party notices for ${app.productName} ${version} (${target})`);
  out.push('');
  out.push(`${app.productName} is licensed under the GNU Affero General Public License v3 (see LICENSE).`);
  out.push(`Source code: ${app.homepage}`);
  out.push('It includes the following third-party components, each under its own license.');
  out.push('');
  if (target === 'desktop') {
    const electron = JSON.parse(read(path.join(ROOT, 'package-lock.json'))).packages['node_modules/electron'].version;
    out.push(`Electron ${electron} (MIT) and the Chromium components it contains: see LICENSE.electron.txt and`);
    out.push('LICENSES.chromium.html next to the program (inside the .app bundle on macOS).');
    out.push('');
  }
  const w = Math.max(...components.map((c) => c.name.length));
  for (const c of components) out.push(`  ${c.name.padEnd(w)}  ${c.version.padEnd(10)}  ${c.license.padEnd(12)}  ${c.url}`);

  out.push('', '', '======================================== License texts ========================================');
  for (const c of components.filter((x) => x.text)) {
    out.push('', `---------- ${c.name} ${c.version} (${c.license}) ----------`, '', c.text);
  }
  const apache = components.filter((c) => c.license === 'Apache-2.0' && !c.text);
  if (apache.length) {
    out.push('', '---------- Apache License 2.0 ----------');
    out.push(`Applies to: ${apache.map((c) => c.name).join(', ')}`, '');
    out.push(read(path.join(__dirname, 'licenses/Apache-2.0.txt')).trim());
  }
  return out.join('\n') + '\n';
}

function main() {
  const [target, outFile, listFile] = process.argv.slice(2);
  if (!['desktop', 'android'].includes(target) || !outFile) {
    console.error('usage: node scripts/third-party-notices.js desktop|android <output> [dependency list]');
    process.exit(2);
  }
  let components = [...vendored(), ...npmRuntime()];
  if (target === 'android') components = components.concat(android(listFile || path.join(ROOT, 'android/app/build/release-dependencies.txt')));
  // 同一个 npm 包可能对应多个 Gradle 模块（例如 @capacitor/android），只列一次
  const seen = new Set();
  components = components.filter((c) => !seen.has(c.name + '@' + c.version) && seen.add(c.name + '@' + c.version))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of components) if (!allowed(c.license)) problems.push(`${c.name}@${c.version}: license "${c.license}" is not on the allow list`);

  if (problems.length) {
    console.error('Third-party license check failed:\n' + [...new Set(problems)].map((p) => '  - ' + p).join('\n'));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, render(target, components));
  const counts = {};
  for (const c of components) counts[c.license] = (counts[c.license] || 0) + 1;
  console.log(`${outFile}: ${components.length} components (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')})`);
}

main();
