/**
 * scripts/recolor-png-icon.js - 单色 PNG 图标重染（保留 alpha 抗锯齿边缘）
 *
 * 用途：底部栏/小图标等单色 PNG 换色（如把选中态图标统一成品牌色）。
 * 用法：node scripts/recolor-png-icon.js <png路径...> <#RRGGBB>
 * 例：  node scripts/recolor-png-icon.js images/gallery-active-dark.png "#E8927C"
 *
 * 说明：对每个非透明像素写入目标 RGB、保留原 alpha —— 抗锯齿边缘不会出现锯齿。
 * 该脚本曾用于修复：深色模式 tabBar「相册/我的」选中图标为蓝色（#1296DB）、
 * 与「首页」的品牌色（#E8927C）不一致的问题（2026-10-08）。
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const args = process.argv.slice(2);
const color = args.pop();
const files = args;

if (!files.length || !/^#?[0-9a-fA-F]{6}$/.test(color || '')) {
  console.error('用法：node scripts/recolor-png-icon.js <png路径...> <#RRGGBB>');
  process.exit(1);
}
const hex = color.startsWith('#') ? color : '#' + color;
const target = [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

for (const f of files) {
  const p = path.resolve(process.cwd(), f);
  const png = PNG.sync.read(fs.readFileSync(p));
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] > 0) {
      png.data[i] = target[0];
      png.data[i + 1] = target[1];
      png.data[i + 2] = target[2];
    }
  }
  fs.writeFileSync(p, PNG.sync.write(png));
  console.log('已重染:', f, '→', hex);
}
