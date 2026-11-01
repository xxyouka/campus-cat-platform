// pages/admin/report-manage/report-manage.js - 管理端「反馈处理」队列
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const { formatTimeAgo } = require('../../../utils/dateFormat');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

const TYPE_META = {
  info_error: '信息有误',
  injured: '受伤 / 生病',
  // 历史数据保留展示；用户端自 2026-10-23 起不再提供「疑似走失」。
  lost: '疑似走失',
  other: '其他'
};

const STATUS_META = {
  pending: { text: '待处理', className: 'pending' },
  resolved: { text: '已处理', className: 'resolved' },
  rejected: { text: '未采纳', className: 'rejected' }
};

const FILTERS = [
  { key: 'pending', label: '待处理' },
  { key: '', label: '全部' },
  { key: 'resolved', label: '已处理' },
  { key: 'rejected', label: '未采纳' }
];

const EMPTY_STATS = {
  windowDays: 30,
  total: 0,
  status: { pending: 0, resolved: 0, rejected: 0 },
  recent: { days7: 0, days30: 0 },
  byType: [],
  topCats: []
};

function decorateItem(item) {
  const statusMeta = STATUS_META[item.status] || STATUS_META.pending;
  return {
    ...item,
    typeText: TYPE_META[item.type] || '其他',
    statusText: statusMeta.text,
    statusClass: statusMeta.className,
    timeStr: formatTimeAgo(item.createTime),
    canGo: !!item.catId
  };
}

function decorateStats(raw) {
  const data = raw || {};
  const status = data.status || {};
  const recent = data.recent || {};

  return {
    windowDays: Number(data.windowDays) || EMPTY_STATS.windowDays,
    total: Number(data.total) || 0,
    status: {
      pending: Number(status.pending) || 0,
      resolved: Number(status.resolved) || 0,
      rejected: Number(status.rejected) || 0
    },
    recent: {
      days7: Number(recent.days7) || 0,
      days30: Number(recent.days30) || 0
    },
    byType: (data.byType || []).map(item => ({
      type: item.type,
      label: TYPE_META[item.type] || '其他',
      count: Number(item.count) || 0
    })),
    topCats: (data.topCats || []).map(item => ({
      catId: item.catId || '',
      catName: item.catName || '未知猫咪',
      count: Number(item.count) || 0,
      lastStr: item.lastAt ? formatTimeAgo(item.lastAt) : ''
    }))
  };
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],

  data: {
    loading: true,
    loadFailed: false,
    loadingMore: false,
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
    filter: 'pending',
    filters: FILTERS,
    typeFilter: '',
    catFilterId: '',
    catFilterName: '',
    filterText: '',
    stats: EMPTY_STATS,
    statsLoading: true,
    statsLoaded: false,
    busyId: '',
    skeletonItems: [1, 2, 3]
  },

  async onLoad() {
    const ok = await requireAdminAuth();
    if (!ok) {
      this.safeSetData({ loading: false, loadFailed: true, statsLoading: false });
      return;
    }
    if (!this.guardPermission('report', '反馈处理')) {
      this.safeSetData({ loading: false, statsLoading: false });
      return;
    }
    this.loadStats();
    this.loadList(true);
  },

  onPullDownRefresh() {
    Promise.all([this.loadStats(), this.loadList(true)])
      .finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._markUnmounted();
  },

  onReachBottom() {
    if (this.data.hasMore && !this._loadingList) this.loadList(false);
  },

  onRetryLoad() {
    this.loadStats();
    this.loadList(true);
  },

  onFilterTap(e) {
    const filter = e.currentTarget.dataset.filter || '';
    if (filter === this.data.filter) return;
    this.safeSetData({ filter });
    this.loadList(true);
  },

  async loadStats() {
    if (this._loadingStats) return;
    this._loadingStats = true;
    this.safeSetData({ statsLoading: true });

    try {
      const res = await this.callAdminFunction('manageReport', {
        action: 'stats'
      }, { timeout: 15000 });

      if (!res.result || !res.result.success) {
        throw new Error(res.result && (res.result.error || res.result.message) || '统计加载失败');
      }
      this.safeSetData({
        stats: decorateStats(res.result.data),
        statsLoading: false,
        statsLoaded: true
      });
    } catch (err) {
      Logger.warn('report-manage', '加载反馈统计失败', err);
      // 统计失败不挡住队列：保留上一次数据（如有），只收起加载态。
      this.safeSetData({ statsLoading: false });
    } finally {
      this._loadingStats = false;
    }
  },

  onTypeFilterTap(e) {
    const type = e.currentTarget.dataset.type || '';
    if (!type) return;
    const nextType = this.data.typeFilter === type ? '' : type;
    this._applyFilters(nextType, this.data.catFilterId, this.data.catFilterName);
  },

  onCatFilterTap(e) {
    const { catId, catName } = e.currentTarget.dataset;
    if (!catId) return;
    const nextCatId = this.data.catFilterId === catId ? '' : catId;
    this._applyFilters(this.data.typeFilter, nextCatId, nextCatId ? catName || '' : '');
  },

  onClearFilters() {
    this._applyFilters('', '', '');
  },

  _applyFilters(type, catId, catName) {
    const parts = [];
    if (type) parts.push(TYPE_META[type] || '其他');
    if (catId) parts.push(catName || '指定猫咪');

    this.safeSetData({
      typeFilter: type || '',
      catFilterId: catId || '',
      catFilterName: catId ? catName || '' : '',
      filterText: parts.join(' · ')
    });
    this.loadList(true);
  },

  async loadList(reset) {
    // 筛选/下拉刷新允许覆盖在途请求；分页加载仍要防重复触底。
    // 用序号丢弃旧响应，避免「后点的筛选被先到的旧列表覆盖」。
    if (!reset && this._loadingList) return;
    const seq = (this._loadSeq || 0) + 1;
    this._loadSeq = seq;
    this._loadingList = true;
    const page = reset ? 1 : this.data.page + 1;

    if (reset) {
      this.safeSetData({ loading: true, loadFailed: false });
    } else {
      this.safeSetData({ loadingMore: true });
    }

    try {
      const res = await this.callAdminFunction('manageReport', {
        action: 'list',
        page,
        pageSize: this.data.pageSize,
        status: this.data.filter,
        type: this.data.typeFilter,
        catId: this.data.catFilterId
      }, { timeout: 15000 });

      if (seq !== this._loadSeq) return;

      if (!res.result || !res.result.success) {
        throw new Error(res.result && (res.result.error || res.result.message) || '加载失败');
      }

      const data = res.result.data || {};
      const nextItems = (data.items || []).map(decorateItem);
      const merged = reset
        ? nextItems
        : this._mergeItems(this.data.items, nextItems);

      this.safeSetData({
        items: merged,
        total: Number(data.total) || 0,
        page,
        hasMore: !!data.hasMore,
        loading: false,
        loadingMore: false,
        loadFailed: false
      });
    } catch (err) {
      if (seq !== this._loadSeq) return;
      Logger.error('report-manage', '加载反馈队列失败', err);
      this.safeSetData({
        loading: false,
        loadingMore: false,
        loadFailed: reset ? true : this.data.loadFailed
      });
      if (!reset) wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      if (seq === this._loadSeq) this._loadingList = false;
    }
  },

  _mergeItems(base, extra) {
    const seen = new Set(base.map(item => item._id));
    return base.concat(extra.filter(item => !seen.has(item._id)));
  },

  onGoCat(e) {
    const catId = e.currentTarget.dataset.catId;
    if (!catId) {
      wx.showToast({ title: '猫咪档案已删除', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/admin/edit-cat/edit-cat?id=${catId}` });
  },

  onResolve(e) {
    const { id, status } = e.currentTarget.dataset;
    if (!id || this.data.busyId) return;
    const isResolved = status === 'resolved';
    wx.showModal({
      title: isResolved ? '标记为已处理' : '标记为未采纳',
      content: '可以补一句处理说明，会随站内通知发给反馈人。',
      editable: true,
      placeholderText: '处理说明（可选，最多 100 字）',
      confirmText: isResolved ? '已处理' : '未采纳',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this._resolve(id, status, res.content || '');
      }
    });
  },

  async _resolve(id, status, note) {
    if (!id || this.data.busyId) return;
    this.safeSetData({ busyId: id });
    try {
      const res = await this.callAdminFunction('manageReport', {
        action: 'resolve',
        id,
        status,
        note
      }, { timeout: 15000 });

      if (!res.result || !res.result.success) {
        throw new Error(res.result && (res.result.error || res.result.message) || '操作失败');
      }

      wx.showToast({
        title: status === 'resolved' ? '已标记处理' : '已标记未采纳',
        icon: 'success'
      });

      // 「全部」和「已处理 / 未采纳」筛选下结论仍然可见：原地更新状态，
      // 只有「待处理」这类不再匹配的筛选才从列表移除。
      const statusMeta = STATUS_META[status] || STATUS_META.pending;
      const keepInList = this.data.filter === '' || this.data.filter === status;
      const items = keepInList
        ? this.data.items.map(item =>
          item._id === id
            ? {
              ...item,
              status,
              statusText: statusMeta.text,
              statusClass: statusMeta.className,
              handleNote: note || item.handleNote || ''
            }
            : item
        )
        : this.data.items.filter(item => item._id !== id);

      this.safeSetData({
        items,
        total: keepInList ? this.data.total : Math.max(0, this.data.total - 1),
        busyId: ''
      });
      this.loadStats();
    } catch (err) {
      Logger.warn('report-manage', '处理反馈失败', { id, status, error: err.message });
      wx.showToast({ title: err.message || '操作失败，请重试', icon: 'none' });
      this.safeSetData({ busyId: '' });
    }
  }
});
