/**
 * utils/cacheCore.js - 统一缓存核心模块
 *
 * 合并自 lru-cache.js + cacheManager.js + cacheStrategy.js
 * 提供 LRU 缓存引擎、数据缓存管理器、缓存策略配置
 */

const { Logger } = require('./logger');

const CACHE_STRATEGY = {
  TTL: {
    FAVORITES: 5 * 60 * 1000,
    MEETS: 3 * 60 * 1000,
    CAT_DETAIL: 2 * 60 * 1000,
    DEFAULT: 5 * 60 * 1000
  },
  MAX_MEMORY_CACHE_SIZE: 50,
  STORAGE_PREFIX: 'cache_'
};

class LRUCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 50;
    this.maxAge = options.maxAge || 120000;
    this.cache = new Map();
    this.cleanupInterval = options.cleanupInterval || 60000;
    this._cleanupTimer = null;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0
    };

    if (typeof window !== 'undefined' || typeof wx !== 'undefined') {
      this._startCleanupTimer();
    }
  }

  set(key, value, options = {}) {
    if (key === null || key === undefined) {
      Logger.warn('LRUCache', 'key不能为null或undefined');
      return false;
    }

    const ttl = options.ttl || this.maxAge;

    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl,
      accessCount: 0,
      size: this._estimateSize(value)
    });

    return true;
  }

  get(key) {
    const item = this.cache.get(key);

    if (!item) {
      this.stats.misses++;
      return undefined;
    }

    if (this._isExpired(item)) {
      this.cache.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return undefined;
    }

    item.accessCount++;
    item.lastAccessTime = Date.now();

    this.cache.delete(key);
    this.cache.set(key, item);

    this.stats.hits++;
    return item.value;
  }

  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    if (this._isExpired(item)) {
      this.cache.delete(key);
      this.stats.expirations++;
      return false;
    }
    return true;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  cleanup() {
    const now = Date.now();

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.ttl) {
        this.cache.delete(key);
        this.stats.expirations++;
      }
    }
  }

  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests * 100).toFixed(2) : 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      usageRate: (this.cache.size / this.maxSize * 100).toFixed(1) + '%',
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: hitRate + '%',
      evictions: this.stats.evictions,
      expirations: this.stats.expirations,
      estimatedMemoryUsage: this._calculateTotalMemory(),
      keys: [...this.cache.keys()]
    };
  }

  snapshot() {
    const snapshot = [];

    for (const [key, item] of this.cache.entries()) {
      snapshot.push({
        key,
        age: Date.now() - item.timestamp,
        remainingTTL: item.ttl - (Date.now() - item.timestamp),
        accessCount: item.accessCount,
        size: item.size,
        isExpired: this._isExpired(item)
      });
    }

    return snapshot.sort((a, b) => a.age - b.age);
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this.clear();
  }

  _isExpired(item) {
    return Date.now() - item.timestamp > item.ttl;
  }

  _estimateSize(value) {
    if (!value) return 0;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value).length * 2;
      } catch {
        return 1024;
      }
    }
    return 64;
  }

  _calculateTotalMemory() {
    let totalSize = 0;
    for (const [, item] of this.cache.entries()) {
      totalSize += item.size || 0;
    }
    if (totalSize < 1024) return `${totalSize} B`;
    if (totalSize < 1024 * 1024) return `${(totalSize / 1024).toFixed(1)} KB`;
    return `${(totalSize / 1024 / 1024).toFixed(2)} MB`;
  }

  _startCleanupTimer() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => { this.cleanup(); }, this.cleanupInterval);
    // Node/Jest 环境下标记 unref，避免后台清理定时器阻止进程退出
    // （wx 运行时 setInterval 返回 number，无 unref 方法，天然跳过）
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }
}

class CacheManager {
  constructor() {
    this._memoryCache = new LRUCache({
      maxSize: CACHE_STRATEGY.MAX_MEMORY_CACHE_SIZE,
      maxAge: CACHE_STRATEGY.TTL.DEFAULT
    });
    this._cacheStats = { hits: 0, misses: 0, size: 0 };
  }

  set(key, data, ttl = CACHE_STRATEGY.TTL.DEFAULT, storageKey = null) {
    const now = Date.now();
    const cacheItem = {
      data,
      timestamp: now,
      expiresAt: now + ttl,
      key
    };

    this._memoryCache.set(key, cacheItem, { ttl });

    if (storageKey) {
      try {
        wx.setStorageSync(CACHE_STRATEGY.STORAGE_PREFIX + storageKey, {
          data,
          // 写入时间一并持久化，恢复时无需按 TTL 反推（反推在自定义 TTL 场景下会出错）
          timestamp: now,
          expiresAt: now + ttl
        });
      } catch (e) {
        console.warn('[Cache] 存储失败:', e.message);
      }
    }

    this._updateStats();
    return true;
  }

  get(key, storageKey = null) {
    const memCached = this._memoryCache.get(key);
    if (memCached && !this._isExpired(memCached)) {
      this._cacheStats.hits++;
      return memCached.data;
    }

    if (memCached) {
      this._memoryCache.delete(key);
    }

    if (storageKey) {
      try {
        const stored = wx.getStorageSync(CACHE_STRATEGY.STORAGE_PREFIX + storageKey);
        if (stored && stored.data && !this._isExpired(stored)) {
          // 优先读持久化的 timestamp；旧格式记录无此字段时按 TTL 反推兜底
          const fallbackTtl = CACHE_STRATEGY.TTL[storageKey.toUpperCase()] || CACHE_STRATEGY.TTL.DEFAULT;
          this._memoryCache.set(key, {
            data: stored.data,
            timestamp: stored.timestamp || stored.expiresAt - fallbackTtl,
            expiresAt: stored.expiresAt,
            key
          });
          this._cacheStats.hits++;
          return stored.data;
        } else {
          wx.removeStorageSync(CACHE_STRATEGY.STORAGE_PREFIX + storageKey);
        }
      } catch (e) {
        console.warn('[Cache] 读取存储失败:', e.message);
      }
    }

    this._cacheStats.misses++;
    return null;
  }

  has(key, storageKey = null) {
    return this.get(key, storageKey) !== null;
  }

  remove(key, storageKey = null) {
    this._memoryCache.delete(key);
    if (storageKey) {
      try {
        wx.removeStorageSync(CACHE_STRATEGY.STORAGE_PREFIX + storageKey);
      } catch (_e) { /* ignore storage removal errors */ }
    }
  }

  clear() {
    this._memoryCache.clear();
    this._cacheStats = { hits: 0, misses: 0, size: 0 };
  }

  clearExpired() {
    this._memoryCache.cleanup();
  }

  getStats() {
    this._updateStats();
    const hitRate = this._cacheStats.hits + this._cacheStats.misses > 0
      ? (this._cacheStats.hits / (this._cacheStats.hits + this._cacheStats.misses) * 100).toFixed(1)
      : 0;

    return {
      ...this._cacheStats,
      hitRate: `${hitRate}%`,
      memorySize: this._memoryCache.cache.size
    };
  }

  _isExpired(cacheItem) {
    if (!cacheItem || !cacheItem.expiresAt) return true;
    return Date.now() > cacheItem.expiresAt;
  }

  _updateStats() {
    this._cacheStats.size = this._memoryCache.cache.size;
  }
}

module.exports = {
  LRUCache,
  CacheManager: new CacheManager(),
  CACHE_STRATEGY
};
