/**
 * __tests__/pages/admin/rank-loading-lock.test.js
 *
 * 相遇/关注两个排行榜页的**在途锁**回归（FE-34）。
 *
 * 为什么这两页此前没有测试：它们结构简单，看着没什么可测的。但
 * `loadRank()` 被三个入口同时调用 —— onLoad、下拉刷新、失败态重试按钮，
 * 而它没有任何在途保护，后果有两个：
 *   1. 一次连续下拉就打多个 getMeetRank / getFavRank，重复消耗配额；
 *   2. 更难受的是 **先返回的旧响应会在后发请求还在途时把 loading 清掉**
 *      —— 列表先闪一下再变，用户会以为页面出错了。
 *
 * 这里锁住：并发调用只打一次云函数，且 loading 一定等到最后一次请求结束才清。
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn(), handleDatabaseError: jest.fn() };
const mockAvatarHelper = { resolveCatAvatars: jest.fn(list => Promise.resolve(list)) };
const mockAdminAuth = { requireAdminAuth: jest.fn(() => Promise.resolve(true)) };

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/avatarHelper', () => mockAvatarHelper);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);

const CASES = [
  { name: 'meet-rank', fn: 'getMeetRank', rel: '../../../pages/admin/meet-rank/meet-rank' },
  { name: 'fav-rank', fn: 'getFavRank', rel: '../../../pages/admin/fav-rank/fav-rank' }
];

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

describe.each(CASES)('$name · 在途锁', ({ fn, rel }) => {
  let pageDef;

  beforeAll(() => {
    global.Page = jest.fn(obj => { pageDef = obj; return obj; });
    require(rel);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
    mockAvatarHelper.resolveCatAvatars.mockImplementation(list => Promise.resolve(list || []));
    wx.cloud.callFunction.mockReset();
    wx.showToast.mockReset();
  });

  function createInstance() {
    const inst = {
      data: { ...pageDef.data },
      setData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
      safeSetData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
      callAdminFunction: (name, data) => wx.cloud.callFunction({ name, data })
    };
    for (const key of Object.keys(pageDef)) {
      if (typeof pageDef[key] === 'function' && !inst[key]) {
        inst[key] = pageDef[key].bind(inst);
      }
    }
    return inst;
  }

  test('并发调用只打一次云函数', async () => {
    const d = deferred();
    wx.cloud.callFunction.mockReturnValue(d.promise);

    const inst = createInstance();
    const p1 = inst.loadRank();
    const p2 = inst.loadRank();
    const p3 = inst.loadRank();

    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(wx.cloud.callFunction.mock.calls[0][0].name).toBe(fn);

    d.resolve({ result: { success: true, data: { list: [] } } });
    await Promise.all([p1, p2, p3]);
  });

  // 这条比「只打一次」更要紧：旧响应先回来时若把 loading 清了，
  // 界面会在请求还没结束时就撤掉骨架，随后又被新一轮内容覆盖 —— 闪一下。
  test('并发时 loading 一定保持到最后一个请求结束才清', async () => {
    const first = deferred();
    const second = deferred();
    wx.cloud.callFunction
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const inst = createInstance();
    const p1 = inst.loadRank();
    const p2 = inst.loadRank();

    expect(inst.data.loading).toBe(true);

    first.resolve({ result: { success: true, data: { list: [{ _id: 'a' }] } } });
    await p1;

    // 只有一次请求，结束就清 —— 这是预期
    expect(inst.data.loading).toBe(false);
    inst._clearAllTimers?.();
    inst._navBackTimer && clearTimeout(inst._navBackTimer);

    second.resolve({ result: { success: true, data: { list: [{ _id: 'b' }] } } });
    await p2;
  });

  test('请求结束后锁被释放，可以再次加载（下拉刷新不能被永久锁死）', async () => {
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { list: [] } } });

    const inst = createInstance();
    await inst.loadRank();
    await inst.loadRank();

    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
  });

  test('失败也会释放锁（否则失败一次后再也刷不出来）', async () => {
    wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: 'boom' } });

    const inst = createInstance();
    await inst.loadRank();
    expect(inst.data.loadFailed).toBe(true);

    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { list: [] } } });
    await inst.loadRank();
    expect(inst.data.loadFailed).toBe(false);
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
  });

  test('异常抛出同样释放锁', async () => {
    wx.cloud.callFunction.mockRejectedValue(new Error('network'));

    const inst = createInstance();
    await inst.loadRank();
    expect(inst._loadingRank).toBe(false);
    expect(inst.data.loadFailed).toBe(true);
  });
});