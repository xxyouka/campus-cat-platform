const cacheBehavior = require('../../behaviors/cacheBehavior');

function createMockContext() {
  const ctx = {};
  const behavior = cacheBehavior;
  if (behavior.created) {
    behavior.created.call(ctx);
  }
  Object.assign(ctx, behavior.methods);
  return ctx;
}

describe('cacheBehavior', () => {
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createMockContext();
  });

  describe('created', () => {
    test('should initialize _cacheLastLoadTime to 0', () => {
      expect(ctx._cacheLastLoadTime).toBe(0);
    });

    test('should initialize _cacheValidTime to 30000', () => {
      expect(ctx._cacheValidTime).toBe(30000);
    });
  });

  describe('isCacheValid', () => {
    test('should return false when cache has never been updated', () => {
      expect(ctx.isCacheValid()).toBe(false);
    });

    test('should return true when cache was updated recently', () => {
      ctx.updateCacheTime();
      expect(ctx.isCacheValid()).toBe(true);
    });

    test('should accept custom validTime parameter', () => {
      ctx._cacheLastLoadTime = Date.now() - 5000;
      expect(ctx.isCacheValid(10000)).toBe(true);
      expect(ctx.isCacheValid(3000)).toBe(false);
    });

    test('should default validTime to 30000', () => {
      ctx._cacheLastLoadTime = Date.now() - 29000;
      expect(ctx.isCacheValid()).toBe(true);
      ctx._cacheLastLoadTime = Date.now() - 31000;
      expect(ctx.isCacheValid()).toBe(false);
    });

    test('should return false when exactly at the boundary', () => {
      const now = Date.now();
      ctx._cacheLastLoadTime = now - 30000;
      expect(ctx.isCacheValid(30000)).toBe(false);
    });
  });

  describe('updateCacheTime', () => {
    test('should set _cacheLastLoadTime to current time', () => {
      const before = Date.now();
      ctx.updateCacheTime();
      const after = Date.now();
      expect(ctx._cacheLastLoadTime).toBeGreaterThanOrEqual(before);
      expect(ctx._cacheLastLoadTime).toBeLessThanOrEqual(after);
    });

    test('should make cache valid after updating', () => {
      expect(ctx.isCacheValid()).toBe(false);
      ctx.updateCacheTime();
      expect(ctx.isCacheValid()).toBe(true);
    });
  });

  describe('clearCache', () => {
    test('should reset _cacheLastLoadTime to 0', () => {
      ctx.updateCacheTime();
      expect(ctx.isCacheValid()).toBe(true);
      ctx.clearCache();
      expect(ctx._cacheLastLoadTime).toBe(0);
      expect(ctx.isCacheValid()).toBe(false);
    });
  });

  describe('invalidateCache', () => {
    test('should reset _cacheLastLoadTime to 0', () => {
      ctx.updateCacheTime();
      ctx.invalidateCache();
      expect(ctx._cacheLastLoadTime).toBe(0);
    });

    test('should make cache invalid after invalidation', () => {
      ctx.updateCacheTime();
      ctx.invalidateCache();
      expect(ctx.isCacheValid()).toBe(false);
    });
  });

  describe('isCacheStale', () => {
    test('should return true when cache is invalid', () => {
      expect(ctx.isCacheStale()).toBe(true);
    });

    test('should return false when cache is valid', () => {
      ctx.updateCacheTime();
      expect(ctx.isCacheStale()).toBe(false);
    });

    test('should accept custom validTime parameter', () => {
      ctx._cacheLastLoadTime = Date.now() - 5000;
      expect(ctx.isCacheStale(10000)).toBe(false);
      expect(ctx.isCacheStale(3000)).toBe(true);
    });

    test('should be the inverse of isCacheValid', () => {
      ctx.updateCacheTime();
      expect(ctx.isCacheStale()).toBe(!ctx.isCacheValid());
      ctx.clearCache();
      expect(ctx.isCacheStale()).toBe(!ctx.isCacheValid());
    });
  });

  describe('loadWithCache', () => {
    test('should call loadFn when cache is stale', async () => {
      const loadFn = jest.fn().mockResolvedValue('data');
      const result = await ctx.loadWithCache(loadFn);
      expect(loadFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('data');
    });

    test('should not call loadFn when cache is valid and force is false', async () => {
      const loadFn = jest.fn().mockResolvedValue('data');
      ctx.updateCacheTime();
      const result = await ctx.loadWithCache(loadFn);
      expect(loadFn).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    test('should call loadFn when force is true even if cache is valid', async () => {
      const loadFn = jest.fn().mockResolvedValue('forced-data');
      ctx.updateCacheTime();
      const result = await ctx.loadWithCache(loadFn, { force: true });
      expect(loadFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('forced-data');
    });

    test('should update cache time after successful load', async () => {
      const loadFn = jest.fn().mockResolvedValue('data');
      const before = Date.now();
      await ctx.loadWithCache(loadFn);
      expect(ctx._cacheLastLoadTime).toBeGreaterThanOrEqual(before);
    });

    test('should use custom validTime from options', async () => {
      const loadFn = jest.fn().mockResolvedValue('data');
      ctx._cacheLastLoadTime = Date.now() - 5000;
      await ctx.loadWithCache(loadFn, { validTime: 10000 });
      expect(loadFn).not.toHaveBeenCalled();
      await ctx.loadWithCache(loadFn, { validTime: 3000 });
      expect(loadFn).toHaveBeenCalledTimes(1);
    });

    test('should return loadFn result', async () => {
      const loadFn = jest.fn().mockResolvedValue({ cats: [] });
      const result = await ctx.loadWithCache(loadFn);
      expect(result).toEqual({ cats: [] });
    });

    test('should propagate loadFn rejection', async () => {
      const loadFn = jest.fn().mockRejectedValue(new Error('network error'));
      await expect(ctx.loadWithCache(loadFn)).rejects.toThrow('network error');
    });

    test('should default options to empty object', async () => {
      const loadFn = jest.fn().mockResolvedValue('data');
      await ctx.loadWithCache(loadFn, undefined);
      expect(loadFn).toHaveBeenCalledTimes(1);
    });
  });
});
