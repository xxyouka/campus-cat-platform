const { getWindowInfo, getDeviceInfo, canIUse } = require('../../utils/compat');

describe('compat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wx.getWindowInfo = jest.fn(() => ({
      windowHeight: 800,
      windowWidth: 375,
      statusBarHeight: 20,
      pixelRatio: 2,
      screenHeight: 812,
      screenWidth: 375
    }));
    wx.getDeviceInfo = jest.fn(() => ({
      brand: 'Apple',
      model: 'iPhone X',
      system: 'iOS 16.0',
      platform: 'ios',
      deviceId: 'abc123'
    }));
    wx.getSystemInfoSync = jest.fn(() => ({
      statusBarHeight: 44,
      windowHeight: 700,
      windowWidth: 375,
      pixelRatio: 3,
      screenHeight: 812,
      screenWidth: 375,
      brand: 'Xiaomi',
      model: 'MI 10',
      system: 'Android 12',
      platform: 'android',
      deviceId: 'xyz789'
    }));
    wx.canIUse = jest.fn(() => true);
  });

  describe('getWindowInfo', () => {
    test('calls wx.getWindowInfo when available', () => {
      const result = getWindowInfo();
      expect(wx.getWindowInfo).toHaveBeenCalled();
      expect(result).toEqual({
        windowHeight: 800,
        windowWidth: 375,
        statusBarHeight: 20,
        pixelRatio: 2,
        screenHeight: 812,
        screenWidth: 375
      });
    });

    test('does not call wx.getSystemInfoSync when wx.getWindowInfo exists', () => {
      getWindowInfo();
      expect(wx.getSystemInfoSync).not.toHaveBeenCalled();
    });

    test('falls back to wx.getSystemInfoSync when wx.getWindowInfo is undefined', () => {
      wx.getWindowInfo = undefined;
      const result = getWindowInfo();
      expect(wx.getSystemInfoSync).toHaveBeenCalled();
      expect(result).toEqual({
        statusBarHeight: 44,
        windowHeight: 700,
        windowWidth: 375,
        pixelRatio: 3,
        screenHeight: 812,
        screenWidth: 375
      });
    });

    test('falls back to wx.getSystemInfoSync when wx.getWindowInfo is null', () => {
      wx.getWindowInfo = null;
      const result = getWindowInfo();
      expect(wx.getSystemInfoSync).toHaveBeenCalled();
      expect(result.statusBarHeight).toBe(44);
    });

    test('uses fallback defaults when getSystemInfoSync fields are falsy', () => {
      wx.getWindowInfo = undefined;
      wx.getSystemInfoSync = jest.fn(() => ({
        statusBarHeight: 0,
        windowHeight: 0,
        windowWidth: 0,
        pixelRatio: 0,
        screenHeight: 0,
        screenWidth: 0
      }));
      const result = getWindowInfo();
      expect(result.pixelRatio).toBe(1);
      expect(result.statusBarHeight).toBe(0);
      expect(result.windowHeight).toBe(0);
      expect(result.windowWidth).toBe(0);
      expect(result.screenHeight).toBe(0);
      expect(result.screenWidth).toBe(0);
    });

    test('returns error defaults when wx.getWindowInfo is undefined and getSystemInfoSync throws', () => {
      wx.getWindowInfo = undefined;
      wx.getSystemInfoSync = jest.fn(() => { throw new Error('fail'); });
      const result = getWindowInfo();
      expect(result).toEqual({
        statusBarHeight: 20,
        windowHeight: 0,
        windowWidth: 0,
        pixelRatio: 1,
        screenHeight: 0,
        screenWidth: 0
      });
    });

    test('does not call getSystemInfoSync when getWindowInfo exists even if it would throw', () => {
      wx.getWindowInfo = jest.fn(() => { throw new Error('windowInfo fail'); });
      expect(() => getWindowInfo()).toThrow('windowInfo fail');
      expect(wx.getSystemInfoSync).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceInfo', () => {
    test('calls wx.getDeviceInfo when available', () => {
      const result = getDeviceInfo();
      expect(wx.getDeviceInfo).toHaveBeenCalled();
      expect(result).toEqual({
        brand: 'Apple',
        model: 'iPhone X',
        system: 'iOS 16.0',
        platform: 'ios',
        deviceId: 'abc123'
      });
    });

    test('does not call wx.getSystemInfoSync when wx.getDeviceInfo exists', () => {
      getDeviceInfo();
      expect(wx.getSystemInfoSync).not.toHaveBeenCalled();
    });

    test('falls back to wx.getSystemInfoSync when wx.getDeviceInfo is undefined', () => {
      wx.getDeviceInfo = undefined;
      const result = getDeviceInfo();
      expect(wx.getSystemInfoSync).toHaveBeenCalled();
      expect(result).toEqual({
        brand: 'Xiaomi',
        model: 'MI 10',
        system: 'Android 12',
        platform: 'android',
        deviceId: 'xyz789'
      });
    });

    test('falls back to wx.getSystemInfoSync when wx.getDeviceInfo is null', () => {
      wx.getDeviceInfo = null;
      const result = getDeviceInfo();
      expect(wx.getSystemInfoSync).toHaveBeenCalled();
      expect(result.brand).toBe('Xiaomi');
    });

    test('uses empty string defaults when getSystemInfoSync fields are falsy', () => {
      wx.getDeviceInfo = undefined;
      wx.getSystemInfoSync = jest.fn(() => ({
        brand: null,
        model: undefined,
        system: '',
        platform: 0,
        deviceId: false
      }));
      const result = getDeviceInfo();
      expect(result).toEqual({
        brand: '',
        model: '',
        system: '',
        platform: '',
        deviceId: ''
      });
    });

    test('returns error defaults when wx.getDeviceInfo is undefined and getSystemInfoSync throws', () => {
      wx.getDeviceInfo = undefined;
      wx.getSystemInfoSync = jest.fn(() => { throw new Error('fail'); });
      const result = getDeviceInfo();
      expect(result).toEqual({
        brand: '',
        model: '',
        system: '',
        platform: '',
        deviceId: ''
      });
    });

    test('does not call getSystemInfoSync when getDeviceInfo exists even if it would throw', () => {
      wx.getDeviceInfo = jest.fn(() => { throw new Error('deviceInfo fail'); });
      expect(() => getDeviceInfo()).toThrow('deviceInfo fail');
      expect(wx.getSystemInfoSync).not.toHaveBeenCalled();
    });
  });

  describe('canIUse', () => {
    test('returns wx.canIUse result when available', () => {
      wx.canIUse = jest.fn(() => true);
      expect(canIUse('getWindowInfo')).toBe(true);
      expect(wx.canIUse).toHaveBeenCalledWith('getWindowInfo');
    });

    test('returns false when wx.canIUse returns false', () => {
      wx.canIUse = jest.fn(() => false);
      expect(canIUse('someApi')).toBe(false);
      expect(wx.canIUse).toHaveBeenCalledWith('someApi');
    });

    test('returns false when wx.canIUse is undefined', () => {
      wx.canIUse = undefined;
      expect(canIUse('getWindowInfo')).toBe(false);
    });

    test('returns false when wx.canIUse is null', () => {
      wx.canIUse = null;
      expect(canIUse('getWindowInfo')).toBe(false);
    });

    test('passes the api string to wx.canIUse', () => {
      wx.canIUse = jest.fn(() => true);
      canIUse('getDeviceInfo');
      expect(wx.canIUse).toHaveBeenCalledWith('getDeviceInfo');
    });
  });
});
