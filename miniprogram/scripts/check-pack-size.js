#!/usr/bin/env node
/**
 * scripts/check-pack-size.js —— 包体门禁（主包体积 + 主包冗余 JS）
 *
 * 背景：2026-10-24 与 2026-10-26 两次「代码质量」红灯都栽在同一件事上 ——
 * 只被分包引用的工具文件留在主包 `utils/`，上传后后台判定
 * 「主包内不应存在主包未使用的 JS 文件」；同时主包体积悄悄逼近 1.5 MB 红线。
 * 这两件事在本地完全看不出来，只有上传后才会在后台亮红。
 *
 * 本脚本把它们提前到 CI，口径与 CHANGELOG 里记账的口径一致：
 *   - 体积：**原始文件字节**（不做压缩估算），按 project.config.json 的
 *     packOptions.ignore 排除，按 app.json 的 subpackages.root 切分包；
 *   - 冗余：主包 `utils/` `services/` `behaviors/` 下的每个 .js，
 *     必须被**主包内**的文件 require 过。只被分包引用 = 应该下沉到分包。
 *
 * 判定阈值（微信硬线）：
 *   - 主包 < 1.5 MB（1572864 B），≥ 1.4 MB 先给预警（余量不足）
 *   - 单个分包 < 2 MB
 *   - 全部分包之和 < 20 MB
 *
 * 用法：node scripts/check-pack-size.js
 *       node scripts/check-pack-size.js --json   （只输出 JSON，供其他脚本消费）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MB = 1024 * 1024;

const MAIN_LIMIT = 1.5 * MB;
const MAIN_WARN = 1.4 * MB;
const SUB_LIMIT = 2 * MB;
const TOTAL_LIMIT = 20 * MB;

// 这些目录里的文件是「被 require 的库」，不是页面/组件入口，必须被主包引用
const LIB_DIRS = ['utils', 'services', 'behaviors'];

const projectConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

const ignores = projectConfig.packOptions && projectConfig.packOptions.ignore || [];
const ignoredFolders = ignores.filter(i => i.type === 'folder').map(i => i.value.replace(/^\/+|\/+$/g, ''));
const ignoredFiles = new Set(ignores.filter(i => i.type === 'file').map(i => i.value));

const subRoots = (appJson.subpackages || []).map(sp => sp.root.replace(/^\/+|\/+$/g, ''));
const subNames = {};
(appJson.subpackages || []).forEach(sp => {
  subNames[sp.root.replace(/^\/+|\/+$/g, '')] = sp.name || sp.root;
});

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isIgnored(rel) {
  if (ignoredFiles.has(rel)) return true;
  return ignoredFolders.some(folder => rel === folder || rel.startsWith(`${folder}/`));
}

function subRootOf(rel) {
  return subRoots.find(root => rel === root || rel.startsWith(`${root}/`)) || null;
}

/** 递归收集「会被打进包里」的文件（已排除 packOptions.ignore） */
function collectFiles(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.relative(ROOT, full));
    if (isIgnored(rel)) continue;
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile()) {
      acc.push({ rel, size: fs.statSync(full).size });
    }
  }
  return acc;
}

const files = collectFiles();

// ---- 体积统计 ----
const mainFiles = [];
const subSize = {};
subRoots.forEach(root => {
  subSize[root] = 0;
});

for (const file of files) {
  const root = subRootOf(file.rel);
  if (root) subSize[root] += file.size;
  else mainFiles.push(file);
}

const mainSize = mainFiles.reduce((sum, f) => sum + f.size, 0);
const subTotal = Object.values(subSize).reduce((sum, n) => sum + n, 0);

// ---- 主包冗余 JS：主包 lib 目录下的文件必须被主包文件引用 ----
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveRequire(fromRel, spec) {
  const baseDir = path.dirname(path.join(ROOT, fromRel));
  const target = path.resolve(baseDir, spec);
  const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return toPosix(path.relative(ROOT, candidate));
    }
  }
  return null;
}

const mainReferenced = new Set();
for (const file of mainFiles) {
  if (!file.rel.endsWith('.js')) continue;
  const source = fs.readFileSync(path.join(ROOT, file.rel), 'utf8');
  REQUIRE_RE.lastIndex = 0;
  let match = REQUIRE_RE.exec(source);
  while (match) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      // 只关心仓内相对引用
      const resolved = resolveRequire(file.rel, spec);
      if (resolved) mainReferenced.add(resolved);
    }
    match = REQUIRE_RE.exec(source);
  }
}

const orphanLibs = mainFiles
  .filter(f => f.rel.endsWith('.js'))
  .filter(f => LIB_DIRS.some(dir => f.rel.startsWith(`${dir}/`)))
  .filter(f => !mainReferenced.has(f.rel))
  .map(f => f.rel)
  .sort();

// ---- 输出 ----
const errors = [];
const warnings = [];

if (mainSize >= MAIN_LIMIT) {
  errors.push(`主包 ${formatSize(mainSize)} 超过 1.5 MB 上限`);
} else if (mainSize >= MAIN_WARN) {
  warnings.push(`主包 ${formatSize(mainSize)} 已到 1.4 MB 预警线，余量 ${formatSize(MAIN_LIMIT - mainSize)}`);
}

for (const [root, size] of Object.entries(subSize)) {
  if (size >= SUB_LIMIT) errors.push(`分包 ${root} ${formatSize(size)} 超过 2 MB 上限`);
}
if (subTotal >= TOTAL_LIMIT) errors.push(`分包合计 ${formatSize(subTotal)} 超过 20 MB 上限`);

if (orphanLibs.length) {
  errors.push(
    `主包存在主包未使用的 JS（应下沉到使用它的分包）：${orphanLibs.join('、')}`
  );
}

function formatSize(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}

if (process.argv.includes('--json')) {
  process.stdout.write(
    JSON.stringify({ mainSize, subSize, subTotal, orphanLibs, errors, warnings }, null, 2)
  );
  process.exit(errors.length ? 1 : 0);
}

console.log(
  `[包体门禁] 主包 ${formatSize(mainSize)} / 1.50 MB（余量 ${formatSize(MAIN_LIMIT - mainSize)}）` +
    `，分包合计 ${formatSize(subTotal)}`
);
for (const [root, size] of Object.entries(subSize).sort((a, b) => b[1] - a[1])) {
  console.log(`  ├ ${root}（${subNames[root]}）${formatSize(size)}`);
}

for (const message of warnings) console.warn(`  ! ${message}`);
for (const message of errors) console.error(`  ✗ ${message}`);

if (errors.length) {
  console.error(`\n[包体门禁] 未通过（${errors.length} 项）`);
  process.exit(1);
}
console.log('[包体门禁] 通过');
