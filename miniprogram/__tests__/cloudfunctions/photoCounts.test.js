/**
 * cloudfunctions/utils/photoCounts.js 的单元测试。
 *
 * 这个模块承担「聚合的隐式 20 条上限」这道闸门，两个能力必须各自锁死：
 *   1. readGroupedCounts：解析分组结果 + 给出计数之和（完整性校验的基准）。
 *      缺 catId 的分组必须被忽略**且不计入和** —— 否则和会凭空变大，
 *      完整性校验会被判成「完整」，截断的键又变成「0 张」直达界面。
 *   2. fillCountsByCount：逐只 count 兜底，结果必须精确；单只失败记 0 但不
 *      拖垮其它猫（否则一只猫查询失败会把整页计数打成错误态）。
 */
jest.mock('wx-server-sdk');

const {
  AGG_LIMIT,
  COUNT_CONCURRENCY,
  readGroupedCounts,
  fillCountsByCount
} = require('../../cloudfunctions/utils/photoCounts');

describe('photoCounts · readGroupedCounts', () => {
  test('agg limit 口径：必须覆盖 20（运行时隐式上限）以上的分组数', () => {
    expect(AGG_LIMIT).toBeGreaterThan(20);
  });

  test('正常分组：返回计数表与计数之和', () => {
    const { counts, sum } = readGroupedCounts([
      { _id: 'c1', count: 32 },
      { _id: 'c2', count: 8 }
    ]);

    expect(counts).toEqual({ c1: 32, c2: 8 });
    expect(sum).toBe(40);
  });

  test('空 / undefined / 非法行都不炸', () => {
    expect(readGroupedCounts([])).toEqual({ counts: {}, sum: 0 });
    expect(readGroupedCounts(undefined)).toEqual({ counts: {}, sum: 0 });
    expect(readGroupedCounts([null, undefined, {}])).toEqual({ counts: {}, sum: 0 });
  });

  test('缺 _id 的分组被忽略，且不计入 sum（否则完整性校验会误判为完整）', () => {
    const { counts, sum } = readGroupedCounts([
      { _id: null, count: 5 },
      { _id: 'c1', count: 3 }
    ]);

    expect(counts).toEqual({ c1: 3 });
    expect(sum).toBe(3);
  });

  test('count 为字符串/非法值时按数字解析，非法按 0', () => {
    const { counts, sum } = readGroupedCounts([
      { _id: 'c1', count: '7' },
      { _id: 'c2', count: null }
    ]);

    expect(counts).toEqual({ c1: 7, c2: 0 });
    expect(sum).toBe(7);
  });

  test('20 条截断的线上形态：和小于真值（调用方据此降级）', () => {
    const truncated = Array.from({ length: 20 }, (_, i) => ({ _id: `c${i}`, count: 2 }));
    const { counts, sum } = readGroupedCounts(truncated);

    expect(Object.keys(counts)).toHaveLength(20);
    expect(sum).toBe(40);
    expect(sum).toBeLessThan(955);   // 与线上真值对比：必须能被判成不完整
  });
});

describe('photoCounts · fillCountsByCount', () => {
  test('逐只 count：精确返回每只猫的张数（含 0 张的猫）', async () => {
    const totals = { c1: 4, c2: 0, c3: 7 };
    const db = {
      collection: jest.fn(() => ({
        where: jest.fn(q => ({ count: jest.fn(() => Promise.resolve({ total: totals[q.catId] })) }))
      }))
    };

    const counts = await fillCountsByCount(db, 'photos', ['c1', 'c2', 'c3']);

    expect(counts).toEqual({ c1: 4, c2: 0, c3: 7 });
    expect(db.collection).toHaveBeenCalledWith('photos');
  });

  test('单只 count 失败：该猫记 0 并留日志，其余猫不受影响', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      collection: jest.fn(() => ({
        where: jest.fn(q => ({
          count: jest.fn(() => {
            if (q.catId === 'bad') return Promise.reject(new Error('db down'));
            return Promise.resolve({ total: 5 });
          })
        }))
      }))
    };

    const counts = await fillCountsByCount(db, 'photos', ['good', 'bad']);

    expect(counts).toEqual({ good: 5, bad: 0 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('并发上限内分批：不串行、也不一次性打爆数据库', async () => {
    let inFlight = 0;
    let peak = 0;
    const db = {
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: jest.fn(() => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            return new Promise(resolve => {
              setImmediate(() => {
                inFlight -= 1;
                resolve({ total: 1 });
              });
            });
          })
        }))
      }))
    };

    const catIds = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const counts = await fillCountsByCount(db, 'photos', catIds);

    expect(Object.keys(counts)).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(COUNT_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  test('extraWhere 原样并入逐只 count（内容拦截照片不能又被算回来）', async () => {
    const seen = [];
    const db = {
      collection: jest.fn(() => ({
        where: jest.fn(q => {
          seen.push(q);
          return { count: jest.fn(() => Promise.resolve({ total: 2 })) };
        })
      }))
    };

    const counts = await fillCountsByCount(db, 'photos', ['c1'], { _mediaBlocked: true });

    expect(counts).toEqual({ c1: 2 });
    expect(seen[0]).toEqual({ catId: 'c1', _mediaBlocked: true });
  });

  test('空列表：不发任何请求', async () => {
    const db = { collection: jest.fn() };

    await expect(fillCountsByCount(db, 'photos', [])).resolves.toEqual({});
    expect(db.collection).not.toHaveBeenCalled();
  });
});
