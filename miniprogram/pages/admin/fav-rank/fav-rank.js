/**
 * 关注排行榜
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');
const ErrorHandler = require('../../../utils/errorHandler');
const { Logger } = require('../../../utils/logger');
const AvatarHelper = require('../../../utils/avatarHelper');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },
  behaviors: [adminBehavior, safeSetDataBehavior],
  data: {
    list: [],
    loading: true,
    // 同 meet-rank：加载失败必须是独立状态，不能被渲染成「暂无记录」
    loadFailed: false,
    skeletonItems: [1, 2, 3, 4, 5]
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 鉴权失败不能只 return：loading 仍为 true → 骨架屏永驻。
      // 与 admin.js 一致：提示后 1.5s 自动返回（onUnload 已清理该定时器，防连退）。
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    this.loadRank();
  },

  onPullDownRefresh() {
    this.loadRank().finally(() => wx.stopPullDownRefresh());
  },

  onRetryLoad() {
    this.loadRank();
  },

  async loadRank() {
    // 在途锁：口径同 meet-rank（onLoad / 下拉刷新 / 重试三者并发）
    if (this._loadingRank) return;
    this._loadingRank = true;
    this.setData({ loading: true });
    try {
      const res = await this.callAdminFunction('getFavRank', { limit: 50 });

      if (res.result?.success) {
        const data = res.result?.data ?? res.result ?? {};
        // 云函数返回的 avatar 是裸 cloud:// fileID，直接当 <image src> 会绕过尺寸档位加载全尺寸原图，
        // 需统一解析成 avatar 档位的临时链接（同 mediaHelper 的处理口径）
        const list = await AvatarHelper.resolveCatAvatars(data.list || []);
        this.safeSetData({ list, loadFailed: false });
      } else {
        this.safeSetData({ loadFailed: true });
        ErrorHandler.handle(new Error(res.result?.error || '加载失败'), { title: '加载失败' });
      }
    } catch (err) {
      Logger.warn('fav-rank', '加载排行榜失败', { error: err.message });
      this.safeSetData({ loadFailed: true });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingRank = false;
      this.safeSetData({ loading: false });
    }
  },

  onGoToDetail(e) {
    const catId = e.currentTarget.dataset.catId;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
  }
});
