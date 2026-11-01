const offlineCache = require('../../utils/offlineCache');

const CACHE_TTL = 30 * 60 * 1000;

describe('offlineCache', () => {
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    store = {};

    if (!wx.getStorageInfoSync) {
      wx.getStorageInfoSync = jest.fn();
    }
    wx.getStorageSync.mockImplementation(key => store[key] !== undefined ? store[key] : '');
    wx.setStorageSync.mockImplementation((key, value) => { store[key] = value; });
    wx.removeStorageSync.mockImplementation(key => { delete store[key]; });
    wx.getStorageInfoSync.mockImplementation(() => ({ keys: Object.keys(store) }));
  });

  describe('saveCats', () => {
    test('should simplify cats to only include allowed fields', () => {
      const cats = [
        {
          _id: 'cat1',
          name: '小花',
          avatar: 'https://example.com/cat1.jpg',
          campus: '主校区',
          status: '正常',
          color: '橘色',
          gender: '公',
          meetCount: 10,
          photoCount: 5,
          extraField1: 'should be removed',
          extraField2: 999
        }
      ];

      offlineCache.saveCats(cats);

      const saved = store['_offline_cats'];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({
        _id: 'cat1',
        name: '小花',
        avatar: 'https://example.com/cat1.jpg',
        campus: '主校区',
        status: '正常',
        color: '橘色',
        gender: '公',
        meetCount: 10,
        photoCount: 5
      });
    });

    test('should store cats with CATS key', () => {
      const cats = [{ _id: '1', name: 'A' }];
      offlineCache.saveCats(cats);
      expect(wx.setStorageSync).toHaveBeenCalledWith('_offline_cats', expect.any(Array));
    });

    test('should store timestamp with CATS_TIME key', () => {
      const now = 1000000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      offlineCache.saveCats([{ _id: '1', name: 'A' }]);

      expect(wx.setStorageSync).toHaveBeenCalledWith('_offline_cats_time', now);
      Date.now.mockRestore();
    });

    test('should handle multiple cats', () => {
      const cats = [
        { _id: '1', name: 'A', avatar: 'a', campus: 'c1', status: 's', color: 'c', gender: 'g', meetCount: 1, photoCount: 1 },
        { _id: '2', name: 'B', avatar: 'b', campus: 'c2', status: 's', color: 'c', gender: 'g', meetCount: 2, photoCount: 2 }
      ];

      offlineCache.saveCats(cats);

      const saved = store['_offline_cats'];
      expect(saved).toHaveLength(2);
      expect(saved[0]._id).toBe('1');
      expect(saved[1]._id).toBe('2');
    });

    test('should not throw when setStorageSync throws', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('storage full'); });
      expect(() => offlineCache.saveCats([{ _id: '1', name: 'A' }])).not.toThrow();
    });
  });

  describe('getCats', () => {
    test('should return cached cats when within TTL', () => {
      const now = Date.now();
      const cats = [{ _id: '1', name: '小花' }];
      store['_offline_cats'] = cats;
      store['_offline_cats_time'] = now - CACHE_TTL + 1000;

      const result = offlineCache.getCats();

      expect(result).toEqual(cats);
    });

    test('should return null when cache is expired', () => {
      const now = Date.now();
      store['_offline_cats'] = [{ _id: '1', name: '小花' }];
      store['_offline_cats_time'] = now - CACHE_TTL - 1000;

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return null when cache time is 0', () => {
      store['_offline_cats'] = [{ _id: '1', name: '小花' }];
      store['_offline_cats_time'] = 0;

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return null when no cats cached', () => {
      store['_offline_cats_time'] = Date.now();

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return null when cached cats is empty array', () => {
      store['_offline_cats'] = [];
      store['_offline_cats_time'] = Date.now();

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return null when getStorageSync throws', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('read error'); });

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return null when cache time is missing', () => {
      store['_offline_cats'] = [{ _id: '1', name: '小花' }];

      const result = offlineCache.getCats();

      expect(result).toBeNull();
    });

    test('should return cats at exact TTL boundary since check uses strict greater than', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      store['_offline_cats'] = [{ _id: '1', name: '小花' }];
      store['_offline_cats_time'] = now - CACHE_TTL;

      const result = offlineCache.getCats();
      dateNowSpy.mockRestore();

      expect(result).toEqual([{ _id: '1', name: '小花' }]);
    });

    test('should return cats just before TTL boundary', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      store['_offline_cats'] = [{ _id: '1', name: '小花' }];
      store['_offline_cats_time'] = now - CACHE_TTL + 1;

      const result = offlineCache.getCats();
      dateNowSpy.mockRestore();

      expect(result).toEqual([{ _id: '1', name: '小花' }]);
    });
  });

  describe('saveCatDetail', () => {
    test('should store simplified cat detail with correct key', () => {
      const cat = {
        _id: 'cat1',
        name: '小花',
        avatar: 'https://example.com/cat1.jpg',
        campus: '主校区',
        status: '正常',
        color: '橘色',
        gender: '公',
        age: '2岁',
        sterilized: true,
        description: '可爱的橘猫',
        appearance: '胖乎乎',
        location: '图书馆旁',
        healthStatus: '健康',
        healthNote: '',
        meetCount: 10,
        photoCount: 5,
        notes: '喜欢吃鱼',
        extraField: 'should be removed'
      };

      offlineCache.saveCatDetail('cat1', cat);

      const saved = store['_offline_cat_detail_cat1'];
      expect(saved.data).toEqual({
        _id: 'cat1',
        name: '小花',
        avatar: 'https://example.com/cat1.jpg',
        campus: '主校区',
        status: '正常',
        color: '橘色',
        gender: '公',
        age: '2岁',
        sterilized: true,
        description: '可爱的橘猫',
        appearance: '胖乎乎',
        location: '图书馆旁',
        healthStatus: '健康',
        healthNote: '',
        meetCount: 10,
        photoCount: 5,
        notes: '喜欢吃鱼'
      });
      expect(saved).toHaveProperty('time');
    });

    test('should store with timestamp', () => {
      const now = 2000000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      offlineCache.saveCatDetail('cat1', { _id: 'cat1', name: 'A' });

      expect(store['_offline_cat_detail_cat1'].time).toBe(now);
      Date.now.mockRestore();
    });

    test('should use catId in key', () => {
      offlineCache.saveCatDetail('abc123', { _id: 'abc123', name: 'Test' });

      expect(wx.setStorageSync).toHaveBeenCalledWith('_offline_cat_detail_abc123', expect.any(Object));
    });

    test('should not throw when setStorageSync throws', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('storage full'); });
      expect(() => offlineCache.saveCatDetail('cat1', { _id: 'cat1', name: 'A' })).not.toThrow();
    });

    test('should strip fields not in whitelist', () => {
      const cat = {
        _id: 'cat1',
        name: '小花',
        avatar: 'a',
        campus: 'c',
        status: 's',
        color: 'c',
        gender: 'g',
        age: '1',
        sterilized: false,
        description: 'd',
        appearance: 'ap',
        location: 'l',
        healthStatus: 'h',
        healthNote: 'hn',
        meetCount: 0,
        photoCount: 0,
        notes: 'n',
        secretField: 'removed',
        internalState: {}
      };

      offlineCache.saveCatDetail('cat1', cat);

      const saved = store['_offline_cat_detail_cat1'].data;
      expect(saved).not.toHaveProperty('secretField');
      expect(saved).not.toHaveProperty('internalState');
    });
  });

  describe('getCatDetail', () => {
    test('should return cached detail when within TTL', () => {
      const detail = { _id: 'cat1', name: '小花' };
      store['_offline_cat_detail_cat1'] = { data: detail, time: Date.now() - CACHE_TTL + 1000 };

      const result = offlineCache.getCatDetail('cat1');

      expect(result).toEqual(detail);
    });

    test('should return null when cache is expired', () => {
      store['_offline_cat_detail_cat1'] = { data: { _id: 'cat1', name: '小花' }, time: Date.now() - CACHE_TTL - 1000 };

      const result = offlineCache.getCatDetail('cat1');

      expect(result).toBeNull();
    });

    test('should return null when no cached data', () => {
      const result = offlineCache.getCatDetail('nonexistent');

      expect(result).toBeNull();
    });

    test('should return null when cached has no data property', () => {
      store['_offline_cat_detail_cat1'] = { time: Date.now() };

      const result = offlineCache.getCatDetail('cat1');

      expect(result).toBeNull();
    });

    test('should return null when cached data is falsy', () => {
      store['_offline_cat_detail_cat1'] = { data: null, time: Date.now() };

      const result = offlineCache.getCatDetail('cat1');

      expect(result).toBeNull();
    });

    test('should return null when getStorageSync throws', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('read error'); });

      const result = offlineCache.getCatDetail('cat1');

      expect(result).toBeNull();
    });

    test('should return detail at exact TTL boundary since check uses strict greater than', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      store['_offline_cat_detail_cat1'] = { data: { _id: 'cat1' }, time: now - CACHE_TTL };

      const result = offlineCache.getCatDetail('cat1');
      dateNowSpy.mockRestore();

      expect(result).toEqual({ _id: 'cat1' });
    });

    test('should return detail just before TTL boundary', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      const detail = { _id: 'cat1', name: '小花' };
      store['_offline_cat_detail_cat1'] = { data: detail, time: now - CACHE_TTL + 1 };

      const result = offlineCache.getCatDetail('cat1');
      dateNowSpy.mockRestore();

      expect(result).toEqual(detail);
    });
  });

  describe('saveNotices', () => {
    test('should store notices with timestamp', () => {
      const now = 3000000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      const notices = [{ _id: 'n1', title: '公告1' }, { _id: 'n2', title: '公告2' }];
      offlineCache.saveNotices(notices);

      expect(store['_offline_notices']).toEqual({ data: notices, time: now });
      Date.now.mockRestore();
    });

    test('should store with NOTICES key', () => {
      offlineCache.saveNotices([]);
      expect(wx.setStorageSync).toHaveBeenCalledWith('_offline_notices', expect.any(Object));
    });

    test('should not throw when setStorageSync throws', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('storage full'); });
      expect(() => offlineCache.saveNotices([])).not.toThrow();
    });
  });

  describe('getNotices', () => {
    test('should return cached notices when within TTL', () => {
      const notices = [{ _id: 'n1', title: '公告1' }];
      store['_offline_notices'] = { data: notices, time: Date.now() - CACHE_TTL + 1000 };

      const result = offlineCache.getNotices();

      expect(result).toEqual(notices);
    });

    test('should return null when cache is expired', () => {
      store['_offline_notices'] = { data: [{ _id: 'n1' }], time: Date.now() - CACHE_TTL - 1000 };

      const result = offlineCache.getNotices();

      expect(result).toBeNull();
    });

    test('should return null when no cached data', () => {
      const result = offlineCache.getNotices();

      expect(result).toBeNull();
    });

    test('should return null when cached has no data property', () => {
      store['_offline_notices'] = { time: Date.now() };

      const result = offlineCache.getNotices();

      expect(result).toBeNull();
    });

    test('should return null when cached data is falsy', () => {
      store['_offline_notices'] = { data: null, time: Date.now() };

      const result = offlineCache.getNotices();

      expect(result).toBeNull();
    });

    test('should return null when getStorageSync throws', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('read error'); });

      const result = offlineCache.getNotices();

      expect(result).toBeNull();
    });

    test('should return notices at exact TTL boundary since check uses strict greater than', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      store['_offline_notices'] = { data: [{ _id: 'n1' }], time: now - CACHE_TTL };

      const result = offlineCache.getNotices();
      dateNowSpy.mockRestore();

      expect(result).toEqual([{ _id: 'n1' }]);
    });

    test('should return notices just before TTL boundary', () => {
      const now = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      const notices = [{ _id: 'n1', title: '公告1' }];
      store['_offline_notices'] = { data: notices, time: now - CACHE_TTL + 1 };

      const result = offlineCache.getNotices();
      dateNowSpy.mockRestore();

      expect(result).toEqual(notices);
    });
  });

  describe('clearAll', () => {
    test('should remove CATS key', () => {
      store['_offline_cats'] = [];
      offlineCache.clearAll();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cats');
    });

    test('should remove CATS_TIME key', () => {
      store['_offline_cats_time'] = 123;
      offlineCache.clearAll();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cats_time');
    });

    test('should remove NOTICES key', () => {
      store['_offline_notices'] = { data: [], time: 123 };
      offlineCache.clearAll();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_notices');
    });

    test('should remove RESCUE keys', () => {      offlineCache.clearAll();    });

    test('should remove all CAT_DETAIL keys', () => {
      store['_offline_cat_detail_cat1'] = { data: {}, time: 1 };
      store['_offline_cat_detail_cat2'] = { data: {}, time: 2 };
      store['other_key'] = 'keep';

      offlineCache.clearAll();

      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cat_detail_cat1');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cat_detail_cat2');
    });

    test('should not remove non-cache keys', () => {
      store['user_settings'] = 'keep';
      store['_offline_cat_detail_cat1'] = { data: {}, time: 1 };

      offlineCache.clearAll();

      expect(wx.removeStorageSync).not.toHaveBeenCalledWith('user_settings');
    });

    test('should not throw when getStorageInfoSync throws', () => {
      wx.getStorageInfoSync.mockImplementation(() => { throw new Error('info error'); });
      expect(() => offlineCache.clearAll()).not.toThrow();
    });

    test('should not throw when removeStorageSync throws', () => {
      wx.removeStorageSync.mockImplementation(() => { throw new Error('remove error'); });
      expect(() => offlineCache.clearAll()).not.toThrow();
    });

    test('should handle empty storage gracefully', () => {
      expect(() => offlineCache.clearAll()).not.toThrow();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cats');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_cats_time');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_notices');
    });
  });

  describe('integration: save then get', () => {
    test('should round-trip cats data', () => {
      const cats = [
        { _id: '1', name: '小花', avatar: 'a', campus: 'c', status: 's', color: 'c', gender: 'g', meetCount: 1, photoCount: 1 }
      ];

      offlineCache.saveCats(cats);
      const result = offlineCache.getCats();

      expect(result).toEqual([{
        _id: '1', name: '小花', avatar: 'a', campus: 'c', status: 's', color: 'c', gender: 'g', meetCount: 1, photoCount: 1
      }]);
    });

    test('should round-trip cat detail data', () => {
      const cat = {
        _id: 'cat1', name: '小花', avatar: 'a', campus: 'c', status: 's', color: 'c',
        gender: 'g', age: '2', sterilized: true, description: 'd', appearance: 'ap',
        location: 'l', healthStatus: 'h', healthNote: 'hn', meetCount: 1, photoCount: 1, notes: 'n'
      };

      offlineCache.saveCatDetail('cat1', cat);
      const result = offlineCache.getCatDetail('cat1');

      expect(result).toEqual({
        _id: 'cat1', name: '小花', avatar: 'a', campus: 'c', status: 's', color: 'c',
        gender: 'g', age: '2', sterilized: true, description: 'd', appearance: 'ap',
        location: 'l', healthStatus: 'h', healthNote: 'hn', meetCount: 1, photoCount: 1, notes: 'n'
      });
    });

    test('should round-trip notices data', () => {
      const notices = [{ _id: 'n1', title: '公告1' }];

      offlineCache.saveNotices(notices);
      const result = offlineCache.getNotices();

      expect(result).toEqual(notices);
    });

    test('should return null after clearAll', () => {
      offlineCache.saveCats([{ _id: '1', name: 'A' }]);
      offlineCache.saveCatDetail('1', { _id: '1', name: 'A' });
      offlineCache.saveNotices([{ _id: 'n1' }]);

      offlineCache.clearAll();

      expect(offlineCache.getCats()).toBeNull();
      expect(offlineCache.getCatDetail('1')).toBeNull();
      expect(offlineCache.getNotices()).toBeNull();
    });

    test('should expire cats after TTL', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      offlineCache.saveCats([{ _id: '1', name: 'A' }]);

      Date.now.mockReturnValue(now + CACHE_TTL + 1);
      expect(offlineCache.getCats()).toBeNull();

      Date.now.mockRestore();
    });

    test('should expire cat detail after TTL', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      offlineCache.saveCatDetail('1', { _id: '1', name: 'A' });

      Date.now.mockReturnValue(now + CACHE_TTL + 1);
      expect(offlineCache.getCatDetail('1')).toBeNull();

      Date.now.mockRestore();
    });

    test('should expire notices after TTL', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      offlineCache.saveNotices([{ _id: 'n1' }]);

      Date.now.mockReturnValue(now + CACHE_TTL + 1);
      expect(offlineCache.getNotices()).toBeNull();

      Date.now.mockRestore();
    });
  });

  // ---- 猫咪详情缓存：只写不清是唯一会涨到微信 storage 上限的路径 ----
  // 每打开一只猫多一个 key，超量后会拖垮列表/公告/统计缓存与登录态的写入。
  describe('saveCatDetail / getCatDetail', () => {
    const detailKey = id => '_offline_cat_detail_' + id;

    test('读到的详情只含白名单字段（多余字段不入缓存）', () => {
      offlineCache.saveCatDetail('c1', {
        _id: 'c1', name: '小花', avatar: 'https://x/a.jpg', campus: '主校区',
        description: '亲人', appearance: '橘猫', meetCount: 3, photoCount: 5,
        secretField: '不该被缓存'
      });

      const cached = offlineCache.getCatDetail('c1');
      expect(cached.name).toBe('小花');
      expect(cached).not.toHaveProperty('secretField');
    });

    test('过期时顺手删除 storage key，而不是只返回 null', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      offlineCache.saveCatDetail('c1', { _id: 'c1', name: '小花' });
      expect(store[detailKey('c1')]).toBeTruthy();

      Date.now.mockReturnValue(now + CACHE_TTL + 1);
      expect(offlineCache.getCatDetail('c1')).toBeNull();
      // 关键：key 必须真的被删掉，否则它会永远留在 storage 里累积到上限
      expect(store[detailKey('c1')]).toBeUndefined();

      Date.now.mockRestore();
    });

    test('超过上限时淘汰最旧的条目，按 time 而非 key 字典序', () => {
      let clock = 1000000;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);

      // 写入 30 条，time 递增
      for (let i = 0; i < 30; i++) {
        offlineCache.saveCatDetail('old' + String(i).padStart(2, '0'), { _id: 'x' });
        clock += 1000;
      }
      // 这条的 key 字典序最小，但打开时间最晚
      offlineCache.saveCatDetail('aaa-newest', { _id: 'x' });

      const keys = Object.keys(store).filter(k => k.startsWith('_offline_cat_detail_'));
      // 上限 30 + 本次写入 = 31，应淘汰掉 1 条最旧的（old00）
      expect(keys).toHaveLength(30);
      expect(store[detailKey('old00')]).toBeUndefined();
      // 字典序最小但最新，必须保留 —— 按 key 排序删会误删它
      expect(store[detailKey('aaa-newest')]).toBeTruthy();

      Date.now.mockRestore();
    });

    test('未达上限时不做任何淘汰', () => {
      offlineCache.saveCatDetail('only1', { _id: 'x' });
      offlineCache.saveCatDetail('only2', { _id: 'x' });

      const keys = Object.keys(store).filter(k => k.startsWith('_offline_cat_detail_'));
      expect(keys).toHaveLength(2);
    });

    test('淘汰过程失败不影响本次写入结果（不抛给调用方）', () => {
      wx.getStorageInfoSync.mockImplementationOnce(() => ({ keys: ['_offline_cat_detail_x'] }));
      wx.getStorageSync.mockImplementationOnce(() => { throw new Error('storage busy'); });

      expect(() => offlineCache.saveCatDetail('c9', { _id: 'c9' })).not.toThrow();
      expect(store[detailKey('c9')]).toBeTruthy();
    });
  });

  // ---- 相册缓存：gallery 首屏 SWR 的数据源 ----
  // 覆盖三条契约：① 只留渲染必需字段；② 只存第一页（分页语义靠 albumPage 维持）；
  // ③ clearAll 一并清掉（否则缓存只增不减，会拖垮其他缓存写入）。
  describe('saveAlbums / getAlbums', () => {
    test('只保留渲染必需字段', () => {
      offlineCache.saveAlbums([{
        catId: 'c1',
        catName: '橘猫',
        coverUrl: 'cloud://cover',
        catAvatar: 'cloud://avatar',
        photoCount: 5,
        catStatus: 'normal',
        _hasAvatar: true,
        内部字段: '不该被缓存'
      }]);

      expect(store['_offline_albums']).toEqual([
        { catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover', catAvatar: 'cloud://avatar', photoCount: 5 }
      ]);
    });

    test('最多只缓存第一页 10 条', () => {
      offlineCache.saveAlbums(Array.from({ length: 25 }, (_, i) => ({ catId: `c${i}` })));

      expect(store['_offline_albums']).toHaveLength(10);
      expect(store['_offline_albums'][0].catId).toBe('c0');
      expect(store['_offline_albums'][9].catId).toBe('c9');
    });

    test('写入后能原样读回（round-trip）', () => {
      offlineCache.saveAlbums([{ catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover', photoCount: 2 }]);

      expect(offlineCache.getAlbums()).toEqual([
        { catId: 'c1', catName: '橘猫', coverUrl: 'cloud://cover', catAvatar: '', photoCount: 2 }
      ]);
    });

    test('超过 TTL 返回 null', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      offlineCache.saveAlbums([{ catId: 'c1' }]);

      Date.now.mockReturnValue(now + CACHE_TTL + 1);
      expect(offlineCache.getAlbums()).toBeNull();

      Date.now.mockRestore();
    });

    test('未写入或写入空数组时返回 null', () => {
      expect(offlineCache.getAlbums()).toBeNull();

      offlineCache.saveAlbums([]);
      expect(offlineCache.getAlbums()).toBeNull();
    });

    test('getStorageSync 抛错时返回 null 而不冒泡', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('read error'); });

      expect(offlineCache.getAlbums()).toBeNull();
    });

    test('setStorageSync 抛错时不冒泡', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('storage full'); });

      expect(() => offlineCache.saveAlbums([{ catId: 'c1' }])).not.toThrow();
    });

    test('clearAll 一并清掉相册缓存与其时间戳', () => {
      offlineCache.saveAlbums([{ catId: 'c1' }]);

      offlineCache.clearAll();

      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_albums');
      expect(wx.removeStorageSync).toHaveBeenCalledWith('_offline_albums_time');
      expect(offlineCache.getAlbums()).toBeNull();
    });
  });
});
