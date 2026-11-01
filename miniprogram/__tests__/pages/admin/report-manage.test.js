/**
 * __tests__/pages/admin/report-manage.test.js
 * 管理端反馈队列：鉴权、列表文案、处理回执、跳档案。
 */
const mockAdminAuth = { requireAdminAuth: jest.fn(() => Promise.resolve(true)) };
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockCallAdminFunction = jest.fn();

jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  goBack: jest.fn()
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../../pages/admin/report-manage/report-manage');
});

function createInstance(dataOverrides = {}) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
    safeSetData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
    _isUnmounted: false,
    callAdminFunction: (...args) => mockCallAdminFunction(...args),
    _loadingList: false
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

function makeListResponse(items, { total = items.length, hasMore = false } = {}) {
  return { result: { success: true, data: { items, total, hasMore } } };
}

describe('report-manage page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
    mockCallAdminFunction.mockReset();
  });

  test('鉴权失败进入失败态，不请求队列', async () => {
    mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
    const inst = createInstance();
    await inst.onLoad();
    expect(inst.data.loadFailed).toBe(true);
    expect(inst.data.loading).toBe(false);
    expect(mockCallAdminFunction).not.toHaveBeenCalled();
  });

  test('loadList 补齐类型/状态/时间文案', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockResolvedValue(makeListResponse([
      { _id: 'r1', catName: '斑斑', type: 'info_error', status: 'pending', description: '名字写错了', createTime: Date.now() },
      { _id: 'r2', catName: '困困', type: 'other', status: 'resolved', description: '已处理', createTime: Date.now() }
    ], { total: 2 }));

    await inst.loadList(true);

    expect(inst.data.items[0].typeText).toBe('信息有误');
    expect(inst.data.items[0].statusText).toBe('待处理');
    expect(inst.data.items[1].statusText).toBe('已处理');
    expect(inst.data.items[0].timeStr).toBeTruthy();
  });

  test('处理成功从列表移除并减少总数', async () => {
    const inst = createInstance({
      items: [{ _id: 'r1', status: 'pending' }],
      total: 1
    });
    mockCallAdminFunction.mockResolvedValue({ result: { success: true, data: { id: 'r1' } } });

    await inst._resolve('r1', 'resolved', '已修正');

    expect(mockCallAdminFunction).toHaveBeenCalledWith('manageReport', expect.objectContaining({
      action: 'resolve',
      id: 'r1',
      status: 'resolved',
      note: '已修正'
    }), expect.any(Object));
    expect(inst.data.items).toHaveLength(0);
    expect(inst.data.total).toBe(0);
  });

  test('跳转猫咪档案', () => {
    const inst = createInstance();
    inst.onGoCat({ currentTarget: { dataset: { catId: 'cat1' } } });
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/admin/edit-cat/edit-cat?id=cat1' });
  });

  test('loadStats 装饰类型文案与高频猫咪', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockResolvedValue({
      result: {
        success: true,
        data: {
          windowDays: 30,
          total: 8,
          status: { pending: 3, resolved: 4, rejected: 1 },
          recent: { days7: 2, days30: 6 },
          byType: [
            { type: 'info_error', count: 4 },
            { type: 'injured', count: 2 }
          ],
          topCats: [
            { catId: 'cat1', catName: '斑斑', count: 3, lastAt: Date.now() }
          ]
        }
      }
    });

    await inst.loadStats();

    expect(mockCallAdminFunction).toHaveBeenCalledWith('manageReport', { action: 'stats' }, expect.any(Object));
    expect(inst.data.statsLoaded).toBe(true);
    expect(inst.data.stats.status.pending).toBe(3);
    expect(inst.data.stats.byType[0]).toEqual({ type: 'info_error', label: '信息有误', count: 4 });
    expect(inst.data.stats.topCats[0]).toEqual(expect.objectContaining({
      catId: 'cat1',
      catName: '斑斑',
      count: 3
    }));
    expect(inst.data.stats.topCats[0].lastStr).toBeTruthy();
  });

  test('类型 / 猫咪筛选写入列表请求，清除后恢复', () => {
    const inst = createInstance({ typeFilter: '', catFilterId: '' });
    mockCallAdminFunction.mockResolvedValue(makeListResponse([]));

    inst.onTypeFilterTap({ currentTarget: { dataset: { type: 'injured' } } });
    expect(inst.data.typeFilter).toBe('injured');
    expect(inst.data.filterText).toBe('受伤 / 生病');
    expect(mockCallAdminFunction).toHaveBeenCalledWith('manageReport', expect.objectContaining({
      action: 'list',
      type: 'injured'
    }), expect.any(Object));

    mockCallAdminFunction.mockClear();
    inst.onCatFilterTap({ currentTarget: { dataset: { catId: 'cat1', catName: '斑斑' } } });
    expect(inst.data.catFilterId).toBe('cat1');
    expect(inst.data.filterText).toBe('受伤 / 生病 · 斑斑');
    expect(mockCallAdminFunction).toHaveBeenCalledWith('manageReport', expect.objectContaining({
      action: 'list',
      type: 'injured',
      catId: 'cat1'
    }), expect.any(Object));

    mockCallAdminFunction.mockClear();
    inst.onClearFilters();
    expect(inst.data.typeFilter).toBe('');
    expect(inst.data.catFilterId).toBe('');
    expect(inst.data.filterText).toBe('');
    expect(mockCallAdminFunction).toHaveBeenCalledWith('manageReport', expect.objectContaining({
      action: 'list',
      type: '',
      catId: ''
    }), expect.any(Object));
  });

  test('「全部」筛选处理成功后原地更新状态，不从列表移除', async () => {
    const inst = createInstance({
      filter: '',
      items: [{ _id: 'r1', status: 'pending', handleNote: '' }],
      total: 1
    });
    mockCallAdminFunction.mockResolvedValue({ result: { success: true, data: { id: 'r1' } } });

    await inst._resolve('r1', 'resolved', '已修正');

    expect(inst.data.items).toHaveLength(1);
    expect(inst.data.items[0].status).toBe('resolved');
    expect(inst.data.items[0].statusText).toBe('已处理');
    expect(inst.data.items[0].handleNote).toBe('已修正');
    expect(inst.data.total).toBe(1);
  });
});
