/**
 * __tests__/cloudfunctions/getPhotosByCat.test.js
 *
 * 回归（2026-10-18 云函数慢日志复盘）：`count()` 与分页 `get()` 必须**并行**。
 *
 * 旧实现是两次串行 await，但两者没有任何数据依赖（hasMore 只是两个数比大小），
 * 每次翻页白付一整个 RTT —— 线上该接口 1107ms、热态实测 0.53s。
 * 串行改并行之后，「先 count 再 get」这个顺序很容易在后续重构里被无意改回去，
 * 所以用「调用 main 后**同步**检查两个查询都已发出」把并行性钉死：
 * 串行实现里，此刻 get 还没发出去。
 *
 * 顺带锁住 liked 标注（详情页心形图标依赖它，缺了会「重进丢赞、二次点击误翻」）
 * 与 hasMore 的边界（末页正好等于 pageSize 时不能误报还有更多）。
 */
jest.mock('wx-server-sdk');

const CAT = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * 装配 db 桩。
 * @param {object} opts
 * @param {number} opts.total  count() 返回的总数
 * @param {Array}  opts.photos 分页 get() 返回的照片
 * @param {Array}  opts.liked  photoLikes 查询返回（{ photoId } 数组）
 */
function setup(opts = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  // 记录「谁在什么时候被调用」，用来判断并行/串行
  const callLog = [];

  const photoWhere = jest.fn(() => {
    const chain = {
      count: jest.fn(() => {
        callLog.push('count');
        return Promise.resolve({ total: opts.total || 0 });
      }),
      orderBy: jest.fn(function () { return this; }),
      skip: jest.fn(function () { return this; }),
      limit: jest.fn(function () { return this; }),
      get: jest.fn(() => {
        callLog.push('get');
        return Promise.resolve({ data: opts.photos || [] });
      })
    };
    return chain;
  });

  const likeWhere = jest.fn(() => ({
    field: jest.fn(function () { return this; }),
    limit: jest.fn(function () { return this; }),
    get: jest.fn(() => Promise.resolve({ data: opts.liked || [] }))
  }));

  cloud.database.mockReturnValue({
    command: { in: jest.fn(v => v), neq: jest.fn(v => v) },
    collection: jest.fn(name => {
      if (name === 'photos') return { where: photoWhere };
      return { where: likeWhere };   // photoLikes
    })
  });

  const handler = require('../../cloudfunctions/getPhotosByCat/index');
  return { main: handler.main, callLog, photoWhere };
}

describe('getPhotosByCat', () => {
  afterEach(() => {
    require('wx-server-sdk').__restoreDatabase();
  });

  test('count 与分页 get 并行发出（防回归：退回串行会白付一个 RTT）', async () => {
    const { main, callLog } = setup({ total: 3, photos: [] });

    const pending = main({ catId: CAT, page: 1, pageSize: 2 }, {});

    // 关键断言：还没 await，两个查询就应该都已经发出去了。
    // 串行实现里此刻只有 count，get 要等 count 回来才发。
    expect(callLog).toEqual(['count', 'get']);

    await pending;
  });

  test('标注 liked 并按总数计算 hasMore', async () => {
    const { main } = setup({
      total: 3,
      photos: [{ _id: 'p1', likeCount: 5 }, { _id: 'p2', likeCount: 1 }],
      liked: [{ photoId: 'p2' }]
    });

    const res = await main({ catId: CAT, page: 1, pageSize: 2 }, {});

    expect(res.success).toBe(true);
    expect(res.data.total).toBe(3);
    expect(res.data.hasMore).toBe(true);          // 0 + 2 < 3
    expect(res.data.photos[0].liked).toBe(false);
    expect(res.data.photos[1].liked).toBe(true);
  });

  test('末页正好等于 pageSize 时不误报 hasMore', async () => {
    const { main } = setup({
      total: 2,
      photos: [{ _id: 'p1' }, { _id: 'p2' }]
    });

    const res = await main({ catId: CAT, page: 1, pageSize: 2 }, {});

    expect(res.data.hasMore).toBe(false);         // 0 + 2 不小于 2
  });

  // 内容安全：被判定 risky 的照片要同时从计数与列表里消失，
  // 否则会出现「相册显示 N 张、点进去只有 N-1 张」这种对不上的状态。
  test('公开计数与列表都过滤 _mediaBlocked', async () => {
    const { main, photoWhere } = setup({ total: 1, photos: [] });

    await main({ catId: CAT, page: 1, pageSize: 2 }, {});

    expect(photoWhere).toHaveBeenCalledTimes(2);
    expect(photoWhere.mock.calls[0][0]).toEqual({ catId: CAT, _mediaBlocked: true });
    expect(photoWhere.mock.calls[1][0]).toEqual({ catId: CAT, _mediaBlocked: true });
  });

  test('catId 格式非法时直接失败，不查库', async () => {
    const { main, photoWhere } = setup({});

    const res = await main({ catId: 'not-a-valid-id', page: 1, pageSize: 2 }, {});

    expect(res.success).toBe(false);
    expect(photoWhere).not.toHaveBeenCalled();
  });
});
