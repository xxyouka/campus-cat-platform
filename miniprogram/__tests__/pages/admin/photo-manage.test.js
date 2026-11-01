const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn()
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin'),
  checkAdminAuth: jest.fn(() => true),
  clearAdminAuth: jest.fn()
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/photo-manage/photo-manage');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _lastLoadTime: 0
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  inst.callAdminFunction = function(name, data = {}, timeout) {
    return wx.cloud.callFunction({ name, data, timeout });
  };
  inst.verifyAdmin = jest.fn().mockResolvedValue(true);
  return inst;
}

describe('photo-manage page', () => {
  // ===== 搜索（服务端过滤，keyword 走 getAlbumsWithInfo）=====
  describe('搜索', () => {
    function albumsResponse(albums, total) {
      return {
        result: {
          success: true,
          data: { albums, total: total === undefined ? albums.length : total, hasMore: false }
        }
      };
    }

    it('onSearchInput 防抖 300ms 后才发请求', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst.loadAlbums = jest.fn().mockResolvedValue();

      inst.onSearchInput({ detail: { value: '绿' } });
      inst.onSearchInput({ detail: { value: '绿豆' } });
      expect(inst.loadAlbums).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);
      expect(inst.loadAlbums).toHaveBeenCalledTimes(1);
      expect(inst.data.searchKeyword).toBe('绿豆');
      jest.useRealTimers();
    });

    it('关键词会传给云函数（服务端过滤，不是客户端筛已加载的那 100 条）', async () => {
      const inst = createInstance({ searchKeyword: '绿豆饼' });
      wx.cloud.callFunction.mockResolvedValue(albumsResponse([], 0));

      await inst.loadAlbums(true);

      const call = wx.cloud.callFunction.mock.calls[0][0];
      expect(call.name).toBe('getAlbumsWithInfo');
      expect(call.data.keyword).toBe('绿豆饼');
    });

    it('搜索态的「找到 N 个」用服务端 total，不是本页条数', async () => {
      const inst = createInstance({ searchKeyword: '绿', hasSearched: true });
      // 云端命中 37 只，本页只回 2 条（分页）
      wx.cloud.callFunction.mockResolvedValue(
        albumsResponse([{ catId: '1', catName: '绿豆', photoCount: 3 }], 37)
      );

      await inst.loadAlbums(true);

      expect(inst.data.searchTotal).toBe(37);
      expect(inst.data.totalAlbums).toBe(37);
      expect(inst.data.albums).toHaveLength(1);
    });

    it('清空关键词回到全量并退出搜索态', async () => {
      const inst = createInstance({ searchKeyword: '绿', hasSearched: true, albumPage: 2 });
      inst.loadAlbums = jest.fn().mockResolvedValue();

      inst.onSearchInput({ detail: { value: '   ' } });

      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.hasSearched).toBe(false);
      expect(inst.data.albumPage).toBe(0);
      expect(inst.loadAlbums).toHaveBeenCalledWith(true);
    });

    it('清空会作废在途搜索（旧响应不得覆盖回全量列表）', () => {
      const inst = createInstance({ searchKeyword: '绿' });
      const seqBefore = inst._albumSeq || 0;
      inst.loadAlbums = jest.fn().mockResolvedValue();

      inst.onClearSearch();

      expect(inst._albumSeq).toBeGreaterThan(seqBefore);
      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.searchError).toBe('');
    });

    it('序号守卫：过期响应被丢弃（连续输入不串结果）', async () => {
      const inst = createInstance({ searchKeyword: '绿豆饼' });
      let resolveOld;
      wx.cloud.callFunction.mockImplementationOnce(() => new Promise(res => { resolveOld = res; }));

      const stale = inst.loadAlbums(true);        // 旧关键词在途

      // 用户又改了一次关键词
      inst.setData({ searchKeyword: '绿豆' });
      wx.cloud.callFunction.mockResolvedValue(albumsResponse([{ catId: '9', catName: '绿豆', photoCount: 1 }], 1));
      await inst.loadAlbums(true);

      // 旧响应此刻才回来：必须被丢弃
      resolveOld(albumsResponse([{ catId: '1', catName: '绿豆饼', photoCount: 8 }], 8));
      await stale;

      expect(inst.data.albums.map(a => a.catId)).toEqual(['9']);
    });

    it('onSearchConfirm 立即搜索（不等防抖）', async () => {
      jest.useFakeTimers();
      const inst = createInstance({ searchKeyword: '绿豆' });
      wx.cloud.callFunction.mockResolvedValue(albumsResponse([], 0));

      inst.onSearchConfirm();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(wx.cloud.callFunction).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('onUnload 清掉搜索防抖定时器', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst.onSearchInput({ detail: { value: '绿' } });
      expect(inst._searchTimer).toBeTruthy();

      inst.onUnload();

      expect(inst._searchTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  // ===== 加载失败态 =====
  describe('加载失败态（searchError）', () => {
    it('请求抛错时置 searchError 并保留旧列表', async () => {
      const inst = createInstance({ albums: [{ catId: 'old', catName: '旧列表' }] });
      wx.cloud.callFunction.mockRejectedValue(new Error('boom'));

      await inst.loadAlbums(true);

      expect(inst.data.searchError).toBe('加载失败，点此重试');
      // 关键：不清空。管理员正在浏览的内容不该因为一次失败就没了
      expect(inst.data.albums).toHaveLength(1);
      expect(inst.data.loading).toBe(false);
    });

    it('success=false 时同样置 searchError', async () => {
      const inst = createInstance({ albums: [{ catId: 'old', catName: '旧列表' }] });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '挂了' } });

      await inst.loadAlbums(true);

      expect(inst.data.searchError).toBe('加载失败，点此重试');
      expect(inst.data.albums).toHaveLength(1);
    });

    it('成功加载后 searchError 归零（失败态不能粘住）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('boom'));
      await inst.loadAlbums(true);
      expect(inst.data.searchError).toBeTruthy();

      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { albums: [{ catId: '1', catName: 'A', photoCount: 1 }], total: 1, hasMore: false } }
      });
      await inst.loadAlbums(true);

      expect(inst.data.searchError).toBe('');
    });

    it('onRetryLoad 重新拉取', async () => {
      const inst = createInstance({ albums: [{ catId: 'old', catName: '旧' }], searchError: '加载失败，点此重试' });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { albums: [{ catId: '1', catName: 'A', photoCount: 1 }], total: 1, hasMore: false } }
      });

      await inst.onRetryLoad();   // onRetryLoad 内部 await loadAlbums(true)

      expect(inst.data.searchError).toBe('');
      expect(inst.data.albums).toHaveLength(1);
    });
  });

  // ===== 模板层：三个空态互斥 =====
  describe('空态互斥（wxml 契约）', () => {
    const fs = require('fs');
    const path = require('path');
    const wxml = fs.readFileSync(
      path.resolve(__dirname, '../../../pages/admin/photo-manage/photo-manage.wxml'),
      'utf8'
    );

    test('失败态要求 searchError 且带重试', () => {
      expect(wxml).toMatch(/!loading && albums\.length === 0 && searchError/);
      expect(wxml).toContain('bindaction="onRetryLoad"');
    });

    test('「没找到」态排除 searchError 与非搜索态', () => {
      expect(wxml).toMatch(/!loading && albums\.length === 0 && hasSearched/);
    });

    test('「暂无相册」态必须排除 searchError 与 hasSearched', () => {
      // 少了这两条排除，搜索失败时管理员会同时看到「加载失败」和「暂无猫咪相册」
      expect(wxml).toMatch(/wx:elif="\{\{!loading && albums\.length === 0\}\}"/);
    });

    test('失败条只在有旧列表时出现（空列表走整屏失败态）', () => {
      expect(wxml).toMatch(/!loading && searchError && albums\.length > 0/);
    });

    test('搜索框存在且绑定输入/清除/确认', () => {
      expect(wxml).toContain('bindinput="onSearchInput"');
      expect(wxml).toContain('bindconfirm="onSearchConfirm"');
      expect(wxml).toContain('bindtap="onClearSearch"');
    });

    test('统计行区分搜索态与非搜索态', () => {
      expect(wxml).toContain("{{hasSearched ? '找到' : '共'}}");
      expect(wxml).toContain('{{hasSearched ? searchTotal : totalAlbums}}');
    });
  });

  // ===== 云函数：keyword 契约 =====
  describe('云函数 getAlbumsWithInfo 的 keyword', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../cloudfunctions/getAlbumsWithInfo/index.js'),
      'utf8'
    );

    test('列表与计数共用同一个 where（否则搜索态 total 永远是全库数）', () => {
      expect(src).toMatch(/const baseWhere = buildCatsWhere\(keyword\)/);
      // 两处 .where(baseWhere)，不能再出现字面量 where({ _deleting: ... })
      const uses = src.match(/\.where\(baseWhere\)/g) || [];
      expect(uses.length).toBe(2);
      // 查询条件只能由这一个函数产出
      expect(src).toMatch(/function buildCatsWhere\(keyword\)/);
    });

    test('关键词按 name / color / location 匹配且转义', () => {
      expect(src).toMatch(/escapeRegex/);
      expect(src).toMatch(/\{ name: regex \}/);
      expect(src).toMatch(/\{ color: regex \}/);
      expect(src).toMatch(/\{ location: regex \}/);
      // 空关键词必须原样返回而不是生成一个「匹配空串」的 $or（那会匹配全部）
      expect(src).toMatch(/if \(!keyword\) return where;/);
    });

    test('空结果分支也返回 total（搜索清零要用）', () => {
      expect(src).toMatch(/return ok\(\{ albums: \[\], total: countResult\.total \|\| 0, hasMore: false \}\)/);
    });
  });
  describe('onLoad', () => {
    it('should set statusBarHeight and load albums', async () => {
      const inst = createInstance();
      inst.loadAlbums = jest.fn().mockResolvedValue();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.loadAlbums).toHaveBeenCalled();
      expect(inst._lastLoadTime).toBeGreaterThan(0);
    });

    it('should return early when auth fails', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(0);
    });
  });

  describe('onShow', () => {
    // onShow 有一道首屏守卫：onLoad 已加载过，首次 onShow 直接返回，
    // 避免 onLoad 的 await 尚未给 _lastLoadTime 赋值时守卫失效而重复拉云端。
    // 故下列「非首屏」场景都需先置 _firstShowSkipped = true。
    it('should reload albums after cache expiry', async () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst._lastLoadTime = Date.now() - 30000;
      inst.loadAlbums = jest.fn().mockResolvedValue();
      await inst.onShow();
      expect(inst.loadAlbums).toHaveBeenCalled();
    });

    it('should not reload within cache period', async () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst._lastLoadTime = Date.now() - 5000;
      inst.loadAlbums = jest.fn();
      await inst.onShow();
      expect(inst.loadAlbums).not.toHaveBeenCalled();
    });

    it('should reload when no lastLoadTime', async () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst._lastLoadTime = null;
      inst.loadAlbums = jest.fn().mockResolvedValue();
      await inst.onShow();
      expect(inst.loadAlbums).toHaveBeenCalled();
    });

    it('should skip the first onShow to avoid duplicate cloud calls', async () => {
      // 回归：原实现无此守卫，onLoad 的 loadAlbums 尚未完成时 onShow 守卫失效，
      // getAlbumsWithInfo + getCatAvatars 被双倍调用
      const inst = createInstance();
      inst.loadAlbums = jest.fn().mockResolvedValue();
      await inst.onShow();
      expect(inst.loadAlbums).not.toHaveBeenCalled();
      expect(inst._firstShowSkipped).toBe(true);
    });
  });

  describe('onPullDownRefresh', () => {
    it('should reload albums and stop refresh', async () => {
      const inst = createInstance();
      inst.loadAlbums = jest.fn().mockResolvedValue();
      await inst.onPullDownRefresh();
      expect(inst.loadAlbums).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('loadAlbums', () => {
    it('should load albums successfully', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            albums: [
              { catId: '1', catName: 'Kitty', coverUrl: 'http://img.jpg', photoCount: 5 },
              { catId: '2', catName: 'Mimi', coverUrl: 'http://img2.jpg', photoCount: '3' }
            ]
          }
        }
      });

      await inst.loadAlbums();

      expect(inst.data.albums.length).toBe(2);
      expect(inst.data.albums[0].photoCount).toBe(5);
      expect(inst.data.albums[1].photoCount).toBe(3);
      expect(inst.data.loading).toBe(false);
    });

    it('should convert cloud cover URLs', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'getAlbumsWithInfo') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                albums: [{ catId: '1', catName: 'Kitty', coverUrl: 'cloud://cover-id', photoCount: 2 }]
              }
            }
          });
        }
        if (name === 'getCatAvatars') {
          return Promise.resolve({
            result: { data: { urlMap: { 'cloud://cover-id': 'http://temp-cover.jpg' } } }
          });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.loadAlbums();

      expect(inst.data.albums[0].coverUrl).toBe('http://temp-cover.jpg');
    });

    it('should handle cover URL conversion failure gracefully', async () => {
      const inst = createInstance();
      let _callCount = 0;
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        _callCount++;
        if (name === 'getAlbumsWithInfo') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                albums: [{ catId: '1', catName: 'Kitty', coverUrl: 'cloud://cover-id', photoCount: 1 }]
              }
            }
          });
        }
        if (name === 'getCatAvatars') {
          return Promise.reject(new Error('fail'));
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.loadAlbums();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(inst.data.albums[0].coverUrl).toBe('cloud://cover-id');
    });

    it('should handle load failure', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, error: 'load failed' }
      });

      await inst.loadAlbums();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    it('should handle exception', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('network'));

      await inst.loadAlbums();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    it('should handle empty albums', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { albums: [] } }
      });

      await inst.loadAlbums();

      expect(inst.data.albums).toEqual([]);
      expect(inst.data.loading).toBe(false);
    });
  });

  describe('onGoToAlbum', () => {
    it('should navigate to album detail with catId and catName', () => {
      const inst = createInstance();
      inst.onGoToAlbum({
        currentTarget: {
          dataset: { album: { catId: 'cat1', catName: 'Kitty' } }
        }
      });
      expect(wx.navigateTo).toHaveBeenCalledWith({
        url: '/pages/admin/photo-manage/album-detail?catId=cat1&catName=Kitty'
      });
    });

    it('should use _id as fallback for catId', () => {
      const inst = createInstance();
      inst.onGoToAlbum({
        currentTarget: {
          dataset: { album: { _id: 'album1', catName: 'Kitty' } }
        }
      });
      expect(wx.navigateTo).toHaveBeenCalledWith({
        url: '/pages/admin/photo-manage/album-detail?catId=album1&catName=Kitty'
      });
    });

    it('should use name as fallback for catName', () => {
      const inst = createInstance();
      inst.onGoToAlbum({
        currentTarget: {
          dataset: { album: { catId: '1', name: 'Kitty' } }
        }
      });
      expect(wx.navigateTo).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining('catName=Kitty') })
      );
    });

    it('should encode catName', () => {
      const inst = createInstance();
      inst.onGoToAlbum({
        currentTarget: {
          dataset: { album: { catId: '1', catName: '小猫 喵' } }
        }
      });
      expect(wx.navigateTo).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(encodeURIComponent('小猫 喵')) })
      );
    });
  });
});
