/**
 * 公告列表页面
 */
const { Logger } = require('../../utils/logger');
const { formatDateShort } = require('../../utils/dateFormat');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');
const cacheBehavior = require('../../behaviors/cacheBehavior');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const ShareHelper = require('../../utils/shareHelper');
const opsTrack = require('../../utils/opsTrack');

Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    this.destroyGuideTour();
  },
  behaviors: [backToTopBehavior, cacheBehavior, guideTourBehavior, safeSetDataBehavior],
  data: {
    statusBarHeight: 0,
    notices: [],
    loading: true,
    networkError: false,
    showBackTop: false,
    expandedIndex: -1,
    page: 1,
    hasMore: false,
    loadingMore: false,
    skeletonItems: [1, 2, 3]
  },

  onLoad() {
    // 沉浸式顶部：获取状态栏高度
    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });

    this._backToTopThreshold = 400; // 自定义阈值
    this._markAsRead();
    this.loadNotices();
  },

  /**
   * 标记公告已读
   */
  _markAsRead() {
    const latestTime = wx.getStorageSync('latestNoticeTime') || new Date().toISOString();
    wx.setStorageSync('lastNoticeReadTime', latestTime);
  },

  async loadNotices() {
    // 请求序号：onShow 每次切回都重拉首屏，与 loadMoreNotices / onRetry 并发时，
    // 旧响应后到会把新列表覆盖成旧数据。这与 notifications.js:56-85 是同一条
    // 逻辑的两个副本 —— 那边早已加了 seq 守卫，这边一直漏着。
    this._listSeq = (this._listSeq || 0) + 1;
    const seq = this._listSeq;

    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getNotices',
        data: { page: 1, pageSize: 20 }
      });

      if (seq !== this._listSeq) return;

      if (res.result && res.result.success) {
        const data = res.result?.data ?? res.result ?? {};
        const notices = (data.notices || []).map(n => ({
          ...n,
          createTimeStr: formatDateShort(n.createTime)
        }));
        this.safeSetData({
          notices,
          page: 1,
          hasMore: data.hasMore || false,
          // 成功后必须清除错误态：否则一次失败后的横幅会叠在已恢复的列表上
          networkError: false
        });
        this._noticesData = notices;
      } else {
        // 业务失败（success:false / result 缺失）此前什么都不做 → 静默落入「暂无公告」空态
        Logger.warn('notice', '公告接口返回失败', { error: res.result && res.result.error });
        this.safeSetData({ networkError: true });
      }
    } catch (err) {
      if (seq !== this._listSeq) return;
      Logger.error('notice', '加载失败', err);
      this.safeSetData({ networkError: true });
    } finally {
      // loading 的释放放 finally：此前在 try/catch 之后，一旦中途 return
      // （例如上面的 seq 校验）就会永远停在 loading 态
      if (seq === this._listSeq) this.safeSetData({ loading: false });
    }
  },

  onRetry() {
    this.setData({ networkError: false });
    this.loadNotices();
  },

  async loadMoreNotices() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    // 与 loadNotices 共用 _listSeq：首屏刷新会令本次分页响应作废，
    // 否则「第 1 页 + 第 3 页」拼接、第 2 页被静默吞掉且 page 记为 3，缺口不自愈
    const seqAtStart = this._listSeq || 0;
    this.setData({ loadingMore: true });

    try {
      const nextPage = this.data.page + 1;
      const res = await wx.cloud.callFunction({
        name: 'getNotices',
        data: { page: nextPage, pageSize: 20 }
      });

      if (seqAtStart !== (this._listSeq || 0)) {
        this.safeSetData({ loadingMore: false });
        return;
      }

      if (res.result && res.result.success) {
        const data = res.result?.data ?? res.result ?? {};
        const newNotices = (data.notices || []).map(n => ({
          ...n,
          createTimeStr: formatDateShort(n.createTime)
        }));
        const notices = [...this.data.notices, ...newNotices];
        this.safeSetData({
          notices,
          page: nextPage,
          hasMore: data.hasMore || false
        });
        this._noticesData = notices;
      }
    } catch (err) {
      Logger.error('notice', '加载更多失败', err);
    } finally {
      if (seqAtStart === (this._listSeq || 0)) {
        this.safeSetData({ loadingMore: false });
      }
    }
  },

  onShow() {
    opsTrack.entry('notice');
    this.initGuideTour('pages/notice/notice', { delay: 800 });
    // 首屏跳过守卫：onLoad 已经调过 loadNotices，首次 onShow 的缓存时间戳还是 0、
    // 判定失效，于是同一份公告会被请求两遍（第一次的响应被 _listSeq 作废丢弃）。
    // 口径同 notice-manage.js:63-66 与 profile.js 的 onShow 守卫。
    if (!this._firstShowSkipped) {
      this._firstShowSkipped = true;
      return;
    }
    this.loadWithCache(() => this.loadNotices(), { validTime: 30000 });
  },

  onHide() {
    this.pauseGuideTour();
  },

  // onPageScroll 和 onBackToTop 由 backToTopBehavior 提供（含节流）

  /**
   * 返回上一页
   */
  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  onToggleExpand(e) {
    const { index } = e.currentTarget.dataset;
    const { expandedIndex } = this.data;
    this.setData({ expandedIndex: expandedIndex === index ? -1 : index });
  },

  onReachBottom() {
    this.loadMoreNotices();
  },

  /**
   * 分享给朋友
   *
   * 优先带上用户正在看的那条公告（展开了就用展开的，否则用最新一条）：
   * 只写「公告栏」对接收方没有信息量，带标题才知道点开值不值。
   */
  onShareAppMessage() {
    const notice = this._shareNotice();
    const noticeTitle = notice ? ShareHelper.truncate(notice.title, 22) : '';
    const titles = noticeTitle
      ? [
        `${noticeTitle} | 校园猫猫公告`,
        `${noticeTitle} - 校园猫咪最新动态`
      ]
      : [
        '校园公告 | 了解猫咪最新动态',
        '校园猫猫小程序公告栏',
        '关注校园猫咪资讯 - 校园猫猫'
      ];
    return {
      title: ShareHelper.pickTitle(titles),
      path: '/pages/notice/notice'
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const notice = this._shareNotice();
    const noticeTitle = notice ? ShareHelper.truncate(notice.title, 22) : '';
    return {
      title: noticeTitle
        ? `${noticeTitle} | 校园猫猫`
        : '校园猫咪公告 | 了解最新动态',
      query: ''
    };
  },

  /** 当前要分享的公告：展开中的那条优先，否则最新一条 */
  _shareNotice() {
    const notices = this.data.notices || [];
    const expanded = this.data.expandedIndex;
    if (expanded >= 0 && notices[expanded]) return notices[expanded];
    return notices[0] || null;
  },


});
