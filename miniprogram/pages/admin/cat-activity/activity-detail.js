/**
 * pages/admin/cat-activity/activity-detail.js - 管理端：单只猫的行动分析详情
 *
 * 展示 getCatActivity 的现算结果：一句话结论、时段/星期/场景/地点分布、
 * 活动地图（点位 + 聚集圈 + 最近一次 + 轨迹时间线）、数据脚注。
 *
 * 三个刻意的设计口径：
 *   1. **每次打开都现算**：不落库、不缓存结论，切换时间窗就重新请求（服务端只有 60s
 *      容器内缓存），页面永远跟最新打卡同步；
 *   2. **样本量摊开讲**：地图点位是 2026-10 选点上线后才有的字段，样本不足时
 *      页面不假装有规律 —— 由 buildFootnote 生成脚注，结论句缺信息就少说一句；
 *   3. **轨迹时间线与地图联动**：点一条记录高亮地图上的对应点位。点位被采样截断
 *      （点位超过上限只保留最近）时匹配不上，就明说「这条没有地图位置」，不乱圈。
 *
 * 权限：**仅超级管理员**。页面门禁只挡界面；服务端 getCatActivity 有独立的
 * role==='superadmin' 硬闸，普通管理员直接调云函数同样拿不到数据。
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const MediaHelper = require('../../../utils/mediaHelper');
const { nearestFeatureName } = require('../utils/campusLandmark');
const { hasMap } = require('../../../utils/campusMapRegistry');
const summary = require('../utils/catActivitySummary');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

/** 时间窗档位：与 cloudfunctions/getCatActivity/index.js 的 RANGE_DAYS 白名单逐项一致 */
const RANGES = [
  { days: 30, label: '近30天' },
  { days: 90, label: '近90天' },
  { days: 0, label: '全部' }
];
const DEFAULT_DAYS = 90;
/** 猫 _id 形态（云数据库自动生成）：与云函数 CAT_ID_PATTERN 同口径，前端先挡一道 */
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;
/** 与 cloudfunctions/getCatActivity/analysis.js 的 DEFAULT_LOCATIONS 一致 */
const DEFAULT_LOCATIONS = ['校园里', '校园内'];
const isDefaultLocation = (loc) => DEFAULT_LOCATIONS.indexOf(loc) >= 0;
const STATUS_TEXT = { normal: '在校', lost: '走失', deceased: '已离世', adopted: '已领养' };

/** 默认时间窗在档位里的下标（DEFAULT_DAYS=90 是第二档） */
function indexOfDays(days) {
  const i = RANGES.findIndex((r) => r.days === days);
  return i >= 0 ? i : RANGES.length - 1;
}

/**
 * 时间线条目 → 地图点位下标。
 *
 * recent 与 points 同源，正常情况下按 (t,u,v) 精确匹配即可；点位被采样截断时
 * 个别点可能没画在图上，此时退化为「找最近的点」，距离仍超过约底图 1% 就返回 -1：
 * 宁可不高亮，也不把用户引到一个错的点上。
 */
function findPointIndex(points, item) {
  if (!item || typeof item.u !== 'number' || typeof item.v !== 'number') return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.t === item.t && p.u === item.u && p.v === item.v) return i;
    const du = p.u - item.u;
    const dv = p.v - item.v;
    const d = du * du + dv * dv;
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= 0.0001 ? best : -1;
}

/** 条形宽度：0 次的条留空（不画一丝假进度），非 0 至少 4% 才看得见 */
function barPercent(count, max) {
  if (!count) return 0;
  return Math.max(4, Math.round(count / max * 100));
}

/**
 * 榜单/图表通用映射：统一按「本榜单内最大值」算条形宽度。
 * 各榜单自己的展示字段由 extra 提供（时段要 range、星期要中文名、地点要文案）。
 */
function withPercent(items, extra) {
  const list = items || [];
  const max = list.reduce((m, x) => Math.max(m, x.count || 0), 0) || 1;
  return list.map((it) => {
    const row = extra ? extra(it) : null;
    return { ...it, ...row, percent: barPercent(it.count, max) };
  });
}

/**
 * 轨迹时间线：最近若干条相遇 → 页面行。
 * 没填具体地点时不写「校园内 / 校园里」——那是「没填」的同义词，不是地点。
 */
function buildTimeline(recent, pointItems) {
  return (recent || []).map((r, i) => ({
    key: `${r.t}-${i}`,
    timeText: summary.formatMeetTime(r.t),
    descText: [
      r.location && !isDefaultLocation(r.location) ? r.location : '未填地点',
      r.tag
    ].filter(Boolean).join(' · '),
    pointIndex: findPointIndex(pointItems, r),
    _active: false
  }));
}

/** 顶部猫信息（标题、头像、状态都是「页面兜底 + 服务端覆盖」的优先级） */
function buildCat(cat, catId, catName) {
  const doc = cat || {};
  return {
    id: doc.id || catId,
    name: doc.name || catName || '未命名',
    avatar: doc.avatar || '',
    campus: doc.campus || '',
    statusText: STATUS_TEXT[doc.status] || doc.status || '在校'
  };
}

/** 样本时间跨度：首次相遇 → 最近一次相遇（没有记录时留空） */
function buildSpanText(totals) {
  if (!totals.firstTime) return '';
  return `样本：${summary.formatMeetTime(totals.firstTime)} 至 ${summary.formatMeetTime(totals.lastTime)}`;
}

/**
 * 活动范围文案。少于 3 个点看不出任何「范围」，与结论句同口径地闭嘴。
 * @param {number} pointTotal 点位样本数
 * @param {string} label spreadLabel 的结果（可能为空）
 */
function buildSpreadText(pointTotal, label) {
  if (pointTotal < 3) return '';
  return label || '点位样本还太少，暂不评价';
}

/** 默认「校园内」= 没填具体地点，不进地点榜，这里如实说明有多少条 */
function buildLocationNote(totals) {
  const n = totals.defaultLocation || 0;
  return n > 0 ? `${n} 条打卡只填了默认的「校园内」，没填具体地点，因此未计入地点榜` : '';
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],

  data: {
    catId: '',
    catName: '',
    navTitle: '猫咪行动分析',

    loading: true,
    // 切换时间窗时保留页面骨架（用 refreshing 提示），避免整页骨架导致上下文丢失
    refreshing: false,
    // 取不到数据与「这段时间没有记录」必须分开显示，否则故障被伪装成业务空
    loadFailed: false,
    errorText: '',
    notFound: false,
    skeletonItems: [1, 2, 3],

    ranges: RANGES,
    rangeIndex: indexOfDays(DEFAULT_DAYS),

    cat: null,
    totals: null,
    spanText: '',
    conclusion: '',
    spreadText: '',

    hasData: false,
    hasMap: false,
    mapPoints: [],
    mapClusters: [],
    lastPoint: null,
    highlight: -1,

    blocks: [],
    weekdays: [],
    tags: [],
    locations: [],
    clusters: [],
    timeline: [],
    footnote: [],
    locationNote: ''
  },

  async onLoad(options) {
    const catId = options && options.id ? decodeURIComponent(options.id) : '';
    const catName = options && options.name ? decodeURIComponent(options.name) : '';
    this._seq = 0;
    this.setData({ catId, catName, navTitle: catName || '猫咪行动分析' });

    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏永驻，只能手动返回
      this.safeSetData({ loading: false });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('catActivity', '猫咪行动分析')) {
      this.safeSetData({ loading: false });
      return;
    }
    if (!CAT_ID_PATTERN.test(catId)) {
      // 参数就不对，不必打一次云函数再失败：直接给「不存在」空态
      this.safeSetData({ loading: false, loadFailed: true, notFound: true, errorText: '猫咪参数无效，请从列表重新进入' });
      return;
    }
    this._reload(DEFAULT_DAYS, true);
  },

  onUnload() {
    this._isUnmounted = true;
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },

  onPullDownRefresh() {
    this._reload(RANGES[this.data.rangeIndex].days, false).finally(() => wx.stopPullDownRefresh());
  },

  onRetryLoad() {
    this._reload(RANGES[this.data.rangeIndex].days, false);
  },

  onBackToList() {
    this.goBack();
  },

  /**
   * 拉取并组装。
   * @param {number} days 时间窗天数（0 = 全部）
   * @param {boolean} skeleton 首次进入用整页骨架；切窗/重试用 refreshing 轻提示
   */
  async _reload(days, skeleton) {
    if (this._loadingAct) return;
    this._loadingAct = true;
    this._seq = (this._seq || 0) + 1;
    const seq = this._seq;

    this.safeSetData(skeleton
      ? { loading: true, refreshing: false, loadFailed: false }
      : { refreshing: true, loadFailed: false });

    try {
      const res = await this.callAdminFunction('getCatActivity', { catId: this.data.catId, rangeDays: days });
      if (seq !== this._seq) return;

      if (!res.result?.success) {
        const msg = res.result?.error || '获取分析失败';
        this.safeSetData({
          loading: false,
          refreshing: false,
          loadFailed: true,
          errorText: msg,
          // 「猫没了」与「拉取失败」的用户动作不同：前者只能返回，后者可以重试
          notFound: /不存在|已删除/.test(msg)
        });
        return;
      }

      const payload = res.result?.data ?? res.result ?? {};
      const vm = this._compose(payload);
      // 头像若是云文件，先换成临时链接（裸 cloud:// 交给 <image> 会拉全尺寸原图）
      if (vm.cat.avatar) {
        const resolved = await MediaHelper.resolveCatAvatars([vm.cat]);
        if (resolved && resolved[0] && resolved[0].avatar) vm.cat.avatar = resolved[0].avatar;
      }
      if (seq !== this._seq) return;
      this.safeSetData({ ...vm, loading: false, refreshing: false, loadFailed: false });
    } catch (err) {
      if (seq !== this._seq) return;
      Logger.error('cat-activity', '加载行动分析失败', err);
      ErrorHandler.handle(err, { title: '加载失败' });
      this.safeSetData({
        loading: false,
        refreshing: false,
        loadFailed: true,
        errorText: '获取分析失败，请重试',
        notFound: false
      });
    } finally {
      this._loadingAct = false;
    }
  },

  /** 云函数响应 → 页面展示模型（纯装配，不做统计） */
  _compose(payload) {
    const p = payload || {};
    const totals = p.totals || {};
    const range = p.range || {};
    const points = p.points || { total: 0, sampled: false, items: [] };
    const spread = p.spread || null;
    const pointItems = points.items || [];
    const spreadLabel = summary.spreadLabel(spread && spread.p90);

    // 聚集圈：先按「这只猫所在校区」的最近地物命名，再合并同名（同一片区分成两簇时
    // 合成一条，否则地图两个圈、文字两行同名，看起来像 bug）。无名圈保持独立。
    // 校区没有底图时不做命名（宁可不命名，也不拿别的校区的地物硬套）。
    const cat = buildCat(p.cat, this.data.catId, this.data.catName);
    const zone = String(cat.campus || '').trim();
    const mapZone = hasMap(zone) ? zone : '';
    const nameOf = mapZone
      ? (u, v) => nearestFeatureName(u, v, undefined, mapZone)
      : null;
    const clusters = summary.mergeNamedClusters(p.clusters || [], nameOf);

    return {
      cat,
      navTitle: cat.name,
      totals,
      spanText: buildSpanText(totals),
      conclusion: summary.buildConclusion({
        rangeDays: range.days,
        totals,
        blocks: p.blocks || [],
        tags: p.tags || [],
        locations: p.locations || [],
        spreadP90: spread && spread.p90
      }),
      spreadText: buildSpreadText(points.total || 0, spreadLabel),
      hasData: Boolean(totals.meets),
      hasMap: pointItems.length > 0 && !!mapZone,
      // 底图跟着猫档案的校区走：东区的点画在本部图上，看着正常、位置全错
      mapZone,
      mapPoints: pointItems,
      mapClusters: clusters.map((c) => ({ u: c.u, v: c.v, count: c.count, label: c.label })),
      lastPoint: p.lastPoint || null,
      highlight: -1,
      blocks: withPercent(p.blocks),
      weekdays: withPercent(p.weekdays, (w) => ({ label: summary.weekLabel(w.d) })),
      tags: withPercent(p.tags, (t) => ({ text: t.text })),
      locations: withPercent(p.locations, (l) => ({ text: l.text })),
      clusters: withPercent(clusters, (c) => ({ key: `${c.u}-${c.v}-${c.name || 'x'}`, label: c.label })),
      timeline: buildTimeline(p.recent, pointItems),
      footnote: summary.buildFootnote({ totals, range, points }),
      locationNote: buildLocationNote(totals)
    };
  },

  /** 时间窗切换：同档重复点不发请求，在途时也不重入 */
  onRangeTap(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (!(idx >= 0) || idx >= RANGES.length) return;
    if (idx === this.data.rangeIndex || this._loadingAct) return;
    this.setData({ rangeIndex: idx });
    this._reload(RANGES[idx].days, false);
  },

  /**
   * 轨迹时间线点选 → 高亮地图上的对应点位。
   * 不做自动滚动：把页面滚来滚去比「高亮状态留着、自己滚上去看」更烦人；
   * 地图就在时间线正上方，抬头即见。
   */
  onTimelineTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.timeline[idx];
    if (!item) return;

    if (!(item.pointIndex >= 0)) {
      // 这条打卡当时没选地图位置：给即时反馈，并清掉上一条的高亮，避免状态误导
      wx.showToast({ title: '这条打卡没选地图位置', icon: 'none' });
      this.setData({ timeline: this.data.timeline.map((it) => ({ ...it, _active: false })), highlight: -1 });
      return;
    }

    this.setData({
      timeline: this.data.timeline.map((it, i) => ({ ...it, _active: i === idx })),
      highlight: item.pointIndex
    });
  }
});
