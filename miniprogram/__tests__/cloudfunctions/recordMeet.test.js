process.env.SUBSCRIBE_MEET_TEMPLATE_ID = 'tmpl-meet';
// 档位表来自被测函数实际使用的副本：断言自动找回写入的 listSort 档位语义
const { LIST_SORT_TIERS } = require('../../cloudfunctions/recordMeet/utils/listSort');

function makeSystemStateCollection() {
  const documents = new Map();
  const matches = (document, condition) => document &&
    Object.entries(condition).every(([key, value]) => document[key] === value);

  return {
    where: jest.fn((condition) => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: documents.has(condition._id) ? [{ ...documents.get(condition._id) }] : []
        }))
      })),
      update: jest.fn(({ data }) => {
        const current = documents.get(condition._id);
        if (!matches(current, condition)) return Promise.resolve({ stats: { updated: 0 } });
        documents.set(condition._id, { ...current, ...data });
        return Promise.resolve({ stats: { updated: 1 } });
      }),
      remove: jest.fn(() => {
        const current = documents.get(condition._id);
        if (!matches(current, condition)) return Promise.resolve({ stats: { removed: 0 } });
        documents.delete(condition._id);
        return Promise.resolve({ stats: { removed: 1 } });
      })
    })),
    add: jest.fn(({ data }) => {
      if (documents.has(data._id)) {
        const error = new Error('duplicate key');
        error.errCode = -502001;
        return Promise.reject(error);
      }
      documents.set(data._id, { ...data });
      return Promise.resolve({ _id: data._id });
    })
  };
}

function installSystemStateMock(cloud) {
  const originalMockReturnValue = cloud.database.mockReturnValue.bind(cloud.database);
  cloud.database.mockReturnValue = (database) => {
    const originalCollection = database.collection;
    const systemState = makeSystemStateCollection();
    return originalMockReturnValue({
      ...database,
      collection: jest.fn((name) => name === 'system_state' ? systemState : originalCollection(name))
    });
  };
}

describe('recordMeet 云函数', () => {
  beforeEach(() => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    installSystemStateMock(cloud);
    cloud.getWXContext.mockReturnValue({ OPENID: 'test-openid' });
  });

  test('缺少 catId 应返回错误', async () => {
    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({}, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少猫咪信息');
  });

  test('缺少服务端 OPENID 时拒绝且不访问数据库', async () => {
    const mockCloud = require('wx-server-sdk');
    const collection = jest.fn();
    mockCloud.getWXContext.mockReturnValue({ OPENID: '' });
    mockCloud.database.mockReturnValue({ collection });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd' }, {});

    expect(result.success).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(collection).not.toHaveBeenCalled();
  });

  test('无效 catId 格式应返回错误', async () => {
    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'invalid-id!!!' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的猫咪ID');
  });

  test('同一猫咪和用户的并发打卡只写入一条记录', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-meet-id' }));
    const mockCount = jest.fn(() => Promise.resolve({ total: mockAdd.mock.calls.length ? 1 : 0 }));
    const mockGet = jest.fn(() => Promise.resolve({ data: { name: '小橘', avatar: 'avatar.jpg' } }));
    const mockUpdate = jest.fn(() => Promise.resolve({}));
    const mockDoc = jest.fn(() => ({ get: mockGet, update: mockUpdate }));

    mockCloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') {
          return { doc: mockDoc, count: mockCount };
        }
        if (name === 'recordMeet') {
          return {
            where: jest.fn(() => ({
              count: mockCount,
              get: jest.fn(() => Promise.resolve({ data: [] })),
              limit: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve({ data: [] }))
              })),
              field: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: jest.fn(() => Promise.resolve({ data: [] }))
                }))
              }))
            })),
            add: mockAdd,
            doc: mockDoc
          };
        }
        return {
          where: jest.fn(() => ({
            field: jest.fn(() => ({
              limit: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve({ data: [] }))
              }))
            })),
            count: mockCount
          }))
        };
      }),
      serverDate: jest.fn(() => new Date()),
      command: {
        gte: jest.fn(v => v),
        neq: jest.fn(v => v),
        inc: jest.fn(v => v),
        exists: jest.fn(v => v)
      },
      startTransaction: jest.fn(() => Promise.reject(new Error('事务不可用')))
    });
    mockCloud.openapi = {
      security: { msgSecCheck: jest.fn(() => Promise.resolve({})) },
      subscribeMessage: { send: jest.fn(() => Promise.resolve({})) }
    };

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const event = { catId: 'abcdef1234567890abcd', location: '图书馆', statusTag: '在睡觉' };
    const results = await Promise.all([
      recordMeet.main(event, {}),
      recordMeet.main(event, {})
    ]);
    const successes = results.filter(result => result.success);
    const rejected = results.filter(result => !result.success);
    expect(successes).toHaveLength(1);
    expect(successes[0].data).toHaveProperty('todayCount');
    expect(successes[0]).toHaveProperty('message');
    expect(rejected).toHaveLength(1);
    expect(['IN_PROGRESS', 'COOLDOWN']).toContain(rejected[0].code);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  test('1小时内重复打卡应返回冷却错误', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockCount = jest.fn(() => Promise.resolve({ total: 1 }));

    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: mockCount,
          get: jest.fn(() => Promise.resolve({ data: [] })),
          limit: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: [] }))
          }))
        })),
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: { name: '小橘' } }))
        })),
        count: mockCount
      })),
      serverDate: jest.fn(() => new Date()),
      command: {
        gte: jest.fn(v => v),
        neq: jest.fn(v => v),
        inc: jest.fn(v => v),
        exists: jest.fn(v => v)
      },
      startTransaction: jest.fn(() => Promise.reject(new Error('事务不可用')))
    });
    mockCloud.openapi = {
      security: { msgSecCheck: jest.fn(() => Promise.resolve({})) }
    };

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main(
      { catId: 'abcdef1234567890abcd' },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('1小时内已打卡');
  });

  test('默认值逻辑应正确', () => {
    const sanitizeEmojiText = (str, maxLen) => {
      if (typeof str !== 'string') return '';
      let result = str.substring(0, maxLen || 200).trim();
      result = result.replace(/<[^>]*>/gi, '');
      result = result.replace(/javascript\s*:/gi, '');
      result = result.replace(/on\w+\s*=/gi, '');
      result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // eslint-disable-line no-control-regex
      result = result.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
      return result.trim();
    };
    expect(sanitizeEmojiText('', 100) || '校园内').toBe('校园内');
    expect(sanitizeEmojiText('图书馆', 100) || '校园内').toBe('图书馆');
    expect(sanitizeEmojiText('<script>alert(1)</script>', 100)).toBe('alert(1)');
  });

  test('打卡推送：配额持有者发送成功 -1；历史授权兜底消费', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockCount = jest.fn(() => Promise.resolve({ total: 0 }));
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-meet-id' }));
    const mockGet = jest.fn(() => Promise.resolve({ data: { name: '小橘', avatar: 'avatar.jpg' } }));
    const mockUpdate = jest.fn(() => Promise.resolve({}));
    const mockDoc = jest.fn(() => ({ get: mockGet, update: mockUpdate }));
    const quotaDocUpdate = jest.fn(() => Promise.resolve({}));
    const quotaWhereUpdate = jest.fn(() => Promise.resolve({}));
    const legacyDocRemove = jest.fn(() => Promise.resolve({}));

    // 读取链同时覆盖 where().limit().get() / where().orderBy().field().limit().get() / where().field().limit().get()
    const makeChain = (data) => {
      const getFn = () => Promise.resolve({ data });
      const limitObj = () => ({ get: jest.fn(getFn) });
      const fieldObj = () => ({ limit: jest.fn(limitObj) });
      const orderByObj = () => ({ limit: jest.fn(limitObj), field: jest.fn(fieldObj) });
      return {
        where: jest.fn(() => ({
          get: jest.fn(getFn),
          limit: jest.fn(limitObj),
          orderBy: jest.fn(orderByObj),
          field: jest.fn(fieldObj)
        }))
      };
    };

    mockCloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') return { doc: mockDoc, count: mockCount };
        if (name === 'recordMeet') {
          return {
            where: jest.fn(() => ({
              count: mockCount,
              get: jest.fn(() => Promise.resolve({ data: [] })),
              limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
            })),
            add: mockAdd,
            doc: mockDoc
          };
        }
        if (name === 'userFavorites') return makeChain([{ _openid: 'follower-1' }]);
        if (name === 'userSubscriptions') {
          return {
            ...makeChain([{ _id: 'legacy-1', _openid: 'legacy-2', status: 'accept' }]),
            doc: jest.fn(() => ({ remove: legacyDocRemove }))
          };
        }
        if (name === 'subscribeQuota') {
          const chain = makeChain([{ _id: 'q1', _openid: 'follower-1', remaining: 2 }]);
          const innerWhere = chain.where;
          chain.where = jest.fn((...args) => ({ ...innerWhere(...args), update: quotaWhereUpdate }));
          chain.doc = jest.fn(() => ({ update: quotaDocUpdate }));
          return chain;
        }
        if (name === 'notifications') {
          return { ...makeChain([]), add: jest.fn(() => Promise.resolve({})) };
        }
        return makeChain([]);
      }),
      serverDate: jest.fn(() => new Date()),
      command: {
        gte: jest.fn(v => v),
        neq: jest.fn(v => v),
        inc: jest.fn(v => v),
        exists: jest.fn(v => v),
        in: jest.fn(v => v),
        gt: jest.fn(v => v)
      },
      startTransaction: jest.fn(() => Promise.reject(new Error('事务不可用')))
    });
    mockCloud.openapi = {
      security: { msgSecCheck: jest.fn(() => Promise.resolve({})) },
      subscribeMessage: { send: jest.fn(() => Promise.resolve({})) }
    };

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main(
      { catId: 'abcdef1234567890abcd', location: '图书馆', statusTag: '在睡觉' },
      {}
    );
    expect(result.success).toBe(true);
    // 两位可推对象：follower-1（有配额 → 发送 + -1）；legacy-2（历史授权兜底 → 发送 + 消费记录）
    expect(mockCloud.openapi.subscribeMessage.send).toHaveBeenCalledTimes(2);
    expect(quotaDocUpdate).toHaveBeenCalledTimes(1);
    expect(quotaDocUpdate.mock.calls[0][0].data.remaining).toBe(-1);
    expect(legacyDocRemove).toHaveBeenCalledTimes(1);
  });

  // ===== BE-1 回归（2026-10-11）：事务失败的两类必须分开处理 =====
  //
  // 既有 4 条用例一律把 startTransaction mock 成 reject，只覆盖「事务不可用 → 非事务降级」，
  // 事务主路径零覆盖。本组用例把事务跑起来，并断言最关键的一条不变量：
  // **rollback 失败（事务可能已提交）时，一次非事务重写都不能发生**。
  // 否则 commit 实际成功、响应丢失的场景会多出一条打卡记录并把 meetCount 双计。

  /**
   * 事务可用的 db mock。
   * @param {boolean} commitFails  commit() 是否失败
   * @param {boolean} rollbackFails rollback() 是否失败（true = 可能已提交）
   */
  function makeTransactionMock({ commitFails, rollbackFails }) {
    const dbAdd = jest.fn(() => Promise.resolve({ _id: 'db-added-meet' }));
    const dbUpdate = jest.fn(() => Promise.resolve({}));
    const txAdd = jest.fn(() => Promise.resolve({ _id: 'tx-added-meet' }));
    const txUpdate = jest.fn(() => Promise.resolve({}));
    const rollback = jest.fn(() => rollbackFails
      ? Promise.reject(new Error('rollback failed: transaction already committed'))
      : Promise.resolve());

    const transaction = {
      collection: jest.fn((name) => name === 'cats'
        ? { doc: () => ({ update: txUpdate }) }
        : { add: txAdd }),
      commit: jest.fn(() => commitFails
        ? Promise.reject(new Error('commit response lost'))
        : Promise.resolve()),
      rollback
    };

    const makeChain = (data) => {
      const getFn = () => Promise.resolve({ data });
      const limitObj = () => ({ get: jest.fn(getFn) });
      const fieldObj = () => ({ limit: jest.fn(limitObj) });
      const orderByObj = () => ({ limit: jest.fn(limitObj), field: jest.fn(fieldObj) });
      return {
        where: jest.fn(() => ({
          get: jest.fn(getFn),
          limit: jest.fn(limitObj),
          orderBy: jest.fn(orderByObj),
          field: jest.fn(fieldObj),
          count: jest.fn(() => Promise.resolve({ total: data.length }))
        }))
      };
    };

    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') {
          return {
            doc: () => ({
              get: jest.fn(() => Promise.resolve({ data: { name: '小橘', avatar: '' } })),
              update: dbUpdate
            }),
            count: jest.fn(() => Promise.resolve({ total: 0 })),
            where: jest.fn(() => ({ count: jest.fn(() => Promise.resolve({ total: 0 })) }))
          };
        }
        if (name === 'recordMeet') {
          return {
            where: jest.fn(() => ({
              count: jest.fn(() => Promise.resolve({ total: 0 })),
              get: jest.fn(() => Promise.resolve({ data: [] }))
            })),
            add: dbAdd
          };
        }
        return makeChain([]);
      }),
      serverDate: jest.fn(() => new Date()),
      command: {
        gte: jest.fn(v => v),
        neq: jest.fn(v => v),
        inc: jest.fn(v => v),
        exists: jest.fn(v => v),
        in: jest.fn(v => v),
        gt: jest.fn(v => v)
      },
      startTransaction: jest.fn(() => Promise.resolve(transaction))
    });
    mockCloud.openapi = {
      security: { msgSecCheck: jest.fn(() => Promise.resolve({})) },
      subscribeMessage: { send: jest.fn(() => Promise.resolve({})) }
    };

    return { dbAdd, dbUpdate, txAdd, txUpdate, rollback };
  }

  test('BE-1：rollback 失败（事务可能已提交）→ 绝不降级重写', async () => {
    const { dbAdd, txAdd, rollback } = makeTransactionMock({ commitFails: true, rollbackFails: true });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(txAdd).toHaveBeenCalledTimes(1);
    // 核心断言：非事务写入路径一次都不能被走到
    expect(dbAdd).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    // 文案必须如实告知「结果未确认」，既不谎报成功、也不谎报未写入
    expect(result.error).toContain('未确认');
  });

  // ==========================================================================
  // QA-9：事务**成功**主路径
  //
  // 补这条的理由：本文件原有 3 条用例把 startTransaction 全 mock 成 reject
  // （recordMeet.test.js:69 / 111 / 211），BE-1 新增的两条也只把 commit 打成失败
  // ——于是「事务可用且成功提交」这条**最正常的主路径**从未被执行过一次。
  // 后果：事务内 add / update / commit 的调用顺序、计数递增归属、返回值口径，
  // 任何改动都不会让测试变红；writeMeetInTransaction 的成功分支长期零覆盖。
  //
  // 判定事务确实走通、且没有偷偷降级，依据三条（都不需要改 makeTransactionMock）：
  //   · txAdd / txUpdate 各调用一次  → 写入走的是事务对象，不是 db.collection
  //   · rollback 未被调用            → commit 没有失败（失败必然先进 catch 再 rollback）
  //   · dbAdd 未被调用              → 没有发生降级重写（否则就是重复打卡 + meetCount 双计）
  // ==========================================================================
  test('QA-9：事务可用且提交成功 → 走事务写入，不降级、不 rollback', async () => {
    const { dbAdd, dbUpdate, txAdd, txUpdate, rollback } = makeTransactionMock({
      commitFails: false,
      rollbackFails: false
    });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main(
      { catId: 'abcdef1234567890abcd', location: '图书馆', statusTag: '在睡觉' },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('todayCount');

    // 写入与计数递增都必须发生在事务对象上
    expect(txAdd).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);

    // commit 未失败 ⇒ catch 未进入 ⇒ rollback 不该被调用
    expect(rollback).not.toHaveBeenCalled();

    // 最关键的一条：事务成功时绝不能再走非事务写入（那会造成重复打卡与计数双计）
    expect(dbAdd).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  test('BE-1：rollback 成功（事务确定未提交）→ 仍降级为非事务写入', async () => {
    const { dbAdd, txAdd } = makeTransactionMock({ commitFails: true, rollbackFails: false });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});

    // 收紧策略不能矫枉过正：事务确实没提交时，降级写入是必要的可用性保障
    expect(txAdd).toHaveBeenCalledTimes(1);
    expect(dbAdd).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  // ==========================================================================
  // lastMeetTime 与「走失猫被再次遇到 → 自动找回」（2026-10-12）
  //
  // 两条不变量：
  //   1. 打卡必须同时刷新 lastMeetTime —— 它是「久未相遇 → 自动走失」的判定基准，
  //      只加计数会让刚被遇到的猫在下次扫描里仍被当成久未相遇；
  //   2. 只有 status === 'lost' 的猫才复位，且复位与通知都以
  //      `where({_id, status:'lost'}).update()` 的 updated > 0 为准（并发打卡只发一次通知）。
  // ==========================================================================

  /**
   * 打卡 + 通知链路共用的 db mock。
   * @param {string} catStatus 打卡前读到的猫咪状态
   * @param {number} updated   条件复位的 updated 计数（0 = 状态已被别人改走）
   */
  function makeRecoverMock({ catStatus = 'lost', updated = 1 } = {}) {
    const catDocUpdate = jest.fn(() => Promise.resolve({}));       // 计数 + lastMeetTime
    const catWhereUpdate = jest.fn(() => Promise.resolve({ stats: { updated } })); // 条件复位
    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n1' }));

    const makeChain = (data) => {
      const getFn = () => Promise.resolve({ data });
      const limitObj = () => ({ get: jest.fn(getFn) });
      const fieldObj = () => ({ limit: jest.fn(limitObj) });
      const orderByObj = () => ({ limit: jest.fn(limitObj), field: jest.fn(fieldObj) });
      return {
        where: jest.fn(() => ({
          get: jest.fn(getFn),
          limit: jest.fn(limitObj),
          orderBy: jest.fn(orderByObj),
          field: jest.fn(fieldObj)
        }))
      };
    };

    const mockCloud = require('wx-server-sdk');
    // 打卡者 openid 与 userFavorites 里的 visitor-1 对齐，才能真的验证「排除打卡者本人」
    mockCloud.getWXContext.mockReturnValue({ OPENID: 'visitor-1' });
    mockCloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') {
          return {
            doc: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: { name: '小橘', avatar: 'a.jpg', status: catStatus } })),
              update: catDocUpdate
            })),
            where: jest.fn(() => ({ update: catWhereUpdate }))
          };
        }
        if (name === 'recordMeet') {
          return {
            // 同一集合被两种计数查询复用，按 where 形状区分：
            // 带 _openid 的是「1 小时冷却去重」（要放行 → 0），不带的是「今日打卡数」（要能算出 1）
            where: jest.fn(w => ({
              count: jest.fn(() => Promise.resolve({ total: w && w._openid ? 0 : 1 })),
              get: jest.fn(() => Promise.resolve({ data: [] })),
              limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
            })),
            add: jest.fn(() => Promise.resolve({ _id: 'meet-1' }))
          };
        }
        // 关注者集合按 where 过滤：`_.neq(visitor)` 走 $neq 指令，
        // 这样「排除打卡者本人」才真的被测到（而不是被 mock 忽略后假绿）
        if (name === 'userFavorites') {
          const rows = [{ _openid: 'follower-1' }, { _openid: 'visitor-1' }];
          const applyWhere = (w) => rows.filter(row => {
            const exclude = w && w._openid;
            if (exclude && typeof exclude === 'object' && '$neq' in exclude) return row._openid !== exclude.$neq;
            return true;
          });
          return {
            where: jest.fn(w => ({
              get: jest.fn(() => Promise.resolve({ data: applyWhere(w) })),
              orderBy: jest.fn(() => ({
                field: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: applyWhere(w) })) })) }))
              })),
              field: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: applyWhere(w) })) })) }))
            }))
          };
        }
        if (name === 'userSubscriptions') return { ...makeChain([]), doc: jest.fn(() => ({ remove: jest.fn(() => Promise.resolve({})) })) };
        if (name === 'subscribeQuota') return { ...makeChain([]), doc: jest.fn(() => ({ update: jest.fn(() => Promise.resolve({})) })) };
        if (name === 'notifications') return { ...makeChain([]), add: notifAdd };
        return makeChain([]);
      }),
      serverDate: jest.fn(() => new Date()),
      command: {
        gte: jest.fn(v => v),
        neq: jest.fn(v => ({ $neq: v })),
        inc: jest.fn(v => v),
        exists: jest.fn(v => v),
        in: jest.fn(v => v),
        gt: jest.fn(v => v)
      },
      startTransaction: jest.fn(() => Promise.reject(new Error('事务不可用')))
    });
    mockCloud.openapi = {
      security: { msgSecCheck: jest.fn(() => Promise.resolve({})) },
      subscribeMessage: { send: jest.fn(() => Promise.resolve({})) }
    };

    return { catDocUpdate, catWhereUpdate, notifAdd };
  }

  test('打卡同时刷新 lastMeetTime（与 meetCount 同一次写入）', async () => {
    const { catDocUpdate } = makeRecoverMock({ catStatus: 'normal' });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const before = Date.now();
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});

    expect(result.success).toBe(true);
    expect(catDocUpdate).toHaveBeenCalledTimes(1);
    const data = catDocUpdate.mock.calls[0][0].data;
    expect(data).toHaveProperty('meetCount');
    expect(typeof data.lastMeetTime).toBe('number');
    expect(data.lastMeetTime).toBeGreaterThanOrEqual(before);
  });

  test('走失猫被再次遇到：条件复位为正常，并向关注者（排除打卡者）发找回通知', async () => {
    const { catWhereUpdate, notifAdd } = makeRecoverMock({ catStatus: 'lost', updated: 1 });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const before = Date.now();
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});
    const after = Date.now();

    expect(result.success).toBe(true);
    // 复位是条件写：只有 status 仍为 lost 时才生效
    expect(catWhereUpdate).toHaveBeenCalledTimes(1);
    const recoverData = catWhereUpdate.mock.calls[0][0].data;
    expect(recoverData.status).toBe('normal');
    // 列表排序值与 updateTime 同步重算：找回 → normal 档，时间戳为本次打卡时刻
    // （漏写会让找回的猫按旧排序值停在走失时的位置）
    expect(recoverData.listSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.normal + before);
    expect(recoverData.listSort).toBeLessThanOrEqual(LIST_SORT_TIERS.normal + after);

    // 找回通知：只有 follower-1（打卡者 visitor-1 被排除）
    const foundCalls = notifAdd.mock.calls.filter(c => c[0].data.type === 'cat_found');
    expect(foundCalls).toHaveLength(1);
    expect(foundCalls[0][0].data._openid).toBe('follower-1');
    expect(foundCalls[0][0].data.content).toContain('找回');
  });

  test('非走失猫打卡：不复位、不发找回通知', async () => {
    const { catWhereUpdate, notifAdd } = makeRecoverMock({ catStatus: 'normal' });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});

    expect(result.success).toBe(true);
    expect(catWhereUpdate).not.toHaveBeenCalled();
    expect(notifAdd.mock.calls.map(c => c[0].data.type)).not.toContain('cat_found');
  });

  test('复位竞争失败（updated = 0）：不发找回通知', async () => {
    const { catWhereUpdate, notifAdd } = makeRecoverMock({ catStatus: 'lost', updated: 0 });

    const recordMeet = require('../../cloudfunctions/recordMeet/index');
    const result = await recordMeet.main({ catId: 'abcdef1234567890abcd', location: '图书馆' }, {});

    expect(result.success).toBe(true);
    expect(catWhereUpdate).toHaveBeenCalledTimes(1);
    expect(notifAdd.mock.calls.map(c => c[0].data.type)).not.toContain('cat_found');
  });
});
