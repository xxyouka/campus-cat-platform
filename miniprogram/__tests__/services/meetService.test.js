const {
  checkTodayMeetStatus,
  submitMeet,
  loadRecentMeets
} = require('../../services/meetService');

jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

jest.mock('../../utils/dateFormat', () => ({
  formatDateShort: jest.fn(d => d ? '2026-05-01' : ''),
  formatTimeAgo: jest.fn(d => d ? '3分钟前' : '')
}));

jest.mock('../../utils/obsHelper', () => ({
  EVENT_NAMES: { MEET_RECORD: 'meet_record' },
  reportEvent: jest.fn()
}));

function createMockPage(overrides = {}) {
  return {
    data: {
      catId: 'cat-1',
      hasMetToday: false,
      meetSubmitting: false,
      recentMeets: [],
      todayMeetCount: 0,
      ...overrides.data
    },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    loadRecentMeets: jest.fn(),
    ...overrides
  };
}

describe('meetService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkTodayMeetStatus', () => {
    test('should set hasMetToday true when count > 0', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, count: 2 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(page.setData).toHaveBeenCalledWith({ hasMetToday: true });
      expect(wx.setStorageSync).not.toHaveBeenCalledWith(
        'meet_today_cat-1',
        expect.anything()
      );
    });

    test('should set hasMetToday false when count is 0', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, count: 0 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(page.setData).toHaveBeenCalledWith({ hasMetToday: false });
      expect(wx.removeStorageSync).not.toHaveBeenCalledWith('meet_today_cat-1');
    });

    test('should set hasMetToday false when result success is false', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, count: 0 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(page.setData).toHaveBeenCalledWith({ hasMetToday: false });
    });

    test('should return early when catId is empty', async () => {
      const page = createMockPage({ data: { catId: '' } });
      await checkTodayMeetStatus(page);

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should handle error and set hasMetToday false', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('network error'));

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(page.setData).toHaveBeenCalledWith({ hasMetToday: false });
    });

    test('should call cloud function with correct date format', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, count: 0 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      const callArgs = wx.cloud.callFunction.mock.calls[0][0];
      expect(callArgs.name).toBe('getMyMeetCount');
      expect(callArgs.data.catId).toBe('cat-1');
      expect(callArgs.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('does not write dead meet_today_* storage when already met today', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, count: 1 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(wx.setStorageSync).not.toHaveBeenCalledWith(
        'meet_today_cat-1',
        expect.anything()
      );
    });

    test('does not remove dead meet_today_* storage when not met today', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, count: 0 }
      });

      const page = createMockPage();
      await checkTodayMeetStatus(page);

      expect(wx.removeStorageSync).not.toHaveBeenCalledWith('meet_today_cat-1');
    });
  });

  describe('submitMeet', () => {
    test('should submit meet successfully', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'recordMeet',
          data: expect.objectContaining({ catId: 'cat-1' })
        })
      );
      expect(page.setData).toHaveBeenCalledWith(expect.objectContaining({ hasMetToday: true }));
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('已记录')
        })
      );
    });

    test('should prevent double submit when meetSubmitting is true', async () => {
      const page = createMockPage({
        data: { catId: 'cat-1', meetSubmitting: true }
      });
      await submitMeet(page);

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should show error toast when result success is false', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, message: '已打卡' }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '已打卡' })
      );
    });

    test('should show default error toast when no message', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '打卡失败，请重试' })
      );
    });

    test('should handle cloud function error', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('submit error'));

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.hideLoading).toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '打卡失败，请稍后再试' })
      );
    });

    test('should reset meetSubmitting in finally', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(page.setData).toHaveBeenCalledWith({ meetSubmitting: false });
    });

    test('should reset meetSubmitting even on error', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));

      const page = createMockPage();
      await submitMeet(page);

      expect(page.setData).toHaveBeenCalledWith({ meetSubmitting: false });
    });

    test('should not write dead meet_today_* storage after successful submit (已移除)', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.setStorageSync).not.toHaveBeenCalledWith(
        'meet_today_cat-1',
        expect.anything()
      );
    });

    test('should vibrate on success', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.vibrateShort).toHaveBeenCalledWith({ type: 'light' });
    });

    test('should call loadRecentMeets after success', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(page.loadRecentMeets).toHaveBeenCalled();
    });

    test('should show loading during submission', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage();
      await submitMeet(page);

      expect(wx.showLoading).toHaveBeenCalledWith(
        expect.objectContaining({ title: '记录中…' })
      );
      expect(wx.hideLoading).toHaveBeenCalled();
    });
  });

  describe('loadRecentMeets', () => {
    test('should load recent meets and format them', async () => {
      const meets = [
        {
          _id: 'm1',
          statusTag: '😺 遇见了',
          createTime: '2026-05-01T10:00:00',
          createdAt: '2026-05-01T10:00:00'
        }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 3 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ recentMeets: expect.any(Array) })
      );
    });

    test('statusTag 无 emoji 时保持纯文本并映射图标', async () => {
      const meets = [
        {
          _id: 'm1',
          statusTag: '遇见了',
          createTime: '2026-05-01T10:00:00'
        }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 1 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      const meetsCall = page.setData.mock.calls.find(c => c[0].recentMeets);
      expect(meetsCall[0].recentMeets[0].statusTag).toBe('遇见了');
      expect(meetsCall[0].recentMeets[0].statusText).toBe('遇见了');
      // 旧版默认措辞「遇见了」语义等同「相遇了」
      expect(meetsCall[0].recentMeets[0].statusIcon).toBe('cat-happy');
    });

    test('历史数据带 emoji 前缀：原始字段保留，显示字段剥离并映射图标', async () => {
      const meets = [
        {
          _id: 'm1',
          statusTag: '😺 遇见了',
          createTime: '2026-05-01T10:00:00'
        }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 1 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      const meetsCall = page.setData.mock.calls.find(c => c[0].recentMeets);
      expect(meetsCall[0].recentMeets[0].statusTag).toBe('😺 遇见了');
      expect(meetsCall[0].recentMeets[0].statusText).toBe('遇见了');
      expect(meetsCall[0].recentMeets[0].statusIcon).toBe('cat-happy');
    });

    test('should use default statusTag when empty', async () => {
      const meets = [
        {
          _id: 'm1',
          statusTag: '',
          createTime: '2026-05-01T10:00:00'
        }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 1 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      const meetsCall = page.setData.mock.calls.find(c => c[0].recentMeets);
      expect(meetsCall[0].recentMeets[0].statusTag).toBe('相遇了');
      expect(meetsCall[0].recentMeets[0].statusText).toBe('相遇了');
      expect(meetsCall[0].recentMeets[0].statusIcon).toBe('cat-happy');
    });

    test('should set todayMeetCount from count result', async () => {
      const meets = [
        { _id: 'm1', statusTag: '😺 遇见了', createTime: '2026-05-01T10:00:00' }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 5 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      expect(page.setData).toHaveBeenCalledWith(expect.objectContaining({ todayMeetCount: 5 }));
    });

    test('两次云调用并行发起（不得串行：串行会让最近相遇晚一个往返才出现）', async () => {
      const callOrder = [];
      let resolveMeets;
      let resolveCount;
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        callOrder.push(name);
        if (name === 'getRecentMeets') {
          return new Promise(resolve => { resolveMeets = resolve; });
        }
        if (name === 'getMyMeetCount') {
          return new Promise(resolve => { resolveCount = resolve; });
        }
        return Promise.resolve({ result: { success: true } });
      });

      const page = createMockPage();
      const pending = loadRecentMeets(page);

      // 关键契约：第一个请求还在途时，第二个请求必须已经发出（并行而非串行）
      expect(callOrder).toEqual(['getRecentMeets', 'getMyMeetCount']);

      resolveMeets({ result: { success: true, meets: [] } });
      resolveCount({ result: { success: true, count: 0 } });
      await pending;
    });

    test('should return early when catId is empty', async () => {
      const page = createMockPage({ data: { catId: '' } });
      await loadRecentMeets(page);

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should handle error silently', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('load error'));

      const page = createMockPage();
      await expect(loadRecentMeets(page)).resolves.toBeUndefined();
    });

    test('should handle rejected promises in Promise.allSettled', async () => {
      wx.cloud.callFunction
        .mockRejectedValueOnce(new Error('meets error'))
        .mockRejectedValueOnce(new Error('count error'));

      const page = createMockPage();
      await loadRecentMeets(page);

      // When both calls fail, the service should still set data with empty arrays
      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ recentMeets: [], todayMeetCount: 0 })
      );
    });

    test('should handle partial failure - meets ok, count fail', async () => {
      const meets = [
        { _id: 'm1', statusTag: '😺 遇见了', createTime: '2026-05-01T10:00:00' }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockRejectedValueOnce(new Error('count error'));

      const page = createMockPage();
      await loadRecentMeets(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ recentMeets: expect.any(Array) })
      );
    });

    test('should format createTime and timeAgo', async () => {
      const { formatDateShort, formatTimeAgo } = require('../../utils/dateFormat');
      const meets = [
        { _id: 'm1', statusTag: '😺 遇见了', createTime: '2026-05-01T10:00:00' }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 1 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      expect(formatDateShort).toHaveBeenCalledWith('2026-05-01T10:00:00');
      expect(formatTimeAgo).toHaveBeenCalledWith('2026-05-01T10:00:00');
    });

    test('should use meetTime as fallback for time formatting', async () => {
      const { formatDateShort, formatTimeAgo } = require('../../utils/dateFormat');
      const meets = [
        { _id: 'm1', statusTag: '😺 遇见了', meetTime: '2026-05-01T12:00:00' }
      ];
      wx.cloud.callFunction
        .mockResolvedValueOnce({
          result: { success: true, meets }
        })
        .mockResolvedValueOnce({
          result: { success: true, count: 1 }
        });

      const page = createMockPage();
      await loadRecentMeets(page);

      expect(formatDateShort).toHaveBeenCalledWith('2026-05-01T12:00:00');
      expect(formatTimeAgo).toHaveBeenCalledWith('2026-05-01T12:00:00');
    });
  });

  // 校园地图坐标：可选字段，缺省必须走 null 而不是 undefined，
  // 否则 recordMeet 里的 sanitizePoint 行为会与「显式没选点」混淆
  describe('submitMeet · 地图坐标透传', () => {
    const lastMeetCall = () =>
      wx.cloud.callFunction.mock.calls.filter(c => c[0].name === 'recordMeet').pop()[0].data;

    test('选了点就把 u/v 带上', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const page = createMockPage({
        data: { catId: 'cat-1', meetPoint: { u: 0.42, v: 0.67, label: '图书馆' } }
      });

      await submitMeet(page);

      expect(lastMeetCall().point).toEqual({ u: 0.42, v: 0.67 });
    });

    test('label 不进 point：它只是给人看的，落库的是坐标', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const page = createMockPage({
        data: { catId: 'cat-1', meetPoint: { u: 0.42, v: 0.67, label: '图书馆' } }
      });

      await submitMeet(page);

      expect(lastMeetCall().point).not.toHaveProperty('label');
    });

    test('没选点：传 null（服务端据此保留猫原来的坐标，不清空）', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const page = createMockPage({ data: { catId: 'cat-1', meetPoint: null } });

      await submitMeet(page);

      expect(lastMeetCall().point).toBeNull();
    });

    test('meetPoint 字段整个不存在时也传 null，不传 undefined', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const page = createMockPage({ data: { catId: 'cat-1' } });

      await submitMeet(page);

      expect(lastMeetCall()).toHaveProperty('point');
      expect(lastMeetCall().point).toBeNull();
    });

    test('提交成功后清掉选点，避免下次打卡沿用上次的坐标', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const page = createMockPage({
        data: { catId: 'cat-1', meetPoint: { u: 0.42, v: 0.67 } }
      });

      await submitMeet(page);

      expect(page.data.meetPoint).toBeNull();
    });

    test('打卡失败时保留选点，用户不用重选', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '失败' } });
      const page = createMockPage({
        data: { catId: 'cat-1', meetPoint: { u: 0.42, v: 0.67 } }
      });

      await submitMeet(page);

      expect(page.data.meetPoint).toEqual({ u: 0.42, v: 0.67 });
    });
  });
});
