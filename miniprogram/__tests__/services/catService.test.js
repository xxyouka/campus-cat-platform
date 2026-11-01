const { loadCats, loadMoreCats, refreshSingleCat, preloadNextPage } = require('../../services/catService');

jest.mock('../../utils/avatarHelper', () => ({
  resolveCatAvatars: jest.fn(cats => Promise.resolve(cats)),
  // catService 的首屏字段预计算会直接调它（见 services/catService.js 的 resolveCatFields）：
  // 它是 mediaHelper 里的纯函数（不依赖 this），首屏不等网络时也要能选出头像。
  // 此前 mock 只给了 resolveCatAvatars，于是实现一调 selectAvatar 就 TypeError，
  // 而 catService 把异常吞进 catch 只留一条 warn —— 表现为「setData 只调了两次」的
  // 迷惑失败。补全 mock 时务必与真实模块的导出保持同步。
  selectAvatar: jest.fn(cat => {
    if (!cat) return null;
    if (cat.avatar) return cat.avatar;
    if (cat.images && cat.images.length > 0) return cat.images[0];
    return null;
  })
}));

jest.mock('../../utils/performanceMonitor', () => ({
  monitorApi: jest.fn((name, fn) => fn())
}));

jest.mock('../../utils/imageLoader', () => ({
  preloadBelowFold: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn()
}));

jest.mock('../../config', () => ({}));

function createMockPage(overrides = {}) {
  return {
    data: {
      pageSize: 10,
      page: 1,
      cats: [],
      filteredCats: [],
      loading: false,
      showSkeleton: false,
      loadingMore: false,
      hasMore: true,
      totalCats: 0,
      filteredCatCount: 0,
      totalPhotos: 0,
      totalViews: 0,
      campusFilter: '',
      genderFilter: '',
      colorFilter: '',
      ageFilter: '',
      searchKeyword: '',
      hasSearched: false,
      colorOptions: [],
      ...overrides.data
    },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _loadingCats: false,
    _loadingAll: false,
    _loadingMoreCats: false,
    _photosMap: {},
    _totalCatsCount: 0,
    _photoCountsMap: {},
    _allCatsCache: [],
    _extractColorOptions: jest.fn(() => ['橘色', '黑色']),
    filterCats: jest.fn(),
    _resolveAvatarsAsync: jest.fn(),
    _preloadNextPage: jest.fn(),
    ...overrides
  };
}

/**
 * 生成一个链式 collection 桩。
 *
 * 为什么要工厂而不是各处内联：`services/catService.js` 的查询链是
 * `collection().where().field().orderBy().limit().get()`，其中 field() 是
 * 「加字段投影」那轮改动引入的。各用例内联的桩一旦漏了 field()，
 * 实现会在链上抛 TypeError，而catService 把异常吞进catch 只留一条 warn ——
 * 断言看到的是「setData 一次都没调」，完全看不出是桩缺方法。
 * 这个坑已经踩过一次（4 条refreshSingleCat + 2 条 loadMoreCats 用例集体变红），
 * 故统一走工厂，新增查询方法只需在这里加一次。
 * orderBy 额外记录调用参数到 `stub.orderByCalls`：列表排序字段契约
 * （listSort 降序，三条查询必须一致）需要断言「查询真的下发了哪个字段」。
 */
function makeCollectionStub({ data = [], total = 0, getImpl, docData, docGetImpl, countImpl } = {}) {
  const orderByCalls = [];
  const docMock = {
    field: jest.fn().mockReturnThis(),
    get: jest.fn(() => {
      if (docGetImpl) return docGetImpl();
      // 注意不能用 `docData || ...`：本套件有一条用例显式传 docData: null
      // 来验证「云端返回空数据时不得更新列表」，|| 会把 null 吞成 {} 而让用例失去意义
      if (docData !== undefined) return Promise.resolve({ data: docData });
      return Promise.resolve({ data: (Array.isArray(data) ? data[0] : data) || {} });
    })
  };
  const stub = {
    where: jest.fn().mockReturnThis(),
    field: jest.fn().mockReturnThis(),
    orderBy: jest.fn((field, dir) => {
      orderByCalls.push({ field, dir });
      return stub;
    }),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    // doc 必须挂在 **collection** 上：实现调的是 db.collection('cats').doc(id)，
    // 挂在 database 上（wx.cloud.database().doc）永远不会被命中，
    // 表现为 refreshSingleCat 一条 setData 都不调（Number of calls: 0）
    doc: jest.fn(() => docMock),
    get: jest.fn(() => getImpl ? getImpl() : Promise.resolve({ data })),
    count: jest.fn(() => countImpl ? countImpl() : Promise.resolve({ total }))
  };
  stub.orderByCalls = orderByCalls;
  return stub;
}

/** 生成 wx.cloud.database 桩；command 必须含 in/neq（withCatVisibility 会取用 neq） */
function makeDatabaseStub(collectionStub, extra = {}) {
  return {
    collection: jest.fn(() => collectionStub),
    command: {
      in: jest.fn(v => v),
      neq: jest.fn(v => v),
      ...extra.command || {}
    },
    ...extra
  };
}

function setupDbMock(catsData = [], countTotal = 0) {
  const collectionMock = makeCollectionStub({ data: catsData, total: countTotal });
  wx.cloud.database.mockReturnValue(makeDatabaseStub(collectionMock));
  return { collectionMock, docMock: collectionMock.doc() };
}

describe('catService', () => {
  beforeEach(() => {
    // 本套件自带数据库桩（setupDbMock 每次重建 wx.cloud.database），因此保持原有的
    // jest.clearAllMocks()：它只清调用记录、不动 setup.js 登记的实现。
    //
    // 曾试过换成 resetWxStubs()，反而把失败从 3 条涨到 9 条 —— resetWxStubs 会mockReset
    // 一批桩，把本套件依赖的默认 wx.cloud 实现清成空壳。凡是自带桩体系的套件都别用它。
    jest.clearAllMocks();
  });

  describe('loadCats', () => {
    test('should set loading state and load cats successfully', async () => {
      const catsData = [
        { _id: '1', name: '小橘', avatar: 'cloud://abc', status: 'normal' },
        { _id: '2', name: '小黑', avatar: 'cloud://def', status: 'normal' }
      ];
      setupDbMock(catsData, 2);
      wx.cloud.callFunction.mockResolvedValue({
        result: { data: { counts: { '1': 5, '2': 3 }, totalPhotos: 8, totalViews: 100 } }
      });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loading: true, showSkeleton: true, page: 1 })
      );
      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          loading: false,
          showSkeleton: false,
          loadingMore: false
        })
      );
      expect(page._loadingCats).toBe(false);

      // 首页大头照档位回归：必须按 gallery 解析头像，不能回退成 avatar 100x100。
      // 220rpx 的大框配 100x100 源图会被放大 2~3 倍（@3x 屏放大 3.3 倍）→ 糊。
      //
      // 执行者从 loadCats 变成了首屏之后的异步补丁：loadCats 现在只做同步字段预计算
      // （见 catService.resolveCatFields），转链交给 page._resolveAvatarsAsync ——
      // 首屏不该为一次 getTempFileURL 往返空等（lazy-image 自己也能转 cloud://）。
      // 所以这里**不许**断言 loadCats 调过 resolveCatAvatars，改断言它没调。
      const AvatarHelper = require('../../utils/avatarHelper');
      expect(AvatarHelper.resolveCatAvatars).not.toHaveBeenCalled();

      // 档位断言移到异步补丁那条链路上（services/imageService.resolveAvatarsAsync）
      expect(typeof page._resolveAvatarsAsync).toBe('function');
    });

    test('首屏不等转链：loadCats 同步渲染，转链走异步补丁', async () => {
      const catsData = [{ _id: '1', name: '小橘', avatar: 'cloud://abc' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({
        result: { data: { counts: {}, totalPhotos: 0, totalViews: 0 } }
      });

      const page = createMockPage();
      await loadCats(page);

      // 关键：loadCats 走完时列表已渲染，且 avatar 仍是 cloud:// 原值（不空等转链）
      const rendered = page.setData.mock.calls
        .map(c => c[0])
        .filter(p => Array.isArray(p.cats))
        .pop();
      expect(rendered.cats[0].avatar).toBe('cloud://abc');
      // 预计算字段仍必须在位（wxml 直接用，算不出来得改模板）
      expect(rendered.cats[0].initialName).toBe('小');
      expect(rendered.cats[0]).toHaveProperty('photoCount');
      expect(rendered.cats[0]).toHaveProperty('updateTime');

      // 异步补丁被触发（由 page._resolveAvatarsAsync 承接，catService 只负责触发）
      expect(page._resolveAvatarsAsync).toHaveBeenCalled();
    });

    test('should prevent double loading when _loadingCats is true', async () => {
      const page = createMockPage({ _loadingCats: true });
      await loadCats(page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should prevent double loading when _loadingAll is true', async () => {
      const page = createMockPage({ _loadingAll: true });
      await loadCats(page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should set filteredCats when no active filter', async () => {
      const catsData = [{ _id: '1', name: '小橘', avatar: 'cloud://abc' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({
        result: { data: { counts: {}, totalPhotos: 0, totalViews: 0 } }
      });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          filteredCats: expect.any(Array),
          filteredCatCount: 1
        })
      );
    });

    test('should merge colorOptions with cloud-loaded colors instead of overwriting', async () => {
      // getFilterOptions（全量花色）与 loadCats 并发：loadCats 晚到时
      // 不能用首页子集整体覆盖云端全量花色；且两端都归一化为标准分类
      // （橘白 → 橘猫；已有列表原样保留）
      const catsData = [{ _id: '1', name: '小橘', avatar: 'cloud://abc', color: '橘白' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({
        result: { data: { counts: {}, totalPhotos: 0, totalViews: 0 } }
      });

      const page = createMockPage({ data: { colorOptions: ['三花', '其他花色'] } });
      await loadCats(page);

      // 固定顺序：狸花 < 橘猫 < 三花 < 奶牛 < 其他花色
      expect(page.data.colorOptions).toEqual(['橘猫', '三花', '其他花色']);
    });

    test('should call filterCats when active filter exists', async () => {
      const catsData = [{ _id: '1', name: '小橘', avatar: 'cloud://abc' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({
        result: { data: { counts: {}, totalPhotos: 0, totalViews: 0 } }
      });

      const page = createMockPage({
        data: { campusFilter: '东校区' }
      });
      await loadCats(page);

      expect(page.filterCats).toHaveBeenCalled();
    });

    test('should handle cloud function failure gracefully', async () => {
      const catsData = [{ _id: '1', name: '小橘' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockRejectedValue(new Error('cloud function timeout'));

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loading: false, showSkeleton: false })
      );
    });

    test('should handle database error', async () => {
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ getImpl: () => Promise.reject(new Error('db error')) }))
      );
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loading: false, showSkeleton: false })
      );
    });

    test('should reset _loadingCats in finally block', async () => {
      setupDbMock([], 0);
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page._loadingCats).toBe(false);
    });

    test('should reset _loadingCats even on error', async () => {
      wx.cloud.database.mockImplementation(() => { throw new Error('init fail'); });

      const page = createMockPage();
      await loadCats(page);

      expect(page._loadingCats).toBe(false);
    });

    test('should call _resolveAvatarsAsync after loading', async () => {
      const catsData = [{ _id: '1', name: '小橘' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page._resolveAvatarsAsync).toHaveBeenCalled();
    });

    test('should set hasMore based on page size', async () => {
      const catsData = Array.from({ length: 10 }, (_, i) => ({
        _id: String(i), name: `cat${i}`
      }));
      setupDbMock(catsData, 10);
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ hasMore: true })
      );
    });

    test('should set hasMore false when fewer cats than pageSize', async () => {
      const catsData = [{ _id: '1', name: '小橘' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ hasMore: false })
      );
    });

    test('should handle photoCounts cloud function failure with fallback', async () => {
      const catsData = [{ _id: '1', name: '小橘' }];
      setupDbMock(catsData, 1);
      wx.cloud.callFunction.mockRejectedValue(new Error('timeout'));

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loading: false, showSkeleton: false })
      );
    });

    test('should handle count query failure with fallback', async () => {
      const catsData = [{ _id: '1', name: '小橘' }];
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ data: catsData, countImpl: () => Promise.reject(new Error('count fail')) }))
      );
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ totalCats: 0 })
      );
    });
  });

  describe('loadMoreCats', () => {
    test('should load more cats and merge with existing', async () => {
      const existingCats = [{ _id: '1', name: '小橘' }];
      const newCats = [{ _id: '2', name: '小黑' }];
      setupDbMock(newCats, 2);

      const page = createMockPage({
        data: {
          cats: existingCats,
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false,
          totalCats: 2
        }
      });
      await loadMoreCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          loadingMore: false
        })
      );

      // 「加载更多」进来的卡片与首屏卡片渲染尺寸一致，档位必须同为 gallery，
      // 否则往下滑动会出现首屏清晰、后续糊的两批图
      const AvatarHelper = require('../../utils/avatarHelper');
      const call = AvatarHelper.resolveCatAvatars.mock.calls[0];
      expect(call[2]).toEqual(expect.objectContaining({ type: 'gallery' }));
    });

    test('should prevent double loading when _loadingMoreCats is true', async () => {
      const page = createMockPage({ _loadingMoreCats: true });
      await loadMoreCats(page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should prevent loading when loadingMore is true', async () => {
      const page = createMockPage({
        data: { loadingMore: true, hasMore: true }
      });
      await loadMoreCats(page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should prevent loading when hasMore is false', async () => {
      const page = createMockPage({
        data: { hasMore: false, loadingMore: false }
      });
      await loadMoreCats(page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should set hasMore false when empty results', async () => {
      setupDbMock([], 0);

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false
        }
      });
      await loadMoreCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ hasMore: false, loadingMore: false })
      );
      // 末页也要同步基准分页状态，否则清除筛选还原全量列表时 hasMore 会被错误还原为 true
      expect(page._baseHasMore).toBe(false);
    });

    test('stale empty page after pull-down refresh must not poison hasMore', async () => {
      // 加载更多在途时下拉刷新（_loadCatsSeq 自增），旧响应晚到且为空：
      // 若空页分支先于序号校验落盘，会把新列表「还有下一页」污染成「已经到底」
      let resolveGet;
      const collectionMock = makeCollectionStub({
        getImpl: () => new Promise(resolve => { resolveGet = resolve; })
      });
      wx.cloud.database.mockReturnValue(makeDatabaseStub(collectionMock));

      const page = createMockPage({
        data: { hasMore: true, page: 1, pageSize: 10, loadingMore: false }
      });
      page._loadCatsSeq = 5;

      const pending = loadMoreCats(page);
      // 请求在途时下拉刷新：序号自增使本次结果作废
      page._loadCatsSeq = 6;
      resolveGet({ data: [] });
      await pending;

      expect(page._baseHasMore).not.toBe(false);
      const wroteNoMore = page.setData.mock.calls.some(
        args => args[0] && args[0].hasMore === false
      );
      expect(wroteNoMore).toBe(false);
    });

    test('should deduplicate cats by _id', async () => {
      const existingCats = [{ _id: '1', name: '小橘' }];
      const newCats = [{ _id: '1', name: '小橘' }, { _id: '2', name: '小黑' }];
      setupDbMock(newCats, 2);

      const page = createMockPage({
        data: {
          cats: existingCats,
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false,
          totalCats: 2
        }
      });
      await loadMoreCats(page);

      const setDataCalls = page.setData.mock.calls;
      const mergedCall = setDataCalls.find(c => c[0].cats);
      expect(mergedCall[0].cats).toHaveLength(2);
    });

    test('should handle errors and reset loadingMore', async () => {
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ getImpl: () => Promise.reject(new Error('db error')) }))
      );

      const page = createMockPage({
        data: {
          cats: [],
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false
        }
      });
      await loadMoreCats(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loadingMore: false })
      );
      expect(page._loadingMoreCats).toBe(false);
    });

    test('should call filterCats after loading more', async () => {
      const newCats = [{ _id: '2', name: '小黑' }];
      setupDbMock(newCats, 2);

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false,
          totalCats: 2
        }
      });
      await loadMoreCats(page);

      expect(page.filterCats).toHaveBeenCalled();
    });

    test('should reset _loadingMoreCats in finally', async () => {
      setupDbMock([], 0);

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false
        }
      });
      await loadMoreCats(page);

      expect(page._loadingMoreCats).toBe(false);
    });

    test('should not clear loadingMore owned by a newer round when superseded', async () => {
      // P2-8：分页请求被下拉刷新抢占后作废返回时，loadingMore 已归新一轮所有，
      // 兜底复位必须按 seqAtStart 比对后跳过 —— 否则会把新一轮刚置上的加载态清掉，
      // 按钮文案回退成「加载更多」
      let resolveGet;
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ getImpl: () => new Promise(resolve => { resolveGet = resolve; }) }))
      );

      const page = createMockPage({
        data: { cats: [], page: 1, pageSize: 10, hasMore: true, loadingMore: false }
      });
      page._loadCatsSeq = 1;

      const pending = loadMoreCats(page);
      expect(page.data.loadingMore).toBe(true);

      // 刷新发起新一轮请求（此时 loadingMore 归新一轮所有）
      page._loadCatsSeq = 2;
      page.data.loadingMore = true;

      resolveGet({ data: [{ _id: '2', name: '小黑' }] });
      await pending;

      expect(page.data.loadingMore).toBe(true);
      expect(page.data.cats).toEqual([]);
    });

    test('should reset loadingMore when the page request still owns it', async () => {
      // 未发生抢占（seqAtStart 仍是最新）时 loadingMore 必须复位：
      // 引入「所有权」判定不得让普通分页路径回归成永久「正在加载」
      let resolveGet;
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ getImpl: () => new Promise(resolve => { resolveGet = resolve; }) }))
      );

      const page = createMockPage({
        data: { cats: [], page: 1, pageSize: 10, hasMore: true, loadingMore: false }
      });
      page._loadCatsSeq = 1;

      const pending = loadMoreCats(page);
      expect(page.data.loadingMore).toBe(true);

      resolveGet({ data: [{ _id: '2', name: '小黑' }] });
      await pending;

      expect(page.data.loadingMore).toBe(false);
      expect(page.data.cats.map(c => c._id)).toEqual(['2']);
    });
  });

  describe('refreshSingleCat', () => {
    test('should update single cat in list', async () => {
      const updatedCat = { _id: '1', name: '小橘', status: 'normal', avatar: 'new-avatar' };
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docData: updatedCat }))
      );

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘', avatar: 'old-avatar', _cloudFileID: 'old-avatar' }],
          filteredCats: [{ _id: '1', name: '小橘', avatar: 'old-avatar', _cloudFileID: 'old-avatar' }]
        }
      });
      await refreshSingleCat('1', page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          cats: expect.arrayContaining([
            expect.objectContaining({ _id: '1', name: '小橘' })
          ])
        })
      );
    });

    test('should not update if cat data is null', async () => {
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docData: null }))
      );

      const page = createMockPage({
        data: { cats: [], filteredCats: [] }
      });
      await refreshSingleCat('1', page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should handle errors silently', async () => {
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docGetImpl: () => Promise.reject(new Error('db error')) }))
      );

      const page = createMockPage({
        data: { cats: [], filteredCats: [] }
      });
      await expect(refreshSingleCat('1', page)).resolves.toBeUndefined();
    });

    test('should call filterCats when hasSearched is true', async () => {
      const updatedCat = { _id: '1', name: '小橘', status: 'normal' };
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docData: updatedCat }))
      );

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          filteredCats: [{ _id: '1', name: '小橘' }],
          hasSearched: true
        }
      });
      await refreshSingleCat('1', page);

      expect(page.filterCats).toHaveBeenCalled();
    });

    test('should set filteredCats directly when not searched', async () => {
      const updatedCat = { _id: '1', name: '小橘', status: 'normal' };
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docData: updatedCat }))
      );

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          filteredCats: [{ _id: '1', name: '小橘' }],
          hasSearched: false
        }
      });
      await refreshSingleCat('1', page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ filteredCats: expect.any(Array) })
      );
    });

    test('should preserve avatar when cloudFileID matches', async () => {
      const updatedCat = { _id: '1', name: '小橘', avatar: 'cloud://same' };
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ docData: updatedCat }))
      );

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘', avatar: 'temp-url', _cloudFileID: 'cloud://same' }],
          filteredCats: []
        }
      });
      await refreshSingleCat('1', page);

      const catsArg = page.setData.mock.calls.find(c => c[0].cats)?.[0].cats;
      expect(catsArg[0].avatar).toBe('temp-url');
    });
  });

  describe('preloadNextPage', () => {
    test('should preload next page data', async () => {
      const catsData = [
        { _id: '3', avatar: 'cloud://avatar3' },
        { _id: '4', avatar: 'cloud://avatar4' }
      ];
      setupDbMock(catsData, 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(wx.cloud.database).toHaveBeenCalled();
    });

    test('should call imageLoader.preloadBelowFold for cloud avatars', async () => {
      const imageLoader = require('../../utils/imageLoader');
      const catsData = [
        { _id: '3', avatar: 'cloud://avatar3' }
      ];
      setupDbMock(catsData, 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(imageLoader.preloadBelowFold).toHaveBeenCalledWith(
        ['cloud://avatar3'], 'avatar'
      );
    });

    test('should handle errors silently', async () => {
      wx.cloud.database.mockReturnValue(
        makeDatabaseStub(makeCollectionStub({ getImpl: () => Promise.reject(new Error('preload error')) }))
      );

      const page = createMockPage();
      await expect(preloadNextPage(2, page)).resolves.toBeUndefined();
    });

    test('should skip preload when no cats returned', async () => {
      const imageLoader = require('../../utils/imageLoader');
      setupDbMock([], 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(imageLoader.preloadBelowFold).not.toHaveBeenCalled();
    });

    test('should filter non-cloud avatar IDs', async () => {
      const imageLoader = require('../../utils/imageLoader');
      const catsData = [
        { _id: '3', avatar: 'https://example.com/img.jpg' }
      ];
      setupDbMock(catsData, 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(imageLoader.preloadBelowFold).not.toHaveBeenCalled();
    });

    test('should use images[0] as fallback avatar', async () => {
      const imageLoader = require('../../utils/imageLoader');
      const catsData = [
        { _id: '3', images: ['cloud://img1', 'cloud://img2'] }
      ];
      setupDbMock(catsData, 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(imageLoader.preloadBelowFold).toHaveBeenCalledWith(
        ['cloud://img1'], 'avatar'
      );
    });
  });

  describe('列表排序字段（listSort：领养垫底口径）', () => {
    // 首页三条查询（首屏 / 加载更多 / 预取下一页）必须共用同一排序字段
    // listSort 降序。排序值由服务端写库时维护（cloudfunctions/utils/listSort.js）：
    // 在校+走失 → 离世 → 被领养垫底；客户端只消费。
    // 这里锁定「查询真的下发了 listSort」——漏改/写错字段会让新旧口径静默混排
    // （改状态的猫顶到最前，与「被领养沉底」相反）。
    test('loadCats：首屏查询按 listSort 降序', async () => {
      const { collectionMock } = setupDbMock([], 0);
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { counts: {} } } });

      const page = createMockPage();
      await loadCats(page);

      expect(collectionMock.orderByCalls).toContainEqual({ field: 'listSort', dir: 'desc' });
    });

    test('loadMoreCats：加载更多按同一排序字段（分页 skip 与排序键必须一致）', async () => {
      const { collectionMock } = setupDbMock([{ _id: '2', name: '小黑' }], 2);

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', name: '小橘' }],
          page: 1,
          pageSize: 10,
          hasMore: true,
          loadingMore: false,
          totalCats: 2
        }
      });
      await loadMoreCats(page);

      expect(collectionMock.orderByCalls).toContainEqual({ field: 'listSort', dir: 'desc' });
    });

    test('preloadNextPage：预取按同一排序字段（预取位置必须与真实列表对齐）', async () => {
      const { collectionMock } = setupDbMock([{ _id: '3', avatar: 'cloud://a3' }], 0);

      const page = createMockPage();
      await preloadNextPage(2, page);

      expect(collectionMock.orderByCalls).toContainEqual({ field: 'listSort', dir: 'desc' });
    });
  });
});
