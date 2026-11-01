/**
 * pages/admin/photo-manage/photo-manage.js - 相册列表
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');

const ErrorHandler = require('../../../utils/errorHandler');

const { Logger } = require('../../../utils/logger');
const { getPageStateManager } = require('../../../utils/pageState');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

/**
 * 批量把相册封面的 cloud:// fileID 换成临时链接。
 * 单独抽成模块级函数（不挂在 Page 上、也不依赖 this）是为了压低 loadAlbums 的复杂度，
 * 它本来就因分页/序号/降级三组分支顶在上限附近。
 *
 * @returns {Promise<Array>} 转链后的相册数组；转链失败时原样返回（封面退回占位图）
 */
async function resolveCoverUrls(albums) {
  const coverFileIDs = albums
    .map(a => a.coverUrl)
    .filter(url => url && url.startsWith('cloud://'));

  if (coverFileIDs.length === 0) return albums;

  try {
    const cfRes = await wx.cloud.callFunction({
      name: 'getCatAvatars',
      data: { fileIDs: coverFileIDs }
    });
    const urlMap = cfRes.result?.data?.urlMap || {};
    return albums.map(album => ({
      ...album,
      coverUrl: urlMap[album.coverUrl] || album.coverUrl
    }));
  } catch (e) {
    // 非致命：封面取不到就退回占位图，列表本身照常可用
    Logger.warn('photo-manage', '封面加载失败', { error: e.message });
    return albums;
  }
}


Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    // 清理延迟返回定时器（门禁失败自动返回用）
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    // 清理搜索防抖定时器：否则用户输完关键词立刻返回，300ms 后定时器仍会
    // 在已销毁页面上触发 performSearch
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
  },
  behaviors: [adminBehavior, safeSetDataBehavior],
  data: {
    statusBarHeight: 0,
    albums: [],
    // 初值必须是 true：onLoad 首行就是 await requireAdminAuth()，门禁往返期间
    // 若为 false，wxml:52 的空态（!loading && albums.length===0）会先渲染出来，
    // 闪现一帧「暂无猫咪相册」。注释「loading 初值为 true」此前与代码相反。
    loading: true,
    // 相册分页：云端 page 从 0 起（getAlbumsWithInfo 支持分页与 hasMore）。
    // 旧实现只拉 page:0/pageSize:100 且忽略 hasMore —— 超过 100 只猫时静默截断。
    albumPage: 0,
    hasMoreAlbums: false,
    // 云端计数降级标记（聚合不可用 → 逐只 count 兜底）
    countsDegraded: false,
    loadingMore: false,
    skeletonItems: [1, 2, 3, 4],

    // 搜索：服务端过滤（keyword 走 getAlbumsWithInfo）。
    // 口径与 cat-manage 一致：防抖 300ms + 序号守卫丢弃过期响应。
    searchKeyword: '',
    hasSearched: false,
    searchTotal: 0,
    totalAlbums: 0,
    // 搜索失败提示（非空 = 云端取不到，可点重试）。与「没有找到匹配的相册」必须分开
    searchError: ''
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!this.guardPermission('photo', '照片管理')) {
      this.safeSetData({ loading: false });
      return;
    }
    this.safeSetData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 0 });
    await this.loadAlbums();
    this._lastLoadTime = Date.now();
  },


  async onShow() {
    // 首屏跳过：onLoad 已await loadAlbums()，但 _lastLoadTime 是在 await **之后**
    // 才赋值，onShow 早于它完成 → 守卫失效 → getAlbumsWithInfo + getCatAvatars
    // 双倍云调用。同项目 cat-manage / notice-manage 已有该守卫，此处原先漏了。
    if (!this._firstShowSkipped) {
      this._firstShowSkipped = true;
      return;
    }
    // 消费相册详情页的刷新标记（上传/删除照片后置位）：命中则跳过 20s 时间守卫
    // 直接重拉 —— 否则上传后 20s 内返回列表仍是旧张数/旧封面，管理员会误以为上传失败
    const pageState = getPageStateManager();
    if (pageState.checkNeedRefresh('photo-manage')) {
      await this.loadAlbums();
      this._lastLoadTime = Date.now();
      return;
    }
    const now = Date.now();
    if (this._lastLoadTime && now - this._lastLoadTime < 20000) return;
    await this.loadAlbums();
    this._lastLoadTime = now;
  },

  onPullDownRefresh() {
    this.loadAlbums().finally(() => wx.stopPullDownRefresh());
  },

  /** 触底加载下一页相册（hasMoreAlbums 为云端 hasMore） */
  onReachBottom() {
    this.loadAlbums(false);
  },

  async loadAlbums(reset = true) {
    if (!reset && (this.data.loading || this.data.loadingMore || !this.data.hasMoreAlbums)) return;

    // 序号守卫：连续输入时丢弃过期响应，防止「输入框显示新关键词、列表却是旧结果」。
    // 300ms 防抖只合并尚未发出的请求，对已在途的请求无效；而取封面的
    // getCatAvatars 又引入一次云往返，命中窗口比看上去更大（同 cat-manage）。
    this._albumSeq = (this._albumSeq || 0) + 1;
    const seq = this._albumSeq;

    this.safeSetData(reset ? { loading: true } : { loadingMore: true });

    const page = reset ? 0 : this.data.albumPage + 1;
    const keyword = this.data.searchKeyword || '';
    try {
      const res = await this.callAdminFunction('getAlbumsWithInfo', {
        page,
        pageSize: 100,
        // 搜索词为空时也传 ''：云端 trim 后等价于不过滤，两条路径共用一套代码
        keyword
      });

      if (seq !== this._albumSeq) return false;

      if (res.result && res.result.success) {
        await this._applyAlbumPage(res.result?.data ?? res.result ?? {}, { reset, page, keyword, seq });
      } else {
        // 失败**保留旧列表**：管理员正在浏览的内容不该因为一次失败就没了。
        // 但必须显式提示，否则「搜过了、就这些」会被当成结论（同 cat-manage）。
        this.safeSetData({ searchError: '加载失败，点此重试' });
        ErrorHandler.handle(new Error(res.result?.error || '获取相册失败'), { title: '加载失败' });
      }
    } catch (err) {
      if (seq !== this._albumSeq) return false;
      Logger.warn('photo-manage', '加载相册列表失败', { error: err.message });
      this.safeSetData({ searchError: '加载失败，点此重试' });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      if (seq === this._albumSeq) {
        this.safeSetData({ loading: false, loadingMore: false });
      }
    }
    return true;
  },

  /**
   * 落地一页相册数据（成功分支）。从 loadAlbums 抽出来是为了压低它的行数与复杂度 ——
   * 主流程已因分页 / 序号守卫 / 失败降级三组分支顶在阈值边缘。
   * @returns {Promise<void>}
   */
  async _applyAlbumPage(data, { reset, page, keyword, seq }) {
    let albums = (data.albums || []).map(album => ({
      ...album,
      photoCount: Number(album.photoCount) || 0
    }));

    // 取封面是一次云往返，期间用户可能又改了一次关键词：
    // 丢弃本次结果，否则「输入框是新词、列表却是旧词的结果」
    albums = await resolveCoverUrls(albums);
    if (seq !== this._albumSeq) return;

    // 分页追加：非重置时并到已加载列表后（按 catId 去重，防并发窗口重复行）
    const merged = reset
      ? albums
      : [...this.data.albums, ...albums.filter(a => !this.data.albums.some(b => b.catId === a.catId))];

    const hasTotal = typeof data.total === 'number';
    this.safeSetData({
      albums: merged,
      albumPage: page,
      hasMoreAlbums: data.hasMore === true,
      searchError: '',
      // 服务端 total 口径：非搜索态是全库相册数，搜索态是命中数。
      // 「找到 N 个」必须用后者，否则搜索时数字纹丝不动，等于没搜。
      totalAlbums: hasTotal ? data.total : this.data.totalAlbums,
      searchTotal: keyword && hasTotal ? data.total : this.data.searchTotal,
      // 云端聚合不可用时已降级为逐只 count；透出标记，提示计数可能不准，
      // 而不是让「列表 0 张、点进去有照片」这种矛盾只能靠用户发现
      countsDegraded: data.countsDegraded === true
    });

    if (data.countsDegraded === true) {
      Logger.warn('photo-manage', '照片计数已降级（云端聚合不可用，改用逐只统计）', {
        page,
        albumCount: merged.length
      });
    }
  },

  /**
   * 搜索输入（带防抖，口径同 cat-manage.onSearchInput）
   */
  onSearchInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ searchKeyword: keyword });

    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
    }

    if (!keyword) {
      // 自增序号作废在途搜索：否则已发出的旧请求仍能通过 seq 校验，
      // 把全量列表又覆盖回旧搜索结果
      this._albumSeq = (this._albumSeq || 0) + 1;
      this.setData({ hasSearched: false, albumPage: 0 });
      this.loadAlbums(true);
      return;
    }

    this._searchTimer = setTimeout(() => {
      this.performSearch();
    }, 300);
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

  async performSearch() {
    // keyword 由 onSearchInput 先写进 data.searchKeyword，loadAlbums 内部统一读它，
    // 这里不再单独传 —— 避免两处关键词来源不一致（传的那个与实际渲染的可能差一次 trim）
    this.setData({ hasSearched: true });
    await this.loadAlbums(true);
  },

  /**
   * 清除搜索（重新拉全量）
   */
  onClearSearch() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
    }
    // 作废在途搜索（双保险：loadAlbums 内部还会再自增一次序号）
    this._albumSeq = (this._albumSeq || 0) + 1;
    this.setData({
      searchKeyword: '',
      hasSearched: false,
      albumPage: 0,
      searchError: ''
    });
    this.loadAlbums(true);
  },

  /** 加载失败后的重试入口 */
  async onRetryLoad() {
    await this.loadAlbums(true);
  },

  onGoToAlbum(e) {
    const album = e.currentTarget.dataset.album;
    const catId = album.catId || album._id;
    const catName = encodeURIComponent(album.catName || album.name || '');
    wx.navigateTo({
      url: `/pages/admin/photo-manage/album-detail?catId=${encodeURIComponent(catId)}&catName=${catName}`
    });
  }
});
