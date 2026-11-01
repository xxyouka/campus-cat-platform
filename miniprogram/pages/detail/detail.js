/**
 * pages/detail/detail.js - 猫咪详情页（精简版）
 *
 * 职责：展示猫咪详细信息、照片墙、相遇打卡
 * 已拆分子模块：
 * - services/photoService.js — 照片加载/预取/点赞/预览
 * - services/meetService.js — 相遇打卡/状态检查
 */
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const { getPageStateManager } = require('../../utils/pageState');
const { monitorPageLoad } = require('../../utils/performanceMonitor');
const AvatarHelper = require('../../utils/avatarHelper');
const ShareHelper = require('../../utils/shareHelper');

// 回访详情页时的最小刷新间隔：从关系猫详情返回、或从其他子页返回时，
// 「今日是否打卡 / 最近相遇 / 关注状态」三个区块在 10s 内没必要全量重拉
//（原先每次 onShow 都重发 3 个云调用）。pageState.checkNeedRefresh 命中时绕过。
const DETAIL_MEET_REFRESH_WINDOW = 10000;
const _config = require('../../config');
const obsHelper = require('../../utils/obsHelper');
const _imageLoader = require('../../utils/imageLoader');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const photoService = require('../../services/photoService');
const meetService = require('../../services/meetService');
// 管理员判定只用于「管理这段关系」入口的显隐，不做任何数据判断；
// 真正的写入门禁在 relation-manage 页（requireAdminAuth）与云函数 checkAdmin。
const { checkAdminAuth } = require('../../utils/adminAuth');

// 只有「已经画好底图」的校区才能给选点入口：没底图的校区给了入口，
// 用户会把点打在别的校区的图上，而服务端按 cats.campus 标成另一个校区 ——
// 产出一份永远显示不出来的坐标。底图清单收在 utils/campusMapRegistry（唯一来源）。
const { resolveZone, hasMap } = require('../../utils/campusMapRegistry');

/**
 * 这只猫能不能给地图选点入口。
 *
 * 收在这一个函数里，而不是在两条加载路径上各判一次：
 * 详情页有「预取秒开」与「云函数加载」两条路，只有后者会 setData 这个标记。
 * 漏掉秒开那条时的表现极具迷惑性 —— 首页列表点进来没按钮、分享链接进来有按钮，
 * 而猫确实是本部的，看起来就像按钮随机消失。
 *
 * @param {object} cat 猫档案（预取快照里也带 campus：CAT_LIST_FIELDS 是排除式投影）
 * @returns {boolean}
 */
function canPickMapPointFor(cat) {
  const zone = String(cat && cat.campus || '').trim();
  return !!zone && hasMap(zone);
}

Page({
  behaviors: [backToTopBehavior, guideTourBehavior, safeSetDataBehavior],

  data: {
    // 沉浸式顶部
    statusBarHeight: 0,
    // 猫咪详情
    catId: '',
    cat: {},
    // 好猫星级五颗星的槽位（渲染 5 颗，实心数 = cat.adoptLevel）
    starSlots: [1, 2, 3, 4, 5],
    updateTime: '',
    // 导航栏是否已随页面滚动切换为实底（透明主题下白字压在照片上不可读）
    navbarScrolled: false,
    // viewCountDisplay 定义在骨架屏区域下方（line 70）
    // 在此定义会导致重复
    // 照片集
    photos: [],
    photoPage: 0,
    showBackToTop: false,
    photoPageSize: 30,
    hasMorePhotos: true,
    // 状态
    loading: true,
    loadingMore: false,
    loadError: false,
    // 'notfound' = 猫咪确实不存在；'network' = 网络/服务异常（两者文案与操作不同）
    loadErrorType: '',
    // 统计
    totalLikes: 0,
    // 照片总数（服务端返回；photos.length 只是已加载分页数，>1 页时会少报）
    photoTotal: 0,
    // 相遇打卡
    hasMetToday: false,
    todayMeetCount: 0,
    recentMeets: [],
    showMeetPanel: false,
    selectedLocation: '',
    // 地图选点结果 {u, v, label, campusZone}；null = 没选（服务端保留旧坐标）
    meetPoint: null,
    // 这只猫所属校区是否已有底图（见 BASEMAP_ZONE 注释）
    canPickMapPoint: false,
    selectedStatusTag: '',
    isCustomStatus: false,
    customStatusText: '',
    meetNote: '',
    meetSubmitting: false,
    meetStatusTags: [
      { icon: 'cat-happy', text: '相遇了' },
      { icon: 'moon', text: '在睡觉' },
      { icon: 'utensils', text: '在吃饭' },
      { icon: 'gamepad', text: '在玩耍' },
      { icon: 'paw', text: '在散步' },
      { icon: 'heart-handshake', text: '求摸摸' }
    ],
    relationCats: [],
    // 管理员入口（「管理这段关系」）是否可见：本页是公共页面，只有管理员才需要它。
    // 用 checkAdminAuth 的本地判定（含签名校验，篡改即清登录态），口径同 profile.js。
    isAdminEntryVisible: false,
    // 骨架屏
    showSkeleton: true,
    viewCountDisplay: '',
    // 导航栏高度（由 custom-navbar 组件通过 heightchange 事件提供）
    navBarTotalHeight: 0,
    // 心跳动画
    heartAnimation: null,
    skeletonItems: [1, 2, 3, 4]
  },

  // ========== 生命周期 ==========

  async onLoad(options) {
    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });

    const catId = options.id;
    const Validator = require('../../utils/validator');
    // autoBack: false —— 返回由本页自建的 _navBackTimer 负责（onUnload 可清理）。
    // 若 validator 也返回一次，两个定时器会把上一页也弹掉（连退两层）。
    if (!Validator.validateCatId(catId, { autoBack: false })) {
      // 提示后返回上一页（此前误传 handle() 不识别的 backOnFail，页面停留在空白态）
      ErrorHandler.handle(new Error('无效的猫咪ID'), { title: '参数错误' });
      // 保存句柄：用户 1.5s 内自己按返回时 onUnload 清理，避免定时器再退一层
      this._navBackTimer = setTimeout(() => {
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
      }, 1500);
      return;
    }
    this.setData({ catId });

    // 静默记录浏览量（含本地队列兜底）
    this._recordViewWithFallback(catId);

    // 预取缓存检查（秒开优化）
    const app = getApp();
    const prefetchCache = app.getPrefetchCache(catId);
    const isFresh = prefetchCache && Date.now() - prefetchCache.timestamp < 5000;
    this.checkFavoriteStatus();

    // 「最近相遇 / 今日打卡状态」只依赖 catId（上方已同步赋值），与主内容**并行**加载：
    // 旧实现非缓存路径把它们放在主内容 Promise.all 的 .then() 之后，且 loadRecentMeets
    // 内部两次云调用还是串行 —— 用户看到的就是「猫咪信息先出来，过一会儿最近相遇才
    // 蹦出来」。立即并行发起，各区块才能几乎同时出现。
    this.checkTodayMeetStatus();
    this.loadRecentMeets();

    if (isFresh) {
      Logger.info('detail', '使用预取缓存数据，秒开');
      await photoService.applyPrefetchCache(this, prefetchCache, catId);
      // 秒开这条路不经过 loadCatDetail，canPickMapPoint 必须在这里补上，
      // 否则「从首页列表点进来」永远看不到定位按钮（分享链接进来又看得到）。
      this.safeSetData({ canPickMapPoint: canPickMapPointFor(this.data.cat) });
      app.globalData._prefetchCache.delete(catId);
      // 秒开路径也要加载关系区块，否则 index→detail 的常态入口下「TA的关系」恒不渲染
      this.loadRelationCats();
    } else {
      monitorPageLoad('detail', () =>
        Promise.all([this.loadCatDetail(), this.loadPhotos()])
      ).catch(err => {
        Logger.error('detail', '页面数据加载失败', err);
        this.safeSetData({ loading: false, showSkeleton: false });
      });
    }
  },

  onShow() {
    if (!this.data.cat || !this.data.cat._id) return;
    this.initGuideTour('pages/detail/detail', { delay: 500 });

    // 管理员入口显隐：每次 onShow 重算，管理员登录 / 退出后返回本页即可生效
    this.setData({ isAdminEntryVisible: this._checkAdminEntry() });

    // 回访窗口：从关系猫详情返回、或从其他子页返回时，这三个区块没必要全量重拉。
    // 首进时 _lastMeetRefreshAt 未设置，一定放行。
    // pageState.checkNeedRefresh 命中时绕过窗口，保证数据变更后立刻刷新。
    const pageState = getPageStateManager();
    const refreshData = pageState.checkNeedRefresh('detail');
    const forced = !!refreshData;
    const withinWindow = this._lastMeetRefreshAt &&
      Date.now() - this._lastMeetRefreshAt < DETAIL_MEET_REFRESH_WINDOW;

    if (this.data.catId && (!withinWindow || forced)) {
      this._lastMeetRefreshAt = Date.now();
      this.checkFavoriteStatus();
      this.checkTodayMeetStatus();
      this.loadRecentMeets();
    }

    const shouldRefreshPhotos = refreshData && (
      refreshData.action === 'photo_added' || refreshData.action === 'photo_deleted' ||
      refreshData.action === 'update'
    );

    if (shouldRefreshPhotos) {
      Logger.info('detail', '检测到数据变更，强制刷新照片列表', { action: refreshData.action });
      if (refreshData.action === 'update') this.loadCatDetail();
      this.loadPhotos(true);
    }
  },

  onHide() {
    this.pauseGuideTour();
  },

  onUnload() {
    this._isUnmounted = true;
    this.destroyGuideTour();
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    if (this._fullPhotosTimer) { clearTimeout(this._fullPhotosTimer); this._fullPhotosTimer = null; }
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    this._loadingPhotos = false;
  },

  // ========== 猫咪详情 ==========

  async onPullDownRefresh() {
    // detail.json 开启了下拉刷新：只刷新照片列表，并停止刷新动画。
    // 不再调用 loadCatDetail()：它会先 setData({ loading: true })，而 detail.wxml 用
    // wx:if="{{!loading}}" 门控全部正文（骨架屏在 wx:if="{{loading}}"），
    // 每次下拉都会销毁重建整页并丢失滚动位置。
    try {
      await this.loadPhotos(true);
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async loadCatDetail() {
    try {
      // 重试时复位错误态，避免错误页与加载态同时生效
      this.setData({ loading: true, loadError: false });
      const { monitorApi } = require('../../utils/performanceMonitor');
      const { formatDateShort } = require('../../utils/dateFormat');
      const res = await monitorApi('detail-getCat', () =>
        wx.cloud.callFunction({
          name: 'getCatDetail',
          data: { catId: this.data.catId }
        }).then(r => {
          const result = r.result || {};
          if (!result.success) throw new Error(result.error || '查询失败');
          // cat 为空 = 这只猫确实不存在。用 [NOT_FOUND] 标记，与网络/服务异常区分开：
          // 前者没有重试的意义，后者必须给「重新加载」而不是误报「已被删除」
          if (!result.data || !result.data.cat) {
            throw new Error('[NOT_FOUND] 猫咪不存在');
          }
          return { data: result.data.cat };
        })
      );
      const cat = res.data;

      cat.updateTime = formatDateShort(cat.updateTime) || '';
      if (cat.deceasedTime) cat.deceasedTime = formatDateShort(cat.deceasedTime);
      if (cat.lostTime) cat.lostTime = formatDateShort(cat.lostTime);

      const avatarUrl = cat.avatar || cat.images && cat.images[0] || '';

      // 头像转链不阻塞正文：先把原始值（cloud:// 时 <image> 原生可渲染）下发并解除 loading，
      // 转链结果后台补丁。旧实现要在 setData 前 await 一次完整往返（150~300ms），
      // 非预取路径（分享进入 / 键盘操作 / 触摸预取被滑动取消）每次进入都要多等这一段。
      cat._tempAvatarUrl = avatarUrl;
      cat.avatarLoaded = false;

      this.safeSetData({
        cat: { ...cat, avatar: avatarUrl },
        updateTime: cat.updateTime || '',
        loading: false,
        showSkeleton: false,
        canPickMapPoint: canPickMapPointFor(cat),
        viewCountDisplay: cat.viewCount >= 1000 ? (cat.viewCount / 1000).toFixed(1) + 'k' : cat.viewCount || 0
      });

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.VIEW_CAT, {
        cat_id: this.data.catId.substring(0, 8), cat_name: cat.name
      });

      this.loadRelationCats();
      if (avatarUrl) this._resolveAvatarInBackground(avatarUrl);
      this.initGuideTour('pages/detail/detail', { delay: 1200 });
    } catch (err) {
      Logger.error('detail', '加载猫咪详情失败', err);
      const notFound = String(err && err.message || '').includes('[NOT_FOUND]');
      this.safeSetData({
        loadError: true,
        loadErrorType: notFound ? 'notfound' : 'network',
        loading: false,
        showSkeleton: false
      });
      ErrorHandler.handle(err, { title: notFound ? '猫咪不存在' : '加载失败' });
    }
  },

  /** 详情加载失败后的「重新加载」（仅网络/服务异常时提供） */
  onRetryLoad() {
    this.loadCatDetail();
  },

  /**
   * 后台解析头像临时链接并补丁（不阻塞正文渲染，见 loadCatDetail 的说明）。
   *
   * 补丁前必须校验「原始值仍是当前值」：详情页会被复用于关系猫之间的跳转，
   * 期间 cat 可能已被新一次加载整体替换，此时把上一只猫的转链结果写进去
   * 就是给新猫配了旧头像（且不会自愈 —— 值一旦写进去，_tempAvatarUrl 与
   * avatar 都"看起来"是转好的链接）。
   * @param {string} rawAvatar - 本次加载拿到的原始头像值（cloud:// 或 http）
   */
  async _resolveAvatarInBackground(rawAvatar) {
    try {
      const resolved = await AvatarHelper.resolveCatAvatars([{ avatar: rawAvatar }], []);
      const url = resolved[0]?.avatar;
      // 解析失败时 resolveCatAvatars 会把 cloud:// 原样返回，这里自然跳过补丁
      if (!url || url === rawAvatar || this._isUnmounted) return;

      const cat = this.data.cat;
      if (!cat || cat._tempAvatarUrl !== rawAvatar) return;

      this.safeSetData({
        'cat.avatar': url,
        'cat._tempAvatarUrl': url,
        'cat.avatarLoaded': true
      });
    } catch (err) {
      Logger.warn('detail', '后台解析头像失败（非致命）', { error: err.message });
    }
  },

  // ========== 照片（委托给 photoService）==========

  async loadPhotos(reset = false) {
    await photoService.loadPhotos(this, reset);
  },

  /**
   * 触底加载更多照片（detail.json 已配置 onReachBottomDistance: 100）
   */
  onReachBottom() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMorePhotos) return;
    this.loadPhotos(false);
  },

  /**
   * 滚动扩展钩子（由 backToTopBehavior 的节流 onPageScroll 调用）：
   * 驱动导航栏主题切换（透明 → 实底），避免白字压在照片上不可读。
   *
   * 不能在本页直接定义 onPageScroll：那会遮蔽 behavior 的同名方法
   *（behavior 用 Behavior() 包装、方法挂在实例上，无法从模块顶层转发）。
   */
  _onPageScrollExtra(e) {
    const scrolled = (e && e.scrollTop || 0) > 80;
    if (scrolled !== this._navbarScrolled) {
      this._navbarScrolled = scrolled;
      this.safeSetData({ navbarScrolled: scrolled });
    }
  },

  _loadFullPhotosQuietly() {
    photoService.loadFullPhotosQuietly(this);
  },

  onPreviewPhoto(e) {
    // 预览前会按 detail 档换链（异步），返回 Promise 便于调用方/测试等待
    return photoService.onPreviewPhoto(this, e);
  },

  async saveImageToAlbum(e) {
    await photoService.saveImageToAlbum(this, e);
  },

  async onTogglePhotoLike(e) {
    await photoService.togglePhotoLike(this, e);
  },

  _computeTotalLikes(photos) {
    const total = (photos || []).reduce((sum, p) => sum + (p.likeCount || 0), 0);
    if (total !== this.data.totalLikes) this.setData({ totalLikes: total });
  },

  _formatViewCount(count) {
    if (!count || count <= 0) return '';
    if (count >= 1000) return (count / 1000).toFixed(1).replace(/0$/, '') + 'k 次云吸';
    return count + ' 次云吸';
  },

  // ========== 相遇打卡（委托给 meetService）==========

  checkTodayMeetStatus() {
    meetService.checkTodayMeetStatus(this);
  },

  onOpenMeetPanel() {
    this.setData({ showMeetPanel: true });
  },

  onCloseMeetPanel() {
    this.setData({ showMeetPanel: false });
  },

  /**
   * 好猫星级解释：未评级不代表猫不好，避免用户把「没星」误读成差评。
   */
  onShowAdoptHelp() {
    wx.showModal({
      title: '好猫星级',
      content: '3 星以上表示这只猫更适合家养，是给想领养的同学的参考。\n没打星只是还没评，不代表猫不好。',
      showCancel: false,
      confirmText: '知道了'
    });
    obsHelper.reportEvent(obsHelper.EVENT_NAMES.FEATURE_FIRST_USE, { feature: 'adopt_level_help' });
  },

  onLocationInput(e) {
    this.setData({ selectedLocation: e.detail.value });
  },

  /**
   * 跳到地图选点页。
   *
   * 只有「已经画好底图」的校区的猫能选（清单见 utils/campusMapRegistry）：
   * 别的校区给了选点入口，用户会把点打在错的底图上，而服务端又会按
   * cats.campus 标成那只猫的校区 —— 结果是一份永远显示不出来的坐标。
   * 所以这里直接不给入口，校区随跳转一起传过去（选点页据此选底图）。
   */
  onPickMapPoint() {
    if (!this.data.canPickMapPoint) {
      wx.showToast({ title: '该校区的地图还没画好', icon: 'none' });
      return;
    }

    const page = this;
    const zone = resolveZone(this.data.cat && this.data.cat.campus);
    wx.navigateTo({
      url: `/subpackages/map/campus-map/campus-map?mode=select&zone=${encodeURIComponent(zone)}`,
      events: {
        // 选点页确定时回传坐标
        pickpoint(point) {
          if (!point) return;

          // 只点了「地图选点」、没拖动也没点图：选点页回传 isDefault。
          // 这时用户并没有选具体地点，不能把默认视角的坐标当成相遇点，
          // 地点文字按「校园内」记 —— 否则每条这样的打卡都会落到同一个假位置。
          if (point.isDefault) {
            if (!page.data.selectedLocation) {
              page.setData({ selectedLocation: point.label || '校园内' });
            }
            return;
          }

          page.setData({ meetPoint: point });
          // 顺手把地点文字填上，省一次输入。选点页给的是最近建筑名，
          // 用户可以自己改（改字不影响坐标，两者独立）。
          //
          // 选到的是空地（label 为空）时也要填：否则输入框留着 placeholder，
          // 看起来像「什么都没选」，但其实坐标已经定了 —— 用户会被这骗到。
          if (!page.data.selectedLocation) {
            page.setData({ selectedLocation: point.label || '校内空地' });
          }
        }
      }
    });
  },

  /**
   * 撤掉地图坐标。
   *
   * 连地点文字一起清：那个字是选点时从地点名自动填进去的，
   * 只清坐标会留下「写着食堂、却没有位置」的自相矛盾状态。
   */
  onClearMapPoint() {
    this.setData({ meetPoint: null, selectedLocation: '' });
  },

  onSelectStatusTag(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({ selectedStatusTag: tag, isCustomStatus: false, customStatusText: '' });
  },

  onTapCustomStatus() {
    this.setData({ isCustomStatus: true, selectedStatusTag: '' });
  },

  onCustomStatusInput(e) {
    this.setData({ customStatusText: e.detail.value });
  },

  onCustomStatusConfirm() {
    if (this.data.customStatusText.trim()) {
      this.setData({ selectedStatusTag: this.data.customStatusText.trim() });
    }
  },

  onMeetNoteInput(e) {
    this.setData({ meetNote: e.detail.value });
  },

  async onSubmitMeet(_e) {
    await meetService.submitMeet(this);
  },

  async loadRecentMeets() {
    await meetService.loadRecentMeets(this);
  },

  // ========== 心跳动画 ==========

  _playHeartbeatAnimation() {
    const animation = wx.createAnimation({
      duration: 150,
      timingFunction: 'ease-out'
    });

    animation.scale(1.3).step({
      duration: 150,
      timingFunction: 'ease-out'
    });

    animation.scale(1).step({
      duration: 150,
      timingFunction: 'ease-out'
    });

    this.setData({
      heartAnimation: animation.export()
    });
  },

  // ========== 关注 ==========

  async toggleFavorite() {
    // 防连击
    if (this._toggleFavLock) return;
    this._toggleFavLock = true;

    try {
      const catId = this.data.catId;
      const catName = this.data.cat && this.data.cat.name || '';
      const raw = wx.getStorageSync('favoriteCats') || [];
      let favorites = Array.isArray(raw) ? raw : [];
      const isFav = Array.isArray(favorites)
        ? typeof favorites[0] === 'string' ? favorites.includes(catId) : favorites.some(f => f.id === catId)
        : false;

      // 先播放动画
      this._playHeartbeatAnimation();

      if (isFav) {
        // 1. 本地先更新（乐观更新）
        favorites = favorites.filter(f => typeof f === 'string' ? f !== catId : f.id !== catId);
        wx.setStorageSync('favoriteCats', favorites);
        this.setData({ isFavorite: false, showUndoBar: true, undoCatName: catName });
        wx.showToast({ title: '已取消关注', icon: 'none' });

        if (this._undoTimer) clearTimeout(this._undoTimer);
        this._undoTimer = setTimeout(() => {
          this.safeSetData({ showUndoBar: false, undoCatName: '' });
        }, 5000);

        // 2. 云端同步（非阻塞）
        wx.cloud.callFunction({
          name: 'syncFavorites',
          data: { action: 'remove', catId }
        }).catch(() => {
          const cur = wx.getStorageSync('favoriteCats') || [];
          const safeCur = Array.isArray(cur) ? cur : [];
          const normalized = safeCur.map(f => typeof f === 'string' ? { id: f, time: Date.now() } : f);
          normalized.push({ id: catId, time: Date.now() });
          wx.setStorageSync('favoriteCats', normalized);
          this.safeSetData({ isFavorite: true, showUndoBar: false, undoCatName: '' });
          wx.showToast({ title: '网络开小差，取消关注没成功', icon: 'none' });
          Logger.warn('detail', '云端取消关注失败，已回滚本地');
        });
      } else {
        // 1. 本地先更新
        // 统一格式为 {id, time}
        if (favorites.length > 0 && typeof favorites[0] === 'string') {
          favorites = favorites.map(id => ({ id, time: Date.now() }));
        }
        favorites.push({ id: catId, time: Date.now() });
        if (favorites.length > 100) favorites = favorites.slice(-100);
        wx.setStorageSync('favoriteCats', favorites);
        this.setData({ isFavorite: true });
        wx.showToast({ title: '已关注', icon: 'none' });
        wx.vibrateShort({ type: 'light' });

        // 2. 云端同步（非阻塞）
        wx.cloud.callFunction({
          name: 'syncFavorites',
          data: { action: 'add', catId, catName }
        }).catch(() => {
          const cur = wx.getStorageSync('favoriteCats') || [];
          const safeCur = Array.isArray(cur) ? cur : [];
          const rolled = safeCur.filter(f => typeof f === 'string' ? f !== catId : f.id !== catId);
          wx.setStorageSync('favoriteCats', rolled);
          this.safeSetData({ isFavorite: false });
          wx.showToast({ title: '网络开小差，关注没成功', icon: 'none' });
          Logger.warn('detail', '云端关注同步失败，已回滚本地');
        });

        // 3. 请求订阅猫咪动态提醒（状态变更 + 相遇打卡，一次性订阅，授权结果记录到云端）
        this._requestSubscribe(catId);
      }
    } catch (err) {
      Logger.warn('detail', '关注操作失败', { error: err.message });
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._toggleFavLock = false;
    }
  },

  /**
   * 请求订阅猫咪动态提醒（找猫刚需场景）：一次弹窗同时请求
   * 「状态变更提醒」「相遇打卡提醒」「新猫登场提醒」三个一次性订阅模板。
   * 用户授权（accept）后调用 subscribeCatStatus 云函数记录，触发时云函数会通过
   * 订阅消息推送（见 updateCat / recordMeet / addCat）。
   * 同一次授权同时计入推送次数账本（manageSubscribeQuota），供发送时扣减与
   * 「我的」页「增加推送次数」同一口径展示。
   * 模板 ID 未配置（config.subscribe*TemplateId 为空）时静默跳过。
   */
  _requestSubscribe(catId) {
    if (typeof wx.requestSubscribeMessage !== 'function') return;
    const tmplIds = [
      _config.subscribeTemplateId,
      _config.subscribeMeetTemplateId,
      _config.subscribeNewCatTemplateId
    ].filter(Boolean);
    if (!tmplIds.length) return;

    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => {
        tmplIds.forEach(tmplId => {
          const status = res && res[tmplId] === 'accept' ? 'accept' : 'ignore';
          // 「新猫登场提醒」是全局订阅（不绑定具体猫），用 'new_cat' 标识
          const recordCatId = tmplId === _config.subscribeNewCatTemplateId ? 'new_cat' : catId;
          wx.cloud.callFunction({
            name: 'subscribeCatStatus',
            // 记录实际授权的模板 ID，与各发送侧环境变量保持一致
            data: { catId: recordCatId, templateId: tmplId, status }
          }).catch(err => {
            Logger.warn('detail', '订阅记录失败（非致命）', { error: err.message });
          });
        });

        // 同一次授权计入推送次数账本（「我的」页「增加推送次数」同一口径，失败非致命）
        const acceptedIds = tmplIds.filter(id => res && res[id] === 'accept');
        if (acceptedIds.length > 0) {
          wx.cloud.callFunction({
            name: 'manageSubscribeQuota',
            data: { action: 'add', templateIds: acceptedIds }
          }).catch(err => {
            Logger.warn('detail', '推送次数记账失败（非致命）', { error: err.message });
          });
        }
      },
      fail: () => { /* 用户拒绝或系统不支持，静默 */ }
    });
  },

  onUndoUnfavorite() {
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    this.setData({ showUndoBar: false, undoCatName: '' });
    this._toggleFavLock = false;
    this.toggleFavorite();
  },

  checkFavoriteStatus() {
    const raw = wx.getStorageSync('favoriteCats') || [];
    const catId = this.data.catId;
    const shouldBeFav = Array.isArray(raw) && raw.length > 0
      ? typeof raw[0] === 'string' ? raw.includes(catId) : raw.some(f => f.id === catId)
      : false;
    if (this.data.isFavorite !== shouldBeFav) {
      this.setData({ isFavorite: shouldBeFav });
    }
  },

  // ========== 分享 ==========

  onShareAppMessage() {
    const { cat, catId } = this.data;
    // 详情页可能停在「参数非法 / 数据没回来」的错误态：不能分享一个没有 id 的链接
    if (!catId) {
      return {
        title: '校园猫咪图鉴 | 每一只都值得被记录',
        path: '/pages/index/index',
        imageUrl: ShareHelper.randomBrandImage()
      };
    }
    const ShareTextGenerator = require('../../utils/shareTextGenerator');
    const title = ShareTextGenerator.generateDetailText(cat, 'friend');
    const imageUrl = this._shareImage(cat);
    obsHelper.reportEvent(obsHelper.EVENT_NAMES.SHARE_CAT, {
      cat_id: catId.substring(0, 8), share_type: 'friend'
    });
    return { title, path: `/pages/detail/detail?id=${encodeURIComponent(catId)}`, imageUrl };
  },

  onShareTimeline() {
    const { cat, catId } = this.data;
    if (!catId) {
      return {
        title: '校园猫咪图鉴 | 每一只都值得被记录',
        query: '',
        imageUrl: ShareHelper.randomBrandImage()
      };
    }
    const ShareTextGenerator = require('../../utils/shareTextGenerator');
    const title = ShareTextGenerator.generateDetailText(cat, 'timeline');
    return { title, query: `id=${encodeURIComponent(catId)}`, imageUrl: this._shareImage(cat) };
  },

  /**
   * 详情页分享图：优先猫咪大头照（2026-10-24 需求：分享的就是这只猫，
   * 头像最有辨识度，方图被微信按 5:4 居中裁切后仍是完整猫脸），
   * 没有头像才退回第一张相册照片，最后才是品牌卡。
   * 相册页（cat-album）分享的是照片集合，仍以第一张照片优先，两页口径刻意不同。
   */
  _shareImage(cat) {
    const firstPhoto = (this.data.photos || [])[0];
    return ShareHelper.firstShareImage(
      [
        cat && cat._tempAvatarUrl,
        cat && cat.avatar,
        firstPhoto && firstPhoto.displayUrl,
        firstPhoto && firstPhoto.url
      ],
      ShareHelper.randomBrandImage()
    );
  },
  // 该页代码与单测保留在仓库里（画布绘制、dpr 缩放、存相册权限引导都可用），
  // 但已从 app.json 摘除 —— 不进包体、不产生「注册了却无入口」的孤儿路由。
  // 若将来要重新上线：恢复 app.json 注册 + 在需要的位置补 navigateTo 即可。
  // ========== 图片头像 ==========

  onAvatarError() {
    if (this.data.cat) {
      const cat = { ...this.data.cat };
      cat.avatar = '';
      cat._tempAvatarUrl = '';
      this.setData({ cat });
    }
  },

  // ========== 浮层 ==========

  /**
   * 来自 custom-navbar 组件的高度变化事件
   * 用于为 cat-profile 区域设置动态 padding-top，避免内容被导航栏遮挡
   */
  onNavbarHeightChange(e) {
    const { totalHeight } = e.detail;
    if (this._navBarHeightUpdating) return;
    if (totalHeight && Math.abs(totalHeight - this.data.navBarTotalHeight) > 0.5) {
      this._navBarHeightUpdating = true;
      this.setData({ navBarTotalHeight: totalHeight }, () => {
        this._navBarHeightUpdating = false;
      });
    }
  },

  async loadRelationCats() {
    try {
      const catRelationService = require('../../utils/catRelationService');
      const res = await catRelationService.getRelationsByCatId(this.data.catId);
      // 成功即回写，空数组也要写：否则删掉最后一条关系后返回本页，
      // 条件为假导致 relationCats 保留旧值，「TA的关系」会继续显示已删除的猫。
      if (res.success) {
        const catId = this.data.catId;
        const isDark = getApp().globalData.theme === 'dark';
        const relationCats = res.data.map(rel => {
          const isFrom = rel.fromCatId === catId;
          const cat = isFrom ? rel.toCat : rel.fromCat;
          const info = rel.relationInfo;
          const color = info
            ? isDark && info.colorDark ? info.colorDark : info.color
            : catRelationService.getRelationColor(rel.type);
          return {
            id: cat._id,
            name: cat.name || '未知',
            avatar: cat.avatar || '',
            relationType: rel.type,
            // 方向口径（见 catRelationService.getRelationLabel 注释）：
            // 关系记录 (catId=A, relatedCatId=B, type=T) 表示「B 是 A 的 T」；
            // 当前猫处于 toCat 端时使用反向标签，避免两端同文案
            relationLabel: catRelationService.getRelationLabel(rel.type, {
              isReverse: !isFrom,
              otherGender: cat && cat.gender
            }),
            relationColor: color
          };
        });
        // 关系猫头像同为裸 cloud://，渲染前过 avatar 档位（口径同本页主猫头像）
        const resolvedRelationCats = await AvatarHelper.resolveCatAvatars(relationCats);
        this.safeSetData({ relationCats: resolvedRelationCats });
      }
    } catch (err) {
      Logger.warn('detail', '加载关系猫咪失败', { error: err.message });
    }
  },

  onRelationCatTap(e) {
    const { id } = e.currentTarget.dataset;
    // 微信页面栈上限 10 层：连续点关系猫超过上限后 navigateTo 会静默失败，
    // 界面毫无反馈。这里显式 fail 兜底 + 超 8 层改 redirectTo 避免栈增长失控
    const stackDepth = getCurrentPages().length;
    const url = `/pages/detail/detail?id=${encodeURIComponent(id)}`;
    if (stackDepth > 8) {
      wx.redirectTo({ url, fail: () => wx.showToast({ title: '返回请用顶部返回键', icon: 'none' }) });
      return;
    }
    wx.navigateTo({
      url,
      fail: () => wx.showToast({ title: '页面打开失败，请稍后再试', icon: 'none' })
    });
  },

  /**
   * 管理员入口是否可见。
   * 只读本地登录态（含签名校验），不额外发请求：云端强校验在目标页做，
   * 这里仅为「不该出现的人别看见入口」，不构成任何鉴权（口径同 profile.js:247）。
   * @returns {boolean}
   */
  _checkAdminEntry() {
    try {
      return !!checkAdminAuth();
    } catch (e) {
      return false;
    }
  },

  /**
   * 管理员入口 → 关系管理页，并把当前猫作为「基准猫咪」带过去。
   * 带上 catId 后目标页会直接打开添加面板并预填这只猫，省掉一次重复选择；
   * 这也避免了一个更笨的替代方案：在管理页先按猫筛出它的关系再手动点开面板。
   */
  onOpenRelationManage() {
    const catId = this.data.catId;
    if (!catId) {
      wx.showToast({ title: '关系加载中，请稍后再试', icon: 'none' });
      return;
    }
    // 把名字一起带上：目标页要显示带头像的 chip，头像/花色得靠 getCatDetail 补，
    // 但那一步是网络请求 —— 一旦失败，chip 就只剩一个空头像圈，看不出是哪只猫。
    // 名字本页已有，直接带过去当兜底（同名风险为 0：id 才是主键）。
    const name = this.data.cat && this.data.cat.name || '';
    let url = `/pages/admin/relation-manage/relation-manage?catId=${encodeURIComponent(catId)}`;
    if (name) url += `&catName=${encodeURIComponent(name)}`;
    if (getCurrentPages().length > 8) {
      wx.redirectTo({ url, fail: () => wx.showToast({ title: '返回请用顶部返回键', icon: 'none' }) });
      return;
    }
    wx.navigateTo({ url, fail: () => wx.showToast({ title: '页面打开失败，请稍后再试', icon: 'none' }) });
  },

  onOpenReport() {
    const catId = this.data.catId;
    if (!catId) {
      wx.showToast({ title: '档案加载中，请稍后再试', icon: 'none' });
      return;
    }
    const cat = this.data.cat || {};
    const name = cat.name || '';
    const avatar = cat.avatar || '';
    let url = `/subpackages/feedback/report/report?catId=${encodeURIComponent(catId)}`;
    if (name) url += `&catName=${encodeURIComponent(name)}`;
    if (avatar) url += `&catAvatar=${encodeURIComponent(avatar)}`;
    wx.navigateTo({ url, fail: () => wx.showToast({ title: '页面打开失败，请稍后再试', icon: 'none' }) });
  },

  onBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      const prevPage = pages[pages.length - 2];
      const tabBarPages = ['pages/index/index', 'pages/gallery/gallery', 'pages/profile/profile'];
      if (tabBarPages.includes(prevPage.route)) {
        wx.switchTab({ url: '/' + prevPage.route });
      } else {
        wx.navigateBack();
      }
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  preventDefault() {},

  // ========== 浏览量兜底 ==========

  _recordViewWithFallback(catId) {
    // 客户端5分钟去重，减少不必要的云函数调用
    const lastViewKey = `_lastView_${catId}`;
    const lastView = wx.getStorageSync(lastViewKey);
    if (lastView && Date.now() - lastView < 5 * 60 * 1000) return;

    wx.cloud.callFunction({ name: 'recordView', data: { catId } })
      .then((res) => {
        if (!res || !res.result || !res.result.success) {
          this._enqueueViewRecord(catId);
          return;
        }
        wx.setStorageSync(lastViewKey, Date.now());
        Logger.info('detail', '浏览量记录成功', { catId: catId.substring(0, 8) });
      })
      .catch(err => {
        Logger.warn('detail', '记录浏览量失败，存入本地队列', { error: err.message });
        this._enqueueViewRecord(catId);
      });
  },

  _enqueueViewRecord(catId) {
    try {
      const raw = wx.getStorageSync('_viewRecordQueue') || [];
      const queue = Array.isArray(raw) ? raw : [];
      queue.push({ catId, timestamp: Date.now() });
      while (queue.length > 100) queue.shift();
      wx.setStorageSync('_viewRecordQueue', queue);
    } catch (e) {
      Logger.warn('detail', '浏览量队列写入失败', { error: e.message });
    }
  }
});
