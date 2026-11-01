/**
 * __tests__/utils/tabBadge.test.js
 *
 * 未读红点是「提示」不是「数据源」：只读本地缓存 + 原生 tabBar API，任何一步失败
 * 都不能影响页面。这里钉住四条口径：
 *   1. 1~99 显示数字，>99 显示 99+；
 *   2. 0 必须 remove（否则会留着上一次的数字）；
 *   3. 冷启动按缓存恢复，不触发网络；
 *   4. 存储 / API 抛错时静默降级。
 */
const TabBadge = require('../../utils/tabBadge');

describe('utils/tabBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wx.getStorageSync.mockReturnValue('');
    wx.setStorageSync.mockImplementation(() => {});
    wx.setTabBarBadge.mockImplementation(() => {});
    wx.removeTabBarBadge.mockImplementation(() => {});
  });

  test('sync 写入缓存并显示数字', () => {
    // 索引不能写漂：TAB_INDEX 必须正好是 app.json 里的「我的」
    const appJson = require('../../app.json');
    expect(appJson.tabBar.list[TabBadge.TAB_INDEX].pagePath).toBe('pages/profile/profile');

    expect(TabBadge.sync(5)).toBe(5);
    expect(wx.setStorageSync).toHaveBeenCalledWith(TabBadge.STORAGE_KEY, 5);
    expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({
      index: TabBadge.TAB_INDEX,
      text: '5'
    }));
    expect(wx.removeTabBarBadge).not.toHaveBeenCalled();
  });

  test('超过 99 显示 99+（tabBar 文本上限）', () => {
    TabBadge.sync(120);
    expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({ text: '99+' }));
  });

  test('0 必须显式 remove，不能留下旧数字', () => {
    TabBadge.sync(0);
    expect(wx.setStorageSync).toHaveBeenCalledWith(TabBadge.STORAGE_KEY, 0);
    expect(wx.removeTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({
      index: TabBadge.TAB_INDEX
    }));
    expect(wx.setTabBarBadge).not.toHaveBeenCalled();
  });

  test('clear 清空缓存并移除红点', () => {
    TabBadge.sync(4);
    TabBadge.clear();
    expect(wx.setStorageSync).toHaveBeenLastCalledWith(TabBadge.STORAGE_KEY, 0);
    expect(wx.removeTabBarBadge).toHaveBeenCalled();
  });

  test('负数 / 非数字统一按 0 处理', () => {
    expect(TabBadge.sync(-3)).toBe(0);
    expect(TabBadge.sync('abc')).toBe(0);
    expect(TabBadge.sync(null)).toBe(0);
    expect(wx.removeTabBarBadge).toHaveBeenCalledTimes(3);
  });

  test('冷启动 refreshFromCache 只读缓存，不发网络', () => {
    wx.getStorageSync.mockReturnValue(3);
    TabBadge.refreshFromCache();
    expect(wx.getStorageSync).toHaveBeenCalledWith(TabBadge.STORAGE_KEY);
    expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({ text: '3' }));
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('缓存为空时清除红点', () => {
    wx.getStorageSync.mockReturnValue('');
    TabBadge.refreshFromCache();
    expect(wx.removeTabBarBadge).toHaveBeenCalled();
  });

  test('存储抛错不阻断（按 0 处理）', () => {
    wx.getStorageSync.mockImplementation(() => { throw new Error('storage broken'); });
    expect(() => TabBadge.refreshFromCache()).not.toThrow();
    expect(wx.removeTabBarBadge).toHaveBeenCalled();
  });

  test('tabBar API 抛错不阻断业务', () => {
    wx.setTabBarBadge.mockImplementation(() => { throw new Error('tabBar not ready'); });
    expect(() => TabBadge.sync(2)).not.toThrow();
    // 缓存仍要写入：下次启动还有机会恢复
    expect(wx.setStorageSync).toHaveBeenCalledWith(TabBadge.STORAGE_KEY, 2);
  });
});
