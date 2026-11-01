/**
 * pages/admin/components/activity-map —— 静态轨迹图的画法与连线规则
 *
 * 三块「错了不会报错、只会画错」的逻辑必须有测试：
 *   1. 连线规则（_segments）：只有同一天内间隔 ≤6h 的相邻两点才连虚线。
 *      多连一条线，用户看到的就是一条猫根本不存在的移动路线。
 *   2. 视图取景（_fit）：按校园边界适配并居中；系数错了整张图会跑到画布外。
 *   3. 画序与点型（_paint / _paintPoints / _paintLast）：越新的点越大越深、
 *      最近一次单独标记、脏坐标不进画布。
 *   4. 缩放手势（总轨迹页 zoomable）：锚点跟手指中点、夹限、平移跟手、
 *      「回到全图」—— 错了不会报错，只会手感诡异（够不着 / 从手指底下滑走）。
 */
jest.mock('../../images/campus-map/campus-map.js', () => ({
  imageSize: [1000, 1000],
  // 100~900 的正方形边界：取景断言可以手算
  bounds: [[100, 100], [900, 100], [900, 900], [100, 900]],
  buildings: [{ name: '综合楼', p: [[400, 400], [600, 400], [600, 600], [400, 600]] }],
  sports: [],
  roads: [],
  greens: []
}), { virtual: true });

let def;

/** 最小可用的 2D ctx：记录调用与颜色赋值，供断言 */
function makeCtx() {
  const ctx = {};
  ['clearRect', 'fillRect', 'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
    'closePath', 'fill', 'stroke', 'arc', 'arcTo', 'setLineDash', 'fillText'
  ].forEach((k) => { ctx[k] = jest.fn(); });
  ctx.createRadialGradient = jest.fn(() => ({ addColorStop: jest.fn() }));
  ctx.measureText = jest.fn((t) => ({ width: String(t).length * 6 }));
  // fill/stroke 的调用记录看不出颜色，总轨迹模式要按猫断色 → 记录属性赋值
  const styles = { fill: [], stroke: [] };
  Object.defineProperty(ctx, 'fillStyle', {
    set: (v) => { styles.fill.push(v); },
    get: () => styles.fill[styles.fill.length - 1]
  });
  Object.defineProperty(ctx, 'strokeStyle', {
    set: (v) => { styles.stroke.push(v); },
    get: () => styles.stroke[styles.stroke.length - 1]
  });
  ctx.__styles = styles;
  return ctx;
}

/** 造一个已就绪的组件实例（画布与底图由各用例自己塞） */
function createInstance() {
  const instance = {
    data: {
      points: [], clusters: [], lastPoint: null, highlight: -1,
      tracks: [], focusId: '', zoomable: false,
      ready: true, loadError: false, zoomed: false
    },
    setData: jest.fn(function (updates) { Object.assign(this.data, updates); }),
    triggerEvent: jest.fn(),
    createSelectorQuery: jest.fn()
  };
  for (const [key, fn] of Object.entries(def.methods || {})) {
    instance[key] = typeof fn === 'function' ? fn.bind(instance) : fn;
  }
  instance._init = true;
  instance._theme = 'light';
  instance._labels = [];
  instance._cw = 400;
  instance._ch = 400;
  instance._view = { k: 0.4, x: 0, y: 0 };
  instance._fitK = 0.4;
  instance._fitX = 0;
  instance._fitY = 0;
  instance._gesture = null;
  instance._rect = { left: 0, top: 0 };
  instance._map = {
    W: 1000, H: 1000, bounds: null, sports: [], buildings: [], roads: [], greens: []
  };
  instance._ctx = makeCtx();
  instance._canvas = {};
  return instance;
}

/** 铺一帧数据并整帧重画，返回 ctx 与点位/圈半径的调用记录 */
function paint(opts = {}) {
  const inst = createInstance();
  inst._paint = inst._paint.bind(inst);
  inst.data.points = opts.points || [];
  inst.data.clusters = opts.clusters || [];
  inst.data.lastPoint = opts.lastPoint === undefined ? null : opts.lastPoint;
  inst.data.highlight = opts.highlight === undefined ? -1 : opts.highlight;
  inst.data.tracks = opts.tracks || [];
  inst.data.focusId = opts.focusId || '';
  if (opts.map) inst._map = opts.map;
  if (opts.bounds) inst._map.bounds = opts.bounds;
  inst._paint();
  return inst;
}

/** 北京时间某刻 → 时间戳 */
function beijingTs(y, m, d, h, min = 0) {
  return Date.UTC(y, m - 1, d, h - 8, min);
}

beforeAll(() => {
  require('../../pages/admin/components/activity-map/activity-map.js');
  def = global.Component.mock.calls[global.Component.mock.calls.length - 1][0];
});

beforeEach(() => {
  global.Component.mockClear();
});

describe('pages/admin/components/activity-map', () => {
  test('_loadMap：底图多边形转成归一化 uv，并置 ready', () => {
    const inst = createInstance();
    inst.data.ready = false;
    inst._loadMap();

    expect(inst.data.ready).toBe(true);
    expect(inst.data.loadError).toBe(false);
    expect(inst._map.W).toBe(1000);
    expect(inst._map.H).toBe(1000);
    expect(inst._map.buildings).toHaveLength(1);
    expect(inst._map.buildings[0].name).toBe('综合楼');
    // [400,400] 像素 → [0.4, 0.4]
    expect(inst._map.buildings[0].uv[0]).toEqual([0.4, 0.4]);
    expect(inst._map.bounds.uv).toHaveLength(4);
  });

  test('_fit：按校园边界适配并居中（边界外留白对称）', () => {
    const inst = createInstance();
    inst._loadMap();
    inst._cw = 400;
    inst._ch = 400;
    inst._view = { k: 1, x: 0, y: 0 };
    inst._fit();

    // 边界 100~900 → 800 边长，画布短边 400 减 14×2 的 padding
    const k = (400 - 28) / 800;
    expect(inst._view.k).toBeCloseTo(k, 10);
    // 校园中心 (0.5, 0.5) 落在画布正中
    const s = inst._toScreen(0.5, 0.5);
    expect(s.x).toBeCloseTo(200, 6);
    expect(s.y).toBeCloseTo(200, 6);
    // 边界左上角正好落在 padding 上，不越界
    const tl = inst._toScreen(0.1, 0.1);
    expect(tl.x).toBeCloseTo(14, 6);
    expect(tl.y).toBeCloseTo(14, 6);
  });

  describe('_segments 连线规则', () => {
    const seg = (points) => createInstance()._segments(points);

    test('同一天内间隔 ≤6h 的相邻两点连线', () => {
      const a = { u: 0.1, v: 0.1, t: beijingTs(2026, 6, 1, 8) };
      const b = { u: 0.2, v: 0.2, t: beijingTs(2026, 6, 1, 13) }; // 5h 后
      expect(seg([a, b])).toHaveLength(1);
    });

    test('间隔超过 6h 不连（早上七点与晚上十一点不是一次连续行动）', () => {
      const a = { u: 0.1, v: 0.1, t: beijingTs(2026, 6, 1, 7) };
      const b = { u: 0.2, v: 0.2, t: beijingTs(2026, 6, 1, 23) };
      expect(seg([a, b])).toHaveLength(0);
    });

    test('跨天不连：哪怕只隔 2 小时（今天 23:00 → 明天 01:00）', () => {
      const a = { u: 0.1, v: 0.1, t: new Date(2026, 5, 1, 23, 0).getTime() };
      const b = { u: 0.2, v: 0.2, t: new Date(2026, 5, 2, 1, 0).getTime() };
      expect(seg([a, b])).toHaveLength(0);
    });

    test('时间倒序 / 同刻不连（gap<=0 直接跳过，不画零长度线）', () => {
      const t = beijingTs(2026, 6, 1, 9);
      expect(seg([{ u: 0.1, v: 0.1, t }, { u: 0.2, v: 0.2, t }])).toHaveLength(0);
      expect(seg([{ u: 0.2, v: 0.2, t }, { u: 0.1, v: 0.1, t: t - 3600000 }])).toHaveLength(0);
    });

    test('只连相邻两点：中间隔了一个不同天的点时，前后不跨连', () => {
      const a = { u: 0.1, v: 0.1, t: beijingTs(2026, 6, 1, 8) };
      const b = { u: 0.5, v: 0.5, t: beijingTs(2026, 6, 5, 8) }; // 跨天，断开
      const c = { u: 0.9, v: 0.9, t: beijingTs(2026, 6, 5, 10) };
      const pairs = seg([a, b, c]);
      expect(pairs).toHaveLength(1);
      expect(pairs[0][0]).toBe(b);
      expect(pairs[0][1]).toBe(c);
    });
  });

  describe('_paint 画序与点型', () => {
    test('越新的点半径越大（新旧渐变），最近一次单独画并带文字标签', () => {
      const oldP = { u: 0.2, v: 0.2, t: beijingTs(2026, 6, 1, 8) };
      const newP = { u: 0.6, v: 0.6, t: beijingTs(2026, 6, 10, 8) };
      const inst = paint({ points: [oldP, newP], lastPoint: newP });

      const arcs = inst._ctx.arc.mock.calls;
      const rOld = arcs[0][2];
      const rNew = arcs[1][2];
      expect(rNew).toBeGreaterThan(rOld);

      // 最近一次：半径 6.5 的实心圈 + 「最近一次」标签
      expect(arcs.some((c) => c[2] === 6.5)).toBe(true);
      const labels = inst._ctx.fillText.mock.calls.map((c) => c[0]);
      expect(labels).toContain('最近一次');
    });

    test('高亮第 N 个点：多画一圈高亮描边（时间线点选）', () => {
      const pts = [
        { u: 0.2, v: 0.2, t: beijingTs(2026, 6, 1, 8) },
        { u: 0.4, v: 0.4, t: beijingTs(2026, 6, 2, 8) },
        { u: 0.6, v: 0.6, t: beijingTs(2026, 6, 3, 8) }
      ];
      const plain = paint({ points: pts });
      const hl = paint({ points: pts, highlight: 1 });
      // 每个点一个 arc，被选中的那个多一个高亮圈
      expect(hl._ctx.arc.mock.calls.length).toBe(plain._ctx.arc.mock.calls.length + 1);
      // 高亮圈画在被选中点的位置上
      const s = hl._toScreen(0.4, 0.4);
      expect(hl._ctx.arc.mock.calls.some((c) => c[0] === s.x && c[1] === s.y && c[2] > 4.5)).toBe(true);
    });

    test('脏点位（u/v 非数）不进画布；lastPoint 非法时不画', () => {
      const inst = paint({
        points: [
          { u: 0.2, v: 0.2, t: 1 },
          { u: NaN, v: 0.3, t: 2 },
          null,
          { u: 0.4, v: undefined, t: 3 }
        ],
        lastPoint: { u: NaN, v: 0.5, t: 9 }
      });
      expect(inst._ctx.arc).toHaveBeenCalledTimes(1);
      expect(inst._ctx.fillText).not.toHaveBeenCalled();
    });

    test('聚集圈画在点位之前，并带「地名 · N 次」标签', () => {
      const inst = paint({
        points: [{ u: 0.5, v: 0.5, t: beijingTs(2026, 6, 1, 8) }],
        clusters: [{ u: 0.5, v: 0.5, count: 4, label: '食堂' }],
        lastPoint: null
      });
      const labels = inst._ctx.fillText.mock.calls.map((c) => c[0]);
      expect(labels).toContain('4');
      expect(labels).toContain('食堂 · 4 次');
      // 圈是虚线圈
      expect(inst._ctx.setLineDash).toHaveBeenCalledWith([5, 4]);
    });

    test('还没拿到画布时 draw 直接返回（不排队、不重画）', () => {
      jest.useFakeTimers();
      try {
        const inst = createInstance();
        inst._init = false;
        inst._paint = jest.fn();
        inst.draw();
        expect(inst._raf).toBeFalsy();
        jest.advanceTimersByTime(20);
        expect(inst._paint).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('draw 合并同一帧的多次触发，只重画一次', () => {
      jest.useFakeTimers();
      try {
        const inst = createInstance();
        inst._paint = jest.fn();
        inst.draw();
        inst.draw();
        expect(inst._raf).toBeTruthy();
        jest.advanceTimersByTime(20);
        expect(inst._paint).toHaveBeenCalledTimes(1);
        expect(inst._raf).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('总轨迹（tracks）多猫模式', () => {
    const t0 = beijingTs(2026, 6, 1, 8);

    function track(id, name, color, pts) {
      return { id, name, color, points: pts };
    }

    test('每只猫按自己的颜色画点与线；误传的单猫道具不出现', () => {
      const inst = paint({
        tracks: [
          track('a', '大橘', '#111111', [
            { u: 0.2, v: 0.2, t: t0 },
            { u: 0.3, v: 0.25, t: t0 + 3600000 }
          ]),
          track('b', '小白', '#222222', [{ u: 0.7, v: 0.7, t: t0 }])
        ],
        // 单猫道具即使被误传，总轨迹模式也不画它们（两种画法互斥）
        points: [{ u: 0.5, v: 0.5, t: t0 }],
        clusters: [{ u: 0.5, v: 0.5, count: 9, label: '食堂' }],
        lastPoint: { u: 0.5, v: 0.5, t: t0 },
        highlight: 0
      });

      const strokes = inst._ctx.__styles.stroke.join(' ');
      const fills = inst._ctx.__styles.fill.join(' ');
      expect(strokes).toContain('rgba(17,17,17');
      expect(strokes).toContain('rgba(34,34,34');
      expect(fills).toContain('rgba(17,17,17');
      expect(fills).toContain('rgba(34,34,34');

      const labels = inst._ctx.fillText.mock.calls.map((c) => c[0]);
      expect(labels).not.toContain('最近一次');
      expect(labels).not.toContain('食堂 · 9 次');
      // 聚集圈的虚线圈样式（[5,4]）不应该出现；总轨迹连线是 [4,4]
      expect(inst._ctx.setLineDash).not.toHaveBeenCalledWith([5, 4]);
    });

    test('聚焦：其余线路压暗、聚焦者加亮并标名字', () => {
      const inst = paint({
        tracks: [
          track('a', '大橘', '#111111', [
            { u: 0.2, v: 0.2, t: t0 },
            { u: 0.3, v: 0.2, t: t0 + 3600000 }
          ]),
          track('b', '小白', '#222222', [{ u: 0.7, v: 0.7, t: t0 }])
        ],
        focusId: 'a'
      });

      const strokes = inst._ctx.__styles.stroke.join(' ');
      const fills = inst._ctx.__styles.fill.join(' ');
      expect(strokes).toContain('rgba(17,17,17,0.85)');
      expect(strokes).toContain('rgba(34,34,34,0.08)');
      expect(fills).toContain('rgba(17,17,17,0.95)');
      expect(fills).toContain('rgba(34,34,34,0.1)');

      const labels = inst._ctx.fillText.mock.calls.map((c) => c[0]);
      expect(labels).toContain('大橘');
      expect(labels).not.toContain('小白');
    });

    test('脏点位被逐猫过滤；空 tracks 回退单猫画法', () => {
      const inst = paint({
        tracks: [
          track('a', '大橘', '#111111', [
            { u: NaN, v: 0.2, t: t0 },
            { u: 0.3, v: 0.3, t: t0 + 60000 }
          ]),
          track('empty', '空', '#222222', [])
        ]
      });
      expect(inst._ctx.arc).toHaveBeenCalledTimes(1);

      const single = paint({
        tracks: [],
        points: [{ u: 0.2, v: 0.2, t: t0 }, { u: 0.4, v: 0.4, t: t0 + 86400000 }]
      });
      expect(single._ctx.arc).toHaveBeenCalledTimes(2);
    });
  });

  describe('缩放手势（zoomable：总轨迹页）', () => {
    /** 打开缩放的实例：draw 打桩；clamp 默认也打桩，锚点/跟手断言不被边界干扰 */
    function zoomable() {
      const c = createInstance();
      c.data.zoomable = true;
      c.draw = jest.fn();
      c._clampView = jest.fn();
      return c;
    }

    /** 造一次双指触摸事件 */
    const pinch = (x1, y1, x2, y2) => ({ touches: [{ clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });

    test('zoomable=false（单猫模式）时触摸不改视图、不重画', () => {
      const c = createInstance();
      c.draw = jest.fn();
      c._clampView = jest.fn();

      c.onTouchStart(pinch(100, 200, 300, 200));
      c.onTouchMove(pinch(0, 200, 400, 200));
      c.onTouchEnd({ touches: [] });

      expect(c._gesture).toBeNull();
      expect(c._view).toEqual({ k: 0.4, x: 0, y: 0 });
      expect(c.draw).not.toHaveBeenCalled();
    });

    test('缩放以手指中点为锚：中点下的地图点缩放前后不动', () => {
      const c = zoomable();
      c.onTouchStart(pinch(100, 200, 300, 200));   // 中点 (200,200)，间距 200
      const midX = 200; const midY = 200;
      const anchorU = (midX - c._view.x) / (c._map.W * c._view.k);
      const anchorV = (midY - c._view.y) / (c._map.H * c._view.k);

      c.onTouchMove(pinch(0, 200, 400, 200));      // 张开到 400 → 2×

      expect(c._view.k).toBeCloseTo(0.8, 6);
      const nowU = (midX - c._view.x) / (c._map.W * c._view.k);
      const nowV = (midY - c._view.y) / (c._map.H * c._view.k);
      expect(nowU).toBeCloseTo(anchorU, 6);
      expect(nowV).toBeCloseTo(anchorV, 6);
    });

    /** 每帧必须在起始状态上绝对重算；在上帧结果上叠加会累积漂移、地图从手指底下滑走 */
    test('连发多次 move 不累积漂移', () => {
      const c = zoomable();
      c.onTouchStart(pinch(150, 200, 250, 200));   // 间距 100，中点 200
      const anchorU = (200 - c._view.x) / (c._map.W * c._view.k);

      for (let i = 1; i <= 20; i++) {
        const half = 50 + i * 5;
        c.onTouchMove(pinch(200 - half, 200, 200 + half, 200));
      }

      expect(c._view.k).toBeCloseTo(1.2, 5);       // 0.4 × (300 / 100)
      const nowU = (200 - c._view.x) / (c._map.W * c._view.k);
      expect(nowU).toBeCloseTo(anchorU, 5);
    });

    test('缩放夹在 [适配, 8×适配] 之间', () => {
      const c = zoomable();

      c.onTouchStart(pinch(150, 200, 250, 200));
      c.onTouchMove(pinch(-4500, 200, 5500, 200));  // 远超出上限
      expect(c._view.k).toBeCloseTo(3.2, 6);        // 0.4 × 8

      c.onTouchStart(pinch(150, 200, 250, 200));
      c.onTouchMove(pinch(199, 200, 201, 200));     // 收到极限以下 → 夹回适配值
      expect(c._view.k).toBeCloseTo(0.4, 6);
    });

    test('单指平移：地图走的距离等于手指走的距离', () => {
      const c = zoomable();
      c.onTouchStart({ touches: [{ clientX: 100, clientY: 100 }] });
      c.onTouchMove({ touches: [{ clientX: 180, clientY: 130 }] });

      expect(c._view.x).toBeCloseTo(80, 6);
      expect(c._view.y).toBeCloseTo(30, 6);
      expect(c.draw).toHaveBeenCalled();
    });

    /** 抬起一根就不接续平移的话，地图会「粘住」到全部松手 */
    test('捏合时抬起一根：剩下的手指立刻接续平移', () => {
      const c = zoomable();
      c.onTouchStart(pinch(100, 200, 300, 200));
      c.onTouchMove(pinch(50, 200, 350, 200));

      c.onTouchEnd({ touches: [{ clientX: 350, clientY: 200 }], changedTouches: [{ clientX: 50, clientY: 200 }] });
      expect(c._gesture).toBeTruthy();
      expect(c._gesture.mode).toBe('pan');

      const before = c._view.x;
      c.onTouchMove({ touches: [{ clientX: 330, clientY: 200 }] });
      expect(c._view.x).not.toBe(before);
    });

    /** _view 是画布坐标系：直接用 client 当本地坐标，锚点会偏掉画布在屏幕里的位置 */
    test('锚点换算到画布本地坐标（client 减 rect）', () => {
      const c = zoomable();
      c._rect = { left: 30, top: 40 };
      const g = c._pinchState([{ clientX: 130, clientY: 240 }, { clientX: 230, clientY: 240 }]);

      expect(g.midX).toBeCloseTo(150, 6);   // (100 + 200) / 2
      expect(g.midY).toBeCloseTo(200, 6);   // (200 + 200) / 2
      expect(g.dist).toBeCloseTo(100, 6);
    });

    test('手势结束后同步「回到全图」显隐；onResetView 还给适配位', () => {
      const c = zoomable();
      c.onTouchStart(pinch(100, 200, 300, 200));
      c.onTouchMove(pinch(0, 200, 400, 200));
      c.onTouchEnd({ touches: [] });
      expect(c.data.zoomed).toBe(true);

      c.onResetView();
      expect(c.data.zoomed).toBe(false);
      expect(c._view).toEqual({ k: 0.4, x: 0, y: 0 });
      expect(c.draw).toHaveBeenCalled();
    });

    test('视图约束：内容大于画布时夹在边界内；小于画布时锁死居中', () => {
      const c = createInstance();
      c._map.bounds = { uv: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] };

      // k=1：边界 100~900，画布 400 → 平移区间 [-500, -100]
      c._view = { k: 1, x: 9999, y: 9999 };
      c._clampView();
      expect(c._view.x).toBeCloseTo(-100, 6);
      expect(c._view.y).toBeCloseTo(-100, 6);

      c._view = { k: 1, x: -9999, y: -9999 };
      c._clampView();
      expect(c._view.x).toBeCloseTo(-500, 6);
      expect(c._view.y).toBeCloseTo(-500, 6);

      // k=0.4：内容 320 < 画布 400 → 任何越界平移都锁死居中（= 适配位）
      c._view = { k: 0.4, x: 123, y: -45 };
      c._clampView();
      expect(c._view.x).toBeCloseTo(0, 6);
      expect(c._view.y).toBeCloseTo(0, 6);
    });
  });

  describe('WXML 契约（手势层只在 zoomable 时渲染）', () => {
    const fs = require('fs');
    const path = require('path');
    const wxml = fs.readFileSync(path.resolve(__dirname, '../../pages/admin/components/activity-map/activity-map.wxml'), 'utf8');

    test('手势层 wx:if=zoomable 且 catch 掉 touchmove（拖图不滚页）', () => {
      // 单猫详情页把这张图夹在卡片流里：手势层无条件渲染会吞掉页面滚动
      expect(wxml).toMatch(/<view[\s\S]*?wx:if="\{\{zoomable\}\}"[\s\S]*?catchtouchmove="onTouchMove"/);
      expect(wxml).toContain('catchtouchstart="onTouchStart"');
      expect(wxml).toContain('catchtouchend="onTouchEnd"');
    });

    test('「回到全图」只在 zoomable 且已偏离适配位时出现，点击走 onResetView', () => {
      expect(wxml).toMatch(/wx:if="\{\{zoomable && zoomed\}\}"/);
      expect(wxml).toContain('bindtap="onResetView"');
    });
  });
});

/**
 * 校区：分析图也按校区取底图。东区的点画在本部图上不会报错，
 * 但位置全错 —— 这是「只在超管页出现」的那类错，必须锁住。
 */
describe('pages/admin/components/activity-map · 校区底图', () => {
  test('zone=东区：载入东区底图', () => {
    const inst = createInstance();
    inst.data.zone = '东区';
    inst._loadMap();

    expect(inst._map).toBeTruthy();
    expect(inst._map.buildings.length).toBeGreaterThan(0);
    expect(inst.data.ready).toBe(true);
    expect(inst.data.loadError).toBe(false);
  });

  test('没画底图的校区：不画（不回退本部）', () => {
    const inst = createInstance();
    inst.data.zone = '南区';
    inst._loadMap();

    expect(inst._map).toBeNull();
    expect(inst.data.ready).toBe(true);
    expect(inst.data.loadError).toBe(false);
  });
});
