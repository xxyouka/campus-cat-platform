/**
 * __tests__/pages/admin/cat-activity/cat-activity.test.js
 *
 * 「猫咪行动分析」入口页（选猫列表）的回归：
 *   1. 门禁：非管理员 / 普通管理员一律拦下并延迟返回（不能停在骨架屏）；
 *   2. 翻页取全：filterCats 按 100/页翻到 hasMore=false，一次拉全再在客户端排序；
 *      下拉刷新与「重新加载」并发进来只能有一份响应落地（在途锁 + 序号守卫）；
 *   3. 客户端搜索：防抖后筛选，空态要分「库里没猫」与「搜索没搜到」；
 *   4. 失败态：loadFailed 必须独立于空态（否则故障会伪装成「还没有猫咪档案」）。
 */
const mockCallAdminFunction = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn(), handleDatabaseError: jest.fn() };
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin')
};
const mockMediaHelper = {
  resolveCatAvatars: jest.fn((list) => Promise.resolve(list))
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/mediaHelper', () => mockMediaHelper);
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../../pages/admin/cat-activity/cat-activity');
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
    setData: jest.fn(function (updates) { applySetData(this.data, updates); }),
    safeSetData: function (updates) { applySetData(this.data, updates); },
    _isUnmounted: false,
    callAdminFunction: (...args) => mockCallAdminFunction(...args),
    goBack: () => {
      if (global.getCurrentPages().length > 1) wx.navigateBack();
      else wx.redirectTo({ url: '/pages/admin/admin' });
    }
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

/** 造一只 filterCats 返回形态的猫 */
function makeCat(id, extra = {}) {
  return {
    _id: id,
    name: `猫${id}`,
    avatar: '',
    color: '橘',
    location: '宿舍区',
    campus: '本部',
    status: 'normal',
    meetCount: 1,
    lastMeetTime: 1000,
    ...extra
  };
}

/**
 * onLoad 里的 loadCats 是 fire-and-forget（未 await），只 await onLoad 拿到的是
 * 「门禁已通过、加载还在途」的中间态。等一轮宏任务让「页面这一屏已就绪」确定下来。
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(true));
  mockAdminAuth.getAdminRole.mockImplementation(() => 'superadmin');
  mockMediaHelper.resolveCatAvatars.mockImplementation((list) => Promise.resolve(list));
  global.getCurrentPages.mockReturnValue([{}, {}]);
});

describe('pages/admin/cat-activity', () => {
  test('未登录 / 非管理员：关掉骨架屏并延迟返回，不打接口', async () => {
    jest.useFakeTimers();
    try {
      mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(false));
      const inst = createInstance();

      await inst.onLoad();

      expect(inst.data.loading).toBe(false);
      expect(mockCallAdminFunction).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1600);
      expect(wx.navigateBack).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('未开通 catActivity 权限：页面门禁拦下并延迟返回', async () => {
    const inst = createInstance();
    inst.guardPermission = jest.fn(() => false);

    await inst.onLoad();

    expect(inst.guardPermission).toHaveBeenCalledWith('catActivity', '猫咪行动分析');
    expect(inst.data.loading).toBe(false);
    expect(mockCallAdminFunction).not.toHaveBeenCalled();
  });

  test('超管：按 100/页翻到 hasMore=false，客户端按最近相遇倒序、首屏只露 30 只', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeCat(`a${String(i).padStart(3, '0')}`, { lastMeetTime: 1000 + i, status: 'normal' }));
    const page2 = [
      makeCat('b001', { lastMeetTime: 999999, status: 'lost' }),
      makeCat('b002', { lastMeetTime: 0, meetCount: 3 }),
      makeCat('b003', { lastMeetTime: 0, meetCount: 9 })
    ];
    const pagesRequested = [];
    mockCallAdminFunction.mockImplementation((name, params) => {
      pagesRequested.push(params.filters.page);
      const cats = params.filters.page === 1 ? page1 : page2;
      return Promise.resolve({
        result: { success: true, data: { cats, hasMore: params.filters.page === 1 } }
      });
    });

    const inst = createInstance();
    await inst.onLoad();
    await flush();

    expect(pagesRequested).toEqual([1, 2]);
    expect(mockCallAdminFunction.mock.calls[0][0]).toBe('filterCats');
    expect(mockCallAdminFunction.mock.calls[0][1].filters.pageSize).toBe(100);

    // 103 只全部拿到，列表按 lastMeetTime 倒序 → 最近的排最前
    expect(inst._allCats).toHaveLength(103);
    expect(inst.data.total).toBe(103);
    expect(inst.data.cats).toHaveLength(30);
    expect(inst.data.hasMore).toBe(true);
    expect(inst.data.cats[0].id).toBe('b001');
    expect(inst.data.cats[0].statusText).toBe('走失');
    expect(inst.data.cats[1].id).toBe('a099');
    // 从没被相遇过的垫底，并列时按累计次数降序（b003 9 次 > b002 3 次）
    // 注：_allCats 是原始顺序（页面只对它做二次筛选），排序结果在 _filtered 上
    expect(inst._allCats).toHaveLength(103);
    expect(inst._filtered.slice(101).map((c) => c.id)).toEqual(['b003', 'b002']);
    expect(inst._filtered[0].id).toBe('b001');
    expect(inst.data.headerText).toBe('共 103 只猫咪 · 按最近相遇排序');
    // 相遇时间给「MM-DD HH:mm」
    expect(inst.data.cats[0].lastMeetText).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    // 从没相遇过的不编造时间
    expect(inst._filtered[102].lastMeetText).toBe('');
  });

  test('并发刷新只有一份响应落地（在途锁）', async () => {
    let resolveFn;
    mockCallAdminFunction.mockImplementation(() => new Promise((resolve) => {
      resolveFn = resolve;
    }));

    const inst = createInstance();
    const first = inst.loadCats();
    const second = inst.loadCats();
    // 第二次进入被在途锁挡掉，不会重复打接口
    expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);

    resolveFn({ result: { success: true, data: { cats: [], hasMore: false } } });
    await Promise.all([first, second]);
    expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);
    expect(inst.data.loading).toBe(false);
  });

  test('搜索：防抖后筛选（猫名 / 花色 / 地点），无结果给独立空态', async () => {
    jest.useFakeTimers();
    try {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: {
          success: true,
          data: {
            cats: [
              makeCat('c1', { name: '大橘', color: '橘白', location: '图书馆后门' }),
              makeCat('c2', { name: '小黑', color: '全黑', location: '食堂' })
            ],
            hasMore: false
          }
        }
      }));

      const inst = createInstance();
      await inst.loadCats();
      expect(inst.data.total).toBe(2);

      // 命中「地点」也算（与服务端 filterCats 的关键词口径一致）
      inst.onSearchInput({ detail: { value: '图书馆' } });
      jest.advanceTimersByTime(250);
      expect(inst.data.total).toBe(1);
      expect(inst.data.cats[0].name).toBe('大橘');
      expect(inst.data.headerText).toBe('匹配 1 只（共 2 只）');

      // 搜不到：空态文案与「库里没猫」必须不同
      inst.onSearchInput({ detail: { value: '不存在' } });
      jest.advanceTimersByTime(250);
      expect(inst.data.total).toBe(0);
      expect(inst.data.emptyTitle).toBe('没有匹配的猫咪');
      expect(inst.data.emptyIcon).toBe('search');

      // 清空关键词恢复全量
      inst.onClearKeyword();
      expect(inst.data.total).toBe(2);
      expect(inst.data.emptyTitle).toBe('还没有猫咪档案');
      expect(inst.data.keyword).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });

  test('显示更多 / 触底：每次 +30，到底后不再增加', async () => {
    mockCallAdminFunction.mockImplementation(() => Promise.resolve({
      result: {
        success: true,
        data: {
          cats: Array.from({ length: 65 }, (_, i) => makeCat(`d${i}`, { lastMeetTime: i })),
          hasMore: false
        }
      }
    }));

    const inst = createInstance();
    await inst.loadCats();
    expect(inst.data.visibleCount).toBe(30);

    inst.onRevealMore();
    expect(inst.data.visibleCount).toBe(60);
    expect(inst.data.hasMore).toBe(true);

    inst.onReachBottom();
    expect(inst.data.visibleCount).toBe(65);
    expect(inst.data.hasMore).toBe(false);

    inst.onRevealMore();
    expect(inst.data.visibleCount).toBe(65);
  });

  test('加载失败：loadFailed 独立置位（不能被渲染成空态）', async () => {
    mockCallAdminFunction.mockImplementation(() => Promise.resolve({
      result: { success: false, error: 'QUERY_FAILED' }
    }));

    const inst = createInstance();
    await inst.onLoad();
    await flush();

    expect(inst.data.loading).toBe(false);
    expect(inst.data.loadFailed).toBe(true);
    expect(inst.data.cats).toEqual([]);
    expect(inst.data.total).toBe(0);
    expect(mockErrorHandler.handle).toHaveBeenCalled();
  });

  test('点猫咪进详情页：id 与名字都带上并做 URL 编码', () => {
    const inst = createInstance();
    inst.onGoToDetail({ currentTarget: { dataset: { catId: 'abc123', catName: '大 橘' } } });

    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/pages/admin/cat-activity/activity-detail?id=abc123&name=${encodeURIComponent('大 橘')}`
    });

    // 没有 id 的脏事件不跳转
    wx.navigateTo.mockClear();
    inst.onGoToDetail({ currentTarget: { dataset: {} } });
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });
});
