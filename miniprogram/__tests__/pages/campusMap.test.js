/**
 * subpackages/map/campus-map —— 校园寻猫地图
 *
 * 该页有两种模式，靠 onLoad 的 options.mode 分流：
 *   browse 独立浏览页：从 getCampusMapCats 拉猫标记，点标记弹卡片
 *   select 选点页：从 detail 的相遇打卡面板跳进来，选完用 EventChannel 回传坐标
 *
 * 选点页刻意做得很薄：只有地图 + 中间的针 + 底部一条确定栏（无搜索/无列表）。
 * 这里锁四条最容易出错的：
 *   1. 拉取失败时**降级为空 + loadError**，不能把上一次的猫留在地图上装作还在
 *   2. 选点模式不拉猫数据（走人页，没必要等网络）
 *   3. 初始针不能看运气：组件 canvas 没就绪时要轮询重试
 *   4. 选过点回传坐标；没动过地图则回传「校园内」且不带默认坐标
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockDateFormat = {
  formatDateShort: jest.fn(v => v ? `D${v}` : ''),
  formatTimeAgo: jest.fn(v => v ? `T${v}` : '')
};

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/dateFormat', () => mockDateFormat);
jest.mock('../../behaviors/safeSetDataBehavior', () => ({}));

let pageDef;
let openedChannel;
const ShareHelper = require('../../utils/shareHelper');
const createdPages = [];

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../subpackages/map/campus-map/campus-map');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.cloud.callFunction.mockReset();
  wx.navigateBack.mockReset();
  wx.navigateTo.mockReset();
  wx.switchTab.mockReset();
  openedChannel = null;
  createdPages.length = 0;
});

// 页面上的 seedPin / 分享快照都会退避重试；用例结束清掉，避免 Jest 报 open handle
afterEach(() => {
  createdPages.forEach((p) => {
    if (typeof p.onUnload === 'function') p.onUnload();
  });
  createdPages.length = 0;
});

/** 造一个页面实例：data 深拷贝 + setData 合并（与真实 Page 的浅合并语义一致） */
function makePage(options) {
  const page = Object.assign({}, pageDef);
  page.data = JSON.parse(JSON.stringify(pageDef.data));
  page.setData = jest.fn(patch => Object.assign(page.data, patch));
  page.getOpenerEventChannel = jest.fn(() => openedChannel);
  // 页面 behaviors 在测试环境不会自动合并：导览入口显式打桩
  page.initGuideTour = jest.fn();
  page.pauseGuideTour = jest.fn();
  page.destroyGuideTour = jest.fn();
  // 真实 Page 一定有 selectComponent；测试里默认「拿不到组件」，
  // 各用例需要时再覆盖。缺了它 resizeMapSoon 的定时器会抛异常。
  page.selectComponent = jest.fn(() => null);
  if (options && options.channel) openedChannel = options.channel;
  createdPages.push(page);
  return page;
}

/** 让 getCampusMapCats 返回给定猫 */
function mockCats(cats) {
  wx.cloud.callFunction.mockResolvedValue({
    result: { success: true, data: { cats, total: cats.length, campusZone: '本部' } }
  });
}

const CAT_A = 'a'.repeat(24);
const CAT_B = 'b'.repeat(24);
const CAT_C = 'c'.repeat(24);

/** 造一个「能拿到假地图组件」的页面，供需要验证组件交互的用例复用 */
function pageWithComp() {
  const page = makePage();
  const comp = {
    centerOnMark: jest.fn(() => true),
    resize: jest.fn(),
    pickAtCenter: jest.fn(() => ({ u: 0.42, v: 0.67, label: '图书馆' })),
    focusBeside: jest.fn(() => true),
    resetView: jest.fn(),
    zoomOnCluster: jest.fn(() => true)
  };
  page.selectComponent = jest.fn(() => comp);
  return { page, comp };
}

describe('campus-map 页面 · 模式分流', () => {
  test('默认 browse 模式，并拉取猫数据', async () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    expect(page.data.mode).toBe('browse');
    expect(page.data.crosshair).toBe(false);
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(wx.cloud.callFunction.mock.calls[0][0].name).toBe('getCampusMapCats');
  });

  test('mode=select 时不拉猫数据，并开启准星', () => {
    const page = makePage();
    page.onLoad({ mode: 'select' });
    expect(page.data.mode).toBe('select');
    expect(page.data.crosshair).toBe(true);
    expect(page.data.loading).toBe(false);
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test.each([
    ['未知模式', { mode: 'whatever' }],
    ['空 query', {}],
    ['数字', { mode: 1 }]
  ])('%s 一律当 browse 处理', (_label, options) => {
    mockCats([]);
    const page = makePage();
    page.onLoad(options);
    expect(page.data.mode).toBe('browse');
  });

  test('onPullDownRefresh 在 select 模式下不拉数据，只停掉动画', () => {
    const page = makePage();
    page.onLoad({ mode: 'select' });
    const r = page.onPullDownRefresh();
    expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    expect(r).toBeUndefined();
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  /** 选点页不该留着搜索/列表的状态字段 */
  test('选点页没有搜索与地点列表相关的 data', () => {
    const page = makePage();
    page.onLoad({ mode: 'select' });
    for (const k of ['places', 'filteredPlaces', 'placeKeyword', 'sheet', 'sheetDragging']) {
      expect(page.data[k]).toBeUndefined();
    }
  });
});

/**
 * 校区：底图一个校区一张（utils/campusMapRegistry），页面必须让
 * 「数据源（getCampusMapCats 的 campusZone）」与「底图（组件的 zone）」
 * 永远是同一个校区 —— 错开时画面看着正常、位置全错，最难发现。
 */
describe('campus-map 页面 · 校区', () => {
  test('默认校区是本部，并把它传给云函数', async () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    await page.loadCats();

    expect(page.data.campusZone).toBe('本部');
    expect(wx.cloud.callFunction.mock.calls[0][0].data).toEqual({ campusZone: '本部' });
  });

  test('选点页按 ?zone= 取校区（detail 按猫档案传进来）', () => {
    const page = makePage();
    page.onLoad({ mode: 'select', zone: '东区' });
    expect(page.data.campusZone).toBe('东区');
  });

  test('脏校区值退回本部（没底图的校区不能拿本部图凑合却标别的校区）', () => {
    const page = makePage();
    page.onLoad({ mode: 'select', zone: '火星校区' });
    expect(page.data.campusZone).toBe('本部');
  });

  test('浏览页只列出已有底图的校区（没画底图的切过去是一片空白）', () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    expect(page.data.zoneTabs).toEqual(['本部', '东区']);
  });

  test('选点页不给校区切换条（校区由猫档案定死）', () => {
    const page = makePage();
    page.onLoad({ mode: 'select', zone: '东区' });
    expect(page.data.zoneTabs).toEqual([]);
  });

  test('切校区：换数据源 + 清掉旧校区的选中态', async () => {
    mockCats([{ id: CAT_A, name: 'A', u: 0.1, v: 0.1, at: 1 }]);
    const page = makePage();
    page.onLoad({});
    await page.loadCats();
    page.setData({ activeId: CAT_A, activeCat: { id: CAT_A } });
    wx.cloud.callFunction.mockClear();

    page.onZoneTap({ currentTarget: { dataset: { zone: '东区' } } });

    expect(page.data.campusZone).toBe('东区');
    expect(page.data.activeId).toBe('');
    expect(page.data.activeCat).toBeNull();
    expect(page.data.marks).toEqual([]);
    expect(wx.cloud.callFunction.mock.calls[0][0].data).toEqual({ campusZone: '东区' });
  });

  test('切到同一个校区：不发请求（重复点不该重拉）', () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    wx.cloud.callFunction.mockClear();

    page.onZoneTap({ currentTarget: { dataset: { zone: '本部' } } });
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('切到没底图的校区：提示且不切（不留下「标着西区、画着本部」的状态）', () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    wx.cloud.callFunction.mockClear();

    page.onZoneTap({ currentTarget: { dataset: { zone: '西区' } } });

    expect(page.data.campusZone).toBe('本部');
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    expect(wx.showToast).toHaveBeenCalled();
  });

  test('选点页回传的校区是本页实际用的那张底图的校区', () => {
    const channel = { emit: jest.fn() };
    const page = makePage({ channel });
    page.onLoad({ mode: 'select', zone: '东区' });
    page.onPick({ detail: { u: 0.4, v: 0.6, label: '物业管理中心旁' } });

    page.onConfirmPick();

    expect(channel.emit.mock.calls[0][1]).toMatchObject({ campusZone: '东区' });
  });
});

describe('campus-map 页面 · 拉取与降级', () => {
  test('猫按坐标时间倒序，最近遇到的排最前', async () => {
    mockCats([
      { id: CAT_A, name: '旧', u: 0.1, v: 0.1, at: 100 },
      { id: CAT_B, name: '新', u: 0.2, v: 0.2, at: 900 }
    ]);
    const page = makePage();
    page.onLoad({});
    await page.loadCats();

    expect(page.data.marks.map(m => m.id)).toEqual([CAT_B, CAT_A]);
    expect(page.data.total).toBe(2);
    expect(page.data.loading).toBe(false);
    // 每只猫带上「多久前」，卡片直接用
    expect(page.data.marks[0].timeAgo).toBe('T900');
  });

  /** 关键：失败时不能留着上一次的猫装作还在地图上 */
  test('云函数失败：标记 loadError 并清空标记', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();
    mockCats([{ id: CAT_A, name: 'A', u: 0.1, v: 0.1, at: 1 }]);
    await page.loadCats();
    expect(page.data.marks).toHaveLength(1);

    wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '炸了' } });
    await page.loadCats();

    expect(page.data.loadError).toBe(true);
    expect(page.data.loading).toBe(false);
    expect(page.data.marks).toEqual([]);
    expect(page.data.total).toBe(0);
  });

  test('云函数抛异常：同样降级，不产生未捕获拒绝', async () => {
    const page = makePage();
    page.onLoad({});
    wx.cloud.callFunction.mockRejectedValue(new Error('network down'));
    await expect(page.loadCats()).resolves.toBeUndefined();

    expect(page.data.loadError).toBe(true);
    expect(page.data.marks).toEqual([]);
  });

  test('返回结构异常（data/cats 缺失）不炸，按空列表处理', async () => {
    const page = makePage();
    page.onLoad({});
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: {} } });
    await page.loadCats();

    expect(page.data.loadError).toBe(false);
    expect(page.data.marks).toEqual([]);
    expect(page.data.total).toBe(0);
  });

  /**
   * 拉完之后布局变了：顶部信息条（wx:if=!loading && !loadError）与底部猫列表
   * （wx:if=marks.length）从「没有」变成「有」，地图区被压矮几十 px。
   *
   * 组件量的是**位图尺寸**：不重量就是拿旧尺寸拉伸显示（画面被压扁），
   * 而命中检测靠缓存的 rect.top 换算，整片点击会跟着偏掉一截。
   */
  test('拉取完成后通知组件重新量尺寸', async () => {
    jest.useFakeTimers();
    const { page, comp } = pageWithComp();
    page.onLoad({});
    await page.loadCats();
    jest.advanceTimersByTime(50);
    expect(comp.resize).toHaveBeenCalled();
    jest.useRealTimers();
  });

  /** 失败/空态会把信息条和列表撤掉，地图区重新变高 —— 同样要重量 */
  test.each([
    ['云函数失败', { result: { success: false, error: '炸了' } }],
    ['云函数抛异常', null]
  ])('%s：降级后也要重量（布局缩回去了）', async (_label, result) => {
    jest.useFakeTimers();
    const { page, comp } = pageWithComp();
    page.onLoad({});
    if (result === null) wx.cloud.callFunction.mockRejectedValue(new Error('network down'));
    else wx.cloud.callFunction.mockResolvedValue(result);
    await page.loadCats();
    jest.advanceTimersByTime(50);
    expect(comp.resize).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('campus-map 页面 · 浏览模式交互', () => {
  beforeEach(() => {
    mockCats([
      { id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100, meetCount: 5 },
      { id: CAT_B, name: '小黑', status: 'lost', u: 0.2, v: 0.2, at: 200, meetCount: 1 }
    ]);
  });

  test('点标记：填卡片，状态翻成人话', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();

    page.onSelectMark({ detail: { id: CAT_B } });
    expect(page.data.activeId).toBe(CAT_B);
    expect(page.data.activeCat.name).toBe('小黑');
    expect(page.data.activeCat.statusText).toBe('走失');

    page.onSelectMark({ detail: { id: CAT_A } });
    expect(page.data.activeCat.statusText).toBe('在校');
  });

  test('点空白 / 关闭：清掉选中', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();
    page.onSelectMark({ detail: { id: CAT_A } });

    page.onSelectNone();
    expect(page.data.activeId).toBe('');
    expect(page.data.activeCat).toBeNull();
  });

  test('点到建筑：只在有选中猫时才收起', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();

    // 没选中时点建筑不该做任何事
    page.onSelectFeature({ detail: { type: 'building', data: { name: '教学楼' } } });
    expect(page.data.activeId).toBe('');

    page.onSelectMark({ detail: { id: CAT_A } });
    page.onSelectFeature({ detail: { type: 'building', data: { name: '教学楼' } } });
    expect(page.data.activeId).toBe('');
  });

  test('未知标记 id 不产生空卡片', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();
    page.onSelectMark({ detail: { id: 'not-a-cat' } });
    expect(page.data.activeCat).toBeNull();
  });

  test('「去看看TA」带上猫 id 跳详情', async () => {
    const page = makePage();
    page.onLoad({});
    await page.loadCats();
    page.onSelectMark({ detail: { id: CAT_A } });
    page.goToCat();
    expect(wx.navigateTo.mock.calls[0][0].url).toBe(`/pages/detail/detail?id=${CAT_A}`);
  });

  test('没有选中猫时不跳（防手滑）', () => {
    const page = makePage();
    page.goToCat();
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });

  /**
   * 底部横向猫列表：解决「针叠在一起点不准」和「没法按名字找猫」。
   */
  describe('底部猫列表', () => {
    test('点一项：地图飞过去 + 选中该猫', async () => {
      mockCats([
        { id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100 },
        { id: CAT_B, name: '小黑', status: 'lost', u: 0.2, v: 0.2, at: 200 }
      ]);
      const { page, comp } = pageWithComp();
      page.onLoad({});
      await page.loadCats();

      page.onTapCatChip({ currentTarget: { dataset: { id: CAT_B } } });

      expect(comp.centerOnMark).toHaveBeenCalledWith(CAT_B);
      expect(page.data.activeId).toBe(CAT_B);
      expect(page.data.activeCat.name).toBe('小黑');
      expect(page.data.activeCat.statusText).toBe('走失');
    });

    test('id 对不上任何猫时什么都不做', async () => {
      mockCats([{ id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100 }]);
      const { page, comp } = pageWithComp();
      page.onLoad({});
      await page.loadCats();

      page.onTapCatChip({ currentTarget: { dataset: { id: 'not-a-cat' } } });

      expect(comp.centerOnMark).not.toHaveBeenCalled();
      expect(page.data.activeCat).toBeNull();
    });

    test('组件没有 centerOnMark（老版本）时仍能选中，只是不飞', async () => {
      mockCats([{ id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100 }]);
      const page = makePage();
      page.selectComponent = jest.fn(() => ({}));
      page.onLoad({});
      await page.loadCats();

      expect(() => page.onTapCatChip({ currentTarget: { dataset: { id: CAT_A } } })).not.toThrow();
      expect(page.data.activeId).toBe(CAT_A);
    });
  });

  /**
   * 底部在「猫列表」和「选中卡片」之间切换，高度不同 → 地图区高度变 →
   * 必须通知组件重新量画布尺寸，否则画布尺寸与布局不符、内容错位。
   */
  test('选中/取消选中都会通知组件重新量尺寸', () => {
    jest.useFakeTimers();
    const { page, comp } = pageWithComp();
    page.setData({ marks: [{ id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 1 }] });

    page.onSelectMark({ detail: { id: CAT_A } });
    jest.advanceTimersByTime(400);
    expect(comp.resize).toHaveBeenCalledTimes(1);

    page.onSelectNone();
    jest.advanceTimersByTime(400);
    expect(comp.resize).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  /**
   * 点到一坨聚在一起的猫。
   *
   * 关键点：多只猫常常是在同一个地方分别打卡记下的（坐标一模一样），
   * 针怎么放都还是一个球、也点不开第二只。所以点开一坨**必须能看到都有哪些猫**；
   * 旧实现「放大到最大还聚着 → 默默选中第一只」正是这个 bug 的来源。
   */
  describe('点到一坨猫', () => {
    // 三只猫记在同一处（u/v 完全一样 —— 这正是现实里最常见的「一坨」）。
    // 顺序照 loadCats 排好的那样：最近遇到的在前
    const THREE = [
      { id: CAT_B, name: '小黑', status: 'lost', u: 0.1, v: 0.1, at: 300 },
      { id: CAT_C, name: '小灰', status: 'normal', u: 0.1, v: 0.1, at: 200 },
      { id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100 }
    ];

    test('点开：列出一坨的猫，且不静默选中任何一只', () => {
      const { page, comp } = pageWithComp();
      page.setData({ marks: THREE });

      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B, CAT_C] } });

      expect(comp.zoomOnCluster).toHaveBeenCalledWith([CAT_A, CAT_B, CAT_C]);
      expect(page.data.clusterCats.map(c => c.name)).toEqual(['小黑', '小灰', '小橘']);
      expect(page.data.activeId).toBe('');
      expect(page.data.activeCat).toBeNull();
    });

    /** marks 已按「最近遇到的在前」排好：名单沿用这个顺序，不按组件给的 id 顺序 */
    test('名单按 marks 顺序（最近遇到的在前），对不上的 id 被丢掉', () => {
      const { page } = pageWithComp();
      page.setData({ marks: THREE });

      page.onSelectCluster({ detail: { ids: [CAT_A, 'not-a-cat', CAT_C] } });

      expect(page.data.clusterCats.map(c => c.id)).toEqual([CAT_C, CAT_A]);
    });

    test('放大拆不开（组件返回 false）时：名单照常出现', () => {
      const { page, comp } = pageWithComp();
      comp.zoomOnCluster = jest.fn(() => false);   // 同一处打卡的几只猫就是这个结果
      page.setData({ marks: THREE });

      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B] } });

      expect(comp.zoomOnCluster).toHaveBeenCalled();
      expect(page.data.clusterCats.map(c => c.id)).toEqual([CAT_B, CAT_A]);
    });

    test('组件没有 zoomOnCluster（老版本）时名单照常出现', () => {
      const page = makePage();
      page.selectComponent = jest.fn(() => ({}));
      page.setData({ marks: THREE });

      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B] } });
      expect(page.data.clusterCats).toHaveLength(2);
    });

    test('只剩一只能对上（名单已过期）：直接进那只猫的详情', () => {
      const { page } = pageWithComp();
      page.setData({ marks: [THREE[2]] });      // 只剩小橘

      page.onSelectCluster({ detail: { ids: [CAT_A, 'not-a-cat'] } });

      expect(page.data.activeId).toBe(CAT_A);
      expect(page.data.activeCat.name).toBe('小橘');
      expect(page.data.clusterCats).toHaveLength(0);
    });

    test('空 ids 直接返回，不崩', () => {
      const { page, comp } = pageWithComp();
      expect(() => page.onSelectCluster({ detail: {} })).not.toThrow();
      expect(comp.zoomOnCluster).not.toHaveBeenCalled();
      expect(page.data.clusterCats).toHaveLength(0);
    });

    test('点名单里的一只：进详情，名单收起', () => {
      const { page, comp } = pageWithComp();
      page.setData({ marks: THREE });
      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B, CAT_C] } });

      page.onTapCatChip({ currentTarget: { dataset: { id: CAT_A } } });

      expect(page.data.activeId).toBe(CAT_A);
      expect(page.data.clusterCats).toHaveLength(0);
      expect(comp.centerOnMark).toHaveBeenCalledWith(CAT_A);
    });

    test('收起 / 点空白：名单清掉', () => {
      const { page } = pageWithComp();
      page.setData({ marks: THREE });
      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B] } });

      page.onCloseActive();
      expect(page.data.clusterCats).toHaveLength(0);

      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B] } });
      page.onSelectNone();
      expect(page.data.clusterCats).toHaveLength(0);
    });

    test('刷新数据后：旧的名单不能留着（id 已是上一批的猫）', async () => {
      mockCats([{ id: CAT_A, name: '小橘', status: 'normal', u: 0.1, v: 0.1, at: 100 }]);
      const page = makePage();
      page.onLoad({});
      await page.loadCats();
      page.setData({ clusterCats: [THREE[0], THREE[1]] });

      await page.loadCats();

      expect(page.data.clusterCats).toHaveLength(0);
    });

    test('名单与卡片切换都会通知组件重新量尺寸', () => {
      jest.useFakeTimers();
      const { page, comp } = pageWithComp();
      page.setData({ marks: THREE });

      page.onSelectCluster({ detail: { ids: [CAT_A, CAT_B] } });
      jest.advanceTimersByTime(400);
      expect(comp.resize).toHaveBeenCalledTimes(1);

      page.onTapCatChip({ currentTarget: { dataset: { id: CAT_A } } });
      jest.advanceTimersByTime(400);
      expect(comp.resize).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });
  });
});

describe('campus-map 页面 · 选点模式', () => {
  const channel = { emit: jest.fn() };

  /** 造一个带假地图组件的选点页 */
  function makePickingPage(compOverrides) {
    const page = makePage({ channel });
    const comp = Object.assign({
      pickAtCenter: jest.fn(() => ({ u: 0.42, v: 0.67, label: '图书馆', hitType: 'building' })),
      resetView: jest.fn()
    }, compOverrides || {});
    page.selectComponent = jest.fn(() => comp);
    page.onLoad({ mode: 'select' });
    return { page, comp };
  }

  test('选点 → 确定：坐标经 EventChannel 回传并返回', () => {
    const page = makePage({ channel });
    page.onLoad({ mode: 'select' });

    page.onPick({ detail: { u: 0.42, v: 0.67, label: '图书馆', hitType: 'building' } });
    expect(page.data.pending).toEqual({ u: 0.42, v: 0.67, label: '图书馆' });

    page.onConfirmPick();
    expect(channel.emit).toHaveBeenCalledWith('pickpoint', {
      u: 0.42, v: 0.67, label: '图书馆', campusZone: '本部'
    });
    expect(wx.navigateBack).toHaveBeenCalled();
  });

  test('拖动地图实时回抛：更新针下的位置，并算作真的选过', () => {
    const { page } = makePickingPage();
    page.onPickChange({ detail: { u: 0.1, v: 0.2, label: '食堂', hitType: 'building' } });
    expect(page.data.pending).toEqual({ u: 0.1, v: 0.2, label: '食堂' });
    expect(page.data.pickTouched).toBe(true);
  });

  test('拖到校外：针收起来，不显示无效坐标', () => {
    const { page } = makePickingPage();
    page.onPick({ detail: { u: 0.2, v: 0.3, label: '' } });
    page.onPickOut();
    expect(page.data.pending).toBeNull();
  });

  test('组件没 ready 时拖到校外不崩', () => {
    const { page } = makePickingPage();
    page.onPickOut();
    expect(page.data.pending).toBeNull();
  });

  test('没选点就确定：提示，不回传、不返回（否则用户以为选上了）', () => {
    const page = makePage({ channel });
    page.onLoad({ mode: 'select' });
    page.onConfirmPick();

    expect(channel.emit).not.toHaveBeenCalled();
    expect(wx.navigateBack).not.toHaveBeenCalled();
    expect(wx.showToast).toHaveBeenCalled();
  });

  test('点到校内空地（无建筑名）也接受，label 留空', () => {
    const page = makePage({ channel });
    page.onLoad({ mode: 'select' });
    page.onPick({ detail: { u: 0.5, v: 0.5, label: '', hitType: 'campus' } });
    page.onConfirmPick();
    expect(channel.emit.mock.calls[0][1].label).toBe('');
  });

  test('校外点击：提示并保持未选', () => {
    const page = makePage({ channel });
    page.onLoad({ mode: 'select' });
    page.onPickReject({ detail: { message: '要选在校内哦' } });
    expect(page.data.pending).toBeNull();
    expect(wx.showToast).toHaveBeenCalled();
  });

  test('没有 EventChannel（被直接打开）时不崩，只是返回', () => {
    const page = makePage();
    page.getOpenerEventChannel = jest.fn(() => undefined);
    page.onLoad({ mode: 'select' });
    page.onPick({ detail: { u: 0.3, v: 0.3, label: 'X' } });
    expect(() => page.onConfirmPick()).not.toThrow();
    expect(wx.navigateBack).toHaveBeenCalled();
  });

  test('onReady 会落一次初始针：一进来就该看到针，不用先拖一下', () => {
    const { page } = makePickingPage();
    page.onReady();
    // 针在校园中心只是起点，地点文字必须是「校园内」，不能冒充图书馆
    expect(page.data.pending).toEqual({ u: 0.42, v: 0.67, label: '校园内' });
    expect(page.data.pickTouched).toBe(false);
  });

  test('首次进入回到全图，不偏袒任何一栋楼', () => {
    const { page, comp } = makePickingPage();

    page.onReady();

    expect(comp.resetView).toHaveBeenCalled();
  });

  test('没动过地图就确定：只回传「校园内」，不带坐标', () => {
    const { page } = makePickingPage();

    page.onReady();
    page.onConfirmPick();

    expect(channel.emit).toHaveBeenCalledWith('pickpoint', {
      label: '校园内', isDefault: true, campusZone: '本部'
    });
    expect(wx.navigateBack).toHaveBeenCalled();
  });

  /** 「回到全图」回到的是校园中心起点；没重新选之前仍是「校园内」 */
  test('「回到全图」后针回到默认起点，仍按校园内处理', () => {
    const { page } = makePickingPage();
    page.onPick({ detail: { u: 0.1, v: 0.2, label: '食堂' } });

    page.onResetView();
    page.onConfirmPick();

    expect(page.data.pending).toEqual({ u: 0.42, v: 0.67, label: '校园内' });
    expect(page.data.pickTouched).toBe(false);
    expect(channel.emit).toHaveBeenCalledWith('pickpoint', {
      label: '校园内', isDefault: true, campusZone: '本部'
    });
  });

  test('组件没有 resetView（老版本）时照常降级，不崩', () => {
    const page = makePage();
    page.selectComponent = jest.fn(() => ({ pickAtCenter: jest.fn(() => ({ u: 0.1, v: 0.1, label: '' })) }));
    page.onLoad({ mode: 'select' });

    expect(() => page.onReady()).not.toThrow();
    expect(page.data.pending).toEqual({ u: 0.1, v: 0.1, label: '校园内' });
  });

  /**
   * 页面的 onReady 早于组件 canvas 初始化完成，这时 pickAtCenter() 返回 null。
   * 只试一次的话针就不出现，而且看机器快慢 —— 所以必须轮询重试。
   */
  test('组件还没就绪时轮询重试，就绪后针落下来', () => {
    jest.useFakeTimers();
    let ready = false;
    const { page } = makePickingPage({
      pickAtCenter: jest.fn(() => ready ? { u: 0.42, v: 0.67, label: '图书馆' } : null)
    });

    page.seedPin();
    expect(page.data.pending).toBeNull();       // 组件没就绪 → 先不落针

    jest.advanceTimersByTime(300);
    expect(page.data.pending).toBeNull();       // 仍未就绪

    ready = true;
    jest.advanceTimersByTime(300);
    expect(page.data.pending).toEqual({ u: 0.42, v: 0.67, label: '校园内' });
    jest.useRealTimers();
  });

  /** 退避重试是 150ms 一拍；用户可能在这段窗口里已经点好了位置 */
  test('重试落针不覆盖用户已经选好的位置', () => {
    jest.useFakeTimers();
    let ready = false;
    const { page } = makePickingPage({
      pickAtCenter: jest.fn(() => ready ? { u: 0.42, v: 0.67, label: '中心' } : null)
    });

    page.seedPin();
    page.onPick({ detail: { u: 0.1, v: 0.2, label: '食堂' } });

    ready = true;
    jest.advanceTimersByTime(300);

    expect(page.data.pending).toEqual({ u: 0.1, v: 0.2, label: '食堂' });
    expect(page.data.pickTouched).toBe(true);
    jest.useRealTimers();
  });

  test('组件始终不就绪也不会无限重试', () => {
    jest.useFakeTimers();
    const pickAtCenter = jest.fn(() => null);
    const { page } = makePickingPage({ pickAtCenter });

    page.seedPin();
    jest.advanceTimersByTime(5000);             // 远超退避总时长

    expect(pickAtCenter.mock.calls.length).toBeLessThanOrEqual(9);  // 首次 + 8 次重试
    expect(page.data.pending).toBeNull();
    jest.useRealTimers();
  });

  test('「回到全图」调组件 resetView，并把针重新落到新中心', () => {
    const { page, comp } = makePickingPage();
    comp.pickAtCenter.mockReturnValue({ u: 0.5, v: 0.5, label: '' });

    page.onResetView();

    expect(comp.resetView).toHaveBeenCalled();
    expect(page.data.pending).toEqual({ u: 0.5, v: 0.5, label: '校园内' });
  });

  test('组件缺失时各入口都不崩', () => {
    const page = makePage();
    page.selectComponent = jest.fn(() => null);
    page.onLoad({ mode: 'select' });
    expect(() => {
      page.onResetView();
      page.seedPin();
    }).not.toThrow();
  });
});

describe('campus-map 页面 · 分享', () => {
  test('转发给好友：标题非空，路径落到浏览模式并带上当前校区', () => {
    const page = makePage();
    page.onLoad({ mode: 'select', zone: '东区' });

    const share = page.onShareAppMessage();
    expect(typeof share.title).toBe('string');
    expect(share.title.length).toBeGreaterThan(0);
    expect(share.path).toBe(`/subpackages/map/campus-map/campus-map?zone=${encodeURIComponent('东区')}`);
    // 选点模式不能分享出去：接收方没有 EventChannel
    expect(share.path).not.toContain('mode=select');
  });

  test('分享路径里的校区能原样回到页面（编码 → 解码往返）', () => {
    mockCats([]);
    const sender = makePage();
    sender.onLoad({ mode: 'select', zone: '东区' });
    const zoneParam = sender.onShareAppMessage().path.split('zone=')[1];

    const receiver = makePage();
    receiver.onLoad({ zone: zoneParam });
    expect(receiver.data.campusZone).toBe('东区');
  });

  test('畸形百分号编码不崩，按本部兜底（手工拼接链接可达）', () => {
    mockCats([]);
    const page = makePage();
    expect(() => page.onLoad({ zone: '%E4' })).not.toThrow();
    expect(page.data.campusZone).toBe('本部');
  });

  test('分享到朋友圈：query 带上当前校区', () => {
    mockCats([]);
    const page = makePage();
    page.onLoad({});
    page.setData({ campusZone: '东区' });

    const share = page.onShareTimeline();
    expect(typeof share.title).toBe('string');
    expect(share.title.length).toBeGreaterThan(0);
    expect(share.query).toBe(`zone=${encodeURIComponent('东区')}`);
  });

  test('有当前校区的快照时优先用快照', () => {
    const page = makePage();
    page.onLoad({ mode: 'select', zone: '东区' });
    page._shareShot = { zone: '东区', path: 'wxfile://map.jpg' };

    expect(page.onShareAppMessage().imageUrl).toBe('wxfile://map.jpg');
    expect(page.onShareTimeline().imageUrl).toBe('wxfile://map.jpg');
  });

  test('快照还没备好时用随机品牌卡（不再拿猫头像凑数）', () => {
    const page = makePage();
    page.onLoad({ mode: 'select' });
    page.setData({ marks: [{ id: CAT_A, avatar: 'https://img.example.com/a.png' }] });

    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(page.onShareAppMessage().imageUrl);
  });

  test('切校区后旧校区的快照不能复用', () => {
    const page = makePage();
    page.onLoad({ mode: 'browse' });
    page.setData({ campusZone: '东区' });
    page._shareShot = { zone: '本部', path: 'wxfile://buben.jpg' };

    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(page.onShareAppMessage().imageUrl);
  });

  test('_prepareShareShot 成功后按校区缓存快照', async () => {
    const { page, comp } = pageWithComp();
    page.loadCats = jest.fn();   // 隔离：浏览态 onLoad 会经 loadCats 再跑一次，别计入
    page.onLoad({ mode: 'browse', zone: '东区' });
    comp.renderShareImage = jest.fn(() => Promise.resolve('wxfile://north.jpg'));

    page._prepareShareShot();
    await Promise.resolve();

    expect(comp.renderShareImage).toHaveBeenCalledTimes(1);
    expect(page._shareShot).toEqual({ zone: '东区', path: 'wxfile://north.jpg' });
  });

  test('渲染失败不缓存（分享时安静回退品牌卡）', async () => {
    const { page, comp } = pageWithComp();
    page.loadCats = jest.fn();
    page.onLoad({ mode: 'browse', zone: '东区' });
    comp.renderShareImage = jest.fn(() => Promise.reject(new Error('boom')));

    page._prepareShareShot();
    await Promise.resolve();

    expect(page._shareShot).toBeUndefined();
    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(page.onShareAppMessage().imageUrl);
  });

  test('组件底图还停在旧校区时先不渲染（避免把本部图挂到东区名下）', () => {
    const { page, comp } = pageWithComp();
    page.loadCats = jest.fn();
    page.onLoad({ mode: 'browse', zone: '东区' });
    comp.data = { mapZone: '本部' };
    comp.renderShareImage = jest.fn(() => Promise.resolve('wxfile://wrong.jpg'));

    page._prepareShareShot();

    expect(comp.renderShareImage).not.toHaveBeenCalled();
    expect(page._shareShot).toBeUndefined();
  });

  test('选点页不预备分享快照（没有分享菜单，还和落针抢画布状态）', async () => {
    const { page, comp } = pageWithComp();
    page.onLoad({ mode: 'select', zone: '东区' });
    comp.renderShareImage = jest.fn(() => Promise.resolve('wxfile://x.jpg'));

    page._prepareShareShot();
    page.onReady();
    await Promise.resolve();

    expect(comp.renderShareImage).not.toHaveBeenCalled();
  });

  test('切校区时立刻清掉旧快照，不给旧底图留窗口', () => {
    const { page } = pageWithComp();
    page.onLoad({ mode: 'browse' });
    page._shareShot = { zone: '本部', path: 'wxfile://buben.jpg' };

    page.onZoneTap({ currentTarget: { dataset: { zone: '东区' } } });
    expect(page._shareShot).toBeNull();
  });

  test('还没拉到数据时也能分享（标题退化成通用文案，不出现 0 只猫）', () => {
    const page = makePage();
    page.onLoad({ mode: 'select' });
    page.setData({ total: 0 });

    const share = page.onShareAppMessage();
    expect(share.title).not.toContain('0 只');
  });
});
