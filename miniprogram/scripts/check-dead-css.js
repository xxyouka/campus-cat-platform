#!/usr/bin/env node
/**
 * scripts/check-dead-css.js —— 死样式台账（只报告）
 *
 * 背景：2026-10-12 视觉对齐时清查过一次死 CSS（profile 清零、全站 324 个确定死类），
 * 为避免再长回来，把当时的审计脚本沉淀成台账：默认只列清单、退出码恒为 0。
 *
 * 口径（判定「确定死类」）：
 * - 以「页面/组件目录」为单位：该目录 wxss 里的类名，必须能在
 *   ① 本目录 wxml/js/json/wxs、② 全部组件目录的同类文件（icon 是 styleIsolation: shared，
 *   页面样式能命中组件内部类）里找到引用；`styles/*.wxss` 是全局样式，按全站引用判定。
 * - **动态拼类名算引用**：`'menu-icon-' + n`、`` `status-${x}` ``、`class="type-{{t}}"`、
 *   `{{x}}-dark` 等前缀/后缀都会豁免（漏掉它们会把活类误判成死类 —— 这坑踩过两次：
 *   `.cat-icon`（组件模板）、`.type-meet`（`type-{{item.typeColor}}`））。
 * - 数据值当类名的（如 `class="cat-status {{cat.status}}"`）无法静态判定，需人工核对；
 *   本次清理时确认 `CAT_VALID_STATUS` 只有四态，`.approved/.pending/.rejected` 才按死类处理。
 *
 * 用法：
 *   node scripts/check-dead-css.js          # 台账（只报告）
 *   node scripts/check-dead-css.js --all    # 完整清单（默认每文件只列 12 个）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OPT = { all: process.argv.includes('--all') };
const CODE_EXT = ['.wxml', '.js', '.json', '.wxs'];
const SKIP_DIRS = ['node_modules', 'coverage', '.git', 'cloudfunctions', 'miniprogram_npm', 'tmp'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 动态拼类名 → 前缀/后缀豁免表 */
function dynamicPatterns(text) {
  const prefixes = new Set();
  const suffixes = new Set();
  for (const m of text.matchAll(/['"`]([\w-]*[a-z][\w-]*)['"`]\s*\+/g)) {
    if (/[-_]/.test(m[1])) prefixes.add(m[1]);
  }
  for (const m of text.matchAll(/([\w-]*[a-z][\w-]*)\s*\$\{/g)) {
    if (/[-_]/.test(m[1])) prefixes.add(m[1]);
  }
  // class="type-{{item.typeColor}}" / "notice-{{type}}"：前缀可以 - / _ 结尾
  for (const m of text.matchAll(/([\w-]+)\s*\{\{/g)) {
    if (/[-_]$/.test(m[1])) prefixes.add(m[1]);
    else if (/[-_]/.test(m[1])) prefixes.add(m[1] + '-');
  }
  for (const m of text.matchAll(/\}\}\s*([-_][\w-]*)/g)) suffixes.add(m[1]);
  for (const m of text.matchAll(/\+\s*['"`]([-_][\w-]*)['"`]/g)) suffixes.add(m[1]);
  return { prefixes: [...prefixes], suffixes: [...suffixes] };
}

const files = walk(ROOT);
const dirText = new Map();
const allCode = [];
for (const f of files) {
  if (!CODE_EXT.includes(path.extname(f))) continue;
  const t = fs.readFileSync(f, 'utf8');
  dirText.set(path.dirname(f), (dirText.get(path.dirname(f)) || '') + '\n' + t);
  allCode.push(t);
}
const allText = allCode.join('\n');
const componentText = files
  .filter(f => f.includes(`${path.sep}components${path.sep}`) && CODE_EXT.includes(path.extname(f)))
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');

let totalClasses = 0;
let totalDead = 0;
const rows = [];

for (const wxss of files.filter(f => f.endsWith('.wxss'))) {
  const dir = path.dirname(wxss);
  const isGlobal = wxss.includes(`${path.sep}styles${path.sep}`);
  const haystack = isGlobal ? allText : (dirText.get(dir) || '') + '\n' + componentText;
  const { prefixes, suffixes } = dynamicPatterns(haystack);

  const css = fs.readFileSync(wxss, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, 'url()');   // data-URI 里的 "www.w3.org" 会污染类名提取
  const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

  const dead = [...classes].filter(c => {
    if (new RegExp(`\\b${c}\\b`).test(haystack)) return false;
    if (prefixes.some(p => c.startsWith(p))) return false;
    if (suffixes.some(s => c.endsWith(s))) return false;
    return true;
  }).sort();

  totalClasses += classes.size;
  totalDead += dead.length;
  if (dead.length) rows.push({ file: path.relative(ROOT, wxss), classes: classes.size, dead });
}

rows.sort((a, b) => b.dead.length - a.dead.length);
console.log('死样式台账（只报告，不修改文件）');
console.log(`wxss ${files.filter(f => f.endsWith('.wxss')).length} 个；类选择器 ${totalClasses} 个；` +
  `疑似死类 ${totalDead} 个${totalClasses ? `（${(totalDead / totalClasses * 100).toFixed(1)}%）` : ''}\n`);
console.log('提示：数据值当类名（class="x {{data}}"）无法静态判定；命中≠一定死，删前请人工核对。\n');
for (const r of rows) {
  console.log(`${r.file}  —  ${r.dead.length}/${r.classes}`);
  console.log('   ' + (OPT.all ? r.dead.join(', ') : r.dead.slice(0, 12).join(', ') +
    (r.dead.length > 12 ? ` …（共 ${r.dead.length} 个，--all 看全）` : '')));
}
