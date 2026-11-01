/**
 * scripts/check-ui-emoji.js - 图标统一防回潮门禁
 *
 * 检查两件事：
 *   1. UI 源码（wxml/wxss/js）与工程文档（md）中不得再出现 emoji 字符；
 *   2. wxml 中的 <icon name="..."> 静态名必须存在于 assets/icons/manifest.js。
 *
 * 白名单（刻意保留的 emoji，均为历史数据兼容映射或兼容性测试用例）：
 *   - utils/statusTag.js                        历史 emoji 前缀 → 图标映射
 *   - cloudfunctions/migrateMeetStatusTag/index.js         数据迁移清洗表
 *   - __tests__/services/meetService.test.js     遗留数据用例
 *   - __tests__/utils/statusTag.test.js          兼容解析用例
 * 跳过的目录：node_modules/.git/coverage/.uploads/images/.agents/.workbuddy/宣传物料（未跟踪、生成物或设计源）
 *
 * 用法：npm run check:icons（已挂入 npm run check）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/u;
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.uploads', 'images', '.agents', '.workbuddy', '宣传物料', 'miniprogram_npm']);
const ALLOW_FILES = new Set([
  'utils/statusTag.js',
  'cloudfunctions/migrateMeetStatusTag/index.js',
  '__tests__/services/meetService.test.js',
  '__tests__/utils/statusTag.test.js'
]);

const manifest = require('../assets/icons/manifest.js');
const iconNames = new Set(Object.keys(manifest));

const problems = [];

/**
 * 剥掉注释后再扫 emoji。
 *
 * 为什么必须剥：这个门禁最大的讽刺场景是「文档里解释为什么不能用某个字符」——
 * 注释里写了那个字符本身，反而把门禁打红（2026-10-11 连续踩了两次：
 * profile.wxml 的注释与 CHANGELOG 的口径说明各一次）。注释不参与渲染，
 * 扫它没有意义；只要可见文本干净即可。
 *
 * 覆盖的注释语法：JS 的 // 与 /* *\/、wxml/wxss/md 的 <!-- -->。
 * 注意：wxml 的注释可能跨行，必须先整块剥掉再按行切分。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释（JS）
    .replace(/<!--[\s\S]*?-->/g, '')           // HTML 注释（wxml / wxss / md）
    .split(/\r?\n/)
    .map(line => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at); // 行注释（JS）
    })
    .join('\n');
}

function checkEmoji(rel, text) {
  // 保留原始行号：先剥注释，再按同样的行序切分（剥除不改变行数）
  const lines = stripComments(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (EMOJI_RE.test(line)) {
      problems.push(`${rel}:${i + 1} 含 emoji：${line.trim().slice(0, 80)}`);
    }
  });
}

function checkIconNames(rel, text) {
  // 静态：name="xxx" / icon="xxx"
  for (const m of text.matchAll(/<icon\b[^>]*?\bname="([a-z][a-z0-9-]*)"/g)) {
    if (!iconNames.has(m[1])) problems.push(`${rel} <icon name="${m[1]}"> 不在 assets/icons/manifest.js`);
  }
  for (const m of text.matchAll(/\bicon="([a-z][a-z0-9-]*)"/g)) {
    if (!iconNames.has(m[1])) problems.push(`${rel} icon="${m[1]}" 不在 assets/icons/manifest.js`);
  }
  // 动态：name="{{...}}" 中的字面量（排除 === / !== 比较值）
  for (const m of text.matchAll(/\bname="\{\{([^}]+)\}\}"/g)) {
    const expr = m[1].replace(/[!=]==\s*'[^']*'/g, '');
    for (const q of expr.matchAll(/'([a-z][a-z0-9-]*)'/g)) {
      if (!iconNames.has(q[1])) problems.push(`${rel} 动态 icon 名 '${q[1]}' 不在 assets/icons/manifest.js`);
    }
  }
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p);
    } else {
      const rel = path.relative(ROOT, p).replaceAll('\\', '/');
      if (ALLOW_FILES.has(rel)) continue;
      const ext = path.extname(e.name);
      if (!/\.(wxml|wxss|js|md)$/.test(ext)) continue;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      checkEmoji(rel, text);
      if (ext === '.wxml') checkIconNames(rel, text);
    }
  }
}

module.exports = { EMOJI_RE, stripComments, checkEmoji, problems, walk, ROOT };

// 仅在直接运行时执行全仓扫描；被 require 时只导出纯函数，供自测用例使用。
if (require.main === module) {
  walk(ROOT);

  if (problems.length) {
    console.error('图标门禁未通过：\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('图标门禁通过：无 emoji、icon 名均在 manifest 内');
}
