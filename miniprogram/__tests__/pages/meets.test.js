const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn() };
const mockDateFormat = { timeAgo: jest.fn(_v => '刚刚') };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/dateFormat', () => mockDateFormat);

const imageLoader = require('../../utils/imageLoader');

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/meets/meets');
});

beforeEach(() => {
  jest.clearAllMocks();
  // imageLoader 是模块级单例，其「fileID@尺寸档位」缓存会跨用例泄漏：
  // 前一个用例成功的换链结果会让下一个用例直接命中缓存、不再触发 wx.cloud.getTempFileURL，
  // 从而跳过被断言的失败/成功路径（jest.clearAllMocks 清不掉它）
  imageLoader.clearCache();
  wx.getStorageSync.mockReturnValue('');
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.cloud.getTempFileURL.mockReset();
  wx.cloud.getTempFileURL.mockResolvedValue({ fileList: [] });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _loadingMore: false,
    _allMeets: [],
    _skipOnce: false,
    _animateTimer: null,
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

describe('meets page', () => {
  describe('onShow', () => {
    // 原用例 'skips once when _skipOnce is true' 已删除：
    // _skipOnce 在页面里从无处置 true，该守卫分支永不进入，
    // 测它等于在测一段不可达代码，反而固化了「存在跳过首屏加载机制」的错觉。

    test('sets loading and calls loadAllData', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets: [] } }
      });
      const inst = createInstance();
      const spy = jest.spyOn(inst, 'loadAllData');
      await inst.onShow();
      expect(inst.setData).toHaveBeenCalledWith({ loading: true });
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('onPullDownRefresh', () => {
    test('calls loadAllData and stops refresh', async () => {
      wx.cloud.callFunction
        .mockResolvedValueOnce({ result: { success: true, data: { meets: [] } } })
        .mockResolvedValueOnce({ result: { success: false } });
      const inst = createInstance();
      const p = inst.onPullDownRefresh();
      await Promise.resolve();
      await Promise.resolve();
      await p;
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('loadAllData', () => {
    test('loads meets and computes calendar on success', async () => {
      const now = Date.now();
      const meets = [
        { catId: '1', catName: '橘猫', meetTime: now, catAvatar: '', location: '图书馆' },
        { catId: '2', catName: '黑猫', meetTime: now - 86400000, catAvatar: '', location: '食堂' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets } }
      });
      const inst = createInstance();
      await inst.loadAllData();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        loading: false,
        hasMore: false
      }));
      // 断言落在真实契约（data.meets）上，而不是已删除的内部字段 _allMeets
      expect(inst.data.meets.length).toBe(2);
    });

    test('handles cloud function failure', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, error: '服务器错误' }
      });
      const inst = createInstance();
      await inst.loadAllData();
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      // 记录为空时进入错误态，供 empty-state 展示重试入口
      expect(inst.setData).toHaveBeenCalledWith({ loading: false, loadError: true });
    });

    test('handles exception from cloud function', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('网络错误'));
      const inst = createInstance();
      await inst.loadAllData();
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.setData).toHaveBeenCalledWith({ loading: false, loadError: true });
    });

    test('catAvatar 原样下发（页面层不转链，交给 lazy-image）', async () => {
      const now = Date.now();
      const meets = [
        { catId: '1', catName: '橘猫', meetTime: now, catAvatar: 'cloud://test-file-id' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets } }
      });
      const inst = createInstance();
      await inst.loadAllData();
      // 页面层不再调 getTempFileURL：wxml 的 lazy-image 的 src 原生支持 cloud://，
      // 且这两处头像区只有 64/88rpx，走 avatar 档更合适（旧实现统一转成 200px 的 thumbnail）
      expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled();
    });

    test('sets hasMore true when meets exceed PAGE_SIZE', async () => {
      const meets = Array(25).fill(null).map((_, i) => ({
        catId: `cat${i}`, catName: `猫${i}`, meetTime: Date.now(), catAvatar: ''
      }));
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets, hasMore: true } }
      });
      const inst = createInstance();
      await inst.loadAllData();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ hasMore: true }));
    });

    test('sets page to 2 after initial load', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets: [] } }
      });
      const inst = createInstance();
      await inst.loadAllData();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    });
  });

  describe('_computeCalendar', () => {
    test('computes meetDays and dayDetails from meets', () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const day = now.getDate();
      const meetTime = new Date(year, month, day, 10, 0, 0).getTime();
      const meets = [
        { catId: '1', catName: '橘猫', meetTime, catAvatar: '', location: '图书馆', statusTag: '' }
      ];
      const inst = createInstance();
      inst._computeCalendar(year, month, meets);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        calendarYear: year,
        calendarMonth: month,
        meetDays: [day],
        stats: expect.objectContaining({ monthDays: 1 })
      }));
    });

    test('computes totalDays from all meets across months', () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const day1 = new Date(year, month, 5, 10, 0, 0).getTime();
      const day2 = new Date(year, month, 10, 10, 0, 0).getTime();
      const meets = [
        { catId: '1', meetTime: day1 },
        { catId: '2', meetTime: day2 }
      ];
      const inst = createInstance();
      inst._computeCalendar(year, month, meets);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({ totalDays: 2 })
      }));
    });

    test('computes streakDays for consecutive days ending today', () => {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const year = now.getFullYear();
      const month = now.getMonth();
      const todayMs = now.getTime();
      const yesterdayMs = todayMs - 86400000;
      const meets = [
        { catId: '1', meetTime: todayMs },
        { catId: '2', meetTime: yesterdayMs }
      ];
      const inst = createInstance();
      inst._computeCalendar(year, month, meets);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({ streakDays: 2 })
      }));
    });

    test('computes streakDays as 0 when today has no meet and yesterday has no meet', () => {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const year = now.getFullYear();
      const month = now.getMonth();
      const threeDaysAgo = now.getTime() - 3 * 86400000;
      const meets = [
        { catId: '1', meetTime: threeDaysAgo }
      ];
      const inst = createInstance();
      inst._computeCalendar(year, month, meets);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({ streakDays: 0 })
      }));
    });

    test('handles empty meets', () => {
      const now = new Date();
      const inst = createInstance();
      inst._computeCalendar(now.getFullYear(), now.getMonth(), []);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        meetDays: [],
        stats: { totalDays: 0, streakDays: 0, monthDays: 0 }
      }));
    });

    test('triggers stats animation', () => {
      const now = new Date();
      jest.useFakeTimers();
      const inst = createInstance();
      inst._computeCalendar(now.getFullYear(), now.getMonth(), []);
      expect(inst._animateTimer).not.toBeNull();
      jest.useRealTimers();
    });
  });

  describe('_animateStatsNumbers', () => {
    test('clears previous timer before starting', () => {
      jest.useFakeTimers();
      jest.spyOn(global, 'clearInterval');
      const inst = createInstance();
      const oldTimer = setInterval(() => {}, 99999);
      inst._animateTimer = oldTimer;
      inst._animateStatsNumbers(10, 5, 3);
      expect(clearInterval).toHaveBeenCalledWith(oldTimer);
      clearInterval(oldTimer);
      jest.useRealTimers();
    });

    test('sets final values after animation completes', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst._animateStatsNumbers(10, 5, 3);
      jest.advanceTimersByTime(800);
      expect(inst.setData).toHaveBeenCalledWith({
        statsDisplay: { totalDays: 10, streakDays: 5, monthDays: 3 }
      });
      jest.useRealTimers();
    });
  });

  describe('_buildCalendarCells', () => {
    test('builds cells with correct number of days', () => {
      const inst = createInstance();
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const cells = inst._buildCalendarCells(year, month, []);
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const dayCells = cells.filter(c => c.day > 0);
      expect(dayCells.length).toBe(daysInMonth);
    });

    test('total cells is multiple of 7', () => {
      const inst = createInstance();
      const now = new Date();
      const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), []);
      expect(cells.length % 7).toBe(0);
    });

    test('marks checked days', () => {
      const inst = createInstance();
      const now = new Date();
      const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), [5, 10]);
      const day5 = cells.find(c => c.day === 5);
      const day10 = cells.find(c => c.day === 10);
      const day15 = cells.find(c => c.day === 15);
      expect(day5.checked).toBe(true);
      expect(day10.checked).toBe(true);
      expect(day15.checked).toBe(false);
    });

    test('marks today cell', () => {
      const inst = createInstance();
      const now = new Date();
      const today = now.getDate();
      const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), []);
      const todayCell = cells.find(c => c.day === today);
      expect(todayCell.isToday).toBe(true);
    });

    test('marks future cells', () => {
      const inst = createInstance();
      const now = new Date();
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      if (now.getDate() < lastDay) {
        const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), []);
        const futureCell = cells.find(c => c.day === lastDay);
        expect(futureCell.future).toBe(true);
      }
    });
  });

  describe('onPrevMonth', () => {
    test('navigates to previous month', () => {
      const inst = createInstance({ calendarYear: 2026, calendarMonth: 4 });
      inst._allMeets = [];
      inst.onPrevMonth();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        calendarYear: 2026,
        calendarMonth: 3,
        selectedDay: 0,
        selectedDayDetails: []
      }));
    });

    test('wraps year when going from January to December', () => {
      const inst = createInstance({ calendarYear: 2026, calendarMonth: 0 });
      inst._allMeets = [];
      inst.onPrevMonth();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        calendarYear: 2025,
        calendarMonth: 11
      }));
    });

    test('does not navigate beyond 12 months ago', () => {
      const now = new Date();
      const inst = createInstance({ calendarYear: now.getFullYear() - 1, calendarMonth: now.getMonth() });
      inst._allMeets = [];
      inst.onPrevMonth();
      const setDataCalls = inst.setData.mock.calls;
      const hasMonthChange = setDataCalls.some(call =>
        call[0].calendarMonth !== undefined || call[0].calendarYear !== undefined
      );
      expect(hasMonthChange).toBe(false);
    });
  });

  describe('onNextMonth', () => {
    test('navigates to next month', () => {
      const now = new Date();
      const inst = createInstance({ calendarYear: now.getFullYear(), calendarMonth: now.getMonth() - 1 });
      inst._allMeets = [];
      inst.onNextMonth();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        selectedDay: 0,
        selectedDayDetails: []
      }));
    });

    test('wraps year when going from December to January', () => {
      const now = new Date();
      if (now.getMonth() >= 11) {
        const inst = createInstance({ calendarYear: now.getFullYear(), calendarMonth: 10 });
        inst._allMeets = [];
        inst.onNextMonth();
        expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
          calendarMonth: 11
        }));
      }
    });

    test('does not navigate beyond next month', () => {
      const now = new Date();
      const inst = createInstance({ calendarYear: now.getFullYear(), calendarMonth: now.getMonth() + 1 });
      inst._allMeets = [];
      inst.onNextMonth();
      const setDataCalls = inst.setData.mock.calls;
      const hasMonthChange = setDataCalls.some(call =>
        call[0].calendarMonth !== undefined || call[0].calendarYear !== undefined
      );
      expect(hasMonthChange).toBe(false);
    });
  });

  describe('onTapCell', () => {
    test('selects a checked day', () => {
      const inst = createInstance({ selectedDay: 0, dayDetails: { 5: [{ catId: '1', catName: '橘猫' }] }, meetDays: [5] });
      inst.onTapCell({ currentTarget: { dataset: { day: 5, checked: true, future: false } } });
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        selectedDay: 5,
        selectedDayDetails: [{ catId: '1', catName: '橘猫' }]
      }));
    });

    test('deselects when tapping the same day', () => {
      const inst = createInstance({ selectedDay: 5, dayDetails: { 5: [{ catId: '1' }] }, meetDays: [5] });
      inst.onTapCell({ currentTarget: { dataset: { day: 5, checked: true, future: false } } });
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        selectedDay: 0,
        selectedDayDetails: []
      }));
    });

    test('ignores day 0', () => {
      const inst = createInstance({ selectedDay: 0 });
      inst.onTapCell({ currentTarget: { dataset: { day: 0, checked: false, future: false } } });
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('ignores unchecked day', () => {
      const inst = createInstance({ selectedDay: 0 });
      inst.onTapCell({ currentTarget: { dataset: { day: 5, checked: false, future: false } } });
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('ignores future day', () => {
      const inst = createInstance({ selectedDay: 0 });
      inst.onTapCell({ currentTarget: { dataset: { day: 5, checked: true, future: true } } });
      expect(inst.setData).not.toHaveBeenCalled();
    });
  });

  describe('onCloseDayDetail', () => {
    test('clears selected day and details', () => {
      const inst = createInstance({ selectedDay: 5, selectedDayDetails: [{ catId: '1' }], meetDays: [5] });
      inst.onCloseDayDetail();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        selectedDay: 0,
        selectedDayDetails: []
      }));
    });
  });

  describe('loadMoreMeets', () => {
    test('returns early when no more data', async () => {
      const inst = createInstance({ hasMore: false });
      await inst.loadMoreMeets();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('returns early when already loading', async () => {
      const inst = createInstance({ hasMore: true });
      inst._loadingMore = true;
      await inst.loadMoreMeets();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('loads more meets and appends to list', async () => {
      const newMeets = [
        { catId: '3', catName: '白猫', meetTime: Date.now(), catAvatar: '' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets: newMeets, hasMore: false } }
      });
      const inst = createInstance({ hasMore: true, page: 2, meetsWithAnim: [] });
      inst._loadingMore = false;
      await inst.loadMoreMeets();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        hasMore: false,
        page: 3
      }));
    });

    test('handles failure gracefully', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      const inst = createInstance({ hasMore: true, page: 2, meetsWithAnim: [] });
      inst._loadingMore = false;
      await inst.loadMoreMeets();
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(inst._loadingMore).toBe(false);
    });

    test('returns early when result is not successful', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });
      const inst = createInstance({ hasMore: true, page: 2, meetsWithAnim: [] });
      inst._loadingMore = false;
      await inst.loadMoreMeets();
      expect(inst._loadingMore).toBe(false);
    });
  });

  describe('onGoToDetail', () => {
    test('navigates to detail page with catId', () => {
      const inst = createInstance();
      inst.onGoToDetail({ currentTarget: { dataset: { catId: 'abc123' } } });
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/detail/detail?id=abc123' });
    });

    test('does nothing without catId', () => {
      const inst = createInstance();
      inst.onGoToDetail({ currentTarget: { dataset: {} } });
      expect(wx.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('onGoHome', () => {
    test('switches to index tab', () => {
      const inst = createInstance();
      inst.onGoHome();
      expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });
  });

  // _resolveCatAvatars 已删除：本页两处头像区都用 lazy-image 渲染，其 src 原生支持
  // cloud://（内部按 type 转链），所以页面层再统一 getTempUrls 一遍纯属重复劳动，
  // 还让首屏多付一个完整往返。原先那批用例随方法一并移除。

  describe('loadAllData 头像口径', () => {
    test('catAvatar 保持 cloud:// 下发（由 lazy-image 自行转链）', async () => {
      const now = Date.now();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            meets: [{ catId: '1', catName: '橘猫', meetTime: now, catAvatar: 'cloud://file1' }],
            hasMore: false
          }
        }
      });
      const inst = createInstance();
      await inst.loadAllData();

      const listCall = inst.setData.mock.calls.find(c => Array.isArray(c[0].meets));
      expect(listCall[0].meets[0].catAvatar).toBe('cloud://file1');
      // 页面层不应再发起任何转链
      expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled();
    });

    test('15s 窗口内重复进入不发请求', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { meets: [], hasMore: false } }
      });
      const inst = createInstance();
      await inst.loadAllData();
      const callsAfterFirst = wx.cloud.callFunction.mock.calls.length;
      await inst.loadAllData();
      expect(wx.cloud.callFunction.mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe('_tryLoadCalendarFromCloud', () => {
    test('updates calendar from cloud data on success', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            meetDays: [1, 5],
            dayDetails: { 1: [{ catId: '1' }], 5: [{ catId: '2' }] },
            totalDays: 10,
            streakDays: 3,
            monthDays: 2
          }
        }
      });
      const inst = createInstance();
      // 页面调用前会先把年月写进 data（标题同步切换），响应到达时按 data 校验新鲜度
      inst.setData({ calendarYear: 2026, calendarMonth: 4 });
      await inst._tryLoadCalendarFromCloud(2026, 4);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        meetDays: [1, 5],
        stats: { totalDays: 10, streakDays: 3, monthDays: 2 }
      }));
    });

    test('resets to empty month grid when cloud result is not successful', async () => {
      // 失败时月份标题已切换，网格必须重建为空月，避免标题与格子错位
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });
      const inst = createInstance();
      inst.setData({ calendarYear: 2026, calendarMonth: 4 });
      await inst._tryLoadCalendarFromCloud(2026, 4);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        meetDays: [],
        dayDetails: {},
        calendarCells: expect.any(Array)
      }));
    });

    test('discards stale response after the user switched to another month', async () => {
      // 连点翻月：旧月份的响应后到，不能覆盖当前月份的格子/统计
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: { meetDays: [1], dayDetails: {}, totalDays: 1, streakDays: 1, monthDays: 1 }
        }
      });
      const inst = createInstance();
      // 标题已切到 2026-04，此时返回的是 2026-05 的响应
      inst.setData({ calendarYear: 2026, calendarMonth: 4 });
      await inst._tryLoadCalendarFromCloud(2026, 5);
      expect(inst.setData).not.toHaveBeenCalledWith(expect.objectContaining({
        meetDays: [1]
      }));
    });

    test('discards older request when a newer one has been issued', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: { meetDays: [1], dayDetails: {}, totalDays: 1, streakDays: 1, monthDays: 1 }
        }
      });
      const inst = createInstance();
      inst.setData({ calendarYear: 2026, calendarMonth: 4 });
      // 两次请求都针对 2026-04，但第二个请求更新，第一个的响应必须作废
      const first = inst._tryLoadCalendarFromCloud(2026, 4);
      const second = inst._tryLoadCalendarFromCloud(2026, 4);
      await first;
      await second;
      const meetDaysCalls = inst.setData.mock.calls.filter(c => c[0].meetDays);
      expect(meetDaysCalls).toHaveLength(1);
    });

    test('handles error gracefully', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      const inst = createInstance();
      inst.setData({ calendarYear: 2026, calendarMonth: 4 });
      await inst._tryLoadCalendarFromCloud(2026, 4);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
