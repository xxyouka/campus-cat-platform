/**
 * 相遇打卡排行榜
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
    // 加载失败必须是独立状态：否则 catch 后列表保持空数组，
    // wxml 会把「加载失败」渲染成「暂无记录」，把故障伪装成业务空
    loadFailed: false,
    skeletonItems: [1, 2, 3, 4, 5]
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 鉴权失败不能只 return：loading 仍为 true → 骨架屏永驻，用户只能手动返回。
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
    // 在途锁：onLoad / 下拉刷新 / 重试按钮三者都能并发进来。
    // 不锁的话一次连续下拉就打多个 getMeetRank（重复消耗配额），
    // 而且**先返回的旧响应会在后发请求还在途时把 loading 清掉** ——
    // 列表先闪一下再变，比慢本身更让人以为出错了。
    if (this._loadingRank) return;
    this._loadingRank = true;
    this.setData({ loading: true });
    try {
      const res = await this.callAdminFunction('getMeetRank', { limit: 50 });

      if (res.result?.success) {
        const data = res.result?.data ?? res.result ?? {};
        // 先解析 avatar 档位临时链接（裸 cloud:// 当 <image src> 会加载全尺寸原图），再格式化时间
        const resolved = await AvatarHelper.resolveCatAvatars(data.list || []);
        const list = resolved.map(item => ({
          ...item,
          lastMeetTime: item.lastMeetTime
            ? this._formatTime(item.lastMeetTime)
            : ''
        }));
        this.safeSetData({ list, loadFailed: false });
      } else {
        this.safeSetData({ loadFailed: true });
        ErrorHandler.handle(new Error(res.result?.error || '加载失败'), { title: '加载失败' });
      }
    } catch (err) {
      Logger.warn('meet-rank', '加载排行榜失败', { error: err.message });
      this.safeSetData({ loadFailed: true });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingRank = false;
      this.safeSetData({ loading: false });
    }
  },

  _formatTime(ts) {
    const d = new Date(ts);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${m}月${day}日`;
  },

  onGoToDetail(e) {
    const catId = e.currentTarget.dataset.catId;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
  }
});
