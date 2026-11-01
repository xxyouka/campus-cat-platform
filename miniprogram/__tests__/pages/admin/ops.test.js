/**
 * pages/admin/ops/ops.js 回归
 *
 * 看板页最容易出的错不是样式，而是「把没有数据渲染成 0」：
 *   - 门禁失败必须退出，不能停在骨架屏；
 *   - 周表/卡片必须按服务端的 null 显示「—」，而不是 0%；
 *   - 入口清单要把注册表里 0 使用的入口补出来，并在满 28 天后标成淘汰候选；
 *   - 识猫全量口径不完整时，主卡要退回「已反馈中确认率」并说清楚。
 */
const mockCallAdminFunction = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn() };
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true))
};
const mockRegistry = [
  { name: 'rank', label: '猫咪榜单', hint: '「我的」→ 排行榜', group: '内容' },
  { name: 'campus_map', label: '寻猫地图', hint: '首页地图 / 打卡选点', group: '核心' }
];

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/opsTrack', () => ({ getRegistry: () => mockRegistry.map(item => ({ ...item })) }));
jest.mock('../../../pages/admin/utils/adminStatsCache', () => ({
  formatStatsTime: jest.fn(() => '刚刚')
}));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../../pages/admin/ops/ops');
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    data[key] = updates[key];
  }
}

function createInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData: jest.fn(function (updates) { applySetData(this.data, updates); }),
    safeSetData: function (updates) { applySetData(this.data, updates); },
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

function week(overrides = {}) {
  return {
    key: '2026-10-19',
    label: '本周 10/19–10/25',
    startAt: 0,
    endAt: 0,
    isCurrent: true,
    hasData: true,
    isPartial: false,
    newUsers: 4,
    maturedNewUsers: 3,
    activatedUsers: 2,
    activationRate: 2 / 3,
    firstMeetUsers: 1,
    firstMeetRate: 1 / 3,
    followers: 2,
    maturedFollowers: 1,
    returnedFollowers: 1,
    followReturnRate: 1,
    recognitionAttempts: 3,
    candidateAttempts: 2,
    recognitionFeedbacks: 2,
    recognitionConfirmed: 1,
    recognitionTop1: 1,
    recognitionNone: 1,
    recognitionCoverageStarted: true,
    recognitionCoverageComplete: true,
    confirmRate: 1 / 3,
    confirmRateAmongCandidates: 1 / 2,
    feedbackRate: 2 / 3,
    confirmRateAmongFeedback: 1 / 2,
    top1Rate: 1 / 3,
    noneRate: 1 / 3,
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    computedAt: Date.now(),
    weeks: [week()],
    entries: {
      windowDays: 28,
      sinceDay: '2026-09-24',
      activeUsers28: 10,
      pruneReady: true,
      items: [
        { name: 'rank', users28: 5, share: 0.5, lastDay: '2026-10-20', status: 'keep' }
      ]
    },
    coverage: {
      trackingStartAt: Date.now() - 40 * 86400000,
      trackingDays: 40,
      recognitionLogStartAt: Date.now() - 20 * 86400000,
      newUserMetricReadyAt: Date.now() - 33 * 86400000,
      entryPruneReadyAt: Date.now() - 12 * 86400000
    },
    dataWarnings: [],
    ...overrides
  };
}

function mockSuccess(data) {
  mockCallAdminFunction.mockResolvedValue({ result: { success: true, data } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  global.getCurrentPages = jest.fn(() => [{}]);
  wx.redirectTo = jest.fn();
  wx.navigateBack = jest.fn();
  wx.stopPullDownRefresh = jest.fn();
});

describe('运营看板页', () => {
  test('成功加载：三张卡、周表、入口清单与口径文案一起落地', async () => {
    mockSuccess(payload());
    const inst = createInstance();

    await inst.onLoad();

    expect(inst.data.loading).toBe(false);
    expect(inst.data.loadFailed).toBe(false);
    expect(inst.data.hasData).toBe(true);
    expect(inst.data.cards).toHaveLength(3);
    expect(inst.data.cards[0].label).toBe('新用户激活');
    expect(inst.data.cards[0].value).toBe('67%');
    expect(inst.data.cards[1].value).toBe('33%');
    expect(inst.data.cards[2].value).toBe('100%');
    expect(inst.data.weeks).toHaveLength(1);
    expect(inst.data.weeks[0].newUsers).toBe('4');

    // 注册表里的 campus_map 没出现在服务端数据里 → 28 天已满，标淘汰候选并排最前
    expect(inst.data.entries.map(item => item.name)).toEqual(['campus_map', 'rank']);
    expect(inst.data.entries[0].status).toBe('unused');
    expect(inst.data.entries[1].status).toBe('keep');
    expect(inst.data.entrySummary).toMatchObject({ unused: 1, keep: 1 });
    expect(inst.data.coverage.activeUsers28).toBe(10);
    expect(inst.data.updateTime).toBe('刚刚');
  });

  test('未满 7 天：率值显示 —，不能显示 0%', async () => {
    mockSuccess(payload({
      weeks: [week({
        maturedNewUsers: 0,
        activationRate: null,
        firstMeetRate: null,
        maturedFollowers: 0,
        followReturnRate: null
      })]
    }));
    const inst = createInstance();

    await inst.onLoad();

    expect(inst.data.cards[0].value).toBe('—');
    expect(inst.data.cards[1].value).toBe('—');
    expect(inst.data.cards[2].value).toBe('—');
    expect(inst.data.weeks[0].activation).toBe('—');
    expect(inst.data.weeks[0].firstMeet).toBe('—');
    expect(inst.data.weeks[0].followReturn).toBe('—');
  });

  test('门禁失败：退出页面，不能停在骨架屏', async () => {
    jest.useFakeTimers();
    mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
    const inst = createInstance();

    await inst.onLoad();
    expect(inst.data.loading).toBe(false);
    expect(inst.data.loadFailed).toBe(true);

    jest.advanceTimersByTime(1500);
    // 页面栈深度为 1（短链/扫码直达）时走 redirectTo，不能停在无权限页
    expect(wx.redirectTo).toHaveBeenCalledWith({ url: '/pages/admin/admin' });
  });

  test('接口失败且没有旧数据：展示独立失败态', async () => {
    mockCallAdminFunction.mockResolvedValue({ result: { success: false, error: '数据库不可用' } });
    const inst = createInstance();

    await inst.onLoad();

    expect(inst.data.loading).toBe(false);
    expect(inst.data.loadFailed).toBe(true);
    expect(mockErrorHandler.handle).toHaveBeenCalled();
  });

  test('切换周期：用新的 weeks 重新拉取', async () => {
    mockSuccess(payload());
    const inst = createInstance();
    await inst.onLoad();

    mockCallAdminFunction.mockClear();
    mockSuccess(payload());
    await inst.onRangeChange({ currentTarget: { dataset: { weeks: 4 } } });

    expect(inst.data.rangeWeeks).toBe(4);
    expect(mockCallAdminFunction).toHaveBeenCalledWith('getOpsDashboard', { weeks: 4 });
  });

  test('下拉刷新结束后一定停止动画', async () => {
    mockSuccess(payload());
    const inst = createInstance();

    await inst.onPullDownRefresh();

    expect(wx.stopPullDownRefresh).toHaveBeenCalled();
  });
});
