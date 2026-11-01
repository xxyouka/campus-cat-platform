/**
 * getOpsDashboard 入口回归
 *
 * 这个入口的重活是「按 _id 游标扫多张表 + 聚合」。测试重点不在把每个数字都抄一遍，
 * 而在几条会静默给错数的边界：
 *   1. 鉴权在缓存与扫描之前：非管理员拿不到缓存里的数字，也不会打库；
 *   2. 5 分钟缓存命中后不再扫表，computedAt 保持一致；
 *   3. 核心表读取失败必须失败关闭；ops_* 缺失只降级并给出 warning；
 *   4. keepWarm 预热不带 OPENID，必须早退，不能触发扫描。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/getOpsDashboard/utils/auth', () => ({ checkAdmin: jest.fn() }));

const { userKey, attemptKey } = require('../../cloudfunctions/getOpsDashboard/utils/opsIdentity');

const NOW = Date.UTC(2026, 9, 22, 12) - 8 * 3600 * 1000; // 北京时间 10-22 12:00

function bj(y, m, d, hour = 0) {
  return Date.UTC(y, m - 1, d, hour) - 8 * 3600 * 1000;
}

function buildData() {
  const u1 = userKey('o1');
  const u2 = userKey('o2');
  const u3 = userKey('o3');
  const u4 = userKey('o4');
  const a1 = attemptKey('o2', 'task-1');
  const a2 = attemptKey('o1', 'task-2');

  return {
    [u1]: { userKey: u1, firstSeenAt: bj(2026, 10, 6, 10), lastSeenAt: bj(2026, 10, 20, 10) },
    [u2]: { userKey: u2, firstSeenAt: bj(2026, 10, 7, 10), lastSeenAt: bj(2026, 10, 20, 10) },
    [u3]: { userKey: u3, firstSeenAt: bj(2026, 10, 8, 10), lastSeenAt: bj(2026, 10, 8, 10) },
    [u4]: { userKey: u4, firstSeenAt: bj(2026, 10, 20, 10), lastSeenAt: bj(2026, 10, 20, 10) },
    u1,
    u2,
    u3,
    u4,
    a1,
    a2
  };
}

function setup(options = {}) {
  jest.resetModules();
  const sdk = require('wx-server-sdk');
  const meta = buildData();

  const docs = {
    recordMeet: options.meets || [
      { _id: 'm1', _openid: 'o1', meetTime: bj(2026, 10, 8, 9) },
      // 更早的打卡不在 8 周窗口内，但仍应被扫描后按时间过滤掉
      { _id: 'm0', _openid: 'o1', meetTime: bj(2026, 6, 1, 9) }
    ],
    userFavorites: options.favorites || [
      { _id: 'f1', _openid: 'o2', createTime: new Date(bj(2026, 10, 9, 23)) }
    ],
    face_feedback: options.feedbacks || [
      {
        _id: 'fb1',
        _openid: 'o2',
        taskId: 'task-1',
        outcome: 'top1',
        createTime: new Date(bj(2026, 10, 10, 10))
      },
      {
        _id: 'fb2',
        _openid: 'o1',
        taskId: 'task-2',
        outcome: 'none',
        createTime: new Date(bj(2026, 10, 11, 11))
      }
    ],
    ops_users: options.users || [
      { _id: `u_${meta.u1}`, ...meta[meta.u1] },
      { _id: `u_${meta.u2}`, ...meta[meta.u2] },
      { _id: `u_${meta.u3}`, ...meta[meta.u3] },
      { _id: `u_${meta.u4}`, ...meta[meta.u4] }
    ],
    ops_days: options.days || [
      { _id: `d_2026-10-06_${meta.u1}`, userKey: meta.u1, day: '2026-10-06' },
      { _id: `d_2026-10-09_${meta.u2}`, userKey: meta.u2, day: '2026-10-09' },
      { _id: `d_2026-10-10_${meta.u2}`, userKey: meta.u2, day: '2026-10-10' },
      { _id: `d_2026-10-20_${meta.u4}`, userKey: meta.u4, day: '2026-10-20' }
    ],
    ops_recognitions: options.recognitions || [
      // 更早的一条用于确认「结果日志早已上线」；它落在 8 周窗口的最早一周，
      // 不影响 10-05 这周的 3 次尝试。
      { _id: 'r_2026-09-01_early', key: 'early-key', userKey: 'early', at: bj(2026, 9, 1, 10), candidateCount: 1 },
      { _id: `r_2026-10-10_${meta.a1}`, key: meta.a1, userKey: meta.u2, at: bj(2026, 10, 10, 10), candidateCount: 2 },
      { _id: `r_2026-10-11_${meta.a2}`, key: meta.a2, userKey: meta.u1, at: bj(2026, 10, 11, 10), candidateCount: 1 },
      { _id: 'r_2026-10-11_old', key: 'old-key', userKey: 'old', at: bj(2026, 10, 11, 10), candidateCount: 0 }
    ],
    ops_entry_usage: options.entries || [
      { _id: `e_2026-10-20_${meta.u1}`, userKey: meta.u1, day: '2026-10-20', entries: ['rank'] },
      { _id: `e_2026-10-20_${meta.u2}`, userKey: meta.u2, day: '2026-10-20', entries: ['rank', 'shop'] }
    ]
  };

  const state = { gets: {}, where: {} };
  const command = {
    gte: v => ({ op: 'gte', v }),
    gt: v => ({ op: 'gt', v }),
    lt: v => ({ op: 'lt', v }),
    and: (...arr) => ({ op: 'and', arr })
  };

  function matches(id, cond) {
    if (!cond) return true;
    if (cond.op === 'gte') return id >= cond.v;
    if (cond.op === 'gt') return id > cond.v;
    if (cond.op === 'lt') return id < cond.v;
    if (cond.op === 'and') return cond.arr.every(c => matches(id, c));
    return true;
  }

  const db = {
    command,
    serverDate: jest.fn(() => 'SERVER_DATE'),
    collection: jest.fn((name) => {
      state.gets[name] = state.gets[name] || 0;
      if (options.throwOn === name) {
        throw new Error(`${name} unavailable`);
      }
      const rows = (docs[name] || []).slice().sort((a, b) => a._id < b._id ? -1 : 1);
      let whereCond = null;
      let take = rows.length;
      const api = {
        where: jest.fn((cond) => {
          whereCond = cond && cond._id ? cond._id : null;
          return api;
        }),
        field: jest.fn(() => api),
        orderBy: jest.fn(() => api),
        limit: jest.fn((n) => {
          take = n;
          return {
            get: jest.fn(async () => {
              state.gets[name]++;
              const filtered = rows.filter(row => matches(row._id, whereCond));
              return { data: filtered.slice(0, take) };
            })
          };
        }),
        get: jest.fn(async () => {
          state.gets[name]++;
          const filtered = rows.filter(row => matches(row._id, whereCond));
          return { data: filtered.slice(0, take) };
        })
      };
      return api;
    })
  };

  sdk.getWXContext.mockReturnValue({ OPENID: options.openid === undefined ? 'admin-openid' : options.openid });
  sdk.database.mockReturnValue(db);

  const { checkAdmin } = require('../../cloudfunctions/getOpsDashboard/utils/auth');
  checkAdmin.mockResolvedValue(options.authResult || { isAdmin: true, adminInfo: { role: 'superadmin' } });

  return {
    main: require('../../cloudfunctions/getOpsDashboard/index').main,
    checkAdmin,
    state,
    meta
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getOpsDashboard 入口', () => {
  test('管理员拿到三类指标与入口清单，8 周表齐全', async () => {
    const { main } = setup();

    const res = await main({ weeks: 8, _adminAccount: 'admin' });

    expect(res.success).toBe(true);
    expect(res.data.weeks).toHaveLength(8);
    expect(res.data.coverage.trackingStartAt).toBe(bj(2026, 10, 6, 10));

    const week = res.data.weeks.find(w => w.key === '2026-10-05');
    expect(week.newUsers).toBe(3);
    expect(week.maturedNewUsers).toBe(3);
    expect(week.activatedUsers).toBe(2);
    expect(week.firstMeetUsers).toBe(1);
    expect(week.followReturnRate).toBe(1);
    const current = res.data.weeks[res.data.weeks.length - 1];
    expect(current.key).toBe('2026-10-19');
    expect(current.newUsers).toBe(1);
    expect(current.maturedNewUsers).toBe(0);
    expect(current.activationRate).toBeNull();

    // 观测不足 28 天：入口一律观测中
    expect(res.data.entries.pruneReady).toBe(false);
    expect(res.data.entries.items.find(item => item.name === 'rank').status).toBe('observing');
  });

  test('5 分钟缓存命中：第二次不再扫表，computedAt 不变', async () => {
    const { main, state } = setup();

    const first = await main({ weeks: 8 });
    const getsAfterFirst = { ...state.gets };
    const second = await main({ weeks: 8 });

    expect(second.success).toBe(true);
    expect(second.data.computedAt).toBe(first.data.computedAt);
    expect(state.gets).toEqual(getsAfterFirst);
  });

  test('鉴权在缓存之前：非管理员被拒，不查库也拿不到缓存', async () => {
    const { main, checkAdmin, state } = setup({
      authResult: { isAdmin: false, error: '无权限查看运营数据面板' }
    });

    const res = await main({ weeks: 8 });

    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
    expect(checkAdmin).toHaveBeenCalled();
    expect(state.gets).toEqual({});
  });

  test('核心表读取失败：失败关闭，不返回一份缺数据的“成功”', async () => {
    const { main } = setup({ throwOn: 'recordMeet' });

    const res = await main({ weeks: 8 });

    expect(res.success).toBe(false);
    expect(res.error).toContain('获取运营数据失败');
  });

  test('ops_entry_usage 缺失：降级返回并带 warning，不拖垮三个主指标', async () => {
    const { main } = setup({ throwOn: 'ops_entry_usage' });

    const res = await main({ weeks: 8 });

    expect(res.success).toBe(true);
    expect(res.data.dataWarnings.some(item => item.includes('ops_entry_usage'))).toBe(true);
    expect(res.data.weeks.find(w => w.key === '2026-10-05').activationRate).toBeCloseTo(2 / 3, 6);
  });

  test('ops_days 缺失：关注后回访率必须为 null，不能显示成 0', async () => {
    const { main } = setup({ throwOn: 'ops_days' });

    const res = await main({ weeks: 8 });

    expect(res.success).toBe(true);
    expect(res.data.dataWarnings.some(item => item.includes('ops_days'))).toBe(true);
    const week = res.data.weeks.find(w => w.key === '2026-10-05');
    expect(week.maturedFollowers).toBe(1);
    expect(week.followReturnRate).toBeNull();
    expect(week.followReturnDataAvailable).toBe(false);
  });

  test('入口集合缺失且埋点已满 28 天：仍不启用淘汰判定，避免把「没读到」当成 0 使用', async () => {
    const oldUserKey = 'old-user';
    const { main } = setup({
      throwOn: 'ops_entry_usage',
      users: [
        {
          _id: `u_${oldUserKey}`,
          userKey: oldUserKey,
          firstSeenAt: bj(2026, 8, 1, 10),
          lastSeenAt: bj(2026, 10, 20, 10)
        }
      ],
      days: [{ _id: `d_2026-10-20_${oldUserKey}`, userKey: oldUserKey, day: '2026-10-20' }],
      meets: [],
      favorites: [],
      feedbacks: [],
      recognitions: []
    });

    const res = await main({ weeks: 8 });

    expect(res.success).toBe(true);
    expect(res.data.entries.dataAvailable).toBe(false);
    expect(res.data.entries.pruneReady).toBe(false);
    expect(res.data.coverage.trackingDays).toBeGreaterThan(28);
  });

  test('keepWarm 预热：没有 OPENID 也在鉴权/扫描前早退', async () => {
    const { main, checkAdmin, state } = setup({ openid: '' });

    const res = await main({ _keepWarm: true });

    expect(res.success).toBe(true);
    expect(res.data._keepWarm).toBe(true);
    expect(checkAdmin).not.toHaveBeenCalled();
    expect(state.gets).toEqual({});
  });
});
