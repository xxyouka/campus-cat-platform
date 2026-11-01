/**
 * utils/pageState.js - 页面状态管理工具
 *
 * 管理页面间的状态同步，智能判断是否需要刷新
 * 用于从详情页返回列表页时的刷新优化
 *
 * @module pageState
 */

const { Logger } = require('./logger');

/**
 * 页面状态管理器
 */
class PageStateManager {
  constructor() {
    // 存储各页面的状态标记
    this._states = new Map();
    // 存储需要刷新的页面
    this._refreshFlags = new Map();
  }

  /**
   * 设置页面需要刷新
   * @param {string} pageName - 页面名称（如 'index', 'gallery'）
   * @param {Object} data - 可选的刷新数据
   */
  setNeedRefresh(pageName, data = null) {
    this._refreshFlags.set(pageName, {
      needRefresh: true,
      data,
      timestamp: Date.now()
    });
    Logger.info('pageState', `设置页面需要刷新: ${pageName}`, data);
  }

  /**
   * 检查页面是否需要刷新
   * @param {string} pageName - 页面名称
   * @returns {Object|null} 需要刷新返回数据，否则返回 null
   */
  checkNeedRefresh(pageName) {
    const flag = this._refreshFlags.get(pageName);
    if (!flag) return null;

    // 检查是否过期（5分钟内有效）
    const isExpired = Date.now() - flag.timestamp > 5 * 60 * 1000;
    if (isExpired) {
      this._refreshFlags.delete(pageName);
      return null;
    }

    if (flag.needRefresh) {
      // 消费掉这个标记（只刷新一次）
      flag.needRefresh = false;
      return flag.data;
    }

    return null;
  }

  /**
   * 清除页面的刷新标记
   * @param {string} pageName - 页面名称
   */
  clearRefreshFlag(pageName) {
    this._refreshFlags.delete(pageName);
  }

  /**
   * 设置页面状态
   * @param {string} pageName - 页面名称
   * @param {string} key - 状态键
   * @param {*} value - 状态值
   */
  setState(pageName, key, value) {
    if (!this._states.has(pageName)) {
      this._states.set(pageName, new Map());
    }
    this._states.get(pageName).set(key, value);
  }

  /**
   * 获取页面状态
   * @param {string} pageName - 页面名称
   * @param {string} key - 状态键
   * @returns {*} 状态值
   */
  getState(pageName, key) {
    const pageStates = this._states.get(pageName);
    if (!pageStates) return undefined;
    return pageStates.get(key);
  }

  /**
   * 清除页面所有状态
   * @param {string} pageName - 页面名称
   */
  clearPageState(pageName) {
    this._states.delete(pageName);
    this._refreshFlags.delete(pageName);
  }

  /**
   * 保存页面滚动位置
   * @param {string} pageName - 页面名称
   * @param {number} scrollTop - 滚动位置
   */
  saveScrollPosition(pageName, scrollTop) {
    this.setState(pageName, 'scrollTop', scrollTop);
  }

  /**
   * 恢复页面滚动位置
   * @param {string} pageName - 页面名称
   * @returns {number|null} 滚动位置
   */
  restoreScrollPosition(pageName) {
    const scrollTop = this.getState(pageName, 'scrollTop');
    if (scrollTop !== undefined) {
      // 恢复后清除
      const pageStates = this._states.get(pageName);
      if (pageStates) {
        pageStates.delete('scrollTop');
      }
      return scrollTop;
    }
    return null;
  }
}

// 单例实例
let instance = null;

/**
 * 获取页面状态管理器实例
 * @returns {PageStateManager}
 */
function getPageStateManager() {
  if (!instance) {
    instance = new PageStateManager();
  }
  return instance;
}

module.exports = {
  PageStateManager,
  getPageStateManager
};
