#!/usr/bin/env node
/**
 * scripts/check-contrast.js —— 对比度台账（只报告）
 *
 * 背景：全站配色曾因对比度不足被点名（小字压品牌色只有 2.1~2.4:1）。
 * 2026-10-12 拍板「配色全部回退、只做对齐」，对比度改成**台账**：
 * 默认只列出可疑项、退出码恒为 0；加 `--strict` 才把低于阈值的项当失败（门禁用）。
 *
 * 口径：
 * - 阈值：小字（< 36rpx / 18px）4.5:1；大字 3.0:1；图标（选择器含 icon/emoji）3.0:1。
 * - 背景判定：规则自带 background 就用它；否则回退到该页的页面底色
 *   （page/.page/.container 的 background 第一段色）。卡片内的浅底文字实际更亮，
 *   所以「报出来」不等于「一定不达标」，由人复核 —— 这是台账不是判决。
 * - token：variables.wxss 解析浅色值；utilities.wxss 的深色媒体查询解析深色值，
 *   两套分别扫描（`--dark` 只扫深色口径）。
 *
 * 用法：
 *   node scripts/check-contrast.js            # 报告（默认浅色）
 *   node scripts/check-contrast.js --all      # 打印全部命中（默认只打前 40 条）
 *   node scripts/check-contrast.js --dark     # 用深色 token 扫一遍
 *   node scripts/check-contrast.js --strict   # 有低于阈值项时退出码 1（门禁）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const OPT = {
  all: args.includes('--all'),
  dark: args.includes('--dark'),
  strict: args.includes('--strict'),
};

/* ---------- 颜色工具 ---------- */
function parseColor(raw) {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*\/\s*([\d.]+)%?|\s*,\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) {
    let a = m[4] !== undefined ? parseFloat(m[4]) : m[5] !== undefined ? parseFloat(m[5]) : 1;
    if (m[4] !== undefined && v.includes('%')) a = a / 100;
    return { rgb: [+m[1], +m[2], +m[3]], a };
  }
  return null;
}

/** 带 alpha 的前景压到背景上的实际观感色 */
function blend(fg, bg) {
  const f = fg.rgb ? fg.rgb : fg;
  const a = fg.rgb ? fg.a : 1;
  if (a >= 1) return f;
  return f.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
}

function luminance([r, g, b]) {
  const f = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 从 background 声明里取「第一个色标」：兼容 linear-gradient(角度/方向, 色 [位置], …) */
function firstColorStop(decl) {
  let s = decl.trim();
  if (/^(linear|radial|conic)-gradient\(/.test(s)) {
    const parts = s.slice(s.indexOf('(') + 1).split(',').map(x => x.trim());
    if (/deg|rad|to |at /.test(parts[0])) parts.shift();
    s = parts[0] || '';
  }
  return s.replace(/\s+[\d.]+%\s*$/, '').trim();   // 去掉色标位置（"#E8927C 0%" → "#E8927C"）
}

/* ---------- token 解析 ---------- */
function readTokens() {
  const light = {};
  const dark = {};
  const varsPath = path.join(ROOT, 'styles/variables.wxss');
  const utilPath = path.join(ROOT, 'styles/utilities.wxss');
  const grab = (text, target) => {
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target[m[1]] = m[2].trim();
  };
  if (fs.existsSync(varsPath)) {
    const vars = fs.readFileSync(varsPath, 'utf8');
    // variables.wxss 里也有一块 @media dark（深色下翻转 --primary-cta-* 等），
    // 不切开会让浅色口径读到深色值（CTA 底色/字色会被算成提亮色，报出的数字失真）。
    const at = vars.indexOf('@media (prefers-color-scheme: dark)');
    grab(vars.slice(0, at < 0 ? vars.length : at), light);
    if (at >= 0) grab(vars.slice(at), dark);
  }
  if (fs.existsSync(utilPath)) {
    const util = fs.readFileSync(utilPath, 'utf8');
    const at = util.indexOf('@media (prefers-color-scheme: dark)');
    grab(util.slice(0, at < 0 ? util.length : at), light);   // utilities 里浅色补充值
    if (at >= 0) grab(util.slice(at), dark);
  }
  return { light, dark };
}

function resolve(value, tokens, depth = 0) {
  if (!value || depth > 4) return null;
  const m = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/.exec(value);
  if (!m) return value.trim();
  const hit = tokens[m[1]];
  if (hit) return resolve(hit, tokens, depth + 1);
  return m[2] ? resolve(m[2], tokens, depth + 1) : null;
}

/* ---------- 扫描 ---------- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'coverage', '.git', 'cloudfunctions'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  }
  return out;
}

const TOKENS = readTokens();
const tokens = OPT.dark ? { ...TOKENS.light, ...TOKENS.dark } : TOKENS.light;

const findings = [];
let checked = 0;

for (const file of walk(ROOT)) {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 页面底色：page / .page / .container 的 background 第一段
  let pageBg = null;
  for (const m of css.matchAll(/(?:^|})\s*(page|\.page|\.container)\s*\{([^}]*)\}/g)) {
    const bg = /background(?:-color)?\s*:\s*([^;]+);/.exec(m[2]);
    const c = bg && parseColor(resolve(firstColorStop(bg[1]), tokens) || '');
    if (c) { pageBg = blend(c, [255, 255, 255]); break; }
  }
  if (!pageBg) {
    const root = parseColor(resolve(tokens['--bg-secondary'] || '#FDF8F5', tokens) || '#FDF8F5');
    pageBg = root || [253, 248, 245];
  }

  // 规则匹配：@media 的前奏天然匹配不上（后面还有 {），内部规则会被单独命中
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selector || selector.startsWith('@') || selector.includes('%')) continue;

    const colorDecl = /(?:^|;)\s*color\s*:\s*([^;]+);/.exec(body);
    if (!colorDecl) continue;
    const bgDecl = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+);/.exec(body);

    let bg = pageBg;
    let bgSource = '(页面底色)';
    let confident = false;
    if (bgDecl) {
      const c = parseColor(resolve(firstColorStop(bgDecl[1]), tokens) || '');
      if (c) {
        const solid = !c.rgb || c.a >= 1;
        bg = blend(c, [255, 255, 255]);
        bgSource = bgDecl[1].trim();
        // 半透明背景（遮罩）背后是照片/内容，脚本无从得知 —— 归入「需核对」
        confident = solid;
      }
    }

    const fgRaw = resolve(colorDecl[1].trim(), tokens);
    const fg = parseColor(fgRaw || '');
    if (!fg) continue;

    const fontSizeDecl = /font-size\s*:\s*([\d.]+)rpx/.exec(body);
    const px = fontSizeDecl ? +fontSizeDecl[1] / 2 : null;
    const isIcon = /icon|emoji|glyph/i.test(selector);
    const threshold = isIcon ? 3.0 : px !== null && px >= 18 ? 3.0 : 4.5;

    const ratio = contrast(blend(fg, bg), bg);
    checked++;
    if (ratio + 1e-6 < threshold) {
      findings.push({
        file: path.relative(ROOT, file),
        selector,
        fg: colorDecl[1].trim(),
        bg: bgSource,
        // 回退页面底色的命中是「需人工核对」：渐变头部/照片上的白字等背景
        // 由别处规则或图片提供，脚本看不见 —— 台账里分开列，不参与 --strict
        confident,
        ratio: Math.round(ratio * 100) / 100,
        threshold,
      });
    }
  }
}

/* ---------- 输出 ---------- */
const sure = findings.filter(f => f.confident);
const review = findings.filter(f => !f.confident);
sure.sort((a, b) => a.ratio - b.ratio);
review.sort((a, b) => a.ratio - b.ratio);

console.log(`对比度台账（${OPT.dark ? '深色' : '浅色'}）`);
console.log(`扫描声明: ${checked} 条；低于阈值: ${findings.length} 条` +
  `（自带背景、可判定 ${sure.length} 条 / 回退页面底色、需核对 ${review.length} 条）`);
console.log('阈值: 小字 4.5:1 · 大字(≥18px) 3.0:1 · 图标 3.0:1。');
console.log('--strict 只看「自带背景」那组；回退页面底色的命中（渐变头部/照片上的白字等）需人工核对。\n');

const print = (list, title) => {
  if (!list.length) return;
  console.log(`【${title}】`);
  const shown = OPT.all ? list : list.slice(0, 20);
  for (const f of shown) {
    console.log(`${f.ratio.toFixed(2)} < ${f.threshold}  ${f.file}  ${f.selector}`);
    console.log(`        color: ${f.fg}  |  bg: ${f.bg}`);
  }
  if (shown.length < list.length) console.log(`… 其余 ${list.length - shown.length} 条用 --all 查看`);
  console.log('');
};

print(sure, '可判定');
print(review, '需人工核对');

if (OPT.strict && sure.length) process.exit(1);
