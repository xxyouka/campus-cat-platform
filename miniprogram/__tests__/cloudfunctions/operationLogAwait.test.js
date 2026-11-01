/**
 * __tests__/cloudfunctions/operationLogAwait.test.js
 *
 * 回归守卫：云函数入口里的 logOperation 调用必须 await。
 *
 * 为什么需要「源码扫描」而不是行为测试：
 *   1. 各入口测试一律 `jest.mock('.../common/operationLogger')` 把 logOperation 换成
 *      jest.fn()，有没有 await 对断言毫无影响 —— 实测把 18 处 await 全部撤掉，
 *      2492 条测试照样全绿（唯一变红的是 importDonationsFromExcel 本就带 await 的那处）。
 *   2. ESLint 也兜不住：未 await 的异步调用要靠类型信息才能判（no-floating-promises
 *      属 typescript-eslint 规则），本仓库是纯 JS。
 *
 * 为什么必须 await：logOperation 内部要「查 admins 解析操作人 + 写 operationLogs」，
 * 不 await 时云函数可能在写入落库前就返回，容器随即冻结，审计日志静默丢失 ——
 * 而失败恰恰是最需要审计日志的时候。
 *
 * 判据是「**每一处** logOperation( 都必须被 await/return 交出」，不是「行首不能是
 * logOperation(」。后者只认行首那一种写法，实测漏过 `void logOperation(...)`、
 * `const p = logOperation(...)`、`operationLogger.logOperation(...)` 等一切带前缀的形态
 * —— 只要总数没减少（比如新增一个入口时顺手写错），守卫就是绿的。
 *
 * 同样的缺陷也存在于 audit：deleteData 的三处 audit.log(...) 原本就没 await，
 * 而本守卫最初只认 logOperation，对这条通道完全失明。现已一并覆盖
 * （utils/audit.js 的 log 与 logOperation 同形：async + 全函数体 try/catch）。
 *
 * 放行 `return logOperation(...)`：那等于把 promise 交给调用方 await，语义等价。
 */
const fs = require('fs');
const path = require('path');

const CLOUD_FUNCTIONS_DIR = path.resolve(__dirname, '../../cloudfunctions');

/**
 * 去掉注释后再扫描：注释掉的调用不是真调用，不该被打红。
 * 行注释的 "//" 前排除 ":"，否则会把 'https://...' 这类字面量从中间截断。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/**
 * 受守卫的异步审计写入。两处命名不统一（deleteData 用 audit.log，
 * exportData 把 log 解构成 auditLog），所以按两种拼写分别匹配。
 * audit.log 与 logOperation 同形：async + 全函数体 try/catch，失败只 console.warn。
 */
const GUARDED = [
  {
    label: 'logOperation',
    calls: /logOperation\(/g,
    handedOff: /(?:await|return)\s+logOperation\(/g
  },
  {
    label: 'audit',
    calls: /(?:audit\.log|auditLog)\(/g,
    handedOff: /(?:await|return)\s+(?:audit\.log|auditLog)\(/g
  }
];

function indexFiles() {
  return fs
    .readdirSync(CLOUD_FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(CLOUD_FUNCTIONS_DIR, d.name, 'index.js'))
    .filter((p) => fs.existsSync(p));
}

/** @returns {{calls: number, byLabel: Object<string, number>, violations: string[]}} */
function scanCalls() {
  let calls = 0;
  const byLabel = {};
  const violations = [];

  for (const file of indexFiles()) {
    const rel = path.relative(CLOUD_FUNCTIONS_DIR, file);
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');

    lines.forEach((line, i) => {
      for (const { label, calls: callRe, handedOff: handedRe } of GUARDED) {
        // 逐行用局部正则，避免共享 lastIndex 造成漏判
        const occurrences = line.match(callRe) || [];
        if (occurrences.length === 0) continue;
        const handedOff = line.match(handedRe) || [];

        calls += occurrences.length;
        byLabel[label] = (byLabel[label] || 0) + occurrences.length;
        if (handedOff.length !== occurrences.length) {
          violations.push(`${rel}:${i + 1} [${label}]  ${line.trim()}`);
        }
      }
    });
  }

  return { calls, byLabel, violations };
}

describe('云函数入口：logOperation 必须 await', () => {
  test('扫描集合非空（防止 glob/路径写错导致守卫空转）', () => {
    // 当前实测 52 个入口（原 55：2026-10-06 删除 healthRecords → 54，
    // 同日按产品要求移除未完成的地图功能（pages/map + getMapCats）→ 53；
    // 2026-10-07 死代码清理删除无调用方的 contentCheck → 52）。
    // 下限贴着实测值：松口径会容忍删掉多个入口而守卫不自知 ——
    // 少一个入口就少一片被扫的代码，正是守卫最该察觉的退化。
    expect(indexFiles().length).toBeGreaterThanOrEqual(52);
  });

  test('每一处 logOperation 调用都被 await/return 交出', () => {
    const { violations } = scanCalls();

    expect(violations).toEqual([]);
  });

  test('审计日志调用点仍被真实覆盖（不是被删光了才通过）', () => {
    const { byLabel } = scanCalls();
    // 实测：logOperation 17 处、audit 3 处（原 19 / 5，
    // 差额全部来自删除 healthRecords —— 该云函数带审计调用，删除模块后随之消失）。
    // 按类分别设下限 —— 合并成一个总数的话，删光 audit 会被 logOperation 的数量掩盖。
    // 下调即为「有人删掉了审计日志」，应显式改这个数字而非静默放过
    expect(byLabel.logOperation).toBeGreaterThanOrEqual(17);
    expect(byLabel.audit).toBeGreaterThanOrEqual(3);
  });
});
