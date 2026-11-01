/**
 * __tests__/cloudfunctions/getAlbumsWithInfo.test.js
 *
 * 回归（2026-10-06）：相册列表必须过滤 `_deleting` 标记的猫 —— 与 filterCats /
 * 客户端可见性口径一致。不滤会出现「首页/管理端已看不到、公开相册列表却永久留存」
 * 的幽灵相册，而 cat-manage 看不到它 → 无法再次发起删除。
 *
 * 注：照片计数桩需同时实现 aggregate 的 group → **limit** → end 与
 * photos.count()（照片总数）—— 计数走 utils/photoCounts.js 的
 * 「显式 limit + 计数之和 == 总数」口径，见 getAlbumsWithInfo.photoCount.test.js。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getAlbumsWithInfo/utils/auth', () => ({
  checkAdmin: jest.fn(() => Promise.resolve({
    isAdmin: true,
    adminInfo: { role: 'admin', permissions: ['photo'] }
  }))
}));
jest.mock('../../cloudfunctions/getAlbumsWithInfo/utils/logger', () => ({
  CloudLogger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  CloudErrorHandler: { handle: jest.fn() }
}));

describe('getAlbumsWithInfo', () => {
  let cloud;
  let main;
  let catsWhere;

  const NEQ = { $neq: true };

  function makeDb() {
    const cats = [
      { _id: 'c1', name: '小橘', avatar: 'cloud://env.bucket/cats/avatar/1.jpg', status: 'normal' }
    ];
    catsWhere = jest.fn(() => ({
      orderBy: jest.fn(function() { return this; }),
      skip: jest.fn(function() { return this; }),
      limit: jest.fn(function() { return this; }),
      get: jest.fn(() => Promise.resolve({ data: cats })),
      count: jest.fn(() => Promise.resolve({ total: 1 }))
    }));

    return {
      collection: jest.fn((name) => {
        if (name === 'cats') {
          return {
            where: catsWhere,
            count: jest.fn(() => Promise.resolve({ total: 1 }))
          };
        }
        // photos：聚合（group → limit → end）+ 逐只 count 兜底
        return {
          count: jest.fn(() => Promise.resolve({ total: 2 })),
          aggregate: jest.fn(() => ({
            match: jest.fn(function() { return this; }),
            group: jest.fn(function() { return this; }),
            limit: jest.fn(function() { return this; }),
            end: jest.fn(() => Promise.resolve({ list: [{ _id: 'c1', count: 2 }] }))
          })),
          where: jest.fn(() => ({
            count: jest.fn(() => Promise.resolve({ total: 2 }))
          }))
        };
      }),
      command: {
        neq: jest.fn(() => NEQ),
        in: jest.fn(v => v),
        aggregate: { in: jest.fn(v => v), sum: jest.fn(v => v) }
      }
    };
  }

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.database.mockReturnValue(makeDb());
    main = require('../../cloudfunctions/getAlbumsWithInfo/index').main;
  });

  test('cats 查询与 count 都过滤 _deleting（幽灵相册不再出现）', async () => {
    const res = await main({ page: 0, pageSize: 50 });

    expect(res.success).toBe(true);
    expect(catsWhere).toHaveBeenCalledWith({ _deleting: NEQ });
    expect(res.data.albums).toHaveLength(1);
    expect(res.data.albums[0].photoCount).toBe(2);
  });
});
