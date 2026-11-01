/**
 * __tests__/cloudfunctions/manageSubscribeQuota.test.js
 * 覆盖订阅消息推送次数账本：授权 +1（上限 200）、查询、参数校验。
 */
jest.mock('wx-server-sdk');

const STATUS_TMPL = 'tmpl-status';
const MEET_TMPL = 'tmpl-meet';
const NEW_CAT_TMPL = 'tmpl-new-cat';
process.env.SUBSCRIBE_STATUS_TEMPLATE_ID = STATUS_TMPL;
process.env.SUBSCRIBE_MEET_TEMPLATE_ID = MEET_TMPL;
process.env.SUBSCRIBE_NEW_CAT_TEMPLATE_ID = NEW_CAT_TMPL;

/**
 * 最小可用的 subscribeQuota「表」桩（有状态）。
 *
 * 为什么不用静态返回值的链式桩：add 现在**写完再回读**整个账本（三个模板的全量快照），
 * 断言必须基于「写入之后读到的值」，而固定的 `where().limit().get()` fixture 无法表达这一点
 *（写前写后返回同一份旧数据）。这里用内存表模拟。
 */
function createQuotaTable(seed = []) {
  const rows = seed.map(row => ({ ...row }));
  // 只支持等值过滤（本文件用到的 where 形态）：bumpOne 的 {_openid, templateId}
  // 与 readCounts 的 {_openid}。忽略过滤条件会让 bumpOne 抓到别的模板的行。
  const find = filter => rows
    .filter(row => Object.keys(filter || {}).every(key => row[key] === filter[key]))
    .map(row => ({ ...row }));
  const collection = {
    where: jest.fn(filter => ({
      limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: find(filter) })) })),
      get: jest.fn(() => Promise.resolve({ data: find(filter) }))
    })),
    add: jest.fn(({ data }) => {
      const row = { _id: `quota-${rows.length + 1}`, ...data };
      rows.push(row);
      return Promise.resolve({ _id: row._id });
    }),
    doc: jest.fn(id => ({
      update: jest.fn(({ data }) => {
        const row = rows.find(r => r._id === id);
        if (row) Object.assign(row, data);
        return Promise.resolve({ stats: { updated: row ? 1 : 0 } });
      })
    }))
  };
  return { collection, rows };
}

describe('manageSubscribeQuota 云函数', () => {
  let cloud;
  let db;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    // 恢复默认 database 实现：用例里 pin 过的 db / collection 会跨用例残留
    //（jest.mock 工厂结果在进程级缓存，resetModules 不清理）
    cloud.__restoreDatabase();
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid-1' });
    // 模块级 db 在 require 时创建：固定 database 实例，使断言基于同一对象
    db = cloud.database();
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/manageSubscribeQuota/index').main;
  });

  afterAll(() => {
    // 恢复被覆盖的 database 实现，防止泄漏到同进程的其他测试文件
    const c = require('wx-server-sdk');
    if (c.__restoreDatabase) c.__restoreDatabase();
  });

  test('未知操作类型返回失败', async () => {
    const res = await main({ action: 'remove' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('未知操作类型');
  });

  test('add 无有效模板ID返回失败', async () => {
    const res = await main({ action: 'add', templateIds: ['not-allowed'] }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少有效的模板ID');
  });

  test('add 兼容单个 templateId 字符串写法', async () => {
    const { collection, rows } = createQuotaTable();
    db.collection.mockReturnValue(collection);

    const res = await main({ action: 'add', templateId: STATUS_TMPL }, {});
    expect(res.success).toBe(true);
    expect(rows[0].remaining).toBe(1);
    expect(res.data.counts[STATUS_TMPL]).toBe(1);
  });

  test('首次授权创建记录 remaining=1', async () => {
    const { collection, rows } = createQuotaTable();
    db.collection.mockReturnValue(collection);

    const res = await main({ action: 'add', templateIds: [STATUS_TMPL] }, {});
    expect(res.success).toBe(true);
    expect(db.collection).toHaveBeenCalledWith('subscribeQuota');
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(1);
    expect(rows[0].templateId).toBe(STATUS_TMPL);
    expect(res.data.counts[STATUS_TMPL]).toBe(1);
    expect(res.data.limit).toBe(200);
  });

  test('重复授权在已有记录上 +1', async () => {
    const { collection, rows } = createQuotaTable([
      { _id: 'quota-1', _openid: 'user-openid-1', templateId: STATUS_TMPL, remaining: 5 }
    ]);
    db.collection.mockReturnValue(collection);

    const res = await main({ action: 'add', templateIds: [STATUS_TMPL] }, {});
    expect(res.success).toBe(true);
    expect(collection.doc).toHaveBeenCalledWith('quota-1');
    // doc() 每次返回新对象：取 main 实际调用产生的 doc 实例断言 update
    const docObj = collection.doc.mock.results[0].value;
    expect(docObj.update).toHaveBeenCalled();
    expect(docObj.update.mock.calls[0][0].data.remaining).toBe(6);
    expect(rows[0].remaining).toBe(6);
    expect(res.data.counts[STATUS_TMPL]).toBe(6);
  });

  test('达到上限 200 后不再增加', async () => {
    const { collection } = createQuotaTable([
      { _id: 'quota-1', _openid: 'user-openid-1', templateId: STATUS_TMPL, remaining: 200 }
    ]);
    db.collection.mockReturnValue(collection);

    const res = await main({ action: 'add', templateIds: [STATUS_TMPL] }, {});
    expect(res.success).toBe(true);
    expect(res.data.counts[STATUS_TMPL]).toBe(200);
    expect(res.data.limit).toBe(200);
    // 已封顶：不产生无意义的 update 写库
    expect(collection.doc).not.toHaveBeenCalled();
  });

  // 回归：add 只授权一个模板时，响应里另外两个分类**也要带真实值**。
  // 之前 add 只回本次涉及的模板，前端把缺 key 的分类渲染成 0 —— 线上表现就是
  // 「敲一次木鱼，相遇打卡/新猫登场的数字被清零」，其实账本没变，
  // 要等下一次 get 全量回来才恢复（见 pages/profile/profile.js 的 _applyQuotaData）。
  test('add 回全量快照：未参与本次授权的模板也带真实剩余次数', async () => {
    const { collection } = createQuotaTable([
      { _id: 'quota-meet', _openid: 'user-openid-1', templateId: MEET_TMPL, remaining: 173 }
    ]);
    db.collection.mockReturnValue(collection);

    const res = await main({ action: 'add', templateIds: [STATUS_TMPL] }, {});
    expect(res.success).toBe(true);
    expect(Object.keys(res.data.counts)).toEqual([STATUS_TMPL, MEET_TMPL, NEW_CAT_TMPL]);
    expect(res.data.counts[STATUS_TMPL]).toBe(1);
    expect(res.data.counts[MEET_TMPL]).toBe(173);
    expect(res.data.counts[NEW_CAT_TMPL]).toBe(0);
    expect(res.data.total).toBe(174);
  });

  test('get 返回全量计数（缺省模板补 0、越界值回夹）', async () => {
    const chain = db.collection();
    chain.where.mockReturnValue({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: [{ templateId: STATUS_TMPL, remaining: 999 }]
        }))
      }))
    });
    db.collection.mockReturnValue(chain);

    const res = await main({ action: 'get' }, {});
    expect(res.success).toBe(true);
    expect(res.data.limit).toBe(200);
    expect(res.data.counts[STATUS_TMPL]).toBe(200);
    // 未授权过的模板补 0
    const zeroCount = Object.values(res.data.counts).filter(v => v === 0).length;
    expect(zeroCount).toBeGreaterThan(0);
  });

  test('数据库异常时透传真实原因（集合未创建/权限问题要能在前端看出来）', async () => {
    const chain = db.collection();
    chain.where.mockReturnValue({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.reject(new Error('collection not exists')))
      }))
    });
    db.collection.mockReturnValue(chain);

    const res = await main({ action: 'get' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('collection not exists');
  });
});
