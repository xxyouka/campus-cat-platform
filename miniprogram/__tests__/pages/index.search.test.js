/**
 * __tests__/index.search.test.js - 首页搜索功能测试
 * 覆盖倒排索引构建和搜索逻辑
 */

// ===== 本地索引路径（_buildSearchIndex → _searchFromIndex → 真实 SearchEngine）=====
// 注意：此处故意不 mock utils/searchEngine —— 缺陷在于页面构造的筛选条件漏项，
// 引擎本身是正确的，mock 掉引擎就无法证伪。
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), swallow: jest.fn() };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn(), handleGlobalError: jest.fn(), handleUnhandledRejection: jest.fn(), initGlobalErrorCatch: jest.fn()
}));
jest.mock('../../utils/network', () => ({ checkNetwork: jest.fn(() => true), getNetworkManager: jest.fn() }));
jest.mock('../../utils/pageState', () => ({ getPageStateManager: jest.fn(() => ({ checkNeedRefresh: jest.fn(() => null) })) }));
jest.mock('../../utils/performanceMonitor', () => ({ monitorPageLoad: jest.fn((_, fn) => fn()), monitorApi: jest.fn((_, fn) => fn()) }));
jest.mock('../../utils/obsHelper', () => ({ isAvailable: jest.fn(), trySetup: jest.fn(), reportEvent: jest.fn(), EVENT_NAMES: {} }));
jest.mock('../../utils/imageLoader', () => ({ preloadAboveFold: jest.fn(), preloadBelowFold: jest.fn() }));
jest.mock('../../utils/imageRetryManager', () => ({ handleError: jest.fn(), cleanup: jest.fn() }));
jest.mock('../../utils/filterService', () => ({ loadCatsByCampus: jest.fn(), filterFromServer: jest.fn(), loadAllAndFilter: jest.fn() }));
jest.mock('../../services/catService', () => ({ loadCats: jest.fn(), loadMoreCats: jest.fn(), refreshSingleCat: jest.fn(), preloadNextPage: jest.fn() }));
jest.mock('../../services/imageService', () => ({ resolveAvatarsAsync: jest.fn(), preloadFirstScreen: jest.fn(), onImageLoad: jest.fn(), onImageError: jest.fn() }));
jest.mock('../../behaviors/cacheBehavior', () => ({}));
jest.mock('../../behaviors/backToTopBehavior', () => ({}));
jest.mock('../../behaviors/agreementBehavior', () => ({}));
jest.mock('../../behaviors/networkBehavior', () => ({}));

const RealSearchEngine = require('../../utils/searchEngine');

describe('首页本地索引路径的筛选条件', () => {
  let pageDef;

  beforeAll(() => {
    global.Page = jest.fn(obj => { pageDef = obj; return obj; });
    require('../../pages/index/index');
  });

  function createInstance(dataOverrides) {
    const inst = {
      data: { ...pageDef.data, ...dataOverrides },
      setData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
      // 关键：使用真实 SearchEngine，而非 mock
      _searchEngine: new RealSearchEngine()
    };
    for (const key of Object.keys(pageDef)) {
      if (typeof pageDef[key] === 'function' && !inst[key]) {
        inst[key] = pageDef[key].bind(inst);
      }
    }
    return inst;
  }

  // age 值取 2 字符，与 2-gram 索引粒度对齐（与 color/campus 同口径）
  const cats = [
    { _id: '1', name: '橘猫', color: '橘色', gender: '公', age: '成年', campus: '本部' },
    { _id: '2', name: '小白', color: '白色', gender: '母', age: '幼年', campus: '本部' },
    { _id: '3', name: '大橘', color: '橘色', gender: '公', age: '幼年', campus: '东区' }
  ];

  function buildAndSearch(overrides) {
    const inst = createInstance({
      searchKeyword: '', genderFilter: '', colorFilter: '', campusFilter: '', ageFilter: '', ...overrides
    });
    inst._buildSearchIndex(cats);
    return inst._searchFromIndex().map(c => c._id).sort();
  }

  test('仅 ageFilter 生效时，只返回年龄匹配的猫', () => {
    // 旧实现漏掉 ageFilter 条件 → 条件数组为空 → search([]) 返回全量 → 本断言失败
    expect(buildAndSearch({ ageFilter: '成年' })).toEqual(['1']);
  });

  test('ageFilter 与其它筛选条件取交集', () => {
    expect(buildAndSearch({ ageFilter: '幼年', colorFilter: '橘色' })).toEqual(['3']);
    expect(buildAndSearch({ ageFilter: '成年', genderFilter: 'female' })).toEqual([]);
  });

  test('未设置任何条件时返回全量', () => {
    expect(buildAndSearch({})).toEqual(['1', '2', '3']);
  });
});

