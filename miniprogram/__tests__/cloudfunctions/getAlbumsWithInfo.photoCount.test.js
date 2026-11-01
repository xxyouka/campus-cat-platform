/**
 * 回归（2026-10-12）：聚合的「隐式 20 条上限」必须被接住。
 *
 * 背景：照片管理列表 / 相册列表曾对**大量猫显示 0 张**，但点进相册能看到照片。
 *
 * 前两轮（2026-10-10 / 10-11）把根因判成 `.match({ catId: $.in(catIds) })` 失效，
 * 于是去掉 match、改成全表 group。线上复现（your-cloud-env-id）证明真正
 * 的根因是**聚合不写 .limit() 时只返回 20 条结果且不抛异常**：
 * photos 955 条、65 只有照片的猫，`group + end()` 只回 20 组、计数之和 398，
 * 于是 45 只猫显示「0 张照片」。截断落在哪 20 组取决于扫描顺序，
 * 所以「全 0」和「部分为 0」都见得到 —— 上一轮的「本页一只都没命中」
 * 只是其中一个特例，判据太窄，接不住部分截断。
 *
 * 本文件锁三件事：
 *   1. 正常路径（分组计数之和 == 照片总数）直接用分组结果，不触发逐只 count；
 *   2. **完整性判据**：和不等于总数（截断/键形态不对）→ 必须降级逐只 count，
 *      不允许让缺失的键以「0 张」的形态直达界面；
 *   3. **显式 limit**：聚合链上必须调用 .limit()（这里用「不实现 limit 就抛
 *      TypeError」的桩把「忘了写 limit」这个回归钉死）。
 *
 * 装配顺序有讲究：被测模块在**加载时**就执行了 `const db = cloud.database()`，
 * 所以 database 桩必须在 require handler **之前**装好，且必须在同一个
 * 模块注册表里（jest.resetModules() 会让顶层拿到的 sdk 实例失效）。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getAlbumsWithInfo/utils/auth', () => ({
  checkAdmin: jest.fn(() => Promise.resolve({
    isAdmin: true,
    adminInfo: { role: 'admin', permissions: ['photo'] }
  }))
}));

const CATS = 'cats';
const PHOTOS = 'photos';
const CAT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CAT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CAT_C = 'cccccccccccccccccccccccc';

/**
 * 装配 db 桩并加载 handler。
 * @param {object} opts
 * @param {Array}  opts.cats        cats 查询返回
 * @param {number} opts.catsTotal
 * @param {number} opts.photosTotal 无 where 的 photos.count() 返回（照片总数 = 完整性基准）
 * @param {Array}  opts.photoGroups aggregate group 的结果 list
 * @param {boolean} opts.emulateTruncation 让聚合桩「丢弃 limit 之后的组」（模拟运行时 20 条上限）
 * @param {Error}  opts.groupThrows 让 aggregate end() 抛错
 * @param {Object<string,number>} opts.perCatCounts 逐只 count 的返回值 { [catId]: total }
 */
function setup(opts) {
  jest.resetModules();
  const sdk = require('wx-server-sdk');
  const perCatCountCalls = [];
  const aggregateLimitCalls = [];
  const aggregateMatchCalls = [];

  const countFor = (query) => {
    // 定向聚合后的完整性基准：where({ catId: in(catIds) }) —— catId 是**数组**，
    // 与逐只兜底的 where({ catId: '<id>' }) 靠类型区分，不能混进 perCatCountCalls。
    if (query && Array.isArray(query.catId)) {
      return Promise.resolve({ total: opts.photosTotal || 0 });
    }
    if (query && query.catId) {
      perCatCountCalls.push(query.catId);
      return Promise.resolve({ total: (opts.perCatCounts || {})[query.catId] || 0 });
    }
    return Promise.resolve({ total: opts.photosTotal || 0 });
  };

  sdk.database.mockReturnValue({
    // 注意层级：被测模块取的是 `db.command.aggregate.sum`（不是 database.aggregate）
    command: { neq: jest.fn(v => v), in: jest.fn(v => v), aggregate: { sum: jest.fn(v => v) } },
    collection: jest.fn(name => {
      if (name === PHOTOS) {
        return {
          // 照片总数（无 where）
          count: jest.fn(() => countFor(null)),
          // 定向 count：where({ catId: in(catIds) })；逐只兜底：where({ catId }).count()
          where: jest.fn(q => ({ count: jest.fn(() => countFor(q)) })),
          aggregate: jest.fn(() => ({
            // 定向聚合的 match 必须在 group 之前，且必须被调用（否则退回全表扫描）
            match: jest.fn((q) => {
              aggregateMatchCalls.push(q);
              return {
                group: () => ({
                  // 只实现 group → limit → end：不写 limit 会直接 TypeError，
                  // 把「忘了显式 limit」这个回归钉死
                  limit: (n) => {
                    aggregateLimitCalls.push(n);
                    if (opts.groupThrows) {
                      return { end: () => Promise.reject(opts.groupThrows) };
                    }
                    const list = opts.photoGroups || [];
                    // 模拟运行时行为：只返回前 20 条（页面上看到的「凭空消失」）
                    const returned = opts.emulateTruncation ? list.slice(0, 20) : list;
                    return { end: () => Promise.resolve({ list: returned }) };
                  },
                  end: () => { throw new TypeError('limit is not a function'); }
                })
              };
            }),
            group: () => ({
              limit: (n) => {
                aggregateLimitCalls.push(n);
                return { end: () => Promise.resolve({ list: opts.photoGroups || [] }) };
              },
              end: () => { throw new TypeError('limit is not a function'); }
            })
          }))
        };
      }
      if (name === CATS) {
        return {
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: jest.fn(() => Promise.resolve({ data: opts.cats || [] }))
                }))
              }))
            })),
            count: jest.fn(() => Promise.resolve({ total: opts.catsTotal || 0 }))
          }))
        };
      }
      return { where: jest.fn(() => ({ count: jest.fn(() => Promise.resolve({ total: 0 })) })) };
    })
  });

  const handler = require('../../cloudfunctions/getAlbumsWithInfo/index');
  return { handler, perCatCountCalls, aggregateLimitCalls, aggregateMatchCalls };
}

describe('getAlbumsWithInfo · 照片计数', () => {
  afterEach(() => {
    require('wx-server-sdk').__restoreDatabase();
  });

  test('聚合完整（计数之和 == 照片总数）：直接用分组结果，不触发逐只 count', async () => {
    const { handler, perCatCountCalls, aggregateLimitCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }, { _id: CAT_B, name: '土豆' }],
      catsTotal: 2,
      photosTotal: 40,
      photoGroups: [{ _id: CAT_A, count: 32 }, { _id: CAT_B, count: 8 }]
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.albums.find(a => a.catId === CAT_A).photoCount).toBe(32);
    expect(res.data.albums.find(a => a.catId === CAT_B).photoCount).toBe(8);
    expect(res.data.countsDegraded).toBe(false);
    expect(perCatCountCalls).toEqual([]);
    // 聚合链上必须有显式 limit（不写就会被运行时截断到 20 条）
    expect(aggregateLimitCalls).toHaveLength(1);
    expect(aggregateLimitCalls[0]).toBeGreaterThanOrEqual(20);
  });

  // 性能回归（2026-10-18）：全表 group + 全表 count 是相册接口热态 0.64~0.86s 的主因。
  // 定向 match 一旦被改回全表，相册就又会稳定超阈值 —— 用 match 的入参把这个钉死。
  test('聚合必须限定到本页 catIds（防回归：退回全表 group）', async () => {
    const { handler, aggregateMatchCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }, { _id: CAT_B, name: '土豆' }],
      catsTotal: 2,
      photosTotal: 9,
      photoGroups: [{ _id: CAT_A, count: 7 }, { _id: CAT_B, count: 2 }]
    });

    await handler.main({ page: 0, pageSize: 50 }, {});

    expect(aggregateMatchCalls).toHaveLength(1);
    expect(aggregateMatchCalls[0]).toEqual({ catId: [CAT_A, CAT_B], _mediaBlocked: true });
  });

  test('回归：隐式 20 条上限截断分组结果 → 必须降级，不得显示 0 张', async () => {
    // 22 只有照片的猫，聚合只回前 20 组 → 后两只键消失（线上真实形态）
    const cats = Array.from({ length: 22 }, (_, i) => ({
      _id: `cat${String(i).padStart(2, '0')}`,
      name: `猫${i}`
    }));
    const photoGroups = cats.map((c, i) => ({ _id: c._id, count: i + 1 }));
    const photosTotal = photoGroups.reduce((s, g) => s + g.count, 0);
    const perCatCounts = {};
    photoGroups.forEach(g => { perCatCounts[g._id] = g.count; });

    const { handler, perCatCountCalls } = setup({
      cats,
      catsTotal: cats.length,
      photosTotal,
      photoGroups,
      emulateTruncation: true,
      perCatCounts
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    // 被截断掉的两只猫（cat20 / cat21）必须是真实值，而不是 0
    expect(res.data.albums.find(a => a.catId === 'cat20').photoCount).toBe(21);
    expect(res.data.albums.find(a => a.catId === 'cat21').photoCount).toBe(22);
    expect(res.data.countsDegraded).toBe(true);
    expect(perCatCountCalls).toEqual(cats.map(c => c._id));
  });

  test('部分截断也能判出来（旧判据「本页一只都没命中」接不住这种形态）', async () => {
    // 3 只猫：分组结果里有 2 只、少 1 只 —— 命中数不为 0，旧实现会照发「0 张」
    const { handler, perCatCountCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }, { _id: CAT_B, name: '土豆' }, { _id: CAT_C, name: '绿豆' }],
      catsTotal: 3,
      photosTotal: 12,                                   // 真值：4 + 5 + 3
      photoGroups: [{ _id: CAT_A, count: 4 }, { _id: CAT_B, count: 5 }],
      perCatCounts: { [CAT_A]: 4, [CAT_B]: 5, [CAT_C]: 3 }
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.albums.find(a => a.catId === CAT_C).photoCount).toBe(3);
    expect(res.data.countsDegraded).toBe(true);
    expect(perCatCountCalls).toEqual([CAT_A, CAT_B, CAT_C]);
  });

  test('分组键形态不对（计数之和大于总数，例如重复键）也降级', async () => {
    const { handler, perCatCountCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }],
      catsTotal: 1,
      photosTotal: 4,
      photoGroups: [{ _id: CAT_A, count: 6 }],
      perCatCounts: { [CAT_A]: 4 }
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.albums[0].photoCount).toBe(4);
    expect(res.data.countsDegraded).toBe(true);
    expect(perCatCountCalls).toEqual([CAT_A]);
  });

  test('部分命中但完整（未命中的猫真的是 0 张）不降级', async () => {
    const { handler, perCatCountCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }, { _id: CAT_B, name: '土豆' }],
      catsTotal: 2,
      photosTotal: 32,
      photoGroups: [{ _id: CAT_A, count: 32 }],   // 土豆确实没有照片
      perCatCounts: { [CAT_A]: 32, [CAT_B]: 0 }
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.albums.find(a => a.catId === CAT_A).photoCount).toBe(32);
    expect(res.data.albums.find(x => x.catId === CAT_B).photoCount).toBe(0);
    expect(res.data.countsDegraded).toBe(false);
    expect(perCatCountCalls).toEqual([]);
  });

  test('照片集合真的为空时不降级（0 张是真的 0 张）', async () => {
    const { handler, perCatCountCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }],
      catsTotal: 1,
      photosTotal: 0,
      photoGroups: []
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.albums[0].photoCount).toBe(0);
    expect(res.data.countsDegraded).toBe(false);
    expect(perCatCountCalls).toEqual([]);
  });

  test('聚合抛异常时同样降级', async () => {
    const { handler, perCatCountCalls } = setup({
      cats: [{ _id: CAT_A, name: '小糯' }],
      catsTotal: 1,
      photosTotal: 5,
      groupThrows: new Error('aggregate unavailable'),
      perCatCounts: { [CAT_A]: 5 }
    });

    const res = await handler.main({ page: 0, pageSize: 50 }, {});

    expect(res.data.countsDegraded).toBe(true);
    expect(res.data.albums[0].photoCount).toBe(5);
    expect(perCatCountCalls).toEqual([CAT_A]);
  });
});
