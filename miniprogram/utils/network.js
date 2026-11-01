/**
 * utils/network.js - 网络状态管理工具
 *
 * 提供网络状态监听、断网提示、恢复自动重试等功能
 *
 * @module network
 */

const { Logger } = require('./logger');

/**
 * 网络状态管理器
 */
class NetworkManager {
  constructor() {
    this._isConnected = true;
    this._networkType = 'unknown';
    this._listeners = [];
    this._offlineToastShown = false;
    // 状态版本号：初始快照（异步）与状态变化事件之间存在竞态，
    // 事件到达时自增，快照返回后若版本已变则丢弃（见 _updateNetworkStatus）
    this._statusVersion = 0;
    this._init();
  }

  /**
   * 初始化网络监听
   * @private
   */
  _init() {
    // 异步获取初始网络状态
    this._updateNetworkStatus();

    // 监听网络状态变化
    wx.onNetworkStatusChange((res) => {
      const wasConnected = this._isConnected;
      // 事件是比「构造时的异步快照」更新的事实：版本自增使在途快照失效
      this._statusVersion++;
      this._isConnected = res.isConnected;
      this._networkType = res.networkType;

      Logger.info('network', '网络状态变化', {
        isConnected: res.isConnected,
        networkType: res.networkType
      });

      // 网络恢复
      if (!wasConnected && res.isConnected) {
        this._onNetworkRestore();
      }

      // 网络断开
      if (wasConnected && !res.isConnected) {
        this._onNetworkLost();
      }

      // 通知所有监听者
      this._notifyListeners({
        isConnected: res.isConnected,
        networkType: res.networkType,
        wasConnected
      });
    });
  }

  /**
   * 更新网络状态
   * @private
   */
  async _updateNetworkStatus() {
    const versionAtStart = this._statusVersion;
    try {
      const res = await wx.getNetworkType();
      // 快照在途期间已有更晚的状态事件到达（网络恰好从断网恢复等）：
      // 事件才是最新事实，用旧快照覆盖会让 isOnline() 长期与真实网络相反
      if (versionAtStart !== this._statusVersion) return;
      this._networkType = res.networkType;
      this._isConnected = res.networkType !== 'none';
    } catch (e) {
      Logger.warn('network', '获取网络状态失败', e);
    }
  }

  /**
   * 网络恢复处理
   * @private
   */
  _onNetworkRestore() {
    this._offlineToastShown = false;
    wx.showToast({
      title: '网络已恢复',
      icon: 'success',
      duration: 2000
    });

    // 触发全局网络恢复事件
    this._triggerGlobalEvent('networkRestore');
  }

  /**
   * 网络断开处理
   * @private
   */
  _onNetworkLost() {
    if (!this._offlineToastShown) {
      this._offlineToastShown = true;
      wx.showToast({
        title: '网络已断开',
        icon: 'none',
        duration: 3000
      });
    }

    // 触发全局网络断开事件
    this._triggerGlobalEvent('networkLost');
  }

  /**
   * 触发全局事件
   * @private
   */
  _triggerGlobalEvent(eventName) {
    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    if (currentPage && typeof currentPage.onNetworkChange === 'function') {
      currentPage.onNetworkChange(eventName);
    }
  }

  /**
   * 通知所有监听者
   * @private
   */
  _notifyListeners(status) {
    this._listeners.forEach(callback => {
      try {
        callback(status);
      } catch (e) {
        Logger.error('network', '通知监听者失败', e);
      }
    });
  }

  /**
   * 添加网络状态监听
   * @param {Function} callback - 回调函数，接收 { isConnected, networkType, wasConnected }
   * @returns {Function} 取消监听的函数
   */
  onStatusChange(callback) {
    this._listeners.push(callback);
    return () => {
      const index = this._listeners.indexOf(callback);
      if (index > -1) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /**
   * 检查是否在线
   * @returns {boolean}
   */
  isOnline() {
    return this._isConnected;
  }

  /**
   * 获取网络类型
   * @returns {string} wifi/4g/3g/2g/none/unknown
   */
  getNetworkType() {
    return this._networkType;
  }

  /**
   * 检查是否可以使用网络请求（在线且不是2G）
   * @returns {boolean}
   */
  canRequest() {
    return this._isConnected && this._networkType !== '2g';
  }

  /**
   * 显示网络错误提示
   * @param {Object} options
   * @param {string} options.title - 提示标题
   * @param {string} options.content - 提示内容
   * @param {boolean} options.showCancel - 是否显示取消按钮
   * @param {Function} options.success - 点击确定的回调
   */
  showOfflineModal(options = {}) {
    const { title = '网络错误', content = '网络连接失败，请检查网络设置', showCancel = true, success } = options;

    wx.showModal({
      title,
      content,
      showCancel,
      cancelText: '取消',
      confirmText: '重试',
      success: (res) => {
        if (res.confirm && typeof success === 'function') {
          success();
        }
      }
    });
  }
}

// 单例实例
let instance = null;

/**
 * 获取网络管理器实例
 * @returns {NetworkManager}
 */
function getNetworkManager() {
  if (!instance) {
    instance = new NetworkManager();
  }
  return instance;
}

/**
 * 检查网络状态，如果离线显示提示
 * @param {Object} options
 * @returns {boolean} 是否在线
 */
function checkNetwork(options = {}) {
  const manager = getNetworkManager();

  if (!manager.isOnline()) {
    // 兑现 showError:false 的静默语义（如冷启动自检场景不应打扰用户）
    if (options.showError === false) {
      return false;
    }
    manager.showOfflineModal(options);
    return false;
  }

  return true;
}

/**
 * 网络请求包装器，自动处理网络错误
 * @param {Function} requestFn - 请求函数
 * @param {Object} options
 * @param {number} options.retryCount - 重试次数
 * @param {boolean} options.showError - 是否显示错误提示
 * @returns {Promise}
 */
async function withNetworkCheck(requestFn, options = {}) {
  const { retryCount = 3, showError = true, _depth = 0 } = options;
  const manager = getNetworkManager();

  if (!manager.isOnline()) {
    if (showError) {
      manager.showOfflineModal({
        success: () => {
          if (_depth < 3) {
            withNetworkCheck(requestFn, { ...options, _depth: _depth + 1 });
          }
        }
      });
    }
    throw new Error('网络已断开');
  }

  // 执行请求
  let lastError = null;
  for (let i = 0; i < retryCount; i++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;

      // 如果是网络错误，等待后重试
      if (err.errMsg && err.errMsg.includes('network')) {
        Logger.warn('network', `请求失败，准备重试 (${i + 1}/${retryCount})`, err);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }

      // 其他错误直接抛出
      throw err;
    }
  }

  // 重试耗尽
  if (showError) {
    wx.showToast({ title: '网络请求失败', icon: 'none' });
  }
  throw lastError;
}

/**
 * 判断错误是否为网络层错误（云函数未部署 / 网络不通 / DNS 失败等）
 * 统一网络错误检测，避免各页面散落硬编码
 *
 * @param {Error} err - 错误对象
 * @returns {boolean}
 */
function isNetworkError(err) {
  if (!err) return false;
  const msg = (err.message || err.errMsg || '').toLowerCase();
  // 微信小程序云函数常见网络错误关键词
  const NETWORK_KEYWORDS = [
    'fetch',          // 网络请求失败
    'network',        // 网络异常
    'timeout',        // 请求超时
    'dns',            // DNS 解析失败
    'socket',         // socket 错误
    'connect',        // 连接失败
    'abort',          // 请求被中断
    '-1',             // 微信通用网络错误码
    'request:fail'    // wx.request 失败前缀
  ];
  return NETWORK_KEYWORDS.some(keyword => msg.includes(keyword));
}

/**
 * 销毁网络管理器单例实例
 * 在小程序退出或需要重置时调用
 * 清理所有监听器和定时器，防止内存泄漏
 *
 * 使用示例：
 * ```javascript
 * // 在 app.js onUnload 中调用
 * const { destroyNetworkManager } = require('./network')
 * destroyNetworkManager()
 * ```
 */
function destroyNetworkManager() {
  if (instance) {
    // 清空所有监听器回调
    instance._listeners = [];
    // 重置状态
    instance._isConnected = true;
    instance._networkType = 'unknown';
    instance._offlineToastShown = false;

    instance = null;
  }
}

/**
 * 重置网络管理器（销毁后重新创建）
 * 用于热重载或测试场景
 */
function resetNetworkManager() {
  destroyNetworkManager();
  return getNetworkManager();
}

module.exports = {
  NetworkManager,
  getNetworkManager,
  checkNetwork,
  withNetworkCheck,
  isNetworkError,
  destroyNetworkManager,
  resetNetworkManager
};
