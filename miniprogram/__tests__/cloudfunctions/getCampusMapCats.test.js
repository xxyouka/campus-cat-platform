/**
 * getCampusMapCats —— 校园地图页的数据通路
 *
 * 该函数是地图上「猫在哪」的唯一来源。它读 cats.lastMeetPoint（由 recordMeet
 * 在打卡时冗余写入），一次查询拿全部猫的锚点，不做 per-cat 查询。
 *
 * 三个关键不变量：
 *   1. 没选过地图点的猫**不应**出现在地图上（MongoDB 对非 null 等值不匹配字段缺失，
 *      where 'lastMeetPoint.campusZone' 天然完成这个过滤）
 *   2. 脏坐标只跳过这一只，不让整张地图崩掉
 *   3. 查询条件必须带 _deleting != true，投影不得带出 _openid
 */
jest.mock('wx-server-sdk');

// node-cache 是云函数侧依赖，根 node_modules 里没有；直通缓存，
// 每次都真正执行 loader（TTL 行为不在本文件的关注范围）
jest.mock('../../cloudfunctions/getCampusMapCats/utils/cache', () => ({
  getOrSet: jest.fn((_key, loader) => loader())
}));

/**
 * 构造 db mock，并记录 where 条件 / 投影字段 / limit
 * @param {Array} cats - where().get() 返回的文档数组
 */
function createFakeDb(cats) {
  const spy = { whereArg: null, fieldArg: null, limitArg: null };
  const chain = {
    where: jest.fn((q) => { spy.whereArg = q; return chain; }),
    field: jest.fn((f) => { spy.fieldArg = f; return chain; }),
    limit: jest.fn((n) => { spy.limitArg = n; return chain; }),
    get: jest.fn(() => Promise.resolve({ data: cats }))
  };
  return {
    spy,
    db: {
      collection: jest.fn(() => chain),
      command: { neq: jest.fn(v => ({ __neq: v })) }
    }
  };
}

/** 构造一个带坐标的猫档案 */
function cat(id, point, extra = {}) {
  return Object.assign({ _id: id, name: '小橘', avatar: 'a.jpg', status: 'normal', campus: '本部', meetCount: 3 }, extra, {
    lastMeetPoint: point
  });
}

describe('getCampusMapCats 云函数', () => {
  let cloud;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
  });

  test('返回带坐标的猫，并规整成地图标记结构', async () => {
    const { db } = createFakeDb([
      cat('a'.repeat(24), { campusZone: '本部', u: 0.42, v: 0.67, at: 1700000000000 })
    ]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    expect(res.data.campusZone).toBe('本部');
    expect(res.data.cats[0]).toEqual({
      id: 'a'.repeat(24),
      name: '小橘',
      avatar: 'a.jpg',
      status: 'normal',
      campus: '本部',
      u: 0.42,
      v: 0.67,
      at: 1700000000000,
      meetCount: 3
    });
  });

  test('查询条件按校区过滤，且排除删除中的猫', async () => {
    const { db, spy } = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    await main({ campusZone: '南院' });

    expect(spy.whereArg._deleting).toEqual({ __neq: true });
    expect(spy.whereArg['lastMeetPoint.campusZone']).toBe('南院');
    // 有上限，不能让地图页一次拉爆
    expect(spy.limitArg).toBe(500);
  });

  test('投影不含 _openid 等私有字段', async () => {
    const { db, spy } = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    await main({ campusZone: '本部' });

    expect(spy.fieldArg).toBeDefined();
    expect(spy.fieldArg._openid).toBeUndefined();
    expect(spy.fieldArg.lastMeetPoint).toBe(true);
  });

  test.each([
    ['完全不传', {}],
    ['空串', { campusZone: '' }],
    ['纯空白', { campusZone: '   ' }],
    ['null', { campusZone: null }],
    ['非字符串数字', { campusZone: 42 }]
  ])('campusZone %s 时默认本部', async (_label, ev) => {
    jest.resetModules();
    const c = require('wx-server-sdk');
    if (c.__restoreDatabase) c.__restoreDatabase();
    const { db, spy } = createFakeDb([]);
    c.database.mockReturnValue(db);

    const res = await require('../../cloudfunctions/getCampusMapCats/index').main(ev);
    expect(res.success).toBe(true);
    expect(res.data.campusZone).toBe('本部');
    expect(spy.whereArg['lastMeetPoint.campusZone']).toBe('本部');
  });

  test('campusZone 超长时截断到 20 字（与 cats.campus 字段上限一致）', async () => {
    const { db, spy } = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: 'A'.repeat(50) });
    expect(res.data.campusZone).toHaveLength(20);
    expect(spy.whereArg['lastMeetPoint.campusZone']).toHaveLength(20);
  });

  test('campusZone 首尾空白被裁掉', async () => {
    const { db, spy } = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '  东区  ' });
    expect(res.data.campusZone).toBe('东区');
    expect(spy.whereArg['lastMeetPoint.campusZone']).toBe('东区');
  });

  /** 脏数据只跳过这一只，不能让整张地图空掉 */
  test('坐标非法的猫被跳过，其余照常返回', async () => {
    const { db } = createFakeDb([
      cat('1'.repeat(24), { campusZone: '本部', u: 0.5, v: 0.5, at: 1 }),
      cat('2'.repeat(24), { campusZone: '本部', u: 5, v: 0.5, at: 1 }),          // 越界
      cat('3'.repeat(24), { campusZone: '本部', u: -1, v: 0.5, at: 1 }),          // 越界
      cat('4'.repeat(24), { campusZone: '本部', u: NaN, v: 0.5, at: 1 }),         // NaN
      cat('5'.repeat(24), { campusZone: '本部', u: Infinity, v: 0.5, at: 1 }),    // Infinity
      cat('6'.repeat(24), { campusZone: '本部', v: 0.5, at: 1 }),                 // 缺 u
      cat('7'.repeat(24), { campusZone: '本部', u: '0.5', v: '0.5', at: 1 }),     // 字符串坐标（写侧已拒）
      cat('8'.repeat(24), { campusZone: '本部', u: 0.3, v: 0.4 }),                // 缺 at，可回退
      cat('9'.repeat(24), null),                                                  // 无锚点
      cat('b'.repeat(24), 'not-an-object')                                       // 类型错
    ]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.success).toBe(true);
    expect(res.data.cats).toHaveLength(2);
    expect(res.data.cats.map(c => c.id)).toEqual(['1'.repeat(24), '8'.repeat(24)]);
  });

  test('锚点缺 at 时回退到 lastMeetTime', async () => {
    const { db } = createFakeDb([
      cat('1'.repeat(24), { campusZone: '本部', u: 0.3, v: 0.4 }, { lastMeetTime: 1699999999999 })
    ]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.data.cats[0].at).toBe(1699999999999);
  });

  test('at 与 meetCount 为非数字时安全降级为 0', async () => {
    const { db } = createFakeDb([
      cat('1'.repeat(24), { campusZone: '本部', u: 0.3, v: 0.4, at: '昨天' }, { meetCount: '三次' })
    ]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.data.cats[0].at).toBe(0);
    expect(res.data.cats[0].meetCount).toBe(0);
  });

  test('没有猫时返回空数组而不是报错', async () => {
    const { db } = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.success).toBe(true);
    expect(res.data.cats).toEqual([]);
    expect(res.data.total).toBe(0);
  });

  test('数据库报错时返回失败，且不泄露原始错误信息', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.1:27017');
    const chain = {
      where: jest.fn(() => chain),
      field: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      get: jest.fn(() => Promise.reject(boom))
    };
    cloud.database.mockReturnValue({
      collection: jest.fn(() => chain),
      command: { neq: jest.fn(v => v) }
    });
    main = require('../../cloudfunctions/getCampusMapCats/index').main;

    const res = await main({ campusZone: '本部' });
    expect(res.success).toBe(false);
    expect(res.data).toBeNull();
    expect(res.error).not.toContain('ECONNREFUSED');
    expect(res.error).not.toContain('10.0.0.1');
  });
});