/**
 * pages/admin/cat-activity/activity-all.js - 管理端：全部小猫的总轨迹图
 *
 * 一张图看**所有猫**的活动路线：每只猫一色（点位 + 同一天内 ≤6h 的相邻虚线），
 * 底部图例点选某只猫即可在地图上聚焦它、再点一次取消。「只要地图和行动路线」——
 * 不做结论、时段与榜单，也不保存任何东西；每次打开都由 getCatActivity 的
 * scope='all' 模式现算（服务端 60s 容器缓存），永远跟最新打卡同步。
 *
 * 权限：**仅超级管理员**。页面级门禁只挡界面，服务端对单猫与总轨迹两种模式
 * 一视同仁地执行 role==='superadmin' 硬闸（普通管理员直接调云函数也拿不到数据）。
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const summary = require('../utils/catActivitySummary');
const { resolveZone, availableZones, hasMap } = require('../../../utils/campusMapRegistry');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

/** 时间窗档位：与 cloudfunctions/getCatActivity/index.js 的 RANGE_DAYS 白名单逐项一致 */
const RANGES = [
  { days: 30, label: '近30天' },
  { days: 90, label: '近90天' },
  { days: 0, label: '全部' }
];
const DEFAULT_DAYS = 90;

/** 默认时间窗在档位里的下标（DEFAULT_DAYS=90 是第二档） */
function indexOfDays(days) {
  const i = RANGES.findIndex((r) => r.days === days);
  return i >= 0 ? i : RANGES.length - 1;
}

/**
 * 地图高度：按屏高取约一半。
 * 图是这页的主角，但要给时间窗、图例与脚注留位置，所以不铺满整屏；
 * 取不到窗口信息时给 380 的兜底值（低端机与极端比例下都可读）。
 */
function computeMapHeight() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : null;
    if (info && info.windowHeight) {
      return Math.max(300, Math.min(480, Math.round(info.windowHeight * 0.5)));
    }
  } catch (e) { /* 拿不到就用兜底值 */ }
  return 380;
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],

  data: {
    loading: true,
    // 切时间窗时保留地图（refreshing 轻提示），避免整页骨架丢上下文
    refreshing: false,
    // 取不到数据与「这段时间没有点位」必须分开显示，否则故障被伪装成业务空
    loadFailed: false,
    errorText: '',
    skeletonItems: [1, 2],

    ranges: RANGES,
    rangeIndex: indexOfDays(DEFAULT_DAYS),
    mapHeight: 380,

    hasData: false,
    emptyTitle: '',
    emptySubtitle: '',
    // 校区：一张底图只能配一套坐标 —— 多校区的猫不能混在一张图上画
    zoneTabs: [],
    zone: '本部',
    tracks: [],
    legend: [],
    focusId: '',
    totalsText: '',
    footnote: []
  },

  async onLoad() {
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
    this.safeSetData({ mapHeight: computeMapHeight() });
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
      const res = await this.callAdminFunction('getCatActivity', { scope: 'all', rangeDays: days });
      if (seq !== this._seq) return;

      if (!res.result?.success) {
        this.safeSetData({
          loading: false,
          refreshing: false,
          loadFailed: true,
          errorText: res.result?.error || '获取总轨迹失败'
        });
        return;
      }

      const vm = this._compose(res.result?.data ?? res.result ?? {});
      if (seq !== this._seq) return;
      // 切校区要按猫档案重新分桶：把原始数据留在实例上，避免再打一次云函数
      const payload = res.result?.data ?? res.result ?? {};
      this._cats = Array.isArray(payload.cats) ? payload.cats : [];
      this.safeSetData({ ...vm, loading: false, refreshing: false, loadFailed: false });
    } catch (err) {
      if (seq !== this._seq) return;
      Logger.error('cat-activity', '加载总轨迹失败', err);
      ErrorHandler.handle(err, { title: '加载失败' });
      this.safeSetData({
        loading: false,
        refreshing: false,
        loadFailed: true,
        errorText: '获取总轨迹失败，请重试'
      });
    } finally {
      this._loadingAct = false;
    }
  },

  /** 云函数响应 → 页面展示模型（纯装配，不做统计） */
  _compose(payload) {
    const p = payload || {};
    const range = p.range || {};
    const totals = p.totals || {};
    const cats = Array.isArray(p.cats) ? p.cats : [];

    // 校区：点位坐标是「各自校区底图」的归一化值，一张图只能画一个校区。
    // 有坐标的校区才进切换条；当前校区不在列表里（切时间窗后数据变了）时退回第一个。
    const zoneCats = {};
    cats.forEach((c) => {
      const z = resolveZone(c.campus);
      (zoneCats[z] = zoneCats[z] || []).push(c);
    });
    const presentZones = availableZones().filter((z) => zoneCats[z] && zoneCats[z].length);
    const zone = presentZones.indexOf(this.data.zone) >= 0 ? this.data.zone : presentZones[0] || '本部';
    const zoneCatsOf = zoneCats[zone] || [];

    // 每只猫按 catId 稳定取色（trailColorFor）：地图与图例的颜色必须一一对上
    const tracks = zoneCatsOf.map((c) => ({
      id: c.id,
      name: c.name || '未命名',
      color: summary.trailColorFor(c.id),
      points: c.points || []
    }));
    const legend = zoneCatsOf.map((c, i) => ({
      id: c.id,
      name: tracks[i].name,
      color: tracks[i].color,
      countText: `${c.pointTotal || 0} 点`
    }));
    const hasData = tracks.length > 0;
    const zonePoints = zoneCatsOf.reduce((s, c) => s + (c.pointTotal || 0), 0);

    return {
      hasData,
      zone,
      zoneTabs: presentZones.length > 1 ? presentZones : [],
      // 两种空态的用户动作不同：完全没打卡 = 换时间窗；有打卡但没选位置 = 等样本
      emptyTitle: totals.meets ? '这段时间还没有带地图位置的打卡' : '这段时间还没有相遇记录',
      emptySubtitle: totals.meets
        ? '等大家在打卡时选一次地图位置，总轨迹图会自动长出来'
        : '换个时间窗看看，或等大家在打卡后自动出现',
      tracks,
      legend,
      focusId: '',
      totalsText: hasData ? `图上 ${tracks.length} 只猫 · 共 ${zonePoints} 个打卡点位` : '',
      footnote: summary.buildTrailFootnote({
        range,
        totals,
        sampledCats: cats.filter((c) => c.sampled).length
      })
    };
  },

  /** 校区切换：同一张图上换一批猫（底图也跟着换，见 activity-map 的 zone） */
  onZoneTap(e) {
    const zone = e.currentTarget.dataset.zone;
    if (!zone || zone === this.data.zone || !hasMap(zone)) return;
    // 数据已经在手上，切校区只是重新分桶，不必再打一次云函数
    const cats = this._cats || [];
    const zoneCats = cats.filter((c) => resolveZone(c.campus) === zone);
    const tracks = zoneCats.map((c) => ({
      id: c.id,
      name: c.name || '未命名',
      color: summary.trailColorFor(c.id),
      points: c.points || []
    }));
    const legend = zoneCats.map((c, i) => ({
      id: c.id,
      name: tracks[i].name,
      color: tracks[i].color,
      countText: `${c.pointTotal || 0} 点`
    }));
    const zonePoints = zoneCats.reduce((s, c) => s + (c.pointTotal || 0), 0);
    this.setData({
      zone,
      focusId: '',
      tracks,
      legend,
      hasData: tracks.length > 0,
      totalsText: tracks.length ? `图上 ${tracks.length} 只猫 · 共 ${zonePoints} 个打卡点位` : ''
    });
  },

  /** 图例点选：点中的猫聚焦（其余压暗），再点一次取消；切时间窗会重置聚集 */
  onChipTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ focusId: this.data.focusId === id ? '' : id });
  },

  /** 时间窗切换：同档重复点不发请求，在途时也不重入 */
  onRangeTap(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (!(idx >= 0) || idx >= RANGES.length) return;
    if (idx === this.data.rangeIndex || this._loadingAct) return;
    this.setData({ rangeIndex: idx });
    this._reload(RANGES[idx].days, false);
  }
});
