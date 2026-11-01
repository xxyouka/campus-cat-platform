const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), swallow: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), handleGlobalError: jest.fn(), handleUnhandledRejection: jest.fn(), initGlobalErrorCatch: jest.fn() };
const mockNetwork = { checkNetwork: jest.fn(() => true), getNetworkManager: jest.fn() };
const mockPageState = { getPageStateManager: jest.fn(() => ({ checkNeedRefresh: jest.fn(() => null) })) };
const mockPerfMonitor = { monitorPageLoad: jest.fn((_, fn) => fn()), monitorApi: jest.fn((_, fn) => fn()) };
const mockObsHelper = {
  isAvailable: jest.fn(),
  trySetup: jest.fn(),
  reportEvent: jest.fn(),
  EVENT_NAMES: {
    GUIDANCE_RELEASE_VIEW: 'guidance_release_view',
    GUIDANCE_RELEASE_CLICK: 'guidance_release_click',
    GUIDE_TOUR_VIEW: 'guide_tour_view',
    GUIDE_TOUR_STEP: 'guide_tour_step',
    GUIDE_TOUR_SKIP: 'guide_tour_skip',
    GUIDE_TOUR_COMPLETE: 'guide_tour_complete',
    COACH_VIEW: 'coach_view',
    COACH_SKIP: 'coach_skip'
  }
};
const mockImageLoader = { preloadAboveFold: jest.fn(), preloadBelowFold: jest.fn() };
const mockImageRetryManager = { handleError: jest.fn(), cleanup: jest.fn() };
const mockSearchEngine = jest.fn(() => ({ buildIndex: jest.fn(), search: jest.fn(() => []), clear: jest.fn() }));
mockSearchEngine.highlightSegments = jest.fn((text, _kw) => text);
const mockFilterService = { loadCatsByCampus: jest.fn(), filterFromServer: jest.fn(), loadAllAndFilter: jest.fn() };
const mockCatService = { loadCats: jest.fn(), loadMoreCats: jest.fn(), refreshSingleCat: jest.fn(), preloadNextPage: jest.fn() };
const mockImageService = { resolveAvatarsAsync: jest.fn(), preloadFirstScreen: jest.fn(), onImageLoad: jest.fn(), onImageError: jest.fn() };
const mockGuidance = {
  hasCompletedOnboarding: jest.fn(() => false),
  getPendingRelease: jest.fn(() => null),
  markReleaseSeen: jest.fn(),
  getTourForPage: jest.fn(() => null)
};
const ShareHelper = require('../../utils/shareHelper');

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/network', () => mockNetwork);
jest.mock('../../utils/pageState', () => mockPageState);
jest.mock('../../utils/performanceMonitor', () => mockPerfMonitor);
jest.mock('../../utils/obsHelper', () => mockObsHelper);
jest.mock('../../utils/imageLoader', () => mockImageLoader);
jest.mock('../../utils/imageRetryManager', () => mockImageRetryManager);
jest.mock('../../utils/searchEngine', () => mockSearchEngine);
jest.mock('../../utils/filterService', () => mockFilterService);
jest.mock('../../utils/guidance', () => mockGuidance);
jest.mock('../../services/catService', () => mockCatService);
jest.mock('../../services/imageService', () => mockImageService);
jest.mock('../../behaviors/cacheBehavior', () => ({}));
jest.mock('../../behaviors/backToTopBehavior', () => ({}));
jest.mock('../../behaviors/agreementBehavior', () => ({}));
jest.mock('../../behaviors/networkBehavior', () => ({}));

const config = require('../../config');

let pageDef;
const createdInstances = [];

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/index/index');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReturnValue('');
  wx.setStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { notices: [] } } });
  wx.showTabBarRedDot = jest.fn();
  wx.hideTabBarRedDot = jest.fn();
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.keys(updates).forEach(key => {
        const parts = key.split('.');
        if (parts.length === 2) {
          const current = this.data[parts[0]] || {};
          this.data[parts[0]] = { ...current, [parts[1]]: updates[key] };
        } else {
          this.data[key] = updates[key];
        }
      });
    }),
    _searchEngine: { buildIndex: jest.fn(), search: jest.fn(() => []), clear: jest.fn() },
    _prefetchTimers: {},
    _loadingCats: false,
    _loadingMoreCats: false,
    _loadingAll: false,
    _retryQueue: null,
    _baseHasMore: null,
    _photoCountsMap: null,
    _retryingCatIds: null,
    _searchTimer: null,
    _autoRetryTimer: null,
    _networkRecoveryTimer: null,
    _skeletonFrameId: null,
    _networkUnsubscribe: null,
    _releaseTimer: null,
    _releaseScheduled: false,
    _releaseShown: false,
    _isUnmounted: false,
    initGuideTour: jest.fn(),
    scheduleGuideTour: jest.fn(),
    pauseGuideTour: jest.fn(),
    destroyGuideTour: jest.fn(),
    checkAgreement: jest.fn(),
    _initNetworkListener: jest.fn(),
    _preloadFirstScreen: jest.fn(),
    clearCache: jest.fn(),
    loadWithCache: jest.fn((cb) => cb()),
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  createdInstances.push(inst);
  return inst;
}

describe('index page', () => {
  afterEach(() => {
    createdInstances.forEach(inst => {
      if (inst._releaseTimer) clearTimeout(inst._releaseTimer);
    });
    createdInstances.length = 0;
  });
  describe('onLoad', () => {
    test('sets statusBarHeight and initializes search engine', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ statusBarHeight: expect.any(Number) }));
      expect(inst.checkAgreement).toHaveBeenCalled();
      expect(inst._initNetworkListener).toHaveBeenCalled();
    });

    test('loads cats when network is available', () => {
      mockNetwork.checkNetwork.mockReturnValue(true);
      const inst = createInstance();
      inst.onLoad();
      expect(mockCatService.loadCats).toHaveBeenCalled();
    });

    test('sets network error when network unavailable', () => {
      mockNetwork.checkNetwork.mockReturnValue(false);
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ loading: false, showSkeleton: false, networkError: true }));
    });

    test('calls checkNewNotice and _preloadFirstScreen', () => {
      mockNetwork.checkNetwork.mockReturnValue(true);
      const inst = createInstance();
      inst.onLoad();
      expect(inst.checkNewNotice).toBeDefined();
      expect(inst._preloadFirstScreen).toHaveBeenCalled();
    });
  });

  describe('onShow', () => {
    test('checks new notice and unread notifications', () => {
      const inst = createInstance({ loading: false, showSkeleton: false, cats: [{ _id: '1' }] });
      inst.onShow();
      expect(mockPageState.getPageStateManager).toHaveBeenCalled();
    });

    test('refreshes via catService when refreshData has catId and action update', () => {
      const refreshData = { catId: 'abc123', action: 'update' };
      mockPageState.getPageStateManager.mockReturnValue({ checkNeedRefresh: jest.fn(() => refreshData) });
      const inst = createInstance({ loading: false, showSkeleton: false, cats: [{ _id: '1' }] });
      inst.onShow();
      expect(mockCatService.refreshSingleCat).toHaveBeenCalledWith('abc123', inst);
    });

    test('refreshes via FilterService when campusFilter is set', () => {
      const refreshData = { catId: 'abc123', action: 'update' };
      mockPageState.getPageStateManager.mockReturnValue({ checkNeedRefresh: jest.fn(() => refreshData) });
      const inst = createInstance({ loading: false, showSkeleton: false, cats: [{ _id: '1' }], campusFilter: '本部' });
      inst.onShow();
      expect(mockFilterService.loadCatsByCampus).toHaveBeenCalledWith('本部', inst);
    });

    test('skips refresh when loading', () => {
      const inst = createInstance({ loading: true, showSkeleton: true });
      inst._loadingCats = true;
      inst.onShow();
      expect(mockCatService.loadCats).not.toHaveBeenCalled();
    });
  });

  describe('filterCats', () => {
    test('resets to all cats when no filters active', () => {
      const inst = createInstance({ cats: [{ _id: '1' }, { _id: '2' }], searchKeyword: '', genderFilter: '', colorFilter: '', ageFilter: '', campusFilter: '' });
      inst.filterCats();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        filteredCats: inst.data.cats,
        hasSearched: false,
        activeFilterCount: 0,
        filteredCatCount: 2
      }));
    });

    test('calls _filterCatsFromServer when filters are active', async () => {
      const inst = createInstance({ cats: [{ _id: '1' }], searchKeyword: '橘', genderFilter: '', colorFilter: '', ageFilter: '', campusFilter: '' });
      mockFilterService.filterFromServer.mockResolvedValue({ success: true, cats: [{ _id: '1', name: '橘猫' }], total: 1 });
      inst.filterCats();
      await Promise.resolve();
      expect(mockFilterService.filterFromServer).toHaveBeenCalled();
    });

    test('falls back to client filter when server filter fails', async () => {
      const inst = createInstance({ cats: [{ _id: '1', name: '橘猫' }], searchKeyword: '橘', genderFilter: '', colorFilter: '', ageFilter: '', campusFilter: '' });
      mockFilterService.filterFromServer.mockRejectedValue(new Error('fail'));
      inst.filterCats();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFiltering: false }));
    });
  });

  describe('onSearchInput', () => {
    test('clears campusFilter and routes through debounced search when keyword and campusFilter both set', async () => {
      jest.useFakeTimers();
      const inst = createInstance({ campusFilter: '本部', searchKeyword: '' });
      inst.onSearchInput({ detail: { value: '橘猫' } });

      // 清校区后必须走防抖分支（与普通输入同口径）。
      // 原实现在这里直接 loadCats() 并 return：① 非 silent → 整页骨架屏闪一帧；
      // ② 不挂防抖定时器，本次输入只靠 loadCats 内部 hasActiveFilter 分支补跑
      //    filterCats 才进入 filtering，_loadingCats 守卫吞掉时需再输入一次。
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ campusFilter: '' }));
      expect(mockCatService.loadCats).not.toHaveBeenCalled();

      const spy = jest.fn();
      inst.filterCats = spy;
      jest.advanceTimersByTime(400); // config.performance.searchDebounceDelay = 300
      expect(spy).toHaveBeenCalled();
      expect(mockCatService.loadCats).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('calls filterCats immediately when keyword is empty', () => {
      const inst = createInstance({ searchKeyword: 'old', cats: [] });
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onSearchInput({ detail: { value: '' } });
      expect(spy).toHaveBeenCalled();
    });

    test('debounces filterCats when keyword is present', () => {
      jest.useFakeTimers();
      const inst = createInstance({ searchKeyword: '', campusFilter: '' });
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onSearchInput({ detail: { value: '橘' } });
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(config.performance.searchDebounceDelay);
      expect(spy).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('filterCats 请求序号：连续变更筛选时丢弃过期响应', () => {
    test('筛选A在途时再发起筛选B：A 的慢响应回来不覆盖 B 的结果', async () => {
      // 这是 _filterSeq 唯一的自有用武之地：作废不是由 clearSearch/onResetFilter/下拉刷新
      // 发起的，而是由「后发起的筛选」自己作废前一次筛选。
      const pending = [];
      mockFilterService.filterFromServer
        .mockImplementationOnce(() => new Promise(resolve => pending.push(resolve)))
        .mockImplementationOnce(() => new Promise(resolve => pending.push(resolve)));

      const inst = createInstance({ filteredCats: [], colorFilter: '橘色' });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });

      inst.filterCats();                    // 筛选 A（橘色）在途
      inst.data.colorFilter = '白色';
      inst.filterCats();                    // 筛选 B（白色）在途 —— 作废 A
      expect(pending).toHaveLength(2);

      pending[1]({ success: true, cats: [{ _id: 'b' }], total: 1 });  // B 先回
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['b']);

      pending[0]({ success: true, cats: [{ _id: 'a' }], total: 1 });  // A 后回（慢）
      await new Promise(resolve => setTimeout(resolve, 0));

      // 删掉 filterCats 里的 _filterSeq 自增后，A 的旧结果会把 B 覆盖掉 → 此处变红
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['b']);
      expect(inst.data.filteredCatCount).toBe(1);
    });
  });

  describe('clearSearch', () => {
    test('只清搜索词，保留花色等已选条件并重新筛选', () => {
      const inst = createInstance({ searchKeyword: '橘', colorFilter: '橘白' });
      inst.filterCats = jest.fn();
      inst.clearSearch();
      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.colorFilter).toBe('橘白');
      expect(inst.filterCats).toHaveBeenCalledTimes(1);
    });

    test('空结果的清除条件入口同时清校区和搜索，作废旧请求', () => {
      const inst = createInstance({ cats: [{ _id: '1' }], campusFilter: '东区', colorFilter: '橘白', searchKeyword: '橘', hasSearched: true });
      const seq = inst._filterSeq || 0;
      inst.onClearAllConditions();
      expect(inst.data).toEqual(expect.objectContaining({ campusFilter: '', colorFilter: '', searchKeyword: '', hasSearched: false, filteredCats: [{ _id: '1' }] }));
      expect(inst._filterSeq).toBeGreaterThan(seq);
    });

    test('clears search keyword and resets filteredCats', () => {
      const inst = createInstance({ cats: [{ _id: '1' }], searchKeyword: '橘', filteredCats: [], hasSearched: true, filteredCatCount: 0 });
      inst.clearSearch();
      expect(inst.data).toEqual(expect.objectContaining({
        searchKeyword: '',
        hasSearched: false,
        filteredCatCount: 1
      }));
    });

    test('clears search timer', () => {
      const inst = createInstance({ cats: [] });
      inst._searchTimer = setTimeout(() => {}, 99999);
      inst.clearSearch();
      expect(inst._searchTimer).toBeNull();
    });

    test('作废在途筛选请求：清空后到达的旧结果不会回填列表', async () => {
      let resolveFilter;
      mockFilterService.filterFromServer.mockReturnValue(
        new Promise(resolve => { resolveFilter = resolve; })
      );
      const inst = createInstance({ cats: [{ _id: '1' }], searchKeyword: '橘', filteredCats: [] });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });

      inst.filterCats();  // 服务端筛选响应在途
      inst.clearSearch(); // 用户立刻点 × 清空

      resolveFilter({ success: true, cats: [{ _id: '2' }], total: 1 });
      await new Promise(resolve => setTimeout(resolve, 0));

      // 列表保持已还原的全量，不被旧筛选结果覆盖
      expect(inst.data.filteredCats).toEqual([{ _id: '1' }]);
      expect(inst.data.filteredCatCount).toBe(1);
      expect(inst.data.hasSearched).toBe(false);
    });
  });

  describe('_extractColorOptions', () => {
    test('将原始色值归一化为标准分类，并按固定展示顺序输出', () => {
      const inst = createInstance();
      const cats = [
        { color: '橘色' }, { color: '橘色' }, { color: '橘色' },
        { color: '橘白' },
        { color: '玳瑁' },
        { color: '白猫' }
      ];
      const result = inst._extractColorOptions(cats);
      // 橘色/橘白 → 橘猫；玳瑁 → 三花；白猫 → 其他花色
      // 固定顺序：狸花 < 橘猫 < 三花 < 奶牛 < 其他花色（不按频次）
      expect(result).toEqual(['橘猫', '三花', '其他花色']);
    });

    test('returns empty array for empty cats', () => {
      const inst = createInstance();
      expect(inst._extractColorOptions([])).toEqual([]);
    });

    test('ignores empty or whitespace-only colors', () => {
      const inst = createInstance();
      const cats = [{ color: '' }, { color: '  ' }, { color: '橘色' }];
      expect(inst._extractColorOptions(cats)).toEqual(['橘猫']);
    });
  });

  describe('_fallbackClientFilter', () => {
    test('filters by keyword matching name', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '橘猫' }, { _id: '2', name: '小白' }],
        searchKeyword: '橘',
        genderFilter: '', colorFilter: '', campusFilter: ''
      });
      inst._fallbackClientFilter('橘');
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        filteredCatCount: 1,
        isFiltering: false
      }));
    });

    test('filters by keyword matching color', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '大橘', color: '橘色' }, { _id: '2', name: '小白', color: '白色' }],
        searchKeyword: '橘色',
        genderFilter: '', colorFilter: '', campusFilter: ''
      });
      inst._fallbackClientFilter('橘色');
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ filteredCatCount: 1 }));
    });

    test('filters by gender using genderMap', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '橘猫', gender: '公' }, { _id: '2', name: '小白', gender: '母' }],
        searchKeyword: '', genderFilter: 'male', colorFilter: '', campusFilter: ''
      });
      inst._fallbackClientFilter('');
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ filteredCatCount: 1 }));
    });

    test('filters by colorFilter', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '橘猫', color: '橘色' }, { _id: '2', name: '小白', color: '白色' }],
        searchKeyword: '', genderFilter: '', colorFilter: '橘色', campusFilter: ''
      });
      inst._fallbackClientFilter('');
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ filteredCatCount: 1 }));
    });

    test('filters by campusFilter', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '橘猫', campus: '本部' }, { _id: '2', name: '小白', campus: '东区' }],
        searchKeyword: '', genderFilter: '', colorFilter: '', campusFilter: '本部'
      });
      inst._fallbackClientFilter('');
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ filteredCatCount: 1 }));
    });

    test('filters by statusFilter（四态精确匹配）', () => {
      const inst = createInstance({
        cats: [
          { _id: '1', name: '已领养猫', status: 'adopted' },
          { _id: '2', name: '在校猫', status: 'normal' },
          { _id: '3', name: '走失猫', status: 'lost' }
        ],
        searchKeyword: '', genderFilter: '', statusFilter: 'adopted', colorFilter: '', campusFilter: ''
      });
      inst._fallbackClientFilter('');
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['1']);
    });

    test('filters by adoptFilter（至少 N 星；未评级 / 缺失不命中）', () => {
      const inst = createInstance({
        cats: [
          { _id: '1', name: '五星猫', adoptLevel: 5 },
          { _id: '2', name: '四星猫', adoptLevel: 4 },
          { _id: '3', name: '三星猫', adoptLevel: 3 },
          { _id: '4', name: '未评级猫' },
          { _id: '5', name: '零值猫', adoptLevel: 0 }
        ],
        searchKeyword: '', genderFilter: '', colorFilter: '', campusFilter: '', adoptFilter: '4'
      });
      inst._fallbackClientFilter('');
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['1', '2']);
    });

    test('adoptFilter = "3"（有星级）命中全部已评级猫咪', () => {
      const inst = createInstance({
        cats: [
          { _id: '1', adoptLevel: 5 },
          { _id: '2', adoptLevel: 3 },
          { _id: '3' }
        ],
        searchKeyword: '', genderFilter: '', colorFilter: '', campusFilter: '', adoptFilter: '3'
      });
      inst._fallbackClientFilter('');
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['1', '2']);
    });

    test('vibrates when keyword search has no results', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: '小白' }],
        searchKeyword: '不存在的猫', genderFilter: '', colorFilter: '', campusFilter: ''
      });
      inst._fallbackClientFilter('不存在的猫');
      expect(wx.vibrateShort).toHaveBeenCalled();
    });
  });

  describe('onPullDownRefresh', () => {
    test('resets filters and reloads cats', async () => {
      const inst = createInstance({ cats: [{ _id: '1' }], filteredCats: [{ _id: '1' }] });
      mockCatService.loadCats.mockResolvedValue();
      await inst.onPullDownRefresh();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        page: 1, hasMore: true, searchKeyword: '', hasSearched: false,
        // 角标计数必须随筛选条件一起归零，否则刷新后按钮仍显示「筛选 ·N」
        activeFilterCount: 0,
        genderFilter: '', colorFilter: '', campusFilter: ''
      }));
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '刷新成功' }));
    });

    test('作废在途筛选请求：刷新后到达的旧筛选结果不会回填列表', async () => {
      let resolveFilter;
      mockFilterService.filterFromServer.mockReturnValueOnce(
        new Promise(resolve => { resolveFilter = resolve; })
      );
      mockCatService.loadCats.mockResolvedValue();

      const inst = createInstance({ cats: [{ _id: 'base' }], colorFilter: '橘色', filteredCats: [] });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });

      inst.filterCats();                    // 筛选请求在途
      expect(mockFilterService.filterFromServer).toHaveBeenCalledTimes(1);

      await inst.onPullDownRefresh();       // 下拉刷新：回到无筛选并作废在途请求

      resolveFilter({ success: true, cats: [{ _id: 'stale' }], total: 1 });
      await new Promise(resolve => setTimeout(resolve, 0));

      // 视为不可见行为断言：旧响应到达后列表不被覆盖、筛选态不被置回 true
      expect(inst.data.filteredCats).toEqual([]);
      expect(inst.data.hasSearched).toBe(false);
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });

    test('handles error gracefully', async () => {
      const inst = createInstance({ cats: [] });
      mockCatService.loadCats.mockRejectedValue(new Error('fail'));
      await inst.onPullDownRefresh();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });
  });

  describe('onShareAppMessage', () => {
    test('返回标题 / 路径 / 品牌分享图', () => {
      const inst = createInstance({ cats: [{ _tempAvatarUrl: 'https://img.png' }], totalCats: 5 });
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/index/index');
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
    });

    test('首页是聚合页：不再拿第一只猫的头像当 5:4 封面（2026-10-22 大头照反馈）', () => {
      const inst = createInstance({ cats: [{ _tempAvatarUrl: 'https://img.png' }], totalCats: 5 });
      expect(inst.onShareAppMessage().imageUrl).not.toBe('https://img.png');
    });

    test('没有猫 / 头像还是 cloud:// 时同样有品牌卡', () => {
      const empty = createInstance({ cats: [], totalCats: 0 });
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(empty.onShareAppMessage().imageUrl);

      const cloud = createInstance({ cats: [{ _tempAvatarUrl: 'cloud://xxx' }], totalCats: 1 });
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(cloud.onShareAppMessage().imageUrl);
    });

    test('分享到朋友圈同样用品牌卡', () => {
      const inst = createInstance({ cats: [{ _tempAvatarUrl: 'https://img.png' }], totalCats: 5 });
      const result = inst.onShareTimeline();
      expect(result.query).toBe('');
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
    });
  });

  describe('checkNewNotice', () => {
    test('sets hasNewNotice false when cached latest <= lastRead', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'lastNoticeReadTime') return '2025-01-02';
        if (key === 'latestNoticeTime') return '2025-01-01';
        return '';
      });
      const inst = createInstance({ hasNewNotice: true });
      await inst.checkNewNotice();
      expect(inst.setData).toHaveBeenCalledWith({ hasNewNotice: false });
    });

    test('sets hasNewNotice true when server has newer notice', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'lastNoticeReadTime') return '2025-01-01';
        if (key === 'latestNoticeTime') return '';
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notices: [{ createTime: '2025-01-05' }] } }
      });
      const inst = createInstance({ hasNewNotice: false });
      await inst.checkNewNotice();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'getNotices', data: { latestOnly: true }
      });
      expect(inst.setData).toHaveBeenCalledWith({ hasNewNotice: true });
    });

    test('handles cloud function error gracefully', async () => {
      wx.getStorageSync.mockReturnValue('');
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ hasNewNotice: false });
      await inst.checkNewNotice();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('_cleanupAllResources', () => {
    test('cleans up all timers and references', () => {
      const inst = createInstance();
      inst._networkUnsubscribe = jest.fn();
      inst._prefetchTimers = { a: setTimeout(() => {}, 99999) };
      inst._searchTimer = setTimeout(() => {}, 99999);
      inst._autoRetryTimer = setInterval(() => {}, 99999);
      inst._networkRecoveryTimer = setTimeout(() => {}, 99999);
      inst._skeletonFrameId = 1;
      inst._loadingCats = true;
      inst._loadingMoreCats = true;
      inst._loadingAll = true;
      inst._retryQueue = [1];
      inst._baseHasMore = true;
      inst._photoCountsMap = {};
      inst._retryingCatIds = new Set();

      inst._cleanupAllResources();

      expect(inst._networkUnsubscribe).toBeNull();
      expect(inst._prefetchTimers).toBeNull();
      expect(inst._searchTimer).toBeNull();
      expect(inst._autoRetryTimer).toBeNull();
      expect(inst._networkRecoveryTimer).toBeNull();
      expect(inst._skeletonFrameId).toBeNull();
      expect(inst._loadingCats).toBe(false);
      expect(inst._loadingMoreCats).toBe(false);
      expect(inst._loadingAll).toBe(false);
      expect(inst._retryQueue).toBeNull();
      expect(inst._baseHasMore).toBeNull();
      expect(inst._photoCountsMap).toBeNull();
      expect(inst._retryingCatIds).toBeNull();
      expect(mockImageRetryManager.cleanup).toHaveBeenCalled();
    });

    test('handles missing timers gracefully', () => {
      const inst = createInstance();
      inst._networkUnsubscribe = null;
      inst._prefetchTimers = null;
      inst._searchTimer = null;
      inst._autoRetryTimer = null;
      inst._networkRecoveryTimer = null;
      inst._skeletonFrameId = null;
      expect(() => inst._cleanupAllResources()).not.toThrow();
    });
  });

  describe('onCatDetail', () => {
    test('navigates to detail page with catId', () => {
      const inst = createInstance();
      inst.onCatDetail({ currentTarget: { dataset: { id: 'abc123' } } });
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/detail/detail?id=abc123' });
    });

    test('clears prefetch timer for the cat', () => {
      const timer = setTimeout(() => {}, 99999);
      const inst = createInstance();
      inst._prefetchTimers = { abc123: timer };
      inst.onCatDetail({ currentTarget: { dataset: { id: 'abc123' } } });
      expect(inst._prefetchTimers.abc123).toBeUndefined();
    });
  });

  describe('onResetFilter', () => {
    test('只清性别/花色/年龄：保留搜索词与校区，按剩余条件重放', () => {
      // 搜索词与校区各有自己的清除入口（clearSearch / 校区下拉的「全部校区」），
      // 面板重置不该越界把它们也清掉
      const inst = createInstance({ cats: [{ _id: '1' }], genderFilter: 'male', statusFilter: 'lost', colorFilter: '橘色', campusFilter: '本部', searchKeyword: '橘', hasSearched: true, activeFilterCount: 3, showFilter: true });
      inst.onResetFilter();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        genderFilter: '', statusFilter: '', colorFilter: '', ageFilter: '', showFilter: false
      }));
      expect(inst.data.searchKeyword).toBe('橘');
      expect(inst.data.campusFilter).toBe('本部');
      // 校区条件仍在 → 重放校区筛选。若走 _restoreFullList，
      // 会把仍在生效的搜索结果一并还原成全量列表
      expect(mockFilterService.loadCatsByCampus).toHaveBeenCalledWith('本部', inst);
    });

    test('仅剩搜索词时重跑筛选，不还原全量', () => {
      const inst = createInstance({ cats: [{ _id: '1' }], colorFilter: '橘色', searchKeyword: '橘' });
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onResetFilter();
      expect(spy).toHaveBeenCalled();
      expect(inst.data.searchKeyword).toBe('橘');
      expect(inst.data.colorFilter).toBe('');
    });

    test('没有任何剩余条件时还原全量列表', () => {
      const inst = createInstance({ cats: [{ _id: '1' }], genderFilter: 'male', hasSearched: true, activeFilterCount: 1 });
      inst.onResetFilter();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        filteredCats: [{ _id: '1' }], hasSearched: false, activeFilterCount: 0
      }));
      expect(mockFilterService.loadCatsByCampus).not.toHaveBeenCalled();
    });

    test('作废在途筛选请求：重置后到达的旧筛选结果不会回填', async () => {
      let resolveFilter;
      mockFilterService.filterFromServer.mockReturnValueOnce(
        new Promise(resolve => { resolveFilter = resolve; })
      );
      const inst = createInstance({
        cats: [{ _id: 'base' }], filteredCats: [], colorFilter: '橘色', hasSearched: true
      });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });

      inst.filterCats();     // 筛选请求在途
      inst.onResetFilter();  // 重置筛选：还原全量并作废在途请求

      resolveFilter({ success: true, cats: [{ _id: 'stale' }], total: 1 });
      await new Promise(resolve => setTimeout(resolve, 0));

      // 视为不可见行为断言：列表保持已还原的全量，不被旧筛选结果覆盖
      expect(inst.data.filteredCats.map(c => c._id)).toEqual(['base']);
      expect(inst.data.hasSearched).toBe(false);
      expect(inst.data.activeFilterCount).toBe(0);
    });
  });

  describe('筛选项即点即筛', () => {
    test('onGenderFilter：选中后经防抖触发 filterCats', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onGenderFilter({ currentTarget: { dataset: { gender: 'male' } } });
      expect(inst.data.genderFilter).toBe('male');
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    test('onStatusFilter：四态选中后经防抖触发 filterCats，「全部」回填空串', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      const spy = jest.fn();
      inst.filterCats = spy;

      inst.onStatusFilter({ currentTarget: { dataset: { status: 'adopted' } } });
      expect(inst.data.statusFilter).toBe('adopted');
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(1);

      // 「全部」复位
      inst.onStatusFilter({ currentTarget: { dataset: { status: '' } } });
      expect(inst.data.statusFilter).toBe('');
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    test('onAdoptFilter：选中星级后经防抖触发 filterCats，「全部」回填空串', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      const spy = jest.fn();
      inst.filterCats = spy;

      inst.onAdoptFilter({ currentTarget: { dataset: { level: '4' } } });
      expect(inst.data.adoptFilter).toBe('4');
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(1);

      // 「全部」复位
      inst.onAdoptFilter({ currentTarget: { dataset: { level: '' } } });
      expect(inst.data.adoptFilter).toBe('');
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    test('连点多个选项只触发一次筛选（防抖合并）', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onGenderFilter({ currentTarget: { dataset: { gender: 'male' } } });
      inst.onGenderFilter({ currentTarget: { dataset: { gender: 'female' } } });
      inst.onColorFilter({ currentTarget: { dataset: { color: '橘色' } } });
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(1);
      // 最终生效的是最后一次点击的值
      expect(inst.data.genderFilter).toBe('female');
      expect(inst.data.colorFilter).toBe('橘色');
      jest.useRealTimers();
    });

    test('onColorFilter：计数为 0 的花色不可选（不改变选中态、不触发筛选）', () => {
      const inst = createInstance({ colorCounts: { 罕见花色: 0 } });
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onColorFilter({ currentTarget: { dataset: { color: '罕见花色' } } });
      expect(inst.data.colorFilter).toBe('');
      expect(spy).not.toHaveBeenCalled();
    });

    test('onColorFilter：有货的花色正常选中', () => {
      jest.useFakeTimers();
      const inst = createInstance({ colorCounts: { 橘猫: 12 } });
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onColorFilter({ currentTarget: { dataset: { color: '橘猫' } } });
      expect(inst.data.colorFilter).toBe('橘猫');
      jest.advanceTimersByTime(config.performance.filterDebounceDelay);
      expect(spy).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });
  });

  describe('_loadAllColorOptions 花色计数', () => {
    test('云函数计数优先；本地兜底按归一化分类累加；固定展示顺序', async () => {
      const inst = createInstance({
        // colorOptions 模拟已被 catService.mergeColorOptions 归一化后的本地状态；
        // 本地猫数据只用于计数兜底
        cats: [{ color: '三花' }, { color: '三花' }, { color: '橘白' }, { color: '黑猫' }],
        colorOptions: ['三花', '橘白', '其他花色']
      });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: { colors: ['橘猫', '三花'], colorCounts: { 橘猫: 20, 三花: 5 }, totalPhotos: 100 }
        }
      });

      await inst._loadAllColorOptions();

      // 本地细项「橘白」归一为「橘猫」并入，不再是独立选项；
      // 固定顺序：狸花 < 橘猫 < 三花 < 奶牛 < 其他花色（不按数量）
      expect(inst.data.colorOptions).toEqual(['橘猫', '三花', '其他花色']);
      // 三花：云函数 5 覆盖本地 2；橘猫：云函数 20 覆盖本地 1（橘白）；
      // 其他花色：云端未返回该分类 → 本地 1（黑猫）兜底
      expect(inst.data.colorCounts).toEqual({ 橘猫: 20, 三花: 5, 其他花色: 1 });
    });

    test('云函数未返回 colorCounts（旧版本/截断）时本地兜底', async () => {
      const inst = createInstance({ cats: [{ color: '三花' }], colorOptions: ['三花'] });
      inst.safeSetData = jest.fn((updates, cb) => { inst.setData(updates); if (cb) cb(); });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { colors: ['三花'], totalPhotos: 100 } }
      });

      await inst._loadAllColorOptions();

      expect(inst.data.colorOptions).toEqual(['三花']);
      expect(inst.data.colorCounts).toEqual({ 三花: 1 });
    });

    test('云函数失败时不破坏已有选项', async () => {
      const inst = createInstance({ colorOptions: ['三花'] });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: 'boom' } });
      await inst._loadAllColorOptions();
      expect(inst.data.colorOptions).toEqual(['三花']);
      expect(inst.data.colorCounts).toEqual({});
    });
  });

  describe('onCampusTab', () => {
    test('calls filterCats when campus is empty', () => {
      const inst = createInstance();
      const spy = jest.fn();
      inst.filterCats = spy;
      inst.onCampusTab({ currentTarget: { dataset: { campus: '' } } });
      expect(spy).toHaveBeenCalled();
    });

    test('calls FilterService.loadCatsByCampus when campus is set', () => {
      const inst = createInstance();
      inst.onCampusTab({ currentTarget: { dataset: { campus: '本部' } } });
      expect(mockFilterService.loadCatsByCampus).toHaveBeenCalledWith('本部', inst);
    });
  });

  describe('onToggleFilter', () => {
    test('toggles showFilter and closes campus panel (mutual exclusion)', () => {
      const inst = createInstance({ showFilter: false, showCampusDropdown: true });
      inst.onToggleFilter();
      expect(inst.setData).toHaveBeenCalledWith({ showFilter: true, showCampusDropdown: false });
    });
  });

  describe('onToggleCampusDropdown', () => {
    test('toggles showCampusDropdown and closes filter panel (mutual exclusion)', () => {
      const inst = createInstance({ showCampusDropdown: false, showFilter: true });
      inst.onToggleCampusDropdown();
      expect(inst.setData).toHaveBeenCalledWith({ showCampusDropdown: true, showFilter: false });
    });

    test('closes itself on second tap', () => {
      const inst = createInstance({ showCampusDropdown: true, showFilter: false });
      inst.onToggleCampusDropdown();
      expect(inst.setData).toHaveBeenCalledWith({ showCampusDropdown: false, showFilter: false });
    });
  });

  describe('_animateStatNumbers 统计数字滚动', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** 推进一帧（steps = 8 / duration = 800ms → 100ms 一帧） */
    const nextFrame = () => jest.advanceTimersByTime(100);

    test('回归：浏览量逐帧写入 displayViewsText，而不是直接跳到终值', () => {
      // 旧实现逐帧只写 displayViews —— wxml 绑定的却是 displayViewsText（带 'w' 的文本），
      // 于是「浏览」全程没有任何可见变化，只在末帧写一次终值。
      // 「只猫 / 张照」绑定的是逐帧写入的 displayCats / displayPhotos，所以正常滚动。
      const inst = createInstance();
      inst._animateStatNumbers(88, 955, 23012);

      const seen = [];
      for (let i = 0; i < 8; i++) {
        nextFrame();
        seen.push(inst.data.displayViewsText);
      }

      // 首帧就是终值 = 「跳」；中间必须出现过其它文本值才算「滚」
      expect(seen[0]).not.toBe('2.3w');
      expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
      // 单调不减（滚动过程中不允许回退）
      const nums = seen.map(t => parseFloat(t) * (t.includes('w') ? 10000 : 1));
      nums.forEach((n, i) => { if (i > 0) expect(n).toBeGreaterThanOrEqual(nums[i - 1]); });
      // 末帧精确落在 target 上
      expect(seen[7]).toBe('2.3w');
      expect(inst.data.displayViews).toBe(23012);
      expect(inst.data.displayCats).toBe(88);
      expect(inst.data.displayPhotos).toBe(955);
      expect(inst._statAnimTimer).toBeNull();
    });

    test('起点是当前显示值：统计补丁在动画途中到达时不把数字打回 0 重滚', () => {
      // 旧实现固定从 0 起步，同一个数字会滚两遍（缓存命中时 955 先掉到 ~315 再滚回来）
      const inst = createInstance({
        displayCats: 45, displayPhotos: 955, displayViews: 23000, displayViewsText: '2.3w'
      });
      inst._animateStatNumbers(88, 960, 23050);

      nextFrame();
      expect(inst.data.displayCats).toBeGreaterThanOrEqual(45);
      expect(inst.data.displayCats).toBeLessThanOrEqual(88);
      expect(inst.data.displayPhotos).toBeGreaterThanOrEqual(955);

      jest.advanceTimersByTime(800);
      expect(inst.data.displayCats).toBe(88);
      expect(inst.data.displayPhotos).toBe(960);
      expect(inst.data.displayViews).toBe(23050);
      expect(inst.data.displayViewsText).toBe('2.3w');
    });

    test('目标等于当前显示值：不启动定时器，也不产生无意义 setData', () => {
      const inst = createInstance({
        displayCats: 88, displayPhotos: 955, displayViews: 23012, displayViewsText: '2.3w'
      });
      inst._animateStatNumbers(88, 955, 23012);

      expect(inst._statAnimTimer).toBeFalsy();
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('末帧用 eased=1 短路：终值精确等于 target（不出差一档的中间值）', () => {
      const inst = createInstance();
      inst._animateStatNumbers(0, 0, 9999);
      jest.advanceTimersByTime(800);

      expect(inst.data.displayViews).toBe(9999);
      expect(inst.data.displayViewsText).toBe('9999');
      expect(inst.data.displayPhotos).toBe(0);
    });
  });

  describe('版本更新卡', () => {
    const release = {
      id: 'release-3.8.0',
      version: '3.8.0',
      title: '这次更新：新功能',
      icon: 'camera',
      items: [
        { text: '拍一张猫脸', entry: '/subpackages/feedback/identify/identify' },
        { text: '地图选点', entry: '' }
      ]
    };

    beforeEach(() => {
      jest.useFakeTimers();
      mockGuidance.hasCompletedOnboarding.mockReturnValue(true);
      mockGuidance.getPendingRelease.mockReturnValue(release);
      mockGuidance.markReleaseSeen.mockClear();
      mockObsHelper.reportEvent.mockClear();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('新用户还没完成欢迎时不弹', () => {
      mockGuidance.hasCompletedOnboarding.mockReturnValue(false);
      const inst = createInstance();
      inst._maybeShowRelease();
      jest.advanceTimersByTime(800);
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('守则/欢迎弹窗还开着时不抢屏', () => {
      const inst = createInstance({ agreementModal: { show: true } });
      inst._maybeShowRelease();
      jest.advanceTimersByTime(800);
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('有未看版本时延迟 800ms 弹出并记录曝光', () => {
      const inst = createInstance();
      inst._maybeShowRelease();
      expect(inst.setData).not.toHaveBeenCalled();

      jest.advanceTimersByTime(800);

      expect(inst.setData).toHaveBeenCalledWith({
        releaseModal: expect.objectContaining({
          show: true,
          title: '这次更新：新功能',
          icon: 'camera',
          entry: '/subpackages/feedback/identify/identify'
        })
      });
      expect(mockObsHelper.reportEvent).toHaveBeenCalledWith('guidance_release_view', { version: '3.8.0' });
    });

    test('同一页面实例只调度一次', () => {
      const inst = createInstance();
      inst._maybeShowRelease();
      inst._maybeShowRelease();
      jest.advanceTimersByTime(800);
      expect(inst.setData).toHaveBeenCalledTimes(1);
    });

    test('点「去看看」会跳转并记为已看', () => {
      const inst = createInstance({
        releaseModal: { show: true, entry: '/subpackages/feedback/identify/identify', items: release.items, title: '', icon: '' }
      });
      inst._pendingRelease = release;

      inst.onReleaseConfirm();

      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/subpackages/feedback/identify/identify' });
      expect(mockGuidance.markReleaseSeen).toHaveBeenCalledWith(release);
      expect(mockObsHelper.reportEvent).toHaveBeenCalledWith('guidance_release_click', { version: '3.8.0' });
      expect(inst.data.releaseModal.show).toBe(false);
    });

    test('点「知道了」只关闭并记为已看，不跳转', () => {
      const inst = createInstance({
        releaseModal: { show: true, entry: '/subpackages/feedback/identify/identify', items: release.items, title: '', icon: '' }
      });
      inst._pendingRelease = release;

      inst.onReleaseCancel();

      expect(wx.navigateTo).not.toHaveBeenCalled();
      expect(mockGuidance.markReleaseSeen).toHaveBeenCalledWith(release);
      expect(inst.data.releaseModal.show).toBe(false);
    });
  });

  describe('全功能导览', () => {
    beforeEach(() => {
      mockGuidance.hasCompletedOnboarding.mockReturnValue(true);
      mockGuidance.getPendingRelease.mockReturnValue(null);
      mockObsHelper.reportEvent.mockClear();
    });

    test('onShow 按页面注册导览，并把浮层互斥条件交给 canStart', () => {
      const inst = createInstance({
        agreementModal: { show: false },
        welcomeModal: { show: false },
        releaseModal: { show: false }
      });

      inst.onShow();

      expect(inst.initGuideTour).toHaveBeenCalledWith(
        'pages/index/index',
        expect.objectContaining({ delay: 700 })
      );
      const options = inst.initGuideTour.mock.calls[0][1];
      expect(options.canStart()).toBe(true);
    });

    test('守则 / 欢迎 / 更新卡任开着时 canStart 返回 false', () => {
      const inst = createInstance({
        agreementModal: { show: true },
        welcomeModal: { show: false },
        releaseModal: { show: false }
      });
      inst.onShow();
      expect(inst.initGuideTour.mock.calls[0][1].canStart()).toBe(false);

      const inst2 = createInstance({
        agreementModal: { show: false },
        welcomeModal: { show: true },
        releaseModal: { show: false }
      });
      inst2.onShow();
      expect(inst2.initGuideTour.mock.calls[0][1].canStart()).toBe(false);

      const inst3 = createInstance({
        agreementModal: { show: false },
        welcomeModal: { show: false },
        releaseModal: { show: true }
      });
      inst3.onShow();
      expect(inst3.initGuideTour.mock.calls[0][1].canStart()).toBe(false);
    });

    test('本次已安排更新卡时先让更新卡讲完', () => {
      const inst = createInstance();
      inst._releaseScheduled = true;
      inst.onShow();
      expect(inst.initGuideTour.mock.calls[0][1].canStart()).toBe(false);
    });

    test('更新卡关闭后主动接上导览，不用等下次 onShow', () => {
      const inst = createInstance({
        releaseModal: { show: true, entry: '', items: [], title: '', icon: '' }
      });
      inst._releaseScheduled = true;
      inst.onReleaseCancel();

      expect(inst.data.releaseModal.show).toBe(false);
      expect(inst._releaseScheduled).toBe(false);
      expect(inst.scheduleGuideTour).toHaveBeenCalledWith(500);
    });
  });

});
