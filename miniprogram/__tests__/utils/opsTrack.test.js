/**
 * utils/opsTrack.js 回归
 *
 * 运营埋点不能拖慢主流程，也不能因为一次上报失败就丢光队列：
 *   1. entry 只写本地队列，同一会话同一入口只记一次；
 *   2. bootstrap 同一天只报一次 session，并顺带清掉已上报的入口；
 *   3. 上报失败时保留队列、不写 session 日期，下次再试；
 *   4. flush 每次最多 12 条，剩余留给下一次。
 */
jest.mock('../../utils/logger', () => ({
  Logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

const SESSION_KEY = '_opsSessionDay';
const QUEUE_KEY = '_opsEntryQueue';

function setup() {
  jest.resetModules();
  const store = new Map();
  wx.getStorageSync = jest.fn(key => store.has(key) ? store.get(key) : '');
  wx.setStorageSync = jest.fn((key, value) => { store.set(key, value); });
  wx.removeStorageSync = jest.fn((key) => { store.delete(key); });
  wx.cloud.callFunction = jest.fn(() => Promise.resolve({ result: { success: true } }));

  return {
    opsTrack: require('../../utils/opsTrack'),
    store
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T04:00:00.000Z')); // 北京时间 10-22 12:00
});

afterEach(() => {
  jest.useRealTimers();
});

describe('opsTrack 客户端队列', () => {
  test('登记过的入口才入队；同一会话同一入口只记一次', () => {
    const { opsTrack, store } = setup();

    expect(opsTrack.entry('rank')).toBe(true);
    expect(opsTrack.entry('rank')).toBe(false);
    expect(opsTrack.entry('not_registered')).toBe(false);

    const queue = store.get(QUEUE_KEY);
    expect(queue).toHaveLength(1);
    expect(queue[0].name).toBe('rank');
  });

  test('跨天后同一入口可以再次入队（进程挂后台跨天不丢第二天）', () => {
    const { opsTrack, store } = setup();

    expect(opsTrack.entry('rank')).toBe(true);
    expect(opsTrack.entry('rank')).toBe(false);

    jest.setSystemTime(new Date('2026-10-23T04:00:00.000Z')); // 北京时间 10-23
    expect(opsTrack.entry('rank')).toBe(true);
    expect(store.get(QUEUE_KEY)).toHaveLength(2);
  });

  test('bootstrap：同一天只报一次 session，并把入口一起发出去', async () => {
    const { opsTrack, store } = setup();
    opsTrack.entry('rank');
    opsTrack.entry('campus_map');

    await opsTrack.bootstrap();

    expect(wx.cloud.callFunction).toHaveBeenCalledWith({
      name: 'trackOps',
      data: { session: true, entries: ['rank', 'campus_map'] }
    });
    expect(store.get(SESSION_KEY)).toBe('2026-10-22');
    expect(store.has(QUEUE_KEY)).toBe(false);

    // 同一天第二次启动：既没有 session 也没有队列，不应再发请求
    wx.cloud.callFunction.mockClear();
    await opsTrack.bootstrap();
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('bootstrap 失败：不写 session 日期，队列原样保留', async () => {
    const { opsTrack, store } = setup();
    opsTrack.entry('rank');
    wx.cloud.callFunction.mockResolvedValue({ result: { success: false } });

    await opsTrack.bootstrap();

    expect(store.has(SESSION_KEY)).toBe(false);
    expect(store.get(QUEUE_KEY)).toHaveLength(1);
  });

  test('flush：每次最多 12 条，剩余留给下一次', async () => {
    const { opsTrack, store } = setup();
    const queue = [];
    for (let i = 0; i < 15; i++) {
      queue.push({ name: 'rank', at: 1000 + i, id: `id-${i}` });
    }
    store.set(QUEUE_KEY, queue);

    await opsTrack.flush();

    expect(wx.cloud.callFunction).toHaveBeenCalledWith({
      name: 'trackOps',
      data: { entries: new Array(12).fill('rank') }
    });
    expect(store.get(QUEUE_KEY)).toHaveLength(3);
    expect(store.get(QUEUE_KEY).map(item => item.id)).toEqual(['id-12', 'id-13', 'id-14']);

    wx.cloud.callFunction.mockClear();
    await opsTrack.flush();
    expect(wx.cloud.callFunction).toHaveBeenCalledWith({
      name: 'trackOps',
      data: { entries: ['rank', 'rank', 'rank'] }
    });
    expect(store.has(QUEUE_KEY)).toBe(false);
  });

  test('flush 失败：队列不丢，等下次 onShow / 冷启动重试', async () => {
    const { opsTrack, store } = setup();
    opsTrack.entry('rank');
    wx.cloud.callFunction.mockRejectedValue(new Error('network down'));

    await opsTrack.flush();

    expect(store.get(QUEUE_KEY)).toHaveLength(1);
  });

  test('注册表只暴露展示需要的字段，并带中文标签', () => {
    const { opsTrack } = setup();
    const registry = opsTrack.getRegistry();

    expect(registry.length).toBeGreaterThan(5);
    expect(registry.find(item => item.name === 'campus_map')).toEqual(expect.objectContaining({
      label: '寻猫地图'
    }));
    // 返回副本：外部改注册表不能污染模块内部白名单
    registry[0].name = 'hacked';
    expect(opsTrack.getRegistry()[0].name).not.toBe('hacked');

    // 并行开发时曾出现两个 report 条目，看板会把同一入口渲染两遍
    const names = opsTrack.getRegistry().map(item => item.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
