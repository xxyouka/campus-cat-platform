/**
 * __tests__/cloudfunctions/migrateCatListSort.test.js
 *
 * 一次性回填「列表排序值 listSort」（migrateCatListSort）：
 * 权限门槛（仅超级管理员）、dryRun 默认不写库、write 模式写入值正确、
 * 游标分页续跑与幂等（重跑 updated = 0）。
 *
 * 排序规则本身（档位 + 时间戳）由 listSort.test.js 锁定，这里只验证
 * 「谁被写、写成什么、什么时候不写」。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/migrateCatListSort/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/migrateCatListSort/common/operationLogger', () => ({
  logOperation: jest.fn()
}));

const { LIST_SORT_TIERS } = require('../../cloudfunctions/migrateCatListSort/utils/listSort');

// 固定时间戳（2023-11 附近）：回填取存量 updateTime/createTime，与运行时刻无关
const T = 1700000000000;

/**
 * 伪造云数据库：只实现本函数用到的查询形状。
 * cats 用内存数组模拟——doc().update() 会把回填值写回数组，
 * 「幂等（重跑 updated = 0）」才真的被测到（而不是靠 mock 假装）。
 */
function makeFakeDb({ cats = [] } = {}) {
  const state = { updates: [] };

  const db = {
    command: { gt: v => ({ $gt: v }) },
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      if (name !== 'cats') throw new Error('未预期的集合: ' + name);
      return {
        where(where) {
          const rows = cats.filter(c => !(where && where._id) || String(c._id) > String(where._id.$gt));
          const chain = {
            orderBy: () => chain,
            field: () => chain,
            limit: n => ({ get: async () => ({ data: rows.slice(0, n) }) })
          };
          return chain;
        },
        doc(id) {
          return {
            update: async ({ data }) => {
              state.updates.push({ id, data });
              const row = cats.find(c => c._id === id);
              if (row) Object.assign(row, data);
              return { stats: { updated: 1 } };
            }
          };
        }
      };
    }
  };

  return { db, state };
}

const SUPER = { isAdmin: true, adminInfo: { role: 'superadmin' } };

/**
 * 装载入口：jest.resetModules() 后必须在这里重抓 mock 实例再装载入口，
 * 否则测试体里设置的 mockResolvedValue 对入口不可见（同 sweepLostCats 套件教训）。
 */
function loadMain({ db, openid = 'admin-openid', authResult = SUPER } = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();
  cloud.getWXContext.mockReturnValue({ OPENID: openid });
  if (db) cloud.database.mockReturnValue(db);

  const auth = require('../../cloudfunctions/migrateCatListSort/utils/auth');
  auth.checkAdmin.mockReset();
  if (authResult) auth.checkAdmin.mockResolvedValue(authResult);

  const oplog = require('../../cloudfunctions/migrateCatListSort/common/operationLogger');
  oplog.logOperation.mockReset();
  oplog.logOperation.mockResolvedValue('log-1');

  return {
    main: require('../../cloudfunctions/migrateCatListSort/index').main,
    auth,
    oplog
  };
}

/** 三只典型猫：缺字段待回填 / 已是最新 / 无时间可循（沉底 0） */
function makeCats() {
  return [
    // 缺 listSort：按 normal 档 + updateTime 回填
    { _id: 'a1', status: 'normal', updateTime: new Date(T) },
    // 已是最新：deceased 档 + (T+1000)，与计算规则一致（此处独立手算，不调 computeListSort）
    { _id: 'a2', status: 'deceased', updateTime: new Date(T + 1000), listSort: LIST_SORT_TIERS.deceased + (T + 1000) },
    // 无 updateTime / createTime（脏数据）：回填为 0，沉到最底
    { _id: 'a3', status: 'adopted' }
  ];
}

describe('migrateCatListSort 云函数', () => {
  test('dryRun（默认）：只出报告不写库，正确区分待回填与已最新', async () => {
    const { db, state } = makeFakeDb({ cats: makeCats() });
    const { main, oplog } = loadMain({ db });

    const res = await main({}, {});

    expect(res.success).toBe(true);
    expect(res.data.mode).toBe('dryRun');
    expect(res.data.scanned).toBe(3);
    expect(res.data.updated).toBe(2);   // a1、a3
    expect(res.data.upToDate).toBe(1);  // a2
    expect(res.data.done).toBe(true);
    expect(res.data.nextCursor).toBe('');
    expect(state.updates).toHaveLength(0);
    // 样本带 from/to，供 dryRun 报告核对
    expect(res.data.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ catId: 'a1', to: LIST_SORT_TIERS.normal + T }),
      expect.objectContaining({ catId: 'a3', to: 0 })
    ]));
    expect(oplog.logOperation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ module: 'migrateCatListSort', action: 'migrate' })
    );
  });

  test('write 模式：按档位 + 时间戳写入正确值', async () => {
    const { db, state } = makeFakeDb({ cats: makeCats() });
    const { main } = loadMain({ db });

    const res = await main({ mode: 'write' }, {});

    expect(res.success).toBe(true);
    expect(res.data.mode).toBe('write');
    expect(res.data.updated).toBe(2);
    expect(state.updates).toHaveLength(2);

    const byId = Object.fromEntries(state.updates.map(u => [u.id, u.data.listSort]));
    expect(byId.a1).toBe(LIST_SORT_TIERS.normal + T);
    expect(byId.a3).toBe(0);
    // 已被最新值覆盖过的不再写
    expect(byId.a2).toBeUndefined();
  });

  test('幂等：write 之后重跑 dryRun，全部已是目标值（updated = 0）', async () => {
    const { db } = makeFakeDb({ cats: makeCats() });
    const { main } = loadMain({ db });

    await main({ mode: 'write' }, {});
    const second = await main({}, {});

    expect(second.success).toBe(true);
    expect(second.data.updated).toBe(0);
    expect(second.data.upToDate).toBe(3);
  });

  test('游标分页续跑：limit 截断时返回 nextCursor，带游标继续直到 done', async () => {
    const { db } = makeFakeDb({ cats: makeCats() });
    const { main } = loadMain({ db });

    const first = await main({ limit: 2 }, {});
    expect(first.success).toBe(true);
    expect(first.data.scanned).toBe(2);
    expect(first.data.done).toBe(false);
    expect(first.data.nextCursor).toBe('a2');

    const second = await main({ limit: 2, cursor: first.data.nextCursor }, {});
    expect(second.success).toBe(true);
    expect(second.data.scanned).toBe(1);
    expect(second.data.done).toBe(true);
    expect(second.data.nextCursor).toBe('');
  });

  test('仅超级管理员：普通管理员被拒绝且不写库', async () => {
    const { db, state } = makeFakeDb({ cats: makeCats() });
    const { main } = loadMain({ db, authResult: { isAdmin: true, adminInfo: { role: 'admin' } } });

    const res = await main({ mode: 'write' }, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('超级管理员');
    expect(state.updates).toHaveLength(0);
  });

  test('非管理员被拒绝', async () => {
    const { db } = makeFakeDb({ cats: makeCats() });
    const { main } = loadMain({ db, authResult: { isAdmin: false, error: '无权限执行此操作' } });

    const res = await main({}, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
  });
});
