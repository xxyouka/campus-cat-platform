const {
  NetworkManager,
  getNetworkManager,
  checkNetwork,
  withNetworkCheck,
  isNetworkError,
  destroyNetworkManager,
  resetNetworkManager
} = require('../../utils/network');

let networkChangeCallback = null;

beforeEach(() => {
  jest.clearAllMocks();
  destroyNetworkManager();

  wx.getNetworkType = jest.fn().mockResolvedValue({ networkType: 'wifi' });
  wx.onNetworkStatusChange = jest.fn(cb => { networkChangeCallback = cb; });
  wx.showToast = jest.fn();
  wx.showModal = jest.fn();
  global.getCurrentPages = jest.fn().mockReturnValue([]);
});

afterEach(() => {
  destroyNetworkManager();
  networkChangeCallback = null;
});

describe('NetworkManager', () => {
  describe('constructor', () => {
    test('should initialize with default values', () => {
      const nm = new NetworkManager();
      expect(nm._isConnected).toBe(true);
      expect(nm._networkType).toBe('unknown');
      expect(nm._listeners).toEqual([]);
      expect(nm._offlineToastShown).toBe(false);
    });

    test('should call _init on construction', () => {
      const initSpy = jest.spyOn(NetworkManager.prototype, '_init');
      const _nm = new NetworkManager();
      expect(initSpy).toHaveBeenCalled();
      initSpy.mockRestore();
    });
  });

  describe('_init', () => {
    test('should call _updateNetworkStatus', () => {
      const updateSpy = jest.spyOn(NetworkManager.prototype, '_updateNetworkStatus');
      const _nm = new NetworkManager();
      expect(updateSpy).toHaveBeenCalled();
      updateSpy.mockRestore();
    });

    test('should register wx.onNetworkStatusChange listener', () => {
      const _nm = new NetworkManager();
      expect(wx.onNetworkStatusChange).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('_updateNetworkStatus', () => {
    test('should set networkType and isConnected from wx.getNetworkType', async () => {
      wx.getNetworkType.mockResolvedValue({ networkType: '4g' });
      const nm = new NetworkManager();
      await nm._updateNetworkStatus();
      expect(nm._networkType).toBe('4g');
      expect(nm._isConnected).toBe(true);
    });

    test('should set isConnected to false when networkType is none', async () => {
      wx.getNetworkType.mockResolvedValue({ networkType: 'none' });
      const nm = new NetworkManager();
      await nm._updateNetworkStatus();
      expect(nm._networkType).toBe('none');
      expect(nm._isConnected).toBe(false);
    });

    test('should handle wx.getNetworkType rejection gracefully', async () => {
      wx.getNetworkType.mockRejectedValue(new Error('api fail'));
      const nm = new NetworkManager();
      await expect(nm._updateNetworkStatus()).resolves.toBeUndefined();
      expect(nm._networkType).toBe('unknown');
      expect(nm._isConnected).toBe(true);
    });

    test('initial snapshot resolving late must not overwrite a newer status event', async () => {
      let resolveGetNetwork;
      wx.getNetworkType.mockImplementation(
        () => new Promise(resolve => { resolveGetNetwork = resolve; })
      );
      const nm = new NetworkManager(); // 构造时发起初始快照（挂起）

      // 快照在途期间：网络从断网恢复的事件先到
      networkChangeCallback({ isConnected: true, networkType: 'wifi' });

      // 过时的快照随后返回「断网」
      resolveGetNetwork({ networkType: 'none' });
      await new Promise(resolve => setTimeout(resolve, 0));

      // 事件才是最新事实：不得被旧快照改回离线
      expect(nm._isConnected).toBe(true);
      expect(nm._networkType).toBe('wifi');
    });
  });

  describe('network status change handling', () => {
    let nm;

    beforeEach(() => {
      nm = new NetworkManager();
    });

    test('should update state on network status change', () => {
      networkChangeCallback({ isConnected: false, networkType: 'none' });
      expect(nm._isConnected).toBe(false);
      expect(nm._networkType).toBe('none');
    });

    test('should call _onNetworkRestore when network recovers', () => {
      nm._isConnected = false;
      const restoreSpy = jest.spyOn(nm, '_onNetworkRestore');
      networkChangeCallback({ isConnected: true, networkType: 'wifi' });
      expect(restoreSpy).toHaveBeenCalled();
      restoreSpy.mockRestore();
    });

    test('should not call _onNetworkRestore when already connected', () => {
      nm._isConnected = true;
      const restoreSpy = jest.spyOn(nm, '_onNetworkRestore');
      networkChangeCallback({ isConnected: true, networkType: '4g' });
      expect(restoreSpy).not.toHaveBeenCalled();
      restoreSpy.mockRestore();
    });

    test('should call _onNetworkLost when network disconnects', () => {
      nm._isConnected = true;
      const lostSpy = jest.spyOn(nm, '_onNetworkLost');
      networkChangeCallback({ isConnected: false, networkType: 'none' });
      expect(lostSpy).toHaveBeenCalled();
      lostSpy.mockRestore();
    });

    test('should not call _onNetworkLost when already disconnected', () => {
      nm._isConnected = false;
      const lostSpy = jest.spyOn(nm, '_onNetworkLost');
      networkChangeCallback({ isConnected: false, networkType: 'none' });
      expect(lostSpy).not.toHaveBeenCalled();
      lostSpy.mockRestore();
    });

    test('should notify all listeners on status change', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      nm.onStatusChange(listener1);
      nm.onStatusChange(listener2);
      networkChangeCallback({ isConnected: true, networkType: '4g' });
      expect(listener1).toHaveBeenCalledWith({
        isConnected: true,
        networkType: '4g',
        wasConnected: true
      });
      expect(listener2).toHaveBeenCalledWith({
        isConnected: true,
        networkType: '4g',
        wasConnected: true
      });
    });
  });

  describe('_onNetworkRestore', () => {
    test('should reset _offlineToastShown', () => {
      const nm = new NetworkManager();
      nm._offlineToastShown = true;
      nm._onNetworkRestore();
      expect(nm._offlineToastShown).toBe(false);
    });

    test('should show success toast', () => {
      const nm = new NetworkManager();
      nm._onNetworkRestore();
      expect(wx.showToast).toHaveBeenCalledWith({
        title: '网络已恢复',
        icon: 'success',
        duration: 2000
      });
    });

    test('should trigger global event networkRestore', () => {
      const nm = new NetworkManager();
      const triggerSpy = jest.spyOn(nm, '_triggerGlobalEvent');
      nm._onNetworkRestore();
      expect(triggerSpy).toHaveBeenCalledWith('networkRestore');
      triggerSpy.mockRestore();
    });
  });

  describe('_onNetworkLost', () => {
    test('should show offline toast when not shown before', () => {
      const nm = new NetworkManager();
      nm._offlineToastShown = false;
      nm._onNetworkLost();
      expect(wx.showToast).toHaveBeenCalledWith({
        title: '网络已断开',
        icon: 'none',
        duration: 3000
      });
      expect(nm._offlineToastShown).toBe(true);
    });

    test('should not show offline toast when already shown', () => {
      const nm = new NetworkManager();
      nm._offlineToastShown = true;
      nm._onNetworkLost();
      expect(wx.showToast).not.toHaveBeenCalled();
    });

    test('should trigger global event networkLost', () => {
      const nm = new NetworkManager();
      const triggerSpy = jest.spyOn(nm, '_triggerGlobalEvent');
      nm._onNetworkLost();
      expect(triggerSpy).toHaveBeenCalledWith('networkLost');
      triggerSpy.mockRestore();
    });
  });

  describe('_triggerGlobalEvent', () => {
    test('should call onNetworkChange on current page if exists', () => {
      const mockPage = { onNetworkChange: jest.fn() };
      global.getCurrentPages.mockReturnValue([mockPage]);
      const nm = new NetworkManager();
      nm._triggerGlobalEvent('networkLost');
      expect(mockPage.onNetworkChange).toHaveBeenCalledWith('networkLost');
    });

    test('should not throw when no pages exist', () => {
      global.getCurrentPages.mockReturnValue([]);
      const nm = new NetworkManager();
      expect(() => nm._triggerGlobalEvent('networkLost')).not.toThrow();
    });

    test('should not throw when page has no onNetworkChange method', () => {
      global.getCurrentPages.mockReturnValue([{ someMethod: jest.fn() }]);
      const nm = new NetworkManager();
      expect(() => nm._triggerGlobalEvent('networkLost')).not.toThrow();
    });

    test('should use last page in stack', () => {
      const page1 = { onNetworkChange: jest.fn() };
      const page2 = { onNetworkChange: jest.fn() };
      global.getCurrentPages.mockReturnValue([page1, page2]);
      const nm = new NetworkManager();
      nm._triggerGlobalEvent('networkRestore');
      expect(page1.onNetworkChange).not.toHaveBeenCalled();
      expect(page2.onNetworkChange).toHaveBeenCalledWith('networkRestore');
    });
  });

  describe('_notifyListeners', () => {
    test('should call each listener with status', () => {
      const nm = new NetworkManager();
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      nm._listeners = [listener1, listener2];
      const status = { isConnected: true, networkType: 'wifi' };
      nm._notifyListeners(status);
      expect(listener1).toHaveBeenCalledWith(status);
      expect(listener2).toHaveBeenCalledWith(status);
    });

    test('should catch errors from listeners', () => {
      const nm = new NetworkManager();
      const badListener = jest.fn(() => { throw new Error('listener error'); });
      const goodListener = jest.fn();
      nm._listeners = [badListener, goodListener];
      nm._notifyListeners({ isConnected: true });
      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe('onStatusChange', () => {
    test('should add listener and return unsubscribe function', () => {
      const nm = new NetworkManager();
      const listener = jest.fn();
      const unsubscribe = nm.onStatusChange(listener);
      expect(nm._listeners).toContain(listener);
      unsubscribe();
      expect(nm._listeners).not.toContain(listener);
    });

    test('should not remove other listeners when unsubscribing', () => {
      const nm = new NetworkManager();
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      const unsub1 = nm.onStatusChange(listener1);
      nm.onStatusChange(listener2);
      unsub1();
      expect(nm._listeners).not.toContain(listener1);
      expect(nm._listeners).toContain(listener2);
    });

    test('should handle double unsubscribe gracefully', () => {
      const nm = new NetworkManager();
      const listener = jest.fn();
      const unsubscribe = nm.onStatusChange(listener);
      unsubscribe();
      unsubscribe();
      expect(nm._listeners).not.toContain(listener);
    });
  });

  describe('isOnline', () => {
    test('should return _isConnected value', () => {
      const nm = new NetworkManager();
      nm._isConnected = true;
      expect(nm.isOnline()).toBe(true);
      nm._isConnected = false;
      expect(nm.isOnline()).toBe(false);
    });
  });

  describe('getNetworkType', () => {
    test('should return _networkType value', () => {
      const nm = new NetworkManager();
      nm._networkType = '4g';
      expect(nm.getNetworkType()).toBe('4g');
    });
  });

  describe('canRequest', () => {
    test('should return true when connected and not 2g', () => {
      const nm = new NetworkManager();
      nm._isConnected = true;
      nm._networkType = 'wifi';
      expect(nm.canRequest()).toBe(true);
    });

    test('should return false when disconnected', () => {
      const nm = new NetworkManager();
      nm._isConnected = false;
      nm._networkType = 'wifi';
      expect(nm.canRequest()).toBe(false);
    });

    test('should return false when on 2g', () => {
      const nm = new NetworkManager();
      nm._isConnected = true;
      nm._networkType = '2g';
      expect(nm.canRequest()).toBe(false);
    });

    test('should return false when disconnected and on 2g', () => {
      const nm = new NetworkManager();
      nm._isConnected = false;
      nm._networkType = '2g';
      expect(nm.canRequest()).toBe(false);
    });
  });

  describe('showOfflineModal', () => {
    test('should call wx.showModal with default options', () => {
      const nm = new NetworkManager();
      nm.showOfflineModal();
      expect(wx.showModal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '网络错误',
          content: '网络连接失败，请检查网络设置',
          showCancel: true,
          cancelText: '取消',
          confirmText: '重试'
        })
      );
    });

    test('should call wx.showModal with custom options', () => {
      const nm = new NetworkManager();
      nm.showOfflineModal({
        title: '自定义标题',
        content: '自定义内容',
        showCancel: false
      });
      expect(wx.showModal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '自定义标题',
          content: '自定义内容',
          showCancel: false
        })
      );
    });

    test('should call success callback when user confirms', () => {
      const success = jest.fn();
      const nm = new NetworkManager();
      nm.showOfflineModal({ success });
      const modalCall = wx.showModal.mock.calls[0][0];
      modalCall.success({ confirm: true });
      expect(success).toHaveBeenCalled();
    });

    test('should not call success callback when user cancels', () => {
      const success = jest.fn();
      const nm = new NetworkManager();
      nm.showOfflineModal({ success });
      const modalCall = wx.showModal.mock.calls[0][0];
      modalCall.success({ confirm: false });
      expect(success).not.toHaveBeenCalled();
    });

    test('should not throw when success is not provided and user confirms', () => {
      const nm = new NetworkManager();
      nm.showOfflineModal();
      const modalCall = wx.showModal.mock.calls[0][0];
      expect(() => modalCall.success({ confirm: true })).not.toThrow();
    });
  });
});

describe('getNetworkManager', () => {
  test('should return a NetworkManager instance', () => {
    const nm = getNetworkManager();
    expect(nm).toBeInstanceOf(NetworkManager);
  });

  test('should return the same instance on subsequent calls', () => {
    const nm1 = getNetworkManager();
    const nm2 = getNetworkManager();
    expect(nm1).toBe(nm2);
  });

  test('should create new instance after destroy', () => {
    const nm1 = getNetworkManager();
    destroyNetworkManager();
    const nm2 = getNetworkManager();
    expect(nm1).not.toBe(nm2);
  });
});

describe('checkNetwork', () => {
  test('should return true when online', () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    expect(checkNetwork()).toBe(true);
  });

  test('should return false when offline', () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    expect(checkNetwork()).toBe(false);
  });

  test('should show offline modal when offline', () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    checkNetwork({ title: '自定义' });
    expect(wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: '自定义' })
    );
  });

  test('should not show modal when online', () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    checkNetwork();
    expect(wx.showModal).not.toHaveBeenCalled();
  });

  test('should pass options to showOfflineModal', () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    checkNetwork({ title: '提示', content: '请检查网络', showCancel: false });
    expect(wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '提示',
        content: '请检查网络',
        showCancel: false
      })
    );
  });
});

describe('withNetworkCheck', () => {
  test('should return request result when online and request succeeds', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const requestFn = jest.fn().mockResolvedValue('data');
    const result = await withNetworkCheck(requestFn);
    expect(result).toBe('data');
  });

  test('should throw and show modal when offline', async () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    const requestFn = jest.fn();
    await expect(withNetworkCheck(requestFn)).rejects.toThrow('网络已断开');
    expect(wx.showModal).toHaveBeenCalled();
    expect(requestFn).not.toHaveBeenCalled();
  });

  test('should not show modal when offline and showError is false', async () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    await expect(
      withNetworkCheck(jest.fn(), { showError: false })
    ).rejects.toThrow('网络已断开');
    expect(wx.showModal).not.toHaveBeenCalled();
  });

  test('should retry on network error with errMsg containing network', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const networkErr = new Error('network fail');
    networkErr.errMsg = 'request:fail network error';
    const requestFn = jest.fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce('success');
    const result = await withNetworkCheck(requestFn, { retryCount: 3 });
    expect(result).toBe('success');
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  test('should throw immediately on non-network error', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const err = new Error('permission denied');
    err.errMsg = 'permission denied';
    const requestFn = jest.fn().mockRejectedValue(err);
    await expect(withNetworkCheck(requestFn)).rejects.toThrow('permission denied');
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  test('should show toast and throw after retries exhausted', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const networkErr = new Error('network fail');
    networkErr.errMsg = 'request:fail network error';
    const requestFn = jest.fn().mockRejectedValue(networkErr);
    await expect(
      withNetworkCheck(requestFn, { retryCount: 2, showError: true })
    ).rejects.toThrow(networkErr);
    expect(wx.showToast).toHaveBeenCalledWith({
      title: '网络请求失败',
      icon: 'none'
    });
  });

  test('should not show toast when showError is false after retries exhausted', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const networkErr = new Error('network fail');
    networkErr.errMsg = 'request:fail network error';
    const requestFn = jest.fn().mockRejectedValue(networkErr);
    await expect(
      withNetworkCheck(requestFn, { retryCount: 2, showError: false })
    ).rejects.toThrow(networkErr);
    expect(wx.showToast).not.toHaveBeenCalled();
  });

  test('should retry with increasing delay', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const networkErr = new Error('network fail');
    networkErr.errMsg = 'request:fail network error';
    const requestFn = jest.fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce('ok');
    jest.useFakeTimers();
    const promise = withNetworkCheck(requestFn, { retryCount: 3 });
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;
    jest.useRealTimers();
    expect(result).toBe('ok');
    expect(requestFn).toHaveBeenCalledTimes(3);
  });

  test('should retry on confirm when offline with _depth < 3', async () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    const requestFn = jest.fn();
    const promise = withNetworkCheck(requestFn, { _depth: 0 });
    const modalCall = wx.showModal.mock.calls[0][0];
    nm._isConnected = true;
    requestFn.mockResolvedValue('retried');
    modalCall.success({ confirm: true });
    await expect(promise).rejects.toThrow('网络已断开');
  });

  test('should not retry on confirm when _depth >= 3', async () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    const requestFn = jest.fn();
    await expect(
      withNetworkCheck(requestFn, { _depth: 3 })
    ).rejects.toThrow('网络已断开');
    const modalCall = wx.showModal.mock.calls[0][0];
    modalCall.success({ confirm: true });
    expect(requestFn).not.toHaveBeenCalled();
  });

  test('should use default retryCount of 3', async () => {
    const nm = getNetworkManager();
    nm._isConnected = true;
    const networkErr = new Error('network fail');
    networkErr.errMsg = 'request:fail network error';
    const requestFn = jest.fn().mockRejectedValue(networkErr);
    await expect(withNetworkCheck(requestFn)).rejects.toThrow(networkErr);
    expect(requestFn).toHaveBeenCalledTimes(3);
  });
});

describe('isNetworkError', () => {
  test('should return false for null', () => {
    expect(isNetworkError(null)).toBe(false);
  });

  test('should return false for undefined', () => {
    expect(isNetworkError(undefined)).toBe(false);
  });

  test('should detect fetch keyword', () => {
    expect(isNetworkError(new Error('fetch failed'))).toBe(true);
  });

  test('should detect network keyword', () => {
    expect(isNetworkError(new Error('network error'))).toBe(true);
  });

  test('should detect timeout keyword', () => {
    expect(isNetworkError(new Error('request timeout'))).toBe(true);
  });

  test('should detect dns keyword', () => {
    expect(isNetworkError(new Error('dns resolve failed'))).toBe(true);
  });

  test('should detect socket keyword', () => {
    expect(isNetworkError(new Error('socket hang up'))).toBe(true);
  });

  test('should detect connect keyword', () => {
    expect(isNetworkError(new Error('connect ECONNREFUSED'))).toBe(true);
  });

  test('should detect abort keyword', () => {
    expect(isNetworkError(new Error('request aborted'))).toBe(true);
  });

  test('should detect -1 error code', () => {
    expect(isNetworkError(new Error('errCode: -1'))).toBe(true);
  });

  test('should detect request:fail keyword', () => {
    expect(isNetworkError(new Error('request:fail'))).toBe(true);
  });

  test('should detect keywords in errMsg property', () => {
    expect(isNetworkError({ errMsg: 'request:fail timeout' })).toBe(true);
  });

  test('should be case insensitive', () => {
    expect(isNetworkError(new Error('NETWORK ERROR'))).toBe(true);
    expect(isNetworkError({ errMsg: 'TIMEOUT' })).toBe(true);
  });

  test('should return false for non-network errors', () => {
    expect(isNetworkError(new Error('permission denied'))).toBe(false);
    expect(isNetworkError(new Error('invalid parameter'))).toBe(false);
    expect(isNetworkError({ errMsg: 'cloud function execution error' })).toBe(false);
  });

  test('should return false for empty error', () => {
    expect(isNetworkError({})).toBe(false);
    expect(isNetworkError(new Error(''))).toBe(false);
  });

  test('should return false for error with no message or errMsg', () => {
    expect(isNetworkError({ code: 500 })).toBe(false);
  });
});

describe('destroyNetworkManager', () => {
  test('should clear listeners', () => {
    const nm = getNetworkManager();
    nm._listeners = [jest.fn(), jest.fn()];
    destroyNetworkManager();
    expect(nm._listeners).toEqual([]);
  });

  test('should reset state to defaults', () => {
    const nm = getNetworkManager();
    nm._isConnected = false;
    nm._networkType = '2g';
    nm._offlineToastShown = true;
    destroyNetworkManager();
    expect(nm._isConnected).toBe(true);
    expect(nm._networkType).toBe('unknown');
    expect(nm._offlineToastShown).toBe(false);
  });

  test('should set instance to null', () => {
    getNetworkManager();
    destroyNetworkManager();
    const nm2 = getNetworkManager();
    expect(nm2).toBeInstanceOf(NetworkManager);
  });

  test('should not throw when no instance exists', () => {
    destroyNetworkManager();
    expect(() => destroyNetworkManager()).not.toThrow();
  });
});

describe('resetNetworkManager', () => {
  test('should return a new NetworkManager instance', () => {
    const nm = resetNetworkManager();
    expect(nm).toBeInstanceOf(NetworkManager);
  });

  test('should create a different instance than before', () => {
    const nm1 = getNetworkManager();
    const nm2 = resetNetworkManager();
    expect(nm1).not.toBe(nm2);
  });

  test('should clear old listeners', () => {
    const nm1 = getNetworkManager();
    nm1._listeners = [jest.fn()];
    resetNetworkManager();
    expect(nm1._listeners).toEqual([]);
  });

  test('should produce a singleton again after reset', () => {
    resetNetworkManager();
    const nm1 = getNetworkManager();
    const nm2 = getNetworkManager();
    expect(nm1).toBe(nm2);
  });
});
