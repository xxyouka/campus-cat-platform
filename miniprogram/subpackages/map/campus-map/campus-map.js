// subpackages/map/campus-map/campus-map.js - 校园寻猫地图
//
// 一个页面两种用法（靠 onLoad 的 options.mode 区分）：
//
//   browse（默认）独立浏览页：打开就看到所有猫在哪。点标记弹详情，点空白收起。
//   select              选点页：从 detail 页的「相遇打卡」面板跳进来，
//                       选完通过 getOpenerEventChannel 回传给对面。
//
// 选点页刻意做得很薄：**只有地图 + 中间的针 + 底部一条确定栏**。
// 不做搜索框、不做地点列表 —— 底图才 53 个图元，肉眼在图上找比打字快，
// 而且针跟着地图走的手感本身就是「一直在实时选」，再叠一层列表只会分心。
//
// 校区从「写死本部」改成了按需传入（底图登记表见 utils/campusMapRegistry）：
//   browse 浏览页：默认本部，顶部校区条可在**已有底图**的校区之间切（切页内数据源）
//   select 选点页：校区由 detail 页按猫档案传入（?zone=东区），选完原样回传
// 拿不到校区、或该校区还没画底图时一律落回本部 —— 服务端只返回该校区的猫，
// 底图与猫标记永远同一套坐标系。
const { resolveZone, availableZones, hasMap } = require('../../../utils/campusMapRegistry');
const { Logger } = require('../../../utils/logger');
const { formatTimeAgo, formatDateShort } = require('../../../utils/dateFormat');
const ShareHelper = require('../../../utils/shareHelper');
const opsTrack = require('../../../utils/opsTrack');
const guideTourBehavior = require('../../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

/**
 * 没手动选点时的地点文字。
 *
 * 进入选点页会先把全图摆好、针落在校园中心，但那只是起点，不是一次选择。
 * 用户如果直接点「确定」，记成「校园内」即可 —— 不能把默认视角冒充成
 * 「综合楼旁」这种具体地点，否则每一份没选点的打卡都会污染地点榜。
 */
const DEFAULT_PICK_LABEL = '校园内';

// 状态 → 人话。与首页/详情页保持同一套说法
const STATUS_TEXT = {
  normal: '在校',
  lost: '走失',
  adopted: '已领养',
  deceased: '已离世'
};

/**
 * 查询参数解码。
 *
 * 分享链接里的校区是百分号编码的（?zone=%E5%8C%97%E9%99%A2）；对已经解过码的
 * 值再跑一次 decodeURIComponent 仍是原值，所以这里统一过一道。畸形编码
 * （'%E4'、孤立的 '%'）会抛 URIError，而 onLoad 是同步段 —— 不兜住就是进页白屏。
 */
function safeDecode(v) {
  if (!v) return '';
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return String(v);
  }
}

Page({
  behaviors: [guideTourBehavior, safeSetDataBehavior],

  data: {
    mode: 'browse',
    // 当前校区（数据源与底图都跟着它走）。浏览页可由顶部校区条切换，
    // 选点页由 detail 按猫档案传入后固定不变。
    campusZone: '本部',
    // 可供切换的校区 = 已有底图的校区（没画底图的切过去只会是一片空白）
    zoneTabs: [],
    // 正在换校区拉数据：这段时间保留信息条（含校区切换条），
    // 否则一点「东区」整条就消失，用户看不到自己切到哪了
    switching: false,

    marks: [],
    total: 0,
    loading: true,
    loadError: false,

    // ── 选点模式 ──
    // crosshair：针钉在屏幕正中，拖地图移针（外卖选点的手感）
    crosshair: false,
    // 针下的位置 { u, v, label }；null = 当前针落在校外
    pending: null,
    // 用户是否真的动过地图/点过图。false = 针还停在默认视角的中心，
    // 确定时只回传「校园内」，不落一份假的精确坐标。
    pickTouched: false,

    // ── 浏览模式 ──
    activeId: '',
    activeCat: null,
    // 点开一坨猫时列出的名单：针叠在一起点不开、又放不大时，
    // 这是唯一能看到「这里都有谁」的地方
    clusterCats: []
  },

  onLoad(options) {
    const mode = options && options.mode === 'select' ? 'select' : 'browse';
    // 选点页的校区由 detail 传（?zone=东区）；浏览页默认本部、可在页内切。
    // 分享链接里的校区是编码过的，先解码；resolveZone 继续兜脏值：
    // 不认识的校区一律回本部，底图与猫数据都按它取。
    const zone = resolveZone(safeDecode(options && options.zone));
    this.setData({
      mode,
      crosshair: mode === 'select',
      campusZone: zone,
      zoneTabs: mode === 'browse' ? availableZones() : []
    });

    if (mode === 'browse') {
      this.loadCats();
    } else {
      // 选点页不拉猫数据：这里只需要底图，选完立刻回传，走人
      this.setData({ loading: false });
    }
  },

  /**
   * 切换校区（仅浏览页）。
   *
   * 三件事必须一起做，少一件就是错位：换数据源（loadCats 按新校区拉猫）、
   * 换底图（组件 zone 属性）、清空选中态（旧校区的猫卡片留在屏幕上会指向错误的针）。
   */
  onZoneTap(e) {
    const zone = e.currentTarget.dataset.zone;
    if (!zone || zone === this.data.campusZone) return;
    if (!hasMap(zone)) {
      wx.showToast({ title: '这个校区的地图还没画好', icon: 'none' });
      return;
    }
    this.setData({
      campusZone: zone,
      switching: true,
      activeId: '',
      activeCat: null,
      clusterCats: [],
      marks: [],
      total: 0
    });
    // 旧校区的分享快照不能留着：卡片上画的是另一张底图，发出去就是错的
    this._shareShot = null;
    this.loadCats();
  },

  onReady() {
    // 选点页也要能分享（分享路径会落回浏览模式）：先把当前校区的底图快照备好
    this._prepareShareShot();
    if (this.data.mode !== 'select') return;
    this.seedPin({ focusDefault: true });
  },

  /**
   * 落初始针。
   *
   * 不能只试一次：页面的 onReady 早于组件的 canvas 初始化完成
   * （组件要等 selectorQuery 的异步回调才把 _init 置 true），
   * 这时 resetView/pickAtCenter 全都无效，针就不出现 ——
   * 而且是**看运气**，机器快慢不同结果不同。所以轮询到组件就绪为止。
   *
   * @param {{focusDefault?: boolean, attempt?: number}} opts
   *   focusDefault 只在该页首次进入时为 true；「回到全图」不能带它，
   *   否则按钮就从「看全图」变成了「跳回某个默认点」。
   */
  seedPin(opts) {
    const o = opts || {};
    const n = o.attempt || 0;
    const c = this.mapComp();

    // 先把整个校园摆进屏幕，针落在校园中心 —— 不偏袒任何一栋楼。
    // 用户没拖动/点选之前，这只是一个起点，不能当成「选了某个具体地点」。
    if (o.focusDefault && c && typeof c.resetView === 'function') {
      c.resetView();
    }

    const p = c && typeof c.pickAtCenter === 'function' ? c.pickAtCenter() : null;
    if (p) {
      // 退避重试期间用户可能已经自己选好了：不能用默认针把他的选择盖掉。
      // 首次落针（n=0）和「回到全图」不走这个分支 —— 那两次就是要把针放回起点。
      if (n > 0 && this.data.pickTouched) return;
      this.setData({
        pending: { ...this.normPick(p), label: DEFAULT_PICK_LABEL },
        pickTouched: false
      });
      return;
    }
    // 组件还没量好尺寸 / 中心点落在校外 → 退避重试；最多 8 次（约 1.2s）
    if (n < 8) {
      if (this._seedTimer) clearTimeout(this._seedTimer);
      this._seedTimer = setTimeout(() => this.seedPin({ attempt: n + 1, focusDefault: o.focusDefault }), 150);
    }
  },

  /* ══════════ 组件句柄 ══════════ */

  /** 拿到地图组件实例；组件还没 ready 时返回 null（调用方自己兜底） */
  mapComp() {
    return this.selectComponent('#campusMap') || null;
  },

  /**
   * 预生成一张当前校区的分享卡（全校园 + 猫针，5:4）。
   *
   * 分享回调必须是同步返回的，来不及现场渲染，所以进页面/切校区/刷新数据后
   * 先备一张缓存；onShareAppMessage 只读缓存，没备好就用品牌卡。
   *
   * 组件 canvas 初始化是异步的，onReady 时不一定拿得到；轮询 3 次（约 0.45s），
   * 和 seedPin 同一套退避。渲染失败不重试 —— 离屏 Canvas 不可用时重试也没用。
   */
  _prepareShareShot(attempt = 0) {
    // 选点页没有分享菜单，快照毫无用处，还和 seedPin 抢组件的画布状态，
    // 别白跑（onReady 无条件调到这里，loadCats 只在浏览态才会走到）。
    if (this.data.mode !== 'browse') return;
    const n = attempt || 0;
    const c = this.mapComp();
    const zone = this.data.campusZone;
    // 切校区时 setData 传到组件是异步的：组件底图还停在旧校区就等下一拍，
    // 否则会把本部的图挂到东区的名字下发出去（不会报错，但内容全错）。
    const compZone = c && c.data ? c.data.mapZone : '';
    if (!c || typeof c.renderShareImage !== 'function' || compZone && compZone !== zone) {
      if (n < 3) {
        if (this._shareTimer) clearTimeout(this._shareTimer);
        this._shareTimer = setTimeout(() => this._prepareShareShot(n + 1), 150);
      }
      return;
    }
    const req = this._shareReq = (this._shareReq || 0) + 1;
    c.renderShareImage().then((path) => {
      // 切校区后旧请求才回来：丢掉，别让它覆盖新校区的卡
      if (this._shareReq !== req) return;
      this._shareShot = { zone, path };
    }).catch((err) => {
      // 组件在、但底图还没 loaded（onReady 早于 attached 的极端时序）：继续等
      if (err && err.message === 'map not ready' && n < 3) {
        if (this._shareTimer) clearTimeout(this._shareTimer);
        this._shareTimer = setTimeout(() => this._prepareShareShot(n + 1), 150);
        return;
      }
      Logger.warn('campusMap', '分享图渲染失败，回退品牌卡', err);
    });
  },

  // 从选点页返回时刷新一次：用户可能刚记了新的相遇
  onShow() {
    opsTrack.entry('campus_map');
    if (this.data.mode === 'browse') {
      this.initGuideTour('subpackages/map/campus-map/campus-map', { delay: 900 });
    }
    if (this.data.mode === 'browse' && !this._firstShowDone) {
      this._firstShowDone = true;
      return;
    }
    if (this.data.mode === 'browse') this.loadCats();
  },

  onPullDownRefresh() {
    if (this.data.mode !== 'browse') {
      wx.stopPullDownRefresh();
      return;
    }
    return this.loadCats().finally(() => wx.stopPullDownRefresh());
  },

  /* ══════════ 数据 ══════════ */

  async loadCats() {
    this.setData({ loading: true, loadError: false });
    // loading 一变 true，顶部信息条（wx:if=!loading && !loadError）就撤掉、地图区变高 ——
    // 下拉刷新期间这一段也要重量，否则刷新时看到的是被压扁的地图。
    this.resizeMapSoon(0);
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCampusMapCats',
        timeout: 10000,
        data: { campusZone: this.data.campusZone }
      });

      if (!res.result || !res.result.success) {
        Logger.warn('campusMap', 'getCampusMapCats返回失败', {
          success: res.result && res.result.success,
          message: res.result && res.result.message
        });
        this.setData({ loadError: true, loading: false, marks: [], total: 0 });
        return;
      }

      const payload = res.result.data || {};
      const cats = Array.isArray(payload.cats) ? payload.cats : [];

      // 时间戳 → 「3小时前」，顺便把过期的排后面（地图上先看到最近遇到的）
      const marks = cats
        .map(c => ({ ...c, timeAgo: formatTimeAgo(c.at) }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));

      this.setData({ marks, total: marks.length, loading: false, loadError: false, clusterCats: [] });
      this._resolveMarkAvatars(marks);
      // 分享卡用全校园 + 猫针的离屏快照；这里失败也不影响页面，分享时退品牌卡
      this._prepareShareShot();
    } catch (err) {
      Logger.error('campusMap', '加载地图数据失败', err);
      this.setData({ loadError: true, loading: false, marks: [], total: 0 });
    } finally {
      // 拉完之后浏览页的布局变了：顶部信息条（wx:if=!loading && !loadError）和
      // 底部猫列表（wx:if=marks.length）都从「没有」变成「有」，地图区被压矮几十 px。
      // 组件量的是**位图尺寸**，不重量就是拿旧尺寸拉伸显示，画面被压扁；
      // 而命中检测靠缓存的 rect.top 换算，整片点击也会整体偏掉一截。
      // 三种结局（成功 / 失败 / 空）都会改布局，所以放 finally。
      this.setData({ switching: false });
      this.resizeMapSoon(0);
    }
  },

  /** 后台把 cloud:// 头像批量转成临时 https 链接（不阻塞地图与列表首屏） */
  async _resolveMarkAvatars(marks) {
    if (!marks || !marks.some(m => m.avatar && String(m.avatar).startsWith('cloud://'))) return;
    try {
      const mediaHelper = require('../../../utils/mediaHelper');
      if (!mediaHelper || typeof mediaHelper.resolveCatAvatars !== 'function') return;
      const resolved = await mediaHelper.resolveCatAvatars(marks);
      if (!Array.isArray(resolved)) return;
      const patch = { marks: resolved };
      const byId = {};
      for (const m of resolved) byId[m.id] = m;
      if (this.data.activeCat) {
        const hit = resolved.find(m => m.id === this.data.activeCat.id);
        if (hit) patch.activeCat = { ...this.data.activeCat, avatar: hit.avatar };
      }
      // 打开中的那坨猫名单同理：头像是转链之后的，云:// 显示不出来
      if (this.data.clusterCats && this.data.clusterCats.length) {
        patch.clusterCats = this.data.clusterCats
          .map(m => byId[m.id] ? { ...m, avatar: byId[m.id].avatar } : m);
      }
      this.setData(patch);
    } catch (e) { /* 转链失败保留原值即可 */ }
  },

  onRetry() {
    this.loadCats();
  },

  /* ══════════ 浏览模式交互 ══════════ */

  onSelectMark(e) {
    const id = e.detail.id;
    const cat = this.data.marks.find(m => m.id === id);
    if (!cat) return;
    this.setData({
      activeId: id,
      activeCat: {
        ...cat,
        statusText: STATUS_TEXT[cat.status] || '在校园里',
        seenAt: cat.at ? formatDateShort(cat.at) : ''
      },
      // 选中卡片与「这坨猫名单」互斥：底部只留一块
      clusterCats: []
    });
    this.resizeMapSoon();
  },

  /**
   * 点底部猫列表的一项：地图飞过去 + 选中它。
   *
   * 这条列表是为了解决两件事：针叠在一起时点不准，以及没法按名字找猫。
   * 点选后不缩放 —— 用户自己调好的视野不该被列表打乱。
   */
  onTapCatChip(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    // 先确认这只猫真在列表里，再动地图 —— 未知 id 不该让视图动一下
    const cat = this.data.marks.find(m => m.id === id);
    if (!cat) return;

    // 不缩放 —— 用户自己调好的视野不该被列表打乱
    const c = this.mapComp();
    if (c && typeof c.centerOnMark === 'function') c.centerOnMark(id);

    this.setData({
      activeId: id,
      activeCat: {
        ...cat,
        statusText: STATUS_TEXT[cat.status] || '在校园里',
        seenAt: cat.at ? formatDateShort(cat.at) : ''
      },
      // 从「这坨猫名单」里点进来：换成选中卡片，名单收起
      clusterCats: []
    });
    this.resizeMapSoon();
  },

  /**
   * 底部区域在「猫列表」和「选中卡片」之间切换，两者高度不同 →
   * 地图区高度跟着变 → 通知组件重新量尺寸。
   * 等过渡走完再量，否则量到的是动画中间值。
   *
   * @param {number} [delay] 默认 280（等 sheetUp 动画走完）；
   *   布局只是「长出来/缩回去」、没有动画时传 0。
   */
  resizeMapSoon(delay) {
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      const run = () => {
        const c = this.mapComp();
        if (c && typeof c.resize === 'function') c.resize();
      };
      // setData 只改数据层，视图层要等一拍才真的换高度；早量一步量到的还是旧尺寸。
      if (wx.nextTick) wx.nextTick(run);
      else run();
    }, delay === undefined ? 280 : delay);
  },

  onHide() {
    this.pauseGuideTour();
  },

  onUnload() {
    this.destroyGuideTour();
    if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
    if (this._seedTimer) { clearTimeout(this._seedTimer); this._seedTimer = null; }
    if (this._shareTimer) { clearTimeout(this._shareTimer); this._shareTimer = null; }
  },

  onSelectNone() {
    this.setData({ activeId: '', activeCat: null, clusterCats: [] });
    // 底部从「卡片 / 名单」换回「猫列表」，高度不同 → 地图区高度变了
    this.resizeMapSoon();
  },

  /**
   * 一坨 id → 对得上的猫对象。
   *
   * 按 marks 自己的顺序走（那边已经按「最近遇到的在前」排过），
   * 对不上的 id 直接丢掉：名单里混进一张空卡片比少一只更糟。
   */
  _catsOf(ids) {
    if (!ids || !ids.length) return [];
    const want = {};
    for (const id of ids) want[id] = true;
    return (this.data.marks || []).filter(m => m && want[m.id]);
  },

  /**
   * 点到一坨聚在一起的猫。
   *
   * 这条路径的重点不是「怎么把它们分开」，而是**分开不了时用户得看得到都有哪些猫**。
   * 多只猫常常是在同一个地方分别打卡记下的，坐标一模一样，怎么放大都还是一个球。
   * 所以固定产出「这坨猫的名单」，放大只在真的拆得开时顺手做一下。
   *
   * 旧实现是「放大到最大还聚着 → 默默选中第一只」，那正是这个 bug 的来源：
   * 点开只看到一只，旁边还挤着好几只却不知道是谁。
   */
  onSelectCluster(e) {
    const ids = e.detail && e.detail.ids || [];
    if (!ids.length) return;
    const cats = this._catsOf(ids);
    if (!cats.length) return;                 // 名单已过期（比如刚刷新过）：什么都不做
    // 只剩一只能对上：没什么「一坨」可言，直接进详情
    if (cats.length === 1) {
      this.onSelectMark({ detail: { id: cats[0].id } });
      return;
    }

    // 拆得开才放大（组件内部会自己判断）；拆不开就不动地图
    const c = this.mapComp();
    if (c && typeof c.zoomOnCluster === 'function') c.zoomOnCluster(ids);

    this.setData({ clusterCats: cats, activeId: '', activeCat: null });
    this.resizeMapSoon();
  },

  /** 点到建筑/绿地：只在有选中猫时收起，别把用户正在看的东西弄没了 */
  onSelectFeature() {
    if (this.data.activeId) this.onSelectNone();
  },

  onCloseActive() {
    this.onSelectNone();
  },

  goToCat() {
    const cat = this.data.activeCat;
    if (!cat) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${cat.id}` });
  },

  onGoRecord() {
    wx.navigateTo({ url: '/pages/meets/meets' });
  },

  /* ══════════ 选点模式 ══════════ */

  /**
   * 组件抛上来的点统一裁成 { u, v, label }。
   * 组件还会带 hitType 等诊断字段，但 pending 要一路传进 setData、
   * 再回传给 detail 页，形状越窄越不容易出意外。
   */
  normPick(detail) {
    const d = detail || {};
    return { u: d.u, v: d.v, label: d.label || '' };
  },

  onPick(e) {
    this.setData({ pending: this.normPick(e.detail), pickTouched: true });
  },

  /**
   * 拖动地图时的实时回抛（准星模式）。
   * 这是外卖里「拖着地图、底部地址跟着变」的那一下，必须每帧都接，
   * 否则会有明显滞后感。
   */
  onPickChange(e) {
    this.setData({ pending: this.normPick(e.detail), pickTouched: true });
  },

  /** 拖到校外：把针收起来，避免显示一个无效坐标 */
  onPickOut() {
    if (this.data.pending) this.setData({ pending: null });
  },

  onPickReject(e) {
    wx.showToast({ title: e.detail && e.detail.message || '要选在校内哦~', icon: 'none' });
  },

  /** 回到全图视角：缩到能看见整个校园，免得放太大之后找不到方向 */
  onResetView() {
    const c = this.mapComp();
    if (c && typeof c.resetView === 'function') c.resetView();
    // 选点模式下复位后针下的位置变了，立刻同步一次。
    // 故意**不带** focusDefault：resetView 刚刚已经做过，这里是「看全图」。
    // seedPin 会把 pickTouched 归零 —— 复位后的针仍是默认起点，不是一次选择。
    if (this.data.mode === 'select') this.seedPin();
  },

  onConfirmPick() {
    const p = this.data.pending;
    if (!p) {
      // pending 为 null 只在针落到校外时发生：说清原因，别让用户以为按钮坏了
      wx.showToast({ title: '针还在校外，拖回校内再确定~', icon: 'none' });
      return;
    }
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (ch && ch.emit) {
      // 没动过地图 = 没选具体地点：只回传「校园内」，不带坐标。
      // 带坐标会把猫标到一个用户从没选过的默认点上，比具体地点写错更糟。
      const payload = this.data.pickTouched
        ? { u: p.u, v: p.v, label: p.label, campusZone: this.data.campusZone }
        : { label: DEFAULT_PICK_LABEL, isDefault: true, campusZone: this.data.campusZone };
      // 校区按本页实际用的底图回传（detail 传来的 zone）。服务端仍以 cats.campus
      // 为准覆盖这个值，这里只是让对面能立刻判断「这只猫能不能用地图选点」
      ch.emit('pickpoint', payload);
    }
    wx.navigateBack();
  },

  onBack() {
    wx.navigateBack();
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  /* ══════════ 分享 ══════════ */

  /**
   * 转发给好友。
   *
   * 选点模式（从详情页跳来）不能按 select 分享：接收方没有 EventChannel，
   * 点「确定」后无处可回 —— 所以分享路径永远落回浏览模式，校区沿用当前底图。
   */
  onShareAppMessage() {
    const zone = this.data.campusZone || '本部';
    const count = this.data.total || 0;
    const titles = [
      count > 0
        ? `校园寻猫地图 | ${zone}有 ${count} 只猫等你偶遇`
        : '校园寻猫地图 | 猫猫们都藏在哪',
      `校园寻猫地图 · ${zone}的毛孩子出没记录`,
      '校园寻猫地图 | 看看你遇见过哪只'
    ];
    const share = {
      title: ShareHelper.pickTitle(titles),
      path: ShareHelper.buildPath('/subpackages/map/campus-map/campus-map', { zone })
    };
    // 分享图用当前校区的真实地图快照；没备好就用品牌卡。
    // 不再「借用猫脸」—— 分享地图却收到一颗猫头，接收方根本不知道这是什么页。
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  onShareTimeline() {
    const zone = this.data.campusZone || '本部';
    const titles = [
      `校园寻猫地图 · ${zone}`,
      '校园寻猫地图 - 记录每一次相遇',
      '校园猫猫出没地图，看看你认识哪只'
    ];
    const share = {
      title: ShareHelper.pickTitle(titles),
      query: ShareHelper.buildQuery({ zone })
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  /** 分享图：当前校区的离屏地图快照 → 品牌卡（快照按校区匹配，切校区后旧图不用） */
  _shareImage() {
    const shot = this._shareShot;
    if (shot && shot.zone === this.data.campusZone && shot.path) return shot.path;
    return ShareHelper.randomBrandImage();
  }
});
