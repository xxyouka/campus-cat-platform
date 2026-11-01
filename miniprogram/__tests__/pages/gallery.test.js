const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), handleGlobalError: jest.fn(), handleUnhandledRejection: jest.fn(), initGlobalErrorCatch: jest.fn() };
const mockPerfMonitor = { monitorPageLoad: jest.fn((_, fn) => fn()), monitorApi: jest.fn((_, fn) => fn()) };
const mockObsHelper = { isAvailable: jest.fn(), trySetup: jest.fn(), reportEvent: jest.fn(), EVENT_NAMES: {} };
const mockImageLoader = { preloadAboveFold: jest.fn(), preloadBelowFold: jest.fn(), getTempUrls: jest.fn(() => Promise.resolve({})) };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/performanceMonitor', () => mockPerfMonitor);
jest.mock('../../utils/obsHelper', () => mockObsHelper);
jest.mock('../../utils/imageLoader', () => mockImageLoader);
jest.mock('../../behaviors/backToTopBehavior', () => ({}));
jest.mock('../../behaviors/cacheBehavior', () => ({}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/gallery/gallery');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReturnValue('');
  wx.setStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: [], hasMore: false } } });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _loadingAlbums: false,
    _preloadTimer: null,
    _preloadTimer1: null,
    _scrollTopTimer: null,
    loadWithCache: jest.fn((cb) => cb()),
    // cacheBehavior 的真实方法；首屏加载成功后 loadCatAlbums 会调它记账
    updateCacheTime: jest.fn(),
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

describe('gallery page', () => {
  describe('onLoad', () => {
    test('sets statusBarHeight', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ statusBarHeight: expect.any(Number) }));
    });

    test('reports view gallery event', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(mockObsHelper.reportEvent).toHaveBeenCalled();
    });

    test('calls loadCatAlbums via monitorPageLoad', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(mockPerfMonitor.monitorPageLoad).toHaveBeenCalledWith('gallery', expect.any(Function));
    });
  });

  describe('onShow', () => {
    test('skips when loading', () => {
      const inst = createInstance({ loading: true });
      inst.onShow();
      expect(inst.loadWithCache).not.toHaveBeenCalled();
    });

    test('skips when _loadingAlbums is true', () => {
      const inst = createInstance({ loading: false });
      inst._loadingAlbums = true;
      inst.onShow();
      expect(inst.loadWithCache).not.toHaveBeenCalled();
    });

    test('calls loadWithCache when not loading', () => {
      const inst = createInstance({ loading: false });
      inst.onShow();
      expect(inst.loadWithCache).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ validTime: 30000 }));
    });
  });

  // 回归（2026-10-18 云函数慢日志复盘）：首屏走 onLoad → loadCatAlbums，
  // 不经过 loadWithCache，而记账只发生在 loadWithCache 内部 →
  // _cacheLastLoadTime 恒为 0，onShow 的 30s 去重（isCacheValid）永远判 false，
  // 每次切回相册都重发一次完整 getAlbumsWithInfo（线上日志：同一用户 28s 内两次）。
  describe('30s Tab 去重的记账', () => {
    test('首屏加载成功后记账（否则 onShow 永远命中不了缓存窗口）', async () => {
      const inst = createInstance();
      await inst.loadCatAlbums(true);
      expect(inst.updateCacheTime).toHaveBeenCalled();
    });

    test('加载失败不记账：错误态重试不能被 30s 窗口挡住', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: 'boom' } });
      await inst.loadCatAlbums(true);
      expect(inst.data.loadError).toBe(true);
      expect(inst.updateCacheTime).not.toHaveBeenCalled();
    });

    test('加载更多（reset=false）不记账：分页不该续期首屏的缓存窗口', async () => {
      const inst = createInstance({ albums: [{ catId: 'a' }], albumPage: 1, hasMoreAlbums: true });
      await inst.loadCatAlbums(false);
      expect(inst.updateCacheTime).not.toHaveBeenCalled();
    });
  });

  describe('loadCatAlbums', () => {
    test('静默刷新重建分页，重新加载最新的第二页', async () => {
      const first = [{ catId: 'a' }];
      const second = [{ catId: 'b' }];
      const third = [{ catId: 'c' }];
      wx.cloud.callFunction
        .mockResolvedValueOnce({ result: { success: true, data: { albums: first, total: 3, hasMore: true } } })
        .mockResolvedValueOnce({ result: { success: true, data: { albums: third, total: 3, hasMore: false } } });
      const inst = createInstance({ albums: [...first, ...second], albumPage: 2, hasMoreAlbums: true });
      await inst.loadCatAlbums(true, { silent: true });
      expect(inst.data.albumPage).toBe(1);
      expect(inst.data.albums.map(a => a.catId)).toEqual(['a']);
      await inst.loadCatAlbums(false);
      expect(wx.cloud.callFunction.mock.calls[1][0].data.page).toBe(1);
      expect(inst.data.albums.map(a => a.catId)).toEqual(['a', 'c']);
    });

    test('分页结果全部重复时仍推进页码', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: [{ catId: 'a' }], hasMore: true } } });
      const inst = createInstance({ albums: [{ catId: 'a' }], albumPage: 1 });
      await inst.loadCatAlbums(false);
      expect(inst.data.albumPage).toBe(2);
      expect(inst.data.hasMoreAlbums).toBe(true);
    });

    test('prevents concurrent loading', async () => {
      const inst = createInstance();
      inst._loadingAlbums = true;
      await inst.loadCatAlbums();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('resets state when reset is true', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: [], hasMore: false } } });
      const inst = createInstance({ albumPage: 3, hasMoreAlbums: false, albums: [{ _id: '1' }] });
      await inst.loadCatAlbums(true);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        albumPage: 0, hasMoreAlbums: true, albums: [], loading: true
      }));
    });

    test('loads albums and increments page', async () => {
      const albums = [{ catId: 'c1', coverUrl: 'https://img.png', catAvatar: 'https://a.png' }];
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums, hasMore: true } } });
      mockImageLoader.getTempUrls.mockResolvedValue({});
      const inst = createInstance({ albumPage: 0 });
      await inst.loadCatAlbums();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        albumPage: 1, hasMoreAlbums: true, loading: false
      }));
    });

    test('deduplicates albums by catId', async () => {
      const albums = [
        { catId: 'c1', coverUrl: 'https://1.png' },
        { catId: 'c1', coverUrl: 'https://2.png' },
        { catId: 'c2', coverUrl: 'https://3.png' }
      ];
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums, hasMore: false } } });
      mockImageLoader.getTempUrls.mockResolvedValue({});
      const inst = createInstance({ albumPage: 0 });
      await inst.loadCatAlbums();
      const setDataCalls = inst.setData.mock.calls;
      const lastAlbums = setDataCalls.find(c => c[0].albums)?.[0].albums;
      const catIds = lastAlbums?.map(a => a.catId);
      expect(catIds).toEqual(['c1', 'c2']);
    });

    test('deduplicates against existing albums', async () => {
      const existingAlbums = [{ catId: 'c1', coverUrl: 'https://1.png' }];
      const newAlbums = [{ catId: 'c1', coverUrl: 'https://2.png' }, { catId: 'c2', coverUrl: 'https://3.png' }];
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: newAlbums, hasMore: false } } });
      mockImageLoader.getTempUrls.mockResolvedValue({});
      const inst = createInstance({ albumPage: 1, albums: existingAlbums });
      await inst.loadCatAlbums();
      const setDataCalls = inst.setData.mock.calls;
      const lastAlbums = setDataCalls.find(c => c[0].albums)?.[0].albums;
      const catIds = lastAlbums?.map(a => a.catId);
      expect(catIds).toEqual(['c1', 'c2']);
    });

    test('handles server error', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: 'fail' } });
      const inst = createInstance({ albumPage: 0 });
      await inst.loadCatAlbums();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    test('handles cloud function exception', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ albumPage: 0 });
      await inst.loadCatAlbums();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    test('sets loading false in finally block', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: [], hasMore: false } } });
      const inst = createInstance({ albumPage: 0 });
      await inst.loadCatAlbums();
      expect(inst._loadingAlbums).toBe(false);
    });
  });

  describe('onLoadMoreAlbums', () => {
    test('calls loadCatAlbums when hasMore and not loading', () => {
      const inst = createInstance({ hasMoreAlbums: true });
      inst._loadingAlbums = false;
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onLoadMoreAlbums();
      expect(spy).toHaveBeenCalledWith(false);
    });

    test('does not call loadCatAlbums when no more albums', () => {
      const inst = createInstance({ hasMoreAlbums: false });
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onLoadMoreAlbums();
      expect(spy).not.toHaveBeenCalled();
    });

    test('does not call loadCatAlbums when already loading', () => {
      const inst = createInstance({ hasMoreAlbums: true });
      inst._loadingAlbums = true;
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onLoadMoreAlbums();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('onEnterCatAlbum', () => {
    test('navigates to cat-album page with params', () => {
      const inst = createInstance();
      inst.onEnterCatAlbum({
        currentTarget: {
          dataset: { catId: 'c1', catName: '橘猫', photoCount: 5, avatar: 'https://a.png' }
        }
      });
      expect(wx.navigateTo).toHaveBeenCalledWith({
        url: expect.stringContaining('/pages/gallery/cat-album?catId=c1')
      });
    });

    test('returns early when catId is missing', () => {
      const inst = createInstance();
      inst.onEnterCatAlbum({ currentTarget: { dataset: {} } });
      expect(wx.navigateTo).not.toHaveBeenCalled();
    });

    test('encodes catName and avatar in URL', () => {
      const inst = createInstance();
      inst.onEnterCatAlbum({
        currentTarget: {
          dataset: { catId: 'c1', catName: '橘 猫', photoCount: 3, avatar: 'cloud://x' }
        }
      });
      const url = wx.navigateTo.mock.calls[0][0].url;
      expect(url).toContain(encodeURIComponent('橘 猫'));
      expect(url).toContain(encodeURIComponent('cloud://x'));
    });
  });

  describe('convertAlbumCovers', () => {
    test('returns albums as-is when empty', async () => {
      const inst = createInstance();
      const result = await inst.convertAlbumCovers([]);
      expect(result).toEqual([]);
    });

    test('returns albums as-is when null', async () => {
      const inst = createInstance();
      const result = await inst.convertAlbumCovers(null);
      expect(result).toBeNull();
    });

    test('converts cloud:// coverUrl', async () => {
      mockImageLoader.getTempUrls.mockResolvedValue({ 'cloud://cover1': 'https://cdn.png' });
      const inst = createInstance();
      const albums = [{ coverUrl: 'cloud://cover1', catAvatar: 'https://a.png' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(result[0].coverUrl).toBe('https://cdn.png');
    });

    test('marks _coverUrlFailed when URL resolution fails', async () => {
      mockImageLoader.getTempUrls.mockResolvedValue({ 'cloud://cover1': null });
      const inst = createInstance();
      const albums = [{ coverUrl: 'cloud://cover1', catAvatar: 'https://a.png' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(result[0]._coverUrlFailed).toBe(true);
    });

    test('converts cloud:// catAvatar when different from coverUrl', async () => {
      mockImageLoader.getTempUrls.mockResolvedValue({
        'cloud://cover1': 'https://cdn.png',
        'cloud://avatar1': 'https://av.png'
      });
      const inst = createInstance();
      const albums = [{ coverUrl: 'cloud://cover1', catAvatar: 'cloud://avatar1' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(result[0].catAvatar).toBe('https://av.png');
    });

    test('skips catAvatar when same as coverUrl', async () => {
      mockImageLoader.getTempUrls.mockResolvedValue({ 'cloud://same': 'https://cdn.png' });
      const inst = createInstance();
      const albums = [{ coverUrl: 'cloud://same', catAvatar: 'cloud://same' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(result[0].catAvatar).toBe('cloud://same');
      expect(mockImageLoader.getTempUrls).toHaveBeenCalledWith(['cloud://same'], expect.any(Object));
    });

    test('marks _catAvatarFailed when avatar resolution fails', async () => {
      mockImageLoader.getTempUrls.mockResolvedValue({
        'cloud://cover1': 'https://cdn.png',
        'cloud://avatar1': null
      });
      const inst = createInstance();
      const albums = [{ coverUrl: 'cloud://cover1', catAvatar: 'cloud://avatar1' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(result[0]._catAvatarFailed).toBe(true);
    });

    test('skips non-cloud URLs', async () => {
      const inst = createInstance();
      const albums = [{ coverUrl: 'https://cdn.png', catAvatar: 'https://av.png' }];
      const result = await inst.convertAlbumCovers(albums);
      expect(mockImageLoader.getTempUrls).not.toHaveBeenCalled();
      expect(result[0].coverUrl).toBe('https://cdn.png');
    });
  });

  describe('onImageError', () => {
    test('marks album cover invalid', () => {
      const inst = createInstance({ albums: [{ _hasValidCover: true }] });
      inst.onImageError({ currentTarget: { dataset: { index: 0, type: 'album' } } });
      expect(inst.setData).toHaveBeenCalledWith({ 'albums[0]._hasValidCover': false });
    });

    test('does nothing for non-album type', () => {
      const inst = createInstance({ albums: [{ _hasValidCover: true }] });
      inst.onImageError({ currentTarget: { dataset: { index: 0, type: 'other' } } });
      expect(inst.setData).not.toHaveBeenCalled();
    });
  });

  describe('onPullDownRefresh', () => {
    test('resets and reloads albums', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { albums: [], hasMore: false } } });
      const inst = createInstance();
      await inst.onPullDownRefresh();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('onReachBottom', () => {
    test('loads more albums when available', () => {
      const inst = createInstance({ hasMoreAlbums: true, albumsLoading: false });
      inst._loadingAlbums = false;
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onReachBottom();
      expect(spy).toHaveBeenCalledWith(false);
    });

    test('does not load more when no more albums', () => {
      const inst = createInstance({ hasMoreAlbums: false, albumsLoading: false });
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onReachBottom();
      expect(spy).not.toHaveBeenCalled();
    });

    test('does not load more when already loading', () => {
      const inst = createInstance({ hasMoreAlbums: true, albumsLoading: true });
      inst._loadingAlbums = true;
      const spy = jest.fn();
      inst.loadCatAlbums = spy;
      inst.onReachBottom();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object with title and path', () => {
      const inst = createInstance();
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/gallery/gallery');
    });

    test('分享图取第一张相册封面，并换成 5:4 分享档', () => {
      const inst = createInstance({
        albums: [{
          coverUrl: 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/400x400>/format/webp/quality/85'
        }]
      });
      const result = inst.onShareAppMessage();
      expect(result.imageUrl).toContain('thumbnail/800x640>');
      expect(result.imageUrl).not.toContain('400x400');
    });

    test('封面还是 cloud:// 时不传 imageUrl（宁可不带图，也不拿默认头像冒充）', () => {
      const inst = createInstance({ albums: [{ coverUrl: 'cloud://env/albums/a.jpg' }] });
      const result = inst.onShareAppMessage();
      expect(result.imageUrl).toBeUndefined();
    });
  });

  describe('onShareTimeline', () => {
    test('returns share object with title and query', () => {
      const inst = createInstance();
      const result = inst.onShareTimeline();
      expect(result).toHaveProperty('title');
      expect(result.query).toBe('');
    });

    test('朋友圈同样带第一张相册封面', () => {
      const inst = createInstance({ albums: [{ catAvatar: 'https://img.example.com/a.png' }] });
      const result = inst.onShareTimeline();
      expect(result.imageUrl).toBe('https://img.example.com/a.png');
    });
  });

  describe('onUnload', () => {
    test('clears timers and resets loading state', () => {
      const inst = createInstance();
      inst._preloadTimer = setTimeout(() => {}, 99999);
      inst._preloadTimer1 = setTimeout(() => {}, 99999);
      inst._scrollTopTimer = setTimeout(() => {}, 99999);
      inst._loadingAlbums = true;
      inst.onUnload();
      expect(inst._preloadTimer).toBeNull();
      expect(inst._preloadTimer1).toBeNull();
      expect(inst._scrollTopTimer).toBeNull();
      expect(inst._loadingAlbums).toBe(false);
    });

    test('handles missing timers gracefully', () => {
      const inst = createInstance();
      inst._preloadTimer = null;
      inst._preloadTimer1 = null;
      inst._scrollTopTimer = null;
      expect(() => inst.onUnload()).not.toThrow();
    });
  });

  describe('_preloadFirstScreenAlbums', () => {
    test('preloads cloud:// cover URLs', () => {
      const inst = createInstance({
        albums: [
          { coverUrl: 'cloud://1' },
          { coverUrl: 'https://cdn.png' },
          { catAvatar: 'cloud://2', coverUrl: 'cloud://3' }
        ]
      });
      inst._preloadFirstScreenAlbums(10);
      expect(mockImageLoader.preloadAboveFold).toHaveBeenCalledWith(
        expect.arrayContaining(['cloud://1', 'cloud://3']),
        'thumbnail'
      );
    });

    test('skips when no albums', () => {
      const inst = createInstance({ albums: [] });
      inst._preloadFirstScreenAlbums(10);
      expect(mockImageLoader.preloadAboveFold).not.toHaveBeenCalled();
    });

    test('respects count parameter', () => {
      const albums = Array(20).fill(null).map((_, i) => ({ coverUrl: `cloud://${i}` }));
      const inst = createInstance({ albums });
      inst._preloadFirstScreenAlbums(5);
      const calledIds = mockImageLoader.preloadAboveFold.mock.calls[0][0];
      expect(calledIds.length).toBeLessThanOrEqual(5);
    });
  });

  // ---- 离线缓存先行渲染 + 静默刷新（相册 tab 的 SWR） ----
  describe('离线缓存（SWR）', () => {
    const CACHED = [
      { catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover1', catAvatar: 'cloud://cover1', photoCount: 2 },
      { catId: 'c2', catName: '狸花', coverUrl: 'cloud://cover2', catAvatar: 'cloud://cover2', photoCount: 3 }
    ];

    /** 让 offlineCache.getAlbums() 命中（时间戳取当下，未过期） */
    function useCache(albums = CACHED) {
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_offline_albums') return albums;
        if (key === '_offline_albums_time') return Date.now();
        return '';
      });
    }

    function flushAsync() {
      return new Promise(resolve => setTimeout(resolve, 0));
    }

    function lastAlbumsSetData(inst) {
      return inst.setData.mock.calls.filter(c => Array.isArray(c[0].albums)).pop();
    }

    test('onLoad 命中缓存：立即渲染且不置 loading', () => {
      useCache();

      const inst = createInstance();
      inst.onLoad();

      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        albums: CACHED, loading: false
      }));
    });

    test('onLoad 命中缓存后走静默刷新：不出现「清空列表 + 转 loading」的骨架屏分支', async () => {
      useCache();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            albums: [{ catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover1', photoCount: 9 }],
            hasMore: false
          }
        }
      });

      const inst = createInstance();
      inst.onLoad();
      await flushAsync();

      const cleared = inst.setData.mock.calls.find(
        c => Array.isArray(c[0].albums) && c[0].albums.length === 0
      );
      expect(cleared).toBeUndefined();
    });

    test('静默刷新替换旧列表，同时更新相册信息', async () => {
      useCache();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            albums: [{ catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover1', photoCount: 9 }],
            total: 25,
            hasMore: true
          }
        }
      });

      const inst = createInstance();
      inst.onLoad();
      await flushAsync();

      const call = lastAlbumsSetData(inst);
      expect(call[0].albums.map(a => a.catId)).toEqual(['c1']);
      expect(call[0].albums[0].photoCount).toBe(9);
      // 分页口径：缓存渲染后从第 0 页起，刷新成功推进到第 1 页
      expect(call[0].albumPage).toBe(1);
      expect(call[0].hasMoreAlbums).toBe(true);
    });

    test('静默刷新遇「第一页就是全部」时整批替换：已删除的相册不能靠合并留在列表里', async () => {
      useCache();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            albums: [{ catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover1', photoCount: 1 }],
            total: 1,
            hasMore: false
          }
        }
      });

      const inst = createInstance();
      inst.onLoad();
      await flushAsync();

      const call = lastAlbumsSetData(inst);
      expect(call[0].albums.map(a => a.catId)).toEqual(['c1']);
      expect(call[0].hasMoreAlbums).toBe(false);
    });

    test('落盘发生在转链之前：缓存里留的是 cloud:// 原值', async () => {
      wx.getStorageSync.mockReturnValue(''); // 无缓存 → 走普通首屏加载
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            albums: [{ catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover1', catAvatar: 'cloud://cover1', photoCount: 2 }],
            hasMore: false
          }
        }
      });
      mockImageLoader.getTempUrls.mockResolvedValue({ 'cloud://cover1': 'https://cdn/cover1.png' });

      const inst = createInstance({ albumPage: 0 });
      inst.onLoad();
      await flushAsync();

      const saved = wx.setStorageSync.mock.calls.find(c => c[0] === '_offline_albums');
      expect(saved).toBeTruthy();
      // 缓存里必须是原始 fileID（临时链接 24h 会过期，下一次冷启动就渲染不出来了）
      expect(saved[1][0].coverUrl).toBe('cloud://cover1');
      // 转链结果只体现在当前列表里（路径 setData：测试桩不会深写 data，直接查 patch 调用）
      const patchCall = inst.setData.mock.calls.find(c => c[0]['albums[0].coverUrl'] !== undefined);
      expect(patchCall[0]['albums[0].coverUrl']).toBe('https://cdn/cover1.png');
      expect(patchCall[0]['albums[0]._coverFileID']).toBe('cloud://cover1');
    });

    test('silent 加载：服务端返回空页时移除旧内容', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { albums: [], hasMore: false } }
      });

      const inst = createInstance({
        albums: [{ catId: 'c1', coverUrl: 'cloud://cover1' }],
        loading: false
      });
      await inst.loadCatAlbums(true, { silent: true });

      const cleared = inst.setData.mock.calls.find(
        c => Array.isArray(c[0].albums) && c[0].albums.length === 0
      );
      expect(cleared).toBeDefined();
      expect(inst.data.albums).toEqual([]);
    });

    test('非 silent 的 reset 仍然清空并转 loading（下拉刷新/错误重试的既有行为不能变）', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { albums: [], hasMore: false } }
      });

      const inst = createInstance({
        albums: [{ catId: 'c1', coverUrl: 'cloud://cover1' }],
        loading: false,
        albumPage: 2
      });
      await inst.loadCatAlbums(true);

      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        albumPage: 0, albums: [], loading: true
      }));
    });

    describe('_mergeAlbums', () => {
      test('同一文件已转过链时保留 http 封面，不打回 cloud://', () => {
        const inst = createInstance({
          albums: [{ catId: 'c1', coverUrl: 'https://cdn/cover1.png', _coverFileID: 'cloud://cover1', photoCount: 2 }]
        });

        const merged = inst._mergeAlbums(inst.data.albums, [
          { catId: 'c1', coverUrl: 'cloud://cover1', catAvatar: 'cloud://cover1', photoCount: 5 }
        ]);

        expect(merged[0].coverUrl).toBe('https://cdn/cover1.png');
        expect(merged[0].photoCount).toBe(5);
      });

      test('封面被换掉（fileID 变了）必须用新值，不能停在旧图', () => {
        const inst = createInstance({
          albums: [{ catId: 'c1', coverUrl: 'https://cdn/old.png', _coverFileID: 'cloud://old', photoCount: 2 }]
        });

        const merged = inst._mergeAlbums(inst.data.albums, [
          { catId: 'c1', coverUrl: 'cloud://new', catAvatar: 'cloud://new', photoCount: 2 }
        ]);

        expect(merged[0].coverUrl).toBe('cloud://new');
      });

      test('新出现的相册追加在末尾，位置不来回跳', () => {
        const inst = createInstance({
          albums: [{ catId: 'c1', coverUrl: 'cloud://cover1' }]
        });

        const merged = inst._mergeAlbums(inst.data.albums, [
          { catId: 'c1', coverUrl: 'cloud://cover1' },
          { catId: 'c9', coverUrl: 'cloud://cover9' }
        ]);

        expect(merged.map(a => a.catId)).toEqual(['c1', 'c9']);
      });
    });
  });
});
