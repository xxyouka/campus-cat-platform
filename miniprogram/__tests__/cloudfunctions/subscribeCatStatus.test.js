/**
 * __tests__/cloudfunctions/subscribeCatStatus.test.js
 * 覆盖订阅授权记录的写入与更新。
 */
jest.mock('wx-server-sdk');
process.env.SUBSCRIBE_STATUS_TEMPLATE_ID = 'tmpl-status';

const VALID_CAT_ID = 'a'.repeat(24);

describe('subscribeCatStatus 云函数', () => {
  let cloud;
  let db;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid-1' });
    // 模块级 db 在 require 时创建：固定 database 实例，使断言基于同一对象
    db = cloud.database();
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/subscribeCatStatus/index').main;
  });

  afterAll(() => {
    // 恢复被覆盖的 database 实现，防止泄漏到同进程的其他测试文件
    const c = require('wx-server-sdk');
    if (c.__restoreDatabase) c.__restoreDatabase();
  });

  test('缺少 catId 返回失败', async () => {
    const res = await main({}, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少猫咪信息');
  });

  test('缺少服务端 OPENID 时拒绝且不查询订阅集合', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });

    const res = await main({ catId: VALID_CAT_ID }, {});

    expect(res.success).toBe(false);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('无效 catId 格式返回失败', async () => {
    const res = await main({ catId: 'bad-id' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无效的猫咪ID格式');
  });

  test('无效订阅状态返回失败', async () => {
    const res = await main({ catId: VALID_CAT_ID, status: 'maybe' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无效的订阅状态');
  });

  test('首次订阅写入记录（accept）', async () => {
    const res = await main({ catId: VALID_CAT_ID, status: 'accept' }, {});
    expect(res.success).toBe(true);
    expect(db.collection).toHaveBeenCalledWith('userSubscriptions');
    // 查询 + 写入共两次 collection 调用，写入在第二次返回的链对象上
    const writeChain = db.collection.mock.results[1].value;
    expect(writeChain.add).toHaveBeenCalled();
  });

  test('重复订阅更新已有记录', async () => {
    // 固定 collection 链 + 查询返回已有记录 → 走 update 分支
    const chain = db.collection();
    db.collection.mockReturnValue(chain);
    chain.where.mockReturnValue({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: [{ _id: 'sub-1' }] }))
      }))
    });
    const res = await main({ catId: VALID_CAT_ID, status: 'ignore' }, {});
    expect(res.success).toBe(true);
    expect(chain.doc).toHaveBeenCalledWith('sub-1');
    // doc() 每次返回新对象：取 main 实际调用产生的 doc 实例断言 update
    const docObj = chain.doc.mock.results[0].value;
    expect(docObj.update).toHaveBeenCalled();
    expect(chain.add).not.toHaveBeenCalled();
  });

  test('自定义 templateId 生效', async () => {
    await main({ catId: VALID_CAT_ID, templateId: 'custom_tmpl' }, {});
    const writeChain = db.collection.mock.results[1].value;
    const addCall = writeChain.add.mock.calls[0][0];
    expect(addCall.data.templateId).toBe('custom_tmpl');
  });
});
