/**
 * __tests__/pages/notifications.test.js
 * 消息中心页面：加载/分页/已读标记/全部已读
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), swallow: jest.fn() };
jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../behaviors/safeSetDataBehavior', () => ({}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/notifications/notifications');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({
    result: { success: true, data: { notifications: [], hasMore: false, unreadCount: 0 } }
  });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
    safeSetData: jest.fn(function(updates) { Object.assign(this.data, updates); })
  };
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('notifications 页面', () => {
  test('返回时发现新动态只显示提示，保留多页列表与分页状态', async () => {
    const old = [{ _id: 'n1' }, { _id: 'n2' }];
    const inst = createInstance({ notifications: old, page: 2, hasMore: false });
    inst._hasLoaded = true;
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { notifications: [{ _id: 'new' }, old[0]] } } });
    inst.onShow();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(inst.data.notifications).toEqual(old);
    expect(inst.data.page).toBe(2);
    expect(inst.data.hasMore).toBe(false);
    expect(inst.data.loading).toBe(false);
    expect(inst.data.hasNewUpdates).toBe(true);
  });

  test('后台检查失败时保留阅读内容，不弹失败提示', async () => {
    const inst = createInstance({ notifications: [{ _id: 'n1' }], page: 3 });
    wx.cloud.callFunction.mockRejectedValue(new Error('network'));
    await inst.checkUpdates();
    expect(inst.data.page).toBe(3);
    expect(inst.data.loadError).toBe(false);
    expect(wx.showToast).not.toHaveBeenCalled();
  });

  test('onLoad 清零未读数（进入即读，红点随之消失）', () => {
    const inst = createInstance();
    inst.safeSetData({ unreadCount: 5 });
    inst.onLoad();
    expect(inst.data.unreadCount).toBe(0);
  });

  test('refresh 加载消息并装饰类型', async () => {
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: {
        notifications: [
          { _id: 'n1', type: 'cat_lost', content: '「小橘」走失了', catName: '小橘', createTime: Date.now() - 3600000 }
        ],
        hasMore: false,
        unreadCount: 1
      } }
    });
    const inst = createInstance();
    await inst.refresh();
    expect(inst.data.notifications).toHaveLength(1);
    expect(inst.data.notifications[0].typeLabel).toContain('走失');
    expect(inst.data.unreadCount).toBe(1);
    expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({ text: '1' }));
  });

  test('loadMore 追加下一页', async () => {
    const inst = createInstance({ page: 1, hasMore: true, notifications: [] });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: {
        notifications: [{ _id: 'n2', type: 'cat_meet', content: 'x' }],
        hasMore: false,
        unreadCount: 0
      } }
    });
    await inst.loadMore();
    expect(inst.data.page).toBe(2);
    expect(inst.data.notifications).toHaveLength(1);
  });

  test('loadMore 在 hasMore=false 时直接返回', async () => {
    const inst = createInstance({ hasMore: false });
    await inst.loadMore();
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('onReachBottom 必须触达 loadMore（第二页的唯一入口）', () => {
    const inst = createInstance({ page: 1, hasMore: true, notifications: [] });
    const spy = jest.spyOn(inst, 'loadMore').mockResolvedValue();
    inst.onReachBottom();
    expect(spy).toHaveBeenCalled();
  });

  test('点击未读消息标记已读并跳转详情', async () => {
    const inst = createInstance({
      notifications: [{ _id: 'n1', catId: 'c1', isRead: false }],
      unreadCount: 2
    });
    inst.onTapNotification({ currentTarget: { dataset: { id: 'n1', catId: 'c1', read: false } } });
    expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
      name: 'markNotificationRead',
      data: { notificationId: 'n1' }
    }));
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/detail/detail?id=c1' });
    expect(inst.data.unreadCount).toBe(1);
    expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({ text: '1' }));
  });

  test('点击已读消息不重复标记', async () => {
    const inst = createInstance({ notifications: [{ _id: 'n1', catId: 'c1', isRead: true }] });
    inst.onTapNotification({ currentTarget: { dataset: { id: 'n1', catId: 'c1', read: true } } });
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    expect(wx.navigateTo).toHaveBeenCalled();
  });

  test('onMarkAllRead 全部标记已读', async () => {
    const inst = createInstance({
      notifications: [{ _id: 'n1', isRead: false }, { _id: 'n2', isRead: false }],
      unreadCount: 2
    });
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { updatedCount: 2 } } });
    await inst.onMarkAllRead();
    expect(inst.data.unreadCount).toBe(0);
    expect(inst.data.notifications.every(n => n.isRead)).toBe(true);
    expect(wx.removeTabBarBadge).toHaveBeenCalled();
  });

  test('_formatTime 相对时间', () => {
    const inst = createInstance();
    const now = Date.now();
    expect(inst._formatTime(now - 30000)).toBe('刚刚');
    // 全项目相对时间口径一致：数字与单位之间不留空格（见 utils/dateFormat.js、getDonations 等）
    expect(inst._formatTime(now - 5 * 60000)).toBe('5分钟前');
    expect(inst._formatTime(now - 3 * 3600000)).toBe('3小时前');
    expect(inst._formatTime(null)).toBe('');
  });
});
