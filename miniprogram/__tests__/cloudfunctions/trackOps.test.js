/**
 * trackOps 入口回归
 *
 * 锁住运营埋点的三条边界：
 *   1. 同一天重复启动不重复写用户文档（session 只回答「哪几天来过」）；
 *   2. 入口文档 ID = 日期 + 匿名用户 + 入口，重复上报天然幂等；
 *   3. 非法入口名被丢弃；写失败不把错误抛给用户（不能影响主流程）。
 */
jest.mock('wx-server-sdk');

function setup(options = {}) {
  jest.resetModules();
  const sdk = require('wx-server-sdk');
  sdk.getWXContext.mockReturnValue({ OPENID: options.openid === undefined ? 'o1' : options.openid });

  const state = {
    users: new Map(),
    days: new Map(),
    entries: new Map(),
    userUpdates: [],
    entryAddAttempts: 0
  };

  function collection(name) {
    return {
      doc(id) {
        return {
          get: async () => {
            if (name === 'ops_users') {
              if (!state.users.has(id)) throw new Error('document not found');
              return { data: state.users.get(id) };
            }
            if (name === 'ops_entry_usage') {
              if (!state.entries.has(id)) throw new Error('document not found');
              return { data: state.entries.get(id) };
            }
            throw new Error('document not found');
          },
          update: async ({ data }) => {
            if (name === 'ops_users') {
              const prev = state.users.get(id) || {};
              state.users.set(id, { ...prev, ...data });
              state.userUpdates.push({ id, data });
              return { stats: { updated: 1 } };
            }
            return { stats: { updated: 1 } };
          },
          set: async ({ data }) => {
            if (name === 'ops_entry_usage') {
              if (options.entriesAddError) throw new Error('collection missing');
              state.entries.set(id, { ...data });
              return {};
            }
            throw new Error(`unexpected set ${name}`);
          }
        };
      },
      add: async ({ data }) => {
        if (name === 'ops_users') {
          if (state.users.has(data._id)) throw new Error('duplicate key');
          state.users.set(data._id, { ...data });
          return { _id: data._id };
        }
        if (name === 'ops_days') {
          if (state.days.has(data._id)) throw new Error('duplicate key');
          state.days.set(data._id, { ...data });
          return { _id: data._id };
        }
        if (name === 'ops_entry_usage') {
          throw new Error('ops_entry_usage should use doc().set()');
        }
        throw new Error(`unexpected collection ${name}`);
      }
    };
  }

  sdk.database.mockReturnValue({
    collection: jest.fn(collection),
    serverDate: jest.fn(() => 'SERVER_DATE')
  });
  sdk.database().command = { inc: jest.fn(v => ({ $inc: v })) };

  return {
    main: require('../../cloudfunctions/trackOps/index').main,
    state
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T04:00:00.000Z')); // 北京时间 10-22 12:00
});

afterEach(() => {
  jest.useRealTimers();
});

describe('trackOps 入口', () => {
  test('首次进入：写用户 + 日活 + 入口，日期用服务端北京时间', async () => {
    const { main, state } = setup();

    const res = await main({
      session: true,
      entries: [{ name: 'rank', at: 1 }, { name: 'shop', at: 2 }]
    });

    expect(res.success).toBe(true);
    expect(res.data.day).toBe('2026-10-22');
    expect(res.data.sessionSaved).toBe(true);
    expect(res.data.entriesSaved).toBe(2);

    const user = [...state.users.values()][0];
    expect(user.firstSeenDay).toBe('2026-10-22');
    expect(user.lastSeenDay).toBe('2026-10-22');
    expect(user.activeDays).toBe(1);
    expect(state.days.size).toBe(1);
    expect([...state.days.keys()][0]).toMatch(/^d_2026-10-22_/);
    expect(state.entries.size).toBe(1);
    const entryDoc = [...state.entries.values()][0];
    expect(entryDoc.entries.sort()).toEqual(['rank', 'shop']);
  });

  test('同一天重复启动：不重复写用户，入口重复 add 失败也算幂等', async () => {
    const { main, state } = setup();

    await main({ session: true, entries: ['rank'] });
    const entriesAfterFirst = state.entries.size;
    const updatesAfterFirst = state.userUpdates.length;

    const second = await main({ session: true, entries: ['rank'] });

    expect(second.data.sessionSaved).toBe(false);
    expect(second.data.entriesSaved).toBe(0);
    expect(state.entries.size).toBe(entriesAfterFirst);
    expect(state.userUpdates.length).toBe(updatesAfterFirst);
  });

  test('跨天再来：lastSeenDay 更新、activeDays 自增、日活多一条', async () => {
    const { main, state } = setup();
    await main({ session: true });

    jest.setSystemTime(new Date('2026-10-23T04:00:00.000Z'));
    const res = await main({ session: true });

    expect(res.data.sessionSaved).toBe(true);
    expect(state.days.size).toBe(2);
    expect(state.userUpdates).toHaveLength(1);
    expect(state.userUpdates[0].data.lastSeenDay).toBe('2026-10-23');
    expect(state.userUpdates[0].data.activeDays).toEqual({ $inc: 1 });
  });

  test('非法入口名被丢弃：非字符串 / 大写 / 过短 / 过长 / 对象', async () => {
    const { main, state } = setup();

    const res = await main({
      entries: [
        null, 42, { name: 42 }, { name: 'OK' }, { name: 'a' },
        'rank', 'rank', 'shop', 'x'.repeat(40), 'valid_name'
      ]
    });

    expect(res.data.entriesSaved).toBe(3); // rank / shop / valid_name
    expect([...state.entries.values()][0].entries.sort())
      .toEqual(['rank', 'shop', 'valid_name']);
  });

  test('未登录直接拒绝，不写任何集合', async () => {
    const { main, state } = setup({ openid: '' });

    const res = await main({ session: true, entries: ['rank'] });

    expect(res.success).toBe(false);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(state.users.size + state.days.size + state.entries.size).toBe(0);
  });

  test('入口集合未创建：不抛错、session 仍记录，entriesSaved=0', async () => {
    const { main, state } = setup({ entriesAddError: true });

    const res = await main({ session: true, entries: ['rank', 'shop'] });

    expect(res.success).toBe(true);
    expect(res.data.sessionSaved).toBe(true);
    expect(res.data.entriesSaved).toBe(0);
    expect(state.users.size).toBe(1);
  });

  test('没有任何动作：直接返回，不写库', async () => {
    const { main, state } = setup();

    const res = await main({});

    expect(res.success).toBe(true);
    expect(res.data.sessionSaved).toBe(false);
    expect(res.data.entriesSaved).toBe(0);
    expect(state.users.size + state.days.size + state.entries.size).toBe(0);
  });
});
