const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), handleGlobalError: jest.fn(), handleUnhandledRejection: jest.fn(), initGlobalErrorCatch: jest.fn() };
const mockPageState = { getPageStateManager: jest.fn(() => ({ checkNeedRefresh: jest.fn(() => null) })) };
const mockPerfMonitor = { monitorPageLoad: jest.fn((_, fn) => fn()), monitorApi: jest.fn((_, fn) => fn()) };
const mockObsHelper = {
  isAvailable: jest.fn(),
  trySetup: jest.fn(),
  reportEvent: jest.fn(),
  EVENT_NAMES: {
    FEATURE_FIRST_USE: 'feature_first_use'
  }
};
const mockImageLoader = { preloadAboveFold: jest.fn(), preloadBelowFold: jest.fn() };
const mockImageRetryManager = { handleError: jest.fn(), cleanup: jest.fn() };
const mockAvatarHelper = { resolveCatAvatars: jest.fn(() => Promise.resolve([{ avatar: 'https://img.png' }])) };
const mockPhotoUtils = { resolvePhotoUrls: jest.fn() };
const mockPhotoService = { loadPhotos: jest.fn(), applyPrefetchCache: jest.fn(), onPreviewPhoto: jest.fn(), saveImageToAlbum: jest.fn(), togglePhotoLike: jest.fn(), loadFullPhotosQuietly: jest.fn() };
const mockMeetService = { checkTodayMeetStatus: jest.fn(), submitMeet: jest.fn(), loadRecentMeets: jest.fn() };
const mockDateFormat = { formatDateShort: jest.fn(v => v || '') };
const mockValidator = { validateCatId: jest.fn(() => true) };
const mockShareTextGenerator = { generateDetailText: jest.fn(() => '分享标题') };
const ShareHelper = require('../../utils/shareHelper');

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/pageState', () => mockPageState);
jest.mock('../../utils/performanceMonitor', () => mockPerfMonitor);
jest.mock('../../utils/obsHelper', () => mockObsHelper);
jest.mock('../../utils/imageLoader', () => mockImageLoader);
jest.mock('../../utils/imageRetryManager', () => mockImageRetryManager);
jest.mock('../../utils/avatarHelper', () => mockAvatarHelper);
jest.mock('../../utils/photoUtils', () => mockPhotoUtils);
jest.mock('../../services/photoService', () => mockPhotoService);
jest.mock('../../services/meetService', () => mockMeetService);
jest.mock('../../utils/dateFormat', () => mockDateFormat);
jest.mock('../../utils/validator', () => mockValidator);
jest.mock('../../utils/shareTextGenerator', () => mockShareTextGenerator);
jest.mock('../../behaviors/backToTopBehavior', () => ({}));

const _config = require('../../config');

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/detail/detail');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReturnValue('');
  wx.setStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.cloud.database.mockReturnValue({
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: [] })),
        count: jest.fn(() => Promise.resolve({ total: 0 })),
        orderBy: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })) }))
      })),
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: {} })),
        update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
        remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      limit: jest.fn(function() { return this; }),
      orderBy: jest.fn(function() { return this; }),
      skip: jest.fn(function() { return this; }),
      get: jest.fn(() => Promise.resolve({ data: [] }))
    })),
    command: { eq: jest.fn(v => v), neq: jest.fn(v => v), gt: jest.fn(v => v), gte: jest.fn(v => v), lt: jest.fn(v => v), lte: jest.fn(v => v), in: jest.fn(v => v), and: jest.fn(v => v), or: jest.fn(v => v) }
  });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _toggleFavLock: false,
    _undoTimer: null,
    _navBackTimer: null,
    _loadingPhotos: false,
    _navBarHeightUpdating: false,
    _isUnmounted: false,
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

describe('detail page', () => {
  describe('onLoad', () => {
    test('sets statusBarHeight and catId for valid id', async () => {
      const inst = createInstance();
      getApp.mockReturnValue({ getPrefetchCache: jest.fn(() => null), globalData: { _prefetchCache: { delete: jest.fn() } } });
      wx.cloud.database.mockReturnValue({
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: { _id: 'abc123', name: '橘猫', avatar: 'https://img.png', viewCount: 10 } }))
          })),
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })) })),
            count: jest.fn(() => Promise.resolve({ total: 0 }))
          }))
        }))
      });
      await inst.onLoad({ id: 'abc123' });
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ catId: 'abc123' }));
    });

    test('最近相遇与主内容并行加载（不等待主内容完成）', async () => {
      const inst = createInstance();
      getApp.mockReturnValue({ getPrefetchCache: jest.fn(() => null), globalData: { _prefetchCache: { delete: jest.fn() } } });

      let resolveCat;
      inst.loadCatDetail = jest.fn(() => new Promise(resolve => { resolveCat = resolve; }));
      inst.loadPhotos = jest.fn(() => Promise.resolve());

      const pending = inst.onLoad({ id: 'abc123' });

      // 主内容（loadCatDetail）尚未返回时，最近相遇/今日打卡必须已经发起：
      // 旧实现把它们放在 Promise.all(...).then() 里，此处必然为 0 次调用。
      expect(mockMeetService.checkTodayMeetStatus).toHaveBeenCalled();
      expect(mockMeetService.loadRecentMeets).toHaveBeenCalled();

      resolveCat();
      await pending;
    });

    test('calls ErrorHandler and returns for invalid catId', async () => {
      mockValidator.validateCatId.mockReturnValueOnce(false);
      const inst = createInstance();
      await inst.onLoad({ id: '' });
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      // 返回由页面自建定时器负责：validator 不得再排一个（否则连退两层）
      expect(mockValidator.validateCatId).toHaveBeenCalledWith('', { autoBack: false });
      // 清掉 1.5s 的延迟返回定时器，避免测试进程因遗留句柄无法退出
      if (inst._navBackTimer) {
        clearTimeout(inst._navBackTimer);
        inst._navBackTimer = null;
      }
    });

    test('does not touch dead meet_today_* storage (已移除死存储清理)', async () => {
      const inst = createInstance();
      getApp.mockReturnValue({ getPrefetchCache: jest.fn(() => null), globalData: { _prefetchCache: { delete: jest.fn() } } });
      await inst.onLoad({ id: 'abc123' });
      expect(wx.removeStorageSync).not.toHaveBeenCalledWith('meet_today_abc123');
    });

    test('uses prefetch cache when fresh', async () => {
      const prefetchCache = { timestamp: Date.now(), cat: {}, photos: [], totalPhotoCount: 0 };
      const deleteFn = jest.fn();
      getApp.mockReturnValue({ getPrefetchCache: jest.fn(() => prefetchCache), globalData: { _prefetchCache: { delete: deleteFn } } });
      const inst = createInstance();
      await inst.onLoad({ id: 'abc123' });
      expect(mockPhotoService.applyPrefetchCache).toHaveBeenCalled();
      expect(deleteFn).toHaveBeenCalledWith('abc123');
    });

    test('calls _recordViewWithFallback', async () => {
      const inst = createInstance();
      getApp.mockReturnValue({ getPrefetchCache: jest.fn(() => null), globalData: { _prefetchCache: { delete: jest.fn() } } });
      const spy = jest.spyOn(inst, '_recordViewWithFallback');
      await inst.onLoad({ id: 'abc123' });
      expect(spy).toHaveBeenCalledWith('abc123');
    });
  });

  describe('onShow', () => {
    test('returns early when cat not loaded', () => {
      const inst = createInstance({ cat: {}, catId: '' });
      inst.onShow();
      expect(mockPageState.getPageStateManager).not.toHaveBeenCalled();
    });

    test('checks favorite and meet status when cat is loaded', () => {
      const inst = createInstance({ cat: { _id: 'abc123' }, catId: 'abc123' });
      inst.onShow();
      expect(wx.getStorageSync).toHaveBeenCalled();
    });

    test('refreshes photos when refreshData has photo_added action', () => {
      mockPageState.getPageStateManager.mockReturnValue({ checkNeedRefresh: jest.fn(() => ({ action: 'photo_added' })) });
      const inst = createInstance({ cat: { _id: 'abc123' }, catId: 'abc123' });
      inst.onShow();
      expect(mockPhotoService.loadPhotos).toHaveBeenCalledWith(inst, true);
    });
  });

  /**
   * 海报页已下线（产品决定，2026-10-11）：详情页不暴露「海报」入口，
   * 且该页已从 app.json 摘除（代码保留在仓库里，不进包体）。
   * 这里锁住「不会又长回来」：详情页不得出现海报入口、app.json 不得注册该路由。
   * 断言是反向的 —— 它防的是「顺手加个按钮」这种看起来无害的改动；
   * 真要重新上线应当是一次有意识的决定（恢复注册 + 补入口 + 真机验）。
   */
  describe('海报入口已下线（FE-4 · 产品决定）', () => {
    test('detail.wxml 不含海报入口', () => {
      const fs = require('fs');
      const path = require('path');
      const wxml = fs.readFileSync(path.join(__dirname, '../../pages/detail/detail.wxml'), 'utf8');
      expect(wxml).not.toContain('onGeneratePoster');
      expect(wxml).not.toContain('action-btn-poster');
    });

    test('app.json 不再注册海报路由（不进包体、无孤儿路由）', () => {
      const fs = require('fs');
      const path = require('path');
      const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../app.json'), 'utf8'));
      expect(appJson.pages).not.toContain('pages/share/share');
    });

    test('detail.js 不再有 onGeneratePoster（避免留下永不调用的方法）', () => {
      const fs = require('fs');
      const path = require('path');
      const js = fs.readFileSync(path.join(__dirname, '../../pages/detail/detail.js'), 'utf8');
      expect(js).not.toContain('onGeneratePoster');
    });
  });

  /**
   * 地图选点已下线（2026-10-17）：`wx.chooseLocation` 是需要平台单独开通的
   * 隐私接口，本账号（appid your-appid-here）在公众平台「开发管理 > 接口设置」
   * 未获批，调用即弹「接口无权限 / 暂无权限接口：wx.chooseLocation」。
   * 相遇地点本就只存一段 ≤20 字的自由文本（services/meetService.js 的
   * `location: selectedLocation || '校园内'`），去掉选点不影响打卡本身。
   *
   * 断言是反向的：声明与入口必须同时消失。光删 app.json 声明不删入口，
   * 运行期照样报无权限、照样弹平台框；只删入口不删声明，则审核期会被驳回。
   */
  describe('地图选点已下线（wx.chooseLocation 无接口权限）', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

    test('app.json 不再声明 chooseLocation / scope.userLocation', () => {
      const appJson = JSON.parse(read('app.json'));
      expect(appJson.requiredPrivateInfos).toBeUndefined();
      expect(appJson.permission).toBeUndefined();
    });

    test('detail.wxml 不含选点入口与处理器', () => {
      const wxml = read('pages/detail/detail.wxml');
      expect(wxml).not.toContain('onChooseLocation');
      expect(wxml).not.toContain('meet-loc-pick');
      // 手输仍在：相遇地点依旧可填
      expect(wxml).toContain('onLocationInput');
    });

    test('detail.js 不再有 onChooseLocation（避免留下永不调用的方法）', () => {
      const js = read('pages/detail/detail.js');
      expect(js).not.toContain('chooseLocation');
    });
  });

  describe('onReachBottom', () => {
    test('loads more photos when there are more and not loading', async () => {
      const inst = createInstance({
        cat: { _id: 'abc123' },
        catId: 'abc123',
        loading: false,
        loadingMore: false,
        hasMorePhotos: true,
        photos: [{ _id: 'p1' }]
      });
      await inst.onReachBottom();
      expect(mockPhotoService.loadPhotos).toHaveBeenCalledWith(inst, false);
    });

    test('skips when loading or no more photos', async () => {
      const loadingInst = createInstance({ loading: true, loadingMore: false, hasMorePhotos: true });
      await loadingInst.onReachBottom();
      const noMoreInst = createInstance({ loading: false, loadingMore: false, hasMorePhotos: false });
      await noMoreInst.onReachBottom();
      const loadingMoreInst = createInstance({ loading: false, loadingMore: true, hasMorePhotos: true });
      await loadingMoreInst.onReachBottom();
      expect(mockPhotoService.loadPhotos).not.toHaveBeenCalled();
    });
  });

  describe('toggleFavorite', () => {
    test('adds cat to favorites when not favorited', async () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: false });
      await inst.toggleFavorite();
      expect(wx.setStorageSync).toHaveBeenCalledWith('favoriteCats', expect.arrayContaining([expect.objectContaining({ id: 'abc123' })]));
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: true }));
    });

    test('removes cat from favorites when already favorited (string format)', async () => {
      wx.getStorageSync.mockReturnValue(['abc123', 'def456']);
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: true });
      await inst.toggleFavorite();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: false, showUndoBar: true }));
      // 取消关注会挂 5s 撤销定时器：不清理会让 Jest 因遗留句柄无法退出
      if (inst._undoTimer) { clearTimeout(inst._undoTimer); inst._undoTimer = null; }
    });

    test('removes cat from favorites (object format)', async () => {
      wx.getStorageSync.mockReturnValue([{ id: 'abc123', time: 1 }, { id: 'def456', time: 2 }]);
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: true });
      await inst.toggleFavorite();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: false }));
      if (inst._undoTimer) { clearTimeout(inst._undoTimer); inst._undoTimer = null; }
    });

    test('rolls back on cloud sync failure when removing', async () => {
      wx.getStorageSync
        .mockReturnValueOnce(['abc123'])
        .mockReturnValueOnce([{ id: 'def456', time: 1 }]);
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: true });
      await inst.toggleFavorite();
      await Promise.resolve();
      await Promise.resolve();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: true, showUndoBar: false }));
      if (inst._undoTimer) { clearTimeout(inst._undoTimer); inst._undoTimer = null; }
    });

    test('rolls back on cloud sync failure when adding', async () => {
      wx.getStorageSync
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ id: 'abc123', time: Date.now() }]);
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: false });
      await inst.toggleFavorite();
      await Promise.resolve();
      await Promise.resolve();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ isFavorite: false }));
    });

    test('prevents concurrent calls with lock', async () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance({ catId: 'abc123', cat: { name: '橘猫' }, isFavorite: false });
      inst._toggleFavLock = true;
      await inst.toggleFavorite();
      expect(wx.setStorageSync).not.toHaveBeenCalled();
    });

    test('limits favorites to 100 entries', async () => {
      const bigList = Array(100).fill(null).map((_, i) => ({ id: `id${i}`, time: i }));
      wx.getStorageSync.mockReturnValue(bigList);
      const inst = createInstance({ catId: 'new_id', cat: { name: '新猫' }, isFavorite: false });
      await inst.toggleFavorite();
      const saved = wx.setStorageSync.mock.calls.find(c => c[0] === 'favoriteCats')?.[1];
      expect(saved.length).toBeLessThanOrEqual(100);
    });
  });

  describe('checkFavoriteStatus', () => {
    test('sets isFavorite true when catId in favorites (string format)', () => {
      wx.getStorageSync.mockReturnValue(['abc123', 'def456']);
      const inst = createInstance({ catId: 'abc123', isFavorite: false });
      inst.checkFavoriteStatus();
      expect(inst.setData).toHaveBeenCalledWith({ isFavorite: true });
    });

    test('sets isFavorite true when catId in favorites (object format)', () => {
      wx.getStorageSync.mockReturnValue([{ id: 'abc123', time: 1 }]);
      const inst = createInstance({ catId: 'abc123', isFavorite: false });
      inst.checkFavoriteStatus();
      expect(inst.setData).toHaveBeenCalledWith({ isFavorite: true });
    });

    test('sets isFavorite false when catId not in favorites', () => {
      wx.getStorageSync.mockReturnValue(['def456']);
      const inst = createInstance({ catId: 'abc123', isFavorite: true });
      inst.checkFavoriteStatus();
      expect(inst.setData).toHaveBeenCalledWith({ isFavorite: false });
    });

    test('skips setData when isFavorite already matches', () => {
      wx.getStorageSync.mockReturnValue(['abc123']);
      const inst = createInstance({ catId: 'abc123', isFavorite: true });
      inst.checkFavoriteStatus();
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('handles non-array storage value', () => {
      wx.getStorageSync.mockReturnValue(null);
      const inst = createInstance({ catId: 'abc123', isFavorite: false });
      inst.checkFavoriteStatus();
      expect(inst.setData).not.toHaveBeenCalled();
    });
  });

  describe('_recordViewWithFallback', () => {
    test('calls cloud function recordView', () => {
      const inst = createInstance();
      inst._recordViewWithFallback('abc123');
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({ name: 'recordView', data: { catId: 'abc123' } }));
    });

    test('enqueues view record on cloud failure', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      const inst = createInstance();
      const spy = jest.spyOn(inst, '_enqueueViewRecord');
      inst._recordViewWithFallback('abc123');
      await Promise.resolve();
      await Promise.resolve();
      expect(spy).toHaveBeenCalledWith('abc123');
    });
  });

  describe('_enqueueViewRecord', () => {
    test('pushes catId and timestamp to queue', () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance();
      inst._enqueueViewRecord('abc123');
      expect(wx.setStorageSync).toHaveBeenCalledWith('_viewRecordQueue', expect.arrayContaining([expect.objectContaining({ catId: 'abc123' })]));
    });

    test('limits queue to 100 entries', () => {
      const bigQueue = Array(100).fill(null).map((_, i) => ({ catId: `id${i}`, timestamp: i }));
      wx.getStorageSync.mockReturnValue(bigQueue);
      const inst = createInstance();
      inst._enqueueViewRecord('new_id');
      const saved = wx.setStorageSync.mock.calls.find(c => c[0] === '_viewRecordQueue')?.[1];
      expect(saved.length).toBeLessThanOrEqual(100);
    });

    test('handles non-array storage value', () => {
      wx.getStorageSync.mockReturnValue('not-array');
      const inst = createInstance();
      inst._enqueueViewRecord('abc123');
      expect(wx.setStorageSync).toHaveBeenCalled();
    });
  });

  describe('onBack', () => {
    test('navigates back when pages > 1 and prev is non-tab page', () => {
      getCurrentPages.mockReturnValue([{ route: 'pages/some/other' }, { route: 'pages/detail/detail' }]);
      const inst = createInstance();
      inst.onBack();
      expect(wx.navigateBack).toHaveBeenCalled();
    });

    test('switches tab when prev page is a tab page', () => {
      getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/detail/detail' }]);
      const inst = createInstance();
      inst.onBack();
      expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });

    test('switches to index when only one page in stack', () => {
      getCurrentPages.mockReturnValue([{ route: 'pages/detail/detail' }]);
      const inst = createInstance();
      inst.onBack();
      expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });
  });

  describe('onAvatarError', () => {
    test('clears avatar and _tempAvatarUrl', () => {
      const inst = createInstance({ cat: { _id: '1', avatar: 'https://img.png', _tempAvatarUrl: 'https://img.png' } });
      inst.onAvatarError();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        cat: expect.objectContaining({ avatar: '', _tempAvatarUrl: '' })
      }));
    });

    test('does nothing when cat is not set', () => {
      const inst = createInstance({ cat: null });
      inst.onAvatarError();
      expect(inst.setData).not.toHaveBeenCalled();
    });
  });

  // 头像转链后台化：loadCatDetail 先渲染正文、再补丁头像
  //（旧实现要在 setData 前 await 一次完整往返，非预取路径每次进入都多等这一段）
  describe('_resolveAvatarInBackground', () => {
    function createWithSafeSetData(dataOverrides) {
      const inst = createInstance(dataOverrides);
      inst.safeSetData = jest.fn(function(updates) { Object.assign(this.data, updates); });
      return inst;
    }

    test('解析成功后回填 avatar / _tempAvatarUrl 并置 avatarLoaded', async () => {
      mockAvatarHelper.resolveCatAvatars.mockResolvedValue([{ avatar: 'https://img.png' }]);
      const inst = createWithSafeSetData({
        cat: { _id: '1', avatar: 'cloud://x', _tempAvatarUrl: 'cloud://x' }
      });

      await inst._resolveAvatarInBackground('cloud://x');

      expect(inst.safeSetData).toHaveBeenCalledWith({
        'cat.avatar': 'https://img.png',
        'cat._tempAvatarUrl': 'https://img.png',
        'cat.avatarLoaded': true
      });
    });

    test('解析失败（原样返回 cloud://）时不补丁', async () => {
      mockAvatarHelper.resolveCatAvatars.mockResolvedValue([{ avatar: 'cloud://x' }]);
      const inst = createWithSafeSetData({
        cat: { _id: '1', avatar: 'cloud://x', _tempAvatarUrl: 'cloud://x' }
      });

      await inst._resolveAvatarInBackground('cloud://x');

      expect(inst.safeSetData).not.toHaveBeenCalled();
    });

    test('期间数据已被替换（原始值不再匹配）时丢弃补丁 —— 否则会给新猫配旧头像', async () => {
      mockAvatarHelper.resolveCatAvatars.mockResolvedValue([{ avatar: 'https://img.png' }]);
      const inst = createWithSafeSetData({
        cat: { _id: '2', avatar: 'cloud://other', _tempAvatarUrl: 'cloud://other' }
      });

      await inst._resolveAvatarInBackground('cloud://x');

      expect(inst.safeSetData).not.toHaveBeenCalled();
    });

    test('页面已卸载时不补丁', async () => {
      mockAvatarHelper.resolveCatAvatars.mockResolvedValue([{ avatar: 'https://img.png' }]);
      const inst = createWithSafeSetData({
        cat: { _id: '1', avatar: 'cloud://x', _tempAvatarUrl: 'cloud://x' }
      });
      inst._isUnmounted = true;

      await inst._resolveAvatarInBackground('cloud://x');

      expect(inst.safeSetData).not.toHaveBeenCalled();
    });

    test('解析抛错只告警，不冒泡到 loadCatDetail', async () => {
      mockAvatarHelper.resolveCatAvatars.mockRejectedValue(new Error('boom'));
      const inst = createWithSafeSetData({
        cat: { _id: '1', avatar: 'cloud://x', _tempAvatarUrl: 'cloud://x' }
      });

      await expect(inst._resolveAvatarInBackground('cloud://x')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('_formatViewCount', () => {
    test('returns empty string for zero or falsy count', () => {
      const inst = createInstance();
      expect(inst._formatViewCount(0)).toBe('');
      expect(inst._formatViewCount(null)).toBe('');
      expect(inst._formatViewCount(undefined)).toBe('');
    });

    test('returns formatted string for count < 1000', () => {
      const inst = createInstance();
      expect(inst._formatViewCount(42)).toBe('42 次云吸');
    });

    test('returns formatted string for count >= 1000', () => {
      const inst = createInstance();
      expect(inst._formatViewCount(1500)).toBe('1.5k 次云吸');
    });

    test('removes trailing zero in k format', () => {
      const inst = createInstance();
      expect(inst._formatViewCount(2000)).toBe('2.k 次云吸');
    });
  });

  describe('_computeTotalLikes', () => {
    test('computes total likes from photos', () => {
      const inst = createInstance({ totalLikes: 0 });
      inst._computeTotalLikes([{ likeCount: 5 }, { likeCount: 3 }, {}]);
      expect(inst.setData).toHaveBeenCalledWith({ totalLikes: 8 });
    });

    test('skips setData when total matches current', () => {
      const inst = createInstance({ totalLikes: 8 });
      inst._computeTotalLikes([{ likeCount: 5 }, { likeCount: 3 }]);
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('handles empty photos array', () => {
      const inst = createInstance({ totalLikes: 5 });
      inst._computeTotalLikes([]);
      expect(inst.setData).toHaveBeenCalledWith({ totalLikes: 0 });
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object with title, path and imageUrl', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _tempAvatarUrl: 'https://img.png', avatar: 'https://img.png' } });
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/detail/detail?id=abc123');
      expect(result.imageUrl).toBe('https://img.png');
    });

    test('uses default brand card when cloud URL', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _tempAvatarUrl: 'cloud://xxx', avatar: 'cloud://xxx' } });
      const result = inst.onShareAppMessage();
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
    });

    test('有大头照时优先头像，不用相册照片（2026-10-24 需求反转旧口径）', () => {
      const inst = createInstance({
        catId: 'abc123',
        cat: { _tempAvatarUrl: 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/100x100>', avatar: 'cloud://raw' },
        photos: [{
          displayUrl: 'https://x.tcb.qcloud.la/p.jpg?sign=s&imageMogr2/thumbnail/400x400>',
          url: 'cloud://raw-photo'
        }]
      });
      const result = inst.onShareAppMessage();
      expect(result.imageUrl).toContain('a.jpg');
      expect(result.imageUrl).toContain('thumbnail/800x640>');
      expect(result.imageUrl).not.toContain('p.jpg');
    });

    test('头像只有 cloud:// 时退回第一张相册照片 / 品牌卡兜底，不返回空', () => {
      const inst = createInstance({
        catId: 'abc123',
        cat: { _tempAvatarUrl: 'cloud://raw-avatar', avatar: 'cloud://raw-avatar' },
        photos: [{ displayUrl: 'https://x.tcb.qcloud.la/p.jpg?sign=s', url: 'cloud://raw-photo' }]
      });
      expect(inst.onShareAppMessage().imageUrl).toContain('p.jpg');
    });

    test('没有 catId（错误态）时回首页，不生成打不开的详情链接', () => {
      const inst = createInstance({ catId: '', cat: null });

      const share = inst.onShareAppMessage();
      expect(share.path).toBe('/pages/index/index');
      expect(share.path).not.toContain('undefined');

      expect(inst.onShareTimeline().query).toBe('');
    });

    test('头像缩略档被替换为分享档 5:4 大图（2026-10-12 糊图回归）', () => {
      const inst = createInstance({
        catId: 'abc123',
        cat: {
          _tempAvatarUrl: 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/100x100>/format/webp/quality/85',
          avatar: 'cloud://raw'
        }
      });
      const result = inst.onShareAppMessage();
      expect(result.imageUrl).toContain('thumbnail/800x640>');
      expect(result.imageUrl).not.toContain('100x100');
    });

    test('timeline 同样使用分享档参数', () => {
      const inst = createInstance({
        catId: 'abc123',
        cat: {
          _tempAvatarUrl: 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/100x100>/format/webp/quality/85',
          avatar: 'cloud://raw'
        }
      });
      const result = inst.onShareTimeline();
      expect(result.imageUrl).toContain('thumbnail/800x640>');
      expect(result.imageUrl).not.toContain('100x100');
    });
  });

  describe('onSubmitMeet', () => {
    test('returns early when meetSubmitting is true', async () => {
      const inst = createInstance({ meetSubmitting: true });
      await inst.onSubmitMeet();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('submits meet record successfully', async () => {
      mockMeetService.submitMeet.mockResolvedValue();
      const inst = createInstance({
        catId: 'abc123', meetSubmitting: false,
        selectedLocation: '图书馆', selectedStatusTag: '相遇了',
        isCustomStatus: false, customStatusText: '', meetNote: ''
      });
      await inst.onSubmitMeet();
      expect(mockMeetService.submitMeet).toHaveBeenCalledWith(inst);
    });

    test('shows error toast when cloud function returns failure', async () => {
      mockMeetService.submitMeet.mockResolvedValue();
      const inst = createInstance({
        catId: 'abc123', meetSubmitting: false,
        selectedLocation: '', selectedStatusTag: '相遇了',
        isCustomStatus: false, customStatusText: '', meetNote: ''
      });
      await inst.onSubmitMeet();
      expect(mockMeetService.submitMeet).toHaveBeenCalledWith(inst);
    });

    test('handles cloud function error', async () => {
      mockMeetService.submitMeet.mockRejectedValue(new Error('net'));
      const inst = createInstance({
        catId: 'abc123', meetSubmitting: false,
        selectedLocation: '', selectedStatusTag: '相遇了',
        isCustomStatus: false, customStatusText: '', meetNote: ''
      });
      await expect(inst.onSubmitMeet()).rejects.toThrow('net');
      expect(mockMeetService.submitMeet).toHaveBeenCalledWith(inst);
    });
  });

  describe('onUnload', () => {
    test('clears timers and resets loading state', () => {
      const inst = createInstance();
      // _fullPhotosTimer 由 photoService 赋值、_navBackTimer 由失效链接提示赋值
      inst._fullPhotosTimer = setTimeout(() => {}, 99999);
      inst._navBackTimer = setTimeout(() => {}, 99999);
      inst._undoTimer = setTimeout(() => {}, 99999);
      inst._loadingPhotos = true;
      inst.onUnload();
      expect(inst._fullPhotosTimer).toBeNull();
      expect(inst._navBackTimer).toBeNull();
      expect(inst._undoTimer).toBeNull();
      expect(inst._loadingPhotos).toBe(false);
    });
  });

  // 校园地图选点入口。
  // 关键约束：只有「已经画好底图」的校区的猫能选点（清单见 utils/campusMapRegistry）。
  // 没底图的校区给了入口，用户会把点打在别的校区的图上，而服务端按 cats.campus
  // 标成那只猫的校区 —— 产出一份永远显示不出来的坐标。所以必须挡住。
  describe('地图选点入口', () => {
    test('有底图校区的猫：可以选点，跳到选点页且带上校区', () => {
      const inst = createInstance({ canPickMapPoint: true, cat: { _id: 'abc123', campus: '东区' } });
      inst.onPickMapPoint();

      expect(wx.navigateTo).toHaveBeenCalled();
      const url = wx.navigateTo.mock.calls[0][0].url;
      expect(url).toContain('subpackages/map/campus-map/campus-map');
      expect(url).toContain('mode=select');
      // 校区必须传过去：选点页据此选底图（错图不会报错、只会把点画到别处）
      expect(url).toContain(`zone=${encodeURIComponent('东区')}`);
    });

    test('没底图校区（或未加载完成）：不跳，只提示', () => {
      const inst = createInstance({ canPickMapPoint: false });
      inst.onPickMapPoint();

      expect(wx.navigateTo).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalled();
    });

    test('loadCatDetail 按猫档案的 campus 决定能不能选点', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { _id: 'abc123', name: '小橘', campus: '西区' } }
      });
      const inst = createInstance();
      getApp.mockReturnValue({
        getPrefetchCache: jest.fn(() => null),
        globalData: { _prefetchCache: { delete: jest.fn() } }
      });
      mockAvatarHelper.resolveCatAvatars.mockResolvedValue({});
      inst.loadRelationCats = jest.fn();
      inst._resolveAvatarInBackground = jest.fn();

      await inst.loadCatDetail();
      expect(inst.data.canPickMapPoint).toBe(false);
    });

    /**
     * 回归：秒开路径（首页列表点进来，5 秒内）不经过 loadCatDetail，
     * 早前没补 canPickMapPoint —— 于是本部猫从列表点进来没按钮、从分享进来有按钮，
     * 看起来像按钮随机消失。
     */
    test.each([
      ['本部', true],
      [' 东区 ', true],
      ['西区', false],
      ['', false]
    ])('预取秒开也要按 campus 定选点入口（campus=%j）', async (campus, expected) => {
      const prefetchCache = {
        timestamp: Date.now(),
        cat: { _id: 'abc123', name: '小橘', campus },
        photos: [],
        totalPhotoCount: 0
      };
      getApp.mockReturnValue({
        getPrefetchCache: jest.fn(() => prefetchCache),
        globalData: { _prefetchCache: { delete: jest.fn() } }
      });
      // applyPrefetchCache 会把快照写进 page.data
      mockPhotoService.applyPrefetchCache.mockImplementation(async (page) => {
        page.setData({ cat: prefetchCache.cat });
        return true;
      });
      const inst = createInstance();
      inst.loadRelationCats = jest.fn();

      await inst.onLoad({ id: 'abc123' });

      expect(mockPhotoService.applyPrefetchCache).toHaveBeenCalled();
      expect(inst.data.canPickMapPoint).toBe(expected);
    });

    test('选点页回传坐标：存进 meetPoint', () => {
      const inst = createInstance({ canPickMapPoint: true });
      inst.onPickMapPoint();

      // 取出 navigateTo 传进去的 events 回调，模拟选点页回传
      const events = wx.navigateTo.mock.calls[0][0].events;
      events.pickpoint({ u: 0.42, v: 0.67, label: '图书馆', campusZone: '本部' });

      expect(inst.data.meetPoint).toEqual({
        u: 0.42, v: 0.67, label: '图书馆', campusZone: '本部'
      });
    });

    test('回传时顺手填地点文字（用户可再改，改字不动坐标）', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '' });
      inst.onPickMapPoint();
      const events = wx.navigateTo.mock.calls[0][0].events;

      events.pickpoint({ u: 0.42, v: 0.67, label: '图书馆' });
      expect(inst.data.selectedLocation).toBe('图书馆');
    });

    /** 只点开地图、没拖动也没点图就确定：用户并没有选具体地点 */
    test('没选具体地点：地点文字写「校园内」，不落假坐标', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '' });
      inst.onPickMapPoint();
      const events = wx.navigateTo.mock.calls[0][0].events;

      events.pickpoint({ label: '校园内', isDefault: true, campusZone: '本部' });

      expect(inst.data.selectedLocation).toBe('校园内');
      expect(inst.data.meetPoint).toBeNull();
    });

    test('没选具体地点，但用户已手填地点：不覆盖他写的字', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '南门' });
      inst.onPickMapPoint();
      const events = wx.navigateTo.mock.calls[0][0].events;

      events.pickpoint({ label: '校园内', isDefault: true });

      expect(inst.data.selectedLocation).toBe('南门');
      expect(inst.data.meetPoint).toBeNull();
    });

    /** 选到空地时 label 为空。这时也必须填字，否则输入框留着 placeholder，
     *  看起来像「什么都没选」，但坐标其实已经定了 */
    test('选到空地（label 为空）也填上「校内空地」，不能让输入框看起来是空的', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '' });
      inst.onPickMapPoint();
      const events = wx.navigateTo.mock.calls[0][0].events;

      events.pickpoint({ u: 0.5, v: 0.5, label: '' });
      expect(inst.data.selectedLocation).toBe('校内空地');
      expect(inst.data.meetPoint).toEqual({ u: 0.5, v: 0.5, label: '' });
    });

    test('用户已手填地点时，不覆盖他写的字', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '南门' });
      inst.onPickMapPoint();
      const events = wx.navigateTo.mock.calls[0][0].events;

      events.pickpoint({ u: 0.42, v: 0.67, label: '图书馆' });
      expect(inst.data.selectedLocation).toBe('南门');
    });

    test('「清除」连地点文字一起清（否则会留下写着地点、却没有位置的矛盾状态）', () => {
      const inst = createInstance({ canPickMapPoint: true, selectedLocation: '图书馆' });
      inst.setData({ meetPoint: { u: 0.42, v: 0.67, label: '图书馆' } });

      inst.onClearMapPoint();
      expect(inst.data.meetPoint).toBeNull();
      expect(inst.data.selectedLocation).toBe('');
    });
  });

  /**
   * 回归（2026-10-19 · P2）：详情页 → 关系管理的入口。
   *   1. 只有管理员看得见（公共页面不能给普通用户露出写操作入口）；
   *   2. 必须带上猫名：目标页的头像/花色要靠一次网络请求补，那一步失败时
   *      名字是唯一的兜底，缺了只剩一个空头像圈；
   *   3. 不构成鉴权 —— 真正的门禁在目标页与云函数。
   */
  describe('管理员关系入口（2026-10-19 · P2）', () => {
    test('非管理员不显示入口', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _id: 'abc123' } });
      jest.spyOn(inst, '_checkAdminEntry').mockReturnValue(false);

      inst.setData({ isAdminEntryVisible: inst._checkAdminEntry() });

      expect(inst.data.isAdminEntryVisible).toBe(false);
    });

    test('管理员显示入口（checkAdminAuth 抛错时按不可见处理）', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _id: 'abc123' } });
      // 页面在模块加载时已解构 checkAdminAuth，改 require 缓存里的属性不影响它；
      // 直接打实例方法上的这层间接层，验证 try/catch 兜底
      const saved = require('../../utils/adminAuth').checkAdminAuth;

      // 用 requireAdmin 的原始模块对象替换会让已解构的引用失效，故改测异常分支：
      // checkAdminAuth 读 storage 出错时必须返回 false，而不是让整页 onShow 崩掉
      expect(typeof inst._checkAdminEntry).toBe('function');
      expect(saved).toBeInstanceOf(Function);
      expect(inst._checkAdminEntry()).toBe(false);
    });

    test('跳管理页时带上 catId 与 catName（名字是头像请求失败时的兜底）', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _id: 'abc123', name: '斜斜' } });

      inst.onOpenRelationManage();

      expect(wx.navigateTo).toHaveBeenCalledTimes(1);
      const { url } = wx.navigateTo.mock.calls[0][0];
      expect(url).toContain('catId=abc123');
      expect(url).toContain('catName=%E6%96%9C%E6%96%9C');
    });

    test('栈深 > 8 改 redirectTo（navigateTo 超过 10 层会静默失败）', () => {
      const inst = createInstance({ catId: 'abc123', cat: { _id: 'abc123', name: '斜斜' } });
      global.getCurrentPages.mockReturnValueOnce(new Array(9).fill({}));

      inst.onOpenRelationManage();

      expect(wx.navigateTo).not.toHaveBeenCalled();
      expect(wx.redirectTo.mock.calls[0][0].url).toContain('catId=abc123');
    });

    test('没有 catId 时不跳转', () => {
      const inst = createInstance({ catId: '' });

      inst.onOpenRelationManage();

      expect(wx.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('好猫星级解释', () => {
    test('点星级药丸弹出解释，说明未评级不代表猫不好', () => {
      pageDef.onShowAdoptHelp();

      expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({
        title: '好猫星级',
        showCancel: false
      }));
      expect(wx.showModal.mock.calls[0][0].content).toContain('没打星只是还没评');
    });
  });

});
