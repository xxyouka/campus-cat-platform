/**
 * __tests__/pages/admin/activity-detail.test.js
 *
 * 「单只猫的行动分析」详情页回归。锁四件事：
 *   1. 门禁与参数：非管理员 / 普通管理员拦下并延迟返回；catId 形态不对直接给
 *      「参数无效」空态，不白打一次云函数；
 *   2. 装配口径：结论句 / 条形宽度 / 星期中文 / 默认地点不进地点榜 /
 *      聚集圈命名合并 / 时间线 → 点位的联动索引；
 *   3. 失败态：`猫没了`（notFound，只能返回）与 `拉取失败`（可重试）必须分开；
 *   4. 时间窗：同档重复点不发请求，切档重新现算（页面永远跟最新打卡同步）。
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
// 地物命名有独立测试（campusLandmark.test.js）用真实底图数据；这里换确定性桩，
// 便于断言「聚集圈按名字合并」这条装配逻辑
jest.mock('../../../pages/admin/utils/campusLandmark', () => ({
  // 以 u=0.5 为界分两个地名：本文件只关心「同名合并」这一条装配逻辑
  nearestFeatureName: (u) => {
    return u < 0.5 ? '食堂' : '后山';
  }
}));

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

const CAT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T1 = Date.UTC(2026, 5, 1, 1);   // 2026-06-01 09:00 北京时间
const T2 = Date.UTC(2026, 5, 1, 4);   // 2026-06-01 12:00
const T3 = Date.UTC(2026, 5, 2, 4);   // 2026-06-02 12:00

let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../../pages/admin/cat-activity/activity-detail');
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

/** onLoad 里的 _reload 是 fire-and-forget，等一轮宏任务让首屏就绪 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 云函数 getCatActivity 的响应数据（analysis.analyze 契约） */
function makePayload(overrides = {}) {
  const points = [
    { u: 0.2, v: 0.2, t: T1 },
    { u: 0.21, v: 0.2, t: T2 },
    { u: 0.22, v: 0.2, t: T3 }
  ];
  return {
    cat: { id: CAT_ID, name: '大橘', avatar: '', campus: '本部', status: 'lost' },
    range: { days: 90, since: 0, until: 0, scanned: 3, truncated: false, maxScan: 5000 },
    totals: {
      meets: 3, withLocation: 2, withPoint: 3, withTag: 1,
      defaultLocation: 1, activeDays: 2, firstTime: T1, lastTime: T3
    },
    blocks: [
      { key: 'dawn', label: '清晨', range: '05:00-08:00', count: 0 },
      { key: 'morning', label: '上午', range: '08:00-12:00', count: 2 },
      { key: 'afternoon', label: '下午', range: '12:00-17:00', count: 1 },
      { key: 'dusk', label: '傍晚', range: '17:00-19:00', count: 0 },
      { key: 'evening', label: '晚上', range: '19:00-23:00', count: 0 },
      { key: 'night', label: '深夜', range: '23:00-05:00', count: 0 }
    ],
    weekdays: [
      { d: 1, count: 2 }, { d: 2, count: 1 }, { d: 3, count: 0 }, { d: 4, count: 0 },
      { d: 5, count: 0 }, { d: 6, count: 0 }, { d: 7, count: 0 }
    ],
    tags: [{ text: '在睡觉', count: 1, ratio: 1 }],
    locations: [{ text: '食堂旁', count: 2, ratio: 0.667 }],
    points: { total: 3, sampled: false, items: points },
    clusters: [
      { u: 0.2, v: 0.2, count: 3, radius: 0.01 },
      { u: 0.21, v: 0.2, count: 2, radius: 0.01 },
      { u: 0.9, v: 0.9, count: 4, radius: 0.02 }
    ],
    spread: { centroid: { u: 0.21, v: 0.2 }, p90: 0.1 },
    lastPoint: { u: 0.22, v: 0.2, t: T3 },
    recent: [
      { t: T3, location: '食堂旁', tag: '在睡觉', u: 0.22, v: 0.2 },
      { t: T2, location: '校园里', tag: '', u: 0.21, v: 0.2 },
      { t: T1, location: '食堂旁', tag: '', u: 0.2, v: 0.2 }
    ],
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(true));
  mockAdminAuth.getAdminRole.mockImplementation(() => 'superadmin');
  mockMediaHelper.resolveCatAvatars.mockImplementation((list) => Promise.resolve(list));
  global.getCurrentPages.mockReturnValue([{}, {}]);
});

describe('pages/admin/activity-detail', () => {
  describe('门禁与参数', () => {
    test('未登录 / 非管理员：关骨架屏、延迟返回、不打接口', async () => {
      jest.useFakeTimers();
      try {
        mockAdminAuth.requireAdminAuth.mockImplementation(() => Promise.resolve(false));
        const inst = createInstance();
        await inst.onLoad({ id: CAT_ID });

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
      await inst.onLoad({ id: CAT_ID });

      expect(inst.guardPermission).toHaveBeenCalledWith('catActivity', '猫咪行动分析');
      expect(mockCallAdminFunction).not.toHaveBeenCalled();
    });

    test('catId 形态不对：直接给「参数无效」空态，不白打一次云函数', async () => {
      const inst = createInstance();
      await inst.onLoad({ id: 'not-a-cat-id' });

      expect(mockCallAdminFunction).not.toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.notFound).toBe(true);
      expect(inst.data.errorText).toBe('猫咪参数无效，请从列表重新进入');
    });
  });

  describe('装配 _compose', () => {
    test('结论句 / 跨度 / 条形宽度 / 星期中文 / 时间线联动索引', () => {
      const inst = createInstance({ catId: CAT_ID, catName: '大橘' });
      const vm = inst._compose(makePayload());

      expect(vm.cat).toMatchObject({ id: CAT_ID, name: '大橘', campus: '本部', statusText: '走失' });
      expect(vm.navTitle).toBe('大橘');
      expect(vm.hasData).toBe(true);
      expect(vm.hasMap).toBe(true);
      expect(vm.mapPoints).toHaveLength(3);
      expect(vm.lastPoint).toEqual({ u: 0.22, v: 0.2, t: T3 });

      // 结论句：次数 / 天数 / 时段 / 场景 / 地点 / 范围
      expect(vm.conclusion).toContain('近90天相遇 3 次');
      expect(vm.conclusion).toContain('出现在 2 天里');
      expect(vm.conclusion).toContain('多在上午出没');
      expect(vm.conclusion).toContain('常出现在「食堂旁」');
      expect(vm.conclusion).toContain('活动范围比较集中');
      expect(vm.spanText).toMatch(/^样本：\d{2}-\d{2} \d{2}:\d{2} 至 \d{2}-\d{2} \d{2}:\d{2}$/);

      // 条形宽度按本榜单最大值；0 次的时段留空
      const morning = vm.blocks.find((b) => b.key === 'morning');
      const afternoon = vm.blocks.find((b) => b.key === 'afternoon');
      const dawn = vm.blocks.find((b) => b.key === 'dawn');
      expect(morning.percent).toBe(100);
      expect(afternoon.percent).toBe(50);
      expect(dawn.percent).toBe(0);

      // 星期带上中文名
      expect(vm.weekdays[0]).toMatchObject({ d: 1, count: 2, label: '周一', percent: 100 });
      expect(vm.weekdays[6]).toMatchObject({ d: 7, count: 0, label: '周日', percent: 0 });

      // 时间线：点条目 → 地图点位下标（正常应精确匹配）
      expect(vm.timeline).toHaveLength(3);
      expect(vm.timeline.map((r) => r.pointIndex)).toEqual([2, 1, 0]);
      expect(vm.timeline[0].timeText).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(vm.timeline[0].descText).toBe('食堂旁 · 在睡觉');
      // 默认「校园里」= 没填地点，显示成「未填地点」而不是一个假地点
      expect(vm.timeline[1].descText).toBe('未填地点');
      expect(vm.timeline.every((r) => r._active === false)).toBe(true);

      // 默认地点不进地点榜，但要如实说明
      expect(vm.locations).toEqual([{ text: '食堂旁', count: 2, ratio: 0.667, percent: 100 }]);
      expect(vm.locationNote).toBe('1 条打卡只填了默认的「校园内」，没填具体地点，因此未计入地点榜');

      // 聚集圈：同名（食堂一带）合并 → 只剩两条，标签带地名与次数
      expect(vm.clusters.map((c) => c.label)).toEqual(['食堂一带', '后山一带']);
      expect(vm.clusters[0]).toMatchObject({ count: 5, percent: 100 });
      expect(vm.clusters[1]).toMatchObject({ count: 4, percent: 80 });
      // 地图只吃 {u,v,count,label}：中心按次数加权（3:2 → 0.204），后山只一圈不合并
      expect(vm.mapClusters).toHaveLength(2);
      expect(vm.mapClusters[0]).toMatchObject({ count: 5, label: '食堂一带' });
      expect(vm.mapClusters[0].u).toBeCloseTo(0.204, 6);
      expect(vm.mapClusters[0].v).toBeCloseTo(0.2, 6);
      expect(vm.mapClusters[1]).toEqual({ u: 0.9, v: 0.9, count: 4, label: '后山一带' });

      // 脚注把样本量摊开讲
      expect(vm.footnote[0]).toBe('时间窗内共扫过 3 条相遇记录');
      expect(vm.footnote[1]).toBe('其中 2 条填了具体地点、3 条在打卡时选了地图位置');
    });

    test('没有相遇记录：hasData / conclusion / spanText 一起收口', () => {
      const inst = createInstance({ catId: CAT_ID, catName: '大橘' });
      const vm = inst._compose(makePayload({
        totals: {
          meets: 0, withLocation: 0, withPoint: 0, withTag: 0,
          defaultLocation: 0, activeDays: 0, firstTime: 0, lastTime: 0
        },
        points: { total: 0, sampled: false, items: [] },
        clusters: [],
        spread: null,
        lastPoint: null,
        recent: []
      }));

      expect(vm.hasData).toBe(false);
      expect(vm.hasMap).toBe(false);
      expect(vm.conclusion).toBe('');
      expect(vm.spanText).toBe('');
      expect(vm.spreadText).toBe('');
      expect(vm.locationNote).toBe('');
      expect(vm.timeline).toEqual([]);
    });

    test('点位不足 3 个：不评价活动范围（一两个点看不出范围）', () => {
      const inst = createInstance({ catId: CAT_ID, catName: '大橘' });
      const vm = inst._compose(makePayload({
        points: { total: 2, sampled: false, items: [{ u: 0.2, v: 0.2, t: T1 }] },
        spread: { centroid: { u: 0.2, v: 0.2 }, p90: 0.02 }
      }));

      expect(vm.spreadText).toBe('');
      // 「画不画」与「评不评价范围」是两件事：有点位就画（哪怕只有 1 个），
      // 但不给「范围很集中」这种一两个点撑不起来的结论
      expect(vm.hasMap).toBe(true);
      expect(vm.mapPoints).toHaveLength(1);
    });

    test('点位够 3 个但没有离散度：如实说样本太少，不硬报集中/分散', () => {
      const inst = createInstance({ catId: CAT_ID, catName: '大橘' });
      const vm = inst._compose(makePayload({ spread: null }));

      expect(vm.spreadText).toBe('点位样本还太少，暂不评价');
    });
  });

  describe('加载与失败态', () => {
    test('首屏：带 catId 与默认时间窗请求，装配结果落到 data', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: { success: true, data: makePayload() }
      }));

      const inst = createInstance();
      await inst.onLoad({ id: CAT_ID, name: encodeURIComponent('大橘') });
      await flush();

      expect(mockCallAdminFunction).toHaveBeenCalledWith('getCatActivity', { catId: CAT_ID, rangeDays: 90 });
      expect(inst.data.loading).toBe(false);
      expect(inst.data.loadFailed).toBe(false);
      expect(inst.data.hasData).toBe(true);
      expect(inst.data.cat.name).toBe('大橘');
      expect(inst.data.navTitle).toBe('大橘');
    });

    test('头像走云文件：解析后再写回（裸 cloud:// 会拉原图）', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: { success: true, data: makePayload({ cat: { id: CAT_ID, name: '大橘', avatar: 'cloud://x/a.jpg', status: 'normal' } }) }
      }));
      mockMediaHelper.resolveCatAvatars.mockImplementation((list) =>
        Promise.resolve(list.map((c) => ({ ...c, avatar: 'https://tmp/a.jpg' }))));

      const inst = createInstance();
      await inst.onLoad({ id: CAT_ID });
      await flush();

      expect(mockMediaHelper.resolveCatAvatars).toHaveBeenCalled();
      expect(inst.data.cat.avatar).toBe('https://tmp/a.jpg');
    });

    test('猫已删除：notFound 置位（页面只能返回，不提供重试）', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: { success: false, error: '猫咪不存在或已删除' }
      }));

      const inst = createInstance();
      await inst.onLoad({ id: CAT_ID });
      await flush();

      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.notFound).toBe(true);
      expect(inst.data.errorText).toBe('猫咪不存在或已删除');
      expect(inst.data.loading).toBe(false);
    });

    test('拉取异常：可重试的失败态（notFound 必须为 false）', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.reject(new Error('network down')));

      const inst = createInstance();
      await inst.onLoad({ id: CAT_ID });
      await flush();

      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.notFound).toBe(false);
      expect(inst.data.errorText).toBe('获取分析失败，请重试');
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });
  });

  describe('时间窗与时间线交互', () => {
    test('切时间窗：同档不重复请求，切档带新 rangeDays 重新现算', async () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: { success: true, data: makePayload() }
      }));

      const inst = createInstance();
      await inst.onLoad({ id: CAT_ID });
      await flush();
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);

      // 已在 90 天档：重复点不发请求
      inst.onRangeTap({ currentTarget: { dataset: { index: 1 } } });
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(1);

      // 切到 30 天：rangeIndex 生效 + 重新请求
      inst.onRangeTap({ currentTarget: { dataset: { index: 0 } } });
      await flush();
      expect(inst.data.rangeIndex).toBe(0);
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(mockCallAdminFunction.mock.calls[1][1].rangeDays).toBe(30);

      // 切到「全部」= 0 天
      inst.onRangeTap({ currentTarget: { dataset: { index: 2 } } });
      await flush();
      expect(mockCallAdminFunction.mock.calls[2][1].rangeDays).toBe(0);

      // 越界下标不动
      inst.onRangeTap({ currentTarget: { dataset: { index: 9 } } });
      expect(mockCallAdminFunction).toHaveBeenCalledTimes(3);
    });

    test('点时间线：有效条目高亮对应点位，没选位置的给提示并清高亮', () => {
      mockCallAdminFunction.mockImplementation(() => Promise.resolve({
        result: { success: true, data: makePayload() }
      }));

      const inst = createInstance();
      return inst.onLoad({ id: CAT_ID }).then(flush).then(() => {
        // 条目 1 有点位（下标 1）
        inst.onTimelineTap({ currentTarget: { dataset: { idx: 1 } } });
        expect(inst.data.highlight).toBe(1);
        expect(inst.data.timeline[1]._active).toBe(true);
        expect(inst.data.timeline[0]._active).toBe(false);
        expect(wx.showToast).not.toHaveBeenCalled();

        // 点位被采样截断、匹配不上时：给提示并清掉高亮，不圈错位置
        inst.setData({
          timeline: inst.data.timeline.map((it, i) => ({
            ...it,
            pointIndex: i === 0 ? -1 : it.pointIndex
          }))
        });
        inst.onTimelineTap({ currentTarget: { dataset: { idx: 0 } } });
        expect(wx.showToast).toHaveBeenCalledWith({ title: '这条打卡没选地图位置', icon: 'none' });
        expect(inst.data.highlight).toBe(-1);
        expect(inst.data.timeline.every((it) => it._active === false)).toBe(true);

        // 越界下标直接忽略
        inst.onTimelineTap({ currentTarget: { dataset: { idx: 99 } } });
        expect(inst.data.highlight).toBe(-1);
      });
    });
  });
});
