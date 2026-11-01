/**
 * __tests__/cloudfunctions/getOperationLogs.filters.test.js
 *
 * 回归：非法筛选值必须报错返回，不能降级成「空结果」。
 *
 * 原实现 buildWhereClause 在枚举校验失败时 `return fail('...')` ——
 * fail() 返回的是**响应对象**，而调用点把返回值直接当 where 塞进 `.where()`：
 *   .where({success:false, data:null, message:'', error:'无效的操作类型筛选条件', code:'ERROR'})
 * 匹配不到任何文档 → 接口返回 success:true + 空列表 + total:0。
 *
 * 这恰恰是该函数注释里明确要避免的「静默误导性输出」的另一种形态：
 * 校验写了却被调用点丢弃，退化成更隐蔽的误导（管理员看到空列表，以为当天无操作）。
 *
 * 另：若传入的字段名恰好与真实文档字段重合，还会退化为按该字段过滤。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getOperationLogs/utils/auth', () => ({
  checkAdmin: jest.fn()
}));

function createFakeDb(opts = {}) {
  const moduleRows = opts.moduleRows || [];
  const makeQuery = () => {
    const q = {
      where: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      skip: jest.fn(() => q),
      limit: jest.fn(() => q),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      get: jest.fn(() => Promise.resolve({ data: [] })),
      // 模块统计：分组 → **显式 limit** → end。返回体必须是 list
      //（聚合 end() 从不返回 data；读 data 会让「各模块操作数」恒为空）。
      // 这里同时塞一个 data 字段：若实现又读回 data，会拿到空数组而失败。
      aggregate: jest.fn(() => ({
        group: jest.fn(() => ({
          limit: jest.fn(() => ({
            end: jest.fn(() => Promise.resolve({ list: moduleRows, data: [] }))
          }))
        }))
      }))
    };
    return q;
  };
  return {
    collection: jest.fn(() => makeQuery()),
    command: { gte: jest.fn(v => v), lte: jest.fn(v => v), aggregate: { sum: jest.fn(v => v) } },
    RegExp: jest.fn(() => 'REGEXP'),
    serverDate: jest.fn(() => 'SERVER_DATE')
  };
}

describe('getOperationLogs 非法筛选值处理', () => {
  let cloud;
  let main;
  let db;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    db = createFakeDb();
    cloud.database.mockReturnValue(db);

    const auth = require('../../cloudfunctions/getOperationLogs/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { account: 'admin', role: 'superadmin' } });

    main = require('../../cloudfunctions/getOperationLogs/index').main;
  });

  test('非法 module 报明确错误，而不是返回空列表', async () => {
    const res = await main({ module: 'not_a_real_module' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('模块');
    // 关键：不得走到查询那一步
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('非法 action 报明确错误（fix_record_openid 已在白名单内，不应被误拒）', async () => {
    const bad = await main({ action: 'xxx' });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('操作类型');

    // 白名单内的实际写入值必须放行
    const good = await main({ action: 'fix_record_openid' });
    expect(good.success).toBe(true);
  });

  test('非法 result 报明确错误', async () => {
    const res = await main({ result: 'maybe' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('结果');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('合法筛选值正常查询', async () => {
    const res = await main({ module: 'cat', action: 'create', result: 'success' });
    expect(res.success).toBe(true);
    expect(db.collection).toHaveBeenCalled();
  });

  test('mediaCheck 模块在白名单内', async () => {
    const media = await main({ module: 'mediaCheck' });
    expect(media.success).toBe(true);
  });

  test('普通管理员未开通 logs 权限时被拒绝（服务端硬校验）', async () => {
    const auth = require('../../cloudfunctions/getOperationLogs/utils/auth');
    auth.checkAdmin.mockResolvedValue({
      isAdmin: false,
      error: '该账号未开通「查看操作日志」权限，请联系超级管理员开启',
      adminInfo: { account: 'admin', role: 'admin' }
    });

    const res = await main({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('未开通');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('普通管理员被授予 logs 权限后可读取', async () => {
    const auth = require('../../cloudfunctions/getOperationLogs/utils/auth');
    auth.checkAdmin.mockResolvedValue({
      isAdmin: true,
      adminInfo: { account: 'admin', role: 'admin', permissions: ['logs'] }
    });

    const res = await main({});
    expect(res.success).toBe(true);
  });
});

describe('getOperationLogs 模块统计（2026-10-12 回归）', () => {
  let cloud;
  let main;

  function mount(moduleRows) {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.database.mockReturnValue(createFakeDb({ moduleRows }));

    const auth = require('../../cloudfunctions/getOperationLogs/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { account: 'admin', role: 'superadmin' } });

    main = require('../../cloudfunctions/getOperationLogs/index').main;
  }

  test('统计从聚合结果的 list 读取（旧实现读 data → 各模块计数恒为空）', async () => {
    mount([{ _id: 'cat', count: 12 }, { _id: 'photo', count: 5 }]);

    const res = await main({});

    expect(res.success).toBe(true);
    // 桩里同时给了 list 与 data（data 为空数组）：读到空 = 又回到了读 data 的老 bug
    expect(res.data.stats).toEqual({ cat: 12, photo: 5 });
  });

  test('空分组结果给空对象（不炸、不返回 undefined）', async () => {
    mount([]);

    const res = await main({});

    expect(res.success).toBe(true);
    expect(res.data.stats).toEqual({});
  });

  test('缺 _id 的分组被忽略（不能出现 undefined 键）', async () => {
    mount([{ _id: null, count: 3 }, { _id: 'cat', count: 1 }]);

    const res = await main({});

    expect(res.data.stats).toEqual({ cat: 1 });
  });
});
