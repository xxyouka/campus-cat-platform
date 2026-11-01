/**
 * 云函数聚合链门禁（2026-10-12 新增）
 *
 * 为什么需要它：云函数端聚合在**不显式写 `.limit()`** 时只返回前 20 条结果，
 * 而且**不抛异常、不报错**。任何按 catId 分组的聚合结果超过 20 组，
 * 第 21 组起的键就凭空消失 —— 相册列表与首页把它当成「这些猫没有照片」，
 * 界面上是「有照片却显示 0 张」，日志里什么都不留。
 *
 * 这个坑在 2026-10-10 / 10-11 / 10-12 被修了三轮（前两轮连根因都判错了），
 * 就是因为**没有任何门禁能拦住「忘了写 limit」**：它不进覆盖率盲区、
 * 不触发 ESLint、单测里只要桩函数不实现 limit 就永远绿。
 * 所以这里直接静态清点源码：每个 `.aggregate()` 链要么有 `.limit()`，
 * 要么是「单行分组」（`_id: null`，结果恒为 1 条，结构上不可能被截断）。
 *
 * 判据与用法见 `cloudfunctions/utils/photoCounts.js` 的模块头。
 */
const fs = require('fs');
const path = require('path');

const CLOUD_ROOT = path.resolve(__dirname, '../../cloudfunctions');
const SKIP_DIRS = new Set(['node_modules', 'coverage']);

/** 递归收集 .js 文件（跳过 node_modules / coverage） */
function collectJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 抽取所有 `.aggregate()` → `.end()` 之间的链文本。
 * 返回 [{ chain, line }]，line 为 `.aggregate()` 所在行号（1 起）。
 */
function extractAggregateChains(src) {
  const chains = [];
  let from = 0;

  for (;;) {
    const aggIdx = src.indexOf('.aggregate(', from);
    if (aggIdx === -1) break;

    const endIdx = src.indexOf('.end(', aggIdx);
    if (endIdx === -1) {
      chains.push({ chain: src.slice(aggIdx), line: lineOf(src, aggIdx) });
      break;
    }

    chains.push({ chain: src.slice(aggIdx, endIdx), line: lineOf(src, aggIdx) });
    from = endIdx + 1;
  }

  return chains;
}

function lineOf(src, index) {
  return src.slice(0, index).split(/\r?\n/).length;
}

const files = collectJs(CLOUD_ROOT);
const violations = [];
const checked = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('.aggregate(')) continue;

  const rel = path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
  for (const { chain, line } of extractAggregateChains(src)) {
    const hasLimit = chain.includes('.limit(');
    const singleRow = chain.includes('_id: null');
    checked.push(`${rel}:${line}`);

    if (!hasLimit && !singleRow) {
      violations.push(`${rel}:${line}`);
    }
  }
}

describe('云函数聚合门禁：聚合链必须显式 .limit() 或为单行分组', () => {
  test('清点到的聚合链数量与仓库现状一致（防止扫描静默失效）', () => {
    // 扫描规则变化/目录改名时这里会先红：
    // 少了说明门禁没扫到（比扫到违规更危险），多了说明有新聚合要一起接受检查
    expect(checked.length).toBeGreaterThanOrEqual(10);
  });

  test('没有「忘了写 .limit()」的聚合链（隐式 20 条上限会静默丢数据）', () => {
    expect(violations).toEqual([]);
  });

  test('photoCounts 这道防线本身仍在（防被"优化"掉）', () => {
    const photoCounts = fs.readFileSync(path.join(CLOUD_ROOT, 'utils/photoCounts.js'), 'utf8');
    expect(photoCounts).toContain('AGG_LIMIT');
    expect(photoCounts).toContain('function readGroupedCounts');
    expect(photoCounts).toContain('function fillCountsByCount');

    // 三个调用方都必须走共享实现，不得各自内联一份（口径漂移是上一轮的教训）
    for (const fn of ['getAlbumsWithInfo', 'getCatPhotoCounts', 'exportData']) {
      const src = fs.readFileSync(path.join(CLOUD_ROOT, fn, 'index.js'), 'utf8');
      expect(src).toContain("require('./utils/photoCounts')");
    }
  });
});
