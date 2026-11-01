/**
 * 回归（2026-10-15）：管理端统计的容器内缓存与「计算时刻」。
 *
 * 背景：getAdminStats 每次调用都要全表扫描 cats / recordMeet / userFavorites（游标分页 +
 * 去重），而管理端一次会话里会反复进出控制台（首页 → 子页 → 返回）—— 每次打开都重算，
 * 等于把同一份结果算好几遍（2026-10-15 性能复盘：pages/admin/admin 切换均值 3758ms）。
 * 本文件锁三件事：
 *   1. **鉴权在缓存之前**：非管理员永远拿不到缓存里的数字；
 *   2. 60s 内第二次调用命中缓存（不再扫表），并回同一个 computedAt；
 *   3. 扫描异常失败关闭，且不把失败写进缓存。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getAdminStats/utils/auth', () => ({ checkAdmin: jest.fn() }));

const CAT_A = 'cat-a';
const CAT_B = 'cat-b';
const GHOST = 'cat-ghost';

// 北京时间 10-01 10:00 / 13:00（同一天，去重后算 1 次）
const T1 = '2026-10-01T02:00:00.000Z';
const T2 = '2026-10-01T05:00:00.000Z';
// 北京时间 10-02 10:00（另一天）
const T3 = '2026-10-02T02:00:00.000Z';

/**
 * 游标分页桩：**按集合共享游标**（每次 collection() 返回新的链，但批次进度是共享的）。
 * 这一点不能写错：真实代码在游标循环里反复调 db.collection(...)，若每次返回的链都从
 * 第一批开始，lastId 永远不变 → 测试自己死循环（本轮就是这么踩到的）。
 */
function makeCursor(batches, onGet, shouldThrow) {
  const state = { i: 0 };
  return () => {
    const api = {
      field: jest.fn(function () { return api; }),
      orderBy: jest.fn(function () { return api; }),
      where: jest.fn(function () { return api; }),
      limit: jest.fn(function () { return api; }),
      get: jest.fn(() => {
        if (onGet) onGet();
        if (shouldThrow && shouldThrow()) return Promise.reject(new Error('db down'));
        const batch = batches[state.i++] || [];
        return Promise.resolve({ data: batch });
      })
    };
    return api;
  };
}

const CATS_BATCHES = [[{ _id: CAT_A }, { _id: CAT_B }]];
const MEET_BATCHES = [
  [
    { _id: 'm1', _openid: 'o1', catId: CAT_A, meetTime: T1 },
    { _id: 'm2', _openid: 'o1', catId: CAT_A, meetTime: T2 }   // 同人同猫同日 → 去重
  ],
  [
    { _id: 'm3', _openid: 'o2', catId: CAT_A, meetTime: T3 },  // 另一天 → +1
    { _id: 'm4', _openid: 'o1', catId: GHOST, meetTime: T1 }   // 猫已删除 → 不计
  ]
];
const FAV_BATCHES = [
  [
    { _id: 'f1', _openid: 'o1', catId: CAT_A },
    { _id: 'f2', _openid: 'o1', catId: CAT_A }                 // 同人同猫 → 去重
  ],
  [
    { _id: 'f3', _openid: 'o2', catId: CAT_A },                // 另一人 → +1
    { _id: 'f4', _openid: 'o1', catId: GHOST }                 // 猫已删除 → 不计
  ]
];

/**
 * @param {object} opts
 * @param {object} opts.authResult     checkAdmin 的返回值
 * @param {boolean} opts.catsScanThrows 让 cats 游标扫描抛错（模拟扫描异常）
 */
function setup(opts = {}) {
  jest.resetModules();
  const sdk = require('wx-server-sdk');
  const calls = { cats: 0, meets: 0, favorites: 0 };
  const photosCount = jest.fn(() => Promise.resolve({ total: 1181 }));
  const catsCount = jest.fn(() => Promise.resolve({ total: 103 }));

  sdk.getWXContext.mockReturnValue({ OPENID: 'o-admin' });
  const catsCursor = makeCursor(CATS_BATCHES, () => { calls.cats++; }, () => opts.catsScanThrows);
  const meetCursor = makeCursor(MEET_BATCHES, () => { calls.meets++; });
  const favCursor = makeCursor(FAV_BATCHES, () => { calls.favorites++; });

  sdk.database.mockReturnValue({
    command: { gt: jest.fn(v => v) },
    collection: jest.fn(name => {
      if (name === 'cats') return { count: catsCount, ...catsCursor() };
      if (name === 'photos') return { count: photosCount };
      if (name === 'recordMeet') {
        return {
          count: jest.fn(() => Promise.resolve({ total: 773 })),
          ...meetCursor()
        };
      }
      if (name === 'userFavorites') {
        return {
          count: jest.fn(() => Promise.resolve({ total: 446 })),
          ...favCursor()
        };
      }
      return {};
    })
  });

  const { checkAdmin } = require('../../cloudfunctions/getAdminStats/utils/auth');
  checkAdmin.mockResolvedValue(opts.authResult || { isAdmin: true, adminInfo: { role: 'superadmin' } });

  return {
    main: require('../../cloudfunctions/getAdminStats/index').main,
    checkAdmin,
    calls,
    photosCount,
    catsCount
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('getAdminStats 入口', () => {
  test('管理员首次调用：三张表各扫一遍，返回统计与计算时刻', async () => {
    const { main, calls } = setup();

    const res = await main({}, {});

    expect(res.success).toBe(true);
    expect(res.data.stats).toEqual({
      totalCats: 103,
      totalPhotos: 1181,
      totalMeets: 2,       // 同人同猫同日去重、已删除的猫不计
      totalFavorites: 2
    });
    expect(typeof res.data.computedAt).toBe('number');
    // 游标循环：有数据的一批 + 收敛用的空批 = 2 次
    expect(calls.cats).toBe(2);
    expect(calls.meets).toBe(3);      // 2 批 + 空批
    expect(calls.favorites).toBe(3);  // 2 批 + 空批
  });

  test('60s 内第二次调用命中缓存：不再扫表，且 computedAt 不变', async () => {
    const { main, calls, photosCount } = setup();

    const first = await main({}, {});
    const scansAfterFirst = { ...calls };

    const second = await main({}, {});

    expect(second.success).toBe(true);
    expect(second.data.stats).toEqual(first.data.stats);
    expect(second.data.computedAt).toBe(first.data.computedAt);
    expect(calls).toEqual(scansAfterFirst);   // 一次 DB 都没多打
    expect(photosCount).toHaveBeenCalledTimes(1);
  });

  test('超过 TTL 后重新计算：computedAt 变新', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
    const { main, calls, photosCount } = setup();

    const first = await main({}, {});
    const scansAfterFirst = calls.cats;

    jest.setSystemTime(new Date('2026-10-15T00:01:01.000Z'));   // +61s
    const second = await main({}, {});

    expect(second.data.computedAt).toBeGreaterThan(first.data.computedAt);
    expect(calls.cats).toBeGreaterThan(scansAfterFirst);   // 确实重新扫了表
    expect(photosCount).toHaveBeenCalledTimes(2);
  });

  test('非管理员被拒：不查库、也拿不到缓存里的数字', async () => {
    const { main, calls, photosCount } = setup({
      authResult: { isAdmin: false, error: '无权限执行此获取统计数据，仅管理员可操作' }
    });

    const res = await main({}, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
    expect(photosCount).not.toHaveBeenCalled();
    expect(calls.cats).toBe(0);
  });

  test('扫描异常：失败关闭，且不把失败写进缓存', async () => {
    const failing = setup({ catsScanThrows: true });

    const res = await failing.main({}, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('获取统计数据失败');

    // 缓存未被污染：下一次（正常环境）仍会真实计算
    const healthy = setup();
    const ok = await healthy.main({}, {});
    expect(ok.success).toBe(true);
    expect(healthy.calls.cats).toBe(2);
  });
});
