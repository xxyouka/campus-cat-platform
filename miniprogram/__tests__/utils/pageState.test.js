const { PageStateManager, getPageStateManager } = require('../../utils/pageState');

describe('PageStateManager', () => {
  let manager;

  beforeEach(() => {
    manager = new PageStateManager();
  });

  describe('constructor', () => {
    test('should initialize _states as a Map', () => {
      expect(manager._states).toBeInstanceOf(Map);
      expect(manager._states.size).toBe(0);
    });

    test('should initialize _refreshFlags as a Map', () => {
      expect(manager._refreshFlags).toBeInstanceOf(Map);
      expect(manager._refreshFlags.size).toBe(0);
    });
  });

  describe('setNeedRefresh', () => {
    test('should set refresh flag with needRefresh true', () => {
      manager.setNeedRefresh('index');
      const flag = manager._refreshFlags.get('index');
      expect(flag.needRefresh).toBe(true);
    });

    test('should set data to null by default', () => {
      manager.setNeedRefresh('index');
      const flag = manager._refreshFlags.get('index');
      expect(flag.data).toBeNull();
    });

    test('should store provided data', () => {
      manager.setNeedRefresh('index', { catId: '123' });
      const flag = manager._refreshFlags.get('index');
      expect(flag.data).toEqual({ catId: '123' });
    });

    test('should set timestamp to current time', () => {
      const before = Date.now();
      manager.setNeedRefresh('index');
      const after = Date.now();
      const flag = manager._refreshFlags.get('index');
      expect(flag.timestamp).toBeGreaterThanOrEqual(before);
      expect(flag.timestamp).toBeLessThanOrEqual(after);
    });

    test('should overwrite previous flag for same page', () => {
      manager.setNeedRefresh('index', { a: 1 });
      manager.setNeedRefresh('index', { b: 2 });
      const flag = manager._refreshFlags.get('index');
      expect(flag.data).toEqual({ b: 2 });
    });

    test('should handle multiple pages independently', () => {
      manager.setNeedRefresh('index', { from: 'index' });
      manager.setNeedRefresh('gallery', { from: 'gallery' });
      expect(manager._refreshFlags.get('index').data).toEqual({ from: 'index' });
      expect(manager._refreshFlags.get('gallery').data).toEqual({ from: 'gallery' });
    });
  });

  describe('checkNeedRefresh', () => {
    test('should return null when no flag exists', () => {
      expect(manager.checkNeedRefresh('index')).toBeNull();
    });

    test('should return data when flag is set and not expired', () => {
      manager.setNeedRefresh('index', { catId: 'abc' });
      expect(manager.checkNeedRefresh('index')).toEqual({ catId: 'abc' });
    });

    test('should return null data when set with default', () => {
      manager.setNeedRefresh('index');
      expect(manager.checkNeedRefresh('index')).toBeNull();
    });

    test('should consume flag on first check', () => {
      manager.setNeedRefresh('index', { x: 1 });
      expect(manager.checkNeedRefresh('index')).toEqual({ x: 1 });
      expect(manager.checkNeedRefresh('index')).toBeNull();
    });

    test('should set needRefresh to false after first check', () => {
      manager.setNeedRefresh('index');
      manager.checkNeedRefresh('index');
      const flag = manager._refreshFlags.get('index');
      expect(flag.needRefresh).toBe(false);
    });

    test('should return null for already consumed flag', () => {
      manager.setNeedRefresh('index', { a: 1 });
      manager.checkNeedRefresh('index');
      expect(manager.checkNeedRefresh('index')).toBeNull();
    });

    test('should return null and delete flag when expired', () => {
      manager.setNeedRefresh('index', { old: true });
      const flag = manager._refreshFlags.get('index');
      flag.timestamp = Date.now() - 5 * 60 * 1000 - 1;
      expect(manager.checkNeedRefresh('index')).toBeNull();
      expect(manager._refreshFlags.has('index')).toBe(false);
    });

    test('should return data when flag is exactly at 5 minute boundary', () => {
      // 固定时钟：否则 Date.now() 在赋值与断言之间走 1ms 就会越过 > 5min 的判据，
      // 这个用例会偶发变红（2026-10-20 全量 check 实测）。
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        manager.setNeedRefresh('index', { edge: true });
        const flag = manager._refreshFlags.get('index');
        flag.timestamp = now - 5 * 60 * 1000;
        expect(manager.checkNeedRefresh('index')).toEqual({ edge: true });
      } finally {
        spy.mockRestore();
      }
    });

    test('should handle different pages independently', () => {
      manager.setNeedRefresh('index', { page: 'index' });
      manager.setNeedRefresh('gallery', { page: 'gallery' });
      expect(manager.checkNeedRefresh('index')).toEqual({ page: 'index' });
      expect(manager.checkNeedRefresh('gallery')).toEqual({ page: 'gallery' });
    });

    test('should not affect other pages when consuming one', () => {
      manager.setNeedRefresh('index');
      manager.setNeedRefresh('gallery');
      manager.checkNeedRefresh('index');
      expect(manager.checkNeedRefresh('gallery')).toBeNull();
      expect(manager._refreshFlags.get('gallery').needRefresh).toBe(false);
    });
  });

  describe('clearRefreshFlag', () => {
    test('should delete refresh flag for specified page', () => {
      manager.setNeedRefresh('index');
      manager.clearRefreshFlag('index');
      expect(manager._refreshFlags.has('index')).toBe(false);
    });

    test('should not throw when clearing non-existent flag', () => {
      expect(() => manager.clearRefreshFlag('nonexistent')).not.toThrow();
    });

    test('should not affect other pages', () => {
      manager.setNeedRefresh('index');
      manager.setNeedRefresh('gallery');
      manager.clearRefreshFlag('index');
      expect(manager._refreshFlags.has('index')).toBe(false);
      expect(manager._refreshFlags.has('gallery')).toBe(true);
    });
  });

  describe('setState', () => {
    test('should set state for a page and key', () => {
      manager.setState('index', 'scrollTop', 100);
      expect(manager.getState('index', 'scrollTop')).toBe(100);
    });

    test('should create page Map if not exists', () => {
      manager.setState('index', 'key', 'value');
      expect(manager._states.has('index')).toBe(true);
      expect(manager._states.get('index')).toBeInstanceOf(Map);
    });

    test('should overwrite existing value for same key', () => {
      manager.setState('index', 'key', 'old');
      manager.setState('index', 'key', 'new');
      expect(manager.getState('index', 'key')).toBe('new');
    });

    test('should handle multiple keys per page', () => {
      manager.setState('index', 'key1', 'val1');
      manager.setState('index', 'key2', 'val2');
      expect(manager.getState('index', 'key1')).toBe('val1');
      expect(manager.getState('index', 'key2')).toBe('val2');
    });

    test('should handle multiple pages independently', () => {
      manager.setState('index', 'key', 'indexVal');
      manager.setState('gallery', 'key', 'galleryVal');
      expect(manager.getState('index', 'key')).toBe('indexVal');
      expect(manager.getState('gallery', 'key')).toBe('galleryVal');
    });

    test('should store various value types', () => {
      manager.setState('index', 'str', 'hello');
      manager.setState('index', 'num', 42);
      manager.setState('index', 'bool', true);
      manager.setState('index', 'obj', { a: 1 });
      manager.setState('index', 'arr', [1, 2, 3]);
      manager.setState('index', 'null', null);
      expect(manager.getState('index', 'str')).toBe('hello');
      expect(manager.getState('index', 'num')).toBe(42);
      expect(manager.getState('index', 'bool')).toBe(true);
      expect(manager.getState('index', 'obj')).toEqual({ a: 1 });
      expect(manager.getState('index', 'arr')).toEqual([1, 2, 3]);
      expect(manager.getState('index', 'null')).toBeNull();
    });
  });

  describe('getState', () => {
    test('should return undefined for non-existent page', () => {
      expect(manager.getState('nonexistent', 'key')).toBeUndefined();
    });

    test('should return undefined for non-existent key', () => {
      manager.setState('index', 'existing', 'val');
      expect(manager.getState('index', 'nonexistent')).toBeUndefined();
    });

    test('should return stored value', () => {
      manager.setState('index', 'key', 'value');
      expect(manager.getState('index', 'key')).toBe('value');
    });
  });

  describe('clearPageState', () => {
    test('should delete states for specified page', () => {
      manager.setState('index', 'key', 'value');
      manager.clearPageState('index');
      expect(manager._states.has('index')).toBe(false);
    });

    test('should delete refresh flags for specified page', () => {
      manager.setNeedRefresh('index');
      manager.clearPageState('index');
      expect(manager._refreshFlags.has('index')).toBe(false);
    });

    test('should clear both states and refresh flags', () => {
      manager.setState('index', 'key', 'value');
      manager.setNeedRefresh('index', { data: true });
      manager.clearPageState('index');
      expect(manager._states.has('index')).toBe(false);
      expect(manager._refreshFlags.has('index')).toBe(false);
    });

    test('should not affect other pages', () => {
      manager.setState('index', 'key', 'value');
      manager.setState('gallery', 'key', 'value');
      manager.setNeedRefresh('index');
      manager.setNeedRefresh('gallery');
      manager.clearPageState('index');
      expect(manager._states.has('index')).toBe(false);
      expect(manager._refreshFlags.has('index')).toBe(false);
      expect(manager._states.has('gallery')).toBe(true);
      expect(manager._refreshFlags.has('gallery')).toBe(true);
    });

    test('should not throw for non-existent page', () => {
      expect(() => manager.clearPageState('nonexistent')).not.toThrow();
    });
  });

  describe('saveScrollPosition', () => {
    test('should save scrollTop via setState', () => {
      manager.saveScrollPosition('index', 250);
      expect(manager.getState('index', 'scrollTop')).toBe(250);
    });

    test('should overwrite previous scroll position', () => {
      manager.saveScrollPosition('index', 100);
      manager.saveScrollPosition('index', 200);
      expect(manager.getState('index', 'scrollTop')).toBe(200);
    });

    test('should handle zero scrollTop', () => {
      manager.saveScrollPosition('index', 0);
      expect(manager.getState('index', 'scrollTop')).toBe(0);
    });
  });

  describe('restoreScrollPosition', () => {
    test('should return saved scroll position', () => {
      manager.saveScrollPosition('index', 300);
      expect(manager.restoreScrollPosition('index')).toBe(300);
    });

    test('should return null when no scroll position saved', () => {
      expect(manager.restoreScrollPosition('index')).toBeNull();
    });

    test('should delete scrollTop after restoring', () => {
      manager.saveScrollPosition('index', 300);
      manager.restoreScrollPosition('index');
      const pageStates = manager._states.get('index');
      expect(pageStates.has('scrollTop')).toBe(false);
    });

    test('should return null on second restore call', () => {
      manager.saveScrollPosition('index', 300);
      expect(manager.restoreScrollPosition('index')).toBe(300);
      expect(manager.restoreScrollPosition('index')).toBeNull();
    });

    test('should not affect other state keys on the same page', () => {
      manager.setState('index', 'otherKey', 'otherValue');
      manager.saveScrollPosition('index', 300);
      manager.restoreScrollPosition('index');
      expect(manager.getState('index', 'otherKey')).toBe('otherValue');
    });

    test('should handle zero scrollTop correctly', () => {
      manager.saveScrollPosition('index', 0);
      expect(manager.restoreScrollPosition('index')).toBe(0);
    });
  });
});

describe('getPageStateManager', () => {
  let _originalInstance;

  beforeAll(() => {
    const mod = require('../../utils/pageState');
    _originalInstance = mod._instance;
  });

  afterEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    jest.resetModules();
  });

  test('should return a PageStateManager instance', () => {
    const result = getPageStateManager();
    expect(result).toBeInstanceOf(PageStateManager);
  });

  test('should return same instance on multiple calls', () => {
    const a = getPageStateManager();
    const b = getPageStateManager();
    expect(a).toBe(b);
  });

  test('should create new instance after module reset', () => {
    const first = getPageStateManager();
    jest.resetModules();
    const { getPageStateManager: freshGet, PageStateManager: FreshPageStateManager } = require('../../utils/pageState');
    const second = freshGet();
    expect(second).toBeInstanceOf(FreshPageStateManager);
    expect(second).not.toBe(first);
  });
});
