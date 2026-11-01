/**
 * subpackages/map/components/campus-map/campus-map.js - 校园矢量地图
 *
 * 数据源：images/campus-map/campus-map.js，由 tools/campus-map-editor 导出
 *
 * 坐标约定：
 *   JSON 里是底图像素坐标（左上原点，x 右 y 下），imageSize 记录原始尺寸。
 *   组件加载后归一化成 u/v（0~1），渲染时再乘回像素，存 u/v 是为了不依赖底图原始分辨率。
 *
 * 渲染分层（自下而上）：绿地 → 道路 → 建筑 → 边界 → POI → 建筑名 → 猫标记 → 选点预览
 *
 * 交互：单指拖动 / 双指缩放 / 点击命中（猫标记优先，其次 POI，再次建筑）
 *
 * 本组件**不调用任何定位接口**（无 wx.getLocation / wx.chooseLocation / scope.userLocation）——
 * 账号 your-appid-here 未获批这些隐私接口，调用即弹「接口无权限」，审核期也会被驳回。
 */
// 数据源是 .js 不是 .json：微信小程序不支持 require('.json')，
// 写成 .json 会在这里直接抛 "module 'campus-map.json.js' is not defined"，
// 整个组件加载失败（页面表现是整块空白 + console 报错，不是降级）。
//
// 底图按校区取（utils/campusMapRegistry 是唯一登记表）：一个校区一张图，
// 拿错图不会报错、只会把坐标画到别处，所以 zone 必须由调用方明确传入。
const { getMap, normalizeZone } = require('../../../../utils/campusMapRegistry');

/** 主题配色：与 theme.json 的暖珊瑚体系保持一致 */
const THEME = {
  light: {
    // 校外底色要比校内明显深一档：竖屏下校园必然上下留空带，
    // 两色太接近就会看成「整张画布没画完」，拉开之后才像「这里就是校园的形状」
    outside: '#DFD8C9',
    campus: '#FBF7EF',
    vignette: 'rgba(88,68,48,.16)',
    campusShadow: 'rgba(96,74,52,.26)',
    sportFill: '#F2D6C4', sportStroke: '#C79272',
    greenFill: '#DDE8CE', greenStroke: '#A8C08A',
    roadFill: '#FBF7F0', roadStroke: '#E5DCC8',
    buildFill: '#F5EBD8', buildStroke: '#D9C4A3', buildShadow: 'rgba(139,109,79,.14)',
    boundary: '#E8927C',
    label: '#5A4A42',
    labelBg: 'rgba(255,255,255,.92)',
    labelBorder: 'rgba(139,109,79,.16)',
    markRing: '#E8927C',
    markLost: '#9B9B9B',
    panel: '#FFFFFF',
    text: '#3D3D3D',
    subText: '#8C8C8C'
  },
  dark: {
    outside: '#100E0C',
    campus: '#221D19',
    vignette: 'rgba(0,0,0,.45)',
    campusShadow: 'rgba(0,0,0,.6)',
    sportFill: '#3A2E27', sportStroke: '#6E5344',
    greenFill: '#242C22', greenStroke: '#3D4A35',
    roadFill: '#332E2A', roadStroke: '#4A433C',
    buildFill: '#2A2622', buildStroke: '#4A433C', buildShadow: 'rgba(0,0,0,.35)',
    boundary: '#E8927C',
    label: '#C9BFB6',
    labelBg: 'rgba(42,38,34,.92)',
    labelBorder: 'rgba(255,255,255,.10)',
    markRing: '#F0A48F',
    markLost: '#7A7570',
    panel: '#2A2622',
    text: '#E8E2DC',
    subText: '#9A938C'
  }
};

/** 建筑按用途微调底色，让「宿舍群 / 教学区」一眼可辨（低饱和，不抢猫标记的视觉） */
const KIND_TINT = {
  light: {
    library: '#F7EBD2', canteen: '#F3E4D6', dorm: '#EFE9DC',
    office: '#F2EDE2', lab: '#F4EEE4', teaching: '#F5EBD8', training: '#F4EEE4', other: '#F5EBD8'
  },
  dark: {
    library: '#332C22', canteen: '#2F2822', dorm: '#282521',
    office: '#2C2924', lab: '#2E2A26', teaching: '#2A2622', training: '#2E2A26', other: '#2A2622'
  }
};

const TAP_SLOP = 8;          // 超过这个位移就当拖动，不算点击

/** 单只猫针的圆头半径（px） */
const PIN_R = 15;
/** 聚合针的圆头半径（px），比单只大一号才看得出是个「球」 */
const CLUSTER_R = 20;
/**
 * 针尖相对圆头中心的下沉量，按圆头半径的倍数算。
 *
 * **针尖才是「坐标在这儿」的那一点** —— 绘制、命中检测、uv 换算全都以它为准。
 * 早前把传进来的坐标当圆头中心用，画出的尖底就落在坐标下方 1.5 倍半径（22.5px），
 * 而取样全在坐标上：于是「针尖指着的地方」和「真正记下来的那个点」差一整根针，
 * 表现正是地图整体偏移、点出来的地和看到的地对不上。
 */
const PIN_TIP_DROP = 1.5;

/**
 * 准星选点时校园允许越过画布边缘的余量（px）。见 _axisSlack。
 * 边界必须能被拖到针下（那才是边界上那些位置唯一的选法），
 * 再多留 24px 让针能探到校外，页面据此提示「这里在校外」。
 */
const EDGE_OVERSCROLL = 24;

/** 空地点位方位后缀（_besideLabel）：按 45° 分八向，0=东、顺时针（底图北朝上、y 向下为南） */
const DIR8 = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
// 小于此比例不画建筑名，避免糊成一团。
// 阈值取「适配态」附近而非更深，这样缩小看全图时仍能看到几个大地标的名字；
// 具体的去重交给 _labelAt 的矩形避让——放不下就自动让位。
const LABEL_MIN_SCALE = 0.16;

Component({
  options: { addGlobalClass: true },

  properties: {
    /** 猫标记 [{ id, name, avatar, status, u, v, at }]，u/v 为 0~1 */
    marks: { type: Array, value: [] },
    /** browse=浏览 | select=选点 */
    mode: { type: String, value: 'browse' },
    /** 选点模式下当前预览的位置 { u, v, label } */
    pending: { type: Object, value: null },
    /** 已选中的猫标记 id */
    activeId: { type: String, value: '' },
    /**
     * 画布高度（px）。**不传或传 0 时按 62vh 自适应** ——
     * 用 vh 而不是 JS 算完再 setData，是因为 canvas 的 inline style 会覆盖 wxss，
     * 而 attached 里的 setData 与首次渲染存在竞态：晚一步布局出来就是 0×0。
     */
    height: { type: Number, value: 0 },
    /**
     * 中心准星模式：针固定在画布正中，**拖地图来移针**，而不是点地图。
     * 这是外卖选点的核心手感 —— 拖动时实时把针下的位置回抛给页面。
     */
    crosshair: { type: Boolean, value: false },
    /**
     * 校区（与 cats.campus 写法一致，见 utils/campusMapRegistry）。
     * 决定用哪一张底图。**必须由调用方传**，不传按本部兜底 ——
     * 拿本部底图配东区坐标时画面看着正常、位置全错，是最难发现的一类错。
     */
    zone: { type: String, value: '本部' }
  },

  observers: {
    zone() {
      // 切校区 = 换底图：重新解析 + 视图回到全图（旧视角是给旧图算的）。
      // 组件没到 ready 时 _loadMap 已经读过一次，这里防重入。
      if (!this._mapZone) return;
      if (this._mapZone === normalizeZone(this.data.zone)) return;
      this._loadMap();
      this._fittedMarks = false;
      if (this._init) {
        this._fit();
        this.draw();
      }
    },
    'marks, pending, activeId, crosshair': function () {
      // 从「没选」变成「选中了」才播入场动画。
      // 拖动过程中 pending 一直在变，每次都播会抖成筛子。
      const has = !!(this.data.pending && !isNil(this.data.pending.u));
      if (has && !this._hadPending) this._playPinIn();
      this._hadPending = has;
      if (this.data.mode === 'browse' && !this._fittedMarks && (this.data.marks || []).length > 0 && this._init) {
        this._fittedMarks = true;
        this.fitToMarks();
        return;
      }
      this.draw();
    }
  },

  data: {
    ready: false,
    loadError: false,
    empty: false,
    // 当前已载入的校区（由 _loadMap 写入，供页面显示/断言用）
    mapZone: ''
  },

  lifetimes: {
    attached() {
      this._init = false;
      this._view = { k: 1, x: 0, y: 0 };
      this._theme = 'light';
      this._raf = null;
      this._labels = [];   // 已绘制的标签框，用于避让
      this._loadMap();
    },
    ready() {
      this._initCanvas();
    },
    detached() {
      // 必须 clearTimeout：只把 _raf 置空，已经排进队列的 16ms 回调仍会跑，
      // 那时 _ctx 已经为 null，_paint 第一行 clearRect 就崩（2026-10-22 线上反馈）。
      if (this._raf) { clearTimeout(this._raf); this._raf = null; }
      if (this._pinAnim) { clearTimeout(this._pinAnim); this._pinAnim = null; }
      this._canvas = null;
      this._ctx = null;
    }
  },

  methods: {
    /* ══════════ 数据 ══════════ */

    /**
     * 解析该校区的底图，预计算命中检测所需的索引。
     * 只算一次，后续平移缩放都复用；切校区时重算（见 zone 观察器）。
     */
    _loadMap() {
      const zone = normalizeZone(this.data.zone);
      this._mapZone = zone;
      try {
        // 底图按校区取（utils/campusMapRegistry）。没登记的校区一律拿 null：
        // 宁可空着（页面按空态提示），也不能回退本部 —— 那会把东区的坐标
        // 画在本部图上，看着正常、位置全错。
        const raw = getMap(zone);
        if (!raw) {
          this._map = null;
          this._labelOrder = [];
          this.setData({ ready: true, loadError: false, empty: true });
          return;
        }
        const size = raw.imageSize || [1000, 1000];
        const W = size[0] || 1000;
        const H = size[1] || 1000;
        const norm = (pts) => (pts || []).map(p => [p[0] / W, p[1] / H]);

        const prep = (arr) => (arr || []).filter(f => f && f.p && f.p.length >= 3).map(f => {
          const uv = norm(f.p);
          return {
            name: f.name || '',
            kind: f.kind || 'other',
            uv,
            // 包围盒：点击时先粗筛，再做精确的点在多边形内判断
            bbox: uvBBox(uv),
            anchor: uvCentroid(uv)
          };
        });

        this._map = {
          W, H,
          campusZone: raw.campusZone || '本部',
          mapVersion: raw.mapVersion || 1,
          bounds: raw.bounds && raw.bounds.length >= 3 ? {
            uv: norm(raw.bounds),
            bbox: uvBBox(norm(raw.bounds))
          } : null,
          sports: prep(raw.sports),
          buildings: prep(raw.buildings),
          roads: prep(raw.roads),
          greens: prep(raw.greens),
          pois: (raw.pois || []).filter(p => p && !isNil(p.x)).map(p => ({
            name: p.name || '',
            kind: p.kind || 'other',
            u: p.x / W,
            v: p.y / H
          }))
        };

        // 标签绘制顺序：按包围盒面积从大到小。
        // 缩小视图时标签位有限，大建筑先占，小的自动让位（见 _labelAt 的矩形避让），
        // 避免出现「重要的楼没名字、不重要的宿舍挤了一堆名字」。
        this._labelOrder = this._map.sports.concat(this._map.buildings).sort((a, b) => {
          const aa = (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0);
          const ab = (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0);
          return ab - aa;
        });

        const total = this._map.buildings.length + this._map.pois.length;
        this._mapZone = this._map.campusZone;
        this.setData({
          ready: true,
          loadError: false,
          empty: !this._map.bounds && total === 0,
          mapZone: this._mapZone
        });
      } catch (err) {
        this.setData({ ready: true, loadError: true });
      }
    },

    /* ══════════ 供页面调用的公开方法 ══════════ */

    /**
     * 针尖所在的屏幕坐标 = 画布正中。
     * 绘制与命中检测**都必须**走这一个函数 —— 两处各算一遍就会
     * 「针画在这儿、算出来的坐标却在那儿」。
     */
    _pinPoint() {
      return { x: this._cw / 2, y: this._ch / 2 };
    },

    /**
     * 找出离 (u,v) 最近的有名地物，返回它的**名字**（不带后缀）。
     * 距离/方位语义见 _nearestFeature。
     */
    _nearestName(u, v) {
      const f = this._nearestFeature(u, v);
      return f ? f.name : '';
    },

    /**
     * 找出离 (u,v) 最近的有名地物，带像素距离与「点相对地物」的方位向量。
     *
     * 距离按**像素**算而不是归一化坐标：uv 两轴的分母不同（1580 × 840），
     * 直接在 uv 空间算欧氏距离会把横向的差距算小，选错最近的楼。
     * 到多边形的距离用「到包围盒的距离」近似，够准且便宜；
     * 方位用地物包围盒中心当参照点（y 向下为南，底图按北朝上画的）。
     */
    _nearestFeature(u, v) {
      const m = this._map;
      if (!m) return null;
      let best = null;
      let bestD = Infinity;

      const consider = (name, dx, dy, cu, cv) => {
        if (!name) return;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) {
          bestD = d;
          best = { name, dist: d, dirX: (u - cu) * m.W, dirY: (v - cv) * m.H };
        }
      };

      for (const f of this._labelOrder || []) {
        const b = f.bbox;
        if (!b) continue;
        const dx = (u < b.x0 ? b.x0 - u : u > b.x1 ? u - b.x1 : 0) * m.W;
        const dy = (v < b.y0 ? b.y0 - v : v > b.y1 ? v - b.y1 : 0) * m.H;
        consider(f.name, dx, dy, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      }
      for (const p of m.pois || []) {
        consider(p.name, (p.u - u) * m.W, (p.v - v) * m.H, p.u, p.v);
      }
      return best;
    },

    /**
     * 空地点位的可读地名，按距离分三档（阈值是底图像素，本部底图 1580 宽覆盖
     * 全校，50px 约几十米，量级足够区分「紧邻 / 隔一段 / 远」）：
     *   紧邻（<50px）  →「图书馆旁」          方位没信息量，别添乱
     *   隔一段（<160px）→「图书馆东侧 / 东南侧」 楼两头、马路对面的相遇点能区分开
     *   远（≥160px）   →「图书馆附近」        说「旁」名不副实
     *
     * 方位以地物中心为参照、按 45° 分八向（底图北朝上）。
     * 用途：针落在校园里但没压在任何建筑/运动场上时（hitTest 返回 campus），
     * 直接显示「校内空地」太无用 —— 校园就这么大，几乎每个空点都紧挨着某栋楼。
     */
    _besideLabel(u, v) {
      const f = this._nearestFeature(u, v);
      if (!f) return '';
      if (f.dist < 50) return f.name + '旁';
      if (f.dist < 160) {
        // atan2(dirY, dirX)：0°=正东，顺时针（y 向下）；四舍五入到 45° 一档
        const idx = (Math.round(Math.atan2(f.dirY, f.dirX) / (Math.PI / 4)) % 8 + 8) % 8;
        return f.name + DIR8[idx] + '侧';
      }
      return f.name + '附近';
    },

    /** (u,v) 是否落在任一地物内部（建筑/道路/运动场/绿地） */
    _insideAny(u, v) {
      const m = this._map;
      const layers = [m.buildings, m.roads, m.sports, m.greens];
      for (const arr of layers) {
        for (const f of arr || []) {
          if (!f.bbox || !bboxHit(f.bbox, u, v)) continue;
          if (pointInPoly(u, v, f.uv)) return true;
        }
      }
      return false;
    },

    /**
     * 候选落点是否可用：在校园内、不在任何地物里、且最近的有名地物就是目标。
     * 三条缺一不可 —— 尤其最后一条，它保证标注一定是「目标名 + 旁」。
     */
    _isBesideCandidate(u, v, name) {
      if (u <= 0 || v <= 0 || u >= 1 || v >= 1) return false;
      const bounds = this._map.bounds;
      if (bounds && !pointInPoly(u, v, bounds.uv)) return false;
      if (this._insideAny(u, v)) return false;
      return this._nearestName(u, v) === name;
    },

    /**
     * 把视图移到某个有名地物的**旁边**，让针正好落在它外侧。
     *
     * 针永远钉在画布正中，所以「默认位置」等于「视图对准哪儿」。
     * 直接对准楼心会让针压在楼里（标注成「综合楼」，可相遇点基本都在楼外），
     * 所以从楼心向外逐步试探，找第一个可用的空地落点（见 _isBesideCandidate）。
     *
     * 全部由底图数据推出来，不写死坐标 —— 以后楼挪了、改名了都不用改这里。
     *
     * @returns {boolean} 是否成功（组件没就绪或找不到该地物时 false，调用方照常降级）
     */
    focusBeside(name, scale) {
      if (!this._init || !this._cw || !this._map) return false;
      const m = this._map;
      const target = (m.buildings || []).concat(m.sports || []).find(f => f.name === name);
      if (!target || !target.bbox) return false;

      const b = target.bbox;
      const cu = (b.x0 + b.x1) / 2;
      const cv = (b.y0 + b.y1) / 2;
      const su = Math.max(1e-4, (b.x1 - b.x0) / 2);
      const sv = Math.max(1e-4, (b.y1 - b.y0) / 2);
      const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];

      let found = null;
      for (let step = 0.55; step <= 3.2 && !found; step += 0.15) {
        for (const [dx, dy] of DIRS) {
          const u = cu + dx * su * step;
          const v = cv + dy * sv * step;
          if (!this._isBesideCandidate(u, v, name)) continue;
          found = { u, v };
          break;
        }
      }
      if (!found) return false;

      const k = Math.max(this._minScale(), Math.min(this._maxScale(), scale || this._fitK * 1.8));
      this._view.k = k;
      this._view.x = this._cw / 2 - found.u * m.W * k;
      this._view.y = this._ch / 2 - found.v * m.H * k;
      this._clamp();
      this.draw();
      return true;
    },

    /**
     * 命中点 → 给用户看的地点名。
     * 压在建筑上就用建筑名；落在空地上退化成「最近的楼 + 旁」。
     */
    _labelForHit(hit, u, v) {
      if (!hit || hit.type === 'outside') return '';
      if (hit.type === 'campus') return this._besideLabel(u, v);
      return hit.data && hit.data.name || this._besideLabel(u, v);
    },

    /**
     * 准星模式下取针尖所指的位置。
     * 越界（在校外）返回 null，由页面提示「要选在校内哦」。
     */
    pickAtCenter() {
      if (!this._init || !this._map) return null;
      const p = this._pinPoint();
      const uv = this._toUV(p.x, p.y);
      const hit = this._hitTest(p.x, p.y);
      if (hit.type === 'outside') return null;
      return {
        u: round4(uv.u),
        v: round4(uv.v),
        label: this._labelForHit(hit, uv.u, uv.v),
        hitType: hit.type
      };
    },

    _initCanvas() {
      // 画布尺寸不在这儿算 —— 它由 wxml 的 inline style 决定（height 属性为 0 时
      // 回落到 62vh，见 campus-map.wxml）。这里只量实际布局结果：inline style 会覆盖
      // wxss 里的 width:100%，所以必须以量到的为准，不能自己推。
      const query = this.createSelectorQuery();
      query.select('#campusCanvas').fields({ node: true, size: true });
      // 位置也一并取：onTouchEnd 要用 clientX - rect.left 才能换算到画布坐标。
      // 这里同步拿到 _rect，避免首次点击时 rect 还没缓存导致坐标全错。
      query.select('#campusCanvas').boundingClientRect((r) => {
        this._rect = r;
      });
      query.exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          this.setData({ loadError: true });
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo && wx.getWindowInfo().pixelRatio || 2;

        this._dpr = dpr;
        this._cw = res[0].width;
        this._ch = res[0].height;
        canvas.width = this._cw * dpr;
        canvas.height = this._ch * dpr;
        ctx.scale(dpr, dpr);

        this._canvas = canvas;
        this._ctx = ctx;
        this._init = true;

        try {
          const app = getApp();
          this._theme = (app && app.globalData && app.globalData.theme) === 'dark' ? 'dark' : 'light';
        } catch (e) { this._theme = 'light'; }

        this._fit();
        if (this.data.mode === 'browse' && !this._fittedMarks && (this.data.marks || []).length > 0) {
          this._fittedMarks = true;
          this.fitToMarks();
          return;
        }
        this.draw();
      });
    },

    /* ══════════ 视图变换 ══════════ */

    /** 归一化坐标 → 屏幕像素 */
    _toScreen(u, v) {
      const m = this._map;
      return {
        x: u * m.W * this._view.k + this._view.x,
        y: v * m.H * this._view.k + this._view.y
      };
    },
    /** 屏幕像素 → 归一化坐标 */
    _toUV(x, y) {
      const m = this._map;
      return {
        u: (x - this._view.x) / (m.W * this._view.k),
        v: (y - this._view.y) / (m.H * this._view.k)
      };
    },

    /**
     * 适配视图。
     * 优先按**校园边界**适配，而非整个 imageSize —— 底稿四周通常有大片留白，
     * 按整图适配会把校园缩成中间一小块、四周全是空白，点起来很难受。
     * 没有边界时（例如只画了部分图层）才退回整图适配。
     */
    _fit() {
      const m = this._map;
      if (!m || !this._cw) return;
      let fx = 0, fy = 0, fw = m.W, fh = m.H;
      if (m.bounds) {
        fx = m.bounds.bbox.x0 * m.W;
        fy = m.bounds.bbox.y0 * m.H;
        fw = (m.bounds.bbox.x1 - m.bounds.bbox.x0) * m.W;
        fh = (m.bounds.bbox.y1 - m.bounds.bbox.y0) * m.H;
      }
      if (fw <= 0 || fh <= 0) { fw = m.W; fh = m.H; fx = 0; fy = 0; }
      const pad = 16;
      const k = Math.min((this._cw - pad * 2) / fw, (this._ch - pad * 2) / fh);
      this._view.k = k;
      this._view.x = (this._cw - fw * k) / 2 - fx * k;
      this._view.y = (this._ch - fh * k) / 2 - fy * k;
      this._fitK = k;   // 缩放上下限以适配比例为基准
    },

    /** 把地图重新居中（对外暴露，页面可调用） */
    resetView() {
      this._fit();
      this.draw();
    },

    /**
     * 导出一张 5:4 的全校园分享图（含猫针），供转发/朋友圈卡片使用。
     *
     * 为什么是离屏重画，而不是直接导屏幕上那块画布：
     *   1. 屏幕上的视图可能被用户缩放/拖到某个角落，卡片会变成一块随机地图；
     *      这里固定按「校园边界适配」出全图，和页面打开时的第一眼一致。
     *   2. 屏幕画布是竖屏（约 0.78:1），微信卡片按 5:4 裁会切掉上下近一半；
     *      离屏画布直接就是 5:4，不用赌微信怎么裁。
     *   3. 重画不走 draw() 的 16ms 合帧，也不动可见画布 —— 分享面板弹出时页面不闪。
     *
     * 字号/针半径都是按屏幕像素写死的（11px、15px…），所以逻辑画布固定 390×312，
     * 再用 ctx.scale 整体放大到 800×640；只放大画布不缩放上下文会让针和地名小一半。
     *
     * @param {{width?: number, height?: number}} [options] 输出像素，默认 800×640
     * @returns {Promise<string>} 临时文件路径（可直接作为 imageUrl）
     */
    renderShareImage(options = {}) {
      const width = options.width || 800;
      const height = options.height || 640;
      return new Promise((resolve, reject) => {
        // 可见画布没量好尺寸（_initCanvas 的异步查询还没回来）时绝不能开工：
        // 下面「保存 _cw/_view 现场 → 临时改写 → 渲染完恢复」会把保存时的
        // undefined 还原回去，_cw 从此丢失 —— 地图画不出来、准星选点全废，
        // 而且是时序敏感的间歇性故障（真机偶发「地图一片空白」）。
        // 与 _map 同用 'map not ready'，页面已有的 150ms×3 重试直接接管。
        if (!this._map || !this._init) {
          reject(new Error('map not ready'));
          return;
        }
        if (typeof wx.createOffscreenCanvas !== 'function') {
          reject(new Error('offscreen canvas unavailable'));
          return;
        }

        let canvas;
        let ctx;
        try {
          canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
          ctx = canvas.getContext('2d');
        } catch (e) {
          reject(e);
          return;
        }
        if (!ctx) {
          reject(new Error('2d context unavailable'));
          return;
        }

        // _paint 会改写这些实例状态；渲染完必须原样还回去，否则可见地图会跳到全图视角
        const prev = {
          ctx: this._ctx,
          cw: this._cw,
          ch: this._ch,
          view: this._view,
          labels: this._labels,
          clusters: this._clusters,
          theme: this._theme,
          activeId: this.data.activeId,
          pending: this.data.pending
        };
        let settled = false;
        const restore = () => {
          this._ctx = prev.ctx;
          this._cw = prev.cw;
          this._ch = prev.ch;
          this._view = prev.view;
          this._labels = prev.labels;
          this._clusters = prev.clusters;
          this._theme = prev.theme;
          this.data.activeId = prev.activeId;
          this.data.pending = prev.pending;
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          restore();
          reject(err);
        };

        const logicalW = 390;
        const logicalH = 312;   // 390 / 1.25，和输出同为 5:4

        try {
          this._ctx = ctx;
          this._cw = logicalW;
          this._ch = logicalH;
          // 分享卡固定用浅色主题：品牌卡是暖白底，深色地图卡在聊天里会显得突兀；
          // 接收方不一定开着深色模式，卡片内容也不该跟着发件人的主题变。
          this._theme = 'light';
          // 分享卡不显示「选中某只」的光环，也不显示选点模式的准星针
          this.data.activeId = '';
          this.data.pending = null;

          // 与 _fit() 同一套口径：按校园边界适配，四周留 16px；
          // 但不写 _fitK / _fittedK —— 那两个是可见画布的缩放上下限，不能被卡片覆盖。
          const m = this._map;
          let fx = 0, fy = 0, fw = m.W, fh = m.H;
          if (m.bounds) {
            const bb = m.bounds.bbox || uvBBox(m.bounds.uv);
            fx = bb.x0 * m.W;
            fy = bb.y0 * m.H;
            fw = (bb.x1 - bb.x0) * m.W;
            fh = (bb.y1 - bb.y0) * m.H;
          }
          if (fw <= 0 || fh <= 0) { fw = m.W; fh = m.H; fx = 0; fy = 0; }
          const pad = 16;
          const k = Math.min((logicalW - pad * 2) / fw, (logicalH - pad * 2) / fh);
          this._view = {
            k,
            x: (logicalW - fw * k) / 2 - fx * k,
            y: (logicalH - fh * k) / 2 - fy * k
          };
          this._labels = [];
          this._clusters = [];

          ctx.scale(width / logicalW, height / logicalH);
          this._paint();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        } catch (e) {
          fail(e);
          return;
        }

        // 画面已经画进离屏 canvas，可见状态立刻还原：
        // 导出回调是异步的（最坏 3 秒），不能让「清掉选中态」一直挂到回调回来，
        // 否则用户在这期间点猫，光环/选中卡片会莫名其妙丢一下。
        restore();

        // 部分环境（PC 开发者工具 / 离屏 Canvas 不可用）回调永远不来，超时后回退品牌卡
        const timer = setTimeout(() => fail(new Error('canvas export timeout')), 3000);
        try {
          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width,
            height,
            destWidth: width,
            destHeight: height,
            fileType: 'jpg',
            quality: 0.9,
            success: (res) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              restore();
              resolve(res.tempFilePath);
            },
            fail: (err) => {
              clearTimeout(timer);
              fail(err);
            }
          }, this);
        } catch (e) {
          clearTimeout(timer);
          fail(e);
        }
      });
    },

    /**
     * 把镜头聚焦到所有猫所在的区域 —— 浏览页的默认视角。
     *
     * 底图 1580x840（约 1.9:1 横躺）而画布是竖屏（0.55:1），两者差近 4 倍，
     * 「填满画面」和「15 只猫一只不裁」天然冲突。这里**分轴各求一个倍率，取小的**：
     *
     *   - **kFill 纵向撑满**：把校园高度放到画布高度。这就是选点页观感的来源 ——
     *     楼很大、名字清楚，不存在「整张图缩在中间」。
     *   - **kCats 横向装下猫群**：可视宽度刚好够放猫群 + 左右各留一点边距。
     *     这条有闭式解（宽度只跟 k 成反比），不用凑余量系数。
     *
     * 取 min 的意思是「先满足纵向的视觉需求，横向不够就退让到刚好不裁猫」。
     * 实测线上 15 只猫挤在综合楼旁：kFill≈0.85、kCats≈0.74 → 取 0.74，
     * 校园纵向占画布 81%（原来只 49%），猫一只不少。
     *
     * 猫真铺满校园时 kCats 会小到 fitK 以下，那就老老实实回全图认方向感，
     * 上下留白是校园本身宽扁的事实，不该为了填满把猫挤出屏。
     */
    fitToMarks() {
      const m = this._map;
      if (!this._init || !m || !this._cw) return false;
      const valid = (this.data.marks || []).filter(mk => !isNil(mk.u) && !isNil(mk.v));
      if (!valid.length) return false;

      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const mk of valid) {
        if (mk.u < u0) u0 = mk.u;
        if (mk.v < v0) v0 = mk.v;
        if (mk.u > u1) u1 = mk.u;
        if (mk.v > v1) v1 = mk.v;
      }

      const bb = m.bounds && m.bounds.bbox || { x0: 0, y0: 0, x1: 1, y1: 1 };
      const campusH = Math.max(1, (bb.y1 - bb.y0) * m.H);
      const MARGIN = 22;                                     // 左右各留：针半径 + 余量
      const V_PAD = 24;                                      // 上下留一点，别让校园顶到画布边
      // EPS 只防 0，**不能拿 1 当下限** —— 合法倍率都在 0.2~0.9 之间，抬到 1 会把所有视角顶爆
      const EPS = 1e-4;
      const kFill = Math.max(EPS, (this._ch - V_PAD * 2) / campusH);
      const spanW = Math.max(1, (u1 - u0) * m.W);
      const kCats = Math.max(EPS, (this._cw - MARGIN * 2) / spanW);

      const fitK = this._fitK || Math.min(kCats, kFill);
      let k = Math.min(kCats, kFill);
      if (k < fitK) k = fitK;                                // 猫铺满校园 → 回全图
      k = Math.min(k, this._maxScale());
      this._fittedK = k;   // 浏览页「该用多大倍率」的结论，供 centerOnMark 复用

      this._view.k = k;
      this._view.x = this._cw / 2 - (u0 + u1) / 2 * m.W * k;
      this._view.y = this._ch / 2 - (v0 + v1) / 2 * m.H * k;
      this._clamp();
      this.draw();
      return true;
    },

    /**
     * 重新量画布尺寸并重绘（保持当前镜头与缩放，不重置为全图）。
     *
     * 底部区域会在「猫列表」和「选中卡片」之间切换，两者高度不同 →
     * 地图区高度跟着变。`type="2d"` 的画布在尺寸变了之后必须重设
     * canvas.width/height 并重算 dpr 缩放，否则内容会错位/拉伸。
     * 注意：不能直接调 _initCanvas()，因为 _initCanvas() 会调 _fit() 把镜头打回全图！
     */
    resize() {
      if (!this._init || !this._canvas || !this._ctx) {
        this._initCanvas();
        return;
      }
      const query = this.createSelectorQuery();
      query.select('#campusCanvas').fields({ size: true });
      query.select('#campusCanvas').boundingClientRect(r => { this._rect = r; });
      query.exec(res => {
        if (!res || !res[0] || !res[0].width || !res[0].height) return;
        const nw = res[0].width, nh = res[0].height;
        if (Math.abs(nw - this._cw) < 1 && Math.abs(nh - this._ch) < 1) return;
        const dx = (nw - this._cw) / 2;
        const dy = (nh - this._ch) / 2;
        this._cw = nw;
        this._ch = nh;
        const dpr = this._dpr || 2;
        this._canvas.width = nw * dpr;
        this._canvas.height = nh * dpr;
        this._ctx.scale(dpr, dpr);
        this._view.x += dx;
        this._view.y += dy;
        this._clamp();
        this.draw();
      });
    },

    /**
     * 这坨猫靠放大能不能拆开？
     *
     * 拆不开的情况比想象中常见：好几只猫常常是**在同一个地方分别打卡记下的**，
     * 记下来的坐标一模一样，那么放大到多少倍它们都还是同一个球。
     * 这种时候「点一下放大一点」只会让地图莫名其妙冲进去，针还是那一坨、
     * 第二只永远点不到 —— 所以动手放大之前得先问一句能不能拆。
     *
     * 判据：放到最大倍率时，成员之间能达到的最大屏幕距离是否超过两根针的宽度。
     * 与 _clusterMarks 的阈值（34px）同源，这里要的是「确定拆得开」，
     * 所以取两根聚合针的直径（CLUSTER_R * 2）留足余量，宁可少放也别白放。
     */
    clusterWillSplit(ids) {
      if (!this._init || !this._map || !ids || ids.length < 2) return false;
      const marks = (this.data.marks || []).filter(mk => ids.indexOf(mk.id) !== -1);
      if (marks.length < 2) return false;
      const kMax = this._maxScale();
      let maxD = 0;
      for (let i = 0; i < marks.length; i++) {
        for (let j = i + 1; j < marks.length; j++) {
          const dx = (marks[i].u - marks[j].u) * this._map.W * kMax;
          const dy = (marks[i].v - marks[j].v) * this._map.H * kMax;
          const d = Math.hypot(dx, dy);
          if (d > maxD) maxD = d;
        }
      }
      return maxD > CLUSTER_R * 2;
    },

    /**
     * 点开一坨猫：以这坨的重心为中心放大。
     *
     * @returns {boolean} 是否真的放大了。放大了也拆不开、或已经到最大缩放时返回 false，
     *   由页面决定怎么处理（当前是把这一坨的猫列出来）—— 组件不替页面做产品决定。
     */
    zoomOnCluster(ids) {
      if (!this._init || !this._cw || !ids || !ids.length) return false;
      const marks = (this.data.marks || []).filter(mk => ids.indexOf(mk.id) !== -1);
      if (!marks.length) return false;

      const maxK = this._maxScale();
      if (this._view.k >= maxK - 1e-6) return false;   // 已经放到最大
      // 同一处打卡的几只猫：再放大也是那一坨，不放（放了在页面上看不出任何变化）
      if (!this.clusterWillSplit(ids)) return false;

      const m = this._map;
      const cu = marks.reduce((s, mk) => s + mk.u, 0) / marks.length;
      const cv = marks.reduce((s, mk) => s + mk.v, 0) / marks.length;

      // 一次放 1.8 倍，够把挨着的几只散开，又不至于跳得太狠
      const k = Math.min(maxK, this._view.k * 1.8);
      this._view.k = k;
      this._view.x = this._cw / 2 - cu * m.W * k;
      this._view.y = this._ch / 2 - cv * m.H * k;
      this._clamp();
      this.draw();
      return true;
    },

    /**
     * 把某个猫标记移到画布正中（底部列表点选用）。
     * 只保证「不比浏览页算出的倍率更小」—— 用户自己放大过就尊重用户，
     * 刚点过「全图」再点猫才自动拉回那个倍率。
     */
    centerOnMark(id) {
      if (!this._init || !this._cw) return false;
      const mk = (this.data.marks || []).find(x => x.id === id);
      if (!mk || isNil(mk.u) || isNil(mk.v)) return false;
      const m = this._map;
      const floor = this._fittedK || this._fitK || this._view.k;
      const targetK = Math.min(this._maxScale(), Math.max(this._view.k, floor));
      this._view.k = targetK;
      this._view.x = this._cw / 2 - mk.u * m.W * targetK;
      this._view.y = this._ch / 2 - mk.v * m.H * targetK;
      this._clamp();
      this.draw();
      return true;
    },

    /* ══════════ 渲染 ══════════ */

    draw() {
      if (!this._init || !this._ctx || !this._map) return;
      if (this._raf) return;
      // 合并同一帧内的多次调用（拖动时高频触发）
      this._raf = setTimeout(() => {
        this._raf = null;
        // 这 16ms 里页面可能已经卸载 / 画布被销毁：回调里必须再查一次，
        // 否则 _paint 会拿着 null 的 _ctx 调 clearRect。
        if (!this._ctx || !this._map) return;
        this._paint();
      }, 16);
    },

    _paint() {
      // 直接调用（分享图离屏重画）和定时回调都会进来；ctx 没了就安静退出，
      // 不让一个已卸载的组件把整个小程序错误栈刷满。
      if (!this._ctx || !this._map) return;
      const ctx = this._ctx;
      const T = THEME[this._theme] || THEME.light;
      const m = this._map;

      ctx.clearRect(0, 0, this._cw, this._ch);

      // 校外底色 + 暗角渐变。校园是 2:1 横躺而画布是竖屏，上下必然各留一条空带；
      // 平涂一块死色会被看成「画布没画完」，压个暗角之后视线自然收到中间的校园上，
      // 留白就成了刻意的取景框。
      ctx.fillStyle = T.outside || T.campus;
      ctx.fillRect(0, 0, this._cw, this._ch);
      if (m.bounds) {
        const bb = m.bounds.bbox || uvBBox(m.bounds.uv);
        const cx = (bb.x0 + bb.x1) / 2 * m.W * this._view.k + this._view.x;
        const cy = (bb.y0 + bb.y1) / 2 * m.H * this._view.k + this._view.y;
        const r0 = Math.min(this._cw, this._ch) * 0.3;
        const r1 = Math.max(this._cw, this._ch) * 0.72;
        const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, T.vignette || 'rgba(90,70,50,.12)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, this._cw, this._ch);
      }

      // 校园本体带投影：让边界从底色里「浮」起来，而不是一块被裁掉的色块
      if (m.bounds) {
        ctx.save();
        if (T.campusShadow) {
          ctx.shadowColor = T.campusShadow;
          ctx.shadowBlur = 20;
          ctx.shadowOffsetY = 7;
        }
        this._poly(m.bounds.uv, T.campus, null, 0);
        ctx.restore();
      }

      this._labels = [];
      const k = this._view.k;

      // 绿地
      (m.greens || []).forEach(f => this._poly(f.uv, T.greenFill, T.greenStroke, 1));
      // 道路
      (m.roads || []).forEach(f => this._poly(f.uv, T.roadFill, T.roadStroke, 1));
      // 运动场（操场 / 球场）
      (m.sports || []).forEach(f => this._poly(f.uv, T.sportFill, T.sportStroke, 1));
      // 建筑：先向下偏移 1.5px 画一层浅投影制造厚度，再画本体
      const tint = KIND_TINT[this._theme] || KIND_TINT.light;
      if (T.buildShadow) {
        ctx.save();
        ctx.translate(0, 1.5);
        (m.buildings || []).forEach(f => this._poly(f.uv, T.buildShadow, null, 0));
        ctx.restore();
      }
      (m.buildings || []).forEach(f => {
        this._poly(f.uv, tint[f.kind] || tint.other, T.buildStroke, 1);
      });
      // 边界
      if (m.bounds) {
        ctx.setLineDash([7, 5]);   // 固定屏幕像素；不要除以 k
        this._poly(m.bounds.uv, null, T.boundary, 2);
        ctx.setLineDash([]);
      }

      // 聚合猫针 → 再登记占位 → 再画建筑名。
      // 顺序很重要：反过来的话就是「谁先画谁占位」，建筑名会把针压住，
      // 而针是这一页的主体内容，必须优先。
      this._clusterMarks();
      this._reserveMarks();

      // 建筑名（缩放够大才画，且做避让）
      if (k >= LABEL_MIN_SCALE) {
        this._labelOrder.forEach(f => {
          if (f.name) this._labelAt(f.anchor.u, f.anchor.v, f.name, T, 11);
        });
      }
      // POI
      (m.pois || []).forEach(p => {
        const s = this._toScreen(p.u, p.v);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = T.boundary;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
        if (k >= LABEL_MIN_SCALE && p.name) {
          this._labelAt(p.u, p.v, p.name, T, 11, s.x + 9, s.y, 'left');
        }
      });

      // 猫标记：按聚合结果画，单只画针、多只画带数字的针
      for (const g of this._clusters) {
        if (g.marks.length === 1) {
          this._mark(g.marks[0], T);
        } else {
          this._cluster(g, T);
        }
      }

      // 选点预览：外卖同款水滴针
      const pending = this.data.pending;
      if (pending && !isNil(pending.u)) {
        const cross = this.data.crosshair;
        // 准星模式下针钉在「可见区域」正中，针尖以下留给底部抽屉
        const s = cross ? this._pinPoint() : this._toScreen(pending.u, pending.v);
        this._pin(s.x, s.y, T, this._pinScale || 1);
        if (pending.label && !cross) {
          this._labelAt(pending.u, pending.v, pending.label, T, 12, s.x, s.y + 34);
        }
      }
    },

    /**
     * 水滴针：圆头 + 尖底 + 落地投影。
     *
     * 这是外卖/打车选点那种「看起来就是个可抓的把手」的形状 ——
     * 比圆点更像可交互，比箭头更像位置。
     *
     * **(x, y) 是针尖**，不是圆头中心 —— 针尖才是「这个坐标在这儿」的那一点。
     * 圆头整体往上让 PIN_TIP_DROP 个半径（见常量处的说明）。
     * scale 用于入场动画（0→1 弹一下）。
     *
     * @returns {{x:number,y:number}} 圆头中心（猫爪等针芯装饰要跟着它走）
     */
    _pin(x, y, T, scale, color) {
      const ctx = this._ctx;
      const s = Math.max(0.05, scale === undefined ? 1 : scale);
      const R = PIN_R * s;
      const tipY = y;                      // 传入的坐标就是针尖
      const headY = tipY - R * PIN_TIP_DROP;   // 圆头在针尖上方
      const fill = color || T.markRing;

      ctx.save();

      // 落地投影：针尖下方的软椭圆，让针「浮」起来
      ctx.beginPath();
      ctx.ellipse(x, tipY + 3 * s, R * 0.46, R * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexA('#3A2A20', 0.18 * s);
      ctx.fill();

      // 尖底
      ctx.beginPath();
      ctx.moveTo(x - R * 0.74, headY + R * 0.58);
      ctx.lineTo(x, tipY);
      ctx.lineTo(x + R * 0.74, headY + R * 0.58);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      // 圆头
      ctx.beginPath();
      ctx.arc(x, headY, R, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // 内芯白点
      ctx.beginPath();
      ctx.arc(x, headY, R * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();

      ctx.restore();
      return { x, y: headY };
    },

    /** 选点针入场：从下方弹上来（easeOutBack），弹一下就停 */
    _playPinIn() {
      if (this._pinAnim) clearTimeout(this._pinAnim);
      const DUR = 320;
      const start = Date.now();
      const step = () => {
        const t = Math.min(1, (Date.now() - start) / DUR);
        // easeOutBack：末段回弹一下，是「啪」落位的手感
        const c1 = 1.70158, c3 = c1 + 1;
        const e = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        this._pinScale = e;
        this.draw();
        if (t < 1) {
          this._pinAnim = setTimeout(step, 16);
        } else {
          this._pinScale = 1;
          this._pinAnim = null;
          this.draw();
        }
      };
      this._pinScale = 0.05;
      step();
    },

    _path(uv) {
      const ctx = this._ctx;
      ctx.beginPath();
      const p0 = this._toScreen(uv[0][0], uv[0][1]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < uv.length; i++) {
        const p = this._toScreen(uv[i][0], uv[i][1]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    },

    _poly(uv, fill, stroke, lw) {
      if (!uv || uv.length < 3) return;
      const ctx = this._ctx;
      this._path(uv);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    },

    /** 圆角矩形路径（小程序 2D canvas 不一定有原生 roundRect，手画 4 段圆弧最稳） */
    _roundRect(x, y, w, h, r) {
      const ctx = this._ctx;
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    },

    /**
     * 标签 + 矩形避让：与已画标签重叠就跳过，避免糊成一团。
     * highlight=true 时跳过避让并用珊瑚底白字，保证当前选中猫的名字永远可见。
     *
     * 贴边的一律不画：横向拖动时建筑名会被画布边缘切成半截字，比不显示更难看。
     * 选中猫的名字是例外（它必须可见）。
     */
    _labelAt(u, v, text, T, fs, forceX, forceY, align, highlight) {
      const ctx = this._ctx;
      const anchor = this._toScreen(u, v);
      const x = !isNil(forceX) ? forceX : anchor.x;
      const y = !isNil(forceY) ? forceY : anchor.y;
      ctx.font = (highlight ? '600 ' : '500 ') + fs + 'px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = align || 'center';
      const w = ctx.measureText(text).width;
      const padX = 6, padY = 3.5;
      const left = align === 'left' ? x - padX : x - w / 2 - padX;
      const rect = { l: left, t: y - fs / 2 - padY, r: left + w + padX * 2, b: y + fs / 2 + padY };
      if (!highlight) {
        if (rect.l < 2 || rect.r > this._cw - 2 || rect.t < 2 || rect.b > this._ch - 2) return;
        for (let i = 0; i < this._labels.length; i++) {
          const o = this._labels[i];
          if (rect.l < o.r && rect.r > o.l && rect.t < o.b && rect.b > o.t) return;
        }
      }
      this._labels.push(rect);
      const rw = rect.r - rect.l, rh = rect.b - rect.t;
      this._roundRect(rect.l, rect.t, rw, rh, rh / 2);
      ctx.fillStyle = highlight ? T.markRing : T.labelBg;
      ctx.fill();
      if (!highlight && T.labelBorder) {
        ctx.strokeStyle = T.labelBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = highlight ? '#FFFFFF' : T.label;
      ctx.fillText(text, x, y);
    },

    /**
     * 把屏幕距离过近的猫针聚成一组。
     *
     * 为什么必须做：针叠在一起时只能点到最上面那个，底下的永远点不到；
     * 视觉上也会糊成一坨。这是地图类页面的通病，标准做法就是聚合。
     *
     * 分组用「首成员位置」当锚点，不用实时重心 —— 重心会随加入顺序漂移，
     * 同样的数据分两次可能得到不同分组，那种不确定性很难查。
     */
    _clusterMarks() {
      const R = 34;   // 屏幕像素：小于这个距离就算一坨
      const groups = [];
      const activeId = this.data.activeId || '';
      let activeGroup = null;
      const marks = this.data.marks || [];
      for (const mk of marks) {
        if (isNil(mk.u) || isNil(mk.v)) continue;
        const s = this._toScreen(mk.u, mk.v);
        // 当前选中的猫永远独立成组并放在最顶层画，避免点中后反而被吞进「9」号聚合球里看不见
        if (activeId && mk.id === activeId) {
          activeGroup = { x: s.x, y: s.y, u: mk.u, v: mk.v, marks: [mk] };
          continue;
        }
        let hit = null;
        for (const g of groups) {
          if (Math.hypot(g.x - s.x, g.y - s.y) <= R) { hit = g; break; }
        }
        if (hit) hit.marks.push(mk);
        else groups.push({ x: s.x, y: s.y, u: mk.u, v: mk.v, marks: [mk] });
      }
      if (activeGroup) groups.push(activeGroup);
      this._clusters = groups;
      return groups;
    },

    /**
     * 把猫针的占位登记进标签避让表。
     *
     * 按**聚合后的组**登记，因为实际画出来的就是组：单只 = 一个针，
     * 多只 = 一个带数字的针。登记原始针的话，被聚合掉的那些会白占位置、
     * 把建筑名挤到没必要的远处。
     *
     * 箱体覆盖整根针（针尖 g.y → 圆头顶 g.y - 2.5R），**不含**针下方的猫名标签 ——
     * 含进去的话针会把自己的名字挤掉。所以猫名标签的 y 偏移（+30）
     * 必须大于这里的下边界（+8）。
     */
    _reserveMarks() {
      for (const g of this._clusters || []) {
        const R = g.marks.length === 1 ? PIN_R : CLUSTER_R;
        this._labels.push({ l: g.x - R - 2, t: g.y - R * (1 + PIN_TIP_DROP) - 2, r: g.x + R + 2, b: g.y + 8 });
      }
    },

    /**
     * 聚合针：比单只的针大一圈，芯里写数量。
     * 不画猫爪 —— 一坨里有多只猫，画谁的爪都不对。
     * 同样以针尖为锚（g.y），圆头在针尖上方。
     */
    _cluster(g, T) {
      const ctx = this._ctx;
      const R = CLUSTER_R;
      const tipY = g.y;
      const headY = tipY - R * PIN_TIP_DROP;

      ctx.save();
      // 落地投影
      ctx.beginPath();
      ctx.ellipse(g.x, tipY + 3, R * 0.46, R * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexA('#3A2A20', 0.2);
      ctx.fill();
      // 尖底 + 圆头
      ctx.beginPath();
      ctx.moveTo(g.x - R * 0.74, headY + R * 0.58);
      ctx.lineTo(g.x, tipY);
      ctx.lineTo(g.x + R * 0.74, headY + R * 0.58);
      ctx.closePath();
      ctx.fillStyle = T.markRing;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(g.x, headY, R, 0, Math.PI * 2);
      ctx.fillStyle = T.markRing;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // 数量
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(g.marks.length), g.x, headY + 1);
      ctx.restore();
    },

    _mark(mk, T) {
      const ctx = this._ctx;
      const s = this._toScreen(mk.u, mk.v);
      const lost = mk.status === 'lost' || mk.status === 'deceased';
      const active = mk.id === this.data.activeId;

      ctx.save();
      if (active) {
        // 选中：外扩一圈珊瑚色光环，和水滴针叠在一起
        ctx.beginPath();
        ctx.arc(s.x, s.y - PIN_R * PIN_TIP_DROP, 22, 0, Math.PI * 2);
        ctx.fillStyle = hexA(T.markRing, 0.22);
        ctx.fill();
      }
      ctx.restore();

      // 水滴针本体（走失/离世用灰）。针尖正好落在猫的坐标上。
      const head = this._pin(s.x, s.y, T, active ? 1.06 : 1, lost ? T.markLost : T.markRing);

      // 针芯放猫爪，而不是白点 —— 跟着 _pin 返回的圆头中心走
      ctx.save();
      ctx.translate(head.x, head.y);
      ctx.scale(1.25, 1.25);
      this._paw(0, 0);
      ctx.restore();

      if (mk.name && (active || this._view.k >= LABEL_MIN_SCALE * 0.8)) {
        // +30：必须大于 _reserveMarks 里占位框的下边界（+8），
        // 否则自己的占位框会把自己的名字挤掉
        this._labelAt(mk.u, mk.v, mk.name, T, 12, s.x, s.y + 30, 'center', active);
      }
    },

    /** 简化猫爪：4 趾 + 掌垫 */
    _paw(x, y) {
      const ctx = this._ctx;
      ctx.fillStyle = '#FFFFFF';
      const toe = (dx, dy, rr) => {
        ctx.beginPath();
        ctx.ellipse(x + dx, y + dy, rr, rr * 1.25, 0, 0, Math.PI * 2);
        ctx.fill();
      };
      toe(-4.2, -3.1, 1.6);
      toe(-1.4, -4.8, 1.6);
      toe(1.4, -4.8, 1.6);
      toe(4.2, -3.1, 1.6);
      ctx.beginPath();
      ctx.ellipse(x, y + 0.5, 3.2, 3.2 * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
    },

    /* ══════════ 命中检测 ══════════ */

    /**
     * 点是否落在某根针上（单只或聚合都行）。
     *
     * 针是「针尖在下、圆头在上」的一段竖直区域，不是一个点：
     * 只测针尖 → 按在圆头上点空；只测圆头 → 按针尖点空。两处都测才点得中。
     */
    _pinHit(g, x, y, r) {
      const R = g.marks.length === 1 ? PIN_R : CLUSTER_R;
      const rr = Math.max(r, R);
      const tip = Math.hypot(g.x - x, g.y - y) <= rr;
      const head = Math.hypot(g.x - x, g.y - R * PIN_TIP_DROP - y) <= rr;
      return tip || head;
    },

    /**
     * 按优先级命中：猫标记 → POI → 建筑 → 道路 → 绿地
     * 标记用屏幕距离判定，保证手指点得中；多边形走 归一化坐标 + 射线法。
     */
    _hitTest(x, y) {
      const m = this._map;
      if (!m) return null;
      const touchR = 22;

      // 1) 猫标记（按聚合结果判定：点到一坨就返回整坨，而不是其中一只）
      for (let i = (this._clusters || []).length - 1; i >= 0; i--) {
        const g = this._clusters[i];
        if (!this._pinHit(g, x, y, touchR)) continue;
        if (g.marks.length === 1) {
          return { type: 'mark', id: g.marks[0].id, data: g.marks[0] };
        }
        return {
          type: 'cluster',
          ids: g.marks.map(mk => mk.id),
          data: g.marks
        };
      }
      // 2) POI
      for (let i = (m.pois || []).length - 1; i >= 0; i--) {
        const p = m.pois[i];
        const s = this._toScreen(p.u, p.v);
        if (Math.hypot(s.x - x, s.y - y) <= touchR) {
          return { type: 'poi', data: p };
        }
      }
      // 3) 几何（建筑 → 道路 → 绿地）
      const uv = this._toUV(x, y);
      const layers = ['buildings', 'roads', 'sports', 'greens'];
      for (let li = 0; li < layers.length; li++) {
        const arr = m[layers[li]] || [];
        // 先用包围盒粗筛（特征数不多，直接线性扫也够快）
        for (let i = arr.length - 1; i >= 0; i--) {
          const f = arr[i];
          if (!bboxHit(f.bbox, uv.u, uv.v)) continue;
          if (pointInPoly(uv.u, uv.v, f.uv)) {
            return { type: layers[li], data: f };
          }
        }
      }
      // 4) 边界兜底：点在校园内但没命中任何要素
      if (m.bounds && pointInPoly(uv.u, uv.v, m.bounds.uv)) {
        return { type: 'campus' };
      }
      return { type: 'outside' };
    },

    /* ══════════ 手势 ══════════ */

    onTouchStart(e) {
      const t = (e.touches || [])[0];
      if (!t || !this._init) return;
      this._gesture = null;
      if (e.touches.length >= 2) {
        this._gesture = this._pinchState(e.touches);
      } else {
        this._gesture = {
          mode: 'pan',
          startX: t.clientX, startY: t.clientY,
          originX: this._view.x, originY: this._view.y,
          moved: false
        };
      }
    },

    onTouchMove(e) {
      const g = this._gesture;
      if (!g || !this._init) return;

      if (g.mode === 'pinch') {
        // 双指中途抬起一根（WeChat 会先发 touchend，但保险起见这里也兜一下）
        if (e.touches.length < 2) {
          const t = e.touches[0];
          if (t) {
            this._gesture = {
              mode: 'pan',
              startX: t.clientX, startY: t.clientY,
              originX: this._view.x, originY: this._view.y,
              moved: true        // 已经动过了，松手时不该算点击
            };
          }
          return;
        }

        const n = this._pinchState(e.touches);
        const minK = this._minScale();
        const maxK = this._maxScale();
        const k = Math.max(minK, Math.min(maxK, g.k0 * (n.dist / g.dist)));

        // 绝对定位：把「起始中点下方的那个地图点」放到「当前中点下方」。
        // 全程只依赖 g 里的起始值，跟上一帧的结果无关，所以不会累积漂移。
        const mx = (g.midX - g.originX) / g.k0;
        const my = (g.midY - g.originY) / g.k0;
        this._view.k = k;
        this._view.x = n.midX - mx * k;
        this._view.y = n.midY - my * k;

        this._clamp();
        this.draw();
        return;
      }

      const t = (e.touches || [])[0];
      if (!t) return;
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) g.moved = true;
      if (!g.moved) return;
      this._view.x = g.originX + dx;
      this._view.y = g.originY + dy;
      this._clamp();
      this.draw();

      // 准星模式：针钉在正中，所以「拖地图」=「移针」。
      // 每帧把针下的位置抛给页面，页面同步刷新底部预览条 ——
      // 这是外卖里拖地图时地址跟着变的那一下。
      if (this.data.crosshair) this._emitCenterPick();
    },

    /** 把针（画布正中）下的位置抛给页面；校外不抛，避免刷出无效坐标 */
    _emitCenterPick() {
      const p = this.pickAtCenter();
      if (!p) {
        this.triggerEvent('pickout', {});
        return;
      }
      this.triggerEvent('pickchange', p);
    },

    onTouchEnd(e) {
      const g = this._gesture;
      const remaining = e.touches || [];

      // 捏合时抬起一根手指 → 立刻用剩下那根重新起一次平移。
      // 不做这一步的话 _gesture 被清空，地图会「粘住」直到用户完全松手重按。
      if (g && g.mode === 'pinch' && remaining.length === 1) {
        const t = remaining[0];
        this._gesture = {
          mode: 'pan',
          startX: t.clientX, startY: t.clientY,
          originX: this._view.x, originY: this._view.y,
          moved: true          // 刚捏合过，松手不该算点击
        };
        return;
      }

      this._gesture = null;
      if (!g || !this._init) return;

      const changed = (e.changedTouches || [])[0];
      // 拖动过 → 只是平移，不触发点击
      if (g.mode !== 'pan' || g.moved || !changed) return;

      const rect = this._canvasRect();
      if (!rect) return;
      const x = changed.clientX - rect.left;
      const y = changed.clientY - rect.top;
      if (x < 0 || y < 0 || x > this._cw || y > this._ch) return;

      const hit = this._hitTest(x, y);

      if (this.data.mode === 'select') {
        // 准星模式：针已经在正中了，抬手只是确认针下那点，
        // 不该再按手指落点重选一次（那会和「拖地图移针」打架）。
        if (this.data.crosshair) {
          const p = this.pickAtCenter();
          if (!p) {
            this.triggerEvent('pickreject', { message: '要选在校内哦~' });
            return;
          }
          this.triggerEvent('pick', p);
          return;
        }
        // 选点模式：只在校内接受
        if (hit.type === 'outside') {
          this.triggerEvent('pickreject', { message: '要选在校内哦' });
          return;
        }
        const uv = this._toUV(x, y);
        this.triggerEvent('pick', {
          u: round4(uv.u), v: round4(uv.v),
          label: this._labelForHit(hit, uv.u, uv.v),
          hitType: hit.type
        });
        return;
      }

      // 浏览模式
      if (hit.type === 'mark') {
        this.triggerEvent('selectmark', { id: hit.id, data: hit.data });
      } else if (hit.type === 'cluster') {
        // 一坨猫：交给页面决定是放大还是直接选第一只
        this.triggerEvent('selectcluster', { ids: hit.ids, data: hit.data });
      } else if (hit.type === 'campus' || hit.type === 'outside') {
        this.triggerEvent('selectnone', {});
      } else {
        this.triggerEvent('selectfeature', { type: hit.type, data: hit.data });
      }
    },

    /**
     * 记录捏合手势的**起始状态**。
     *
     * 必须存下起始的 view 偏移（originX/originY）与起始缩放（k0）：
     * 每次 move 都要从「起始」重算绝对位置，而不是在上一帧的结果上叠加 ——
     * 叠加会累积误差，表现就是双指缩放时地图从手指底下滑走。
     */
    _pinchState(touches) {
      const a = touches[0], b = touches[1];
      const x1 = a.clientX, y1 = a.clientY, x2 = b.clientX, y2 = b.clientY;
      return {
        mode: 'pinch',
        dist: Math.hypot(x2 - x1, y2 - y1) || 1,
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
        k0: this._view.k,
        originX: this._view.x,
        originY: this._view.y
      };
    },

    _minScale() { return (this._fitK || 1) * 0.9; },
    _maxScale() { return (this._fitK || 1) * 8; },

    /**
     * 单轴约束。
     *
     * @param {number} pos    当前平移量
     * @param {number} local0 内容左/上边界在「本地像素」里的位置
     * @param {number} local1 内容右/下边界在「本地像素」里的位置
     * @param {number} k      当前缩放
     * @param {number} view  画布在该轴上的尺寸
     * @param {number} slack 允许越出画布的余量（0 = 内容必须盖满画布）
     * 内容比画布小 → 锁死居中（拖不动，避免校园缩在一边、旁边全是校外底色）；
     * 内容比画头大 → 平移范围刚好是「内容边缘对齐画布边缘」，再多拖就是露白。
     *
     * 余量 slack 是准星选点要的东西：区间两端各放开 slack，边界正好能走到
     * 「画布正中」那条线上，也就是针尖所在处。默认 slack=0 时行为与旧版逐位一致。
     */
    _clampAxis(pos, local0, local1, k, view, slack) {
      const s = slack || 0;
      const s0 = local0 * k, s1 = local1 * k;
      const size = s1 - s0;
      const lo = view - s1 - s;
      const hi = -s0 + s;
      // 区间退化成一点（lo >= hi）说明内容比画布还小 → 锁死居中，拖不动
      if (lo >= hi) return (view - size) / 2 - s0;
      return Math.max(lo, Math.min(hi, pos));
    },

    /**
     * 该轴允许越出画布多少（px）。
     *
     * **只有「针钉在画布正中」才需要余量** —— 针的位置完全由镜头决定，
     * 镜头走不到边界，针就永远够不着边界上的位置（点选模式针跟着手指走，用不着）。
     * 半屏是刚好的量：边界走到针下 = 内容边缘对齐画布中心，再加 EDGE_OVERSCROLL 让针
     * 能略微探出校外，给「这里在校外」一个可达的触发态。
     */
    _axisSlack(view) {
      return this.data.crosshair ? view / 2 + EDGE_OVERSCROLL : 0;
    },

    /**
     * 约束平移。
     *
     * 浏览态：校园必须盖满画布，绝不把地图拖到半出屏。
     *
     * 准星选点态反过来。若沿用浏览态的上限（校园边缘贴画布边缘），校园最外一圈
     * 就永远停在画布边上，针只能落在**内缩半屏**的范围里 —— 边界上的位置一个都选不到。
     * 校园比画布矮时更糟：整轴退化成「锁死居中」，上下完全拖不动。
     * 所以准星模式每轴多给半屏余量（见 _axisSlack）。
     */
    _clamp() {
      const m = this._map;
      if (!m) return;
      const k = this._view.k;
      const bb = m.bounds && m.bounds.bbox || { x0: 0, y0: 0, x1: 1, y1: 1 };
      const sx = this._axisSlack(this._cw);
      const sy = this._axisSlack(this._ch);
      this._view.x = this._clampAxis(this._view.x, bb.x0 * m.W, bb.x1 * m.W, k, this._cw, sx);
      this._view.y = this._clampAxis(this._view.y, bb.y0 * m.H, bb.y1 * m.H, k, this._ch, sy);
    },

    _canvasRect() {
      // _rect 在 _initCanvas 时已随 node 查询一并落库，这里只做兜底。
      // 早前版本在这里发异步查询却同步返回，首次点击时 rect 未就绪 → 坐标全错。
      return this._rect || { left: 0, top: 0 };
    }
  }
});

/* ══════════════ 几何工具（纯函数） ══════════════ */

function uvBBox(uv) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i];
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}

function bboxHit(b, x, y) {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

function uvCentroid(uv) {
  let x = 0, y = 0;
  for (let i = 0; i < uv.length; i++) { x += uv[i][0]; y += uv[i][1]; }
  return { u: x / uv.length, v: y / uv.length };
}

/** 射线法：点是否在多边形内（归一化坐标，不依赖缩放） */
function pointInPoly(x, y, uv) {
  let inside = false;
  for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) {
    const xi = uv[i][0], yi = uv[i][1];
    const xj = uv[j][0], yj = uv[j][1];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** null / undefined 统一判空（等价于 != null，但过项目的 eqeqeq 规则） */
function isNil(v) { return v === null || v === undefined; }

function round4(n) { return Math.round(n * 10000) / 10000; }

/** #RRGGBB → rgba(...) */
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
