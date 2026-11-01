/**
 * __tests__/cloudfunctions/listSort.test.js
 *
 * 列表排序值（cloudfunctions/utils/listSort.js，canonical 源）单元测试。
 *
 * 这是「首页领养垫底」排序的单一语义点：任何改写 cats.updateTime / cats.status
 * 的写库路径都必须同步重算 listSort（见模块头部维护纪律），
 * 本文件锁定计算规则本身：
 *   在校+走失（2e13 档） > 离世（1e13 档） > 领养（0 档），组内按时间戳倒序。
 */
const { LIST_SORT_TIERS, computeListSort } = require('../../cloudfunctions/utils/listSort');

// 固定时间戳（2023-11 附近），避免对 Date.now() 的依赖
const T = 1700000000000;
const DAY = 24 * 3600 * 1000;

describe('listSort 计算规则（canonical 源）', () => {
  test('档位偏移表：在校/走失同档，离世次之，领养垫底且为 0', () => {
    expect(LIST_SORT_TIERS.normal).toBe(LIST_SORT_TIERS.lost);
    expect(LIST_SORT_TIERS.normal).toBeGreaterThan(LIST_SORT_TIERS.deceased);
    expect(LIST_SORT_TIERS.deceased).toBeGreaterThan(LIST_SORT_TIERS.adopted);
    expect(LIST_SORT_TIERS.adopted).toBe(0);
    // 防空转：档间隔必须显著大于毫秒时间戳量级（当前 ~1.76e12），
    // 否则「任何时刻的在校 > 任何时刻的离世」不成立、档位会随时间交叠。
    // 1e13 间隔约为当前时间戳的 5.7 倍，这里留 5 倍安全线
    // （时间戳每年增长 ~3.15e10，理论可覆盖到约公元 2286 年）。
    expect(LIST_SORT_TIERS.deceased - LIST_SORT_TIERS.adopted).toBeGreaterThan(5 * T);
    expect(LIST_SORT_TIERS.normal - LIST_SORT_TIERS.deceased).toBeGreaterThan(5 * T);
  });

  test('同状态按时间戳倒序：越新越大', () => {
    expect(computeListSort('normal', T + 1000)).toBeGreaterThan(computeListSort('normal', T));
    expect(computeListSort('lost', T + 1000)).toBeGreaterThan(computeListSort('lost', T));
    expect(computeListSort('deceased', T + 1000)).toBeGreaterThan(computeListSort('deceased', T));
    expect(computeListSort('adopted', T + 1000)).toBeGreaterThan(computeListSort('adopted', T));
  });

  test('跨档恒定：任何时刻的在校/走失 > 任何时刻的离世 > 任何时刻的领养', () => {
    const future = T + 100 * DAY;
    expect(computeListSort('normal', T)).toBeGreaterThan(computeListSort('deceased', future));
    expect(computeListSort('lost', T)).toBeGreaterThan(computeListSort('deceased', future));
    expect(computeListSort('deceased', T)).toBeGreaterThan(computeListSort('adopted', future));
    // 走失与在校同档混排（不沉底），被领养垫底
    expect(computeListSort('lost', T)).toBe(computeListSort('normal', T));
    expect(computeListSort('adopted', future)).toBeLessThan(computeListSort('deceased', T));
  });

  test('状态缺失/枚举外按「在校」档兜底（列表只取四类合法状态，兜底方向安全）', () => {
    expect(computeListSort(undefined, T)).toBe(computeListSort('normal', T));
    expect(computeListSort('unknown-status', T)).toBe(computeListSort('normal', T));
  });

  test('时间缺失/非法时返回 0：整条沉底，而不是落进某档的组首', () => {
    expect(computeListSort('normal', undefined)).toBe(0);
    expect(computeListSort('normal', NaN)).toBe(0);
    expect(computeListSort('normal', 0)).toBe(0);
    expect(computeListSort('adopted', -5)).toBe(0);
    expect(computeListSort('normal', 'not-a-number')).toBe(0);
    // 0 必须低于任何合法组合（含领养 + 极小时间戳）
    expect(computeListSort('adopted', 1)).toBeGreaterThan(0);
  });
});
