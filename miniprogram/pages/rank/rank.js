/**
 * 猫咪排行榜 - 支持云吸/关注/相遇三种排行
 */
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const AvatarHelper = require('../../utils/avatarHelper');
const ShareHelper = require('../../utils/shareHelper');
const opsTrack = require('../../utils/opsTrack');
const cacheBehavior = require('../../behaviors/cacheBehavior');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');

const TYPE_META = {
  view: {
    title: '云吸排行',
    countLabel: '累计',
    countUnit: '次云吸',
    emptyIcon: 'eye',
    emptySubtitle: '暂无猫咪被云吸过'
  },
  fav: {
    title: '关注排行',
    countLabel: '被',
    countUnit: '人关注',
    emptyIcon: 'heart-double',
    emptySubtitle: '暂无猫咪被关注'
  },
  meet: {
    title: '相遇排行',
    countLabel: '被',
    countUnit: '次相遇',
    emptyIcon: 'paw',
    emptySubtitle: '暂无猫咪被相遇'
  }
};

Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    this.destroyGuideTour();
  },
  behaviors: [cacheBehavior, guideTourBehavior, safeSetDataBehavior],
  data: {
    currentType: 'view',
    list: [],
    loading: true,
    typeMeta: TYPE_META.view,
    // 分页加载（触底加载更多）
    rankOffset: 0,
    rankPageSize: 20,
    hasMore: false,
    loadingMore: false,
    // 首屏加载失败（列表为空时展示错误态 + 重试）
    loadError: false,
    skeletonItems: [1, 2, 3, 4, 5, 6, 7]
  },

  _loadingRank: false,
  _loadingMoreRank: false,

  onLoad(options = {}) {
    // 分享卡片可带 type 参数直达对应榜单（无参/非法值回落默认云吸榜）。
    // 不带参数时接收方永远落在云吸榜，与分享文案承诺的榜单不一致（数据完全不同）。
    const type = options && TYPE_META[options.type] ? options.type : '';
    if (type && type !== this.data.currentType) {
      this.setData({ currentType: type, typeMeta: TYPE_META[type] });
    }
    this.loadRank();
  },

  onShow() {
    opsTrack.entry('rank');
    this.initGuideTour('pages/rank/rank', { delay: 700 });
    this.loadWithCache(() => this.loadRank(), { validTime: 30000 });
  },

  onHide() {
    this.pauseGuideTour();
  },

  onPullDownRefresh() {
    this.loadRank().finally(() => wx.stopPullDownRefresh());
  },

  onSwitchTab(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.currentType) return;

    this.setData({
      currentType: type,
      typeMeta: TYPE_META[type],
      loading: true,
      list: [],
      hasMore: false,
      rankOffset: 0
    });
    // 打断在途的旧 Tab 请求：递增序号使其响应被丢弃，并释放锁让新 Tab 立即加载
    this._rankSeq = (this._rankSeq || 0) + 1;
    this._loadingRank = false;
    // 分页锁一并释放：若「加载更多」在途时切了 Tab，该请求的 finally 会因 stale()
    // 为真而跳过释放（见 loadRank 末尾）。当前不会造成永久泄漏——最后发出的请求
    // seq 必然等于 _rankSeq，总由它兜底释放——但依赖这个隐式推理太脆：
    // 任何一处新增「提前 return 且不复位」的分支都可能把它打破，故显式对称释放。
    this._loadingMoreRank = false;
    this.loadRank();
  },

  /**
   * 加载排行榜
   * @param {boolean} reset - true 重置加载第一页；false 触底加载下一页
   */
  async loadRank(reset = true) {
    if (reset) {
      if (this._loadingRank) return;
      this._loadingRank = true;
      this.setData({ loading: true, loadError: false, hasMore: false, rankOffset: 0 });
    } else {
      if (this._loadingRank || this._loadingMoreRank || this.data.loading || !this.data.hasMore) return;
      this._loadingMoreRank = true;
      this.setData({ loadingMore: true });
    }

    // 请求序号：Tab 快速切换时旧 Tab 的响应按序号丢弃，避免旧数据渲染在新 Tab 下
    this._rankSeq = (this._rankSeq || 0) + 1;
    const seq = this._rankSeq;
    const stale = () => seq !== this._rankSeq;

    try {
      const offset = reset ? 0 : this.data.rankOffset;
      const res = await wx.cloud.callFunction({
        name: 'getCatRank',
        data: {
          type: this.data.currentType,
          limit: this.data.rankPageSize,
          offset
        }
      });

      if (stale()) return;

      if (res.result?.success) {
        await this._applyRankResult(res.result, reset, offset, stale);
      } else {
        // 列表为空时展示错误态；已有数据时仅 toast
        if (reset && this.data.list.length === 0) this.safeSetData({ loadError: true });
        ErrorHandler.handle(new Error(res.result?.error || '加载失败'), { title: '加载失败' });
      }
    } catch (err) {
      if (stale()) return;
      Logger.warn('rank', '加载排行榜失败', { error: err.message });
      if (reset && this.data.list.length === 0) this.safeSetData({ loadError: true });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      // 仅最新请求有权释放锁与清理 UI 状态
      if (!stale()) {
        this._loadingRank = false;
        this._loadingMoreRank = false;
        this.safeSetData({ loading: false, loadingMore: false });
      }
    }
  },

  /**
   * 应用排行榜查询结果：头像转换 + catId 去重 + 追加
   *
   * @param {Function} stale - 请求序号守卫，返回 true 表示该请求已过期
   */
  async _applyRankResult(result, reset, offset, stale) {
    const data = result?.data ?? result ?? {};
    let newList = data.list || [];

    if (newList.length > 0) {
      newList = await AvatarHelper.resolveCatAvatars(
        newList,
        reset ? [] : this.data.list
      );
    }

    // 头像解析是异步的：等待窗口内用户可能已切 Tab（onSwitchTab 会清空 list 并递增 _rankSeq），
    // 旧 Tab 的结果不得写入新 Tab。与 loadRank 内其它分支使用同一 stale() 机制。
    if (stale()) return;

    // 按 catId 去重，防止翻页交界处重复
    const existingIds = new Set(reset ? [] : this.data.list.map(c => c.catId));
    const uniqueNew = newList.filter(c => !existingIds.has(c.catId));

    this.safeSetData({
      list: reset ? uniqueNew : [...this.data.list, ...uniqueNew],
      rankOffset: offset + newList.length,
      hasMore: newList.length >= this.data.rankPageSize
    });
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore) {
      this.loadRank(false);
    }
  },

  /**
   * 错误态重试
   */
  onRetryLoad() {
    this.loadRank();
  },

  onGoToDetail(e) {
    const catId = e.currentTarget.dataset.catId;
    if (catId) wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
  },

  onShareAppMessage() {
    const { currentType, list } = this.data;
    const type = TYPE_META[currentType] ? currentType : 'view';
    const meta = this.data.typeMeta || TYPE_META[type];
    const first = (list || [])[0];
    const firstName = first && (first.catName || '这只猫');
    const titles = first
      ? [
        `「${firstName}」领跑校园${meta.title}`,
        `校园猫咪${meta.title} | 第一名是${firstName}`,
        `校园猫猫${meta.title}，看看你认识几只`
      ]
      : [
        `校园猫猫${meta.title}，快来看看吧`,
        `校园猫咪${meta.title} | 每一只都值得被看见`
      ];
    const share = {
      title: ShareHelper.pickTitle(titles),
      // 带上当前榜单类型：不带的话接收方永远落在默认的「云吸排行」，
      // 与卡片文案承诺的榜单不一致（数据完全不同）
      path: `/pages/rank/rank?type=${encodeURIComponent(type)}`,
      // 榜单是聚合页：第一名那只猫只出现在标题里，封面统一用品牌卡。
      // 拿第一只猫的头像当 5:4 图会被裁成大头照（2026-10-22 反馈）。
      imageUrl: ShareHelper.randomBrandImage()
    };
    return share;
  },

  onShareTimeline() {
    const { currentType, list } = this.data;
    const type = TYPE_META[currentType] ? currentType : 'view';
    const meta = this.data.typeMeta || TYPE_META[type];
    const first = (list || [])[0];
    const firstName = first && (first.catName || '这只猫');
    const share = {
      title: first
        ? `「${firstName}」领跑校园${meta.title}`
        : `校园猫猫${meta.title}`,
      query: `type=${encodeURIComponent(type)}`,
      imageUrl: ShareHelper.randomBrandImage()
    };
    return share;
  }

});
