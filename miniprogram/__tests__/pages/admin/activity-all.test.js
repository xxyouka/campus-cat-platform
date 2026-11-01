/**
 * __tests__/pages/admin/activity-all.test.js
 *
 * 「全部小猫总轨迹」页回归。锁四件事：
 *   1. 门禁：非管理员 / 普通管理员拦下并延迟返回，不打云函数；
 *   2. 请求口径：scope='all' + 时间窗档位；同档重复点不发请求，切档重新现算；
 *   3. 装配：tracks 与图例的颜色一一对应（trailColorFor）、总量文案、脚注、
 *      两种空态（没打卡 vs 没点位）分开；
 *   4. 交互与失败态：图例聚焦/取消、失败可重试（不伪装成空态）、下拉刷新收尾；
 *   5. WXML 契约：地图开启 zoomable 且带「双指缩放」提示。
 */
const mockCallAdminFunction = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn(), handleDatabaseError: jest.fn() };
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin')
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

const CAT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CAT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const T1 = Date.UTC(2026, 5, 1, 1);   // 2026-06-01 09:00 北京时间
const T2 = Date.UTC(2026, 5, 2, 4);   // 2026-06-02 12:00

let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../../pages/admin/cat-activity/activity-all');
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
      if (global.getCurrentPages().length > 1) global.wx.navigateBack();
      else global.wx.redirectTo({ url: '/pages/admin/admin' });
    }
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

/** onLoad 里的 _reload 是 fire-and-forget，等一轮宏任务让首屏就绪 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function okResult(data) {
  return { result: { success: true, data } };
}

/** 云函数 getCatActivity scope='all' 的响应数据（analysis.analyzeTrails 契约） */
function makePayload(overrides = {}) {
  return {
    scope: 'all',
    cats: [
      {
        id: CAT_A, name: '大橘', avatar: '', status: 'normal', meets: 3, pointTotal: 3,
        sampled: false, lastMeetTime: T2,
        points: [{ u: 0.2, v: 0.2, t: T1 }, { u: 0.3, v: 0.25, t: T2 }]
      },
      {
        id: CAT_B, name: '小白', avatar: '', status: 'lost', meets: 1, pointTotal: 1,
        sampled: true, lastMeetTime: T1,
        points: [{ u: 0.7, v: 0.7, t: T1 }]
      }
    ],
    range: { days: 90, since: 0, until: 0, scanned: 4, truncated: false, maxScan: 10000, maxTrailPoints: 200 },
    totals: { meets: 4, cats: 2, points: 4, catsTruncated: false, returned: 2 },
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallAdminFunction.mockReset();
  mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(true));
  mockAdminAuth.getAdminRole.mockImplementation(() => 'superadmin');
  global.getCurrentPages.mockReturnValue([{}, {}]);
});

describe('pages/admin/activity-all', () => {
  describe('门禁', () => {
    test('未登录 / 非管理员：关骨架屏、延迟返回、不打接口', async () => {
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
      expect(mockCallAdminFunction).not.toHaveBeenCalled();
    });

    test('onUnload 清掉门禁的延迟返回定时器（不留孤儿定时器）', async () => {
      jest.useFakeTimers();
      try {
        mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(false));
        const inst = createInstance();
        await inst.onLoad();
        expect(inst._navBackTimer).toBeTruthy();

        inst.onUnload();
        expect(inst._navBackTimer).toBeNull();
        wx.navigateBack.mockClear();
        jest.advanceTimersByTime(5000);
        expect(wx.navigateBack).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('加载与装配', () => {
    test('首屏：scope=all + 默认 90 天；tracks 与图例颜色一一对应', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve(okResult(makePayload())));
      const inst = createInstance();
      await inst.onLoad();
      await flush();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('getCatActivity', { scope: 'all', rangeDays: 90 });
      expect(inst.data.loading).toBe(false);
      expect(inst.data.loadFailed).toBe(false);
      expect(inst.data.hasData).toBe(true);
      expect(inst.data.rangeIndex).toBe(1); // 默认档位是「近90天」

      // 颜色来自 trailColorFor（catId 散列）：图例与地图必须同色
      const summary = require('../../../pages/admin/utils/catActivitySummary');
      expect(inst.data.tracks.map((t) => t.id)).toEqual([CAT_A, CAT_B]);
      expect(inst.data.tracks[0].color).toBe(summary.trailColorFor(CAT_A));
      expect(inst.data.legend[0]).toMatchObject({
        id: CAT_A, name: '大橘', color: inst.data.tracks[0].color, countText: '3 点'
      });
      expect(inst.data.totalsText).toBe('图上 2 只猫 · 共 4 个打卡点位');
      expect(inst.data.footnote[0]).toBe('时间窗内共扫过 4 条相遇记录');
      // 地图高度按屏高算（setup 里 windowHeight=800 → 400）
      expect(inst.data.mapHeight).toBe(400);
    });

    test('空态：没打卡 vs 有打卡没点位，两种文案分开', () => {
      const inst = createInstance();

      let vm = inst._compose(makePayload({
        cats: [],
        totals: { meets: 0, cats: 0, points: 0, catsTruncated: false, returned: 0 }
      }));
      expect(vm.hasData).toBe(false);
      expect(vm.emptyTitle).toBe('这段时间还没有相遇记录');
      expect(vm.totalsText).toBe('');

      vm = inst._compose(makePayload({
        cats: [],
        totals: { meets: 9, cats: 0, points: 0, catsTruncated: false, returned: 0 }
      }));
      expect(vm.hasData).toBe(false);
      expect(vm.emptyTitle).toBe('这段时间还没有带地图位置的打卡');
      expect(vm.tracks).toEqual([]);
      expect(vm.legend).toEqual([]);
    });

    test('装配：截断 / 猫数上限 / 单猫采样如实进脚注', () => {
      const inst = createInstance();
      const vm = inst._compose(makePayload({
        range: { days: 90, since: 0, until: 0, scanned: 12000, truncated: true, maxScan: 10000, maxTrailPoints: 200 },
        totals: { meets: 12000, cats: 65, points: 9000, catsTruncated: true, returned: 60 },
        cats: [{
          id: CAT_A, name: '大橘', meets: 5, pointTotal: 300, sampled: true, lastMeetTime: T2,
          points: [{ u: 0.1, v: 0.1, t: T1 }]
        }]
      }));
      expect(vm.footnote).toContain('记录量超过 10000 条，本次只覆盖了最新的部分');
      expect(vm.footnote).toContain('带位置的猫较多，图上只画了最近活跃的 60 只');
      expect(vm.footnote).toContain('有 1 只猫的点位过多，每只最多画最近 200 个点');
    });
  });

  describe('时间窗与图例交互', () => {
    test('切时间窗：同档不重复请求；切档带新 rangeDays 重算并重置聚焦', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve(okResult(makePayload())));
      const inst = createInstance();
      await inst.onLoad();
      await flush();
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);

      // 先聚焦某只猫，再切窗口：聚焦要重置（新窗口上旧聚焦会误导）
      inst.onChipTap({ currentTarget: { dataset: { id: CAT_A } } });
      expect(inst.data.focusId).toBe(CAT_A);

      // 同档（默认就在 90）重复点不发请求
      inst.onRangeTap({ currentTarget: { dataset: { index: 1 } } });
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);

      // 切到近 30 天
      inst.onRangeTap({ currentTarget: { dataset: { index: 0 } } });
      expect(inst.data.refreshing).toBe(true);
      await flush();
      expect(inst.data.refreshing).toBe(false);
      expect(inst.data.rangeIndex).toBe(0);
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(mockCallAdminFunction.mock.calls[1][1]).toEqual({ scope: 'all', rangeDays: 30 });
      expect(inst.data.focusId).toBe('');

      // 越界下标不动
      inst.onRangeTap({ currentTarget: { dataset: { index: 9 } } });
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
    });

    test('图例点选：点一次聚焦、再点一次取消；空 id 不动状态', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve(okResult(makePayload())));
      const inst = createInstance();
      await inst.onLoad();
      await flush();

      inst.onChipTap({ currentTarget: { dataset: { id: CAT_B } } });
      expect(inst.data.focusId).toBe(CAT_B);
      inst.onChipTap({ currentTarget: { dataset: { id: CAT_B } } });
      expect(inst.data.focusId).toBe('');

      inst.onChipTap({ currentTarget: { dataset: {} } });
      expect(inst.data.focusId).toBe('');
    });
  });

  describe('失败态与刷新', () => {
    test('云函数业务失败：可重试的失败态（不伪装成空态）', async () => {
      mockCallAdminFunction.mockImplementation(() =>
        Promise.resolve({ result: { success: false, error: '仅超级管理员可查看猫咪行动分析' } }));
      const inst = createInstance();
      await inst.onLoad();
      await flush();

      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.errorText).toBe('仅超级管理员可查看猫咪行动分析');
      expect(inst.data.hasData).toBe(false);

      // 重试：重新请求并恢复
      mockCallAdminFunction.mockImplementation(() => Promise.resolve(okResult(makePayload())));
      inst.onRetryLoad();
      await flush();
      expect(inst.data.loadFailed).toBe(false);
      expect(inst.data.hasData).toBe(true);
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
    });

    test('拉取异常：统一文案 + ErrorHandler，不留骨架屏', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.reject(new Error('network down')));
      const inst = createInstance();
      await inst.onLoad();
      await flush();

      expect(inst.data.loading).toBe(false);
      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.errorText).toBe('获取总轨迹失败，请重试');
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });

    test('下拉刷新：重拉当前窗口并收掉刷新态', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve(okResult(makePayload())));
      const inst = createInstance();
      await inst.onLoad();
      await flush();

      inst.onPullDownRefresh();
      await flush();
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('WXML 契约', () => {
    const fs = require('fs');
    const path = require('path');
    const wxml = fs.readFileSync(path.resolve(__dirname, '../../../pages/admin/cat-activity/activity-all.wxml'), 'utf8');

    test('总轨迹地图开启缩放（zoomable），并给出双指缩放的提示', () => {
      // 「地图可以缩放」是对用户承诺过的能力：组件属性被摘掉就红
      expect(wxml).toMatch(/<activity-map[^>]*zoomable="\{\{true\}\}"/);
      expect(wxml).toContain('双指缩放');
    });
  });
});
