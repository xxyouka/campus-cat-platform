/**
 * subpackages/map/components/campus-map —— 手势与「地点名」推断
 *
 * 两块逻辑都是「错了不会报错、只会手感不对」的那种，必须有测试锁住：
 *
 *   1. 捏合缩放。起点存不全 → 每帧在上一帧结果上叠加 → 地图从手指底下滑走；
 *      中点位移被算两遍 → 双指平移速度翻倍。两种都是肉眼能感觉、代码看不出。
 *   2. 针落在空地上时的地名。不能显示「校内空地」，要退化成「最近的楼 + 旁」。
 */
jest.mock('../../images/campus-map/campus-map.js', () => ({ imageSize: [1000, 1000] }), { virtual: true });

let def;

/** 造一个够用的组件实例：不带真实地图数据，_map 由各用例自己塞 */
function createInstance() {
  const instance = {
    data: JSON.parse(JSON.stringify(def.data || {})),
    setData: jest.fn(function (updates) { Object.assign(this.data, updates); }),
    triggerEvent: jest.fn()
  };
  if (def.properties) {
    for (const [key, prop] of Object.entries(def.properties)) {
      instance.data[key] = prop.value;
    }
  }
  for (const [key, fn] of Object.entries(def.methods || {})) {
    instance[key] = typeof fn === 'function' ? fn.bind(instance) : fn;
  }
  // 画布与地图：手感和地名计算都依赖这些
  instance._init = true;
  instance._cw = 400;
  instance._ch = 600;
  instance._fitK = 0.25;
  instance._view = { k: 0.25, x: 0, y: 0 };
  instance.draw = jest.fn();
  instance._clamp = jest.fn();     // 单独测，别让 4 条边限制干扰锚点断言
  instance._map = { W: 1000, H: 1000, bounds: null, pois: [], buildings: [], sports: [], roads: [], greens: [] };
  return instance;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  require('../../subpackages/map/components/campus-map/campus-map');
  def = global.Component.mock.calls[0][0];
});

describe('campus-map 组件 · 捏合缩放', () => {
  /** 造一次双指触摸事件 */
  const pinch = (x1, y1, x2, y2) => ({ touches: [{ clientX: x1, clientY: y1 }, { clientX: x2, clientY: y2 }] });

  test('缩放时手指中点下方的地图点保持不动（这才是「以手指为锚点」）', () => {
    const c = createInstance();
    c._view = { k: 0.25, x: 0, y: 0 };

    // 起始：双指张开 100px，中点 (200, 300)
    c.onTouchStart(pinch(150, 300, 250, 300));
    const midX = 200, midY = 300;
    const anchorU = (midX - c._view.x) / (c._map.W * c._view.k);
    const anchorV = (midY - c._view.y) / (c._map.H * c._view.k);

    // 张开到 200px（放大 2 倍）
    c.onTouchMove(pinch(100, 300, 300, 300));

    expect(c._view.k).toBeCloseTo(0.5, 6);
    // 同一个地图点，现在应该仍在当前中点 (200,300) 下方
    const nowU = (midX - c._view.x) / (c._map.W * c._view.k);
    const nowV = (midY - c._view.y) / (c._map.H * c._view.k);
    expect(nowU).toBeCloseTo(anchorU, 6);
    expect(nowV).toBeCloseTo(anchorV, 6);
  });

  /**
   * 旧实现每帧读已经改过的 this._view.x，误差逐帧累积 ——
   * 连发多次 move（真实触摸就是连发）之后地图会明显漂移。
   */
  test('连发多次 move 不累积漂移', () => {
    const c = createInstance();
    c._view = { k: 0.25, x: 0, y: 0 };
    c.onTouchStart(pinch(150, 300, 250, 300));

    const midX = 200, midY = 300;
    const anchorU = (midX - c._view.x) / (c._map.W * c._view.k);

    // 模拟一次连续的手势：20 个中间帧，距离逐渐张开
    for (let i = 1; i <= 20; i++) {
      const half = 50 + i * 5;
      c.onTouchMove(pinch(midX - half, midY, midX + half, midY));
    }

    expect(c._view.k).toBeCloseTo(0.25 * (150 / 50), 5);
    const nowU = (midX - c._view.x) / (c._map.W * c._view.k);
    expect(nowU).toBeCloseTo(anchorU, 5);
  });

  /** 旧实现把中点位移算了两遍，双指平移会走两倍距离 */
  test('双指平移：地图走的距离等于手指走的距离，不是两倍', () => {
    const c = createInstance();
    c._view = { k: 0.25, x: 0, y: 0 };

    // 手指间距不变（纯平移），中点右移 100
    c.onTouchStart(pinch(150, 300, 250, 300));
    c.onTouchMove(pinch(250, 300, 350, 300));

    expect(c._view.k).toBeCloseTo(0.25, 6);   // 没有缩放
    expect(c._view.x).toBeCloseTo(100, 6);    // 恰好跟着手指走 100，不是 200
  });

  test('缩放被夹在 min/max 之间', () => {
    const c = createInstance();
    c._minScale = () => 0.2;
    c._maxScale = () => 1;

    // 起始间距 100，一次张开到 10000 → 远超上限
    c.onTouchStart(pinch(150, 300, 250, 300));
    c.onTouchMove(pinch(-4500, 300, 5500, 300));
    expect(c._view.k).toBe(1);

    // 收到极限以下 → 夹在下限
    c.onTouchStart(pinch(150, 300, 250, 300));
    c.onTouchMove(pinch(199, 300, 201, 300));
    expect(c._view.k).toBe(0.2);
  });

  /** 捏合中途抬起一根手指，剩下一根要继续能拖动，不能「粘住」 */
  test('捏合时抬起一根：剩下的手指立刻接续平移', () => {
    const c = createInstance();
    c.onTouchStart(pinch(100, 300, 300, 300));
    c.onTouchMove(pinch(50, 300, 350, 300));

    // 抬起左边那根
    c.onTouchEnd({ touches: [{ clientX: 350, clientY: 300 }], changedTouches: [{ clientX: 100, clientY: 300 }] });
    expect(c._gesture).toBeTruthy();
    expect(c._gesture.mode).toBe('pan');

    // 剩下那根继续拖，地图要跟着动
    const before = c._view.x;
    c.onTouchMove({ touches: [{ clientX: 300, clientY: 300 }] });
    expect(c._view.x).not.toBe(before);
  });

  test('捏合松手不该被当成点击选点', () => {
    const c = createInstance();
    c.data.mode = 'select';
    c.data.crosshair = false;
    c._hitTest = jest.fn(() => ({ type: 'campus' }));

    c.onTouchStart(pinch(100, 300, 300, 300));
    c.onTouchMove(pinch(50, 300, 350, 300));
    c.onTouchEnd({ touches: [], changedTouches: [{ clientX: 350, clientY: 300 }] });

    expect(c.triggerEvent).not.toHaveBeenCalledWith('pick', expect.anything());
  });
});

describe('campus-map 组件 · 针落在空地上的地名', () => {
  /** 一个 1000x1000 的假底图，两栋楼 + 一个 POI */
  function withMap(instance) {
    instance._map = Object.assign(instance._map, {
      bounds: { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      buildings: [
        { name: '图书馆', bbox: { x0: 0.10, y0: 0.10, x1: 0.20, y1: 0.20 }, uv: [] },
        { name: '食堂', bbox: { x0: 0.60, y0: 0.60, x1: 0.70, y1: 0.70 }, uv: [] }
      ],
      sports: [],
      pois: []
    });
    instance._labelOrder = instance._map.buildings;
    return instance;
  }

  test('空地上取最近的楼，加「旁」', () => {
    const c = withMap(createInstance());
    // 紧挨图书馆右下角
    expect(c._besideLabel(0.22, 0.22)).toBe('图书馆旁');
    // 紧挨食堂左上角
    expect(c._besideLabel(0.58, 0.58)).toBe('食堂旁');
  });

  /**
   * uv 两轴分母不同时，直接在 uv 空间算欧氏距离会选错楼。
   * 这里让两栋楼在 uv 上看起来一样远，但像素距离不同。
   */
  test('距离按像素算，不受 uv 两轴比例影响', () => {
    const c = createInstance();
    c._map.W = 2000;    // 横向拉长一倍
    c._map.H = 1000;
    c._map.buildings = [
      { name: '横向远', bbox: { x0: 0.50, y0: 0.50, x1: 0.60, y1: 0.60 }, uv: [] },
      { name: '纵向近', bbox: { x0: 0.50, y0: 0.42, x1: 0.60, y1: 0.48 }, uv: [] }
    ];
    c._map.pois = [];
    c._labelOrder = c._map.buildings;

    // 点 (0.5, 0.485)：到「纵向近」像素距离 0；到「横向远」…
    // 用一个明确偏向纵向近的位置，确认没有被 uv 均一化骗到
    expect(c._besideLabel(0.5, 0.485)).toBe('纵向近旁');
  });

  test('POI 也参与最近判定', () => {
    const c = withMap(createInstance());
    c._map.pois = [{ name: '校门', u: 0.5, v: 0.5 }];
    c._labelOrder = [];
    expect(c._besideLabel(0.505, 0.5)).toBe('校门旁');
  });

  test('一个有名地物都没有时返回空串（调用方回落到「校内空地」）', () => {
    const c = createInstance();
    c._labelOrder = [];
    expect(c._besideLabel(0.5, 0.5)).toBe('');
  });

  test('空地地名按距离分档：紧邻「旁」、隔一段带方位「X侧」、远「附近」', () => {
    const c = withMap(createInstance());
    // 图书馆 bbox 0.10~0.20（1000px 底图即 100~200px）：
    // 正右侧 100px → 东侧；正上方 80px → 北侧；右下 100√2≈141px → 东南侧
    expect(c._besideLabel(0.30, 0.15)).toBe('图书馆东侧');
    expect(c._besideLabel(0.15, 0.02)).toBe('图书馆北侧');
    expect(c._besideLabel(0.30, 0.30)).toBe('图书馆东南侧');
    // (0.42, 0.42) 到食堂（0.60~0.70）距离 180√2≈255px → 附近
    expect(c._besideLabel(0.42, 0.42)).toBe('食堂附近');
  });

  test('方位以地物中心为参照（点在楼的哪一侧，就说哪一侧）', () => {
    const c = withMap(createInstance());
    // 图书馆中心 (0.15, 0.15)。点 (0.15, 0.30)：dx=0、dy=150px → 正南
    expect(c._besideLabel(0.15, 0.30)).toBe('图书馆南侧');
    // 点 (0.02, 0.15)：dx=-150px → 正西
    expect(c._besideLabel(0.02, 0.15)).toBe('图书馆西侧');
  });

  test('_labelForHit：压在校外返回空；压在建筑上直接用建筑名（不加「旁」）', () => {
    const c = withMap(createInstance());
    expect(c._labelForHit({ type: 'outside' }, 0.5, 0.5)).toBe('');
    expect(c._labelForHit({ type: 'buildings', data: { name: '图书馆' } }, 0.15, 0.15)).toBe('图书馆');
    expect(c._labelForHit({ type: 'campus' }, 0.22, 0.22)).toBe('图书馆旁');
  });

  test('没有名字的地物（如匿名绿地）退化成「最近的楼 + 旁」', () => {
    const c = withMap(createInstance());
    expect(c._labelForHit({ type: 'greens', data: {} }, 0.22, 0.22)).toBe('图书馆旁');
  });
});

describe('campus-map 组件 · 默认落点（进入选点页时对准哪儿）', () => {
  /** 一个 1000x1000 的假底图：校园铺满，中间一栋「综合楼」，四周留空地 */
  function withSquare(instance) {
    const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const zong = {
      name: '综合楼',
      bbox: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 },
      uv: square(0.4, 0.4, 0.6, 0.6)
    };
    instance._map = Object.assign(instance._map, {
      W: 1000, H: 1000,
      bounds: { uv: square(0.05, 0.05, 0.95, 0.95) },
      buildings: [zong],
      sports: [], roads: [], greens: [], pois: []
    });
    instance._labelOrder = [zong];
    return instance;
  }

  /** 视图正中对应的归一化坐标 */
  const centerUV = c => ({
    u: (c._cw / 2 - c._view.x) / (c._map.W * c._view.k),
    v: (c._ch / 2 - c._view.y) / (c._map.H * c._view.k)
  });

  test('对准「综合楼」后，视图正中确实落在它旁边的空地上', () => {
    const c = withSquare(createInstance());
    expect(c.focusBeside('综合楼')).toBe(true);

    const { u, v } = centerUV(c);
    // 不能压在楼里 —— 压在楼里的标注会是「综合楼」，而相遇点基本都在楼外
    expect(pointInPolyFor(c, u, v)).toBe(false);
    // 最近的有名地物必须是它，这样标注才保证是「综合楼旁」
    expect(c._nearestName(u, v)).toBe('综合楼');
    expect(c._besideLabel(u, v)).toBe('综合楼旁');
  });

  test('对准后会放大，不是停在全图比例', () => {
    const c = withSquare(createInstance());
    const fitK = c._fitK;
    c.focusBeside('综合楼');
    expect(c._view.k).toBeGreaterThan(fitK);
  });

  test('组件没就绪时返回 false（调用方据此退避重试，不该抛）', () => {
    const c = withSquare(createInstance());
    c._init = false;
    expect(c.focusBeside('综合楼')).toBe(false);
  });

  test('底图里没有这个地物时返回 false，不抛', () => {
    const c = withSquare(createInstance());
    expect(c.focusBeside('不存在的楼')).toBe(false);
  });

  test('外侧没有任何空地时返回 false，而不是硬塞一个压线点', () => {
    const c = createInstance();
    // 楼铺满整张图：任何候选点要么在楼里、要么越界，没有「旁边」可言
    c._map = Object.assign(c._map, {
      bounds: { uv: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]] },
      buildings: [{
        name: '巨楼',
        bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
        uv: [[0, 0], [1, 0], [1, 1], [0, 1]]
      }],
      sports: [], roads: [], greens: [], pois: []
    });
    c._labelOrder = c._map.buildings;
    expect(c.focusBeside('巨楼')).toBe(false);
  });

  test('_isBesideCandidate：校外的点一律不合格', () => {
    const c = withSquare(createInstance());
    expect(c._isBesideCandidate(0.001, 0.5, '综合楼')).toBe(false);
    expect(c._isBesideCandidate(0.999, 0.5, '综合楼')).toBe(false);
  });

  test('_isBesideCandidate：压在楼里的点不合格', () => {
    const c = withSquare(createInstance());
    expect(c._isBesideCandidate(0.5, 0.5, '综合楼')).toBe(false);
  });
});

describe('campus-map 组件 · 猫针聚合', () => {
  /** 造一批屏幕距离可控的猫 */
  function withMarks(instance, positions) {
    instance.data.marks = positions.map((p, i) => ({
      id: 'cat' + i, name: '猫' + i, u: p[0], v: p[1], status: 'normal'
    }));
    return instance;
  }

  test('挨在一起的猫被聚成一坨，散开的不受影响', () => {
    const c = createInstance();
    // 图 1000x1000、k=0.25、x=y=0 → 1px 屏幕 = 0.004 uv
    // 前两只相距 0.008 uv ≈ 2px（同一坨），第三只远在天边
    withMarks(c, [[0.10, 0.10], [0.108, 0.10], [0.80, 0.80]]);

    const groups = c._clusterMarks();

    expect(groups).toHaveLength(2);
    expect(groups[0].marks).toHaveLength(2);
    expect(groups[1].marks).toHaveLength(1);
  });

  test('刚好超过阈值的不合并（阈值是 34px）', () => {
    const c = createInstance();
    // 0.14 uv = 35px > 34 → 不合并
    withMarks(c, [[0.10, 0.10], [0.24, 0.10]]);
    expect(c._clusterMarks()).toHaveLength(2);

    // 0.13 uv = 32.5px < 34 → 合并
    withMarks(c, [[0.10, 0.10], [0.23, 0.10]]);
    expect(c._clusterMarks()).toHaveLength(1);
  });

  /** 重心会随加入顺序漂移 → 同样的数据可能分组不同，那种不确定性很难查 */
  test('分组与猫的先后顺序无关', () => {
    const a = createInstance();
    const b = createInstance();
    const pts = [[0.10, 0.10], [0.108, 0.10], [0.116, 0.10]];
    withMarks(a, pts);
    withMarks(b, pts.slice().reverse());

    const ga = a._clusterMarks().map(g => g.marks.length).sort();
    const gb = b._clusterMarks().map(g => g.marks.length).sort();
    expect(ga).toEqual(gb);
  });

  test('缺坐标的猫直接跳过，不产生空组', () => {
    const c = createInstance();
    c.data.marks = [
      { id: 'a', u: 0.1, v: 0.1 },
      { id: 'b', u: null, v: 0.2 },
      { id: 'c', v: 0.2 }
    ];
    const groups = c._clusterMarks();
    expect(groups).toHaveLength(1);
    expect(groups[0].marks).toHaveLength(1);
  });

  test('点到一坨返回整坨的 id 列表，而不是其中一只', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.108, 0.10]]);
    c._clusterMarks();

    // k=0.25、W=1000 → u=0.10 对应屏幕 x = 25
    const hit = c._hitTest(25, 25);
    expect(hit.type).toBe('cluster');
    expect(hit.ids).toEqual(['cat0', 'cat1']);
  });

  test('点到单只仍返回 mark', () => {
    const c = createInstance();
    withMarks(c, [[0.80, 0.80]]);
    c._clusterMarks();

    const hit = c._hitTest(200, 200);
    expect(hit.type).toBe('mark');
    expect(hit.id).toBe('cat0');
  });

  test('放大会把一坨散开，且以这坨的重心为中心', () => {
    const c = createInstance();
    // 相距 0.10 uv：当前 k=0.25 下是 25px（< 34，算一坨），
    // 放大到最大倍率 2.0 则是 200px，确定拆得开
    withMarks(c, [[0.10, 0.10], [0.20, 0.10]]);
    c._clusterMarks();

    expect(c.clusterWillSplit(['cat0', 'cat1'])).toBe(true);
    expect(c.zoomOnCluster(['cat0', 'cat1'])).toBe(true);
    expect(c._view.k).toBeCloseTo(0.25 * 1.8, 5);
    // 重心 (0.15, 0.10) 应落在画布正中
    const s = c._toScreen(0.15, 0.10);
    expect(s.x).toBeCloseTo(c._cw / 2, 4);
    expect(s.y).toBeCloseTo(c._ch / 2, 4);
  });

  /**
   * 同一处打卡的几只猫：坐标一模一样，怎么放大都还是那个球。
   * 这种情况必须**不放大** —— 地图冲进去、针还是那一坨，纯属吓人，
   * 而且用户依然点不到第二只（页面只能改用「把这坨猫列出来」）。
   */
  test('同一坐标的几只猫：放大了也拆不开 → 拒绝放大，视图不动', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.10, 0.10], [0.10, 0.10]]);
    c._clusterMarks();
    const k0 = c._view.k, x0 = c._view.x, y0 = c._view.y;

    expect(c.clusterWillSplit(['cat0', 'cat1', 'cat2'])).toBe(false);
    expect(c.zoomOnCluster(['cat0', 'cat1', 'cat2'])).toBe(false);
    expect(c._view).toEqual({ k: k0, x: x0, y: y0 });
  });

  test('clusterWillSplit 的边界：一只、未知 id、空入参都不拆', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.20, 0.10]]);
    expect(c.clusterWillSplit(['cat0'])).toBe(false);       // 一只猫谈不上拆
    expect(c.clusterWillSplit(['nope'])).toBe(false);       // 对不上任何猫
    expect(c.clusterWillSplit([])).toBe(false);
    expect(c.clusterWillSplit(null)).toBe(false);
    // 只有一只对上（另一只坐标没了）也算不了拆
    expect(c.clusterWillSplit(['cat0', 'nope'])).toBe(false);
  });

  test('已经放到最大时返回 false（由页面决定要不要列名单）', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.20, 0.10]]);
    c._clusterMarks();
    c._view.k = c._maxScale();

    expect(c.zoomOnCluster(['cat0', 'cat1'])).toBe(false);
  });

  test('id 对不上任何猫时返回 false，不抛', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10]]);
    expect(c.zoomOnCluster(['nope'])).toBe(false);
    expect(c.zoomOnCluster([])).toBe(false);
    expect(c.zoomOnCluster(null)).toBe(false);
  });

  /** 聚合后要按「组」登记占位，否则被聚合掉的针会白占位置、把建筑名挤远 */
  test('占位按聚合结果登记，不是按原始猫数', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.108, 0.10], [0.80, 0.80]]);
    c._labels = [];
    c._clusterMarks();
    c._reserveMarks();

    expect(c._labels).toHaveLength(2);   // 2 组，不是 3 只
  });

  test('fitToMarks：把镜头聚焦到猫群所在区域并适度放大', () => {
    const c = createInstance();
    // 猫全部集中在左半区 (0.15~0.25)
    withMarks(c, [[0.15, 0.45], [0.25, 0.55]]);
    expect(c.fitToMarks()).toBe(true);
    expect(c._view.k).toBeGreaterThan(c._fitK);
    // 猫群中心 (0.20, 0.50) 应落在画布正中
    const s = c._toScreen(0.20, 0.50);
    expect(s.x).toBeCloseTo(c._cw / 2, 4);
    expect(s.y).toBeCloseTo(c._ch / 2, 4);
  });

  test('fitToMarks：没有猫或组件没就绪时返回 false', () => {
    const c = createInstance();
    expect(c.fitToMarks()).toBe(false);
    c._init = false;
    withMarks(c, [[0.2, 0.2]]);
    expect(c.fitToMarks()).toBe(false);
  });

  /**
   * 真实底图是 1580x840（约 1.9:1 横躺），画布却是竖的 ——
   * 按「装下猫群」这一条算完，上下必然各空一条，能占掉近一半画布。
   * fitToMarks 因此还多了一条「纵向撑满」的下限。
   */
  function withWideCampus(instance) {
    instance._map = Object.assign(instance._map, {
      W: 1580, H: 840,
      bounds: { uv: [[0, 0], [1, 0], [1, 1], [0, 1]], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }
    });
    return instance;
  }

  /**
   * 真机实测的画布比例（376×680 = 0.55），配套 1580×840 的底图（1.88）。
   * 「分轴取小」就是为这个比例设计的，所以用例必须用真实比例，通用桩的 400×600 测不出来。
   */
  function withDeviceCanvas() {
    const c = withWideCampus(createInstance());
    c._cw = 376;
    c._ch = 680;
    c._fit();          // 让 _fitK 与真实比例自洽，而不是沿用通用桩的 0.25
    return c;
  }

  const MARGIN = 22, V_PAD = 24;
  const kFillOf = (c) => (c._ch - V_PAD * 2) / c._map.H;
  const kCatsOf = (c, u0, u1) => (c._cw - MARGIN * 2) / ((u1 - u0) * c._map.W);

  /**
   * 真实线上分布：15 只猫挤在 u 0.12~0.41 / v 0.49~0.81（只占校园 0.29×0.33）。
   *
   * 这正是「分轴取小」要解决的场景：纵向撑满要 k≈0.752，横向装下 453px 宽的猫群
   * 只能到 k≈0.732。取小的 0.732 —— 校园纵向占画布 90%，15 只猫一只不裁。
   */
  test('fitToMarks：猫挤在校园一角 → 横向那条更紧，以横向为准（不裁猫优先）', () => {
    const c = withDeviceCanvas();
    withMarks(c, [[0.12, 0.49], [0.41, 0.81], [0.30, 0.60]]);
    c.fitToMarks();

    expect(kCatsOf(c, 0.12, 0.41)).toBeLessThan(kFillOf(c));      // 前提：横向确实是瓶颈
    expect(c._view.k).toBeCloseTo(kCatsOf(c, 0.12, 0.41), 6);
    // 横向：可视宽度盖得住猫群本体，且左右各留出边距
    const spanW = (0.41 - 0.12) * c._map.W;
    expect(c._cw / c._view.k).toBeGreaterThanOrEqual(spanW);
    // 纵向：校园仍占九成画面，不是原来那种「缩在中间一条」
    expect(c._map.H * c._view.k / c._ch).toBeGreaterThan(0.85);
    // 猫群中心落在画布正中
    expect(c._toScreen(0.265, 0.65).x).toBeCloseTo(c._cw / 2, 4);
  });

  test('fitToMarks：猫很集中 → 横向那条极宽，由纵向撑满接管', () => {
    const c = withDeviceCanvas();
    withMarks(c, [[0.30, 0.50], [0.31, 0.50]]);
    c.fitToMarks();

    expect(kFillOf(c)).toBeLessThan(kCatsOf(c, 0.30, 0.31));
    expect(c._view.k).toBeCloseTo(kFillOf(c), 6);
    // 校园高度正好撑满画布（留出 V_PAD）
    expect(c._map.H * c._view.k).toBeCloseTo(c._ch - V_PAD * 2, 0);
  });

  test('fitToMarks：猫铺满校园时不硬撑纵向，宁可上下留白也不裁猫', () => {
    const c = withDeviceCanvas();
    withMarks(c, [[0.05, 0.15], [0.95, 0.85]]);
    c.fitToMarks();

    // 横向那条变成瓶颈（猫占了校园 90% 宽），于是回落到接近全图，绝不硬撑纵向
    expect(kCatsOf(c, 0.05, 0.95)).toBeLessThan(kFillOf(c));
    expect(c._view.k).toBeCloseTo(kCatsOf(c, 0.05, 0.95), 6);
    expect(c._view.k).toBeLessThan(c._fitK * 1.2);
    // 代价就是上下留白回来了 —— 这是校园本身宽扁的事实
    expect(c._map.H * c._view.k / c._ch).toBeLessThan(0.5);
  });

  test('fitToMarks：倍率不低于全图适配，也不超过最大缩放', () => {
    const c = withDeviceCanvas();
    withMarks(c, [[0.30, 0.50], [0.31, 0.50]]);
    c.fitToMarks();
    expect(c._view.k).toBeGreaterThanOrEqual(c._fitK);
    expect(c._view.k).toBeLessThanOrEqual(c._maxScale());
  });

  test('_labelAt：贴边的标签不画（横向拖动时建筑名会被切成半截字）', () => {
    const c = withWideCampus(createInstance());
    c._ctx = makeCtx();
    c._labels = [];
    const T = { label: '#000', labelBg: '#fff', markRing: '#E8927C', labelBorder: 'rgba(0,0,0,.1)' };

    c._labelAt(0.5, 0.5, '中间那栋', T, 12);
    expect(c._labels).toHaveLength(1);

    // 右边缘：胶囊右沿超出画布 → 不画
    c._labelAt(0.5, 0.5, '园艺与食品学院', T, 12, c._cw - 20, 100);
    expect(c._labels).toHaveLength(1);
    // 上边缘同理
    c._labelAt(0.5, 0.5, '旧实训大楼', T, 12, 200, 1);
    expect(c._labels).toHaveLength(1);
  });

  test('_labelAt：选中猫的名字例外，贴边也照画（必须一眼认出选了谁）', () => {
    const c = withWideCampus(createInstance());
    c._ctx = makeCtx();
    c._labels = [];
    const T = { label: '#000', labelBg: '#fff', markRing: '#E8927C' };
    c._labelAt(0.5, 0.5, '蛋蛋', T, 12, c._cw - 6, 100, 'center', true);
    expect(c._labels).toHaveLength(1);
  });

  test('fitToMarks：猫铺得很开时仍然以猫群为准（不缩回全图，也不多余放大）', () => {
    const c = withWideCampus(createInstance());
    withMarks(c, [[0.08, 0.20], [0.92, 0.80]]);   // 从西南到东北各一只
    c.fitToMarks();
    // 两端都要看得见 → 倍率回落到全图适配附近
    expect(c._view.k).toBeLessThan(c._fitK * 1.5);
  });

  test('centerOnMark：点过「全图」再点猫，会拉回浏览页该用的倍率', () => {
    const c = withWideCampus(createInstance());
    withMarks(c, [[0.30, 0.50], [0.31, 0.50]]);
    c.fitToMarks();
    c.resetView();                       // 模拟用户按了「全图」
    expect(c._view.k).toBeCloseTo(c._fitK, 6);

    c.centerOnMark('cat0');
    expect(c._view.k).toBeCloseTo(c._fittedK, 6);
    const s = c._toScreen(0.30, 0.50);
    expect(s.x).toBeCloseTo(c._cw / 2, 4);
  });

  test('centerOnMark：用户已经放得更大时不许把它缩回去', () => {
    const c = createInstance();
    withMarks(c, [[0.20, 0.50], [0.30, 0.60]]);
    c._view.k = c._fitK * 5;
    c.centerOnMark('cat0');
    expect(c._view.k).toBeCloseTo(c._fitK * 5, 6);
  });

  test('centerOnMark：没跑过 fitToMarks 时退回全图倍率，不擅自放大', () => {
    const c = createInstance();
    withMarks(c, [[0.20, 0.50], [0.30, 0.60]]);
    expect(c._fittedK).toBeUndefined();
    c.centerOnMark('cat0');
    expect(c._view.k).toBeCloseTo(c._fitK, 6);
  });

  test('选中的猫自己独立成组，不被吞进聚合球（否则点中了反而看不见）', () => {
    const c = createInstance();
    withMarks(c, [[0.10, 0.10], [0.108, 0.10]]);
    c.data.activeId = 'cat1';
    const groups = c._clusterMarks();
    expect(groups).toHaveLength(2);
    // 选中的那只排最后 → 画在最上层，不会被另一坨盖住
    expect(groups[groups.length - 1].marks[0].id).toBe('cat1');
  });
});

describe('campus-map 组件 · 平移约束 _clamp', () => {
  /** 用真的 _clamp（createInstance 默认把它 mock 掉了，这里换回来） */
  function withRealClamp() {
    const c = createInstance();
    c._clamp = def.methods._clamp.bind(c);
    c._clampAxis = def.methods._clampAxis.bind(c);
    c._axisSlack = def.methods._axisSlack.bind(c);
    c._map = Object.assign(c._map, {
      W: 1000, H: 1000,
      bounds: { uv: [[0, 0], [1, 0], [1, 1], [0, 1]], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }
    });
    return c;
  }

  test('校园比画布小 → 拖不动，锁死居中（旁边不该露出一条校外底色）', () => {
    const c = withRealClamp();
    c._view = { k: 0.25, x: -300, y: -300 };   // 试图把校园拖到左上角
    c._clamp();
    // 内容 250x250 装进 400x600 → 两轴都居中
    expect(c._view.x).toBeCloseTo((400 - 250) / 2, 6);
    expect(c._view.y).toBeCloseTo((600 - 250) / 2, 6);
  });

  test('校园比画布大 → 平移范围是「边缘对齐边缘」，拖不出白边', () => {
    const c = withRealClamp();
    c._view = { k: 1, x: 0, y: 0 };              // 内容 1000x1000，画布 400x600
    c._view.x = 99999; c._view.y = 99999;         // 往右下死拖
    c._clamp();
    expect(c._view.x).toBeCloseTo(0, 6);          // 右边缘贴住画布右边缘
    expect(c._view.y).toBeCloseTo(0, 6);

    c._view.x = -99999; c._view.y = -99999;       // 往左上死拖
    c._clamp();
    expect(c._view.x).toBeCloseTo(400 - 1000, 6); // 左边缘贴住画布左边缘
    expect(c._view.y).toBeCloseTo(600 - 1000, 6);
  });

  test('病态平移量（捏合累积漂移那种）被夹回有限范围，不会把地图甩飞', () => {
    const c = withRealClamp();
    c._view = { k: 1, x: -1.53e14, y: -1.53e14 };
    c._clamp();
    expect(Number.isFinite(c._view.x)).toBe(true);
    expect(Number.isFinite(c._view.y)).toBe(true);
    expect(c._view.x).toBeCloseTo(400 - 1000, 6);
    expect(c._view.y).toBeCloseTo(600 - 1000, 6);
  });

  test('边界只在中间一小块时，约束按边界而不是整张底图算', () => {
    const c = withRealClamp();
    // 底图 1000x1000，但校园只占 uv 0.10~0.90 → 本地像素 100~900，跨度 800
    c._map.bounds.bbox = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 };
    c._view = { k: 1, x: -99999, y: 0 };
    c._clamp();
    // 校园左边缘最多只能到画布左边缘：x 不能小于 400-900 = -500
    expect(c._view.x).toBeCloseTo(-500, 6);

    c._view.x = 99999;
    c._clamp();
    // 也不能超过 -100（校园右边缘贴住画布右边缘）
    expect(c._view.x).toBeCloseTo(-100, 6);
  });
});

/**
 * 准星选点：针钉在画布正中，镜头就必须能走到边界。
 *
 * 旧实现沿用浏览态的「边缘贴边缘」上限，校园最外一圈永远停在画布边上，
 * 针能落到的范围等于校园内缩半屏 —— 边界上的位置一个都选不到，
 * 校园比画布矮时整轴还退化成锁死居中，上下完全拖不动。
 */
describe('campus-map 组件 · 准星选点的边界可达性', () => {
  const OVER = 24;   // EDGE_OVERSCROLL

  function withRealClamp(opts) {
    const c = createInstance();
    c._clamp = def.methods._clamp.bind(c);
    c._clampAxis = def.methods._clampAxis.bind(c);
    c._axisSlack = def.methods._axisSlack.bind(c);
    c._map = Object.assign(c._map, {
      W: 1000, H: 1000,
      bounds: { uv: [[0, 0], [1, 0], [1, 1], [0, 1]], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }
    });
    if (opts && opts.crosshair !== undefined) c.data.crosshair = opts.crosshair;
    return c;
  }

  /** 针（画布正中）此刻对应的归一化坐标 */
  const pinUV = c => ({
    u: (c._cw / 2 - c._view.x) / (c._map.W * c._view.k),
    v: (c._ch / 2 - c._view.y) / (c._map.H * c._view.k)
  });

  /** 往一个方向死拖，看针最终被推到哪 */
  const dragTo = (c, x, y) => { c._view.x = x; c._view.y = y; c._clamp(); return pinUV(c); };

  test('浏览模式仍不许越界（余量为 0，行为不变）', () => {
    const c = withRealClamp({ crosshair: false });
    c._view = { k: 1, x: 0, y: 0 };
    const at = dragTo(c, 99999, 99999);
    // 右/下边缘贴住画布右/下边缘 → 针只够得到校园内缩半屏的一段
    expect(at.u).toBeCloseTo(0.2, 6);
    expect(at.v).toBeCloseTo(0.3, 6);
    expect(dragTo(c, -99999, -99999).u).toBeCloseTo(0.8, 6);
  });

  test('准星模式：针能走到校园的四条边（并略微越过，用于触发「校外」态）', () => {
    const c = withRealClamp();
    c.data.crosshair = true;
    c._view = { k: 1, x: 0, y: 0 };        // 内容 1000x1000，画布 400x600

    // 镜头往右下推到底：校园左/上边缘贴到针尖，再多给 24px 余量
    const a = dragTo(c, 99999, 99999);
    expect(a.u * c._map.W * c._view.k).toBeCloseTo(-OVER, 6);
    expect(a.v * c._map.H * c._view.k).toBeCloseTo(-OVER, 6);

    // 镜头往左上推到底：右/下边缘贴到针尖
    const b = dragTo(c, -99999, -99999);
    expect(b.u * c._map.W * c._view.k).toBeCloseTo(1000 + OVER, 6);
    expect(b.v * c._map.H * c._view.k).toBeCloseTo(1000 + OVER, 6);
  });

  /**
   * 真实线上场景：1580x840 的横躺校园配竖屏画布，
   * 校园高度远小于画布高度 → 旧实现在这一轴直接锁死居中，针一辈子动不了。
   */
  test('校园比画布矮时不再锁死居中，上下能拖到边界', () => {
    const c = withRealClamp();
    c.data.crosshair = true;
    const bb = { x0: 0.0304, y0: 0.0821, x1: 0.9842, y1: 0.9675 };
    c._map = Object.assign(c._map, {
      W: 1580, H: 840,
      bounds: { uv: [[0, 0], [1, 0], [1, 1], [0, 1]], bbox: bb }
    });
    c._cw = 376; c._ch = 680;
    c._fit();
    // 默认落点倍率：focusBeside 用的是 fitK * 1.8
    c._view.k = c._fitK * 1.8;

    const south = dragTo(c, 0, -99999);      // 镜头往上推 → 针看到校园南边
    const north = dragTo(c, 0, 99999);       // 镜头往下压 → 针看到校园北边
    expect(north.v).toBeLessThan(bb.y0);     // 针能越过上边界
    expect(south.v).toBeGreaterThan(bb.y1);  // 针能越过下边界
    expect(south.v - north.v).toBeGreaterThan(bb.y1 - bb.y0);   // 覆盖整个校园纵向范围

    // 对照：同一场景下浏览模式仍然锁死居中（校园边缘贴画布边缘，针到不了边界）
    c.data.crosshair = false;
    expect(dragTo(c, 0, -99999).v).toBeCloseTo(dragTo(c, 0, 99999).v, 6);
  });

  test('余量只在准星模式下开：点选模式针跟着手指走，不需要', () => {
    const c = withRealClamp({ crosshair: false });
    expect(c._axisSlack(600)).toBe(0);
    c.data.crosshair = true;
    expect(c._axisSlack(600)).toBe(600 / 2 + OVER);
  });

  test('病态平移量（捏合累积漂移那种）在准星模式下也夹得回来', () => {
    const c = withRealClamp();
    c.data.crosshair = true;
    c._view = { k: 1, x: -1.53e14, y: -1.53e14 };
    c._clamp();
    expect(Number.isFinite(c._view.x)).toBe(true);
    expect(Number.isFinite(c._view.y)).toBe(true);
    // 仍是有限区间：校园右/下边缘最多停在针尖 + 余量处
    expect(c._view.x).toBeCloseTo(400 - 1000 - (400 / 2 + OVER), 6);
    expect(c._view.y).toBeCloseTo(600 - 1000 - (600 / 2 + OVER), 6);
  });
});

/**
 * 针尖才是坐标。
 *
 * 早前 _pin 把传进去的坐标当成**圆头中心**，尖底画在坐标下方 1.5 倍半径（22.5px），
 * 而命中检测、_toUV/pickAtCenter 全都在坐标上取样。于是：
 *
 *   - 针尖指着的地方 ≠ 真正记下来的那个点（差一整根针）
 *   - 按针尖点猫点不中（它在命中半径的边缘外），按圆头才中
 *
 * 表现就是「地图跟指针对不上」。这里把「针尖 = 坐标」锁死。
 */
describe('campus-map 组件 · 针尖 = 坐标', () => {
  const T = { markRing: '#E8927C', markLost: '#9B9B9B' };
  const PIN_R = 15;
  const DROP = 1.5;                       // 圆头中心比针尖高 1.5 个半径

  /** 只画一根针，返回它的记账 ctx */
  function drawnPin(x, y, scale) {
    const c = createInstance();
    c._ctx = recCtx();
    c._pin(x, y, T, scale === undefined ? 1 : scale);
    return c._ctx.calls;
  }

  test('_pin：尖底画在传入的坐标上，整根针都在它上方', () => {
    const calls = drawnPin(200, 300);

    // 尖底那个顶点 = 传入的坐标
    expect(calls.some(c => c.cmd === 'lineTo' && c.x === 200 && c.y === 300)).toBe(true);
    // 圆头中心 = 针尖上方 1.5 半径（不是针尖本身）
    const head = calls.find(c => c.cmd === 'arc' && c.r === PIN_R);
    expect(head).toBeTruthy();
    expect(head.y).toBeCloseTo(300 - PIN_R * DROP, 6);
    // 除了投影，画出来的任何东西都不该低于针尖
    for (const c of calls) {
      if (c.cmd === 'ellipse') continue;   // 落地投影本来就在针尖下方
      expect(c.y).toBeLessThanOrEqual(300);
    }
  });

  /** 绘制与取样必须是同一个点：画哪儿就记哪儿 */
  test('_pinPoint() 既是画针尖的位置，也是取样坐标的位置', () => {
    const c = createInstance();
    c._ctx = recCtx();
    c._map.bounds = { uv: [[0, 0], [1, 0], [1, 1], [0, 1]], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
    c._view = { k: 0.25, x: 75, y: 175 };   // 250px 的底图摆在 400x600 正中 → 正中是校内

    const p = c._pinPoint();
    expect(p).toEqual({ x: c._cw / 2, y: c._ch / 2 });

    c._pin(p.x, p.y, T, 1);
    expect(c._ctx.calls.some(x => x.cmd === 'lineTo' && x.x === p.x && x.y === p.y)).toBe(true);

    // 取样也走它：_toUV(_pinPoint()) == pickAtCenter 返回的 uv
    const uv = c._toUV(p.x, p.y);
    const pick = c.pickAtCenter();
    expect(pick.u).toBeCloseTo(uv.u, 6);
    expect(pick.v).toBeCloseTo(uv.v, 6);
  });

  /** 命中要盖住整根针：针尖、圆头、以及两者之间 */
  test('命中判定同时覆盖针尖与圆头（按哪一头都点得中）', () => {
    const c = createInstance();
    // uv 0.5 → 屏幕 (125, 125)（k=0.25、W=1000、x=y=0）
    c.data.marks = [{ id: 'cat0', name: '猫0', u: 0.5, v: 0.5, status: 'normal' }];
    c._clusterMarks();

    expect(c._hitTest(125, 125).type).toBe('mark');                     // 针尖
    expect(c._hitTest(125, 125 - PIN_R * DROP).type).toBe('mark');       // 圆头中心
    expect(c._hitTest(125, 115).type).toBe('mark');                       // 针身中段
    // 旧实现把「针尖」画在坐标下方 1.5R = 22.5px，那里才点得中；
    // 命中区必须跟着针一起挪走 —— 现在那个位置什么都不是
    expect(c._hitTest(125, 125 + PIN_R * DROP).type).not.toBe('mark');
  });

  test('占位框盖住整根针（含针尖），不会漏出边界', () => {
    const c = createInstance();
    c.data.marks = [{ id: 'cat0', name: '猫0', u: 0.5, v: 0.5, status: 'normal' }];
    c._labels = [];
    c._clusterMarks();
    c._reserveMarks();

    const box = c._labels[0];
    expect(box.t).toBeLessThanOrEqual(125 - PIN_R * (1 + DROP));   // 圆头顶
    expect(box.b).toBeGreaterThanOrEqual(125);                     // 针尖
    // 横向要盖住圆头，否则建筑名会从针的两侧钻出来
    expect(box.l).toBeLessThanOrEqual(125 - PIN_R);
    expect(box.r).toBeGreaterThanOrEqual(125 + PIN_R);
  });

  test('聚合针同样以针尖为锚（圆头更大、下沉更多）', () => {
    const c = createInstance();
    c._ctx = recCtx();
    c.data.marks = [
      { id: 'cat0', name: '猫0', u: 0.10, v: 0.10, status: 'normal' },
      { id: 'cat1', name: '猫1', u: 0.108, v: 0.10, status: 'normal' }
    ];
    const g = c._clusterMarks()[0];

    c._cluster(g, T);
    // 针尖画在这一坨的坐标上（uv 0.10 → 屏幕 (25, 25)）
    expect(c._ctx.calls.some(x => x.cmd === 'lineTo' && x.x === 25 && x.y === 25)).toBe(true);
    const head = c._ctx.calls.find(x => x.cmd === 'arc' && x.r === 20);
    expect(head.y).toBeCloseTo(25 - 20 * DROP, 6);
    // 按圆头也点得中这一坨
    expect(c._hitTest(25, 25 - 20 * DROP).type).toBe('cluster');
  });

  test('猫爪跟着圆头走（画在圆头中心，不是钉在坐标上）', () => {
    const c = createInstance();
    c._ctx = recCtx();
    c._labels = [];                      // _labelAt 要用它做避让
    c.data.marks = [{ id: 'cat0', name: '猫0', u: 0.5, v: 0.5, status: 'normal' }];
    c._clusterMarks();

    c._mark(c.data.marks[0], T);

    const t = c._ctx.calls.find(x => x.cmd === 'translate');
    expect(t).toBeTruthy();
    expect(t.x).toBeCloseTo(125, 6);
    expect(t.y).toBeCloseTo(125 - PIN_R * DROP, 6);
  });
});

/** 测试用：最小 canvas 2d 上下文桩。_labelAt 只需要 measureText + 路径/填充命令 */
function makeCtx() {
  const noop = () => {};
  return {
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    measureText: (t) => ({ width: String(t).length * 12 }),   // 每字 12px，够算胶囊宽度
    beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop,
    fill: noop, stroke: noop, fillText: noop, fillRect: noop, clearRect: noop
  };
}

/**
 * 测试用：会记账的 canvas 2d 上下文桩。
 * 断言「针画在哪儿」只能看实际下发的路径命令 —— 桩里没有真画布，
 * 所以把 moveTo/lineTo/arc/ellipse/translate 都记下来。
 */
function recCtx() {
  const calls = [];
  const noop = () => {};
  return {
    calls,
    font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    measureText: (t) => ({ width: String(t).length * 12 }),
    beginPath: noop, closePath: noop, fill: noop, stroke: noop, fillText: noop,
    fillRect: noop, clearRect: noop, save: noop, restore: noop, scale: noop, setLineDash: noop,
    arcTo: noop,
    moveTo: (x, y) => calls.push({ cmd: 'moveTo', x, y }),
    lineTo: (x, y) => calls.push({ cmd: 'lineTo', x, y }),
    arc: (x, y, r) => calls.push({ cmd: 'arc', x, y, r }),
    ellipse: (x, y) => calls.push({ cmd: 'ellipse', x, y }),
    translate: (x, y) => calls.push({ cmd: 'translate', x, y })
  };
}

/** 测试用：点是否在任一地物内（复用组件的判定口径） */
function pointInPolyFor(c, u, v) {
  const layers = [c._map.buildings, c._map.roads, c._map.sports, c._map.greens];
  for (const arr of layers) {
    for (const f of arr || []) {
      if (!f.uv) continue;
      let inside = false;
      for (let i = 0, j = f.uv.length - 1; i < f.uv.length; j = i++) {
        const xi = f.uv[i][0], yi = f.uv[i][1], xj = f.uv[j][0], yj = f.uv[j][1];
        if (yi > v !== yj > v && u < (xj - xi) * (v - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}

/**
 * 校区：底图一个校区一张（utils/campusMapRegistry）。
 * 拿错底图不会报错、只会把坐标画到别处，所以「按 zone 取图」和
 * 「没底图就不画（不拿本部凑合）」都必须锁住。
 */
describe('campus-map 组件 · 校区底图', () => {
  test('zone=东区：载入东区底图（不是本部那张）', () => {
    const c = createInstance();
    c.data.zone = '东区';
    c._loadMap();

    expect(c._map.campusZone).toBe('东区');
    expect(c._map.buildings.length).toBeGreaterThan(0);
    expect(c.data.ready).toBe(true);
    expect(c.data.empty).toBe(false);
    expect(c.data.loadError).toBe(false);
  });

  test('没画底图的校区：置空态，绝不回退本部底图', () => {
    const c = createInstance();
    c.data.zone = '西区';
    c._loadMap();

    expect(c._map).toBeNull();
    expect(c.data.empty).toBe(true);
    expect(c.data.loadError).toBe(false);
  });

  test('校区名带空格：去空白后正常取图', () => {
    const c = createInstance();
    c.data.zone = ' 东区 ';
    c._loadMap();
    expect(c._map.campusZone).toBe('东区');
  });

  test('不认识的校区：同样置空态（不猜、不拿本部凑合）', () => {
    const c = createInstance();
    c.data.zone = '火星校区';
    c._loadMap();
    expect(c._map).toBeNull();
    expect(c.data.empty).toBe(true);
  });
});

describe('campus-map 组件 · 分享图', () => {
  /** 造一个画布导出环境：离屏 canvas 只用到 scale/setTransform，_paint 由用例替换 */
  function mockCanvasExport(exportImpl) {
    const ctx = { scale: jest.fn(), setTransform: jest.fn() };
    const canvas = { getContext: jest.fn(() => ctx) };
    wx.createOffscreenCanvas = jest.fn(() => canvas);
    wx.canvasToTempFilePath = jest.fn(exportImpl);
    return { canvas, ctx };
  }

  test('导出 800×640 的 5:4 临时文件，并把可见视图/状态原样还原', async () => {
    const c = createInstance();
    c._map = { W: 1000, H: 1000, bounds: null, pois: [], buildings: [], sports: [], roads: [], greens: [] };
    c._ctx = { marker: 'visible' };
    c._cw = 400;
    c._ch = 600;
    c._view = { k: 0.25, x: 10, y: 20 };
    c._labels = [{ l: 1 }];
    c._clusters = [{ x: 1 }];
    c._theme = 'dark';
    c.data.activeId = 'cat1';
    c.data.pending = { u: 0.5, v: 0.5 };
    const paint = jest.fn();
    c._paint = paint;

    const { ctx } = mockCanvasExport((opts) => opts.success({ tempFilePath: 'wxfile://share.jpg' }));

    const path = await c.renderShareImage();
    expect(path).toBe('wxfile://share.jpg');
    expect(wx.createOffscreenCanvas).toHaveBeenCalledWith({ type: '2d', width: 800, height: 640 });
    expect(paint).toHaveBeenCalledTimes(1);
    // 逻辑画布 390×312，整体放大到 800×640，字号/针半径才不会缩水
    expect(ctx.scale).toHaveBeenCalledWith(800 / 390, 640 / 312);
    expect(wx.canvasToTempFilePath.mock.calls[0][0].width).toBe(800);
    expect(wx.canvasToTempFilePath.mock.calls[0][0].destWidth).toBe(800);

    // 还原：任何一个漏还原，可见地图都会跳视角
    expect(c._ctx).toEqual({ marker: 'visible' });
    expect(c._cw).toBe(400);
    expect(c._ch).toBe(600);
    expect(c._view).toEqual({ k: 0.25, x: 10, y: 20 });
    expect(c._labels).toEqual([{ l: 1 }]);
    expect(c._clusters).toEqual([{ x: 1 }]);
    expect(c._theme).toBe('dark');
    expect(c.data.activeId).toBe('cat1');
    expect(c.data.pending).toEqual({ u: 0.5, v: 0.5 });
  });

  test('可见画布没就绪时 reject（否则会把 undefined 的 _cw 现场还原回去，地图间歇性空白）', async () => {
    const c = createInstance();
    c._init = false;   // _initCanvas 的异步量尺寸还没回来
    mockCanvasExport(() => { throw new Error('should not export'); });

    await expect(c.renderShareImage()).rejects.toThrow('map not ready');
    expect(wx.createOffscreenCanvas).not.toHaveBeenCalled();
  });

  test('底图没加载时直接 reject，不创建离屏画布', async () => {
    const c = createInstance();
    c._map = null;
    mockCanvasExport(() => { throw new Error('should not export'); });

    await expect(c.renderShareImage()).rejects.toThrow('map not ready');
    expect(wx.createOffscreenCanvas).not.toHaveBeenCalled();
  });

  test('导出失败时也要还原状态', async () => {
    const c = createInstance();
    c._ctx = { marker: 'visible' };
    c._cw = 400;
    c._ch = 600;
    c._view = { k: 0.25, x: 10, y: 20 };
    c._paint = jest.fn();
    mockCanvasExport((opts) => opts.fail(new Error('export boom')));

    await expect(c.renderShareImage()).rejects.toThrow('export boom');
    expect(c._ctx).toEqual({ marker: 'visible' });
    expect(c._cw).toBe(400);
    expect(c._ch).toBe(600);
    expect(c._view).toEqual({ k: 0.25, x: 10, y: 20 });
  });

  test('平台不回调时 3 秒超时，不会把分享面板挂住', async () => {
    const c = createInstance();
    c._view = { k: 0.25, x: 10, y: 20 };
    c._paint = jest.fn();
    mockCanvasExport(() => { /* 永远不回调 */ });

    jest.useFakeTimers();
    try {
      const p = c.renderShareImage();
      jest.advanceTimersByTime(3000);
      await expect(p).rejects.toThrow('canvas export timeout');
      expect(c._view).toEqual({ k: 0.25, x: 10, y: 20 });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('campus-map 组件 · 画布销毁保护', () => {
  test('_paint 在 ctx 为空时安静退出（卸载后的回调不再崩）', () => {
    const c = createInstance();
    c._ctx = null;
    expect(() => c._paint()).not.toThrow();
  });

  test('16ms 回调执行前画布被销毁，不再重绘', () => {
    jest.useFakeTimers();
    try {
      const c = createInstance();
      c._init = true;
      c._ctx = {};
      c._map = { W: 100, H: 100 };
      const paint = jest.fn();
      c._paint = paint;
      def.methods.draw.call(c);
      c._ctx = null;              // 模拟 detached
      jest.advanceTimersByTime(16);
      expect(paint).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('detached 会取消已排队的 16ms 重绘', () => {
    jest.useFakeTimers();
    try {
      const c = createInstance();
      c._init = true;
      c._ctx = {};
      c._map = { W: 100, H: 100 };
      const paint = jest.fn();
      c._paint = paint;
      def.methods.draw.call(c);
      def.lifetimes.detached.call(c);
      expect(c._raf).toBeNull();
      jest.advanceTimersByTime(16);
      expect(paint).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
