// cloudfunctions/utils/cache.js - 云函数缓存工具
const NodeCache = require('node-cache');

// 创建30秒TTL的内存缓存
const cache = new NodeCache({
  stdTTL: 30,        // 默认30秒过期
  checkperiod: 10,   // 每10秒检查过期
  useClones: false   // 不克隆对象以提高性能
});

class CloudCache {
  /**
   * 获取或设置缓存数据
   * @param {string} key - 缓存键
   * @param {Function} fn - 数据获取函数
   * @param {number} ttl - 过期时间(秒)，默认30秒
   * @returns {Promise<any>} 缓存的数据
   */
  static async getOrSet(key, fn, ttl = 30) {
    // 尝试从缓存获取
    const cached = cache.get(key);
    if (cached !== undefined) {
      console.log(`[CloudCache HIT] ${key}`);
      return cached;
    }

    console.log(`[CloudCache MISS] ${key}`);
    try {
      // 执行数据获取函数
      const data = await fn();

      // 存入缓存
      cache.set(key, data, ttl);

      return data;
    } catch (err) {
      console.error(`[CloudCache ERROR] ${key}:`, err);
      throw err;
    }
  }

  /**
   * 手动设置缓存
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间(秒)
   */
  static set(key, value, ttl = 30) {
    cache.set(key, value, ttl);
  }

  /**
   * 获取缓存
   * @param {string} key - 缓存键
   * @returns {any} 缓存值或undefined
   */
  static get(key) {
    return cache.get(key);
  }

  /**
   * 删除缓存
   * @param {string} key - 缓存键
   * @returns {boolean} 是否删除成功
   */
  static del(key) {
    return cache.del(key);
  }

  /**
   * 清空所有缓存
   */
  static flushAll() {
    cache.flushAll();
    console.log('[CloudCache] 缓存已清空');
  }

  /**
   * 获取缓存统计信息
   * @returns {Object} 缓存统计
   */
  static getStats() {
    return cache.getStats();
  }

  /**
   * 生成缓存键
   * @param {string} prefix - 前缀
   * @param {any[]} params - 参数数组
   * @returns {string} 缓存键
   */
  static generateKey(prefix, ...params) {
    const paramStr = params.map(p => String(p)).join(':');
    return `${prefix}:${paramStr}`;
  }
}

module.exports = CloudCache;