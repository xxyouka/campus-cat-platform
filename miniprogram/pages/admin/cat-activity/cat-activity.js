/**
 * pages/admin/cat-activity/cat-activity.js - 管理端：猫咪行动分析（选猫列表）
 *
 * 「猫咪行动分析」的入口页：列出猫咪，选一只进 activity-detail 看它的行动规律
 * 与活动轨迹。**只读** —— 本页与详情页都不写任何库（无结论保存、无操作日志）。
 *
 * 数据源用 filterCats（与 cat-manage 同源，返回的猫档案里带 meetCount /
 * lastMeetTime）：单页最多 100 只，全站猫咪规模很小，一次翻完再在客户端排序，
 * 比「服务端按 listSort 排、页面又要按相遇时间排」两套口径更好维护。
 * 搜索同样放在客户端：拿到全量后二次筛选不再打网络，输入即筛。
 *
 * 权限：**仅超级管理员**。页面级 isSuperAdmin 只影响入口显隐，
 * 服务端 getCatActivity 还有一道 role==='superadmin' 硬闸（普通管理员绕过前端也拿不到数据）。
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const MediaHelper = require('../../../utils/mediaHelper');
const { formatMeetTime } = require('../utils/catActivitySummary');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

/** filterCats 单页上限 100；翻页留硬顶，防止异常数据把一次进入拖成几十个请求 */
const FETCH_PAGE_SIZE = 100;
const FETCH_MAX_PAGES = 6;
/** 渲染节奏：首屏 30 只，「显示更多」每次 +30（纯客户端切片，与网络无关） */
const RENDER_STEP = 30;
const SEARCH_DEBOUNCE = 200;

/** 猫状态文案（与 cat-manage.wxml / detail.wxml 的映射逐字一致） */
const STATUS_TEXT = { normal: '在校', lost: '走失', deceased: '已离世', adopted: '已领养' };

/**
 * 相遇时间倒序：最近被相遇的排前面，从没被相遇过的一律垫底。
 * 二级键用累计次数、三级键用名字 —— 三个键全同的情况几乎不存在，
 * 但一旦出现，不兜底就会「刷新一下顺序就变」，列表看起来像在乱跳。
 */
function sortByActivity(list) {
  return list.slice().sort((a, b) =>
    b.lastMeetTime - a.lastMeetTime ||
    b.meetCount - a.meetCount ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],

  data: {
    loading: true,
    // 加载失败必须是独立状态：否则 catch 后列表保持空数组，
    // wxml 会把「加载失败」渲染成「还没有猫咪档案」，把故障伪装成业务空
    loadFailed: false,
    skeletonItems: [1, 2, 3, 4, 5, 6],
    keyword: '',
    cats: [],
    visibleCount: 0,
    hasMore: false,
    total: 0,
    headerText: '',
    emptyIcon: 'cat',
    emptyTitle: '还没有猫咪档案',
    emptySubtitle: '先在「猫咪管理」里录入猫咪，再来分析'
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏永驻，用户只能手动返回
      this.safeSetData({ loading: false });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('catActivity', '猫咪行动分析')) {
      this.safeSetData({ loading: false });
      return;
    }
    this.loadCats();
  },

  onUnload() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
  },

  onPullDownRefresh() {
    this.loadCats().finally(() => wx.stopPullDownRefresh());
  },

  onRetryLoad() {
    this.loadCats();
  },

  /**
   * 取回全部猫咪（页码翻页，最多 FETCH_MAX_PAGES 页）。
   *
   * 在途锁是必须的：下拉刷新与「重新加载」按钮都能并发进来，
   * 两份响应各自落地会让列表先闪一下再变。请求序号再兜一层 ——
   * 抢先后到的旧响应直接丢弃，不会覆盖新数据。
   */
  async loadCats() {
    if (this._loadingCats) return;
    this._loadingCats = true;
    this._seq = (this._seq || 0) + 1;
    const seq = this._seq;
    this.safeSetData({ loading: true, loadFailed: false });

    try {
      const all = [];
      let hasMore = true;
      for (let page = 1; hasMore && page <= FETCH_MAX_PAGES; page++) {
        const res = await this.callAdminFunction('filterCats', {
          filters: { page, pageSize: FETCH_PAGE_SIZE }
        });
        if (seq !== this._seq) return;
        if (!res.result?.success) throw new Error(res.result?.error || '加载失败');

        const data = res.result?.data ?? res.result ?? {};
        const cats = data.cats || [];
        all.push(...cats);
        hasMore = !!data.hasMore && cats.length > 0;
      }

      // 头像云文件先换临时链接（裸 cloud:// 交给 <image> 会拉原图）
      const withAvatar = await MediaHelper.resolveCatAvatars(all);
      if (seq !== this._seq) return;

      this._allCats = withAvatar.map((cat) => ({
        id: cat._id,
        name: cat.name || '未命名',
        avatar: cat.avatar || '',
        campus: cat.campus || '',
        statusText: STATUS_TEXT[cat.status] || cat.status || '在校',
        meetCount: typeof cat.meetCount === 'number' ? cat.meetCount : 0,
        lastMeetTime: cat.lastMeetTime || 0,
        lastMeetText: cat.lastMeetTime ? formatMeetTime(cat.lastMeetTime) : '',
        // 搜索索引：与服务端 filterCats 的关键词口径一致（name / color / location）
        searchKey: [cat.name, cat.color, cat.location].filter(Boolean).join(' ').toLowerCase()
      }));

      this.safeSetData({ loading: false, loadFailed: false });
      this._applyFilter(true);
    } catch (err) {
      if (seq !== this._seq) return;
      Logger.error('cat-activity', '加载猫咪列表失败', err);
      ErrorHandler.handle(err, { title: '加载失败' });
      this.safeSetData({ loading: false, loadFailed: true, cats: [], total: 0, hasMore: false });
    } finally {
      this._loadingCats = false;
    }
  },

  /* ══════════ 搜索与渲染切片 ══════════ */

  onSearchInput(e) {
    const keyword = e.detail.value || '';
    this.setData({ keyword });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    // 200ms 静置后再筛选：连续打字不必每敲一个字就重排整表
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this._applyFilter(true);
    }, SEARCH_DEBOUNCE);
  },

  onClearKeyword() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.setData({ keyword: '' });
    this._applyFilter(true);
  },

  /** 关键词 → 过滤 → 排序 → 渲染首屏切片 */
  _applyFilter(reset) {
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const source = this._allCats || [];
    const matched = kw ? source.filter((c) => c.searchKey.includes(kw)) : source;
    this._filtered = sortByActivity(matched);
    this._renderList(reset ? RENDER_STEP : this.data.visibleCount);
  },

  onRevealMore() {
    if (!this.data.hasMore) return;
    this._renderList(this.data.visibleCount + RENDER_STEP);
  },

  onReachBottom() {
    this.onRevealMore();
  },

  /** 纯客户端切片：顺序已在 _applyFilter 里定好，这里只决定露出多少 */
  _renderList(count) {
    const list = this._filtered || [];
    const shown = Math.min(count, list.length);
    const kw = (this.data.keyword || '').trim();
    const all = (this._allCats || []).length;

    this.safeSetData({
      cats: list.slice(0, shown),
      visibleCount: shown,
      hasMore: list.length > shown,
      total: list.length,
      headerText: kw ? `匹配 ${list.length} 只（共 ${all} 只）` : `共 ${list.length} 只猫咪 · 按最近相遇排序`,
      // 空态要分「库里没猫」与「搜索没搜到」：两者的下一步动作完全不同
      emptyIcon: kw ? 'search' : 'cat',
      emptyTitle: kw ? '没有匹配的猫咪' : '还没有猫咪档案',
      emptySubtitle: kw ? '换个关键词试试（猫名 / 花色 / 常驻地点）' : '先在「猫咪管理」里录入猫咪，再来分析'
    });
  },

  /** 进「全部小猫总轨迹」：同一套只读分析的总览视图（activity-all） */
  onGoAllTrails() {
    wx.navigateTo({ url: '/pages/admin/cat-activity/activity-all' });
  },

  onGoToDetail(e) {
    const { catId, catName } = e.currentTarget.dataset;
    if (!catId) return;
    // 带上名字：详情页在数据回来之前就能把标题显示出来，避免白屏标题
    wx.navigateTo({
      url: `/pages/admin/cat-activity/activity-detail?id=${encodeURIComponent(catId)}&name=${encodeURIComponent(catName || '')}`
    });
  }
});
