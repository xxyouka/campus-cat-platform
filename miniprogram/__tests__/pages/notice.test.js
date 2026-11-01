const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockDateFormat = { formatDateShort: jest.fn(v => v ? '05-06' : '') };
const mockBackToTopBehavior = {
  data: { showBackToTop: false },
  methods: {
    onPageScroll: jest.fn(),
    onBackToTop: jest.fn()
  }
};
const mockCacheBehavior = {
  data: {},
  created() { this._cacheLastLoadTime = 0; },
  methods: {
    isCacheValid: jest.fn(() => false),
    updateCacheTime: jest.fn(),
    clearCache: jest.fn(),
    loadWithCache: jest.fn(async (loadFn) => { await loadFn(); })
  }
};

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/dateFormat', () => mockDateFormat);
jest.mock('../../behaviors/backToTopBehavior', () => mockBackToTopBehavior);
jest.mock('../../behaviors/cacheBehavior', () => mockCacheBehavior);

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/notice/notice');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReturnValue('');
  wx.setStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  mockCacheBehavior.methods.loadWithCache.mockImplementation(async (loadFn) => { await loadFn(); });
  mockCacheBehavior.methods.isCacheValid.mockReturnValue(false);
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _cacheLastLoadTime: 0,
    _noticesData: [],
    _backToTopThreshold: 400,
    loadWithCache: jest.fn(async (loadFn) => { await loadFn(); }),
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

describe('notice page', () => {
  describe('onLoad', () => {
    test('sets statusBarHeight from getWindowInfo', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        statusBarHeight: 20
      }));
    });

    test('sets statusBarHeight to 0 when getWindowInfo returns undefined', () => {
      wx.getWindowInfo.mockReturnValueOnce({ statusBarHeight: undefined, windowHeight: 800, windowWidth: 375, pixelRatio: 2, screenHeight: 800, screenWidth: 375 });
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        statusBarHeight: 0
      }));
    });

    test('calls _markAsRead', () => {
      const inst = createInstance();
      const spy = jest.spyOn(inst, '_markAsRead');
      inst.onLoad();
      expect(spy).toHaveBeenCalled();
    });

    test('calls loadNotices', () => {
      const inst = createInstance();
      const spy = jest.spyOn(inst, 'loadNotices');
      inst.onLoad();
      expect(spy).toHaveBeenCalled();
    });

    test('sets custom backToTop threshold', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst._backToTopThreshold).toBe(400);
    });
  });

  describe('_markAsRead', () => {
    test('stores latestNoticeTime as lastNoticeReadTime', () => {
      wx.getStorageSync.mockReturnValue('2026-05-01T00:00:00.000Z');
      const inst = createInstance();
      inst._markAsRead();
      expect(wx.setStorageSync).toHaveBeenCalledWith('lastNoticeReadTime', '2026-05-01T00:00:00.000Z');
    });

    test('uses current ISO string when no latestNoticeTime in storage', () => {
      wx.getStorageSync.mockReturnValue('');
      const inst = createInstance();
      inst._markAsRead();
      expect(wx.setStorageSync).toHaveBeenCalledWith('lastNoticeReadTime', expect.any(String));
    });
  });

  describe('loadNotices', () => {
    test('loads notices and formats dates on success', async () => {
      const notices = [
        { _id: 'n1', title: '公告1', content: '内容1', createTime: Date.now() },
        { _id: 'n2', title: '公告2', content: '内容2', createTime: Date.now() - 86400000 }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices, hasMore: false } }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        notices: expect.arrayContaining([
          expect.objectContaining({ _id: 'n1', createTimeStr: '05-06' }),
          expect.objectContaining({ _id: 'n2', createTimeStr: '05-06' })
        ]),
        page: 1,
        hasMore: false
      }));
      expect(inst.setData).toHaveBeenCalledWith({ loading: false });
    });

    test('stores notices in _noticesData', async () => {
      const notices = [
        { _id: 'n1', title: '公告1', createTime: Date.now() }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices, hasMore: true } }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst._noticesData.length).toBe(1);
    });

    test('sets hasMore from result', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [], hasMore: true } }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ hasMore: true }));
    });

    test('defaults hasMore to false when not in result', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [] } }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ hasMore: false }));
    });

    test('handles cloud function error', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      const inst = createInstance();
      await inst.loadNotices();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(inst.setData).toHaveBeenCalledWith({ loading: false });
    });

    test('does not update data when result is not successful', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst.setData).not.toHaveBeenCalledWith(expect.objectContaining({ notices: expect.any(Array) }));
      expect(inst.setData).toHaveBeenCalledWith({ loading: false });
    });

    test('sets loading true at start', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [] } }
      });
      const inst = createInstance();
      await inst.loadNotices();
      expect(inst.setData).toHaveBeenCalledWith({ loading: true });
    });

    // seq 守卫回归：与 notifications.js:56-85 是同一条逻辑的两个副本，
    // 那边早已加、这边一直漏着。onShow 每次切回都重拉首屏，
    // 与 loadMoreNotices / onRetry 并发时，旧响应后到会覆盖新列表。
    test('并发新请求回来后，过期响应不得覆盖 notices / networkError', async () => {
      let resolveFirst;
      wx.cloud.callFunction.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { notices: [{ _id: 'newer', title: '新公告' }], hasMore: true } }
      });

      const inst = createInstance();
      const stale = inst.loadNotices();     // 第一次请求：挂在 await 上
      const fresh = inst.loadNotices();     // 递增 _listSeq，作废上面那次
      await fresh;

      // 现在放行旧响应 —— 它必须被丢弃
      resolveFirst({ result: { success: true, data: { notices: [{ _id: 'stale' }], hasMore: false } } });
      await stale;

      const noticeWrites = inst.setData.mock.calls
        .map(c => c[0])
        .filter(p => Object.prototype.hasOwnProperty.call(p, 'notices'));
      const lastWrite = noticeWrites[noticeWrites.length - 1];
      expect(lastWrite.notices.map(n => n._id)).toEqual(['newer']);
      // 过期响应也不许把 networkError 置回去
      expect(inst.setData).not.toHaveBeenCalledWith({ networkError: true });
    });

    test('过期响应不再释放 loading（避免把新请求的加载态关掉）', async () => {
      let resolveFirst;
      wx.cloud.callFunction.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

      const inst = createInstance();
      const stale = inst.loadNotices();
      const fresh = inst.loadNotices();
      await fresh;
      const callsAfterFresh = inst.setData.mock.calls.length;

      resolveFirst({ result: { success: true, data: { notices: [] } } });
      await stale;

      expect(inst.setData.mock.calls.length).toBe(callsAfterFresh);
    });
  });

  describe('loadMoreNotices', () => {
    test('returns early when already loading more', async () => {
      const inst = createInstance({ loadingMore: true });
      await inst.loadMoreNotices();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('returns early when no more data', async () => {
      const inst = createInstance({ loadingMore: false, hasMore: false });
      await inst.loadMoreNotices();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('loads next page and appends notices', async () => {
      const newNotices = [
        { _id: 'n3', title: '公告3', createTime: Date.now() }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: newNotices, hasMore: false } }
      });
      const inst = createInstance({
        loadingMore: false,
        hasMore: true,
        page: 1,
        notices: [{ _id: 'n1', title: '公告1', createTimeStr: '05-06' }]
      });
      await inst.loadMoreNotices();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ hasMore: false }));
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ loadingMore: false }));
    });

    test('handles error during load more', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      const inst = createInstance({ loadingMore: false, hasMore: true, page: 1, notices: [] });
      await inst.loadMoreNotices();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(inst.setData).toHaveBeenCalledWith({ loadingMore: false });
    });
  });

  describe('onShow', () => {
    // 首屏跳过守卫回归：onLoad 已调过 loadNotices，首次 onShow 的缓存时间戳还是 0、
    // 判定失效，于是同一份公告会被请求两遍（第一次响应被 _listSeq 作废丢弃）。
    test('首次 onShow 跳过（onLoad 已拉过，不重复请求）', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [], hasMore: false } }
      });
      const inst = createInstance();
      await inst.onShow();
      expect(inst.loadWithCache).not.toHaveBeenCalled();
    });

    test('第二次及以后的 onShow 走 loadWithCache', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [], hasMore: false } }
      });
      const inst = createInstance();
      await inst.onShow();   // 第一次：跳过
      await inst.onShow();   // 第二次：正常刷新
      expect(inst.loadWithCache).toHaveBeenCalledTimes(1);
      expect(inst.loadWithCache).toHaveBeenCalledWith(expect.any(Function), { validTime: 30000 });
    });
  });

  describe('onBack', () => {
    test('navigates back', () => {
      const inst = createInstance();
      inst.onBack();
      expect(wx.navigateBack).toHaveBeenCalledWith(expect.objectContaining({ delta: 1 }));
    });

    test('falls back to switchTab on navigateBack failure', () => {
      wx.navigateBack.mockImplementation(({ fail }) => fail());
      const inst = createInstance();
      inst.onBack();
      expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });
  });

  describe('onToggleExpand', () => {
    test('expands a collapsed section', () => {
      const inst = createInstance({ expandedIndex: -1 });
      inst.onToggleExpand({ currentTarget: { dataset: { index: 0 } } });
      expect(inst.setData).toHaveBeenCalledWith({ expandedIndex: 0 });
    });

    test('collapses an expanded section', () => {
      const inst = createInstance({ expandedIndex: 2 });
      inst.onToggleExpand({ currentTarget: { dataset: { index: 2 } } });
      expect(inst.setData).toHaveBeenCalledWith({ expandedIndex: -1 });
    });

    test('switches to different section', () => {
      const inst = createInstance({ expandedIndex: 0 });
      inst.onToggleExpand({ currentTarget: { dataset: { index: 1 } } });
      expect(inst.setData).toHaveBeenCalledWith({ expandedIndex: 1 });
    });
  });

  describe('onReachBottom', () => {
    test('calls loadMoreNotices', () => {
      const inst = createInstance();
      const spy = jest.spyOn(inst, 'loadMoreNotices');
      inst.onReachBottom();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object with title and path', () => {
      const inst = createInstance();
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/notice/notice');
    });

    test('returns one of the predefined titles', () => {
      const inst = createInstance();
      const titles = [
        '校园公告 | 了解猫咪最新动态',
        '校园猫猫小程序公告栏',
        '关注校园猫咪资讯 - 校园猫猫'
      ];
      const result = inst.onShareAppMessage();
      expect(titles).toContain(result.title);
    });

    test('有公告时带上最新一条的标题', () => {
      const inst = createInstance({
        notices: [
          { _id: '1', title: '国庆假期投喂安排' },
          { _id: '2', title: '旧公告' }
        ]
      });
      const result = inst.onShareAppMessage();
      expect(result.title).toContain('国庆假期投喂安排');
    });

    test('展开中的公告优先于最新一条', () => {
      const inst = createInstance({
        notices: [
          { _id: '1', title: '最新公告' },
          { _id: '2', title: '正在看的公告' }
        ],
        expandedIndex: 1
      });
      const result = inst.onShareAppMessage();
      expect(result.title).toContain('正在看的公告');
      expect(result.title).not.toContain('最新公告');
    });
  });

  describe('onShareTimeline', () => {
    test('returns share timeline object', () => {
      const inst = createInstance();
      const result = inst.onShareTimeline();
      expect(result).toHaveProperty('title');
      expect(result.query).toBe('');
    });

    test('朋友圈同样带上当前公告标题', () => {
      const inst = createInstance({ notices: [{ _id: '1', title: '国庆假期投喂安排' }] });
      const result = inst.onShareTimeline();
      expect(result.title).toContain('国庆假期投喂安排');
    });
  });
});
