const { LRUCache, CacheManager: _CacheManager, CACHE_STRATEGY } = require('../../utils/cacheCore');

describe('CACHE_STRATEGY', () => {
  test('should have correct TTL constants', () => {
    expect(CACHE_STRATEGY.TTL.FAVORITES).toBe(5 * 60 * 1000);
    expect(CACHE_STRATEGY.TTL.MEETS).toBe(3 * 60 * 1000);    expect(CACHE_STRATEGY.TTL.CAT_DETAIL).toBe(2 * 60 * 1000);
    expect(CACHE_STRATEGY.TTL.DEFAULT).toBe(5 * 60 * 1000);
  });

  test('should have MAX_MEMORY_CACHE_SIZE', () => {
    expect(CACHE_STRATEGY.MAX_MEMORY_CACHE_SIZE).toBe(50);
  });

  test('should have STORAGE_PREFIX', () => {
    expect(CACHE_STRATEGY.STORAGE_PREFIX).toBe('cache_');
  });
});

describe('LRUCache', () => {
  let cache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new LRUCache({ maxSize: 3, maxAge: 10000, cleanupInterval: 5000 });
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    test('should use default options', () => {
      const defaultCache = new LRUCache();
      expect(defaultCache.maxSize).toBe(50);
      expect(defaultCache.maxAge).toBe(120000);
      expect(defaultCache.cleanupInterval).toBe(60000);
      defaultCache.destroy();
    });

    test('should accept custom options', () => {
      const customCache = new LRUCache({ maxSize: 10, maxAge: 5000, cleanupInterval: 2000 });
      expect(customCache.maxSize).toBe(10);
      expect(customCache.maxAge).toBe(5000);
      expect(customCache.cleanupInterval).toBe(2000);
      customCache.destroy();
    });

    test('should initialize stats', () => {
      expect(cache.stats).toEqual({
        hits: 0,
        misses: 0,
        evictions: 0,
        expirations: 0
      });
    });

    test('should initialize empty cache', () => {
      expect(cache.cache.size).toBe(0);
    });
  });

  describe('set', () => {
    test('should store a value', () => {
      cache.set('a', 1);
      expect(cache.cache.has('a')).toBe(true);
      expect(cache.cache.get('a').value).toBe(1);
    });

    test('should return true on success', () => {
      expect(cache.set('a', 1)).toBe(true);
    });

    test('should return false for null key', () => {
      expect(cache.set(null, 1)).toBe(false);
    });

    test('should return false for undefined key', () => {
      expect(cache.set(undefined, 1)).toBe(false);
    });

    test('should warn for null key', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      cache.set(null, 1);
      // 输出已收敛到 Logger（P3-5）：Logger.warn 固定追加 data 参数（空对象格式化为 ''）
      expect(warnSpy).toHaveBeenCalledWith('[LRUCache] key不能为null或undefined', '');
      warnSpy.mockRestore();
    });

    test('should overwrite existing key and move to end', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10);
      const keys = [...cache.cache.keys()];
      expect(keys).toEqual(['b', 'a']);
      expect(cache.cache.get('a').value).toBe(10);
    });

    test('should evict oldest when exceeding maxSize', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      expect(cache.cache.has('a')).toBe(false);
      expect(cache.cache.has('d')).toBe(true);
      expect(cache.stats.evictions).toBe(1);
    });

    test('should evict multiple items when adding beyond capacity', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      cache.set('e', 5);
      expect(cache.cache.size).toBe(3);
      expect(cache.stats.evictions).toBe(2);
    });

    test('should use custom TTL from options', () => {
      cache.set('a', 1, { ttl: 5000 });
      expect(cache.cache.get('a').ttl).toBe(5000);
    });

    test('should use default maxAge when no TTL provided', () => {
      cache.set('a', 1);
      expect(cache.cache.get('a').ttl).toBe(10000);
    });

    test('should record timestamp', () => {
      const now = Date.now();
      cache.set('a', 1);
      expect(cache.cache.get('a').timestamp).toBe(now);
    });

    test('should initialize accessCount to 0', () => {
      cache.set('a', 1);
      expect(cache.cache.get('a').accessCount).toBe(0);
    });

    test('should estimate size for stored value', () => {
      cache.set('a', 'hello');
      expect(cache.cache.get('a').size).toBe('hello'.length * 2);
    });
  });

  describe('get', () => {
    test('should return value for existing key', () => {
      cache.set('a', 42);
      expect(cache.get('a')).toBe(42);
    });

    test('should return undefined for missing key', () => {
      expect(cache.get('missing')).toBeUndefined();
    });

    test('should increment misses on cache miss', () => {
      cache.get('missing');
      expect(cache.stats.misses).toBe(1);
    });

    test('should increment hits on cache hit', () => {
      cache.set('a', 1);
      cache.get('a');
      expect(cache.stats.hits).toBe(1);
    });

    test('should return undefined for expired item', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      expect(cache.get('a')).toBeUndefined();
    });

    test('should increment expirations and misses for expired item', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      cache.get('a');
      expect(cache.stats.expirations).toBe(1);
      expect(cache.stats.misses).toBe(1);
    });

    test('should delete expired item from cache', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      cache.get('a');
      expect(cache.cache.has('a')).toBe(false);
    });

    test('should increment accessCount on hit', () => {
      cache.set('a', 1);
      cache.get('a');
      cache.get('a');
      expect(cache.cache.get('a').accessCount).toBe(2);
    });

    test('should set lastAccessTime on hit', () => {
      cache.set('a', 1);
      cache.get('a');
      const item = cache.cache.get('a');
      expect(item.lastAccessTime).toBe(Date.now());
    });

    test('should move accessed item to end of cache', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a');
      const keys = [...cache.cache.keys()];
      expect(keys).toEqual(['b', 'c', 'a']);
    });
  });

  describe('has', () => {
    test('should return true for existing non-expired key', () => {
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
    });

    test('should return false for missing key', () => {
      expect(cache.has('missing')).toBe(false);
    });

    test('should return false for expired key', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      expect(cache.has('a')).toBe(false);
    });

    test('should delete and count expiration for expired key', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      cache.has('a');
      expect(cache.cache.has('a')).toBe(false);
      expect(cache.stats.expirations).toBe(1);
    });
  });

  describe('delete', () => {
    test('should remove a key', () => {
      cache.set('a', 1);
      cache.delete('a');
      expect(cache.cache.has('a')).toBe(false);
    });

    test('should return true for existing key', () => {
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
    });

    test('should return false for non-existing key', () => {
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    test('should remove all items', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.cache.size).toBe(0);
    });
  });

  describe('cleanup', () => {
    test('should remove expired items', () => {
      cache.set('a', 1, { ttl: 100 });
      cache.set('b', 2, { ttl: 100 });
      cache.set('c', 3, { ttl: 50000 });
      jest.advanceTimersByTime(200);
      cache.cleanup();
      expect(cache.cache.size).toBe(1);
      expect(cache.cache.has('c')).toBe(true);
    });

    test('should increment expirations for each removed item', () => {
      cache.set('a', 1, { ttl: 100 });
      cache.set('b', 2, { ttl: 100 });
      jest.advanceTimersByTime(200);
      cache.cleanup();
      expect(cache.stats.expirations).toBe(2);
    });

    test('should not remove non-expired items', () => {
      cache.set('a', 1, { ttl: 50000 });
      cache.cleanup();
      expect(cache.cache.size).toBe(1);
    });
  });

  describe('getStats', () => {
    test('should return stats object with correct shape', () => {
      cache.set('a', 1);
      const stats = cache.getStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats).toHaveProperty('usageRate');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('evictions');
      expect(stats).toHaveProperty('expirations');
      expect(stats).toHaveProperty('estimatedMemoryUsage');
      expect(stats).toHaveProperty('keys');
    });

    test('should report correct size', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.getStats().size).toBe(2);
    });

    test('should report correct maxSize', () => {
      expect(cache.getStats().maxSize).toBe(3);
    });

    test('should calculate hitRate correctly', () => {
      cache.set('a', 1);
      cache.get('a');
      cache.get('a');
      cache.get('missing');
      expect(cache.getStats().hitRate).toBe('66.67%');
    });

    test('should report 0 hitRate when no requests', () => {
      expect(cache.getStats().hitRate).toBe('0%');
    });

    test('should include keys array', () => {
      cache.set('x', 1);
      cache.set('y', 2);
      expect(cache.getStats().keys).toEqual(['x', 'y']);
    });

    test('should report evictions', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      expect(cache.getStats().evictions).toBe(1);
    });
  });

  describe('snapshot', () => {
    test('should return array of cache items', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      const snap = cache.snapshot();
      expect(snap.length).toBe(2);
    });

    test('should include key, age, remainingTTL, accessCount, size, isExpired', () => {
      cache.set('a', 1);
      const item = cache.snapshot()[0];
      expect(item).toHaveProperty('key', 'a');
      expect(item).toHaveProperty('age');
      expect(item).toHaveProperty('remainingTTL');
      expect(item).toHaveProperty('accessCount');
      expect(item).toHaveProperty('size');
      expect(item).toHaveProperty('isExpired');
    });

    test('should sort by age ascending', () => {
      cache.set('a', 1);
      jest.advanceTimersByTime(10);
      cache.set('b', 2);
      const snap = cache.snapshot();
      expect(snap[0].key).toBe('b');
      expect(snap[1].key).toBe('a');
    });

    test('should return empty array for empty cache', () => {
      expect(cache.snapshot()).toEqual([]);
    });
  });

  describe('destroy', () => {
    test('should clear the cache', () => {
      cache.set('a', 1);
      cache.destroy();
      expect(cache.cache.size).toBe(0);
    });

    test('should clear cleanup timer', () => {
      cache.destroy();
      expect(cache._cleanupTimer).toBeNull();
    });

    test('should be safe to call multiple times', () => {
      cache.destroy();
      expect(() => cache.destroy()).not.toThrow();
    });
  });

  describe('_isExpired', () => {
    test('should return false for non-expired item', () => {
      cache.set('a', 1, { ttl: 50000 });
      const item = cache.cache.get('a');
      expect(cache._isExpired(item)).toBe(false);
    });

    test('should return true for expired item', () => {
      cache.set('a', 1, { ttl: 100 });
      jest.advanceTimersByTime(200);
      const item = cache.cache.get('a');
      expect(cache._isExpired(item)).toBe(true);
    });
  });

  describe('_estimateSize', () => {
    test('should return 0 for falsy values', () => {
      expect(cache._estimateSize(null)).toBe(0);
      expect(cache._estimateSize(undefined)).toBe(0);
      expect(cache._estimateSize(0)).toBe(0);
      expect(cache._estimateSize('')).toBe(0);
      expect(cache._estimateSize(false)).toBe(0);
    });

    test('should return length*2 for strings', () => {
      expect(cache._estimateSize('hello')).toBe(10);
      expect(cache._estimateSize('abc')).toBe(6);
    });

    test('should return JSON length*2 for objects', () => {
      const obj = { a: 1 };
      expect(cache._estimateSize(obj)).toBe(JSON.stringify(obj).length * 2);
    });

    test('should return 1024 for circular objects', () => {
      const circular = {};
      circular.self = circular;
      expect(cache._estimateSize(circular)).toBe(1024);
    });

    test('should return 64 for other types', () => {
      expect(cache._estimateSize(123)).toBe(64);
      expect(cache._estimateSize(true)).toBe(64);
      expect(cache._estimateSize(() => {})).toBe(64);
    });
  });

  describe('_calculateTotalMemory', () => {
    test('should return bytes for small sizes', () => {
      cache.set('a', 'hi');
      expect(cache._calculateTotalMemory()).toBe('4 B');
    });

    test('should return KB for medium sizes', () => {
      const longStr = 'x'.repeat(600);
      cache.set('a', longStr);
      const result = cache._calculateTotalMemory();
      expect(result).toContain('KB');
    });

    test('should return MB for large sizes', () => {
      const veryLongStr = 'x'.repeat(600000);
      cache.set('a', veryLongStr);
      const result = cache._calculateTotalMemory();
      expect(result).toContain('MB');
    });

    test('should return 0 B for empty cache', () => {
      expect(cache._calculateTotalMemory()).toBe('0 B');
    });
  });

  describe('_startCleanupTimer', () => {
    test('should set up interval timer', () => {
      const timerCache = new LRUCache({ maxSize: 5, maxAge: 10000, cleanupInterval: 1000 });
      expect(timerCache._cleanupTimer).not.toBeNull();
      timerCache.destroy();
    });

    test('should call cleanup on interval', () => {
      const timerCache = new LRUCache({ maxSize: 5, maxAge: 100, cleanupInterval: 1000 });
      timerCache.set('a', 1, { ttl: 50 });
      jest.advanceTimersByTime(60);
      jest.advanceTimersByTime(1000);
      expect(timerCache.cache.size).toBe(0);
      timerCache.destroy();
    });

    test('should replace existing timer on re-init', () => {
      const timerCache = new LRUCache({ maxSize: 5, maxAge: 10000, cleanupInterval: 1000 });
      const oldTimer = timerCache._cleanupTimer;
      timerCache._startCleanupTimer();
      expect(timerCache._cleanupTimer).not.toBe(oldTimer);
      timerCache.destroy();
    });
  });
});

describe('CacheManager', () => {
  let manager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new (require('../../utils/cacheCore').CacheManager.constructor)();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    manager._memoryCache.destroy();
    manager.clear();
    console.warn.mockRestore();
    jest.useRealTimers();
  });

  describe('set', () => {
    test('should store data in memory cache', () => {
      manager.set('key1', { name: 'cat' });
      expect(manager._memoryCache.cache.has('key1')).toBe(true);
    });

    test('should return true', () => {
      expect(manager.set('key1', 'data')).toBe(true);
    });

    test('should store with default TTL', () => {
      manager.set('key1', 'data');
      const item = manager._memoryCache.cache.get('key1');
      expect(item.value.expiresAt - item.value.timestamp).toBe(CACHE_STRATEGY.TTL.DEFAULT);
    });

    test('should store with custom TTL', () => {
      manager.set('key1', 'data', 3000);
      const item = manager._memoryCache.cache.get('key1');
      expect(item.value.expiresAt - item.value.timestamp).toBe(3000);
    });

    test('should write to wx storage when storageKey provided', () => {
      manager.set('key1', 'data', 5000, 'myKey');
      expect(wx.setStorageSync).toHaveBeenCalledWith('cache_myKey', {
        data: 'data',
        // timestamp 一并持久化，恢复时无需按 TTL 反推
        timestamp: expect.any(Number),
        expiresAt: expect.any(Number)
      });
    });

    test('should not write to wx storage when storageKey is null', () => {
      wx.setStorageSync.mockClear();
      manager.set('key1', 'data', 5000);
      expect(wx.setStorageSync).not.toHaveBeenCalled();
    });

    test('should handle wx storage write failure gracefully', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('storage full'); });
      expect(() => manager.set('key1', 'data', 5000, 'myKey')).not.toThrow();
      expect(console.warn).toHaveBeenCalledWith('[Cache] 存储失败:', 'storage full');
    });

    test('should update stats after set', () => {
      manager.set('key1', 'data');
      expect(manager._cacheStats.size).toBe(1);
    });
  });

  describe('get', () => {
    test('should return data from memory cache on hit', () => {
      manager.set('key1', { name: 'cat' });
      expect(manager.get('key1')).toEqual({ name: 'cat' });
    });

    test('should increment hits on memory hit', () => {
      manager.set('key1', 'data');
      manager.get('key1');
      expect(manager._cacheStats.hits).toBe(1);
    });

    test('should return null on miss', () => {
      expect(manager.get('missing')).toBeNull();
    });

    test('should increment misses on miss', () => {
      manager.get('missing');
      expect(manager._cacheStats.misses).toBe(1);
    });

    test('should return null for expired memory item', () => {
      manager.set('key1', 'data', 100);
      jest.advanceTimersByTime(200);
      expect(manager.get('key1')).toBeNull();
    });

    test('should delete expired item from memory', () => {
      manager.set('key1', 'data', 100);
      jest.advanceTimersByTime(200);
      manager.get('key1');
      expect(manager._memoryCache.cache.has('key1')).toBe(false);
    });

    test('should fall back to wx storage when memory miss', () => {
      wx.getStorageSync.mockReturnValue({ data: 'stored_data', expiresAt: Date.now() + 10000 });
      const result = manager.get('key1', 'storageKey');
      expect(result).toBe('stored_data');
    });

    test('should use correct storage key with prefix', () => {
      wx.getStorageSync.mockReturnValue({ data: 'stored', expiresAt: Date.now() + 10000 });
      manager.get('key1', 'myKey');
      expect(wx.getStorageSync).toHaveBeenCalledWith('cache_myKey');
    });

    test('should re-populate memory from storage on fallback hit', () => {
      wx.getStorageSync.mockReturnValue({ data: 'stored', expiresAt: Date.now() + 10000 });
      manager.get('key1', 'storageKey');
      expect(manager._memoryCache.cache.has('key1')).toBe(true);
    });

    test('should increment hits on storage fallback hit', () => {
      wx.getStorageSync.mockReturnValue({ data: 'stored', expiresAt: Date.now() + 10000 });
      manager.get('key1', 'storageKey');
      expect(manager._cacheStats.hits).toBe(1);
    });

    test('should remove expired storage item', () => {
      wx.getStorageSync.mockReturnValue({ data: 'old', expiresAt: Date.now() - 1000 });
      manager.get('key1', 'storageKey');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('cache_storageKey');
    });

    test('should return null for expired storage item', () => {
      wx.getStorageSync.mockReturnValue({ data: 'old', expiresAt: Date.now() - 1000 });
      expect(manager.get('key1', 'storageKey')).toBeNull();
    });

    test('should handle storage read failure gracefully', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('read error'); });
      expect(manager.get('key1', 'storageKey')).toBeNull();
      expect(console.warn).toHaveBeenCalledWith('[Cache] 读取存储失败:', 'read error');
    });

    test('should return null for storage item without data', () => {
      wx.getStorageSync.mockReturnValue({ expiresAt: Date.now() + 10000 });
      expect(manager.get('key1', 'storageKey')).toBeNull();
    });
  });

  describe('has', () => {
    test('should return true for existing key', () => {
      manager.set('key1', 'data');
      expect(manager.has('key1')).toBe(true);
    });

    test('should return false for missing key', () => {
      expect(manager.has('missing')).toBe(false);
    });

    test('should return false for expired key', () => {
      manager.set('key1', 'data', 100);
      jest.advanceTimersByTime(200);
      expect(manager.has('key1')).toBe(false);
    });
  });

  describe('remove', () => {
    test('should remove from memory cache', () => {
      manager.set('key1', 'data');
      manager.remove('key1');
      expect(manager._memoryCache.cache.has('key1')).toBe(false);
    });

    test('should remove from wx storage when storageKey provided', () => {
      manager.remove('key1', 'myKey');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('cache_myKey');
    });

    test('should not call wx storage when no storageKey', () => {
      wx.removeStorageSync.mockClear();
      manager.remove('key1');
      expect(wx.removeStorageSync).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    test('should clear memory cache', () => {
      manager.set('key1', 'data');
      manager.set('key2', 'data2');
      manager.clear();
      expect(manager._memoryCache.cache.size).toBe(0);
    });

    test('should reset stats', () => {
      manager.set('key1', 'data');
      manager.get('key1');
      manager.clear();
      expect(manager._cacheStats).toEqual({ hits: 0, misses: 0, size: 0 });
    });
  });

  describe('clearExpired', () => {
    test('should delegate to memory cache cleanup', () => {
      manager.set('key1', 'data', 100);
      jest.advanceTimersByTime(200);
      manager.clearExpired();
      expect(manager._memoryCache.cache.size).toBe(0);
    });
  });

  describe('getStats', () => {
    test('should return stats object with correct shape', () => {
      const stats = manager.getStats();
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('memorySize');
    });

    test('should calculate hitRate correctly', () => {
      manager.set('key1', 'data');
      manager.get('key1');
      manager.get('missing');
      const stats = manager.getStats();
      expect(stats.hitRate).toBe('50.0%');
    });

    test('should report 0% hitRate with no requests', () => {
      expect(manager.getStats().hitRate).toBe('0%');
    });

    test('should report memorySize', () => {
      manager.set('key1', 'data');
      manager.set('key2', 'data2');
      expect(manager.getStats().memorySize).toBe(2);
    });
  });

  describe('_isExpired', () => {
    test('should return true for null item', () => {
      expect(manager._isExpired(null)).toBe(true);
    });

    test('should return true for item without expiresAt', () => {
      expect(manager._isExpired({})).toBe(true);
    });

    test('should return true for expired item', () => {
      expect(manager._isExpired({ expiresAt: Date.now() - 1000 })).toBe(true);
    });

    test('should return false for non-expired item', () => {
      expect(manager._isExpired({ expiresAt: Date.now() + 10000 })).toBe(false);
    });
  });

  describe('_updateStats', () => {
    test('should update size to match memory cache size', () => {
      manager.set('key1', 'data');
      manager.set('key2', 'data2');
      manager._updateStats();
      expect(manager._cacheStats.size).toBe(2);
    });
  });
});
