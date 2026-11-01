/**
 * scripts/build-icons.js - 图标字体构建（子集化，内联 base64）
 *
 * 用法：npm run build:icons
 * 输入：assets/icons/manifest.js + @phosphor-icons/web（devDependency）
 * 输出：
 *   styles/iconfont.wxss             小程序的 @font-face + .cat-icon 类（base64 内联）
 *   components/icon/iconfont-map.js  语义名 → 码位 / 字重（供 icon 组件 require）
 *
 * 步骤：读清单 → 从 Phosphor 官方 css 解析各字重码位 → harfbuzz 子集化（只保留用到的字形）
 *      → fontkit 回读校验 → 写产物。
 * 失败即抛错，不产出半成品。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = require('../assets/icons/manifest.js');

const PHOSPHOR_DIR = path.join(ROOT, 'node_modules', '@phosphor-icons', 'web', 'src');
const WEIGHTS = {
  regular: { css: path.join(PHOSPHOR_DIR, 'regular', 'style.css'), ttf: path.join(PHOSPHOR_DIR, 'regular', 'Phosphor.ttf'), family: 'cat-icon' },
  fill: { css: path.join(PHOSPHOR_DIR, 'fill', 'style.css'), ttf: path.join(PHOSPHOR_DIR, 'fill', 'Phosphor-Fill.ttf'), family: 'cat-icon-fill' },
};

const OUT_WXSS = path.join(ROOT, 'styles', 'iconfont.wxss');
const OUT_MAP = path.join(ROOT, 'components', 'icon', 'iconfont-map.js');

/** 从 Phosphor 的 style.css 解析 图标名 → 码位 */
function parseCss(cssPath) {
  if (!fs.existsSync(cssPath)) throw new Error(`缺少 Phosphor 源码：${cssPath}（先 npm install）`);
  const css = fs.readFileSync(cssPath, 'utf8');
  const map = new Map();
  for (const m of css.matchAll(/\.ph(?:-fill)?\.ph-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-f]{4,5})"/g)) {
    map.set(m[1], parseInt(m[2], 16));
  }
  if (!map.size) throw new Error(`解析不到任何码位：${cssPath}`);
  return map;
}

async function main() {
  const subsetFont = require('subset-font');
  const fontkit = require('fontkit');

  const cssMaps = Object.fromEntries(Object.entries(WEIGHTS).map(([w, cfg]) => [w, parseCss(cfg.css)]));

  // ===== 1. 解析清单，按字重归集 =====
  const byWeight = { regular: [], fill: [] };
  const problems = [];
  for (const [name, cfg] of Object.entries(MANIFEST)) {
    const weight = cfg.fill ? 'fill' : 'regular';
    const phName = cfg.ph;
    const cp = cssMaps[weight].get(phName);
    if (cp === undefined) { problems.push(`${name} → ${phName}（${weight}）在 Phosphor 中不存在`); continue; }
    byWeight[weight].push({ name, cp, phName });
  }
  if (problems.length) throw new Error('清单校验失败：\n  ' + problems.join('\n  '));

  // 两个字重的同一字形码位必须一致（Phosphor 生成器保证；不一致说明版本异常）
  for (const a of byWeight.regular) {
    const b = cssMaps.fill.get(a.phName);
    if (b !== undefined && b !== a.cp) throw new Error(`码位不一致：${a.phName} regular=0x${a.cp.toString(16)} fill=0x${b.toString(16)}`);
  }

  // ===== 2. 子集化 =====
  const fonts = {};
  for (const weight of ['regular', 'fill']) {
    const cfg = WEIGHTS[weight];
    const list = byWeight[weight];
    if (!list.length) { fonts[weight] = null; continue; }
    const chars = list.map(x => String.fromCharCode(x.cp)).join('');
    const src = fs.readFileSync(cfg.ttf);
    const out = await subsetFont(src, chars, { targetFormat: 'sfnt' });
    // 回读校验：每个码位都有真实字形
    const font = fontkit.create(out);
    for (const item of list) {
      const g = font.glyphForCodePoint(item.cp);
      if (!g || g.id === 0) throw new Error(`子集字体缺字形：${item.name}（0x${item.cp.toString(16)}）`);
    }
    fonts[weight] = { buf: out, cfg, count: list.length, srcSize: src.length };
  }

  // ===== 3. 写产物 =====
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('/* =========================================================');
  lines.push(' * styles/iconfont.wxss - 图标字体（AUTO-GENERATED，请勿手改）');
  lines.push(' * 生成：npm run build:icons（scripts/build-icons.js）');
  lines.push(` * 来源：assets/icons/manifest.js + @phosphor-icons/web（MIT，${stamp} 生成）`);
  lines.push(' * 增删图标：改 manifest.js 后重跑构建；深浅色随 currentColor 自动适配');
  lines.push(' * ========================================================= */');
  for (const weight of ['regular', 'fill']) {
    const f = fonts[weight];
    if (!f) continue;
    lines.push('');
    lines.push(`/* ${weight === 'fill' ? '实心' : '线性'}字重：${f.count} 个字形，子集 ${(f.buf.length / 1024).toFixed(1)}KB */`);
    lines.push('@font-face {');
    lines.push(`  font-family: ${f.cfg.family};`);
    lines.push(`  src: url('data:font/truetype;charset=utf-8;base64,${f.buf.toString('base64')}') format('truetype');`);
    lines.push('  font-weight: normal;');
    lines.push('  font-style: normal;');
    lines.push('}');
  }
  lines.push('');
  lines.push('/* 线性图标（默认） */');
  lines.push('.cat-icon {');
  lines.push('  color: currentcolor;');
  lines.push('  font-family: cat-icon, cat-icon-fill, sans-serif !important;');
  lines.push('  font-style: normal;');
  lines.push('  -webkit-font-smoothing: antialiased;');
  lines.push('}');
  lines.push('');
  lines.push('/* 实心图标（heart 等 Fill 字重） */');
  lines.push('.cat-icon-fill {');
  lines.push('  font-family: cat-icon-fill, cat-icon, sans-serif !important;');
  lines.push('}');
  lines.push('');
  fs.writeFileSync(OUT_WXSS, lines.join('\n'), 'utf8');

  const mapLines = [];
  mapLines.push('// components/icon/iconfont-map.js - 图标名 → [码位, 是否实心]（AUTO-GENERATED，改动请改 assets/icons/manifest.js）');
  mapLines.push(`// 生成：npm run build:icons（${stamp}）`);
  mapLines.push('module.exports = {');
  const entries = [
    ...byWeight.regular.map(x => ({ ...x, fill: 0 })),
    ...byWeight.fill.map(x => ({ ...x, fill: 1 }))
  ].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) mapLines.push(`  '${e.name}': [0x${e.cp.toString(16)}, ${e.fill}],`);
  mapLines.push('};');
  mapLines.push('');
  fs.writeFileSync(OUT_MAP, mapLines.join('\n'), 'utf8');

  // ===== 4. 统计输出 =====
  console.log('图标字体构建完成：');
  for (const weight of ['regular', 'fill']) {
    const f = fonts[weight];
    if (!f) continue;
    const b64 = (f.buf.toString('base64').length / 1024).toFixed(1);
    const line = `  ${weight.padEnd(8)} ${String(f.count).padStart(3)} 字形  ` +
      `${(f.srcSize / 1024).toFixed(0)}KB → ${(f.buf.length / 1024).toFixed(1)}KB（base64 后 ${b64}KB）`;
    console.log(line);
  }
  console.log(`  产物：styles/iconfont.wxss（${(fs.statSync(OUT_WXSS).size / 1024).toFixed(1)}KB）`);
  console.log(`        components/icon/iconfont-map.js（${entries.length} 条）`);
}

main().catch(err => { console.error('构建失败：', err.message); process.exit(1); });
