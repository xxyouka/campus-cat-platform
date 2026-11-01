/**
 * pages/gallery/gallery.js - 相册列表页
 *
 * 职责：展示猫咪相册列表，点击进入独立相册页面
 */
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const imageLoader = require('../../utils/imageLoader');
const offlineCache = require('../../utils/offlineCache');
const { monitorPageLoad, monitorApi } = require('../../utils/performanceMonitor');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');
const cacheBehavior = require('../../behaviors/cacheBehavior');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const obsHelper = require('../../utils/obsHelper');
const opsTrack = require('../../utils/opsTrack');
const ShareHelper = require('../../utils/shareHelper');

/**
 * 相册去重键：优先 catId，其次 albumId / _id，最后用**数组下标**兜底。
 *
 * 兜底不能用 Math.random()：本函数在同一轮加载里被调用多次（自身去重、existingKeys
 * 构造、增量过滤、转链回填定位），随机键每次都不同，于是各处算出的键互相对不上，
 * 去重与回填会静默失效。必须在数据入口就确定性地绑好下标。
 *
 * 提到模块级：静默刷新（离线缓存 + 后台刷新合并）与转链回填都要用它，
 * 三处各写一份内联表达式迟早会漂移（历史上就漂移过）。
 */
function albumKey(album, idx) {
  return album.catId || album.albumId || album._id || `idx_${idx}`;
}

Page({
  // 使用回到顶部 behavior + 缓存 behavior（Tab 切换时 30s 内不重刷）
  behaviors: [backToTopBehavior, cacheBehavior, guideTourBehavior, safeSetDataBehavior],

  // ========== 数据 ==========
  data: {
    // 沉浸式顶部：状态栏高度
    statusBarHeight: 0,

    // 相册列表
    albums: [],
    loading: true,
    // 首屏加载失败（列表为空时展示错误态 + 重试）
    loadError: false,

    // 相册分页
    albumPage: 0,
    albumPageSize: 10,
    hasMoreAlbums: true,
    albumsLoading: false,
    showBackToTop: false,
    skeletonItems: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  },

  // ========== 生命周期 ==========

  onLoad () {
    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });

    obsHelper.reportEvent(obsHelper.EVENT_NAMES.VIEW_GALLERY, {});
    opsTrack.entry('gallery');

    // SWR：先用落盘的上一屏内容渲染（有缓存就是「秒开」，不再从骨架屏起步），再静默刷新。
    // 静默刷新与本页原来的加载共用同一套分页/去重状态机，区别只有两点：
    //   ① 不清空列表、不置 loading（否则刚渲染的缓存会被清掉，骨架屏闪一次 = 白做）；
    //   ② 结果按 catId 就地合并而不是整体替换。
    // 与首页 catService.loadCats 的 options.silent 是同一模式。
    const hasCachedRender = this._renderAlbumsFromCache();

    monitorPageLoad('gallery', () => this.loadCatAlbums(true, { silent: hasCachedRender }))
      .catch(err => Logger.error('gallery', '相册首屏加载失败', err));
  },

  /**
   * 页面显示（Tab 切换回来时触发）
   * 优化：30秒内不重复加载，避免 Tab 切换时闪烁
   */
  onShow() {
    this.initGuideTour('pages/gallery/gallery', { delay: 700 });

    // 首次加载时跳过（由 onLoad 负责）
    if (this._loadingAlbums || this.data.loading) return;

    // 使用 cacheBehavior：30秒内不重复加载。
    // 已有内容时同样走静默刷新：Tab 切回来不该把已经显示着的相册清空重画一遍。
    this.loadWithCache(() => {
      this.loadCatAlbums(true, { silent: (this.data.albums || []).length > 0 });
    }, { validTime: 30000 });
  },

  /**
   * 预加载相册封面（立即执行，不等待）
   * @param {number} count - 预加载数量，默认 10 个
   */
  _preloadFirstScreenAlbums (count = 10) {
    const albums = this.data.albums;
    if (albums.length === 0) return;

    const coverIds = albums
      .slice(0, count)
      .map(a => a.coverUrl || a.catAvatar)
      .filter(id => id?.startsWith('cloud://'));

    if (coverIds.length > 0) {
      imageLoader.preloadAboveFold(coverIds, 'thumbnail');
      Logger.info('gallery', '预加载相册封面', { count: coverIds.length });
    }
  },

  // ========== 相册列表 ==========

  /**
   * 用离线缓存渲染第一页（命中返回 true，未命中返回 false）。
   *
   * 只渲染缓存的第一页：缓存渲染后 albumPage 仍从 0 起，紧随其后的静默刷新
   * 成功即推进到 1，与「加载更多」的分页口径完全一致。缓存里若预置更多页，
   * 页码与已加载数据就对不上，触底加载会重复拉取。
   */
  _renderAlbumsFromCache () {
    const cached = offlineCache.getAlbums();
    if (!cached || cached.length === 0) return false;

    this.safeSetData({
      albums: cached,
      loading: false,
      loadError: false,
      // 缓存只有第一页，后面还有没有得等静默刷新给答案；先按「可能还有」渲染，
      // 否则数据到底时「已经到底啦」会先闪一下再变成「加载更多」
      hasMoreAlbums: true
    });
    this._preloadFirstScreenAlbums(10);
    Logger.info('gallery', '使用离线缓存渲染相册', { count: cached.length });
    return true;
  },

  /**
   * 按去重键就地合并（静默刷新用）：新数据覆盖同键项，未出现在本次响应里的旧项保留。
   *
   * 保留旧项而不是整体替换：静默刷新只拉第一页，整体替换会把用户已经翻出来的
   * 第 2 页起的内容清掉；覆盖同键项时保留已转好链的 http 封面（见下），
   * 避免同一张封面「http → cloud:// → http」来回换 src 触发无谓的重新加载。
   */
  _mergeAlbums (existing, incoming) {
    const current = Array.isArray(existing) ? existing : [];
    if (current.length === 0) return incoming;

    const idxByKey = {};
    current.forEach((album, idx) => { idxByKey[albumKey(album, idx)] = idx; });

    const merged = current.slice();
    incoming.forEach((album, idx) => {
      const key = albumKey(album, idx);
      const at = idxByKey[key];
      if (at === undefined) {
        merged.push(album);
        return;
      }
      const prev = merged[at];
      const next = { ...prev, ...album };
      // 同一文件（_coverFileID 记的是转链前的原始 fileID）已转好链时保留 http 结果：
      // 新数据里的 coverUrl 又是 cloud://，直接覆盖会让卡片把 src 换回 cloud:// 再转一次。
      // 管理员换掉封面时 fileID 会变，此时必须用新值 —— 这正是要记 fileID、
      // 而不是简单地「有 http 就沿用 http」的原因（后者会让封面永远停在旧图）。
      if (prev._coverFileID && prev._coverFileID === album.coverUrl &&
          prev.coverUrl && !prev.coverUrl.startsWith('cloud://')) {
        next.coverUrl = prev.coverUrl;
      }
      if (prev._catAvatarFileID && prev._catAvatarFileID === album.catAvatar &&
          prev.catAvatar && !prev.catAvatar.startsWith('cloud://')) {
        next.catAvatar = prev.catAvatar;
      }
      merged[at] = next;
    });
    return merged;
  },

  /**
   * 刷新成功后以服务端第一页重建列表，避免排序变动使旧页码漏项。
   * 静默刷新复用未变化的已转链封面，加载期间仍显示旧列表。
   */
  _buildNextAlbums (reset, silent, inner, newAlbums, uniqueNewAlbums) {
    if (reset && !silent) return uniqueNewAlbums;
    if (!reset) return [...this.data.albums, ...uniqueNewAlbums];

    const merged = this._mergeAlbums(this.data.albums, newAlbums);
    const byKey = new Map(merged.map((album, idx) => [albumKey(album, idx), album]));
    return newAlbums.map((album, idx) => byKey.get(albumKey(album, idx)) || album);
  },

  /**
   * 加载猫咪相册列表
   * @param {boolean} reset - 是否从第一页重拉
   * @param {{silent?: boolean}} options - silent：已有内容（离线缓存/上一轮结果）时不闪骨架屏，
   *   成功后替换为最新第一页。onLoad 命中离线缓存、onShow 带着内容回来时使用。
   */
  async loadCatAlbums(reset = false, options = {}) {
    if (this._loadingAlbums) return;
    this._loadingAlbums = true;

    const silent = !!options.silent;

    try {
      if (reset && !silent) {
        this.setData({
          albumPage: 0,
          hasMoreAlbums: true,
          albums: [],
          loading: true,
          albumsLoading: false,
          loadError: false
        });
      } else if (!reset) {
        this.setData({ albumsLoading: true });
      }
      // reset && silent：什么都不置。列表里已有内容在渲染，
      // 清空或转 loading 都会让用户看到一次无谓的骨架屏。

      const page = reset ? 0 : this.data.albumPage;
      const pageSize = this.data.albumPageSize;

      const res = await monitorApi(
        'gallery-getAlbumsWithInfo',
        () => wx.cloud.callFunction({
          name: 'getAlbumsWithInfo',
          data: { page, pageSize },
          timeout: 10000
        })
      );

      if (!res.result?.success) {
        throw new Error(res.result?.error || '获取相册失败');
      }

      const inner = res.result?.data ?? res.result ?? {};
      let newAlbums = inner.albums || [];

      // 去重键统一由模块级 albumKey 生成（口径与其注释：随机键会让跨页去重静默失效）
      const seen = new Set();
      newAlbums = newAlbums
        .map((a, idx) => ({ album: a, key: albumKey(a, idx) }))
        .filter(({ key }) => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(({ album }) => album);

      // 客户端去重（与已有数据去重）：已有数据键在入库时已按当时下标生成，
      // 这里沿用同样的下标口径（新旧数组顺序一致时才对得上，这也正是去重的前提）
      const existingKeys = new Set(this.data.albums.map((a, idx) => albumKey(a, idx)));
      const uniqueNewAlbums = newAlbums.filter((a, idx) => !existingKeys.has(albumKey(a, idx)));
      
      if (uniqueNewAlbums.length === 0 && !reset) {
        this.safeSetData({
          albumPage: page + 1, hasMoreAlbums: inner.hasMore !== false, loading: false, albumsLoading: false
        });
        this._loadingAlbums = false;
        return;
      }
      
      // 封面转链**不阻塞首屏**：lazy-image 的 src 原生支持 cloud://（内部按 type
      // 转链），所以拿到数据先直接渲染，转链在后台完成再 patch 回填。
      // 旧实现 await convertAlbumCovers 之后才 setData，首屏多付一个完整往返
      //（150~300ms）；而这一轮拿到的档位（thumbnail）与 lazy-image 自己用的完全一致，
      // 于是 patch 回来的值与 lazy-image 内部算的是同一个缓存键（fileID@thumbnail），
      // 不会触发二次下载。
      //
      // 合并口径分三种（整体替换 / 就地合并 / 追加），
      // 详细说明与「静默刷新必须喂 newAlbums」的原因见 _buildNextAlbums
      const nextAlbums = this._buildNextAlbums(reset, silent, inner, newAlbums, uniqueNewAlbums);
      this.safeSetData({
        albums: nextAlbums,
        albumPage: page + 1,
        hasMoreAlbums: inner.hasMore !== false,
        loading: false,
        albumsLoading: false
      });

      // 记账给 onShow 的 30s 去重（cacheBehavior.isCacheValid）用。
      //
      // 必须在这里记：`loadWithCache` 只在**它自己**调完 loadFn 之后才 updateCacheTime
      //（behaviors/cacheBehavior.js:46-48），而首屏是 onLoad 直接调 loadCatAlbums 的，
      // 从不经过它 → `_cacheLastLoadTime` 恒为 0 → isCacheValid 永远判 false →
      // 每次从子页/Tab 切回相册都重发一次完整 getAlbumsWithInfo。
      // 2026-10-18 线上日志实证：同一用户 28s 内两次调用（1602ms / 1137ms），
      // 两次都超阈值，且第二次显然不是冷启动 —— 30s 窗口压根没生效。
      //
      // 只在 reset 且**成功**时记：加载更多不该续期；失败不能记账，
      // 否则错误态重试会被自己挡住 30 秒。
      if (reset) this.updateCacheTime();

      // 落盘与转链都用**本次响应的原始批次**（newAlbums）：
      //   - 落盘必须在 convertAlbumCovers 之前，转链会把 coverUrl 换成会过期的临时链接，
      //     缓存里要留 cloud:// 原值（见 offlineCache.saveAlbums 的说明）；
      //   - 只存第一页（page === 0）：缓存服务于「下次冷启动立刻出内容」，
      //     第二页起由静默刷新/触底加载补齐；
      //   - 用 uniqueNewAlbums 会漏掉静默刷新要覆盖的那批同键项（见上面的合并说明）。
      if (page === 0 && newAlbums.length > 0) {
        offlineCache.saveAlbums(newAlbums);
      }

      // 立即预加载当前批次封面（此时还是 cloud:// 原 ID，转链与否都能预热）
      this._preloadFirstScreenAlbums(10);

      // 后台转链并回填（不阻塞列表渲染，失败也不影响已渲染的列表）
      this._patchConvertedCovers(newAlbums);
    } catch (err) {
      Logger.error('gallery', '加载相册失败', err);
      // 列表为空时展示错误态（保留重试入口）；已有数据时仅 toast，不停留在骨架屏
      this.safeSetData({
        loading: false,
        albumsLoading: false,
        loadError: this.data.albums.length === 0
      });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingAlbums = false;
    }
  },

  /**
   * 错误态重试
   */
  onRetryLoad() {
    if (this._loadingAlbums) return;
    this.setData({ loadError: false, loading: true });
    this.loadCatAlbums(true);
  },

  /**
   * 空状态跳转首页
   */
  onGoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  /**
   * 加载更多相册
   */
  onLoadMoreAlbums() {
    if (this.data.hasMoreAlbums && !this._loadingAlbums) {
      this.loadCatAlbums(false);
    }
  },

  /**
   * 进入单个猫咪相册（跳转独立页面）
   */
  onEnterCatAlbum(e) {
    const { catId, catName, photoCount, avatar } = e.currentTarget.dataset;
    if (!catId) return;

    wx.navigateTo({
      url: `/pages/gallery/cat-album?catId=${catId}&catName=${encodeURIComponent(catName || '未知猫咪')}&photoCount=${photoCount || 0}&avatarUrl=${encodeURIComponent(avatar || '')}`
    });
  },

  // ========== 封面 URL 转换 ==========

  /**
   * 后台转链封面并按去重键回填。失败不影响已渲染的列表：
   * coverUrl 保持 cloud://，lazy-image 会自己处理。
   *
   * 回填定位必须按去重键，而不是原先的「startIdx + 本批次下标」位移口径：
   * 静默刷新是把新数据合并进已有列表（位置不再与新批次一一对应）。
   */
  _patchConvertedCovers(albums) {
    this.convertAlbumCovers(albums)
      .then(albumsWithUrls => {
        if (this._isUnmounted) return;
        const current = this.data.albums;
        if (!Array.isArray(current) || current.length === 0) return;

        const idxByKey = {};
        current.forEach((album, i) => { if (album) idxByKey[albumKey(album, i)] = i; });

        const patch = {};
        albumsWithUrls.forEach((album, i) => {
          const key = albumKey(album, i);
          const idx = idxByKey[key];
          if (idx === undefined || !current[idx]) return;
          // 列表可能已被新一轮刷新整体替换：按 key 复核后再写
          if (albumKey(current[idx], idx) !== key) return;
          patch[`albums[${idx}].coverUrl`] = album.coverUrl;
          if (album.catAvatar) patch[`albums[${idx}].catAvatar`] = album.catAvatar;
          // 记下转链前的原始 fileID：静默刷新合并时据此判断封面是否已转过链
          if (album._coverFileID) patch[`albums[${idx}]._coverFileID`] = album._coverFileID;
          if (album._catAvatarFileID) patch[`albums[${idx}]._catAvatarFileID`] = album._catAvatarFileID;
        });

        if (Object.keys(patch).length > 0) this.safeSetData(patch);
      })
      .catch(err => {
        Logger.warn('gallery', '封面转链失败（列表已正常渲染）', { error: err.message });
      });
  },

  /**
   * 转换相册封面图片URL
   * 优化：封面和头像统一走 thumbnail（200px），仅一次 getTempUrls 调用
   * 之前：coverIds(avatar) + avatarIds(thumbnail) 两次并行请求
   * 现在：合并为一次请求，减少 getTempFileURL 调用
   */
  async convertAlbumCovers(albums) {
    if (!albums?.length) return albums;

    // 收集所有需要转换的 cloud:// ID（去重）
    const allCloudIds = [];
    const idFieldMap = []; // { idx, field } 记录每个 ID 属于哪个 album 的哪个字段

    albums.forEach((album, idx) => {
      if (album.coverUrl?.startsWith('cloud://')) {
        allCloudIds.push(album.coverUrl);
        idFieldMap.push({ idx, field: 'coverUrl', id: album.coverUrl });
      }
      // 仅当 catAvatar 与 coverUrl 不同时才单独处理
      if (album.catAvatar?.startsWith('cloud://') && album.catAvatar !== album.coverUrl) {
        allCloudIds.push(album.catAvatar);
        idFieldMap.push({ idx, field: 'catAvatar', id: album.catAvatar });
      }
    });

    if (allCloudIds.length === 0) return albums;

    // 一次 getTempUrls 调用，统一 thumbnail 类型（200px）
    const urlMap = await imageLoader.getTempUrls(allCloudIds, { optimizeType: 'thumbnail' });

    // 应用 URL 到相册对象
    return albums.map((album, idx) => {
      const result = { ...album };

      idFieldMap.filter(m => m.idx === idx).forEach(({ field, id }) => {
        const optimizedUrl = urlMap[id];
        if (field === 'coverUrl') {
          result.coverUrl = optimizedUrl || null;
          result._coverUrlFailed = !optimizedUrl;
          // 记下转链前的原始 fileID：静默刷新合并时据此判断「同一张封面是否已转过链」，
          // 避免把已经拿到 http 的 coverUrl 又换回 cloud:// 重新加载一次（见 _mergeAlbums）
          result._coverFileID = id;
        } else if (field === 'catAvatar') {
          result.catAvatar = optimizedUrl || null;
          result._catAvatarFailed = !optimizedUrl;
          result._catAvatarFileID = id;
        }
      });

      return result;
    });
  },

  // ========== 图片事件 ==========

  /**
   * 图片加载失败
   */
  onImageError(e) {
    const { index, type } = e.currentTarget.dataset;
    
    if (type === 'album') {
      // 使用路径更新，避免直接修改 data 数组引用
      this.setData({
        [`albums[${index}]._hasValidCover`]: false
      });
    }
  },

  // ========== 下拉刷新 ==========

  // onPageScroll 和 onBackToTop 由 backToTopBehavior 提供（含节流）

  async onPullDownRefresh() {
    await this.loadCatAlbums(true);
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    if (this.data.hasMoreAlbums && !this._loadingAlbums && !this.data.albumsLoading) {
      this.loadCatAlbums(false);
    }
  },

  // ========== 分享 ==========

  /**
   * 相册列表页的分享图用第一张相册封面：这是最能代表「校园猫咪相册」的画面。
   * 封面可能是未转链的 cloud://（首屏极快划走时转链还没回来），此时宁可不带图，
   * 让微信截页面，也不要塞一张无关的默认头像。
   */
  _shareImage() {
    const first = (this.data.albums || [])[0];
    return ShareHelper.firstShareImage([
      first && first.coverUrl,
      first && first.catAvatar
    ]);
  },

  onShareAppMessage() {
    const share = {
      title: ShareHelper.pickTitle([
        '校园猫咪相册 | 每一帧都是治愈',
        '记录校园里的小可爱们 - 校园猫猫相册',
        '校园猫咪图鉴 | 快来看看这些毛孩子'
      ]),
      path: '/pages/gallery/gallery'
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  onShareTimeline() {
    const share = {
      title: ShareHelper.pickTitle([
        '校园猫咪相册 | 每一只都值得被记录',
        '校园猫猫图鉴 - 校园里的毛孩子大赏',
        '用镜头记录温暖 - 校园猫咪相册'
      ]),
      query: ''
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  // ========== 生命周期 ==========

  onHide() {
    this.pauseGuideTour();
  },

  onUnload() {
    this._isUnmounted = true;
    this.destroyGuideTour();
    // 清理可能存在的定时器（防御性清理）
    const timerKeys = ['_preloadTimer', '_preloadTimer1', '_scrollTopTimer'];
    timerKeys.forEach(key => {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    });
    // 清理运行状态标志位
    this._loadingAlbums = false;
  }
});
