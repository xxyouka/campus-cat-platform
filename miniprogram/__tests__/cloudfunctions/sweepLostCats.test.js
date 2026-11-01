/**
 * __tests__/cloudfunctions/sweepLostCats.test.js
 *
 * 「久未相遇 → 自动走失」定时扫描：定时触发校验、判定口径、安全阀与写库幂等。
 *
 * 通知链路（站内 + 订阅推送）在本套件里被 mock 掉：那部分由
 * updateCat/recordMeet 的既有用例与 utils/statusNotify 的共享实现负责，
 * 本套件只验证「谁被标记、谁没被标记、什么时候不写库」。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/sweepLostCats/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/sweepLostCats/common/operationLogger', () => ({
  logOperation: jest.fn()
}));
jest.mock('../../cloudfunctions/sweepLostCats/utils/statusNotify', () => ({
  STATUS_NOTIFICATIONS: {
    lost: { type: 'cat_lost', title: '走失提醒', tip: '请帮忙留意校园角落', template: '你关注的「{name}」走失了，请帮忙留意！' }
  },
  notifyCatStatusChange: jest.fn(async () => ({ notified: 2, pushed: 1 }))
}));

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
// 档位表来自被测函数实际使用的副本：断言写入的 listSort 档位语义
// （走失档 = 在校同档：2e13，见 cloudfunctions/utils/listSort.js）
const { LIST_SORT_TIERS } = require('../../cloudfunctions/sweepLostCats/utils/listSort');

/** 造一只猫档案：lastMeetTime 用「距今多少天」表达 */
function makeCat(id, { name = '猫' + id, daysAgo = 1, via = 'meet', location = '' } = {}) {
  const cat = { _id: id, name, status: 'normal', location, avatar: '' };
  if (daysAgo === null) return cat;
  if (via === 'meet') cat.lastMeetTime = NOW - daysAgo * DAY;
  if (via === 'create') cat.createTime = new Date(NOW - daysAgo * DAY);
  if (via === 'reset') cat.lostResetAt = NOW - daysAgo * DAY;
  return cat;
}

/** 伪造云数据库：只实现本函数用到的查询形状（cats 分页扫描 / 条件更新、system_state 节流） */
function makeFakeDb({ cats = [], updateResult, systemState = [] } = {}) {
  const state = {
    catUpdates: [],
    systemStateAdds: [],
    systemStateDocs: systemState.slice()
  };

  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (value && typeof value === 'object' && '$gt' in value) {
      return String(row[key]) > String(value.$gt);
    }
    return row[key] === value;
  });

  const db = {
    serverDate: () => 'SERVER_DATE',
    command: { gt: v => ({ $gt: v }) },
    collection(name) {
      if (name === 'cats') {
        return {
          where(where) {
            const rows = cats.filter(c => matches(c, where));
            const chain = {
              orderBy: () => chain,
              field: () => chain,
              limit: n => ({ get: async () => ({ data: rows.slice(0, n) }) }),
              update: async ({ data }) => {
                state.catUpdates.push({ where, data });
                return typeof updateResult === 'function' ? updateResult(where) : { stats: { updated: 1 } };
              }
            };
            return chain;
          }
        };
      }
      if (name === 'system_state') {
        return {
          where: () => ({ limit: () => ({ get: async () => ({ data: state.systemStateDocs }) }) }),
          add: async ({ data }) => {
            state.systemStateAdds.push(data);
            state.systemStateDocs.push(data);
            return { _id: 'state-1' };
          },
          doc: () => ({
            update: async () => ({}),
            remove: async () => {
              state.systemStateDocs = [];
              return {};
            }
          })
        };
      }
      throw new Error('未预期的集合: ' + name);
    }
  };

  return { db, state };
}

/**
 * 装载入口。
 *
 * 必须在这里（而不是测试体的 beforeEach 里）重新 require 被测模块与它的依赖：
 * jest.resetModules() 会让之后 require 到的 mock 工厂重新执行，
 * 于是 beforeEach 里抓到的 auth / operationLogger 引用会变成**另一个实例**，
 * 在上面设的 mockResolvedValue 对入口完全不可见（曾经因此红了一整组用例）。
 */
function loadMain({ db, openid = '', source = 'wx_trigger', authResult } = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();
  cloud.getWXContext.mockReturnValue({ OPENID: openid, SOURCE: source });
  if (db) cloud.database.mockReturnValue(db);

  const auth = require('../../cloudfunctions/sweepLostCats/utils/auth');
  auth.checkAdmin.mockReset();
  if (authResult) auth.checkAdmin.mockResolvedValue(authResult);

  const oplog = require('../../cloudfunctions/sweepLostCats/common/operationLogger');
  oplog.logOperation.mockReset();
  oplog.logOperation.mockResolvedValue('log-1');

  const notifier = require('../../cloudfunctions/sweepLostCats/utils/statusNotify');
  notifier.notifyCatStatusChange.mockClear();

  return {
    main: require('../../cloudfunctions/sweepLostCats/index').main,
    auth,
    oplog,
    notifier
  };
}

const TIMER_EVENT = { Type: 'Timer', TriggerName: 'lostSweepTimer' };
const ADMIN = { isAdmin: true, adminInfo: { role: 'superadmin' } };

describe('sweepLostCats 云函数', () => {
  test('客户端伪造 Timer 事件（带 OPENID）：不进定时分支，也不写库', async () => {
    const { db, state } = makeFakeDb({ cats: [makeCat('c1', { daysAgo: 90 })] });
    const { main, oplog } = loadMain({
      db,
      openid: 'hacker-openid',
      source: 'wx_client',
      authResult: { isAdmin: false, error: '无权限' }
    });

    const res = await main(TIMER_EVENT, {});

    expect(res.success).toBe(false);
    expect(state.catUpdates).toHaveLength(0);
    expect(oplog.logOperation).not.toHaveBeenCalled();
  });

  test('触发器名字不对：同一次调用不会被当成定时任务', async () => {
    const { db, state } = makeFakeDb({ cats: [makeCat('c1', { daysAgo: 90 })] });
    const { main } = loadMain({ db, authResult: { isAdmin: false, error: '无权限' } });

    const res = await main({ Type: 'Timer', TriggerName: 'reconcileTimer' }, {});

    expect(res.success).toBe(false);
    expect(state.catUpdates).toHaveLength(0);
  });

  test('非管理员手动调用被拒（dryRun 也不行）', async () => {
    const { db, state } = makeFakeDb({ cats: [makeCat('c1', { daysAgo: 90 })] });
    const { main } = loadMain({
      db,
      openid: 'user-openid',
      authResult: { isAdmin: false, error: '无权限执行此自动走失扫描' }
    });

    const res = await main({}, {});

    expect(res.success).toBe(false);
    expect(state.catUpdates).toHaveLength(0);
  });

  test('管理员 write 模式：非超管被拒，dryRun 允许', async () => {
    const { db } = makeFakeDb({ cats: [] });
    const { main } = loadMain({
      db,
      openid: 'admin-openid',
      authResult: { isAdmin: true, adminInfo: { role: 'admin' } }
    });

    const res = await main({ mode: 'write' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('超级管理员');

    const dry = await main({}, {});
    expect(dry.success).toBe(true);
    expect(dry.data.mode).toBe('dryRun');
  });

  describe('判定口径', () => {
    test('满 60 天的猫进候选：基准取 max(最后相遇, 建档, 手动复位)', async () => {
      const { db } = makeFakeDb({
        cats: [
          makeCat('old-meet', { daysAgo: 61 }),                          // 61 天没被遇到 → 候选
          makeCat('fresh-meet', { daysAgo: 59 }),                        // 差一天 → 不动
          makeCat('never-met', { daysAgo: 100, via: 'create' }),         // 从未被遇到，建档 100 天 → 候选
          makeCat('new-cat-never-met', { daysAgo: 10, via: 'create' }),  // 新猫从未被遇到 → 不动
          // 建档 90 天，但 5 天前刚被打过卡（lastMeetTime 比建档新）
          { ...makeCat('met-lately', { daysAgo: 90, via: 'create' }), lastMeetTime: NOW - 5 * DAY },
          // 建档 100 天，但管理员 3 天前手动复位过（lostResetAt 重启倒计时）
          { ...makeCat('admin-reset', { daysAgo: 100, via: 'create' }), lostResetAt: NOW - 3 * DAY },
          makeCat('no-baseline', { daysAgo: null })                      // 三个基准全缺 → 只报告
        ]
      });

      const { main } = loadMain({ db, openid: 'admin-openid', authResult: ADMIN });

      const res = await main({});

      expect(res.success).toBe(true);
      const report = res.data.report;
      expect(report.scanned).toBe(7);
      expect(report.invalidBaseline).toBe(1);
      expect(report.candidates).toBe(2);
      expect(report.samples.map(s => s.catId).sort()).toEqual(['never-met', 'old-meet']);
      expect(report.marked).toBeUndefined(); // dryRun 不写库
    });

    test('定时运行：满 60 天转走失，lostTime 记最后相遇那天并带 auto 标记', async () => {
      const baseline = NOW - 61 * DAY;
      const { db, state } = makeFakeDb({
        cats: [{ _id: 'c1', name: '小橘', status: 'normal', location: '图书馆', avatar: '', lastMeetTime: baseline }]
      });
      const { main } = loadMain({ db });

      const before = Date.now();
      const res = await main(TIMER_EVENT, {});
      const after = Date.now();

      expect(res.success).toBe(true);
      expect(state.catUpdates).toHaveLength(1);
      const update = state.catUpdates[0];
      expect(update.where).toEqual({ _id: 'c1', status: 'normal' });
      expect(update.data.status).toBe('lost');
      expect(update.data.lostSource).toBe('auto');
      expect(update.data.lostLocation).toBe('图书馆');
      // 列表排序值与 updateTime 同步重算（utils/listSort.js 的维护纪律：任何改写
      // cats.status / cats.updateTime 的路径都必须一起写 listSort）
      expect(typeof update.data.listSort).toBe('number');
      // 档位 = 走失档（在校同档），时间戳 = 本次标记时刻
      expect(update.data.listSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.lost + before);
      expect(update.data.listSort).toBeLessThanOrEqual(LIST_SORT_TIERS.lost + after);
      // lostTime 是基准那天（北京时间日期串），不是今天
      expect(update.data.lostTime).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(update.data.lostTime).toBe(
        new Date(baseline + 8 * 3600 * 1000).toISOString().slice(0, 10)
      );
      expect(res.data.report.marked).toBe(1);
      expect(res.data.report.notified).toBe(2);
    });

    test('写库条件不满足（状态已被改动）：跳过且不发通知', async () => {
      const { db, state } = makeFakeDb({
        cats: [makeCat('c1', { daysAgo: 90 })],
        updateResult: () => ({ stats: { updated: 0 } })
      });
      const { main, notifier } = loadMain({ db });

      const res = await main(TIMER_EVENT, {});

      expect(state.catUpdates).toHaveLength(1);
      expect(res.data.report.marked).toBe(0);
      expect(res.data.report.skipped).toBe(1);
      expect(notifier.notifyCatStatusChange).not.toHaveBeenCalled();
    });
  });

  describe('安全阀', () => {
    /** 造 n 只 90 天没被遇到的猫 */
    const staleCats = n => Array.from({ length: n }, (_, i) => makeCat('c' + i, { daysAgo: 90 + i }));

    test('单轮上限之外的候选顺延下一轮（22 只只标记 20 只）', async () => {
      const { db, state } = makeFakeDb({ cats: [...staleCats(22), ...Array.from({ length: 60 }, (_, i) => makeCat('fresh' + i, { daysAgo: 1 }))] });
      const { main } = loadMain({ db });

      const res = await main(TIMER_EVENT, {});

      expect(state.catUpdates).toHaveLength(20);
      expect(res.data.report.marked).toBe(20);
      expect(res.data.report.deferred).toBe(2);
      expect(res.data.report.aborted).toBeUndefined();
    });

    test('异常闸门：候选超过单轮上限且占在册正常猫一半以上 → 整轮不写库', async () => {
      const { db, state } = makeFakeDb({ cats: staleCats(26) });
      const { main, oplog } = loadMain({ db });

      const res = await main(TIMER_EVENT, {});

      expect(state.catUpdates).toHaveLength(0);
      expect(res.data.report.aborted).toBe(true);
      expect(res.data.report.reason).toBe('anomaly_ratio');
      expect(oplog.logOperation).toHaveBeenCalledWith(
        expect.anything(), '', expect.objectContaining({ result: 'blocked' })
      );
    });

    test('20 小时内重复触发被节流（system_state 已有近期记录）', async () => {
      const { db, state } = makeFakeDb({
        cats: staleCats(1),
        systemState: [{ _id: 's1', key: 'timer_lostSweepTimer', lastRunAt: Date.now() - 3600 * 1000 }]
      });
      const { main } = loadMain({ db });

      const res = await main(TIMER_EVENT, {});

      expect(res.data.skipped).toBe(true);
      expect(state.catUpdates).toHaveLength(0);
    });

    test('运行成功后写节流记录（失败才回滚）', async () => {
      const { db, state } = makeFakeDb({ cats: staleCats(1) });
      const { main } = loadMain({ db });

      await main(TIMER_EVENT, {});

      expect(state.systemStateAdds).toHaveLength(1);
      expect(state.systemStateAdds[0].key).toBe('timer_lostSweepTimer');
      expect(typeof state.systemStateAdds[0].lastRunAt).toBe('number');
    });
  });
});
