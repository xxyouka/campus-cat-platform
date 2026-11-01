/**
 * __tests__/pages/admin/media-review.test.js
 *
 * 内容复核页的关键行为：
 *   - 鉴权失败进入失败态，不请求队列；
 *   - list 结果补齐类型/状态/时间文案；
 *   - 通过 / 拦截调用 mediaReview，成功后从列表移除；
 *   - 「去处理」照片跳单猫相册、头像跳编辑猫咪。
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
  require('../../../pages/admin/media-review/media-review');
});

function applySetData(data, updates) {
  Object.assign(data, updates);
}

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    safeSetData: jest.fn(function(updates) { applySetData(this.data, updates); }),
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

describe('media-review page', () => {
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
      { _id: 'm1', target: 'photo', status: 'review', traceId: 't1', updateTime: Date.now() },
      { _id: 'm2', target: 'avatar', status: 'risky', traceId: 't2', updateTime: Date.now() }
    ], { total: 2, hasMore: false }));

    await inst.loadList(true);

    expect(inst.data.items[0]).toEqual(expect.objectContaining({
      targetText: '照片',
      statusText: '待复核',
      timeStr: '刚刚'
    }));
    expect(inst.data.items[1]).toEqual(expect.objectContaining({
      targetText: '猫猫头像',
      statusText: '已拦截'
    }));
    expect(inst.data.total).toBe(2);
  });

  test('通过：调用 resolve(keep) 并从列表移除', async () => {
    const inst = createInstance({ items: [{ _id: 'm1', status: 'review' }], total: 1 });
    mockCallAdminFunction.mockResolvedValue({ result: { success: true, data: {} } });

    await inst._resolve('m1', 'keep');

    expect(mockCallAdminFunction).toHaveBeenCalledWith('mediaReview', expect.objectContaining({
      action: 'resolve',
      id: 'm1',
      decision: 'keep'
    }), expect.anything());
    expect(inst.data.items).toEqual([]);
    expect(inst.data.total).toBe(0);
  });

  test('拦截：确认后才调用 resolve(block)', async () => {
    const inst = createInstance({ items: [{ _id: 'm1', status: 'review' }], total: 1 });
    inst.confirm = jest.fn(() => Promise.resolve(false));
    mockCallAdminFunction.mockResolvedValue({ result: { success: true, data: {} } });

    await inst.onBlock({ currentTarget: { dataset: { id: 'm1' } } });
    expect(mockCallAdminFunction).not.toHaveBeenCalled();

    inst.confirm = jest.fn(() => Promise.resolve(true));
    await inst.onBlock({ currentTarget: { dataset: { id: 'm1' } } });
    expect(mockCallAdminFunction).toHaveBeenCalledWith('mediaReview', expect.objectContaining({
      action: 'resolve',
      id: 'm1',
      decision: 'block'
    }), expect.anything());
  });

  test('去处理：照片跳单猫相册，头像跳编辑猫咪', () => {
    const inst = createInstance();

    inst.onGoTarget({ currentTarget: { dataset: { target: 'photo', catId: 'c1', catName: '小 橘' } } });
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: '/pages/admin/photo-manage/album-detail?catId=c1&catName=%E5%B0%8F%20%E6%A9%98'
    });

    inst.onGoTarget({ currentTarget: { dataset: { target: 'avatar', catId: 'c1' } } });
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: '/pages/admin/edit-cat/edit-cat?id=c1'
    });
  });

  test('筛选切换后重新从第 1 页加载', () => {
    const inst = createInstance({ page: 3, items: [{ _id: 'old' }] });
    inst.loadList = jest.fn();

    inst.onFilterTap({ currentTarget: { dataset: { filter: 'risky' } } });

    expect(inst.data.filter).toBe('risky');
    expect(inst.loadList).toHaveBeenCalledWith(true);
  });
});
