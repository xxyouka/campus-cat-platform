const mockLRUCache = {
  get: jest.fn(),
  set: jest.fn(),
  has: jest.fn(() => false),
  delete: jest.fn(),
  getStats: jest.fn(() => ({ size: 0 })),
  destroy: jest.fn()
};

jest.mock('../config', () => ({
  env: 'development',
  version: '3.1.0',
  cloudEnv: 'test-cloud-env'
}));

jest.mock('../utils/cacheCore', () => ({
  LRUCache: jest.fn(() => mockLRUCache),
  CacheManager: {},
  CACHE_STRATEGY: {}
}));

jest.mock('../utils/obsHelper', () => ({
  isAvailable: jest.fn(() => false),
  trySetup: jest.fn(() => Promise.resolve(false)),
  setCustomId: jest.fn(),
  setCustomProperties: jest.fn(),
  getStatus: jest.fn(() => 'unavailable'),
  reportEvent: jest.fn(() => false),
  EVENT_NAMES: {
    VIEW_CAT: 'view_cat',
    SEARCH_CAT: 'search_cat',
    FILTER_CAMPUS: 'filter_campus',
    MEET_CAT: 'meet_cat',
    FAVORITE_CAT: 'favorite_cat',
    SHARE_CAT: 'share_cat',
    VIEW_GALLERY: 'view_gallery',    ADMIN_LOGIN: 'admin_login',
    ADMIN_ADD_CAT: 'admin_add_cat',
    ADMIN_EDIT_CAT: 'admin_edit_cat',
    ADMIN_ADD_PHOTO: 'admin_add_photo',
    ONBOARDING_COMPLETE: 'onboarding_complete',
    AGREEMENT_ACCEPT: 'agreement_accept',
    GLOBAL_ERROR: 'global_error',
    UNHANDLED_REJECTION: 'unhandled_rejection'
  }
}));

jest.mock('../utils/compat', () => ({
  getWindowInfo: jest.fn(() => ({
    windowHeight: 800,
    windowWidth: 375,
    statusBarHeight: 20,
    pixelRatio: 2
  })),
  getDeviceInfo: jest.fn(() => ({
    brand: 'devtools',
    model: 'devtools',
    system: 'devtools',
    platform: 'devtools'
  }))
}));

jest.mock('../utils/errorHandler', () => {
  const handler = jest.fn().mockImplementation(() => ({}));
  handler.initGlobalErrorCatch = jest.fn();
  handler.handleGlobalError = jest.fn();
  handler.handleUnhandledRejection = jest.fn();
  return handler;
});

jest.mock('../utils/adminAuth', () => ({
  checkAdminAuth: jest.fn(() => false)
}));

jest.mock('../utils/imageLoader', () => ({
  pauseCleanup: jest.fn(),
  resumeCleanup: jest.fn()
}));

let appObj;
let ErrorHandler;

beforeAll(() => {
  jest.resetModules();
  const AppCalls = [];
  global.App = jest.fn(obj => { AppCalls.push(obj); });
  require('../app');
  appObj = AppCalls[0];
  ErrorHandler = require('../utils/errorHandler');
});

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wx.getStorageSync.mockImplementation(() => '');
    wx.setStorageSync.mockImplementation(() => {});
    wx.removeStorageSync.mockImplementation(() => {});
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
    wx.cloud.init.mockReturnValue(undefined);
    wx.getNetworkType.mockImplementation(({ success }) => {
      if (success) success({ networkType: 'wifi' });
    });
    wx.onNetworkStatusChange.mockImplementation(() => {});
    wx.nextTick.mockImplementation(fn => fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('globalData', () => {
    test('should have version from config', () => {
      expect(appObj.globalData.version).toBe('3.1.0');
    });

    test('should have isAdmin initialized as false', () => {
      expect(appObj.globalData.isAdmin).toBe(false);
    });

    test('should have isOnline initialized as true', () => {
      expect(appObj.globalData.isOnline).toBe(true);
    });

    test('should have _prefetchCache as an LRUCache instance', () => {
      expect(appObj.globalData._prefetchCache).toBeDefined();
    });
  });

  describe('onLaunch', () => {
    test('should call initCloud', async () => {
      const initCloudSpy = jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      await appObj.onLaunch();
      expect(initCloudSpy).toHaveBeenCalled();
      initCloudSpy.mockRestore();
    });

    test('should check admin auth', async () => {
      const { checkAdminAuth } = require('../utils/adminAuth');
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      await appObj.onLaunch();
      expect(checkAdminAuth).toHaveBeenCalled();
    });

    test('should set isAdmin from checkAdminAuth result', async () => {
      const { checkAdminAuth } = require('../utils/adminAuth');
      checkAdminAuth.mockReturnValue(true);
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      await appObj.onLaunch();
      expect(appObj.globalData.isAdmin).toBe(true);
    });

    test('should call initOpenId', async () => {
      const initOpenIdSpy = jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      await appObj.onLaunch();
      expect(initOpenIdSpy).toHaveBeenCalled();
      initOpenIdSpy.mockRestore();
    });

    test('should call ErrorHandler.initGlobalErrorCatch', async () => {
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      await appObj.onLaunch();
      expect(ErrorHandler.initGlobalErrorCatch).toHaveBeenCalledWith(appObj);
    });

    test('should call initObs', async () => {
      const initObsSpy = jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      await appObj.onLaunch();
      expect(initObsSpy).toHaveBeenCalled();
      initObsSpy.mockRestore();
    });

    test('should call initNetworkStatus', async () => {
      const initNetworkSpy = jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      await appObj.onLaunch();
      expect(initNetworkSpy).toHaveBeenCalled();
      initNetworkSpy.mockRestore();
    });

    test('should call flushViewRecordQueue', async () => {
      const flushSpy = jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      jest.spyOn(appObj, 'initCloud').mockResolvedValue();
      jest.spyOn(appObj, 'initOpenId').mockResolvedValue();
      jest.spyOn(appObj, 'initObs').mockResolvedValue();
      jest.spyOn(appObj, 'initNetworkStatus').mockImplementation(() => {});
      await appObj.onLaunch();
      expect(flushSpy).toHaveBeenCalled();
      flushSpy.mockRestore();
    });
  });

  describe('initOpenId', () => {
    test('should return early if openid is cached', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return 'cached-openid';
        return '';
      });
      await appObj.initOpenId();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should call cloud function when openid is not cached', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return '';
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, openid: 'new-openid' }
      });
      await appObj.initOpenId();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'getOpenId' });
    });

    test('should save openid to storage on success', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return '';
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, openid: 'new-openid' }
      });
      await appObj.initOpenId();
      expect(wx.setStorageSync).toHaveBeenCalledWith('openid', 'new-openid');
    });

    test('should not save openid if result is not successful', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return '';
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });
      await appObj.initOpenId();
      expect(wx.setStorageSync).not.toHaveBeenCalledWith('openid', expect.anything());
    });

    test('should not throw on cloud function error', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return '';
        return '';
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('cloud error'));
      await expect(appObj.initOpenId()).resolves.toBeUndefined();
    });
  });

  describe('initObs', () => {
    test('should return early if obsHelper is not available', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(false);
      await appObj.initObs();
      expect(obsHelper.trySetup).not.toHaveBeenCalled();
    });

    test('should call trySetup when obsHelper is available', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockResolvedValue(true);
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return 'test-openid';
        return '';
      });
      await appObj.initObs();
      expect(obsHelper.trySetup).toHaveBeenCalled();
    });

    test('should set custom id with openid when ready', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockResolvedValue(true);
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return 'test-openid';
        return '';
      });
      await appObj.initObs();
      expect(obsHelper.setCustomId).toHaveBeenCalledWith('test-openid');
    });

    test('should not set custom id when openid is not available', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockResolvedValue(true);
      wx.getStorageSync.mockImplementation(() => '');
      await appObj.initObs();
      expect(obsHelper.setCustomId).not.toHaveBeenCalled();
    });

    test('should set custom properties when ready', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockResolvedValue(true);
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'openid') return 'test-openid';
        return '';
      });
      await appObj.initObs();
      expect(obsHelper.setCustomProperties).toHaveBeenCalledWith({
        user_type: expect.any(String),
        app_version: expect.any(String)
      });
    });

    test('should not set custom properties when not ready', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockResolvedValue(false);
      await appObj.initObs();
      expect(obsHelper.setCustomProperties).not.toHaveBeenCalled();
    });

    test('should not throw on obsHelper error', async () => {
      const obsHelper = require('../utils/obsHelper');
      obsHelper.isAvailable.mockReturnValue(true);
      obsHelper.trySetup.mockRejectedValue(new Error('obs error'));
      await expect(appObj.initObs()).resolves.toBeUndefined();
    });
  });

  describe('initCloud', () => {
    test('should call wx.cloud.init', () => {
      appObj.initCloud();
      expect(wx.cloud.init).toHaveBeenCalled();
    });

    test('should pass cloudEnv from config', () => {
      appObj.initCloud();
      expect(wx.cloud.init).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.anything() })
      );
    });

    test('should pass traceUser as false', () => {
      appObj.initCloud();
      expect(wx.cloud.init).toHaveBeenCalledWith(
        expect.objectContaining({ traceUser: false })
      );
    });

    test('should return resolved promise when wx.cloud is not available', () => {
      const originalCloud = wx.cloud;
      Object.defineProperty(wx, 'cloud', { value: null, configurable: true });
      const result = appObj.initCloud();
      expect(result).toEqual(Promise.resolve());
      Object.defineProperty(wx, 'cloud', { value: originalCloud, configurable: true });
    });
  });

  describe('initNetworkStatus', () => {
    test('should call wx.getNetworkType', () => {
      appObj.initNetworkStatus();
      expect(wx.getNetworkType).toHaveBeenCalled();
    });

    test('should set isOnline to true when network is available', () => {
      wx.getNetworkType.mockImplementation(({ success }) => {
        if (success) success({ networkType: 'wifi' });
      });
      appObj.initNetworkStatus();
      expect(appObj.globalData.isOnline).toBe(true);
    });

    test('should set isOnline to false when network is none', () => {
      wx.getNetworkType.mockImplementation(({ success }) => {
        if (success) success({ networkType: 'none' });
      });
      appObj.initNetworkStatus();
      expect(appObj.globalData.isOnline).toBe(false);
    });

    test('should register wx.onNetworkStatusChange listener', () => {
      appObj.initNetworkStatus();
      expect(wx.onNetworkStatusChange).toHaveBeenCalledWith(expect.any(Function));
    });

    test('should update isOnline on network status change', () => {
      let networkCallback;
      wx.onNetworkStatusChange.mockImplementation(cb => { networkCallback = cb; });
      appObj.initNetworkStatus();
      networkCallback({ isConnected: false });
      expect(appObj.globalData.isOnline).toBe(false);
      networkCallback({ isConnected: true });
      expect(appObj.globalData.isOnline).toBe(true);
    });
  });

  describe('onHide', () => {
    test('should call imageLoader.pauseCleanup', () => {
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      appObj.onHide();
      const imageLoader = require('../utils/imageLoader');
      expect(imageLoader.pauseCleanup).toHaveBeenCalled();
    });
  });

  // FE-23：此前全仓 0 命中 UpdateManager。微信把新包静默下发、
  // 「下次冷启动生效」，用户不主动重启就一直跑旧代码，且没有任何提示。
  describe('initUpdateManager', () => {
    let onUpdateReady;
    let onUpdateFailed;
    let applyUpdate;
    let manager;

    beforeEach(() => {
      onUpdateReady = jest.fn();
      onUpdateFailed = jest.fn();
      applyUpdate = jest.fn();
      manager = {
        onUpdateReady,
        onUpdateFailed,
        applyUpdate
      };
      wx.getUpdateManager = jest.fn(() => manager);
    });

    afterEach(() => {
      delete wx.getUpdateManager;
    });

    test('注册了 onUpdateReady / onUpdateFailed', () => {
      appObj.initUpdateManager();
      expect(onUpdateReady).toHaveBeenCalledTimes(1);
      expect(onUpdateFailed).toHaveBeenCalledTimes(1);
    });

    test('新包就绪时弹窗，确认后 applyUpdate', () => {
      appObj.initUpdateManager();
      wx.showModal.mockImplementation(opts => opts.success({ confirm: true }));

      onUpdateReady.mock.calls[0][0]();

      expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({
        confirmText: '立即重启'
      }));
      expect(applyUpdate).toHaveBeenCalledTimes(1);
    });

    // 必须给「稍后再说」：强制重启会打断正在填的表单、打到一半的木鱼次数。
    test('用户选择稍后则不重启（不强推）', () => {
      appObj.initUpdateManager();
      wx.showModal.mockImplementation(opts => opts.success({ confirm: false }));

      onUpdateReady.mock.calls[0][0]();

      expect(applyUpdate).not.toHaveBeenCalled();
    });

    test('没有 getUpdateManager 时静默跳过，不影响启动', () => {
      delete wx.getUpdateManager;
      expect(() => appObj.initUpdateManager()).not.toThrow();
    });

    test('getUpdateManager 抛错也不影响启动（非致命）', () => {
      wx.getUpdateManager = jest.fn(() => { throw new Error('boom'); });
      expect(() => appObj.initUpdateManager()).not.toThrow();
    });

    // 注册必须排在 onLaunch 的第一个 await 之前，否则冷启动网络慢就错过 onUpdateReady
    test('onLaunch 在 initCloud 之前就完成注册', async () => {
      const order = [];
      jest.spyOn(appObj, 'initUpdateManager').mockImplementation(() => order.push('update'));
      jest.spyOn(appObj, 'initCloud').mockImplementation(() => {
        order.push('cloud');
        return Promise.resolve();
      });

      await appObj.onLaunch();

      expect(order[0]).toBe('update');
      expect(order.indexOf('update')).toBeLessThan(order.indexOf('cloud'));
      appObj.initUpdateManager.mockRestore();
      appObj.initCloud.mockRestore();
    });
  });

  describe('onShow', () => {
    test('should call imageLoader.resumeCleanup', () => {
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      appObj.onShow();
      const imageLoader = require('../utils/imageLoader');
      expect(imageLoader.resumeCleanup).toHaveBeenCalled();
    });

    test('should call flushViewRecordQueue', () => {
      const flushSpy = jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      appObj.onShow();
      expect(flushSpy).toHaveBeenCalled();
      flushSpy.mockRestore();
    });

    // 未读红点只读本地缓存恢复，不能在 onShow 里再发一次 getNotifications
    test('should restore tabBar unread badge from cache', () => {
      jest.spyOn(appObj, 'flushViewRecordQueue').mockResolvedValue();
      const TabBadge = require('../utils/tabBadge');
      const badgeSpy = jest.spyOn(TabBadge, 'refreshFromCache').mockImplementation(() => {});
      appObj.onShow();
      expect(badgeSpy).toHaveBeenCalled();
      badgeSpy.mockRestore();
    });
  });

  describe('flushViewRecordQueue', () => {
    test('should return early when queue is empty', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return '';
        return '';
      });
      await appObj.flushViewRecordQueue();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should return early when queue is empty array', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return [];
        return '';
      });
      await appObj.flushViewRecordQueue();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should process queue items', async () => {
      const queue = [{ catId: 'cat1' }, { catId: 'cat2' }];
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return queue;
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await appObj.flushViewRecordQueue();
      expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
    });

    test('should remove queue from storage when all succeed', async () => {
      const queue = [{ catId: 'cat1' }];
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return queue;
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await appObj.flushViewRecordQueue();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_viewRecordQueue');
    });

    test('should keep failed items in storage', async () => {
      const queue = [{ catId: 'cat1' }, { catId: 'cat2' }];
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return queue;
        return '';
      });
      wx.cloud.callFunction
        .mockResolvedValueOnce({ result: { success: true } })
        .mockRejectedValueOnce(new Error('fail'));
      await appObj.flushViewRecordQueue();
      expect(wx.setStorageSync).toHaveBeenCalledWith('_viewRecordQueue', [{ catId: 'cat2' }]);
    });

    test('should not throw on error', async () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('storage error'); });
      await expect(appObj.flushViewRecordQueue()).resolves.toBeUndefined();
    });

    test('并发调用只跑一轮：第二个调用必须被重入守卫拦下', async () => {
      const queue = [{ catId: 'cat1' }, { catId: 'cat2' }];
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return queue;
        return '';
      });
      // 用具名 resolver 挂起云调用，模拟第一轮还在途
      const resolvers = [];
      wx.cloud.callFunction.mockImplementation(
        () => new Promise(resolve => resolvers.push(resolve))
      );

      const first = appObj.flushViewRecordQueue();
      // 第一轮已同步发出 2 个调用；onLaunch/onShow 场景下第二个调用几乎同时到达
      const second = appObj.flushViewRecordQueue();

      expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);

      resolvers.forEach(resolve => resolve({ result: { success: true } }));
      await Promise.all([first, second]);

      // 两轮结束后守卫必须复位
      expect(appObj._flushingViewQueue).toBe(false);
    });

    test('上一轮完成后守卫复位：新队列仍能被处理', async () => {
      const queue = [{ catId: 'cat1' }];
      wx.getStorageSync.mockImplementation(key => {
        if (key === '_viewRecordQueue') return queue;
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await appObj.flushViewRecordQueue();
      expect(appObj._flushingViewQueue).toBe(false);

      await appObj.flushViewRecordQueue();
      expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPrefetchCache', () => {
    test('should call _prefetchCache.get with catId', () => {
      appObj.getPrefetchCache('cat123');
      expect(appObj.globalData._prefetchCache.get).toHaveBeenCalledWith('cat123');
    });
  });

  describe('setPrefetchCache', () => {
    test('should call _prefetchCache.set with catId and data with timestamp', () => {
      const data = { cat: { name: 'Kitty' }, photos: [] };
      appObj.setPrefetchCache('cat123', data);
      expect(appObj.globalData._prefetchCache.set).toHaveBeenCalledWith(
        'cat123',
        expect.objectContaining({ ...data, timestamp: expect.any(Number) })
      );
    });
  });

  describe('getPrefetchCacheStats', () => {
    test('should call _prefetchCache.getStats', () => {
      appObj.getPrefetchCacheStats();
      expect(appObj.globalData._prefetchCache.getStats).toHaveBeenCalled();
    });
  });

  describe('destroyPrefetchCacheCleanup', () => {
    test('should call _prefetchCache.destroy', () => {
      appObj.destroyPrefetchCacheCleanup();
      expect(appObj.globalData._prefetchCache.destroy).toHaveBeenCalled();
    });

    test('should not throw if _prefetchCache is null', () => {
      const original = appObj.globalData._prefetchCache;
      appObj.globalData._prefetchCache = null;
      expect(() => appObj.destroyPrefetchCacheCleanup()).not.toThrow();
      appObj.globalData._prefetchCache = original;
    });
  });

  describe('onPageNotFound', () => {
    test('should redirect to index page', () => {
      appObj.onPageNotFound({ path: '/pages/unknown/unknown', query: {} });
      expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });
  });

  describe('onError', () => {
    test('should call ErrorHandler.handleGlobalError', () => {
      const error = new Error('test error');
      appObj.onError(error);
      expect(ErrorHandler.handleGlobalError).toHaveBeenCalledWith(error);
    });
  });

  describe('onUnhandledRejection', () => {
    test('should call ErrorHandler.handleUnhandledRejection', () => {
      const res = { reason: new Error('unhandled'), promise: {} };
      appObj.onUnhandledRejection(res);
      expect(ErrorHandler.handleUnhandledRejection).toHaveBeenCalledWith(res);
    });
  });
});
