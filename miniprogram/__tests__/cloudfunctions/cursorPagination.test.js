/**
 * 回归：游标分页的 where 条件必须与原条件**合并**。
 *
 * wx-server-sdk 的 Query.where() 是整体替换 _fieldFilters，而不是合并：
 * 第二页若写成 query.where({ _id: _.gt(lastId) })，第一页的
 * _openid / status / meetTime 条件会被静默丢弃。
 *   - getMeetCalendar：第二页起会把全站用户的打卡并进当前用户的日历与累计天数；
 *   - getFilterOptions：第二页起不再过滤 status，非法状态猫咪的颜色会混进筛选项。
 *
 * 本测试锁定契约：第二页的 where 里必须同时出现原过滤条件与 _id 游标。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getFilterOptions/utils/cache', () => ({
  getOrSet: jest.fn((key, loader) => loader())
}));
jest.mock('../../cloudfunctions/getFilterOptions/utils/logger', () => ({
  CloudLogger: { warn: jest.fn(), log: jest.fn(), error: jest.fn(), performance: jest.fn() }
}));

function makeQueryFactory({ pages, whereCalls }) {
  return () => {
    const q = {
      where: jest.fn(cond => { whereCalls.push(cond); return q; }),
      field: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      skip: jest.fn(() => q),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      get: jest.fn(() => Promise.resolve({ data: pages.length ? pages.shift() : [] }))
    };
    return q;
  };
}

function page(n, extra) {
  return Array.from({ length: n }, (_, i) => ({
    _id: String(i).padStart(24, '0'),
    ...extra
  }));
}

describe('getMeetCalendar 游标分页条件合并', () => {
  test('第二页的 where 必须仍带 _openid / meetTime', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    const whereCalls = [];
    const pages = [
      page(1000, { meetTime: 1750000000000 }),
      []
    ];
    cloud.database.mockReturnValue({
      collection: jest.fn(makeQueryFactory({ pages, whereCalls })),
      command: {
        gt: v => ({ $gt: v }),
        gte: () => ({ and: () => ({ $range: true }) }),
        lt: () => ({}),
        lte: () => ({})
      }
    });

    const { main } = require('../../cloudfunctions/getMeetCalendar/index');
    const res = await main({ year: 2026, month: 8 });

    expect(res.success).toBe(true);
    // 第 0 次是月历第一页，第 1 次是月历第二页
    expect(whereCalls.length).toBeGreaterThanOrEqual(2);
    expect(whereCalls[0]._openid).toBe('test-openid');
    expect(whereCalls[1]._openid).toBe('test-openid');
    expect(whereCalls[1].meetTime).toBeDefined();
    expect(whereCalls[1]._id).toBeDefined();
  });
});

describe('getFilterOptions 游标分页条件合并', () => {
  test('第二页的 where 必须仍带 status 过滤', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    const whereCalls = [];
    const pages = [
      page(100, { color: '橘' }),
      []
    ];
    cloud.database.mockReturnValue({
      collection: jest.fn(makeQueryFactory({ pages, whereCalls })),
      command: {
        in: v => v,
        gt: v => ({ $gt: v })
      }
    });

    const { main } = require('../../cloudfunctions/getFilterOptions/index');
    const res = await main({});

    expect(res.success).toBe(true);
    expect(whereCalls.length).toBeGreaterThanOrEqual(2);
    expect(whereCalls[1].status).toBeDefined();
    expect(whereCalls[1]._id).toBeDefined();
  });

  test('照片计数在花色扫描完成前启动', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    const events = [];
    let resolveCatPage;
    cloud.database.mockReturnValue({
      collection: jest.fn(name => {
        if (name === 'photos') {
          return { count: jest.fn(() => {
            events.push('photo-count');
            return Promise.resolve({ total: 12 });
          }) };
        }
        const query = {
          where: jest.fn(() => query),
          field: jest.fn(() => query),
          orderBy: jest.fn(() => query),
          limit: jest.fn(() => query),
          skip: jest.fn(() => query),
          get: jest.fn(() => {
            events.push('cat-page');
            return new Promise(resolve => { resolveCatPage = resolve; });
          })
        };
        return query;
      }),
      command: { in: v => v, gt: v => ({ $gt: v }) }
    });

    const { main } = require('../../cloudfunctions/getFilterOptions/index');
    const pendingResult = main({});
    await Promise.resolve();

    expect(events).toEqual(['photo-count', 'cat-page']);

    resolveCatPage({ data: [{ _id: 'cat-1', color: '橘' }] });
    const result = await pendingResult;
    expect(result.success).toBe(true);
    expect(result.data.totalPhotos).toBe(12);
  });
});
