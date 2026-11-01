#!/usr/bin/env node
/**
 * scripts/check-design-tokens.js —— 设计口径台账（只报告）
 *
 * 背景：2026-10-14 维护者连续点名三类问题（砖红按钮 / 徽标变椭圆 / 白字口径不齐），
 * 当时靠人肉 grep 排查，容易漏。把口径沉淀成台账，默认只列清单、退出码恒为 0；
 * 加 `--strict` 才把「确定项」当失败。
 *
 * 四类判定：
 * 1. 椭圆风险：非正方形元素上写 border-radius: 50% / var(--radius-full)。
 *    50% 是按「宽高各自的 50%」圆角，非正方形会渲染成椭圆 —— 应改 --radius-pill。
 *    （正方形 = 正圆，是正确的，不报。）
 * 2. 硬编码色：color / background(-color) / border-color 直接写 hex 或 rgb()，
 *    且该值不在 token 表（variables / utilities / icons）里 —— 绕开 token 的色值。
 * 3. 深浅模式风险：@media dark 块里引用不随主题翻转的「浅色专用」token
 *    （--urgent-deep / --info-dark / --status-adoptable-deep），
 *    深色下会变成深底深字，应指回对应的提亮 token。
 * 4. 品牌面字色：浅色模式下 background 用品牌珊瑚（--primary-color / --primary-cta-bg /
 *    --primary-cta-gradient），字色却不是白字口径（--primary-cta-text / --bg-primary / #FFF）。
 * 5. 品牌面图标：品牌面上的 <icon> 没挂 color: inherit —— 图标按名字自带颜色
 *    （.icon-name-* 的 --icon-* 系列）会盖掉继承色，出现「粉图标 + 白字」。
 *
 * 用法：
 *   node scripts/check-design-tokens.js          # 台账（只报告）
 *   node scripts/check-design-tokens.js --all    # 完整清单
 *   node scripts/check-design-tokens.js --strict # 有「确定项」时退出码 1
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OPT = { all: process.argv.includes('--all'), strict: process.argv.includes('--strict') };
const SKIP_DIRS = ['node_modules', 'coverage', '.git', 'cloudfunctions', 'miniprogram_npm', 'tmp'];
const LIGHT_ONLY_TOKENS = ['--urgent-deep', '--info-dark', '--status-adoptable-deep'];

/** 品牌面容器（承载「品牌珊瑚底 + 白字」的元素）。
 *  这些容器里的 <icon> 必须能被 icons.wxss 的 `color: inherit` 规则覆盖，
 *  否则图标按名字自带颜色（.icon-name-*），会出现「粉色图标 + 白色文字」（2026-10-14 维护者截图反馈）。 */
const BRAND_CONTAINERS = [
  'stat-action', 'push-mode', 'cat-follow-btn', 'rank-tab', 'meet-status', 'day-detail-tag',
  'quick-pill', 'action-btn', 'btn-opt', 'notify-type', 'status-chip', 'cat-status-badge',
  'cat-duration', 'campus-act-btn', 'node-center-badge', 'card-tag', 'support-confirm',
  'empty-btn', 'empty-action', 'empty-action-btn', 'load-error-btn', 'retry-btn', 'section-number'
];

/**
 * 已人工核过、判定没问题的（写清理由，避免每次都被翻出来当噪音）：
 * - 尺寸由别处/父级决定的：实际都是正方形 → 50% 就是正圆，写法正确
 *   （::after 装饰、img 撑满正方形容器、.avatar/.skeleton-avatar 由 .sm/.md/.lg 定尺寸、
 *    .avatar-ring 是 inset 叠在正方形头像上、.header-deco 由 -1/-2/-3 定尺寸）；
 * - lazy-image 的 .cat-face：刻意的「猫脸」形状（50% 50% 45% 45%），不是胶囊、也不该是圆。
 */
const IGNORE = new Set([
  'components/lazy-image/lazy-image.wxss .cat-face',  'pages/admin/add-cat/add-cat.wxss .avatar-preview image',
  'pages/admin/edit-cat/edit-cat.wxss .avatar-preview image',
  'pages/detail/detail.wxss .skeleton-avatar::after',
  'pages/share/share.wxss .header-deco',
  'pages/share/share.wxss .avatar-ring',
  'styles/animations.wxss .avatar',
  'styles/components.wxss .skeleton-avatar'
]);
const BRAND_SURFACES = [
  /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--primary-color\)/,
  /var\(--primary-cta-(?:bg|gradient)\)/
];
const CTA_TEXT_OK = /var\(--primary-cta-text\)|var\(--bg-primary\)|#fff\b|#ffffff\b|white\b/i;
const COLOR_LIST_KEYS = [
  '--primary-color', '--primary-dark',
  '--primary-light', '--primary-cta-bg', '--primary-cta-text'
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  }
  return out;
}

function walkWxml(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkWxml(p, out);
    else if (e.name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

function readTokens() {
  const tokens = new Map();
  for (const rel of ['styles/variables.wxss', 'styles/utilities.wxss', 'styles/icons.wxss']) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}

const TOKENS = readTokens();
const TOKEN_VALUES = new Set();
for (const [k, v] of TOKENS) {
  if (COLOR_LIST_KEYS.includes(k)) continue;
  for (const c of v.matchAll(/#[0-9a-f]{3,8}|rgb\([^)]*\)|rgba\([^)]*\)/gi)) TOKEN_VALUES.add(c[0].toLowerCase().replace(/\s+/g, ' '));
}
const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** 去掉 var(--x, 兜底值) 里的兜底值：兜底色不算硬编码（专题讨论过，见 --error-color 的沿革） */
function stripVars(value) {
  let out = '', i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let depth = 0, j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

const problems = { ellipse: [], hardcoded: [], darkToken: [], brandText: [], brandIcon: [] };
let rules = 0;

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');

  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selector || selector.startsWith('@') || selector.includes('%') || !body.trim()) continue;
    rules++;
    const inDark = darkStart >= 0 && m.index > darkStart;
    const at = { file: rel, selector };

    // 1. 椭圆风险
    if (!IGNORE.has(`${rel} ${selector}`) && /border-radius:\s*(?:50%|var\(--radius-full\))/.test(body)) {
      const num = k => { const r = new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([\\d.]+)rpx`).exec(body); return r ? +r[1] : null; };
      const w = num('width'), h = num('height'), mw = num('min-width'), mh = num('min-height');
      const pad = /(?:^|;)\s*padding:\s*([^;]+);/.exec(body);
      const square = w !== null && h !== null && w === h && !pad;
      const flexible = mw !== null && mh !== null && mw === mh || w !== null && h !== null && w === h;
      if (!square && !flexible) {
        problems.ellipse.push({ ...at, geom: `w:${w ?? '-'} h:${h ?? '-'} minW:${mw ?? '-'} minH:${mh ?? '-'} pad:${pad ? pad[1].trim() : '-'}` });
      }
    }

    // 2. 硬编码色
    for (const decl of ['color', 'background', 'background-color', 'border-color']) {
      const re = new RegExp(`(?:^|;)\\s*${decl}\\s*:\\s*([^;]+);`, 'g');
      for (const d of body.matchAll(re)) {
        for (const c of stripVars(d[1]).matchAll(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi)) {
          const val = norm(c[0]);
          if (!TOKEN_VALUES.has(val)) problems.hardcoded.push({ ...at, decl, value: val, dark: inDark });
        }
      }
    }

    // 3. 深浅模式风险
    if (inDark && selector) {
      for (const t of LIGHT_ONLY_TOKENS) {
        if (new RegExp(`var\\(${t}\\)`).test(body)) problems.darkToken.push({ ...at, token: t });
      }
    }

    // 4. 品牌面字色
    if (!inDark && BRAND_SURFACES.some(re => re.test(body))) {
      const colorDecl = /(?:^|;)\s*color\s*:\s*([^;]+);/.exec(body);
      if (colorDecl && !CTA_TEXT_OK.test(colorDecl[1])) {
        problems.brandText.push({ ...at, color: colorDecl[1].trim() });
      }
    }
  }
}

// ---------- 5. 品牌面上的图标是否跟着面走 ----------
// icons.wxss 里写了 color: inherit 的容器（即已经处理过图标的）
const iconCss = fs.readFileSync(path.join(ROOT, 'styles/icons.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const inheritContainers = new Set();
for (const m of iconCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/color:\s*inherit/.test(m[2])) continue;
  for (const sel of m[1].split(',')) {
    const hit = /\.([\w-]+)/.exec(sel);
    if (hit) inheritContainers.add(hit[1]);
  }
}
for (const file of walkWxml(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const cls of BRAND_CONTAINERS) {
      if (inheritContainers.has(cls)) continue;
      // 类名要整词命中：'empty-action' 不该命中 'empty-action-btn'（两者修复方式不同）
      const re = new RegExp(`(?:^|[\\s"'])${cls}(?=[\\s"'])`);
      if (!re.test(line)) continue;
      const window = lines.slice(i, i + 3).join(' ');
      if (window.includes('<icon')) problems.brandIcon.push({ file: rel, container: cls });
    }
  });
}

const show = (list, title, fmt, limit = 12) => {  console.log(`【${title}】${list.length} 条`);
  const shown = OPT.all ? list : list.slice(0, limit);
  for (const x of shown) console.log(`  ${fmt(x)}`);
  if (shown.length < list.length) console.log(`  … 其余 ${list.length - shown.length} 条用 --all 查看`);
  console.log('');
};

console.log('设计口径台账（只报告）');
console.log(`扫描规则 ${rules} 条\n`);
show(problems.ellipse, '椭圆风险：非正方形 + 50%（应改 --radius-pill）',
  x => `${x.file}  ${x.selector}   [${x.geom}]`);
show(problems.hardcoded, '硬编码色：绕开 token 直接写色值',
  x => `${x.file}  ${x.selector}  ${x.decl}: ${x.value}${x.dark ? '（深色块）' : ''}`, 16);
show(problems.darkToken, '深浅模式风险：深色块里引用浅色专用 token（会深底深字）',
  x => `${x.file}  ${x.selector}  ${x.token}`);
show(problems.brandText, '品牌面字色不齐：品牌珊瑚底上不是白字口径',
  x => `${x.file}  ${x.selector}  color: ${x.color}`);
show(problems.brandIcon, '品牌面图标未跟随字色：图标会按名字自带颜色（粉图标 + 白字）',
  x => `${x.file}  .${x.container}  里的 <icon> 需要在 icons.wxss 补 color: inherit`);

if (OPT.strict && problems.ellipse.length) process.exit(1);
