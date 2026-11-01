const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn() };
const mockMediaHelper = { resolveCatAvatars: jest.fn(cats => Promise.resolve(cats)) };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/mediaHelper', () => mockMediaHelper);

// 本文件不 mock imageLoader：通知路径真实地走 imageLoader.getTempUrls → wx.cloud.getTempFileURL
const imageLoader = require('../../utils/imageLoader');
const ShareHelper = require('../../utils/shareHelper');

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/favorites/favorites');
});

beforeEach(() => {
  jest.clearAllMocks();
  // imageLoader 是模块级单例，其「fileID@尺寸档位」缓存会跨用例泄漏：
  // 前一个用例成功的换链结果会让下一个用例直接命中缓存、不再触发 wx.cloud.getTempFileURL，
  // 从而跳过被断言的失败路径（jest.clearAllMocks 清不掉它）
  imageLoader.clearCache();
  wx.getStorageSync.mockReturnValue([]);
  wx.setStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.cloud.getTempFileURL.mockReset();
  wx.cloud.getTempFileURL.mockResolvedValue({ fileList: [] });
  wx.cloud.database.mockReturnValue({
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: [] }))
      })),
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: {} }))
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
      limit: jest.fn(function() { return this; }),
      orderBy: jest.fn(function() { return this; }),
      skip: jest.fn(function() { return this; }),
      get: jest.fn(() => Promise.resolve({ data: [] }))
    })),
    command: {
      eq: jest.fn(v => v),
      in: jest.fn(v => v)
    }
  });
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates, callback) {
      Object.assign(this.data, updates);
      if (callback) callback();
    }),
    _syncTimer: null,
    _processingAction: false,
  };
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('favorites page', () => {
  describe('onLoad', () => {
    test('云端恢复成功后才做本地→云端对齐，且恢复在前', async () => {
      const inst = createInstance();
      const restoreSpy = jest.spyOn(inst, '_restoreCloudFavorites').mockResolvedValue(true);
      const syncSpy = jest.spyOn(inst, '_delayedSync');

      await inst.onLoad();

      expect(restoreSpy).toHaveBeenCalled();
      expect(syncSpy).toHaveBeenCalled();
      // 顺序契约：恢复（云端→本地）必须先于对齐（本地→云端）
      expect(restoreSpy.mock.invocationCallOrder[0])
        .toBeLessThan(syncSpy.mock.invocationCallOrder[0]);
    });

    test('云端恢复失败时跳过本地→云端对齐（防止把云端独有收藏误删）', async () => {
      const inst = createInstance();
      jest.spyOn(inst, '_restoreCloudFavorites').mockResolvedValue(false);
      const syncSpy = jest.spyOn(inst, '_delayedSync');

      await inst.onLoad();

      expect(syncSpy).not.toHaveBeenCalled();
    });
  });

  describe('onShow', () => {
    test('loads favorites', async () => {
      wx.getStorageSync.mockReturnValue([]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [], total: 0 } }
      });
      const inst = createInstance();
      const favSpy = jest.spyOn(inst, 'loadFavorites');
      await inst.onShow();
      expect(favSpy).toHaveBeenCalled();
    });
  });

  describe('onPullDownRefresh', () => {
    test('refreshes favorites and stops the spinner', async () => {
      wx.getStorageSync.mockReturnValue([]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { notifications: [], unreadCount: 0 } }
      });
      const inst = createInstance();
      inst.onPullDownRefresh();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('onHide', () => {
    test('calls clearTimeout for sync timer', () => {
      jest.useFakeTimers();
      jest.spyOn(global, 'clearTimeout');
      const inst = createInstance();
      inst._syncTimer = setTimeout(() => {}, 99999);
      inst.onHide();
      expect(clearTimeout).toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('does nothing when no timer', () => {
      const inst = createInstance();
      inst._syncTimer = null;
      expect(() => inst.onHide()).not.toThrow();
    });
  });

  describe('onUnload', () => {
    test('calls clearTimeout for sync timer', () => {
      jest.useFakeTimers();
      jest.spyOn(global, 'clearTimeout');
      const inst = createInstance();
      inst._syncTimer = setTimeout(() => {}, 99999);
      inst.onUnload();
      expect(clearTimeout).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('loadFavorites', () => {
    test('returns early when processing action', async () => {
      const inst = createInstance();
      inst._processingAction = true;
      await inst.loadFavorites();
      expect(wx.getStorageSync).not.toHaveBeenCalled();
    });

    // 回归：云函数失败时必须置 loadError，不能与「真的没关注」共用空态。
    // 原实现 getCatsByIds 失败返回 []，页面渲染「还没有关注任何猫咪」——
    // 与真实空列表完全同形，云端未部署这类故障会被彻底隐藏。
    test('getCatsByIds 失败时置 loadError 而非显示空列表', async () => {
      wx.getStorageSync.mockReturnValue([{ id: 'a'.repeat(24), time: Date.now() }]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, error: '未初始化数据库' }
      });
      const inst = createInstance();
      await inst.loadFavorites();
      expect(inst.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loading: false, loadError: true })
      );
      // 关键：不得把列表当成「空」渲染出去
      expect(inst.setData).not.toHaveBeenCalledWith(
        expect.objectContaining({ favoriteCats: [] })
      );
    });

    // 回归：关注数与显示数不一致时必须如实记账。
    // 现象：关注了 3 只，页面显示「共 3 只」却只渲染 2 张卡片 ——
    // 因为其中 1 只在 cats 集合里查不到（已硬删除 / _deleting 中），
    // getCatsByIds 静默少返回，前端毫不知情，用户完全无法理解。
    test('部分关注的猫查不到时计入 missingCount', async () => {
      const id1 = 'a'.repeat(24);
      const id2 = 'b'.repeat(24);
      const id3 = 'c'.repeat(24);
      wx.getStorageSync.mockReturnValue([
        { id: id1, time: Date.now() - 3000 },
        { id: id2, time: Date.now() - 2000 },
        { id: id3, time: Date.now() - 1000 }
      ]);
      // 云端只返回 2 只，id2 查不到
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [
          { _id: id1, name: '猫A', avatar: '' },
          { _id: id3, name: '猫C', avatar: '' }
        ] } }
      });
      const inst = createInstance();
      await inst.loadFavorites();

      expect(inst.data.missingCount).toBe(1);
      expect(inst.data.favoriteCount).toBe(3);   // 关注数仍如实显示
      expect(inst.data.favoriteCats).toHaveLength(2); // 实际渲染数
    });

    test('全部查到时 missingCount 为 0', async () => {
      const id1 = 'a'.repeat(24);
      const id2 = 'b'.repeat(24);
      wx.getStorageSync.mockReturnValue([
        { id: id1, time: Date.now() - 1000 },
        { id: id2, time: Date.now() }
      ]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [
          { _id: id1, name: '猫A', avatar: '' },
          { _id: id2, name: '猫B', avatar: '' }
        ] } }
      });
      const inst = createInstance();
      await inst.loadFavorites();

      expect(inst.data.missingCount).toBe(0);
      expect(inst.data.favoriteCats).toHaveLength(2);
    });

    // 回归：本地 storage 含重复 catId 时必须去重。
    // 成因：_restoreCloudFavorites 把云端独有的 ID 前插到头部、detail 页关注是 push 到尾部，
    // 两条写入路径可能对同一只猫各写一次。
    // 原实现不去重 → favoriteCount=3（重复项被计入）而 getCatsByIds 只返回 2 只唯一猫，
    // 表现为「关注 3 只、列表只显示 2 只」且两个数字自相矛盾。
    test('本地含重复 catId 时按唯一猫计数', async () => {
      const id1 = 'a'.repeat(24);
      const id2 = 'b'.repeat(24);
      wx.getStorageSync.mockReturnValue([
        { id: id1, time: Date.now() - 3000 },
        { id: id2, time: Date.now() - 2000 },
        { id: id1, time: Date.now() - 1000 }   // 重复
      ]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [
          { _id: id1, name: '猫A', avatar: '' },
          { _id: id2, name: '猫B', avatar: '' }
        ] } }
      });
      const inst = createInstance();
      await inst.loadFavorites();

      expect(inst.data.favoriteCount).toBe(2);        // 去重后
      expect(inst.data.favoriteCats).toHaveLength(2);
      expect(inst.data.missingCount).toBe(0);
    });

    test('sets empty state when no favorites', async () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance();
      await inst.loadFavorites();
      expect(inst.setData).toHaveBeenCalledWith({ favoriteCount: 0 });
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ favoriteCats: [], loading: false }));
    });

    test('sets empty state when favorites have no valid ids', async () => {
      wx.getStorageSync.mockReturnValue([{ time: Date.now() }]);
      const inst = createInstance();
      await inst.loadFavorites();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ favoriteCats: [], loading: false }));
    });

    test('loads and displays favorites', async () => {
      const favIds = [{ id: 'cat1', time: Date.now() - 86400000 }, { id: 'cat2', time: Date.now() }];
      wx.getStorageSync.mockReturnValue(favIds);
      wx.cloud.database.mockReturnValue({
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({
              data: [
                { _id: 'cat1', name: '橘猫', avatar: 'https://img1.png' },
                { _id: 'cat2', name: '黑猫', avatar: 'https://img2.png' }
              ]
            }))
          }))
        })),
        command: { in: jest.fn(v => v) }
      });
      const inst = createInstance();
      await inst.loadFavorites();
      expect(inst.setData).toHaveBeenCalledWith({ favoriteCount: 2 });
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        loading: false
      }));
    });

    test('handles error gracefully', async () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('storage error'); });
      const inst = createInstance();
      await inst.loadFavorites();
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.setData).toHaveBeenCalledWith({ loading: false });
    });

    test('normalizes string favorites', async () => {
      wx.getStorageSync.mockReturnValue(['cat1', 'cat2']);
      wx.cloud.database.mockReturnValue({
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: [{ _id: 'cat1', name: '橘猫' }] }))
          }))
        })),
        command: { in: jest.fn(v => v) }
      });
      const inst = createInstance();
      await inst.loadFavorites();
      expect(inst.setData).toHaveBeenCalledWith({ favoriteCount: 2 });
    });

    test('appends results on subsequent pages', async () => {
      const favIds = Array(25).fill(null).map((_, i) => ({ id: `cat${i}`, time: Date.now() }));
      wx.getStorageSync.mockReturnValue(favIds);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [{ _id: 'cat1', name: '猫1' }] } }
      });
      const inst = createInstance({ page: 2, favoriteCats: [{ _id: 'cat0', name: '猫0' }] });
      await inst.loadFavorites();
      // 追加而非替换；已展示 1 条 / 本地共 25 条 → 仍有可加载的页
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        favoriteCats: [
          expect.objectContaining({ _id: 'cat0' }),
          expect.objectContaining({ _id: 'cat1' })
        ],
        hasMore: true
      }));
    });
  });

  describe('_restoreCloudFavorites', () => {
    test('reloads the list when the cloud merge lands while the onShow load is in flight', async () => {
      // P2-2 回归：onLoad 先发 syncFavorites，onShow 的 loadFavorites 占锁并 await
      // getCatsByIds；云调用先返回、合并写回 storage 后调用的重载若被在途锁吞掉，
      // 合并进来的云端收藏（含 favoriteCount）不会显示，直到下次进入页面/下拉刷新
      let storage = [{ id: 'cat1', time: 1 }];
      wx.getStorageSync.mockImplementation(() => storage);
      wx.setStorageSync.mockImplementation((key, value) => {
        if (key === 'favoriteCats') storage = value;
      });

      const requestedIdsList = [];
      let resolveFirstGetCats;
      wx.cloud.callFunction.mockImplementation(({ name, data }) => {
        if (name === 'getCatsByIds') {
          requestedIdsList.push(data.ids);
          if (requestedIdsList.length === 1) {
            return new Promise(resolve => { resolveFirstGetCats = resolve; });
          }
          return Promise.resolve({
            result: { success: true, data: { cats: data.ids.map(id => ({ _id: id, name: id })) } }
          });
        }
        if (name === 'syncFavorites') {
          return Promise.resolve({ result: { success: true, data: { catIds: ['cat1', 'cat2'] } } });
        }
        return Promise.resolve({ result: { success: true, data: {} } });
      });

      const inst = createInstance({ page: 1 });

      const restore = inst._restoreCloudFavorites(); // onLoad 路径
      const firstLoad = inst.loadFavorites();        // onShow 路径（占锁）
      await restore;                                 // 云端收藏合并完成 → 排队重载

      expect(inst._pendingFavoritesReload).toBe(true);
      // 合并后本地收藏为 cat1 + cat2（云端独有项前插）
      expect(storage.map(f => f.id).sort()).toEqual(['cat1', 'cat2']);

      // 第一次加载（合并前的 1 条）返回，锁释放后补跑强制重载
      resolveFirstGetCats({ result: { success: true, data: { cats: [{ _id: 'cat1' }] } } });
      await firstLoad;
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(requestedIdsList.length).toBe(2);
      expect([...requestedIdsList[1]].sort()).toEqual(['cat1', 'cat2']);
      expect(inst.data.favoriteCount).toBe(2);
      expect(inst.data.favoriteCats.map(c => c._id).sort()).toEqual(['cat1', 'cat2']);
    });

    test('plain loadFavorites is still swallowed by the in-flight lock (连点防护不受影响)', async () => {
      wx.getStorageSync.mockReturnValue([{ id: 'cat1', time: 1 }]);
      let resolveGetCats;
      wx.cloud.callFunction.mockReturnValue(new Promise(resolve => { resolveGetCats = resolve; }));

      const inst = createInstance({ page: 1 });
      const first = inst.loadFavorites();
      const second = inst.loadFavorites(); // 非强制重载：被在途锁挡下且不排队

      expect(inst._pendingFavoritesReload).toBe(false);
      resolveGetCats({ result: { success: true, data: { cats: [{ _id: 'cat1' }] } } });
      await Promise.all([first, second]);

      expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
    });
  });

  describe('loadMore', () => {
    test('returns early when no more data', () => {
      const inst = createInstance({ hasMore: false });
      inst.loadMore();
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('returns early when processing action', () => {
      const inst = createInstance({ hasMore: true });
      inst._processingAction = true;
      inst.loadMore();
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('increments page and triggers loadFavorites', () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance({ hasMore: true, page: 1 });
      const spy = jest.spyOn(inst, 'loadFavorites');
      inst.loadMore();
      expect(inst.data.page).toBe(2);
      expect(spy).toHaveBeenCalled();
    });

    test('ignores repeated taps while a page is in flight', async () => {
      // 连点两次：第二次必须被挡掉，否则两次请求会读到同一页码、整页重复追加
      wx.getStorageSync.mockReturnValue([{ id: 'cat1', time: 1 }, { id: 'cat2', time: 2 }]);
      let resolveCats;
      wx.cloud.callFunction.mockReturnValue(
        new Promise(resolve => { resolveCats = resolve; })
      );

      const inst = createInstance({ hasMore: true, page: 1, favoriteCats: [{ _id: 'cat1' }] });
      const first = inst.loadMore();
      inst.loadMore();

      expect(inst.data.page).toBe(2);
      expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
      expect(inst.data.loadingMore).toBe(true);

      resolveCats({ result: { success: true, data: { cats: [{ _id: 'cat2' }] } } });
      await first;

      expect(inst.data.loadingMore).toBe(false);
      // 去重后两只猫各出现一次
      expect(inst.data.favoriteCats.map(c => c._id)).toEqual(['cat1', 'cat2']);
    });

    test('deduplicates cats when appending the next page', async () => {
      const repeat = { _id: 'cat1', name: '橘猫' };
      const fresh = { _id: 'cat2', name: '黑猫' };
      wx.getStorageSync.mockReturnValue([
        { id: 'cat1', time: 1 }, { id: 'cat2', time: 2 }, { id: 'cat3', time: 3 }
      ]);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { cats: [repeat, fresh] } }
      });

      const inst = createInstance({
        page: 2,
        pageSize: 2,
        hasMore: true,
        loading: false,
        favoriteCats: [repeat]
      });
      await inst.loadFavorites();

      expect(inst.data.favoriteCats.map(c => c._id)).toEqual(['cat1', 'cat2']);
    });
  });

  describe('_delayedSync', () => {
    test('sets a timer that calls syncFavoritesToCloud', () => {
      jest.useFakeTimers();
      wx.getStorageSync.mockReturnValue([{ id: 'cat1', time: Date.now() }]);
      const inst = createInstance();
      inst._delayedSync();
      expect(inst._syncTimer).not.toBeNull();
      jest.advanceTimersByTime(800);
      expect(wx.cloud.callFunction).toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('only stores the sync signature after a complete success, allowing retry after failure', async () => {
      jest.useFakeTimers();
      const catIds = [{ id: 'cat1', time: 1 }];
      wx.getStorageSync.mockImplementation(key => key === 'favoriteCats' ? catIds : undefined);
      wx.cloud.callFunction
        .mockResolvedValueOnce({ result: { success: false, error: 'temporary failure' } })
        .mockResolvedValueOnce({ result: { success: true } });
      const inst = createInstance();

      try {
        inst._delayedSync();
        jest.advanceTimersByTime(800);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(wx.setStorageSync).not.toHaveBeenCalledWith('_fav_cloud_sync_sig', 'cat1');

        inst._delayedSync();
        jest.advanceTimersByTime(800);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
        expect(wx.setStorageSync).toHaveBeenCalledWith('_fav_cloud_sync_sig', 'cat1');
      } finally {
        jest.useRealTimers();
      }
    });

    test('clears previous timer before setting new one', () => {
      jest.useFakeTimers();
      jest.spyOn(global, 'clearTimeout');
      const inst = createInstance();
      inst._syncTimer = setTimeout(() => {}, 99999);
      inst._delayedSync();
      expect(clearTimeout).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('onGoToDetail', () => {
    test('navigates to detail page with id', () => {
      const inst = createInstance();
      inst.onGoToDetail({ currentTarget: { dataset: { id: 'cat1' } } });
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/detail/detail?id=cat1' });
    });

    test('does nothing without id', () => {
      const inst = createInstance();
      inst.onGoToDetail({ currentTarget: { dataset: {} } });
      expect(wx.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('onGoHome', () => {
    test('switches to index tab', () => {
      const inst = createInstance();
      inst.onGoHome();
      expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    });
  });

  describe('onQuickUnfavorite', () => {
    test('returns early without catId', async () => {
      const inst = createInstance();
      await inst.onQuickUnfavorite({ currentTarget: { dataset: { name: '橘猫' } } });
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    test('returns early when processing action', async () => {
      const inst = createInstance();
      inst._processingAction = true;
      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat1', name: '橘猫' } } });
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    test('does nothing when user cancels modal', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: false, cancel: true }));
      const inst = createInstance();
      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat1', name: '橘猫' } } });
      expect(inst._processingAction).toBe(false);
    });

    test('removes cat from favorites on confirm', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: true, cancel: false }));
      wx.getStorageSync.mockReturnValue([{ id: 'cat1', time: Date.now() }, { id: 'cat2', time: Date.now() }]);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const inst = createInstance({
        favoriteCats: [{ _id: 'cat1', name: '橘猫' }, { _id: 'cat2', name: '黑猫' }]
      });
      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat1', name: '橘猫' } } });
      expect(wx.setStorageSync).toHaveBeenCalledWith('favoriteCats', expect.arrayContaining([
        expect.objectContaining({ id: 'cat2' })
      ]));
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        favoriteCount: 1
      }));
      expect(wx.hideLoading).toHaveBeenCalled();
      expect(mockErrorHandler.showSuccess).toHaveBeenCalled();
    });

    test('recomputes pagination so the next page continues after the shown cats', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: true, cancel: false }));
      const raw = Array.from({ length: 60 }, (_, i) => ({ id: `cat${i}`, time: i }));
      wx.getStorageSync.mockReturnValue(raw);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      // 已翻到第 2 页（展示 40 条）
      const shown = raw.slice(0, 40).map(f => ({ _id: f.id }));
      const inst = createInstance({ favoriteCats: shown, page: 2, pageSize: 20, hasMore: true });

      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat0', name: '橘猫' } } });

      expect(inst.data.favoriteCats).toHaveLength(39);
      expect(inst.data.hasMore).toBe(true);

      // 取消关注后本地收藏少一条，下一次「加载更多」必须从第一条未展示的猫咪继续，
      // 既不能重复已展示的尾部条目，也不能跳过被取消关注那只后面的 cat40
      const remaining = raw.filter(f => f.id !== 'cat0');
      wx.getStorageSync.mockReturnValue(remaining);
      let requestedIds = null;
      wx.cloud.callFunction.mockImplementation(({ name, data }) => {
        if (name === 'getCatsByIds') requestedIds = data.ids;
        return Promise.resolve({ result: { success: true, data: { cats: [] } } });
      });

      await inst.loadMore();

      expect(requestedIds[0]).toBe('cat40');
      expect(requestedIds).toHaveLength(20);
    });

    test('本地收藏已全部展示时取消关注：hasMore 重算为 false（不再白跑一次空请求）', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: true, cancel: false }));
      // 本地共 3 条收藏，且 3 条都已展示 —— 取消关注后已展示数 == 本地总数
      const raw = [
        { id: 'cat1', time: 1 }, { id: 'cat2', time: 2 }, { id: 'cat3', time: 3 }
      ];
      wx.getStorageSync.mockReturnValue(raw);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      const inst = createInstance({
        favoriteCats: [{ _id: 'cat1' }, { _id: 'cat2' }, { _id: 'cat3' }],
        page: 1, pageSize: 20, hasMore: true
      });

      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat1', name: '橘猫' } } });

      expect(inst.data.favoriteCats).toHaveLength(2);
      expect(inst.data.favoriteCount).toBe(2);
      // 无条件 hasMore:true 时这里变红：本地已无未展示条目，下次「加载更多」只会白跑一趟空请求
      expect(inst.data.hasMore).toBe(false);
    });

    test('handles error during unfavorite', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: true, cancel: false }));
      wx.getStorageSync.mockImplementation(() => { throw new Error('storage fail'); });
      const inst = createInstance({ favoriteCats: [] });
      await inst.onQuickUnfavorite({ currentTarget: { dataset: { id: 'cat1', name: '橘猫' } } });
      expect(wx.hideLoading).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst._processingAction).toBe(false);
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object', () => {
      const inst = createInstance();
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/index/index');
    });

    test('有关注时文案带数量，分享图用随机品牌卡（不再拿第一只关注猫的头像）', () => {
      const inst = createInstance({
        favoriteCount: 3,
        favoriteCats: [{ avatar: 'https://img.example.com/cat.png' }]
      });
      const result = inst.onShareAppMessage();
      expect(result.title).toContain('3 只');
      expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
      expect(result.imageUrl).not.toBe('https://img.example.com/cat.png');
    });

    test('没有关注时不拼出「0 只」', () => {
      const inst = createInstance({ favoriteCount: 0, favoriteCats: [] });
      const result = inst.onShareAppMessage();
      expect(result.title).not.toContain('0 只');
    });
  });

  describe('onShareTimeline', () => {
    test('返回朋友圈分享对象', () => {
      const inst = createInstance({ favoriteCount: 2, favoriteCats: [] });
      const result = inst.onShareTimeline();
      expect(result.title).toContain('2 只');
      expect(result.query).toBe('');
    });
  });

  describe('_sortByFavoritesOrder', () => {
    test('sorts cats by favorites order', () => {
      const inst = createInstance();
      const cats = [{ _id: 'cat2' }, { _id: 'cat1' }, { _id: 'cat3' }];
      const favIds = [{ id: 'cat1', time: 1 }, { id: 'cat2', time: 2 }, { id: 'cat3', time: 3 }];
      const result = inst._sortByFavoritesOrder(cats, favIds);
      expect(result.map(c => c._id)).toEqual(['cat1', 'cat2', 'cat3']);
    });

    test('places unknown cats at end', () => {
      const inst = createInstance();
      const cats = [{ _id: 'cat_unknown' }, { _id: 'cat1' }];
      const favIds = [{ id: 'cat1', time: 1 }];
      const result = inst._sortByFavoritesOrder(cats, favIds);
      expect(result[0]._id).toBe('cat1');
    });

    test('filters out cats without _id', () => {
      const inst = createInstance();
      const cats = [{ _id: 'cat1' }, { name: 'no-id' }, null];
      const favIds = [{ id: 'cat1', time: 1 }];
      const result = inst._sortByFavoritesOrder(cats, favIds);
      expect(result.length).toBe(1);
    });
  });

  describe('_attachFollowInfo', () => {
    test('attaches follow duration to cats', () => {
      const inst = createInstance();
      const cats = [{ _id: 'cat1' }];
      const favIds = [{ id: 'cat1', time: Date.now() - 86400000 * 5 }];
      inst._attachFollowInfo(cats, favIds);
      expect(cats[0]._followDuration).toBeTruthy();
    });

    test('sets empty string for missing follow time', () => {
      const inst = createInstance();
      const cats = [{ _id: 'cat1' }];
      const favIds = [{ id: 'cat1' }];
      inst._attachFollowInfo(cats, favIds);
      expect(cats[0]._followDuration).toBe('');
    });
  });

  describe('_formatFollowDuration', () => {
    test('returns empty string for null timestamp', () => {
      const inst = createInstance();
      expect(inst._formatFollowDuration(null)).toBe('');
    });

    test('returns "今天关注" for today', () => {
      const inst = createInstance();
      expect(inst._formatFollowDuration(Date.now())).toBe('今天关注');
    });

    test('returns "关注1天" for 1 day', () => {
      const inst = createInstance();
      expect(inst._formatFollowDuration(Date.now() - 86400000)).toBe('关注1天');
    });

    test('returns days format for < 30 days', () => {
      const inst = createInstance();
      expect(inst._formatFollowDuration(Date.now() - 86400000 * 10)).toBe('关注10天');
    });

    test('returns months format for >= 30 days', () => {
      const inst = createInstance();
      const ts = Date.now() - 86400000 * 60;
      const result = inst._formatFollowDuration(ts);
      expect(result).toContain('个月');
    });

    test('returns years format for >= 365 days', () => {
      const inst = createInstance();
      const ts = Date.now() - 86400000 * 400;
      const result = inst._formatFollowDuration(ts);
      expect(result).toContain('年');
    });
  });

  describe('_normalizeFavorites', () => {
    test('converts string entries to objects', () => {
      const inst = createInstance();
      const result = inst._normalizeFavorites(['cat1', 'cat2']);
      expect(result).toEqual([
        { id: 'cat1', time: expect.any(Number) },
        { id: 'cat2', time: expect.any(Number) }
      ]);
    });

    test('keeps valid object entries', () => {
      const inst = createInstance();
      const input = [{ id: 'cat1', time: 123 }];
      const result = inst._normalizeFavorites(input);
      expect(result).toEqual([{ id: 'cat1', time: 123 }]);
    });

    test('filters out invalid entries', () => {
      const inst = createInstance();
      const result = inst._normalizeFavorites([null, undefined, { time: 123 }, 'cat1']);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('cat1');
    });
  });

  describe('stopPropagation', () => {
    test('is a no-op function', () => {
      const inst = createInstance();
      expect(inst.stopPropagation()).toBeUndefined();
    });
  });
});
