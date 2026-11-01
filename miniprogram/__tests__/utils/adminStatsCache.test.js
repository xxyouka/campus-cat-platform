/**
 * __tests__/utils/adminStatsCache.test.js
 *
 * 管理端统计快照（SWR 本地缓存）。背景：管理后台首屏曾要等「云端鉴权 → 统计」
 * 两个串行云函数（页面切换均值 3758ms），现在先用快照出内容、再后台刷新。
 * 这里覆盖三条不能退化的性质：
 *   1. 缓存坏了就当没有 —— 任何异常都不得冒泡打断页面渲染；
 *   2. 跨天快照的「更新于」必须带日期，否则昨天的数字会被读成「刚更新」；
 *   3. 写失败只是少一次加速，不算错误。
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));

const {
  STATS_CACHE_KEY,
  formatStatsTime,
  readStatsCache,
  saveStatsCache,
  clearStatsCache
} = require('../../pages/admin/utils/adminStatsCache');

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReset();
  wx.setStorageSync.mockReset();
  wx.removeStorageSync.mockReset();
});

describe('formatStatsTime', () => {
  test('同一天只给 HH:mm', () => {
    expect(formatStatsTime(Date.now())).toMatch(/^\d{2}:\d{2}$/);
  });

  test('跨天带 MM-DD 前缀（不让昨天的数字看起来像刚更新）', () => {
    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    expect(formatStatsTime(yesterday)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('readStatsCache', () => {
  test('返回已写入的快照', () => {
    const cache = { stats: { totalCats: 92 }, updateTime: '21:11', savedAt: 1750000000000 };
    wx.getStorageSync.mockReturnValue(cache);
    expect(readStatsCache()).toBe(cache);
    expect(wx.getStorageSync).toHaveBeenCalledWith(STATS_CACHE_KEY);
  });

  test.each([
    ['空串（从未写入）', ''],
    ['null', null],
    ['垃圾字符串', 'garbage'],
    ['缺 stats 字段', { updateTime: '21:11' }]
  ])('%s 一律按无缓存处理', (_label, value) => {
    wx.getStorageSync.mockReturnValue(value);
    expect(readStatsCache()).toBeNull();
  });

  test('存储层抛错时不冒泡（缓存不是数据源）', () => {
    wx.getStorageSync.mockImplementation(() => { throw new Error('storage broken'); });
    expect(readStatsCache()).toBeNull();
  });
});

describe('saveStatsCache', () => {
  test('写入 stats / updateTime / savedAt', () => {
    saveStatsCache({ totalCats: 92 }, '21:11');
    expect(wx.setStorageSync).toHaveBeenCalledWith(STATS_CACHE_KEY, {
      stats: { totalCats: 92 },
      updateTime: '21:11',
      savedAt: expect.any(Number)
    });
  });

  test('写失败只记日志，不抛错', () => {
    wx.setStorageSync.mockImplementation(() => { throw new Error('quota exceeded'); });
    expect(() => saveStatsCache({ totalCats: 1 }, '00:00')).not.toThrow();
    expect(mockLogger.debug).toHaveBeenCalled();
  });
});

describe('clearStatsCache', () => {
  test('清掉快照键', () => {
    clearStatsCache();
    expect(wx.removeStorageSync).toHaveBeenCalledWith(STATS_CACHE_KEY);
  });

  test('清理失败不抛错', () => {
    wx.removeStorageSync.mockImplementation(() => { throw new Error('boom'); });
    expect(() => clearStatsCache()).not.toThrow();
  });
});
