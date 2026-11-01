// pages/admin/media-review/media-review.js - 管理端「内容复核」队列
//
// 数据源：cloudfunctions/mediaReview
//   list    待复核（review）/ 已拦截（risky）的多媒体检测记录 + 目标缩略图
//   resolve 通过（keep）/ 拦截（block）
//
// 处置口径（与云函数一致）：
//   - 通过：清除 `_mediaReview` / `_mediaBlocked`；被拦截清空过的头像按原 fileID 恢复；
//   - 拦截：照片由读侧过滤 `_mediaBlocked` 隐藏；头像立即清空（公开页退回占位图）。
// 真正的删除仍走照片管理 / 编辑猫咪，避免在这里再造一套删除逻辑。
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const { formatTimeAgo } = require('../../../utils/dateFormat');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

const TARGET_LABELS = {
  photo: '照片',
  avatar: '猫猫头像'
};

const STATUS_META = {
  review: { text: '待复核', className: 'review' },
  risky: { text: '已拦截', className: 'risky' }
};

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'review', label: '待复核' },
  { key: 'risky', label: '已拦截' }
];

function decorateItem(item) {
  const statusMeta = STATUS_META[item.status] || STATUS_META.review;
  return {
    ...item,
    targetText: TARGET_LABELS[item.target] || '内容',
    statusText: statusMeta.text,
    statusClass: statusMeta.className,
    timeStr: formatTimeAgo(item.updateTime || item.createTime),
    canGo: !!item.catId
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
    filter: '',
    filters: FILTERS,
    busyId: '',
    skeletonItems: [1, 2, 3]
  },

  async onLoad() {
    const ok = await requireAdminAuth();
    if (!ok) {
      this.safeSetData({ loading: false, loadFailed: true });
      return;
    }
    if (!this.guardPermission('mediaReview', '内容复核')) {
      this.safeSetData({ loading: false });
      return;
    }
    this.loadList(true);
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._markUnmounted();
  },

  onReachBottom() {
    if (this.data.hasMore && !this._loadingList) this.loadList(false);
  },

  onRetryLoad() {
    this.loadList(true);
  },

  onFilterTap(e) {
    const filter = e.currentTarget.dataset.filter || '';
    if (filter === this.data.filter) return;
    this.safeSetData({ filter });
    this.loadList(true);
  },

  /**
   * @param {boolean} reset true = 回到第 1 页并替换列表；false = 追加下一页
   */
  async loadList(reset) {
    if (this._loadingList) return;
    this._loadingList = true;
    const page = reset ? 1 : this.data.page + 1;

    if (reset) {
      this.safeSetData({ loading: true, loadFailed: false });
    } else {
      this.safeSetData({ loadingMore: true });
    }

    try {
      const res = await this.callAdminFunction('mediaReview', {
        action: 'list',
        page,
        pageSize: this.data.pageSize,
        status: this.data.filter
      }, { timeout: 15000 });

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
      Logger.error('media-review', '加载内容复核队列失败', err);
      this.safeSetData({
        loading: false,
        loadingMore: false,
        loadFailed: reset ? true : this.data.loadFailed
      });
      if (!reset) wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this._loadingList = false;
    }
  },

  /** 翻页追加时按 _id 去重（期间可能有记录被处理掉，页边界会漂移） */
  _mergeItems(base, extra) {
    const seen = new Set(base.map(item => item._id));
    return base.concat(extra.filter(item => !seen.has(item._id)));
  },

  onKeep(e) {
    this._resolve(e.currentTarget.dataset.id, 'keep');
  },

  async onBlock(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const confirm = await this.confirm('确认拦截这条内容？照片会从公开相册隐藏，头像会立即清空。');
    if (!confirm) return;
    this._resolve(id, 'block');
  },

  async _resolve(id, decision) {
    if (!id || this.data.busyId) return;
    this.safeSetData({ busyId: id });
    try {
      const res = await this.callAdminFunction('mediaReview', {
        action: 'resolve',
        id,
        decision
      }, { timeout: 15000 });

      if (!res.result || !res.result.success) {
        throw new Error(res.result && (res.result.error || res.result.message) || '操作失败');
      }

      wx.showToast({
        title: decision === 'keep' ? '已通过' : '已拦截',
        icon: 'success'
      });
      this.safeSetData({
        items: this.data.items.filter(item => item._id !== id),
        total: Math.max(0, this.data.total - 1),
        busyId: ''
      });
    } catch (err) {
      Logger.warn('media-review', '处理复核记录失败', { id, decision, error: err.message });
      wx.showToast({ title: err.message || '操作失败，请重试', icon: 'none' });
      this.safeSetData({ busyId: '' });
    }
  },

  onGoTarget(e) {
    const { target, catId, catName } = e.currentTarget.dataset;
    if (!catId) {
      wx.showToast({ title: '目标对象已删除', icon: 'none' });
      return;
    }
    if (target === 'photo') {
      const name = catName ? `&catName=${encodeURIComponent(catName)}` : '';
      wx.navigateTo({
        url: `/pages/admin/photo-manage/album-detail?catId=${catId}${name}`
      });
      return;
    }
    wx.navigateTo({ url: `/pages/admin/edit-cat/edit-cat?id=${catId}` });
  },

  confirm(content) {
    return new Promise((resolve) => {
      wx.showModal({
        title: '确认',
        content,
        confirmText: '拦截',
        cancelText: '取消',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false)
      });
    });
  }
});
