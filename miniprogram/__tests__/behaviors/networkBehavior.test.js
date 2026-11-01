const networkBehavior = require('../../behaviors/networkBehavior');

jest.mock('../../utils/network', () => ({
  getNetworkManager: jest.fn(),
  checkNetwork: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

const { getNetworkManager, checkNetwork } = require('../../utils/network');
const { Logger } = require('../../utils/logger');

function createMockContext(overrides = {}) {
  const ctx = {
    data: { ...networkBehavior.data },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _autoRetryTimer: null,
    _autoRetryCountdown: 0,
    _networkUnsubscribe: null,
    _retryLoadCallback: null,
    ...overrides
  };
  Object.assign(ctx, networkBehavior.methods);
  return ctx;
}

describe('networkBehavior', () => {
  let ctx;
  let mockUnsubscribe;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockUnsubscribe = jest.fn();
    getNetworkManager.mockReturnValue({
      onStatusChange: jest.fn(_cb => {
        ctx._networkUnsubscribe = mockUnsubscribe;
        return mockUnsubscribe;
      })
    });
    checkNetwork.mockReturnValue(true);
    ctx = createMockContext();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('data', () => {
    test('should have networkError initialized as false', () => {
      expect(networkBehavior.data.networkError).toBe(false);
    });

    test('should have autoRetryCountdown initialized as 0', () => {
      expect(networkBehavior.data.autoRetryCountdown).toBe(0);
    });
  });

  describe('lifetimes.attached', () => {
    test('should call _initNetworkListener', () => {
      const initSpy = jest.spyOn(ctx, '_initNetworkListener');
      networkBehavior.lifetimes.attached.call(ctx);
      expect(initSpy).toHaveBeenCalled();
      initSpy.mockRestore();
    });
  });

  describe('lifetimes.detached', () => {
    test('should call _cleanupTimers', () => {
      const cleanupSpy = jest.spyOn(ctx, '_cleanupTimers');
      networkBehavior.lifetimes.detached.call(ctx);
      expect(cleanupSpy).toHaveBeenCalled();
      cleanupSpy.mockRestore();
    });
  });

  describe('_initNetworkListener', () => {
    test('should call getNetworkManager', () => {
      ctx._initNetworkListener();
      expect(getNetworkManager).toHaveBeenCalled();
    });

    test('should subscribe to network status changes', () => {
      const mockManager = getNetworkManager();
      ctx._initNetworkListener();
      expect(mockManager.onStatusChange).toHaveBeenCalledWith(expect.any(Function));
    });

    test('should store unsubscribe function', () => {
      ctx._initNetworkListener();
      expect(ctx._networkUnsubscribe).toBe(mockUnsubscribe);
    });

    test('should clear error without toast when network recovers (toast 由 NetworkManager 全局统一弹出)', () => {
      let statusCallback;
      const mockManager = {
        onStatusChange: jest.fn(cb => {
          statusCallback = cb;
          return mockUnsubscribe;
        })
      };
      getNetworkManager.mockReturnValue(mockManager);
      ctx._initNetworkListener();

      statusCallback({ isConnected: true, wasConnected: false });
      expect(wx.showToast).not.toHaveBeenCalled();
      expect(ctx.setData).toHaveBeenCalledWith({ networkError: false });
    });

    test('should not re-subscribe when already initialized (幂等保护)', () => {
      const mockManager = {
        onStatusChange: jest.fn(() => mockUnsubscribe)
      };
      getNetworkManager.mockReturnValue(mockManager);
      ctx._initNetworkListener();
      ctx._initNetworkListener();
      expect(mockManager.onStatusChange).toHaveBeenCalledTimes(1);
    });

    test('should not show toast when network was already connected', () => {
      let statusCallback;
      const mockManager = {
        onStatusChange: jest.fn(cb => {
          statusCallback = cb;
          return mockUnsubscribe;
        })
      };
      getNetworkManager.mockReturnValue(mockManager);
      ctx._initNetworkListener();

      statusCallback({ isConnected: true, wasConnected: true });
      expect(wx.showToast).not.toHaveBeenCalled();
    });

    test('should log network status change', () => {
      let statusCallback;
      const mockManager = {
        onStatusChange: jest.fn(cb => {
          statusCallback = cb;
          return mockUnsubscribe;
        })
      };
      getNetworkManager.mockReturnValue(mockManager);
      ctx._initNetworkListener();

      statusCallback({ isConnected: true, wasConnected: false });
      expect(Logger.info).toHaveBeenCalledWith('network', '网络状态变化', { isConnected: true, wasConnected: false });
    });
  });

  describe('_cleanupTimers', () => {
    test('should clear auto retry timer if it exists', () => {
      ctx._autoRetryTimer = setInterval(() => {}, 1000);
      const timerRef = ctx._autoRetryTimer;
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      ctx._cleanupTimers();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timerRef);
      clearIntervalSpy.mockRestore();
    });

    test('should set _autoRetryTimer to null after clearing', () => {
      ctx._autoRetryTimer = setInterval(() => {}, 1000);
      ctx._cleanupTimers();
      expect(ctx._autoRetryTimer).toBeNull();
    });

    test('should not throw if _autoRetryTimer is null', () => {
      ctx._autoRetryTimer = null;
      expect(() => ctx._cleanupTimers()).not.toThrow();
    });

    test('should call _networkUnsubscribe if it exists', () => {
      ctx._networkUnsubscribe = mockUnsubscribe;
      ctx._cleanupTimers();
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    test('should set _networkUnsubscribe to null after calling', () => {
      ctx._networkUnsubscribe = mockUnsubscribe;
      ctx._cleanupTimers();
      expect(ctx._networkUnsubscribe).toBeNull();
    });

    test('should not throw if _networkUnsubscribe is null', () => {
      ctx._networkUnsubscribe = null;
      expect(() => ctx._cleanupTimers()).not.toThrow();
    });
  });

  describe('onRetryLoad', () => {
    test('只清倒计时定时器、不退订网络监听（否则断网横幅永不消失）', () => {
      const unsubscribe = jest.fn();
      ctx._networkUnsubscribe = unsubscribe;
      ctx._autoRetryTimer = setInterval(() => {}, 9999);
      const cleanupSpy = jest.spyOn(ctx, '_cleanupTimers');

      ctx.onRetryLoad();

      expect(ctx._autoRetryTimer).toBeNull();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(ctx._networkUnsubscribe).toBe(unsubscribe);
      // 不再走 _cleanupTimers（它会连带退订网络监听）
      expect(cleanupSpy).not.toHaveBeenCalled();
      cleanupSpy.mockRestore();
    });

    test('should reset autoRetryCountdown to 0', () => {
      ctx.onRetryLoad();
      expect(ctx.setData).toHaveBeenCalledWith({ autoRetryCountdown: 0 });
    });

    test('should return early if checkNetwork returns false', () => {
      checkNetwork.mockReturnValue(false);
      ctx.onRetryLoad();
      expect(ctx.setData).not.toHaveBeenCalledWith(
        expect.objectContaining({ networkError: false, loading: true })
      );
    });

    test('should set networkError false, loading true, showSkeleton true when network is available', () => {
      checkNetwork.mockReturnValue(true);
      ctx.onRetryLoad();
      expect(ctx.setData).toHaveBeenCalledWith({
        networkError: false,
        loading: true,
        showSkeleton: true
      });
    });

    test('should call _retryLoadCallback if it is a function', () => {
      const callback = jest.fn();
      ctx._retryLoadCallback = callback;
      ctx.onRetryLoad();
      expect(callback).toHaveBeenCalled();
    });

    test('should call loadCats if _retryLoadCallback is not a function but loadCats is', () => {
      ctx._retryLoadCallback = null;
      ctx.loadCats = jest.fn();
      ctx.onRetryLoad();
      expect(ctx.loadCats).toHaveBeenCalled();
    });

    test('should prefer _retryLoadCallback over loadCats', () => {
      const callback = jest.fn();
      ctx._retryLoadCallback = callback;
      ctx.loadCats = jest.fn();
      ctx.onRetryLoad();
      expect(callback).toHaveBeenCalled();
      expect(ctx.loadCats).not.toHaveBeenCalled();
    });

    test('should not throw if neither callback nor loadCats exists', () => {
      ctx._retryLoadCallback = null;
      expect(() => ctx.onRetryLoad()).not.toThrow();
    });
  });

  describe('showNetworkErrorEnhanced', () => {
    test('should set networkError true, autoRetryCountdown 5, showSkeleton false', () => {
      ctx.showNetworkErrorEnhanced();
      expect(ctx.setData).toHaveBeenCalledWith({
        networkError: true,
        autoRetryCountdown: 5,
        showSkeleton: false
      });
    });

    test('should clear existing auto retry timer', () => {
      const existingTimer = setInterval(() => {}, 1000);
      ctx._autoRetryTimer = existingTimer;
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      ctx.showNetworkErrorEnhanced();
      expect(clearIntervalSpy).toHaveBeenCalledWith(existingTimer);
      clearIntervalSpy.mockRestore();
    });

    test('should set _autoRetryCountdown to 5', () => {
      ctx.showNetworkErrorEnhanced();
      expect(ctx._autoRetryCountdown).toBe(5);
    });

    test('should create a new interval timer', () => {
      ctx.showNetworkErrorEnhanced();
      expect(ctx._autoRetryTimer).not.toBeNull();
    });

    test('should count down and update autoRetryCountdown each second', () => {
      ctx.showNetworkErrorEnhanced();
      jest.advanceTimersByTime(1000);
      expect(ctx._autoRetryCountdown).toBe(4);
      expect(ctx.setData).toHaveBeenCalledWith({ autoRetryCountdown: 4 });

      jest.advanceTimersByTime(1000);
      expect(ctx._autoRetryCountdown).toBe(3);
      expect(ctx.setData).toHaveBeenCalledWith({ autoRetryCountdown: 3 });
    });

    test('should auto retry when countdown reaches 0', () => {
      ctx.showNetworkErrorEnhanced();
      const retrySpy = jest.spyOn(ctx, 'onRetryLoad');
      jest.advanceTimersByTime(5000);
      expect(retrySpy).toHaveBeenCalled();
      expect(ctx._autoRetryTimer).toBeNull();
      retrySpy.mockRestore();
    });

    test('should log auto retry', () => {
      ctx.showNetworkErrorEnhanced();
      jest.advanceTimersByTime(5000);
      expect(Logger.info).toHaveBeenCalledWith('network', '自动重试加载');
    });

    test('should set autoRetryCountdown to 0 when countdown finishes', () => {
      ctx.showNetworkErrorEnhanced();
      jest.advanceTimersByTime(5000);
      expect(ctx.setData).toHaveBeenCalledWith({ autoRetryCountdown: 0 });
    });
  });

  describe('onNetworkChange', () => {
    test('should log the event name', () => {
      ctx.onNetworkChange('testEvent');
      expect(Logger.info).toHaveBeenCalledWith('network', '网络全局事件', { eventName: 'testEvent' });
    });

    test('should handle different event names', () => {
      ctx.onNetworkChange('reconnect');
      expect(Logger.info).toHaveBeenCalledWith('network', '网络全局事件', { eventName: 'reconnect' });
    });
  });
});
