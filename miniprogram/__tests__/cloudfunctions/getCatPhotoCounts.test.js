/**
 * 回归（2026-10-12）：首页/详情页的照片数同样不能被「聚合隐式 20 条上限」截断。
 *
 * getCatPhotoCounts 是 mediaHelper 的 photoCountsMap 数据源（首页卡片、
 * 搜索/筛选结果、详情页都按 catId 查这张表，缺键即显示 0 张）。
 * 线上复现：photos 955 条 / 65 只有照片的猫，`group + end()` 只回 20 组、
 * 计数之和 398 → 45 只猫全站显示「0 张照片」。
 *
 * 锁三件事：
 *   1. 聚合链必须有显式 .limit()（桩不实现 limit 就直接抛，钉死「忘了写」）；
 *   2. 计数之和 == 照片总数时直接用分组结果（不额外 count）；
 *   3. 不再用「是否存在猫咪 id 白名单」判断口径，完整性以和为判据。
 */
jest.mock('wx-server-sdk');

jest.mock('../../cloudfunctions/getCatPhotoCounts/utils/cache', () => ({
  // 直通缓存：每次都真正执行 loader（TTL 行为不在本文件的关注范围）
  getOrSet: jest.fn((_key, loader) => loader())
}));

const CAT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CAT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * @param {object} opts
 * @param {Array}  opts.photoGroups   photos 分组结果
 * @param {number} opts.photosTotal   photos 集合总数（完整性基准）
 * @param {number} opts.totalViews
 * @param {boolean} opts.emulateTruncation 模拟运行时「只回前 20 组」
 * @param {Array}  opts.catIds        降级路径读取的猫咪 id
 * @param {Object<string,number>} opts.perCatCounts 逐只 count 返回值
 */
function setup(opts) {
  jest.resetModules();
  const sdk = require('wx-server-sdk');
  const perCatCountCalls = [];
  const aggregateLimitCalls = [];

  sdk.database.mockReturnValue({
    command: { neq: jest.fn(v => v), aggregate: { sum: jest.fn(v => v) } },
    collection: jest.fn(name => {
      if (name === 'photos') {
        const groupChain = () => ({
          limit: (n) => {
            aggregateLimitCalls.push(n);
            const list = opts.photoGroups || [];
            const returned = opts.emulateTruncation ? list.slice(0, 20) : list;
            if (opts.aggThrows) return { end: () => Promise.reject(opts.aggThrows) };
            return { end: () => Promise.resolve({ list: returned }) };
          }
        });
        return {
          count: jest.fn(() => Promise.resolve({ total: opts.photosTotal || 0 })),
          where: jest.fn(q => ({
            count: jest.fn(() => {
              if (q && q.catId) {
                perCatCountCalls.push(q.catId);
                return Promise.resolve({ total: (opts.perCatCounts || {})[q.catId] || 0 });
              }
              return Promise.resolve({ total: opts.photosTotal || 0 });
            })
          })),
          aggregate: jest.fn(() => ({
            match: jest.fn(() => ({ group: groupChain })),
            group: groupChain
          }))
        };
      }
      if (name === 'cats') {
        return {
          field: jest.fn(() => ({
            skip: jest.fn(() => ({
              limit: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve({ data: (opts.catIds || []).map(_id => ({ _id })) }))
              }))
            }))
          })),
          aggregate: jest.fn(() => ({
            group: () => ({
              end: jest.fn(() => Promise.resolve({ list: [{ totalViews: opts.totalViews || 0 }] }))
            })
          }))
        };
      }
      return {};
    })
  });

  const { main } = require('../../cloudfunctions/getCatPhotoCounts/index');
  return { main, perCatCountCalls, aggregateLimitCalls };
}

describe('getCatPhotoCounts · 照片计数', () => {
  afterEach(() => {
    require('wx-server-sdk').__restoreDatabase();
  });

  test('聚合完整：直接用分组结果，带显式 limit，不触发逐只 count', async () => {
    const { main, perCatCountCalls, aggregateLimitCalls } = setup({
      photoGroups: [{ _id: CAT_A, count: 30 }, { _id: CAT_B, count: 10 }],
      photosTotal: 40
    });

    const res = await main({}, {});

    expect(res.success).toBe(true);
    expect(res.data.counts).toEqual({ [CAT_A]: 30, [CAT_B]: 10 });
    expect(res.data.totalPhotos).toBe(40);
    expect(res.data.countsDegraded).toBe(false);
    expect(perCatCountCalls).toEqual([]);
    expect(aggregateLimitCalls).toHaveLength(1);
    expect(aggregateLimitCalls[0]).toBeGreaterThan(20);
  });

  test('回归：分组被截断到 20 组（和 ≠ 总数）→ 降级逐只 count，不许留 0 张', async () => {
    const catIds = Array.from({ length: 22 }, (_, i) => `cat${String(i).padStart(2, '0')}`);
    const photoGroups = catIds.map((id, i) => ({ _id: id, count: i + 1 }));
    const photosTotal = photoGroups.reduce((s, g) => s + g.count, 0);
    const perCatCounts = {};
    photoGroups.forEach(g => { perCatCounts[g._id] = g.count; });

    const { main, perCatCountCalls } = setup({
      photoGroups,
      photosTotal,
      emulateTruncation: true,
      catIds,
      perCatCounts
    });

    const res = await main({}, {});

    expect(res.data.countsDegraded).toBe(true);
    // 被截断掉的两只猫必须拿到真实张数（21 / 22），而不是 0
    expect(res.data.counts.cat20).toBe(21);
    expect(res.data.counts.cat21).toBe(22);
    expect(perCatCountCalls).toEqual(catIds);
  });

  test('真的一只猫都没照片：sum 0 == total 0，不降级', async () => {
    const { main, perCatCountCalls } = setup({
      photoGroups: [],
      photosTotal: 0
    });

    const res = await main({}, {});

    expect(res.data.counts).toEqual({});
    expect(res.data.countsDegraded).toBe(false);
    expect(perCatCountCalls).toEqual([]);
  });

  test('聚合抛异常：整体失败态（fail 响应），不透出错误数据', async () => {
    const { main, perCatCountCalls } = setup({
      photoGroups: [],
      photosTotal: 40,
      aggThrows: new Error('boom')
    });

    const res = await main({}, {});

    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    // 失败态下不得偷偷返回「全 0 张」的假数据
    expect(res.data).toBeNull();
    expect(perCatCountCalls).toEqual([]);
  });
});
