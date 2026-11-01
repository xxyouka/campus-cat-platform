/**
 * pages/admin/components/activity-map/activity-map.js - 猫咪活动轨迹图（只读静态图）
 *
 * 数据源：images/campus-map/campus-map.js（与 campus-map 组件同一份权威底图，
 * 由 tools/campus-map-editor 导出，勿手改）。
 *
 * 与 subpackages/map/components/campus-map 的分工：那边是「可交互的寻猫地图」（拖动/缩放/选点），
 * 这边是**管理端分析页的配图**，默认不做手势、不接定位 —— 只把一次分析的
 * 结论画出来：底图 + 打卡点位（按新旧渐变）+ 聚集圈 + 最近一次标记 + 当行高亮。
 * 唯一的例外是总轨迹模式（zoomable=true）：多猫同框点位密集，双指放大 + 拖动
 * 才看得清各自的路线；单猫模式保持静态 —— 它夹在详情页的卡片流里，
 * 地图吞掉页面滚动会让整页难滑。两边的绘制代码互不 import，避免分析页的
 * 需求把寻猫地图改出回归。
 *
 * 坐标约定：点位是归一化 u/v（0~1），渲染时乘回底图像素再套视图变换，
 * 与 campus-map 完全一致（这样两边同一坐标落点必然一致）。
 *
 * 画什么由 props 决定，两种模式互斥：
 *   单猫模式（tracks 为空）——
 *     points     全部点位 [{u,v,t}]，按时间升序
 *     clusters   聚集圈 [{u,v,count,label}]（label 由页面用最近地物算好）
 *     lastPoint  最近一次 {u,v,t}（会被单独标记；点位被采样截断时仍是最新那个）
 *     highlight  高亮第 N 个点的索引（时间线点选用；-1 表示无）
 *   总轨迹模式（tracks 非空）——
 *     tracks     [{ id, name, color, points:[{u,v,t}] }]，每只猫一色
 *     focusId    聚焦的猫 id（'' = 全部等权；聚焦时其余压暗、聚焦者最后画并标名字）
 *   height     画布高度（px）；不传按 320px
 *   zone       校区（点位属于哪个校区，决定画在哪张底图上；缺省本部）
 *
 * 底图按校区取（utils/campusMapRegistry）：拿错底图不会报错、只会把点画到别处，
 * 所以点位与底图必须来自同一校区 —— 跨校区的点不要塞进同一张图。
 */
const { getMap, normalizeZone } = require('../../../../utils/campusMapRegistry');

/** 主题配色：与 campus-map / theme.json 的暖珊瑚体系一致 */
const THEME = {
  light: {
    outside: '#DFD8C9',
    campus: '#FBF7EF',
    vignette: 'rgba(88,68,48,.16)',
    campusShadow: 'rgba(96,74,52,.26)',
    sportFill: '#F2D6C4', sportStroke: '#C79272',
    greenFill: '#DDE8CE', greenStroke: '#A8C08A',
    roadFill: '#FBF7F0', roadStroke: '#E5DCC8',
    buildFill: '#F5EBD8', buildStroke: '#D9C4A3',
    boundary: '#E8927C',
    label: '#5A4A42',
    labelBg: 'rgba(255,255,255,.92)',
    labelBorder: 'rgba(139,109,79,.16)',
    markRing: '#E8927C',
    point: '#E8927C',
    highlight: '#C2553B'
  },
  dark: {
    outside: '#100E0C',
    campus: '#221D19',
    vignette: 'rgba(0,0,0,.45)',
    campusShadow: 'rgba(0,0,0,.6)',
    sportFill: '#3A2E27', sportStroke: '#6E5344',
    greenFill: '#242C22', greenStroke: '#3D4A35',
    roadFill: '#332E2A', roadStroke: '#4A433C',
    buildFill: '#2A2622', buildStroke: '#4A433C',
    boundary: '#E8927C',
    label: '#C9BFB6',
    labelBg: 'rgba(42,38,34,.92)',
    labelBorder: 'rgba(255,255,255,.10)',
    markRing: '#F0A48F',
    point: '#F0A48F',
    highlight: '#FF8E6E'
  }
};

/**
 * 轨迹连线规则：只有**同一天内间隔 ≤ 6 小时**的相邻两次打卡才连虚线。
 *
 * 跨天的直线不是轨迹，是两点的连线段——猫不是从宿舍直线走到食堂的，
 * 把几天前的点连起来会画出一条根本不存在的「路线」。宁可少画，
 * 也不给用户看一条看起来很确定、实际是编造的路径。同一天隔得远
 * （早上 7 点、晚上 11 点）大概率也不是一次连续行动，同样不连。
 */
const SEGMENT_MAX_GAP_MS = 6 * 3600 * 1000;

/** 点位新旧渐变的取值范围（px 半径 / 透明度） */
const POINT_R_MIN = 2.2;
const POINT_R_MAX = 4.5;
const POINT_A_MIN = 0.22;
const POINT_A_MAX = 0.85;

/**
 * 多猫总轨迹（tracks 模式）的透明度分层：聚焦 / 常态 / 被压暗。
 * 多条线同框时，颜色只回答「哪只是哪只」，聚焦靠明暗回答。
 */
const TRACK_SEG_A = { focus: 0.85, normal: 0.42, dim: 0.08 };
const TRACK_PT_A = { focus: 0.95, normal: 0.6, dim: 0.1 };

Component({
  options: { addGlobalClass: true },

  properties: {
    /** 全部点位 [{ u, v, t }]，按时间升序 */
    points: { type: Array, value: [] },
    /** 聚集圈 [{ u, v, count, label }]，label 可为空串 */
    clusters: { type: Array, value: [] },
    /** 最近一次 { u, v, t } */
    lastPoint: { type: Object, value: null },
    /** 高亮点的索引（-1 无） */
    highlight: { type: Number, value: -1 },
    /** 画布高度（px），0/缺省按 320px */
    height: { type: Number, value: 0 },
    /** 多猫总轨迹 [{ id, name, color, points:[{u,v,t}] }]；非空时进入总轨迹模式 */
    tracks: { type: Array, value: [] },
    /** 总轨迹模式下聚焦的猫 id（'' = 全部等权展示） */
    focusId: { type: String, value: '' },
    /** 是否开启双指缩放 / 拖动（总轨迹页用；单猫模式不绑手势，别吞页面滚动） */
    zoomable: { type: Boolean, value: false },
    /**
     * 校区：决定画在哪张底图上。点位与底图必须同一校区 ——
     * 拿错底图不会报错、只会把点画到别处（见文件头注释）。
     */
    zone: { type: String, value: '本部' }
  },

  observers: {
    zone() {
      if (!this._mapZone) return;
      if (this._mapZone === normalizeZone(this.data.zone)) return;
      this._loadMap();
      if (this._init) {
        this._fit();
        this.draw();
      }
    },
    'points, clusters, lastPoint, highlight, tracks, focusId': function () {
      this.draw();
    }
  },

  data: {
    ready: false,
    loadError: false,
    /** 视图已偏离「整校全览」→ 显示「回到全图」（只在手势结束/复位时刷新） */
    zoomed: false
  },

  lifetimes: {
    attached() {
      this._init = false;
      this._view = { k: 1, x: 0, y: 0 };
      this._fitK = null;
      this._fitX = 0;
      this._fitY = 0;
      this._gesture = null;
      this._rect = null;
      this._theme = 'light';
      this._raf = null;
      this._labels = [];
      this._loadMap();
    },
    ready() {
      this._initCanvas();
    },
    detached() {
      if (this._raf) { clearTimeout(this._raf); this._raf = null; }
      this._canvas = null;
      this._ctx = null;
    }
  },

  methods: {
    /* ══════════ 数据 ══════════ */

    /** 解析该校区的底图（每个校区各算一次）：多边形统一转成归一化 uv 数组 */
    _loadMap() {
      const zone = normalizeZone(this.data.zone);
      this._mapZone = zone;
      try {
        // 没登记的校区：宁可空着（页面按空态提示），也不回退别的校区底图
        const raw = getMap(zone);
        if (!raw) {
          this._map = null;
          this.setData({ ready: true, loadError: false });
          return;
        }
        const size = raw.imageSize || [1000, 1000];
        const W = size[0] || 1000;
        const H = size[1] || 1000;
        const prep = (arr) => (arr || [])
          .filter((f) => f && f.p && f.p.length >= 3)
          .map((f) => ({
            name: f.name || '',
            uv: f.p.map((p) => [p[0] / W, p[1] / H])
          }));

        this._map = {
          W,
          H,
          bounds: raw.bounds && raw.bounds.length >= 3
            ? { uv: raw.bounds.map((p) => [p[0] / W, p[1] / H]) }
            : null,
          sports: prep(raw.sports),
          buildings: prep(raw.buildings),
          roads: prep(raw.roads),
          greens: prep(raw.greens)
        };
        this.setData({ ready: true, loadError: false });
      } catch (err) {
        this.setData({ ready: true, loadError: true });
      }
    },

    _initCanvas() {
      const query = this.createSelectorQuery();
      query.select('#activityCanvas').fields({ node: true, size: true });
      // 位置也一并取：手势把 clientX/Y 换算到画布本地坐标要用它。
      // 必须在这里同步落库 —— 等首次触摸再异步查，第一帧的坐标就已经错了。
      query.select('#activityCanvas').boundingClientRect((r) => {
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
        this._paint();
      });
    },

    /* ══════════ 视图变换 ══════════ */

    /**
     * 适配视图：优先按**校园边界**适配，没有边界才退回整图。
     * 横竖比差异大时以短边为准（取 min 比例），保证校园完整可见。
     */
    _fit() {
      const m = this._map;
      if (!m || !this._cw) return;
      let fx = 0; let fy = 0; let fw = m.W; let fh = m.H;
      if (m.bounds) {
        const b = uvBBox(m.bounds.uv);
        if (b.x1 > b.x0 && b.y1 > b.y0) {
          fx = b.x0 * m.W; fy = b.y0 * m.H;
          fw = (b.x1 - b.x0) * m.W; fh = (b.y1 - b.y0) * m.H;
        }
      }
      if (fw <= 0 || fh <= 0) { fw = m.W; fh = m.H; fx = 0; fy = 0; }
      const pad = 14;
      const k = Math.min((this._cw - pad * 2) / fw, (this._ch - pad * 2) / fh);
      this._view.k = k;
      this._view.x = (this._cw - fw * k) / 2 - fx * k;
      this._view.y = (this._ch - fh * k) / 2 - fy * k;
      // 记下适配位：缩放下限、「回到全图」都回到这三个值
      this._fitK = k;
      this._fitX = this._view.x;
      this._fitY = this._view.y;
    },

    /** 归一化坐标 → 屏幕像素 */
    _toScreen(u, v) {
      const m = this._map;
      return {
        x: u * m.W * this._view.k + this._view.x,
        y: v * m.H * this._view.k + this._view.y
      };
    },

    /** 缩放下限：适配视图本身（再小只多一圈校外底色，没意义） */
    _kMin() { return this._fitK || 1; },

    /** 缩放上限：8× 适配（与 campus-map 同一上限；再大点位也分不开） */
    _kMax() { return (this._fitK || 1) * 8; },

    /**
     * 单轴平移约束（与 campus-map._clampAxis 同一手法，这边没有准星余量）。
     * 内容比画布小 → 锁死居中（拖不动，视图自然就是适配位）；比画布大 →
     * 平移范围刚好是「内容边缘对齐画布边缘」，再多拖就露白。
     */
    _clampAxis(pos, local0, local1, k, view) {
      const s0 = local0 * k;
      const s1 = local1 * k;
      const size = s1 - s0;
      const lo = view - s1;
      const hi = -s0;
      if (lo >= hi) return (view - size) / 2 - s0;
      return Math.max(lo, Math.min(hi, pos));
    },

    /** 约束平移：以校园边界（没有边界就用整图）为限，校园不许被拖出画布 */
    _clampView() {
      const m = this._map;
      if (!m) return;
      const b = m.bounds ? uvBBox(m.bounds.uv) : { x0: 0, y0: 0, x1: 1, y1: 1 };
      this._view.x = this._clampAxis(this._view.x, b.x0 * m.W, b.x1 * m.W, this._view.k, this._cw);
      this._view.y = this._clampAxis(this._view.y, b.y0 * m.H, b.y1 * m.H, this._view.k, this._ch);
    },

    /* ══════════ 手势（zoomable：总轨迹页；单猫模式渲染层就不绑） ══════════ */

    /** 触摸点 → 画布本地坐标（client 减画布矩形；与 campus-map 同一换算） */
    _touchLocal(t) {
      const r = this._rect || { left: 0, top: 0 };
      return { x: t.clientX - (r.left || 0), y: t.clientY - (r.top || 0) };
    },

    onTouchStart(e) {
      if (!this.data.zoomable || !this._init) return;
      const t = (e.touches || [])[0];
      if (!t) return;
      // 画布矩形会随页面滚动变化：每次手势开始重新量一次（异步，赶上哪帧算哪帧）。
      // 不刷新的话，滚动过页面之后捏合的锚点会整体偏掉「滚过的距离」那么大。
      this._refreshRect();
      this._gesture = (e.touches || []).length >= 2
        ? this._pinchState(e.touches)
        : {
          mode: 'pan',
          startX: t.clientX, startY: t.clientY,
          originX: this._view.x, originY: this._view.y
        };
    },

    onTouchMove(e) {
      const g = this._gesture;
      if (!g || !this.data.zoomable || !this._init) return;

      if (g.mode === 'pinch') {
        // 双指中途抬起一根（WeChat 会先发 touchend，这里也兜一下）
        if (e.touches.length < 2) {
          const t = e.touches[0];
          if (t) {
            this._gesture = {
              mode: 'pan',
              startX: t.clientX, startY: t.clientY,
              originX: this._view.x, originY: this._view.y
            };
          }
          return;
        }

        // 绝对定位：把「起始中点下方的那个地图点」放到「当前中点下方」。
        // 每帧都从 g 里的起始值重算，不在上一帧结果上叠加 —— 叠加会累积漂移，
        // 表现就是双指缩放时地图从手指底下滑走。
        const n = this._pinchState(e.touches);
        const k = Math.max(this._kMin(), Math.min(this._kMax(), g.k0 * (n.dist / g.dist)));
        const mx = (g.midX - g.originX) / g.k0;
        const my = (g.midY - g.originY) / g.k0;
        this._view.k = k;
        this._view.x = n.midX - mx * k;
        this._view.y = n.midY - my * k;
        this._clampView();
        this.draw();
        return;
      }

      const t = (e.touches || [])[0];
      if (!t) return;
      this._view.x = g.originX + (t.clientX - g.startX);
      this._view.y = g.originY + (t.clientY - g.startY);
      this._clampView();
      this.draw();
    },

    onTouchEnd(e) {
      const g = this._gesture;
      const remaining = e.touches || [];

      // 捏合时抬起一根 → 用剩下那根立刻接续平移；不做这一步地图会「粘住」到全部松手
      if (g && g.mode === 'pinch' && remaining.length === 1) {
        const t = remaining[0];
        this._gesture = {
          mode: 'pan',
          startX: t.clientX, startY: t.clientY,
          originX: this._view.x, originY: this._view.y
        };
        return;
      }

      this._gesture = null;
      this._syncZoomed();
    },

    /** 「回到全图」：把视图还给适配位 */
    onResetView() {
      if (!this._init || isNil(this._fitK)) return;
      this._view.k = this._fitK;
      this._view.x = this._fitX;
      this._view.y = this._fitY;
      this._syncZoomed();
      this.draw();
    },

    /**
     * 记录捏合手势的**起始状态**（起始中点/间距 + 起始缩放与偏移）。
     * 中点存画布本地坐标而不是 client：_view 是画布坐标系，直接吃 client
     * 会让缩放锚点偏掉画布在屏幕里的位置（图不在 (0,0) 时肉眼可见）。
     */
    _pinchState(touches) {
      const a = this._touchLocal(touches[0]);
      const b = this._touchLocal(touches[1]);
      return {
        mode: 'pinch',
        dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        k0: this._view.k,
        originX: this._view.x,
        originY: this._view.y
      };
    },

    /** 视图是否已偏离适配位（k 回到适配值 ⇒ 平移也必然被夹回居中）→ 控「回到全图」显隐 */
    _syncZoomed() {
      const zoomed = !!this._fitK && Math.abs(this._view.k - this._fitK) > 1e-6;
      if (zoomed !== !!this.data.zoomed) this.setData({ zoomed });
    },

    /** 重新量画布矩形（手势开始时调用；取不到就沿用旧值，最多锚点差一帧） */
    _refreshRect() {
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q || !q.select) return;
      q.select('#activityCanvas').boundingClientRect((r) => {
        if (r) this._rect = r;
      });
      if (q.exec) q.exec();
    },

    /* ══════════ 渲染 ══════════ */

    draw() {
      if (!this._init || !this._ctx || !this._map) return;
      if (this._raf) return;
      // 合并同一帧内的多次观测触发（数据到达 + 高亮变化可能同帧）
      this._raf = setTimeout(() => {
        this._raf = null;
        this._paint();
      }, 16);
    },

    _paint() {
      const ctx = this._ctx;
      const T = THEME[this._theme] || THEME.light;

      ctx.clearRect(0, 0, this._cw, this._ch);
      this._paintBackdrop(T);
      this._paintBase(T);

      // 标签避让表按帧重置：每次重画都要重新竞争位置
      this._labels = [];

      // 总轨迹模式：只画多猫线。两种模式的画法互斥 ——
      // 单猫的聚集圈/最近一次/高亮不会在总轨迹上出现（props 也传不进来）
      const tracks = (this.data.tracks || []).filter((t) => t && (t.points || []).length);
      if (tracks.length) {
        this._paintTracks(tracks, T);
        return;
      }

      // 点位按时间升序（服务端已排序，这里防御性再排一次，保证连线与渐变口径）
      const points = (this.data.points || [])
        .filter((p) => p && isFinite(p.u) && isFinite(p.v))
        .slice()
        .sort((a, b) => (a.t || 0) - (b.t || 0));

      // 画序：聚集圈（底层）→ 连线 → 点位 → 高亮 → 最近一次（最上层，压住一切）
      (this.data.clusters || []).forEach((c) => this._clusterRing(c, T));
      this._paintSegments(points, T);
      this._paintPoints(points, T);
      this._paintLast(T);
    },

    /** 校外底色 + 暗角：校园是横长形，画面上下必然留白，压个暗角把视线收到校园上 */
    _paintBackdrop(T) {
      const ctx = this._ctx;
      const m = this._map;

      ctx.fillStyle = T.outside || T.campus;
      ctx.fillRect(0, 0, this._cw, this._ch);
      if (!m.bounds) return;

      const b = uvBBox(m.bounds.uv);
      const cx = b.cx * m.W * this._view.k + this._view.x;
      const cy = b.cy * m.H * this._view.k + this._view.y;
      const r0 = Math.min(this._cw, this._ch) * 0.3;
      const r1 = Math.max(this._cw, this._ch) * 0.72;
      const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, T.vignette || 'rgba(90,70,50,.12)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this._cw, this._ch);
    },

    /** 校园本体（带投影）+ 绿地/道路/运动场/建筑 + 虚线边界 */
    _paintBase(T) {
      const ctx = this._ctx;
      const m = this._map;

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

      (m.greens || []).forEach((f) => this._poly(f.uv, T.greenFill, T.greenStroke, 1));
      (m.roads || []).forEach((f) => this._poly(f.uv, T.roadFill, T.roadStroke, 1));
      (m.sports || []).forEach((f) => this._poly(f.uv, T.sportFill, T.sportStroke, 1));
      (m.buildings || []).forEach((f) => this._poly(f.uv, T.buildFill, T.buildStroke, 1));

      if (m.bounds) {
        ctx.setLineDash([7, 5]);
        this._poly(m.bounds.uv, null, T.boundary, 2);
        ctx.setLineDash([]);
      }
    },

    /** 同一天内 ≤6h 的相邻点连虚线（见 SEGMENT_MAX_GAP_MS 的说明） */
    _paintSegments(points, T) {
      const ctx = this._ctx;
      this._segments(points).forEach(([p1, p2]) => {
        const a = this._toScreen(p1.u, p1.v);
        const b = this._toScreen(p2.u, p2.v);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = hexA(T.point, 0.5);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      });
    },

    /** 点位：越新越大越深（一眼看出最近常去哪）+ 时间线点选的高亮圈 */
    _paintPoints(points, T) {
      const ctx = this._ctx;
      const rec = recencyRange(points);
      const hl = this.data.highlight;

      points.forEach((p, i) => {
        const s = this._toScreen(p.u, p.v);
        const ratio = rec ? ((p.t || rec.min) - rec.min) / Math.max(1, rec.max - rec.min) : 1;
        const r = POINT_R_MIN + (POINT_R_MAX - POINT_R_MIN) * ratio;
        const alpha = POINT_A_MIN + (POINT_A_MAX - POINT_A_MIN) * ratio;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexA(T.point, alpha);
        ctx.fill();
        if (i !== hl) return;
        // 高亮圈 + 白边：时间线点中的那一条在任何底色上都要看得见
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = hexA(T.highlight, 0.28);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      });
    },

    /** 最近一次：双圈 + 文字标签（最上层，压在点位与线上） */
    _paintLast(T) {
      const lp = this.data.lastPoint;
      if (!lp || !isFinite(lp.u) || !isFinite(lp.v)) return;
      const ctx = this._ctx;
      const s = this._toScreen(lp.u, lp.v);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = T.highlight;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
      this._labelAt(lp.u, lp.v, '最近一次', T, 11, s.x, s.y - 16);
    },

    /**
     * 多猫总轨迹：每只猫一种颜色，连线段与单猫同规则（同一天内 ≤6h 的相邻点）。
     * 有聚焦猫时其余线路压暗、聚焦线路最后画（压在最上层），并在它的最近一个点上
     * 标名字；没有聚焦时全部等权 —— 认「谁是谁」由图例负责。
     */
    _paintTracks(tracks, T) {
      const ctx = this._ctx;
      const focusId = this.data.focusId || '';
      // 聚焦的排最后画：压在其他猫上面，不被盖住
      const ordered = focusId
        ? tracks.slice().sort((a, b) => (a.id === focusId ? 1 : 0) - (b.id === focusId ? 1 : 0))
        : tracks;
      let label = null;

      ordered.forEach((t) => {
        const pts = (t.points || [])
          .filter((p) => p && isFinite(p.u) && isFinite(p.v))
          .slice()
          .sort((a, b) => (a.t || 0) - (b.t || 0));
        if (!pts.length) return;

        const focused = !!focusId && t.id === focusId;
        const dim = !!focusId && !focused;
        const color = t.color || T.point;
        const segA = dim ? TRACK_SEG_A.dim : focused ? TRACK_SEG_A.focus : TRACK_SEG_A.normal;
        const ptA = dim ? TRACK_PT_A.dim : focused ? TRACK_PT_A.focus : TRACK_PT_A.normal;

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = hexA(color, segA);
        ctx.lineWidth = focused ? 2 : 1.4;
        this._segments(pts).forEach(([p1, p2]) => {
          const a = this._toScreen(p1.u, p1.v);
          const b = this._toScreen(p2.u, p2.v);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        });
        ctx.restore();

        const r = focused ? 3.2 : 2.4;
        pts.forEach((p) => {
          const s = this._toScreen(p.u, p.v);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fillStyle = hexA(color, ptA);
          ctx.fill();
        });

        if (focused) label = { name: t.name || '', p: pts[pts.length - 1] };
      });

      if (label && label.name) {
        const s = this._toScreen(label.p.u, label.p.v);
        this._labelAt(label.p.u, label.p.v, label.name, T, 11, s.x, s.y - 15);
      }
    },

    /**
     * 同一天内、相邻且间隔 ≤6h 的连续打卡 → 连线对。
     * @returns {Array<[object, object]>}
     */
    _segments(points) {
      const out = [];
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const gap = (b.t || 0) - (a.t || 0);
        if (gap <= 0 || gap > SEGMENT_MAX_GAP_MS) continue;
        if (localDayKey(a.t) !== localDayKey(b.t)) continue;
        out.push([a, b]);
      }
      return out;
    },

    /** 聚集圈：虚线圈 + 中心次数 + 下方地名标签 */
    _clusterRing(c, T) {
      if (!c || !isFinite(c.u) || !isFinite(c.v)) return;
      const ctx = this._ctx;
      const s = this._toScreen(c.u, c.v);
      // 点越多圈越大，封顶 26px（再大就把整个校区盖住了）
      const r = Math.min(26, 12 + Math.sqrt(c.count || 1) * 3.2);

      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(T.highlight, 0.10);
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = hexA(T.highlight, 0.75);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = T.highlight;
      ctx.font = '700 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.count || 0), s.x, s.y + 1);

      if (c.label) {
        this._labelAt(c.u, c.v, `${c.label} · ${c.count} 次`, T, 11, s.x, s.y + r + 12);
      }
    },

    _poly(uv, fill, stroke, lw) {
      if (!uv || uv.length < 3) return;
      const ctx = this._ctx;
      ctx.beginPath();
      const p0 = this._toScreen(uv[0][0], uv[0][1]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < uv.length; i++) {
        const p = this._toScreen(uv[i][0], uv[i][1]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    },

    /** 圆角矩形（小程序 2D canvas 不一定有原生 roundRect，手画最稳） */
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
     * 标签 + 矩形避让：与已画标签重叠就跳过；贴边不画（会被画布边缘切成半截字）。
     * 与 campus-map._labelAt 同一手法的精简版（那边还要服务交互高亮，参数更多）。
     */
    _labelAt(u, v, text, T, fs, forceX, forceY) {
      const ctx = this._ctx;
      const anchor = this._toScreen(u, v);
      const x = !isNil(forceX) ? forceX : anchor.x;
      const y = !isNil(forceY) ? forceY : anchor.y;
      ctx.font = '500 ' + fs + 'px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const w = ctx.measureText(text).width;
      const padX = 6;
      const padY = 3.5;
      const left = x - w / 2 - padX;
      const rect = { l: left, t: y - fs / 2 - padY, r: left + w + padX * 2, b: y + fs / 2 + padY };
      if (rect.l < 2 || rect.r > this._cw - 2 || rect.t < 2 || rect.b > this._ch - 2) return;
      for (let i = 0; i < this._labels.length; i++) {
        const o = this._labels[i];
        if (rect.l < o.r && rect.r > o.l && rect.t < o.b && rect.b > o.t) return;
      }
      this._labels.push(rect);

      const rw = rect.r - rect.l;
      const rh = rect.b - rect.t;
      this._roundRect(rect.l, rect.t, rw, rh, rh / 2);
      ctx.fillStyle = T.labelBg;
      ctx.fill();
      if (T.labelBorder) {
        ctx.strokeStyle = T.labelBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = T.label;
      ctx.fillText(text, x, y);
    }
  }
});

/* ══════════ 纯函数工具（供组件内使用，测试可直接引用） ══════════ */

/** 半透明色：'#RRGGBB' + alpha → rgba()。2D canvas 没有可靠的全局透明度继承 */
function hexA(hex, a) {
  const v = String(hex).replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function isNil(x) {
  return x === undefined || x === null;
}

/** uv 多边形的包围盒 + 中心（归一化坐标）。外接矩形足够用于取景与暗角定位 */
function uvBBox(uv) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of uv || []) {
    if (!p) continue;
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** 设备本地时区的日期键（Y-M-D）：只用于「同一天」判断，不参与展示 */
function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 时间范围（用于新旧渐变的比例尺）；空数组或全部同刻返回 null */
function recencyRange(points) {
  if (!points.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const t = p.t || 0;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!isFinite(min) || !isFinite(max) || max <= min) return null;
  return { min, max };
}
