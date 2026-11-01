/**
 * pages/admin/cat-manage/cat-manage.js - 猫咪管理页面
 * 
 * 职责：
 * 1. 展示猫咪列表
 * 2. 搜索和筛选
 * 3. 编辑和删除猫咪
 */
const _app = getApp();
const { requireAdminAuth, checkAdminAuth } = require('../../../utils/adminAuth');

const { Logger } = require('../../../utils/logger');

const ErrorHandler = require('../../../utils/errorHandler');

const backToTopBehavior = require('../../../behaviors/backToTopBehavior');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');
const { getPageStateManager } = require('../../../utils/pageState');


Page({
  // 使用回到顶部 behavior（含节流）
  behaviors: [backToTopBehavior, adminBehavior, safeSetDataBehavior],

  // ========== 数据 ==========
  data: {
    statusBarHeight: 0,
    cats: [],
    allCats: [],
    totalCats: 0,
    loading: true,
    searchKeyword: '',
    hasSearched: false,
    searchTotal: 0,
    // 搜索失败提示（非空 = 云端取不到，可点重试）。与「没有找到匹配的猫咪」必须分开
    searchError: '',
    deleteModal: { show: false, cat: null },
    
    // 分页
    page: 1,
    pageSize: 10,
    hasMore: false,
    loadingMore: false,
    showBackToTop: false,
    skeletonItems: [1, 2, 3]
  },

  // ========== 生命周期 ==========

  async onLoad() {
    this._backToTopThreshold = 400;
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!this.guardPermission('cat', '猫咪管理')) {
      this.safeSetData({ loading: false });
      return;
    }
    // 入口已由 guardPermission('cat') 把关：能进本页即具备「猫咪管理」权限，
    // 页内删除不再按角色隐藏（普通管理员被开通入口后同样可以删）。
    this.setData({
      statusBarHeight: wx.getWindowInfo().statusBarHeight || 0
    });
    this.loadCats();
  },


  onShow() {
    // onLoad 已触发首载，首次 onShow 直接跳过，避免双请求
    if (!this._firstShowSkipped) {
      this._firstShowSkipped = true;
      return;
    }
    // 消费编辑页的刷新标记（改名/换头像后立即返回）：20s 时间守卫会吞掉这次刷新，
    // 且换头像后旧文件已删 → 列表裂图，管理员会误以为新头像上传失败
    const pageState = getPageStateManager();
    if (pageState.checkNeedRefresh('cat-manage')) {
      if (this.data.hasSearched && this.data.searchKeyword) {
        this.performSearch(this.data.searchKeyword);
      } else {
        this.loadCats();
      }
      return;
    }
    // 使用缓存策略，20秒内不重复加载
    const now = Date.now();
    const lastLoad = this._lastLoadTime || 0;
    if (now - lastLoad > 20000) {
      this.loadCats();
    }
  },

  // ========== 猫咪列表 ==========

  /**
   * 加载猫咪列表（第一页，通过云函数）
   */
  async loadCats() {
    if (this._loading) return;
    this._loading = true;
    // 与 performSearch / loadMoreCats 共用同一请求序号：
    // 本请求发出后，任何新请求（搜索/清空搜索/加载更多）都会自增序号使其作废。
    // 原先 loadCats 不参与序号 —— 冷启动/下拉刷新在途时输入搜索词，
    // loadCats 后落地会用**未过滤**的第一页覆盖搜索结果（hasSearched 仍是 true）。
    this._searchSeq = (this._searchSeq || 0) + 1;
    const seq = this._searchSeq;

    this.setData({ loading: true, page: 1 });

    try {
      const res = await this.callAdminFunction('filterCats', {
        filters: { page: 1, pageSize: this.data.pageSize }
      });

      if (seq !== this._searchSeq) return;

      if (!res.result?.success) {
        throw new Error(res.result?.error || '加载失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      const cats = data.cats || [];
      const catsWithAvatar = await this.convertCatAvatars(cats);

      // 转链是异步的，等待窗口内可能已发起新请求，落地前再校验一次
      if (seq !== this._searchSeq) return;

      this.safeSetData({
        cats: catsWithAvatar,
        allCats: catsWithAvatar,
        totalCats: data.total || 0,
        hasMore: data.hasMore || false,
        loading: false,
        loadingMore: false
      });

      this._lastLoadTime = Date.now();

    } catch (err) {
      if (seq !== this._searchSeq) return;
      Logger.error('cat-manage', '加载猫咪列表失败', err);
      ErrorHandler.handleDatabaseError(err, {
        show: true,
        title: '加载失败，请重试'
      });
      this.setData({ loading: false });
    } finally {
      this._loading = false;
    }
  },

  /**
   * 加载更多猫咪（通过云函数）
   */
  async loadMoreCats() {
    // 与 loadCats 共用同一把锁 + 同一请求序号：
    // 原先 loadMoreCats 只看 data.loadingMore，而 loadCats 只看 this._loading，
    // 两者互不感知 → 「加载更多」在途时下拉刷新会并发两个请求，
    // 若loadMoreCats 先落地、loadCats 后落地，第 1 页直接覆盖已加载的第 2 页，
    // page 被重置为 1，已加载内容静默丢失。
    if (this._loading || this.data.loadingMore || !this.data.hasMore) return;
    this._loading = true;
    this._searchSeq = (this._searchSeq || 0) + 1;
    const seq = this._searchSeq;

    try {
      this.setData({ loadingMore: true });

      const nextPage = this.data.page + 1;

      // 搜索态也能继续翻页：带上去重后的关键词，搜索结果不再被硬截断在第 1 页
      const filters = { page: nextPage, pageSize: this.data.pageSize };
      if (this.data.hasSearched && this.data.searchKeyword) {
        filters.keyword = this.data.searchKeyword;
      }

      const res = await this.callAdminFunction('filterCats', {
        filters
      });

      // 已被更新的请求接管（搜索/刷新）→ 丢弃本次结果
      if (seq !== this._searchSeq) return;

      if (!res.result?.success) {
        throw new Error(res.result?.error || '加载失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      const cats = data.cats || [];

      if (cats.length === 0) {
        this.safeSetData({ hasMore: false, loadingMore: false });
        return;
      }

      const catsWithAvatar = await this.convertCatAvatars(cats);
      // 转链是异步的，等待窗口内可能已发起新请求，落地前再校验一次
      if (seq !== this._searchSeq) return;
      const newCats = [...this.data.cats, ...catsWithAvatar];

      this.safeSetData({
        cats: newCats,
        allCats: newCats,
        page: nextPage,
        hasMore: data.hasMore || false,
        loadingMore: false
      });

    } catch (err) {
      if (seq !== this._searchSeq) return;
      Logger.error('cat-manage', '加载更多猫咪失败', err);
      ErrorHandler.handleDatabaseError(err, {
        show: true,
        title: '加载失败'
      });
      this.safeSetData({ loadingMore: false });
    } finally {
      // 锁必须无条件释放：loadMoreCats 在途时被 performSearch/onSearchInput 抢占
      // （_searchSeq 已自增）也会走到这里 —— 若用 `seq === this._searchSeq` 判定，
      // 这次释放会被跳过，_loading 永久为 true，此后 loadCats / loadMoreCats
      // 全部被守卫拦死，只能退出页面重进。
      // 无条件释放是安全的：同一时刻只可能有一个请求持有 _loading
      // （loadCats / loadMoreCats 入口都会检查），不存在「释放了别人的锁」的场景。
      this._loading = false;
      // loadingMore 同样必须无条件复位：被抢占的请求会在 seq 校验处提前 return，
      // 不经过 catch 的复位分支 —— 不复位则列表底部常驻「正在加载...」，
      // onReachBottom 与 loadMoreCats 的 data.loadingMore 守卫被永久拦死。
      this.safeSetData({ loadingMore: false });
    }
  },

  /**
   * 转换猫咪头像URL
   * 使用云函数获取（有管理员权限）
   */
  async convertCatAvatars(cats) {
    const needConvert = [];
    const avatarMap = new Map();

    cats.forEach((cat, index) => {
      let cloudUrl = null;
      if (cat.avatar?.startsWith('cloud://')) {
        cloudUrl = cat.avatar;
      } else if (cat.images?.[0]?.startsWith('cloud://')) {
        cloudUrl = cat.images[0];
      }
      
      if (cloudUrl) {
        needConvert.push(cloudUrl);
        avatarMap.set(index, cloudUrl);
      }
    });

    if (needConvert.length === 0) return cats;

    try {
      // 使用云函数获取（有管理员权限）
      const res = await this.callAdminFunction('getCatAvatars', { fileIDs: needConvert });
      
      const urlMap = res.result?.data?.urlMap || {};
      
      const newCats = [...cats];
      avatarMap.forEach((cloudUrl, index) => {
        if (urlMap[cloudUrl]) {
          newCats[index] = { ...newCats[index], _displayAvatar: urlMap[cloudUrl] };
        }
      });
      return newCats;
    } catch (err) {
      Logger.warn('cat-manage', '转换头像URL失败', { error: err.message });
      return cats;
    }
  },

  // ========== 搜索 ==========

  /**
   * 搜索输入（带防抖）
   */
  onSearchInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ searchKeyword: keyword });

    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
    }

    if (!keyword) {
      // 自增序号作废在途搜索请求：否则已发出的旧请求仍能通过 seq 校验，
      // 把空关键词下的全量列表又覆盖回旧搜索结果（同 index.js 的 _restoreFullList）
      this._searchSeq = (this._searchSeq || 0) + 1;
      this.setData({ hasSearched: false, hasMore: this.data.totalCats > this.data.page * this.data.pageSize });
      this.setData({ page: 1 });
      this.loadCats();
      return;
    }

    this._searchTimer = setTimeout(() => {
      this.performSearch(keyword);
    }, 300);
  },

  /**
   * 页面卸载 - 清理定时器
   */
  onUnload () {
    this._isUnmounted = true;
    // 清理延迟返回定时器（门禁失败自动返回用）
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
  },

  /**
   * 执行搜索（服务端搜索，覆盖全部猫咪）
   */
  async performSearch(keyword) {
    // 请求序号守卫：连续输入时丢弃过期响应，防止「输入框显示新关键词、列表却是旧结果」。
    // 300ms 防抖只合并尚未发出的请求，对已在途的请求无效；而 convertCatAvatars
    // 又引入一次云往返，命中窗口比看上去更大。同批页面 index.js / rank.js 已有此模式。
    this._searchSeq = (this._searchSeq || 0) + 1;
    const seq = this._searchSeq;

    this.setData({ loading: true, page: 1 });

    try {
      const res = await this.callAdminFunction('filterCats', {
        filters: { keyword, page: 1, pageSize: this.data.pageSize }
      });

      if (seq !== this._searchSeq) return;

      if (!res.result?.success) {
        throw new Error(res.result?.error || '搜索失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      const cats = data.cats || [];
      const catsWithAvatar = await this.convertCatAvatars(cats);

      if (seq !== this._searchSeq) return;

      this.safeSetData({
        cats: catsWithAvatar,
        hasSearched: true,
        hasMore: data.hasMore || false,
        searchError: '',
        // 搜索结果数用服务端返回的 total：原先列表统计显示 cats.length（仅第一页），
        // 命中 25 只只显示「找到 10 只猫咪」
        searchTotal: data.total || catsWithAvatar.length,
        loading: false
      });
    } catch (err) {
      if (seq !== this._searchSeq) return;
      Logger.error('cat-manage', '搜索失败', err);
      // 失败**不能**落回「没有找到匹配的猫咪」：那会把「云端取不到」说成
      // 「确实没有」，管理员会据此以为数据被删了。保留旧列表 + 显式错误 + 可重试。
      this.safeSetData({ loading: false, searchError: '搜索失败，点此重试' });
      ErrorHandler.handle(err, { title: '搜索失败' });
    }
  },

  /** 搜索失败后的重试入口 */
  onRetrySearch() {
    this.performSearch(this.data.searchKeyword);
  },

  /**
   * 搜索确认（点击键盘搜索按钮）
   */
  onSearchConfirm() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
    }
    this.performSearch(this.data.searchKeyword);
  },

  /**
   * 清除搜索（重新从服务端加载）
   */
  onClearSearch() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
    }
    // 作废在途搜索：否则旧搜索响应落地后把列表改回过滤结果并置 hasSearched=true，
    // 而此时输入框已经清空（loadCats 内部还会再自增一次序号，双保险）
    this._searchSeq = (this._searchSeq || 0) + 1;
    this.setData({
      searchKeyword: '',
      hasSearched: false,
      page: 1
    });
    this.loadCats();
  },

  // ========== 编辑和删除 ==========

  /**
   * 编辑猫咪
   */
  onEdit(e) {
    const catId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/admin/edit-cat/edit-cat?id=${encodeURIComponent(catId)}`
    });
  },

  /**
   * 显示删除确认弹窗
   */
  onDelete(e) {
    const catId = e.currentTarget.dataset.id;
    const cat = this.data.cats.find(c => c._id === catId);
    if (!cat) return;
    
    this.setData({
      'deleteModal.show': true,
      'deleteModal.cat': cat
    });
  },

  /**
   * 取消删除
   */
  onDeleteCancel() {
    this.setData({ 'deleteModal.show': false });
  },

  /**
   * 确认删除猫咪
   */
  async onDeleteConfirm() {
    if (this._deleting) return;
    this._deleting = true;

    const isAdmin = checkAdminAuth();
    if (!isAdmin) {
      this._deleting = false;
      wx.showToast({ title: '权限不足', icon: 'none' });
      return;
    }

    const { cat } = this.data.deleteModal;
    this.setData({ 'deleteModal.show': false });

    wx.showLoading({ title: '删除中…' });

    try {
      // 通过云函数删除猫咪（服务端权限校验 + 关联清理）
      const res = await this.callAdminFunction('deleteData', { type: 'cat', id: cat._id });

      wx.hideLoading();
      if (!res.result?.success) {
        ErrorHandler.handle(new Error(res.result?.error || '删除失败'), { title: '删除失败' });
        return;
      }

      ErrorHandler.showSuccess('删除成功');
      // 搜索态下必须重放搜索：直接 loadCats 会用未过滤全量覆盖列表，而 hasSearched 保持 true
      // → 「找到 N 只」与列表矛盾；此后翻页还会把搜索结果页拼到全量页之后，列表彻底混杂
      if (this.data.hasSearched && this.data.searchKeyword) {
        this.performSearch(this.data.searchKeyword);
      } else {
        this.loadCats();
      }
    } catch (err) {
      wx.hideLoading();
      Logger.error('cat-manage', '删除猫咪失败', err);
      ErrorHandler.handleDatabaseError(err, {
        show: true,
        title: '删除失败，请重试'
      });
    } finally {
      this._deleting = false;
    }
  },

  /**
   * 查看猫咪详情
   */
  onCatDetail(e) {
    const catId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${encodeURIComponent(catId)}`
    });
  },

  // ========== 下拉刷新 ==========

  onPullDownRefresh() {
    // 搜索态下刷新必须重放搜索：直接 loadCats 会用未过滤的全量覆盖搜索结果，
    // 而 hasSearched 仍为 true，列表与统计相互矛盾
    const task = this.data.hasSearched && this.data.searchKeyword
      ? this.performSearch(this.data.searchKeyword)
      : this.loadCats();
    return task.finally(() => wx.stopPullDownRefresh());
  },

  // onPageScroll 和 onBackToTop 由 backToTopBehavior 提供（含节流）

  // ========== 触底加载 ==========

  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore) {
      this.loadMoreCats();
    }
  },

  // ========== 头像处理 ==========

  /**
   * 猫咪头像加载失败，显示emoji
   */
  onCatImageError(e) {
    const index = e.currentTarget.dataset.index;
    const cats = [...this.data.cats];
    if (cats[index]) {
      cats[index] = { ...cats[index], _showEmoji: true };
      this.setData({ cats });
    }
  }
});
