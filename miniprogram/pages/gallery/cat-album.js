/**
 * pages/gallery/cat-album.js - 单个猫咪相册独立页面
 *
 * 职责：展示某一只猫咪的所有照片，系统返回按钮自然回到相册列表
 */
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const imageLoader = require('../../utils/imageLoader');
const { isNetworkError } = require('../../utils/network');
const AvatarHelper = require('../../utils/avatarHelper');
const Validator = require('../../utils/validator');
const ShareHelper = require('../../utils/shareHelper');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');

Page({
  behaviors: [guideTourBehavior, safeSetDataBehavior],
  data: {
    catInfo: null,
    photos: [],
    photosLoading: false,
    photoPage: 0,
    photoPageSize: 20,
    hasMore: true,
    loading: true,
    // 加载失败（区别于「真的没有照片」）：失败时渲染错误态 + 重试，不再伪装成空态
    loadError: false,
    loadMoreError: false,
    // 失败原因文案（网络失败时为空 → wxml 回落到通用网络提示）
    errorMessage: '',
    showBackToTop: false,
    // 回到顶部的目标锚点 id（scroll-into-view 用，见 onBackToTop）
    scrollIntoView: '',
    navTotalHeight: 0,
    skeletonItems: [1, 2, 3, 4, 5, 6]
  },

  onLoad (options) {
    const { catId, catName, photoCount, avatarUrl } = options;

    // 使用 Validator 校验 catId
    if (!Validator.validateCatId(catId)) {
      // 参数非法必须给明确反馈：只清 loading 会让 wxml 渲染「暂无照片」空态，
      // 把「传错了 catId」误报成「这只猫没有照片」
      this.setData({ loading: false, loadError: true, errorMessage: '猫咪信息无效，请返回重新进入' });
      return;
    }

    // 初始化导航栏高度
    this._initNavHeight();

    this._catId = catId;

    // decodeURIComponent 对畸形百分号编码（如 '%E4'、孤立的 '%'）会抛 URIError，
    // 且这里在 onLoad 同步段里 —— 不兜底就是进页即白屏。手工构造 URL/二维码可达。
    const safeDecode = (v, fallback) => {
      if (!v) return fallback;
      try { return decodeURIComponent(v); } catch (e) { return fallback; }
    };

    this.setData({
      catInfo: {
        name: safeDecode(catName, '未知猫咪'),
        photoCount: parseInt(photoCount) || 0,
        avatarUrl: safeDecode(avatarUrl, '')
      },
      loading: true
    });

    this.loadPhotos(catId);
    this.initGuideTour('pages/gallery/cat-album', { delay: 800 });
  },

  /**
   * 接收导航栏高度变化事件
   */
  onNavHeightChange(e) {
    const { totalHeight } = e.detail;
    if (totalHeight) {
      this.setData({ navTotalHeight: totalHeight });
    }
  },

  /**
   * 初始化导航栏高度（降级方案）
   */
  _initNavHeight() {
    try {
      let statusBarHeight = 20;
      let navBarHeight = 44;
      try {
        const deviceInfo = wx.getDeviceInfo();
        const windowInfo = wx.getWindowInfo();
        statusBarHeight = windowInfo.statusBarHeight || 20;
        navBarHeight = deviceInfo.platform === 'ios' ? 44 : 48;
      } catch (e) {
        const windowInfo = wx.getWindowInfo();
        const deviceInfo = wx.getDeviceInfo();
        statusBarHeight = windowInfo.statusBarHeight || 20;
        navBarHeight = deviceInfo.platform === 'ios' ? 44 : 48;
      }
      this.setData({
        navTotalHeight: statusBarHeight + navBarHeight
      });
    } catch (e) {
      this.setData({ navTotalHeight: 64 });
    }
  },

  /**
   * 加载照片列表
   */
  async loadPhotos(catId, reset = false) {
    if (this._loadingPhotos) return;
    this._loadingPhotos = true;
    this.safeSetData({ loadMoreError: false });

    try {
      const currentPage = reset ? 0 : this.data.photoPage;
      const pageSize = this.data.photoPageSize;

      if (reset) {
        this.setData({
          photoPage: 0,
          hasMore: true,
          photos: [],
          photosLoading: true
        });
      } else {
        this.setData({ photosLoading: true });
      }

      if (!reset && !this.data.hasMore) {
        this.setData({ photosLoading: false });
        this._loadingPhotos = false;
        return;
      }

      // 通过云函数获取照片列表（避免客户端直连数据库）
      const res = await wx.cloud.callFunction({
        name: 'getPhotosByCat',
        // 服务端页码从 1 开始（photoPage 记录已加载页数，本次请求下一页）
        data: { catId, page: currentPage + 1, pageSize }
      }).catch(err => {
        // 专门捕获网络层错误（云函数未部署 / 网络不通）
        if (isNetworkError(err)) {
          throw new Error('[NETWORK] 无法连接服务器，请检查网络后重试');
        }
        throw err;
      });

      if (!res.result?.success) {
        throw new Error(res.result?.error || '获取照片失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      let newPhotos = data.photos || [];
      const hasMoreFromServer = data.hasMore;
      // 服务端本次返回的原始条数（去重前）：hasMore 的判断必须基于它，
      // 否则分页时会用「去重后的条数」与 pageSize 比较——重复项被滤掉后永远凑不满
      // 一整页，hasMore 恒为 false，之后再也加载不出更多照片（分页死锁）
      const fetchedCount = newPhotos.length;

      // 客户端去重
      const existingIds = new Set(this.data.photos.map(p => p._id));
      newPhotos = newPhotos.filter(p => !existingIds.has(p._id));

      if (newPhotos.length === 0) {
        this.safeSetData({
          hasMore: false,
          photosLoading: false,
          loading: false,
          loadError: false
        });
        this._loadingPhotos = false;
        return;
      }

      // 转换 URL
      newPhotos = await this._resolvePhotoUrls(newPhotos);

      const allPhotos = reset ? newPhotos : [...this.data.photos, ...newPhotos];

      this.safeSetData({
        photos: allPhotos,
        photoPage: currentPage + 1,
        hasMore: hasMoreFromServer !== false && fetchedCount === this.data.photoPageSize,
        photosLoading: false,
        loading: false,
        loadError: false,
        // 回填照片总数：分享链接/直达时 photoCount 参数可能缺失，
        // 头部「0 张照片」会与网格里正在加载的照片自相矛盾
        'catInfo.photoCount': typeof data.total === 'number' ? data.total : this.data.catInfo.photoCount
      });

      // 头像兜底：直达/分享进入时 avatarUrl 参数缺失 → lazy-image 显示「图片加载失败」。
      // 用首批照片的已转链地址当封面（仅在确实为空时回填一次）
      if (!this.data.catInfo.avatarUrl && allPhotos.length > 0) {
        const cover = allPhotos[0].displayUrl || allPhotos[0].url || '';
        if (cover) this.safeSetData({ 'catInfo.avatarUrl': cover });
      }

      // 立即预加载照片
      if (allPhotos.length > 0) {
        const photoIds = allPhotos
          .slice(0, 8)
          .map(p => p._cloudFileID || p.cloudFileID || p.url)
          .filter(id => id?.startsWith('cloud://'));
        if (photoIds.length > 0) {
          imageLoader.preloadAboveFold(photoIds, 'gallery');
        }
      }

    } catch (err) {
      Logger.error('cat-album', '加载照片失败', err);
      // 首屏失败 → 置 loadError 渲染错误态（带重试）；已有照片时的「加载更多」失败
      // 只提示、不动列表，避免把已经看到的照片清空
      const firstLoadFailed = this.data.photos.length === 0;
      this.safeSetData({
        photosLoading: false,
        loading: false,
        loadError: firstLoadFailed,
        loadMoreError: !firstLoadFailed
      });
      // 网络层错误给更明确的提示（自定义 [NETWORK] 标记）
      if (err.message?.includes('[NETWORK]')) {
        ErrorHandler.toast('网络连接失败', { duration: 2000 });
        return;
      }
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingPhotos = false;
    }
  },

  /**
   * 转换照片 URL 为临时链接（使用公共工具类）
   */
  async _resolvePhotoUrls (photos) {
    return await AvatarHelper.resolvePhotoUrls(photos);
  },

  /**
   * 预加载下一页照片
   */
  _preloadNextPage (currentPhotos) {
    if (this._preloadTimer) clearTimeout(this._preloadTimer);
    this._preloadTimer = setTimeout(() => {
      const ids = currentPhotos
        .slice(-6)
        .map(p => p.url)
        .filter(id => id?.startsWith('cloud://'));

      if (ids.length > 0) {
        imageLoader.preloadBelowFold(ids, 'gallery');
      }
      this._preloadTimer = null;
    }, 500);
  },

  /**
   * scroll-view 触底自动加载更多
   */
  onScrollToLower () {
    if (this.data.hasMore && !this._loadingPhotos && !this.data.loadMoreError) {
      this.loadPhotos(this._catId, false);
    }
  },

  /**
   * 手动点击"加载更多"按钮
   */
  onLoadMore () {
    if (this.data.hasMore && !this._loadingPhotos) {
      this.loadPhotos(this._catId, false);
    }
  },

  /**
   * 首屏加载失败后的「重新加载」（错误态 CTA）
   */
  onRetryLoad () {
    this._loadingPhotos = false;
    this.safeSetData({ loadError: false, loading: true, photosLoading: true });
    this.loadPhotos(this._catId, true);
  },

  /**
   * 预览照片
   * 网格用 displayUrl（gallery 档 400px）；全屏预览必须换 detail 档（600×600），
   * 否则点开的大图是 400px 拉伸。只为「当前点开的这一张」换链一次
   * （走 imageLoader 的 fileID@detail 缓存，重复点开不再发请求），
   * 不对整页照片批量换档，避免预览一次就拉取整册大图。
   */
  async onPreviewPhoto (e) {
    const { url, id } = e.currentTarget.dataset;
    const photos = this.data.photos || [];
    const urls = photos
      .map(p => p.displayUrl || p.url)
      .filter(u => u && !u.startsWith('cloud://'));

    if (!urls.length || !url || url.startsWith('cloud://')) {
      ErrorHandler.toast('图片加载中，请稍后再试');
      return;
    }

    const photo = id ? photos.find(p => p._id === id) : null;
    const fileID = photo && (photo._cloudFileID ||
      (typeof photo.url === 'string' && photo.url.startsWith('cloud://') ? photo.url : ''));

    if (fileID) {
      const detailUrl = await imageLoader.getSingleTempUrl(fileID, { optimizeType: 'detail' });
      if (detailUrl) {
        // 用 detail 链接替换 urls 中对应的那一项，保证 current 仍在 urls 内（否则左右滑动会错位）
        const index = urls.indexOf(url);
        if (index >= 0) urls[index] = detailUrl;
        wx.previewImage({ current: detailUrl, urls });
        return;
      }
    }

    // 拿不到云文件 ID 或换链失败：退回列表用的 400px 链接，至少保证能预览
    wx.previewImage({ current: url, urls });
  },

  /**
   * scroll-view 滚动 - 控制回到顶部按钮显隐
   */
  onPhotoScroll (e) {
    const show = e.detail.scrollTop > 600;
    if (show !== this.data.showBackToTop) {
      this.setData({ showBackToTop: show });
    }
  },

  /**
   * 回到顶部
   */
  onBackToTop () {
    // 改用 scroll-into-view 定位到列表顶部锚点（wxml 中 id="album-top"）：
    // 原 scroll-top 方案下 data.scrollTop 从初始化起恒为 0，setData 值未变化会被
    // 小程序 diff 丢弃、不下发给 scroll-view，按钮点了没反应。
    // 这里先置空再置目标 id，并通过 setData 回调串行下发，确保两次更新的值都发生变化
    // （连续点击时若只设同一个 id，同样会被 diff 丢弃）。
    this.setData({ showBackToTop: false });
    this.safeSetData({ scrollIntoView: '' }, () => {
      this.safeSetData({ scrollIntoView: 'album-top' });
    });
  },

  /**
   * 下拉刷新
   */
  async onPullDownRefresh () {
    await this.loadPhotos(this._catId, true);
    wx.stopPullDownRefresh();
  },

  /**
   * 分享
   *
   * 分享图优先用第一张照片（最能代表这只猫），没有照片时退回头像；
   * 两者都拿不到就不传 imageUrl，让微信截页面 —— 不拿默认头像冒充。
   */
  _shareImage () {
    const firstPhoto = (this.data.photos || [])[0];
    const photoUrl = firstPhoto && (firstPhoto.displayUrl || firstPhoto.url);
    const catInfo = this.data.catInfo || {};
    return ShareHelper.firstShareImage([photoUrl, catInfo.avatarUrl]);
  },

  _shareCatName () {
    const catInfo = this.data.catInfo || {};
    return catInfo.name || '猫咪';
  },

  _shareTitle () {
    const catName = this._shareCatName();
    const catInfo = this.data.catInfo || {};
    const count = catInfo.photoCount || 0;
    return count > 0
      ? `「${catName}」的相册 | ${count} 张治愈系照片`
      : `「${catName}」的相册 - 校园猫猫`;
  },

  onShareAppMessage () {
    // 参数非法时页面停在错误态（没有 _catId）：不能分享一个必然打不开的链接
    if (!this._catId) {
      return {
        title: '校园猫咪相册 | 每一帧都是治愈',
        path: '/pages/gallery/gallery'
      };
    }
    const catName = this._shareCatName();
    const share = {
      title: this._shareTitle(),
      path: `/pages/gallery/cat-album?catId=${encodeURIComponent(this._catId)}&catName=${encodeURIComponent(catName)}`
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  onShareTimeline () {
    if (!this._catId) {
      return {
        title: '校园猫咪相册 | 每一只都值得被记录',
        query: ''
      };
    }
    const catName = this._shareCatName();
    const share = {
      title: this._shareTitle(),
      query: `catId=${encodeURIComponent(this._catId)}&catName=${encodeURIComponent(catName)}`
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  onUnload () {
    this._isUnmounted = true;
    this.destroyGuideTour();
    if (this._preloadTimer) {
      clearTimeout(this._preloadTimer);
      this._preloadTimer = null;
    }
    if (this._scrollTopTimer) {
      clearTimeout(this._scrollTopTimer);
      this._scrollTopTimer = null;
    }
  }
});
