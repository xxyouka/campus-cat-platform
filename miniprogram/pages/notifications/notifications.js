/**
 * pages/notifications/notifications.js - 最新动态（原「消息中心」，与「我的」页入口文案统一）
 * 聚合：被相遇 / 走失提醒 / 找回通知 / 离世通知，支持分页、下拉刷新、已读标记
 */
const { Logger } = require('../../utils/logger');
const imageLoader = require('../../utils/imageLoader');
const TabBadge = require('../../utils/tabBadge');
const opsTrack = require('../../utils/opsTrack');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');

const TYPE_META = {
  cat_meet: { icon: 'paw', label: '被相遇', color: 'meet' },
  cat_lost: { icon: 'siren', label: '走失提醒', color: 'lost' },
  cat_found: { icon: 'check-circle', label: '找回通知', color: 'found' },
  cat_deceased: { icon: 'dove', label: '离世通知', color: 'deceased' },
  cat_adopted: { icon: 'home', label: '被领养通知', color: 'found' },
  cat_health_ok: { icon: 'heart', label: '康复提醒', color: 'found' },
  cat_health_stomatitis: { icon: 'stethoscope', label: '口炎提醒', color: 'lost' },
  cat_health_skin: { icon: 'stethoscope', label: '皮肤病提醒', color: 'lost' },
  cat_health_other: { icon: 'stethoscope', label: '健康提醒', color: 'lost' },
  report_result: { icon: 'announce', label: '反馈处理', color: 'found' }
};

Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    this.destroyGuideTour();
  },
  behaviors: [guideTourBehavior, safeSetDataBehavior],

  data: {
    notifications: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    loadingMore: false,
    unreadCount: 0,
    loadError: false,
    hasNewUpdates: false
  },

  onLoad() {
    // 未读清零：用户点进来就是要读，红点应随之消失。
    //
    this.setData({ unreadCount: 0 });
  },

  onShow() {
    opsTrack.entry('notifications');
    this.initGuideTour('pages/notifications/notifications', { delay: 800 });
    if (this._hasLoaded) this.checkUpdates();
    else this.refresh();
  },

  onHide() {
    this.pauseGuideTour();
  },

  async checkUpdates() {
    if (this._checkingUpdates || this.data.loading) return;
    this._checkingUpdates = true;
    const seq = this._listSeq;
    try {
      const res = await wx.cloud.callFunction({ name: 'getNotifications', data: { page: 1, pageSize: this.data.pageSize } });
      if (seq !== this._listSeq || !res.result?.success) return;
      const data = res.result.data ?? res.result;
      const ids = new Set(this.data.notifications.map(n => n._id));
      if ((data.notifications || []).some(n => !ids.has(n._id))) {
        this.safeSetData({ hasNewUpdates: true });
      }
    } catch (err) {
      Logger.warn('notifications', '检查新动态失败', err);
    } finally {
      this._checkingUpdates = false;
    }
  },

  async onViewUpdates() {
    await this.refresh();
    if (!this.data.loadError) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onPullDownRefresh() {
    // notifications.json 开了下拉刷新但此前没有该处理器：下拉动画停不下来
    //（无人调 stopPullDownRefresh）且不刷新任何数据，用户看到「永远在转圈」
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    // 请求序号：refresh 会整体替换列表，在途 loadMore 的响应必须作废 ——
    // 否则「第 1 页 + 第 3 页」拼接、第 2 页被静默吞掉且 page 记为 3，缺口不自愈
    this._listSeq = (this._listSeq || 0) + 1;
    const seq = this._listSeq;
    this.setData({ loading: true, page: 1 });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getNotifications',
        data: { page: 1, pageSize: this.data.pageSize }
      });
      if (seq !== this._listSeq) return;
      if (res.result?.success === false) throw new Error(res.result.error || '加载失败');
      const data = res.result?.data ?? res.result ?? {};
      const notifications = await this._decorate(data.notifications || []);
      if (seq !== this._listSeq) return;
      this.safeSetData({
        notifications,
        hasMore: !!data.hasMore,
        unreadCount: data.unreadCount || 0,
        loading: false,
        loadError: false,
        hasNewUpdates: false
      });
      this._hasLoaded = true;
      // 消息中心与 tabBar 红点同源：拉到的未读数立即回写本地缓存
      TabBadge.sync(data.unreadCount || 0);
    } catch (err) {
      if (seq !== this._listSeq) return;
      Logger.warn('notifications', '加载消息失败', err);
      // 区分「加载失败」与「真的没有消息」：失败时渲染错误态 + 重试入口
      this.safeSetData({ loading: false, loadError: true });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  onRetryLoad() {
    this.refresh();
  },

  /** 空态 CTA：去首页逛逛 */
  onGoBrowse() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.loading) return;
    const seqAtStart = this._listSeq || 0;
    const nextPage = this.data.page + 1;
    this.setData({ loadingMore: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getNotifications',
        data: { page: nextPage, pageSize: this.data.pageSize }
      });
      const data = res.result?.data ?? res.result ?? {};
      const newItems = await this._decorate(data.notifications || []);
      // refresh 期间列表已被整体替换：本次结果作废（避免拼接出「第1页+第3页」）
      if (seqAtStart !== (this._listSeq || 0)) {
        this.safeSetData({ loadingMore: false });
        return;
      }
      this.safeSetData({
        notifications: this.data.notifications.concat(newItems),
        page: nextPage,
        hasMore: !!data.hasMore,
        loadingMore: false
      });
    } catch (err) {
      Logger.warn('notifications', '加载更多失败', err);
      this.safeSetData({ loadingMore: false });
    }
  },

  /**
   * 触底加载更多：页面原先没有任何 loadMore 的触发入口
   *（wxml 只有一行「上拉加载更多」的提示文本，js 也没有 onReachBottom），
   * 第 2 页起永远加载不出来 —— 用户反复上拉没有任何反应。
   * 微信页面不注册 onReachBottom 时，上拉不会触发任何回调。
   */
  onReachBottom() {
    this.loadMore();
  },

  /**
   * 装饰通知项：类型标签、相对时间、头像临时链接
   *
   * catAvatar 来自云函数回传的数据库 `cats.avatar` 字段，是**未签名的
   * `cloud://` fileID**；`<image>` 组件不支持 cloud://，直接绑定必然破图。
   * 同项目 favorites 页对同一份数据做了转链，本页原先漏了 → 同一数据在两个页面
   * 表现不一致。口径与 favorites.js 一致。
   */
  async _decorate(list) {
    const cloudAvatars = [...new Set(
      list
        .filter(n => n.catAvatar && n.catAvatar.startsWith('cloud://'))
        .map(n => n.catAvatar)
    )];

    let avatarUrlMap = {};
    if (cloudAvatars.length > 0) {
      try {
        // getTempUrls 内部按 50 个/批分批请求并带 LRU 缓存
        avatarUrlMap = await imageLoader.getTempUrls(cloudAvatars, { optimizeType: 'avatar' }) || {};
      } catch (err) {
        // 转链失败不阻断列表：降级为空串走 wxml 的 else 占位头像
        Logger.warn('notifications', '通知头像URL转换失败', { error: err.message });
      }
    }

    return list.map(n => {
      const meta = TYPE_META[n.type] || { icon: 'announce', label: '新动态', color: 'default' };
      const raw = n.catAvatar || '';
      return {
        ...n,
        catAvatar: raw.startsWith('cloud://') ? avatarUrlMap[raw] || '' : raw,
        typeIcon: meta.icon,
        typeLabel: meta.label,
        typeColor: meta.color,
        timeStr: this._formatTime(n.createTime),
        // 正文模板本身已含「猫名」（如：你关注的「小Y」在操场被遇见啦！），
        // 若再单独渲染 .notify-cat 会重复显示并把名字挤成孤字行。
        // 仅当正文确实不含该名字（历史/异常数据）时才补渲染，作兜底。
        showCatName: !!(n.catName && (n.content || '').indexOf(n.catName) === -1)
      };
    });
  },

  _formatTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}-${day}`;
  },

  onTapNotification(e) {
    const { id, catId, read } = e.currentTarget.dataset;
    if (!read) {
      // 在途锁：同一 id 只允许一个未完成的标记请求。
      // 原实现无锁，连点两次会各自乐观更新 unreadCount（基于当前值 -1），
      // 但云端只标记 1 条 → 本地少计 1 且永久错位；
      // 而失败回滚用的 prevXxx 快照也取自当前值，两次连点会把已成功的更新一起回滚。
      if (!this._readLocks) this._readLocks = new Set();
      if (this._readLocks.has(id)) {
        if (catId) {
          wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
        }
        return;
      }
      this._readLocks.add(id);

      // 乐观更新前保存快照，云端失败时回滚，避免本地已读/云端未读状态发散
      const prevNotifications = this.data.notifications;
      const prevUnreadCount = this.data.unreadCount;
      const nextUnreadCount = Math.max(0, prevUnreadCount - 1);
      this.safeSetData({
        notifications: this.data.notifications.map(n => n._id === id ? { ...n, isRead: true } : n),
        unreadCount: nextUnreadCount
      });
      TabBadge.sync(nextUnreadCount);
      wx.cloud.callFunction({ name: 'markNotificationRead', data: { notificationId: id } })
        .then(res => {
          // 业务失败不会 reject：云函数正常返回 {success:false} 时 Promise 是 fulfilled，
          // 只挂 .catch 会漏掉这一支，导致本地已读/云端未读状态永久发散
          if (res.result && res.result.success === false) {
            Logger.warn('notifications', '标记已读业务失败', { error: res.result.error });
            this.safeSetData({ notifications: prevNotifications, unreadCount: prevUnreadCount });
            TabBadge.sync(prevUnreadCount);
          }
        })
        .catch(() => {
          this.safeSetData({ notifications: prevNotifications, unreadCount: prevUnreadCount });
          TabBadge.sync(prevUnreadCount);
        })
        .finally(() => {
          this._readLocks.delete(id);
        });
    }
    if (catId) {
      wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
    }
  },

  onMarkAllRead() {
    wx.cloud.callFunction({ name: 'markNotificationRead', data: { markAll: true } }).then(res => {
      // 同 onTapNotification：业务失败不 reject，必须单独判 success，
      // 否则会对用户谎报「已全部标记为已读」，而云端一条都没改
      if (res.result && res.result.success === false) {
        Logger.warn('notifications', '全部已读业务失败', { error: res.result.error });
        wx.showToast({ title: '操作失败，请重试', icon: 'none' });
        return;
      }
      this.safeSetData({
        notifications: this.data.notifications.map(n => ({ ...n, isRead: true })),
        unreadCount: 0
      });
      TabBadge.sync(0);
      wx.showToast({ title: '已全部标记为已读', icon: 'success' });
    }).catch(e => {
      Logger.warn('notifications', '全部已读失败', { error: e.message });
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    });
  }
});
