/**
 * pages/index/index.js - 首页（精简版）
 *
 * 职责：
 * 1. 展示猫咪列表
 * 2. 猫咪搜索和筛选功能
 * 3. 展示统计数据
 * 4. 互动守则弹窗
 *
 * 数据流：
 * 1. loadCats() 并行获取猫咪列表 + 照片列表
 * 2. AvatarHelper.resolveCatAvatars() 统一处理头像选择和URL转换
 * 3. filterCats() 处理搜索和筛选
 *
 * 已拆分子模块：
 * - services/catService.js — 猫咪列表/分页/刷新
 * - services/imageService.js — 图片加载/重试/预加载
 * - services/searchService.js — 搜索/筛选
 * - behaviors/agreementBehavior.js — 互动守则/引导
 * - behaviors/networkBehavior.js — 网络监听/自动重试
 */
const app = getApp();
const cacheBehavior = require('../../behaviors/cacheBehavior');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');
const agreementBehavior = require('../../behaviors/agreementBehavior');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const networkBehavior = require('../../behaviors/networkBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const { checkNetwork } = require('../../utils/network');
const { getPageStateManager } = require('../../utils/pageState');
const startupTrace = require('../../utils/startupTrace');
const ShareHelper = require('../../utils/shareHelper');
const ShareTextGenerator = require('../../utils/shareTextGenerator');
const TabBadge = require('../../utils/tabBadge');
// 详情预取是客户端直连读，必须与 getCatDetail / getPhotosByCat 同语义：
// 过滤删除中的猫咪 + 剔除内部字段（详见 utils/dbFields.js 的模块说明）
const { CAT_LIST_FIELDS, PHOTO_LIST_FIELDS, withCatVisibility } = require('../../utils/dbFields');
const config = require('../../config');
const obsHelper = require('../../utils/obsHelper');
const guidance = require('../../utils/guidance');
const SearchEngine = require('../../utils/searchEngine');
const imageRetryManager = require('../../utils/imageRetryManager');
const FilterService = require('../../utils/filterService');
const catService = require('../../services/catService');
const offlineCache = require('../../utils/offlineCache');
// 地图入口带上首页当前校区：只有画过底图的校区才带（其余会退回本部）
const { hasMap } = require('../../utils/campusMapRegistry');
const imageService = require('../../services/imageService');
const { normalizeColor, expandColor, isOtherColor, sortByDisplayOrder } = require('../../utils/colorNormalize');

Page({
  // 合并 behaviors
  behaviors: [
    cacheBehavior,
    backToTopBehavior,
    agreementBehavior,
    guideTourBehavior,
    networkBehavior,
    safeSetDataBehavior
  ],

  // ========== 数据 ==========
  data: {
    // 沉浸式顶部
    statusBarHeight: 0,
    // 猫咪列表
    cats: [],
    filteredCats: [],
    // 统计数据
    totalPhotos: 0,
    totalCats: 0,
    totalViews: 0,
    displayCats: 0,
    displayPhotos: 0,
    displayViews: 0,
    displayViewsText: '0',
    filteredCatCount: 0,
    // 搜索和筛选
    activeFilter: 'all',
    searchKeyword: '',
    showFilter: false,
    showCampusDropdown: false,
    genderFilter: '',
    statusFilter: '',
    colorFilter: '',
    // 好猫星级（适合家养）：'' = 不筛；'3'/'4'/'5' = 至少 N 星
    adoptFilter: '',
    colorOptions: [],
    // 花色 → 猫咪数量（getFilterOptions 云函数返回，本地已加载列表计数兜底）。
    // 与 colorOptions 平行维护而不是改成对象数组：colorOptions 有三个写入方
    // （_loadAllColorOptions / catService.mergeColorOptions / filterService._extractColorOptions），
    // 改形状会牵连三个模块；平行 map 只让新逻辑集中在一处。
    colorCounts: {},
    ageFilter: '',
    campusFilter: '',
    campusOptions: ['本部', '东区', '西区', '南区'],
    activeFilterCount: 0,
    isFiltering: false,
    // 搜索历史
    searchHistory: [],
    showSearchHistory: false,
    // 加载状态
    loading: true,
    showSkeleton: true,
    hasSearched: false,
    // 分页
    page: 1,
    pageSize: 10,
    hasMore: false,
    loadingMore: false,
    // 公告红点
    hasNewNotice: false,
    // 回到顶部
    showBackToTop: false,
    // 刷新状态
    isRefreshing: false,
    // 网络错误（定义由 networkBehavior 提供，此处补充默认值）
    networkError: false,
    autoRetryCountdown: 0,
    skeletonItems: [1, 2, 3, 4, 5, 6],
    // 版本更新卡（每版最多一次；内容来自 config.guidance.releases）
    releaseModal: {
      show: false,
      icon: '',
      title: '',
      items: [],
      entry: ''
    }
    // 全功能导览数据由 behaviors/guideTourBehavior 提供（guideTour）
  },

  // ========== 生命周期 ==========

  onLoad () {
    // 路由阶段结束 = 小程序启动 + 页面注册实例化全部完成
    startupTrace.markRoute('index');

    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });

    this._searchEngine = new SearchEngine();
    this.checkAgreement();
    this._initNetworkListener();

    if (!checkNetwork({ showError: false })) {
      this.setData({ loading: false, showSkeleton: false, networkError: true });
      return;
    }

    // SWR：先渲染本地缓存（若有）再静默刷新，冷启动不等完整网络链路
    const cachedCats = offlineCache.getCats();
    if (cachedCats && cachedCats.length > 0) {
      this._hasCachedRender = true;
      this.safeSetData({
        cats: cachedCats,
        filteredCats: cachedCats,
        loading: false,
        showSkeleton: false
      });
    }
    // 统计先显示上次的数字（避免照片数/浏览量闪 0）
    const cachedStats = offlineCache.getStats();
    if (cachedStats) {
      this.safeSetData({
        totalPhotos: cachedStats.totalPhotos,
        totalViews: cachedStats.totalViews,
        displayPhotos: cachedStats.totalPhotos,
        displayViews: cachedStats.totalViews,
        displayViewsText: this._fmtNum(cachedStats.totalViews)
      });
    }
    this.loadCats();
    this.checkNewNotice();
    // 首个 onShow 紧随 onLoad，跳过重复的公告检查
    this._skipNextNoticeCheck = true;
    this._preloadFirstScreen();
  },

  /**
   * 首屏渲染完成。
   *
   * 微信的 onReady = 页面**首次渲染完成**，也就是用户第一次真的看到内容的那一刻 ——
   * 比 onLoad 准，也比「网络返回后 setData」准（SWR 命中时那是毫秒级的事，
   * 而 onReady 反映的是真实的「从打开到看见」）。
   *
   * 只在首次进入时打点：从详情页返回不算冷启动，重新打会污染数据。
   */
  onReady () {
    if (this._tracedFirstReady) return;
    this._tracedFirstReady = true;
    startupTrace.finishFirstRender('index');
    // 缓存命中与否决定了「用户等的是网络还是缓存」，一起记下来便于对照
    startupTrace.mark('first-render-source:' + (this._hasCachedRender ? 'cache' : 'network'));
  },

  /**
   * 性能面板：把启动各阶段耗时显示出来。
   *
   * 真机上没有 vConsole，埋点数据不主动展示就等于白埋。正常路径不暴露入口，
   * 由 __tests__ 与调试时手动调用。
   */
  async onShowTrace () {
    try {
      const text = startupTrace.formatReport();
      // eslint-disable-next-line no-console
      console.log('[startupTrace]\n' + text);
      wx.showModal({ title: '启动耗时', content: text, showCancel: false });
    } catch (e) {
      wx.showToast({ title: '埋点不可用（基础库 < 2.9.0）', icon: 'none' });
    }
  },

  onShow() {
    // 版本更新卡：每次冷启动最多调度一次。放在 onShow 最前面，
    // 避免被下面的首屏 loading / 刷新守卫提前 return 掉。
    this._maybeShowRelease();
    this.initGuideTour('pages/index/index', {
      delay: 700,
      canStart: () => {
        const isOpen = modal => !!(modal && modal.show);
        return !isOpen(this.data.agreementModal)
          && !isOpen(this.data.welcomeModal)
          && !isOpen(this.data.releaseModal)
          && !this._releaseScheduled;
      }
    });

    // 默认落地页：从本地缓存恢复「我的」未读红点（零网络）。
    // app.onShow 时 tabBar 可能尚未就绪，这里作为兜底再刷一次。
    TabBadge.refreshFromCache();
    if (this._skipNextNoticeCheck) {
      this._skipNextNoticeCheck = false;
    } else {
      this.checkNewNotice();
    }
    if (!this._prefetchTimers) this._prefetchTimers = {};
    // eslint-disable-next-line no-extra-parens -- 显式括号标明优先级，防止误改
    if (this._loadingCats || (this.data.loading && this.data.showSkeleton)) return;

    const pageState = getPageStateManager();
    const refreshData = pageState.checkNeedRefresh('index');

    if (refreshData) {
      Logger.info('index', '从详情页返回，需要刷新', refreshData);
      if (this.data.campusFilter) {
        FilterService.loadCatsByCampus(this.data.campusFilter, this);
      } else if (refreshData.catId && refreshData.action === 'update') {
        catService.refreshSingleCat(refreshData.catId, this);
      } else {
        catService.loadCats(this);
      }
      return;
    }

    this.loadWithCache(() => {
      if (this.data.campusFilter) {
        FilterService.loadCatsByCampus(this.data.campusFilter, this);
      } else {
        catService.loadCats(this);
      }
    }, { validTime: 15000 });
  },

  onHide() {
    this.pauseGuideTour();
    if (this._prefetchTimers && typeof this._prefetchTimers === 'object') {
      Object.keys(this._prefetchTimers).forEach(catId => {
        try { clearTimeout(this._prefetchTimers[catId]); } catch (e) {
          Logger.debug('index', 'onHide: 清理预取定时器失败', { catId });
        }
        delete this._prefetchTimers[catId];
      });
    }
  },

  onUnload () {
    this._isUnmounted = true;
    this.destroyGuideTour();
    this._cleanupAllResources();
  },

  _clearGuidanceTimers() {
    if (this._releaseTimer) {
      try { clearTimeout(this._releaseTimer); } catch (e) { /* ignore */ }
      this._releaseTimer = null;
    }
  },

  _cleanupAllResources() {
    if (this._networkUnsubscribe) {
      try { this._networkUnsubscribe(); } catch (e) { Logger.warn('index', '取消网络监听失败', e); }
      this._networkUnsubscribe = null;
    }
    if (this._prefetchTimers && typeof this._prefetchTimers === 'object') {
      Object.keys(this._prefetchTimers).forEach(catId => {
        try { clearTimeout(this._prefetchTimers[catId]); } catch (e) { /* ignore */ } });
      this._prefetchTimers = null;
    }
    imageRetryManager.cleanup();
    if (this._searchTimer) {
      try { clearTimeout(this._searchTimer); } catch (e) { Logger.debug('index', '清理搜索防抖定时器失败', e); }
      this._searchTimer = null;
    }
    if (this._filterTapTimer) {
      try { clearTimeout(this._filterTapTimer); } catch (e) { Logger.debug('index', '清理筛选防抖定时器失败', e); }
      this._filterTapTimer = null;
    }
    if (this._autoRetryTimer) {
      try { clearInterval(this._autoRetryTimer); } catch (e) { Logger.debug('index', '清理自动重试定时器失败', e); }
      this._autoRetryTimer = null;
    }
    this._clearGuidanceTimers();
    if (this._networkRecoveryTimer) {
      try { clearTimeout(this._networkRecoveryTimer); } catch (e) { Logger.debug('index', '清理网络恢复定时器失败', e); }
      this._networkRecoveryTimer = null;
    }
    if (this._statAnimTimer) {
      try { clearInterval(this._statAnimTimer); } catch (e) { /* ignore */ }
      this._statAnimTimer = null;
    }
    if (this._skeletonFrameId) {
      try { cancelAnimationFrame(this._skeletonFrameId); } catch (e) { /* ignore */ }
      this._skeletonFrameId = null;
    }
    this._loadingCats = false;
    this._loadingMoreCats = false;
    this._loadingAll = false;
    this._retryQueue = null;
    this._baseHasMore = null;
    this._photoCountsMap = null;
    this._retryingCatIds = null;
    if (this._searchEngine) this._searchEngine.clear();
    Logger.info('index', '页面资源已全部清理（增强版）');
  },

  // ========== 猫咪列表（委托给 catService）==========

  async loadCats() {
    // 已用本地缓存渲染过（SWR）→ 静默刷新，不闪骨架屏
    const silent = !!this._hasCachedRender;
    this._hasCachedRender = false;
    await catService.loadCats(this, { silent });
    // 首屏只驱动猫咪总数动画；张照/浏览等统计补丁（patchPhotoCounts）到达后再驱动。
    // 三格的**目标值**都取权威值：张照/浏览取 totalPhotos/totalViews，统计还没到时
    // （值仍为 0）才回退到当前显示值 —— 若直接把「当前显示值」当目标，刷新恰好撞上
    // 统计动画在途，就会把中途的临时值当成终值，数字停在半路。
    // 猫总数同样以 _totalCatsCount 兜底：data.totalCats 曾有冷启动短暂为 0 的观测记录。
    this._animateStatNumbers(
      this.data.totalCats || this._totalCatsCount || 0,
      this.data.totalPhotos || this.data.displayPhotos || 0,
      this.data.totalViews || this.data.displayViews || 0
    );
  },

  async loadMoreCats() {
    // 筛选态必须走服务端筛选分页：此前筛选结果的 hasMore 来自云函数，
    // 但 loadMore 只拉基础列表再本地重跑筛选，第 101 条起永远翻不出来
    //（filterService 此前固定请求 page=1，第 2 页的结果从未被取回）。
    if (this.data.hasSearched) {
      await this._loadMoreFilteredCats();
      return;
    }
    await catService.loadMoreCats(this);
  },

  /**
   * 筛选态的加载更多：按服务端分页续取筛选结果并追加到 filteredCats。
   * 竞态护栏与 filterCats 一致：filterFromServer 内部按 _filterSeq 丢弃过期响应；
   * 未被作废时才推进 _filterPage。
   */
  async _loadMoreFilteredCats() {
    // hasMore 守卫：服务端已到底后每次触底仍会发云函数（_filterPage 持续自增、
    // 反复返回空页），浪费配额且高频滑动会逼近云函数限流。与 catService.loadMoreCats 同口径。
    if (this._loadingMoreCats || this.data.loadingMore || !this.data.hasMore) return;
    this._loadingMoreCats = true;
    this.safeSetData({ loadingMore: true });

    const seqAtStart = this._filterSeq;
    const nextPage = (this._filterPage || 1) + 1;

    try {
      const kw = (this.data.searchKeyword || '').toLowerCase().trim();
      const result = await FilterService.filterFromServer(this, kw, { page: nextPage, append: true });
      // 结果已被新筛选/还原全量作废时不推进页码；hasMore 也由新请求维护
      if (seqAtStart === this._filterSeq && result && result.success) {
        this._filterPage = nextPage;
      }
    } catch (err) {
      Logger.warn('index', '筛选态加载更多失败', { error: err.message });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingMoreCats = false;
      if (this.data.loadingMore) this.safeSetData({ loadingMore: false });
    }
  },

  async _preloadNextPage(pageNum) {
    await catService.preloadNextPage(pageNum, this);
  },

  async _refreshSingleCat(catId) {
    await catService.refreshSingleCat(catId, this);
  },

  // ========== 花色选项 ==========

  _extractColorOptions(cats) {
    const colorCount = {};
    cats.forEach(cat => {
      // 必须归一化：否则「狸白」「橘白」等原始值会直接写进 colorOptions，
      // 与云端的标准分类混排显示
      const c = normalizeColor(cat.color);
      if (c) colorCount[c] = (colorCount[c] || 0) + 1;
    });
    return sortByDisplayOrder(Object.keys(colorCount));
  },

  async _loadAllColorOptions() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getFilterOptions' });
      const result = res.result || {};
      if (!result.success) {
        Logger.warn('index', '加载花色选项失败', { error: result.error });
        return;
      }
      const cloudColors = result.data?.colors || [];
      const cloudCounts = result.data?.colorCounts || {};

      // 本地已有的 colorOptions（来自 mergeColorOptions / _extractColorOptions / 缓存）
      // 也要归一化后并入：历史上这些写入方直写原始值，不归一化会出现
      // 「狸白 4」「梨花 4」与「狸花」并排显示的混排列表（实际发生过的 bug）
      const merged = new Set();
      this.data.colorOptions.forEach(c => {
        const std = normalizeColor(c);
        if (std) merged.add(std);
      });
      cloudColors.forEach(c => {
        const std = normalizeColor(c);
        if (std) merged.add(std);
      });

      // 计数：云端优先（全量扫描）；本地已加载列表计数仅在云端未返回该分类时兜底，
      // 且本地计数同样按归一化后的分类累加，避免细项计数丢失
      const localCount = {};
      this.data.cats.forEach(cat => {
        const c = normalizeColor(cat.color);
        if (c) localCount[c] = (localCount[c] || 0) + 1;
      });

      const counts = {};
      merged.forEach(c => {
        counts[c] = cloudCounts[c] ?? localCount[c] ?? 0;
      });

      const sorted = sortByDisplayOrder([...merged]);
      // 这里只管花色选项，**不要写 totalPhotos**：
      // getFilterOptions 与 catService.getCatPhotoCounts 是两个独立数据源，onLoad 里并行发起，
      // 谁后返回谁覆盖 —— 后者的计数失败时会返回 0，首页「张照」直接归零。
      // 且首页 stat chip 渲染的是 displayPhotos（由 _animateStatNumbers 动画一次），
      // 此时改 totalPhotos 也不会同步到展示层，数据层与展示层会永久不一致。
      this.safeSetData({ colorOptions: sorted, colorCounts: counts });
    } catch (err) {
      Logger.warn('index', '加载全量花色选项失败', { error: err.message });
    }
  },

  // ========== 统计 ==========

  _animateStatNumbers(targetCats, targetPhotos, targetViews) {
    // 降帧优化：从 40 步降到 8 步（每 100ms 一帧），setData 次数减少 80%
    // 配合 ease-out 缓动，视觉效果仍流畅，首屏渲染压力大幅降低
    const steps = 8;
    const duration = 800;
    const interval = duration / steps;

    // 起点是「当前显示值」（不是固定 0）—— 同一个数字只滚一次：
    // 固定 0 起步时，统计补丁在「只猫」动画途中到达会把滚到一半的 88 打回 0 重滚；
    // 缓存命中时也会把已显示的 955 先打回 ~315 再滚回来（同一格数字滚两遍）。
    // 冷启动无缓存时起点本来就是 0，「从小滚到大」的观感不受影响。
    const fromCats = this.data.displayCats || 0;
    const fromPhotos = this.data.displayPhotos || 0;
    const fromViews = this.data.displayViews || 0;

    // 三个目标都等于当前显示值：没有任何要滚的变化（统计没变的刷新最常见），
    // 跳开整段定时器，省掉 8 次无意义 setData；只补一次可能滞后的 'w' 文本。
    if (fromCats === targetCats && fromPhotos === targetPhotos && fromViews === targetViews) {
      const finalText = this._fmtNum(targetViews);
      if (this.data.displayViewsText !== finalText) {
        this.safeSetData({ displayViewsText: finalText });
      }
      return;
    }

    let step = 0;
    if (this._statAnimTimer) clearInterval(this._statAnimTimer);
    this._statAnimTimer = setInterval(() => {
      step++;
      const isLast = step >= steps;
      // 末帧短路成 eased = 1：终值直接落在 target 上，不让缓动/取整的浮点误差
      // 让统计数字差 1（这类错最容易被看出来）
      const eased = isLast ? 1 : 1 - Math.pow(1 - step / steps, 3);
      const viewsNow = Math.round(fromViews + (targetViews - fromViews) * eased);
      this.safeSetData({
        displayCats: Math.round(fromCats + (targetCats - fromCats) * eased),
        displayPhotos: Math.round(fromPhotos + (targetPhotos - fromPhotos) * eased),
        displayViews: viewsNow,
        // 浏览量 chip 渲染的是 displayViewsText（带 'w' 的文本），不是 displayViews：
        // 此前只逐帧写 displayViews（全仓无绑定 = 零可见变化），displayViewsText 只在
        // 动画结束时写一次 —— 「浏览」因此是直接跳到终值，而不是滚上去的。
        displayViewsText: this._fmtNum(viewsNow)
      });
      if (isLast) {
        clearInterval(this._statAnimTimer);
        this._statAnimTimer = null;
      }
    }, interval);
  },

  _fmtNum(n) {
    if (!n || n < 10000) return String(n || 0);
    return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
  },

  // ========== 图片事件（委托给 imageService）==========

  _preloadFirstScreen() {
    imageService.preloadFirstScreen(this.data.cats);
  },

  async _resolveAvatarsAsync(cats) {
    await imageService.resolveAvatarsAsync(cats, this);
    // 预热放在这里而不是 onLoad：onLoad 里 this.data.cats 还是 []（loadCats 未 await），
    // 预热是空转。这里拿到的已经是解析完成的列表，冷启动才能真正预热首 10 张图。
    // 档位与 wxml 的 lazy-image type 对齐由 imageService.preloadFirstScreen 保证。
    this._preloadFirstScreen();
  },

  onImageLoad(e) {
    imageService.onImageLoad(e, this);
  },

  onImageError(e) {
    imageService.onImageError(e, this);
  },

  // ========== 搜索和筛选 ==========

  onSearchInput(e) {
    const keyword = e.detail.value.trim().toLowerCase();
    this.setData({ searchKeyword: e.detail.value, isFiltering: !!keyword });

    clearTimeout(this._searchTimer);
    // 搜索时若已选校区，清除校区筛选实现全局搜索。
    //
    // 原实现在这里直接调 loadCats()（非 silent）并 return：① 整页骨架屏闪一次；
    // ② 本次输入不挂防抖定时器，只靠 loadCats 内部 hasActiveFilter 分支
    //    (catService.js:122-130) 补跑 filterCats 才进入 filtering —— 若这次
    //    loadCats 被 _loadingCats 守卫吞掉，用户必须再输入一次才生效。
    // 改为只清校区、继续走下面的防抖分支，与普通输入完全同口径。
    if (keyword && this.data.campusFilter) {
      this.setData({ campusFilter: '' });
    }
    if (!keyword) {
      // 清空搜索：立即执行，无需防抖
      this.filterCats();
      return;
    }

    // 修复：统一走 filterCats() 入口，移除重复的客户端过滤逻辑
    // 所有搜索/筛选逻辑现在都在 filterCats() 中统一处理
    this._searchTimer = setTimeout(() => {
      this.filterCats();

      // 搜索相关的日志和埋点
      Logger.info('index', `搜索"${keyword}"完成`);
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.SEARCH_CAT, {
        keyword_length: keyword.length,
        result_count: (this.data.filteredCats || []).length,
        has_result: this.data.filteredCats?.length > 0 ? 'true' : 'false'
      });
    }, config.performance.searchDebounceDelay);
  },

  clearSearch() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.setData({ searchKeyword: '', showSearchHistory: false });
    this.filterCats();
  },

  onClearAllConditions() {
    clearTimeout(this._searchTimer);
    clearTimeout(this._filterTapTimer);
    this._searchTimer = null;
    this._filterTapTimer = null;
    this._restoreFullList({
      searchKeyword: '', campusFilter: '', genderFilter: '', statusFilter: '',
      colorFilter: '', ageFilter: '', adoptFilter: '',
      showFilter: false, showCampusDropdown: false, showSearchHistory: false
    });
  },

  onFinishFilter() {
    this.setData({ showFilter: false });
    if (this._filterTapTimer) {
      clearTimeout(this._filterTapTimer);
      this._filterTapTimer = null;
      this.filterCats();
    }
  },

  onSearchFocus() {
    this._loadSearchHistory();
    if (this.data.searchHistory.length > 0 && !this.data.searchKeyword) {
      this.setData({ showSearchHistory: true });
    }
  },

  onSearchBlur() {
    setTimeout(() => {
      this.setData({ showSearchHistory: false });
    }, 200);
  },

  onSearchConfirm(e) {
    const keyword = (e.detail.value || '').trim();
    if (keyword) {
      this._addSearchHistory(keyword);
      this.setData({ showSearchHistory: false });
      this.filterCats();
    }
  },

  // ========== 搜索历史 ==========

  _loadSearchHistory() {
    try {
      const history = wx.getStorageSync('searchHistory') || [];
      this.setData({ searchHistory: Array.isArray(history) ? history.slice(0, 8) : [] });
    } catch (e) { /* 忽略 */ }
  },

  _addSearchHistory(keyword) {
    if (!keyword) return;
    try {
      let history = wx.getStorageSync('searchHistory') || [];
      if (!Array.isArray(history)) history = [];
      history = history.filter(h => h !== keyword);
      history.unshift(keyword);
      if (history.length > 8) history = history.slice(0, 8);
      wx.setStorageSync('searchHistory', history);
      this.setData({ searchHistory: history });
    } catch (e) { /* 忽略 */ }
  },

  onDeleteHistoryItem(e) {
    const { index } = e.currentTarget.dataset;
    const history = [...this.data.searchHistory];
    history.splice(index, 1);
    this.setData({ searchHistory: history });
    try { wx.setStorageSync('searchHistory', history); } catch { /* ignore */ }
  },

  onClearSearchHistory() {
    this.setData({ searchHistory: [], showSearchHistory: false });
    try { wx.setStorageSync('searchHistory', []); } catch (e) { /* ignore */ }
  },

  onTapHistoryItem(e) {
    const { term } = e.currentTarget.dataset;
    this.setData({ searchKeyword: term, showSearchHistory: false });
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.filterCats();
  },

  filterCats() {
    const hasFilters = !!(this.data.searchKeyword || this.data.genderFilter ||
      this.data.statusFilter || this.data.colorFilter || this.data.ageFilter ||
      this.data.campusFilter || this.data.adoptFilter);
    const activeFilterCount = [this.data.genderFilter, this.data.statusFilter,
      this.data.colorFilter, this.data.ageFilter, this.data.campusFilter,
      this.data.adoptFilter].filter(v => v).length;

    if (!hasFilters) {
      this._restoreFullList();
      return;
    }

    const kw = (this.data.searchKeyword || '').toLowerCase().trim();

    // 新一轮筛选从第 1 页开始；后续「加载更多」在筛选态按服务端分页续取
    this._filterPage = 1;
    this.setData({ hasSearched: true, activeFilterCount, isFiltering: true });

    // 请求序号：连续变更筛选时丢弃过期响应，防止旧筛选结果覆盖新筛选视图
    this._filterSeq = (this._filterSeq || 0) + 1;
    const seq = this._filterSeq;

    this._filterCatsFromServer(kw).then(result => {
      if (seq !== this._filterSeq) return;
      if (result && result.success) {
        const serverCats = result.cats || [];
        this._resolveAvatarsAsync(serverCats);

        const filtered = this._applyHighlights(serverCats, kw);

        // 只下发 filteredCats：_serverFilteredCats / _serverFilterTotal 是死字段
        // （grep 确认全项目零读取点），却每次筛选都把整包猫咪对象经 setData
        // 跨线程序列化下发一遍。serverCats 与 filtered 指向同一批对象，
        // 内存与传输双份冗余，故一并去掉。
        this.safeSetData({
          filteredCats: filtered,
          filteredCatCount: result.total || filtered.length,
          isFiltering: false
        });
      } else {
        this._fallbackClientFilter(kw);
      }
    }).catch(() => {
      if (seq !== this._filterSeq) return;
      this._fallbackClientFilter(kw);
    });
  },

  _applyHighlights(cats, kw) {
    if (!kw) {
      return cats.map(cat => {
        const c = { ...cat };
        delete c._hlName; delete c._hlLocation; delete c._hlCampus;
        return c;
      });
    }

    return cats.map(cat => ({
      ...cat,
      _hlName: SearchEngine.highlightSegments(cat.name, kw),
      _hlLocation: SearchEngine.highlightSegments(cat.location, kw),
      _hlCampus: SearchEngine.highlightSegments(cat.campus, kw)
    }));
  },

  _fallbackClientFilter(kw) {
    let filtered = [...this.data.cats];

    if (kw) {
      filtered = filtered.filter(cat =>
        cat.name?.toLowerCase().includes(kw) ||
        cat.color && cat.color.toLowerCase().includes(kw) ||
        cat.location && cat.location.toLowerCase().includes(kw) ||
        cat.campus && cat.campus.toLowerCase().includes(kw) ||
        cat.tags && cat.tags.some(tag => tag.toLowerCase().includes(kw))
      );
    }
    if (this.data.genderFilter) {
      const targetGender = config.genderMap[this.data.genderFilter];
      if (targetGender) {
        filtered = filtered.filter(cat => cat.gender === targetGender);
      }
    }
    if (this.data.statusFilter) {
      // 四态均为精确匹配；status 缺失的历史文档与云端白名单口径一致（不可见）
      filtered = filtered.filter(cat => cat.status === this.data.statusFilter);
    }
    if (this.data.adoptFilter) {
      // 好猫星级：至少 N 星（3/4/5）。缺失 / 0（未评级）的猫不命中，
      // 与云函数 filterCats 的 _.gte(N) 同语义
      filtered = this._applyAdoptFilter(filtered);
    }
    if (this.data.colorFilter) {
      if (this.data.colorFilter === '其他花色') {
        filtered = filtered.filter(cat => cat.color && isOtherColor(cat.color));
      } else {
        const variants = expandColor(this.data.colorFilter);
        filtered = filtered.filter(cat => cat.color && variants.includes(cat.color));
      }
    }
    if (this.data.campusFilter) {
      filtered = filtered.filter(cat => cat.campus && cat.campus === this.data.campusFilter);
    }
    if (this.data.ageFilter) {
      filtered = filtered.filter(cat => cat.age && cat.age === this.data.ageFilter);
    }

    filtered = this._applyHighlights(filtered, kw);

    if (kw && filtered.length === 0) {
      wx.vibrateShort({ type: 'light' }).catch(e => Logger.swallow('index', '震动反馈', e));
    }

    this.setData({
      filteredCats: filtered,
      filteredCatCount: filtered.length,
      isFiltering: false
    });
  },

  onFilterChange(e) {
    const filter = e.currentTarget.dataset.filter;
    this.setData({ activeFilter: filter });
    this.filterCats();
    if (filter === 'campus' && this.data.campusFilter) {
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.FILTER_CAMPUS, { campus: this.data.campusFilter });
    }
  },

  onToggleFilter() {
    const show = !this.data.showFilter;
    // 与校区面板互斥（同上：两个行内面板 + 两个遮罩不能并存）
    this.setData({ showFilter: show, showCampusDropdown: false });
    // 全量花色只在首次展开筛选面板时拉取（不在首屏关键路径上，省一次冷启动云调用）
    if (show && !this._colorOptionsLoaded) {
      this._colorOptionsLoaded = true;
      this._loadAllColorOptions();
    }
  },

  onGenderFilter(e) {
    this.setData({ genderFilter: e.currentTarget.dataset.gender });
    this._scheduleFilter();
  },

  onStatusFilter(e) {
    // 四态单选；「全部」回填空串复位。值来自 WXML 固定选项（normal/adopted/lost/deceased），
    // 云函数侧对 status 有白名单校验，非法值会回退成全部状态
    this.setData({ statusFilter: e.currentTarget.dataset.status });
    this._scheduleFilter();
  },

  onAdoptFilter(e) {
    // 好猫星级单选：''（全部）/ '3'（有星级）/ '4'（4星以上）/ '5'（5星）。
    // 值来自 WXML 固定选项；云函数侧白名单校验，非法值会被忽略（等同于不筛）
    this.setData({ adoptFilter: e.currentTarget.dataset.level || '' });
    this._scheduleFilter();
  },

  onColorFilter(e) {
    const color = e.currentTarget.dataset.color;
    // 计数为 0 的花色置灰不可点：选它只会得到空结果，还得再手动清除
    if (color && this.data.colorCounts[color] === 0) return;
    this.setData({ colorFilter: color });
    this._scheduleFilter();
  },

  /**
   * 筛选项即点即筛的防抖入口。
   * 与搜索防抖（searchDebounceDelay=300）分开配置：选项是离散点击而非连续输入，
   * 200ms 只为了把「公猫→母猫→橘猫」的连点压成一次云函数调用。
   * 连续点击的竞态由 filterCats 的 _filterSeq 序号守卫兜底。
   */
  _scheduleFilter() {
    clearTimeout(this._filterTapTimer);
    this._filterTapTimer = setTimeout(() => {
      this._filterTapTimer = null;
      this.filterCats();
    }, config.performance.filterDebounceDelay);
  },

  onToggleCampusDropdown() {
    const show = !this.data.showCampusDropdown;
    // 与筛选面板互斥：两个都是行内展开面板，同时打开会叠在一起、
    // 两个遮罩的层级也会互相覆盖
    this.setData({ showCampusDropdown: show, showFilter: false });
  },

  // 下拉遮罩 catchtouchmove 绑定的空实现：阻断滚动穿透并避免绑定缺失告警
  preventDefault() {},

  onSelectCampus(e) {
    const campus = e.currentTarget.dataset.campus;
    this.setData({ campusFilter: campus, showCampusDropdown: false });
    if (!campus) {
      this.filterCats();
    } else {
      FilterService.loadCatsByCampus(campus, this);
    }
  },

  onCampusTab(e) {
    const campus = e.currentTarget.dataset.campus;
    this.setData({ campusFilter: campus });
    if (!campus) {
      this.filterCats();
    } else {
      FilterService.loadCatsByCampus(campus, this);
    }
  },

  /**
   * onCampusFilter — 与 onCampusTab 合并为一个处理函数
   * 两个事件处理函数之前完全重复，现统一为 onCampusTab
   */
  onCampusFilter(e) {
    this.onCampusTab(e);
  },

  async _loadCatsByCampus(campus) {
    await FilterService.loadCatsByCampus(campus, this);
  },

  async _filterCatsFromServer(kw) {
    return await FilterService.filterFromServer(this, kw);
  },

  async _loadAllAndFilter() {
    await FilterService.loadAllAndFilter(this);
  },

  _buildSearchIndex(cats) {
    if (!cats || cats.length === 0) { this._searchEngine.clear(); return; }
    this._searchEngine.buildIndex(cats, (cat) => [
      cat.name?.toLowerCase().trim(), cat.color?.toLowerCase().trim(),
      cat.location?.toLowerCase().trim(), cat.campus?.toLowerCase().trim(),
      cat.gender, cat.age,
      ...(cat.tags || []).map(tag => tag.toLowerCase().trim())
    ]);
  },

  _searchFromIndex() {
    const conditions = [];
    if (this.data.searchKeyword) {
      conditions.push({ type: 'keyword', value: this.data.searchKeyword.toLowerCase().trim() });
    }
    if (this.data.genderFilter) conditions.push({ type: 'exact', value: config.genderMap[this.data.genderFilter] });
    if (this.data.colorFilter) conditions.push({ type: 'exact', value: this.data.colorFilter });
    if (this.data.campusFilter) conditions.push({ type: 'exact', value: this.data.campusFilter });
    if (this.data.ageFilter) conditions.push({ type: 'exact', value: this.data.ageFilter });
    const results = this._searchEngine.search(conditions);
    // 本地搜索索引只支持「关键词 / 精确匹配」，星级是数值下界比较：
    // 放在检索之后做一次过滤，避免本地降级路径把「有星级」条件静默丢掉
    return this._applyAdoptFilter(results);
  },

  /**
   * 本地列表的好猫星级过滤（搜索索引降级路径与客户端兜底共用）：
   * adoptFilter 为空时原样返回；否则只保留「至少 N 星」的猫。
   * @param {Array} list
   * @returns {Array}
   */
  _applyAdoptFilter(list) {
    const minLevel = Number(this.data.adoptFilter);
    if (!minLevel) return list;
    return list.filter(cat => Number(cat.adoptLevel) >= minLevel);
  },

  /**
   * 面板内「重置」：只清性别/花色/年龄，不清搜索词和校区
   *（两者各有自己的清除入口：搜索框的清除按钮、校区下拉的「全部校区」）。
   * 清完后不能一律走 _restoreFullList —— 它会把 filteredCats 还原成全量基础列表，
   * 把仍在生效的搜索结果一并冲掉；必须按剩余条件重放。
   */
  onResetFilter() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    // setData 的 data 同步更新，下面分支读到的已是清空后的值
    this.setData({
      genderFilter: '', statusFilter: '', colorFilter: '', ageFilter: '', adoptFilter: '', showFilter: false
    });
    if (this.data.campusFilter) {
      // 校区路径内部走 filterFromServer，会带上已清空的性别/花色
      FilterService.loadCatsByCampus(this.data.campusFilter, this);
    } else if (this.data.searchKeyword) {
      this.filterCats();
    } else {
      this._restoreFullList();
    }
  },

  /**
   * 还原全量列表：清空搜索/校区/重置筛选共用（单次 setData）。
   * cats 是全量分页基准（筛选只写 filteredCats），由此恢复视图与基础分页状态。
   */
  _restoreFullList(extra = {}) {
    // 作废在途的筛选请求：清空搜索/重置筛选后列表立刻还原全量，
    // 若不自增序号，稍后返回的旧筛选响应仍能通过 filterCats 的 seq 校验，
    // 把已还原的全量列表又覆盖回旧结果
    this._filterSeq = (this._filterSeq || 0) + 1;
    this.setData({
      ...extra,
      filteredCats: this.data.cats,
      hasSearched: false,
      activeFilterCount: 0,
      // 在途请求已被上面的序号作废，不会再有响应把它置回 false
      isFiltering: false,
      filteredCatCount: this.data.totalCats || this.data.cats.length,
      // 筛选期间 hasMore 被筛选分页覆写，还原为基础列表的分页状态
      hasMore: this._baseHasMore !== null && this._baseHasMore !== undefined
        ? this._baseHasMore
        : this.data.hasMore
    });
  },

  // ========== 页面跳转 ==========

  onCatTouchStart(e) {
    const catId = e.currentTarget.dataset.id;
    if (!catId || this._prefetchTimers?.[catId]) return;
    this._prefetchTimers = this._prefetchTimers || {};
    this._touchStartY = e.touches?.[0]?.clientY || 0;
    this._touchScrolled = false;
    this._prefetchTimers[catId] = setTimeout(async () => {
      if (this._touchScrolled) {
        delete this._prefetchTimers[catId];
        return;
      }
      // 全局并发限制：同时只允许 1 个预取进行中，避免滑动浏览时浪费云配额
      if (this._prefetchInflight) {
        delete this._prefetchTimers[catId];
        return;
      }
      this._prefetchInflight = true;
      try {
        const db = wx.cloud.database();
        const catRes = await db.collection('cats')
          .where(withCatVisibility({ _id: catId }))
          .field(CAT_LIST_FIELDS)
          .limit(1)
          .get();
        const cat = catRes.data && catRes.data[0];
        // 猫咪不存在或正在删除中：不写预取缓存，交给详情页走 getCatDetail
        // （该云函数对 _deleting 记录返回「猫咪不存在」，与 filterCats 的列表口径一致）
        if (!cat) {
          Logger.info('index', '预取跳过：猫咪不存在或正在删除中', { catId });
          return;
        }
        const [photoRes, countRes] = await Promise.all([
          db.collection('photos')
            .where({ catId })
            .orderBy('createTime', 'desc')
            .limit(20)
            .field(PHOTO_LIST_FIELDS)
            .get(),
          db.collection('photos').where({ catId }).count()
        ]);
        app.setPrefetchCache(catId, {
          cat, photos: photoRes.data, totalPhotoCount: countRes.total
        });
        Logger.info('index', '预取详情数据完成', { catId, photoCount: photoRes.data.length, totalCount: countRes.total });
      } catch (err) {
        Logger.warn('index', '预取详情数据失败', { catId, error: err.message });
      } finally {
        delete this._prefetchTimers[catId];
        this._prefetchInflight = false;
      }
    }, config.performance.touchPreloadDelay);
  },

  onCatTouchMove(e) {
    if (this._touchScrolled) return;
    const y = e.touches?.[0]?.clientY || 0;
    if (Math.abs(y - this._touchStartY) > 10) {
      this._touchScrolled = true;
    }
  },

  onPageScroll(e) {
    this._touchScrolled = true;
    // 页面级 onPageScroll 会覆盖 behavior 中的同名方法，
    // 需手动转调以恢复「回到顶部」按钮的显隐逻辑
    if (e && typeof this._handleScroll === 'function') {
      this._handleScroll(e.scrollTop);
    }
  },

  onCatDetail(e) {
    const catId = e.currentTarget.dataset.id;
    if (this._prefetchTimers?.[catId]) {
      clearTimeout(this._prefetchTimers[catId]);
      delete this._prefetchTimers[catId];
    }
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
  },

  // 快捷入口导航
  onQuickAction(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    // tabBar 页禁止 navigateTo，必须 switchTab
    const TAB_ROUTES = ['/pages/index/index', '/pages/gallery/gallery', '/pages/profile/profile'];
    if (TAB_ROUTES.includes(url)) {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },

  // ========== 版本更新卡 ==========

  /**
   * 每次冷启动最多调度一张更新卡。
   * - 新用户还没完成欢迎屏时不弹（先欢迎，再谈更新）
   * - 已有更新卡在显示时不重复调度
   * - 延迟 800ms：避开启动首屏的骨架与数据渲染
   */
  _maybeShowRelease() {
    if (this._releaseScheduled || this._releaseShown) return;
    if (!guidance.hasCompletedOnboarding()) return;
    const isOpen = modal => !!(modal && modal.show);
    if (isOpen(this.data.agreementModal) || isOpen(this.data.welcomeModal)) return;

    const release = guidance.getPendingRelease(config.guidance.releases);
    if (!release) return;

    this._releaseScheduled = true;
    this._pendingRelease = release;

    const firstEntry = release.items.find(item => item && item.entry);
    const entry = firstEntry ? firstEntry.entry : '';

    if (this._releaseTimer) clearTimeout(this._releaseTimer);
    this._releaseTimer = setTimeout(() => {
      this._releaseTimer = null;
      if (this._isUnmounted) return;

      this._releaseShown = true;
      this.setData({
        releaseModal: {
          show: true,
          icon: release.icon || 'sparkle',
          title: release.title || '这次更新',
          items: release.items,
          entry
        }
      });
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDANCE_RELEASE_VIEW, {
        version: release.version
      });
    }, 800);
  },

  onReleaseConfirm() {
    const { entry } = this.data.releaseModal;
    this._closeReleaseModal(!!entry);
    if (entry) {
      wx.navigateTo({ url: entry });
    }
  },

  onReleaseCancel() {
    this._closeReleaseModal(false);
  },

  _closeReleaseModal(clicked) {
    const release = this._pendingRelease;
    this.setData({ 'releaseModal.show': false });
    this._releaseScheduled = false;

    if (release) {
      guidance.markReleaseSeen(release);
      if (clicked) {
        obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDANCE_RELEASE_CLICK, {
          version: release.version
        });
      }
    }
    this._pendingRelease = null;

    // 更新卡让位后再接全功能导览；不等下一次 onShow。
    this.scheduleGuideTour(500);
  },

  // ========== 全功能导览 ==========
  // 分步逻辑在 behaviors/guideTourBehavior；页面只负责在浮层关闭后
  // 主动 scheduleGuideTour，不等下一次 onShow。WXML 直接绑 behavior 的方法。

  onGoToNotice() {
    this._markNoticeRead();
    wx.navigateTo({ url: '/pages/notice/notice' });
  },

  /** 校园寻猫地图：打开就看到所有被标过位置的猫在哪（带上首页当前校区，省得再切） */
  onGoToCampusMap() {
    const zone = this.data.campusFilter;
    const q = zone && hasMap(zone) ? `?zone=${encodeURIComponent(zone)}` : '';
    wx.navigateTo({ url: `/subpackages/map/campus-map/campus-map${q}` });
  },

  // ========== 公告 ==========

  async checkNewNotice() {
    // 5 分钟内不重复检查：此前依赖 lastReadTime 短路，但用户从不点开公告时该键恒为空，
    // 导致每次 onShow 都发一次 getNotices 云调用（冷启动首屏还和 onLoad 重复一次）。
    const now = Date.now();
    if (this._lastNoticeCheckAt && now - this._lastNoticeCheckAt < 5 * 60 * 1000) return;
    this._lastNoticeCheckAt = now;

    const lastReadTime = wx.getStorageSync('lastNoticeReadTime') || '';
    const cachedLatest = wx.getStorageSync('latestNoticeTime') || '';
    if (cachedLatest && lastReadTime && cachedLatest <= lastReadTime) {
      if (this.data.hasNewNotice) this.setData({ hasNewNotice: false });
      return;
    }
    try {
      const res = await wx.cloud.callFunction({ name: 'getNotices', data: { latestOnly: true } });
      // 兼容新旧两种响应格式：{data:{notices}} 和 {notices}
      const notices = res.result?.data?.notices ?? res.result?.notices ?? [];
      if (res.result?.success && notices.length > 0) {
        const latestTime = notices[0].createTime;
        wx.setStorageSync('latestNoticeTime', latestTime);
        this.safeSetData({ hasNewNotice: latestTime > lastReadTime });
      }
    } catch (err) {
      Logger.warn('index', '检查新公告失败（非致命）', { error: err.message });
    }
  },

  _markNoticeRead() {
    const latestTime = wx.getStorageSync('latestNoticeTime') || new Date().toISOString();
    wx.setStorageSync('lastNoticeReadTime', latestTime);
    this.setData({ hasNewNotice: false });
  },

  // ========== 下拉刷新 & 触底 ==========

  async onPullDownRefresh() {
    Logger.info('index', '下拉刷新');
    // 刷新即回到无筛选状态，同时作废在途的筛选/校区请求，
    // 否则旧响应回来会把刚刷新的全量列表覆盖成旧筛选结果
    this._filterSeq = (this._filterSeq || 0) + 1;
    // 保留旧数据避免列表瞬间清空闪烁，仅重置分页/筛选状态
    // 新数据由 loadCats 内部 setData 整体替换
    this.setData({
      isRefreshing: true,
      page: 1,
      hasMore: true,
      searchKeyword: '',
      hasSearched: false,
      activeFilter: 'all',
      // 筛选条件已全部重置，角标计数必须同步归零：
      // 否则列表已是全量、面板无任何选中项，按钮仍显示「筛选 ·N」，自相矛盾
      activeFilterCount: 0,
      genderFilter: '',
      statusFilter: '',
      colorFilter: '',
      campusFilter: '',
      // ageFilter 当前还没有 UI 与 setter（死字段），但已被 filterCats / activeFilterCount /
      // filterService 等 5 处消费。此处一并重置，避免将来加上年龄筛选 UI 后
      // 出现「下拉刷新后筛选条件还在但列表已变」的幽灵状态。
      ageFilter: '',
      // 好猫星级筛选同理：刷新即回到无筛选状态
      adoptFilter: ''
      // 故意不重置 cats / filteredCats：保留旧数据直到新数据到达，避免闪烁
    });
    this.clearCache();
    this._loadingCats = false;
    // 筛选/降级全量加载期间 catService.loadCats 的入口守卫是 `_loadingCats || _loadingAll`，
    // 只解锁前者会让刷新请求被静默吞掉却提示「刷新成功」；在途筛选响应会被 _filterSeq 作废
    this._loadingAll = false;
    try {
      await this.loadCats();
      wx.stopPullDownRefresh();
      wx.showToast({ title: '刷新成功', icon: 'success' });
    } catch (err) {
      wx.stopPullDownRefresh();
      ErrorHandler.handle(err, { title: '刷新失败' });
    } finally {
      this.safeSetData({ isRefreshing: false });
    }
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore) this.loadMoreCats();
  },

  // ========== 分享 ==========

  onShareAppMessage() {
    const { totalCats } = this.data;
    // 首页是聚合页：没有「某一张具体猫图」的语义，统一用随机品牌卡。
    // 历史上拿第一只猫的头像当 5:4 封面，会被微信裁成一颗大头照（2026-10-22 反馈）。
    return {
      title: ShareTextGenerator.generateHomeText({ totalCats }, 'friend'),
      path: '/pages/index/index',
      imageUrl: ShareHelper.randomBrandImage()
    };
  },

  onShareTimeline() {
    const { totalCats } = this.data;
    return {
      title: ShareTextGenerator.generateHomeText({ totalCats }, 'timeline'),
      query: '',
      imageUrl: ShareHelper.randomBrandImage()
    };
  }
});
