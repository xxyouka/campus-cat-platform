// utils/compat.js - 小程序 API 兼容层（适配不同基础库版本）
function getWindowInfo() {
  if (wx.getWindowInfo) {
    return wx.getWindowInfo();
  }
  try {
    const systemInfo = wx.getSystemInfoSync();
    return {
      statusBarHeight: systemInfo.statusBarHeight || 0,
      windowHeight: systemInfo.windowHeight || 0,
      windowWidth: systemInfo.windowWidth || 0,
      pixelRatio: systemInfo.pixelRatio || 1,
      screenHeight: systemInfo.screenHeight || 0,
      screenWidth: systemInfo.screenWidth || 0
    };
  } catch (e) {
    return {
      statusBarHeight: 20,
      windowHeight: 0,
      windowWidth: 0,
      pixelRatio: 1,
      screenHeight: 0,
      screenWidth: 0
    };
  }
}

function getDeviceInfo() {
  if (wx.getDeviceInfo) {
    return wx.getDeviceInfo();
  }
  try {
    const systemInfo = wx.getSystemInfoSync();
    return {
      brand: systemInfo.brand || '',
      model: systemInfo.model || '',
      system: systemInfo.system || '',
      platform: systemInfo.platform || '',
      deviceId: systemInfo.deviceId || ''
    };
  } catch (e) {
    return {
      brand: '',
      model: '',
      system: '',
      platform: '',
      deviceId: ''
    };
  }
}

function canIUse(api) {
  return wx.canIUse ? wx.canIUse(api) : false;
}

module.exports = {
  getWindowInfo,
  getDeviceInfo,
  canIUse
};
