const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn(),
  handleValidationError: jest.fn()
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
jest.mock('../../../behaviors/backToTopBehavior', () => ({}));
const mockCallAdminFunction = jest.fn();
const mockVerifyAdmin = jest.fn(() => Promise.resolve(true));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: (...args) => mockVerifyAdmin(...args),
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/cat-manage/cat-manage');
});

const mockCats = [
  { _id: '1', name: 'Kitty', avatar: 'http://img.jpg', updateTime: new Date() },
  { _id: '2', name: 'Mimi', avatar: 'http://img2.jpg', updateTime: new Date() }
];

function makeFilterCatsResponse(cats, total, hasMore) {
  return { result: { success: true, data: { cats: cats || [], total: total || 0, hasMore: !!hasMore } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
  mockCallAdminFunction.mockReset();
  mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(mockCats, 2, false));
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.cloud.database.mockReset();
  wx.cloud.database.mockReturnValue({
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: [] })),
        count: jest.fn(() => Promise.resolve({ total: 0 }))
      })),
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: {} })),
        update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
        remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      limit: jest.fn(function() { return this; }),
      orderBy: jest.fn(function() { return this; }),
      skip: jest.fn(function() { return this; }),
      get: jest.fn(() => Promise.resolve({ data: [] }))
    })),
    command: {
      eq: jest.fn(v => v),
      neq: jest.fn(v => v)
    }
  });
  wx.showModal.mockReset();
  wx.showModal.mockImplementation((opts) => {
    if (opts.success) opts.success({ confirm: false });
    return Promise.resolve({ confirm: false });
  });
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let target = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = updates[key];
    } else {
      data[key] = updates[key];
    }
  }
}

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) {
      applySetData(this.data, updates);
    }),
    safeSetData: function(updates) {
      applySetData(this.data, updates);
    },
    _loading: false,
    _deleting: false,
    _searchTimer: null,
    _lastLoadTime: 0,
    _backToTopThreshold: 400,
    callAdminFunction: (...args) => mockCallAdminFunction(...args),
    verifyAdmin: () => Promise.resolve(true),
    convertCatAvatars: function(cats) { return Promise.resolve(cats); }
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('cat-manage page', () => {
  describe('onLoad', () => {
    it('should set statusBarHeight after auth passes', async () => {
      const inst = createInstance();
      inst.loadCats = jest.fn();
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(mockCats, 2, false));

      await inst.onLoad();

      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.loadCats).toHaveBeenCalled();
    });

    it('should return early when auth fails', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(0);
    });

    it('should allow ordinary admin (with cat permission) into cat-manage', async () => {
      mockAdminAuth.getAdminRole.mockReturnValue('admin');
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(mockCats, 2, false));
      const inst = createInstance();
      inst.loadCats = jest.fn();
      await inst.onLoad();
      // 入口权限由 guardPermission('cat') 把关；能进页面即不应再按角色隐藏删除
      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.loadCats).toHaveBeenCalled();
    });
  });

  describe('onShow', () => {
    it('should reload cats after cache expiry', async () => {
      const inst = createInstance();
      inst._firstShowSkipped = true; // onLoad 已完成首载
      inst._lastLoadTime = Date.now() - 30000;
      inst.loadCats = jest.fn();
      inst.onShow();
      expect(inst.loadCats).toHaveBeenCalled();
    });

    it('should not reload within cache period', () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst._lastLoadTime = Date.now() - 5000;
      inst.loadCats = jest.fn();
      inst.onShow();
      expect(inst.loadCats).not.toHaveBeenCalled();
    });

    it('should skip first onShow (onLoad already loaded)', () => {
      const inst = createInstance();
      inst.loadCats = jest.fn();
      inst.onShow();
      expect(inst.loadCats).not.toHaveBeenCalled();
    });
  });

  describe('loadCats', () => {
    it('should load cats via cloud function', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(mockCats, 2, false));

      await inst.loadCats();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('filterCats', {
        filters: { page: 1, pageSize: inst.data.pageSize }
      });
      expect(inst.data.cats.length).toBe(2);
      expect(inst.data.totalCats).toBe(2);
      expect(inst.data.loading).toBe(false);
      expect(inst._loading).toBe(false);
    });

    it('should prevent duplicate loading', async () => {
      const inst = createInstance();
      inst._loading = true;
      await inst.loadCats();
      expect(mockCallAdminFunction).not.toHaveBeenCalled();
    });

    it('should handle load error', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockResolvedValue({ result: { success: false, message: 'fail' } });

      await inst.loadCats();

      expect(mockLogger.error).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
      expect(inst._loading).toBe(false);
    });

    it('loadCats 在途时被新请求抢占：响应不得覆盖列表（搜索框与列表一致）', async () => {
      const inst = createInstance();
      let resolveLoad;
      mockCallAdminFunction.mockImplementationOnce(
        () => new Promise(resolve => { resolveLoad = resolve; })
      );

      const pending = inst.loadCats();
      // 在途期间搜索发起（performSearch 口径：自增 _searchSeq），搜索先落地
      inst._searchSeq = (inst._searchSeq || 0) + 1;
      inst.safeSetData({ cats: [{ _id: 's1', name: '搜索结果' }], hasSearched: true, loading: false });

      resolveLoad(makeFilterCatsResponse(mockCats, 2, false));
      await pending;

      // 旧响应的未过滤第一页被丢弃，搜索列表保持
      expect(inst.data.cats.length).toBe(1);
      expect(inst.data.cats[0]._id).toBe('s1');
      expect(inst._loading).toBe(false);
    });
  });

  describe('loadMoreCats', () => {
    it('should not load when already loading more', async () => {
      const inst = createInstance({ loadingMore: true });
      await inst.loadMoreCats();
      expect(mockCallAdminFunction).not.toHaveBeenCalled();
    });

    it('should not load when no more data', async () => {
      const inst = createInstance({ hasMore: false });
      await inst.loadMoreCats();
      expect(mockCallAdminFunction).not.toHaveBeenCalled();
    });

    it('搜索态下继续翻页：请求携带关键词，结果追加而非丢弃', async () => {
      const existingCats = [{ _id: '1', name: '橘座' }];
      const inst = createInstance({
        hasMore: true,
        hasSearched: true,
        searchKeyword: '橘',
        cats: existingCats,
        allCats: existingCats,
        page: 1,
        pageSize: 10
      });
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse([{ _id: '2', name: '橘子' }], 2, false));

      await inst.loadMoreCats();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('filterCats', {
        filters: { page: 2, pageSize: 10, keyword: '橘' }
      });
      expect(inst.data.cats.length).toBe(2);
      expect(inst.data.page).toBe(2);
    });

    it('should append new cats via cloud function', async () => {
      const existingCats = [{ _id: '1', name: 'Kitty' }];
      const newCats = [{ _id: '2', name: 'Mimi' }];
      const inst = createInstance({
        hasMore: true,
        hasSearched: false,
        cats: existingCats,
        allCats: existingCats,
        page: 1,
        pageSize: 10
      });
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(newCats, 2, false));

      await inst.loadMoreCats();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('filterCats', {
        filters: { page: 2, pageSize: 10 }
      });
      expect(inst.data.cats.length).toBe(2);
      expect(inst.data.page).toBe(2);
    });

    it('should set hasMore false when no more data', async () => {
      const inst = createInstance({ hasMore: true, hasSearched: false, page: 1, pageSize: 10 });
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse([], 0, false));

      await inst.loadMoreCats();

      expect(inst.data.hasMore).toBe(false);
    });

    it('加载更多在途时被搜索抢占：锁必须仍被释放（防死锁）', async () => {
      const inst = createInstance({ hasMore: true, hasSearched: false, page: 1, pageSize: 10 });
      // 挂起云调用，模拟 loadMoreCats 在途
      let resolveCall;
      mockCallAdminFunction.mockImplementation(
        () => new Promise(resolve => { resolveCall = resolve; })
      );

      const pending = inst.loadMoreCats();
      // 在途期间用户输入触发搜索（performSearch 的口径：自增 _searchSeq）
      inst._searchSeq = (inst._searchSeq || 0) + 1;

      resolveCall(makeFilterCatsResponse([{ _id: '9' }], 9, false));
      await pending;

      // 被抢占时不写入结果，但锁必须释放：
      // 旧实现 finally 里按 seq 判定，导致 _loading 永久为 true，
      // 此后 loadCats / loadMoreCats 全被守卫拦死。
      expect(inst._loading).toBe(false);
      // loadingMore 也必须复位：否则列表底部常驻「正在加载...」，
      // onReachBottom 与 loadMoreCats 的 data.loadingMore 守卫被永久拦死
      expect(inst.data.loadingMore).toBe(false);

      // 后续加载仍能正常发出请求
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(mockCats, 2, false));
      await inst.loadCats();
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(inst.data.cats.length).toBe(2);
    });
  });

  describe('convertCatAvatars', () => {
    it('should return cats unchanged when no cloud URLs', async () => {
      const inst = createInstance();
      const cats = [{ _id: '1', avatar: 'http://img.jpg' }];
      const result = await inst.convertCatAvatars(cats);
      expect(result).toEqual(cats);
    });

    it('should convert cloud URLs via cloud function', async () => {
      const inst = createInstance();
      // 用真实 convertCatAvatars 替换 stub
      inst.convertCatAvatars = pageDef.convertCatAvatars.bind(inst);
      const cats = [{ _id: '1', avatar: 'cloud://test-file-id' }];
      mockCallAdminFunction.mockResolvedValue({
        result: { data: { urlMap: { 'cloud://test-file-id': 'http://temp-url.jpg' } } }
      });

      const result = await inst.convertCatAvatars(cats);
      expect(result[0]._displayAvatar).toBe('http://temp-url.jpg');
    });

    it('should fall back to images array for cloud URLs', async () => {
      const inst = createInstance();
      inst.convertCatAvatars = pageDef.convertCatAvatars.bind(inst);
      const cats = [{ _id: '1', avatar: null, images: ['cloud://img-id'] }];
      mockCallAdminFunction.mockResolvedValue({
        result: { data: { urlMap: { 'cloud://img-id': 'http://temp.jpg' } } }
      });

      const result = await inst.convertCatAvatars(cats);
      expect(result[0]._displayAvatar).toBe('http://temp.jpg');
    });

    it('should handle cloud function error gracefully', async () => {
      const inst = createInstance();
      const cats = [{ _id: '1', avatar: 'cloud://test-id' }];
      mockCallAdminFunction.mockRejectedValue(new Error('fail'));

      const result = await inst.convertCatAvatars(cats);
      expect(result).toEqual(cats);
    });
  });

  describe('search', () => {
    it('onSearchInput should reload on empty keyword', () => {
      const inst = createInstance({ allCats: [{ _id: '1', name: 'Kitty' }], page: 1, pageSize: 10, totalCats: 1 });
      inst.loadCats = jest.fn();
      inst.onSearchInput({ detail: { value: '' } });
      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.hasSearched).toBe(false);
      expect(inst.loadCats).toHaveBeenCalled();
    });

    it('onSearchInput should set keyword and debounce', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst.performSearch = jest.fn();
      inst.onSearchInput({ detail: { value: 'Kitty' } });
      expect(inst.data.searchKeyword).toBe('Kitty');
      jest.advanceTimersByTime(300);
      expect(inst.performSearch).toHaveBeenCalledWith('Kitty');
      jest.useRealTimers();
    });

    it('onSearchInput should clear previous timer', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst.performSearch = jest.fn();
      inst.onSearchInput({ detail: { value: 'Ki' } });
      inst.onSearchInput({ detail: { value: 'Kitty' } });
      jest.advanceTimersByTime(300);
      expect(inst.performSearch).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('performSearch should search via cloud function', async () => {
      const inst = createInstance({ totalCats: 2 });
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse(
        [{ _id: '1', name: 'Kitty', color: 'orange' }], 1, false
      ));

      await inst.performSearch('kitty');

      expect(mockCallAdminFunction).toHaveBeenCalledWith('filterCats', {
        filters: { keyword: 'kitty', page: 1, pageSize: inst.data.pageSize }
      });
      expect(inst.data.cats.length).toBe(1);
      expect(inst.data.cats[0].name).toBe('Kitty');
      expect(inst.data.hasSearched).toBe(true);
    });

    it('onSearchConfirm should clear timer and search immediately', () => {
      jest.useFakeTimers();
      const inst = createInstance({ searchKeyword: 'test' });
      inst.performSearch = jest.fn();
      inst._searchTimer = setTimeout(() => {}, 9999);
      inst.onSearchConfirm();
      expect(inst.performSearch).toHaveBeenCalledWith('test');
      jest.useRealTimers();
    });

    it('onClearSearch should reload from server', () => {
      const inst = createInstance({ searchKeyword: 'test' });
      inst.loadCats = jest.fn();
      const seqBefore = inst._searchSeq || 0;
      inst.onClearSearch();
      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.hasSearched).toBe(false);
      expect(inst.data.page).toBe(1);
      expect(inst.loadCats).toHaveBeenCalled();
      // 在途搜索必须被作废：否则旧搜索响应会把列表改回过滤结果
      expect(inst._searchSeq).toBeGreaterThan(seqBefore);
    });

    it('搜索结果数使用服务端 total，而不再是当前页条数', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse([{ _id: 's1' }], 25, true));

      await inst.performSearch('猫');

      expect(inst.data.searchTotal).toBe(25);
      expect(inst.data.hasMore).toBe(true);
    });
  });

  describe('onUnload', () => {
    it('should clear search timer', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst._searchTimer = setTimeout(() => {}, 9999);
      inst.onUnload();
      expect(inst._searchTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  describe('edit and delete', () => {
    it('onEdit should navigate to edit page', () => {
      const inst = createInstance();
      inst.onEdit({ currentTarget: { dataset: { id: 'cat123' } } });
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/admin/edit-cat/edit-cat?id=cat123' });
    });

    it('onDelete should show delete modal', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: 'Kitty' }]
      });
      inst.onDelete({ currentTarget: { dataset: { id: '1' } } });
      expect(inst.data.deleteModal.show).toBe(true);
      expect(inst.data.deleteModal.cat).toEqual({ _id: '1', name: 'Kitty' });
    });

    it('onDelete should do nothing if cat not found', () => {
      const inst = createInstance({ cats: [] });
      inst.onDelete({ currentTarget: { dataset: { id: '999' } } });
      expect(inst.data.deleteModal.show).toBe(false);
    });

    it('onDeleteCancel should hide modal', () => {
      const inst = createInstance({ deleteModal: { show: true, cat: { _id: '1' } } });
      inst.onDeleteCancel();
      expect(inst.data.deleteModal.show).toBe(false);
    });

    it('onDeleteConfirm should delete cat successfully', async () => {
      const inst = createInstance({
        deleteModal: { show: true, cat: { _id: '1', name: 'Kitty' } }
      });
      inst.loadCats = jest.fn();
      mockCallAdminFunction.mockResolvedValue({ result: { success: true } });

      await inst.onDeleteConfirm();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('deleteData',
        expect.objectContaining({ type: 'cat', id: '1' })
      );
      expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('删除成功');
    });

    it('onDeleteConfirm should handle failure', async () => {
      const inst = createInstance({
        deleteModal: { show: true, cat: { _id: '1', name: 'Kitty' } }
      });
      mockCallAdminFunction.mockResolvedValue({ result: { success: false, message: 'fail' } });

      await inst.onDeleteConfirm();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });

    it('onDeleteConfirm should prevent duplicate delete', async () => {
      const inst = createInstance({
        deleteModal: { show: true, cat: { _id: '1' } }
      });
      inst._deleting = true;
      await inst.onDeleteConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onCatDetail should navigate to detail page', () => {
      const inst = createInstance();
      inst.onCatDetail({ currentTarget: { dataset: { id: 'cat123' } } });
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/detail/detail?id=cat123' });
    });
  });

  describe('onPullDownRefresh', () => {
    it('should reload cats and stop refresh', async () => {
      const inst = createInstance();
      inst.loadCats = jest.fn().mockResolvedValue();
      await inst.onPullDownRefresh();
      expect(inst.loadCats).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });

    it('搜索态下下拉刷新重放搜索，不用全量覆盖搜索结果', async () => {
      const inst = createInstance({ hasSearched: true, searchKeyword: '橘' });
      inst.loadCats = jest.fn().mockResolvedValue();
      mockCallAdminFunction.mockResolvedValue(makeFilterCatsResponse([{ _id: 's1', name: '橘子' }], 1, false));

      await inst.onPullDownRefresh();

      expect(inst.loadCats).not.toHaveBeenCalled();
      expect(mockCallAdminFunction).toHaveBeenCalledWith('filterCats', {
        filters: { keyword: '橘', page: 1, pageSize: 10 }
      });
      expect(inst.data.hasSearched).toBe(true);
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('onReachBottom', () => {
    it('should load more when not loading', () => {
      const inst = createInstance({ loading: false, loadingMore: false });
      inst.loadMoreCats = jest.fn();
      inst.onReachBottom();
      expect(inst.loadMoreCats).toHaveBeenCalled();
    });

    it('should not load more when loading', () => {
      const inst = createInstance({ loading: true, loadingMore: false });
      inst.loadMoreCats = jest.fn();
      inst.onReachBottom();
      expect(inst.loadMoreCats).not.toHaveBeenCalled();
    });
  });

  describe('onCatImageError', () => {
    it('should show emoji on image error', () => {
      const inst = createInstance({
        cats: [{ _id: '1', name: 'Kitty' }, { _id: '2', name: 'Mimi' }]
      });
      inst.onCatImageError({ currentTarget: { dataset: { index: 0 } } });
      expect(inst.data.cats[0]._showEmoji).toBe(true);
    });

    it('should handle invalid index', () => {
      const inst = createInstance({ cats: [] });
      inst.onCatImageError({ currentTarget: { dataset: { index: 99 } } });
      expect(inst.data.cats).toEqual([]);
    });
  });
});
