/**
 * 我的关注页面
 */
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const MediaHelper = require('../../utils/mediaHelper');
const ShareHelper = require('../../utils/shareHelper');
const opsTrack = require('../../utils/opsTrack');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');

// 上次成功同步到云端的关注签名（catId 排序后拼接）。用于跳过「本地没变却仍全量回写」
// 的浪费 —— syncFavorites action:'sync' 是「以本地为准」的全量写，见 syncFavoritesToCloud。
const FAV_SYNC_SIG_KEY = '_fav_cloud_sync_sig';
const pendingFavoriteSyncSignatures = new Set();

Page({
  behaviors: [guideTourBehavior, safeSetDataBehavior],
  data: {
    favoriteCats: [],
    favoriteCount: 0,
    // 关注了但查不到（已删除/删除中）的数量；>0 时页面须如实提示，避免「共 3 只却只显示 2 只」
    missingCount: 0,
    loading: true,
    loadError: false,
    // 云端收藏拉取是否失败（用于区分「加载失败」与「真的没关注」）
    _cloudRestoreFailed: false,
    hasMore: true,
    loadingMore: false,
    page: 1,
    pageSize: 20,
    skeletonItems: [1, 2, 3, 4, 5, 6]
  },

  _syncTimer: null,
  _processingAction: false,
  _loadingFavorites: false,
  // 被在途锁挡下的强制重载（loadFavorites(true)）在此排队，锁释放后补跑一次
  _pendingFavoritesReload: false,

  async onLoad() {
    // 顺序有语义：必须先完成「云端 → 本地」的恢复，再做「本地 → 云端」的对齐。
    // _delayedSync 发出的是 action:'sync'（以本地为准，云端有而本地没有的会被**真实删除**）。
    // 旧实现两者并发发起：恢复失败或慢于 800ms 时，本地还是不含云端独有项（如另一台设备
    // 关注的猫）的旧列表，sync 会把这些云端收藏当「本地已取消」删掉 —— 跨设备收藏静默丢失。
    // 恢复失败时本次不再对齐：云端都读不到，sync 也没有意义，下次进入页面会重试。
    const restored = await this._restoreCloudFavorites();
    if (restored) {
      this._delayedSync();
    } else {
      Logger.warn('favorites', '云端恢复未完成，跳过本地→云端对齐（避免误删云端收藏）');
    }
  },

  async onShow() {
    opsTrack.entry('favorites');
    this.initGuideTour('pages/favorites/favorites', { delay: 800 });
    // 重置分页：loadMore 翻页后离开再返回时，避免同一页数据被重复 append
    if (this.data.page !== 1) {
      this.setData({ page: 1, hasMore: true });
    }
    await this.loadFavorites();
  },

  onPullDownRefresh() {
    // 下拉刷新语义是重置列表：loadMore 翻页后直接刷新会以旧页码重复 append 同一页
    if (this.data.page !== 1) {
      this.setData({ page: 1, hasMore: true });
    }
    this.loadFavorites().finally(() => wx.stopPullDownRefresh());
  },

  onHide() {
    this.pauseGuideTour();
    if (this._syncTimer) clearTimeout(this._syncTimer);
  },

  onUnload() {
    this._isUnmounted = true;
    this.destroyGuideTour();
    if (this._syncTimer) clearTimeout(this._syncTimer);
  },

  // ==================== 数据加载 ====================

  /**
   * 加载关注列表
   * @param {boolean} [force=false] - true 表示这次重载不可丢（如云端收藏合并后必须重载）；
   *   在途时排队一次，锁释放后自动补跑，而不是被在途锁静默吞掉
   */
  async loadFavorites(force = false) {
    // 在途锁：连点「加载更多」时第二次点击会在 loadMore 里被直接挡掉，
    // 这里再兜一层，防止同一页码被并发请求后整页重复 append
    if (this._processingAction || this._loadingFavorites) {
      // 不能在途直接 return：onLoad 先发 syncFavorites（_restoreCloudFavorites），
      // onShow 的 loadFavorites 占锁并 await getCatsByIds；云调用先返回、合并写回
      // storage 后调用的重载若被早退吞掉，合并进来的云端收藏与 favoriteCount
      // 就不会显示，直到下次进入页面/下拉刷新
      if (force) this._pendingFavoritesReload = true;
      return;
    }
    this._loadingFavorites = true;
    // 本次重载本身就会读最新 storage，先前排队的待办在此消化
    this._pendingFavoritesReload = false;

    try {
      const raw = wx.getStorageSync('favoriteCats') || [];
      const favoriteIds = Array.isArray(raw) ? this._normalizeFavorites(raw) : [];
      const favoriteCount = favoriteIds.length;
      this.setData({ favoriteCount });

      if (favoriteCount === 0) {
        // 本地空 ≠ 用户没关注：云端可能存着（换设备/清缓存后本地丢）。
        // _restoreCloudFavorites 合并完会置_pendingFavoritesReload 触发强制重载，
        // 但它**失败**时（云端未部署 / OPENID 取不到）也要给出可见信号，
        // 否则这里直接渲染「还没有关注任何猫咪」，与真实空列表完全同形。
        this.setData({
          favoriteCats: [], missingCount: 0, loading: false,
          loadError: this.data._cloudRestoreFailed === true
        });
        return;
      }

      const catIds = favoriteIds.map(item => item.id).filter(Boolean);
      if (catIds.length === 0) {
        this.setData({ favoriteCats: [], missingCount: 0, loading: false });
        return;
      }

      const { page, pageSize } = this.data;
      // 第 1 页重载（进入页面/下拉刷新）从头部切；后续翻页从「已展示条数」处继续。
      // 不能直接用 (page - 1) * pageSize：取消关注会让本地收藏少一条、索引整体前移，
      // 按页码乘出来会跳过一个条目（被取消关注那只后面的猫永远翻不到）
      const start = page === 1 ? 0 : this.data.favoriteCats.length;
      const pagedIds = catIds.slice(start, start + pageSize);

      const { cats, failed } = await getCatsByIds(pagedIds);
      if (failed) {
        // 有 ID 但取不到猫数据：置错误态，让页面显示「加载失败」而不是
        //「还没关注任何猫咪」——后者会让云端故障被完全隐藏
        this.safeSetData({ loading: false, loadError: true });
        return;
      }

      // 关注数与显示数必须分开记账：
      // favoriteCount 是「我关注了几只」（读本地 storage），
      // 而 favoriteCats.length 是「实际取回了几只」。两者不等时，
      // 页面会显示「共 3 只」却只渲染 2 张卡片 —— 用户完全无法理解。
      // 不等的原因是某只猫在 cats 集合里查不到（已硬删除 / 处于 _deleting 中），
      // 云函数静默少返回，前端毫不知情。
      // 故：① 显式算出 missing 数并记录 ② 页面把两个数都如实显示。
      const returnedIds = new Set(cats.map(c => c._id));
      const missingIds = page === 1
        ? catIds.filter(id => !returnedIds.has(id))
        : [];

      const catsWithUrls = await MediaHelper.resolveCatAvatars(cats);


      const sorted = this._sortByFavoritesOrder(catsWithUrls, favoriteIds);
      this._attachFollowInfo(sorted, favoriteIds);

      // 追加时按 _id 去重：取消关注后页码重算、或分页边界重叠时，同一只猫不重复渲染
      const existingIds = new Set(this.data.favoriteCats.map(c => c._id));
      const favoriteCats = page === 1
        ? sorted
        : [...this.data.favoriteCats, ...sorted.filter(c => !existingIds.has(c._id))];

      if (page === 1 && missingIds.length > 0) {
        Logger.warn('favorites', '部分关注的猫咪查不到（可能已被删除）', {
          missing: missingIds,
          asked: catIds.length,
          got: cats.length
        });
      }

      this.safeSetData({
        favoriteCats,
        // missingCount 只统计「第 1 页就已查不到」的条目，翻页时不重复累加
        missingCount: page === 1 ? missingIds.length : this.data.missingCount || 0,
        hasMore: start + pageSize < catIds.length,
        loading: false,
        loadError: false
      });
    } catch (err) {
      Logger.warn('favorites', '加载关注列表失败', { error: err.message });
      this.safeSetData({ loading: false });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingFavorites = false;
      // 排队中的强制重载（force=true 被在途锁挡下）在锁释放后补跑一次。
      // 普通重载不排队：连点防护（loadMore 的 _processingAction/_loadingFavorites 早退）不受影响
      if (this._pendingFavoritesReload) {
        this._pendingFavoritesReload = false;
        if (!this._isUnmounted) this.loadFavorites(true);
      }
    }
  },

  // ==================== 分页 ====================

  async loadMore() {
    // 在途锁双重判定：loadMore 会被 onReachBottom 连续触发，
    // 而本函数同步把 page +1 并发请求，同一页会被追加两遍
    if (!this.data.hasMore || this._processingAction || this._loadingFavorites) return;
    this.setData({ page: this.data.page + 1, loadingMore: true });
    try {
      await this.loadFavorites();
    } finally {
      this.safeSetData({ loadingMore: false });
    }
  },

  // ==================== 关注同步 ====================

  _delayedSync() {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      syncFavoritesToCloud();
      this._syncTimer = null;
    }, 800);
  },

  /**
   * 云端收藏恢复：换设备/清缓存后，把云端收藏合并回本地列表
   * （本地优先，云端独有的 catId 补入并触发列表刷新）
   *
   * @returns {Promise<boolean>} 云端列表是否成功取到。
   *   false 时调用方（onLoad）必须跳过本地→云端对齐，避免误删云端收藏。
   */
  async _restoreCloudFavorites() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'syncFavorites',
        data: { action: 'list' }
      });
      const result = res.result || {};
      if (!result.success) {
        // 业务失败**不能静默 return**：云端未部署 / OPENID 取不到时，
        // 本地 storage 若是空的，页面会显示「还没有关注任何猫咪」——
        // 与「用户真的没关注」完全无法区分，这类问题因此被拖了很久才被发现。
        // 置 _cloudRestoreFailed 让空态渲染成「加载失败」而不是「没关注」。
        Logger.warn('favorites', '云端收藏拉取失败', { error: result.error });
        this.safeSetData({ _cloudRestoreFailed: true });
        // 本地为空时立刻重算一次空态，让用户马上看到错误而非空列表
        if (!this._loadingFavorites) this.loadFavorites(true);
        return false;
      }
      this.safeSetData({ _cloudRestoreFailed: false });

      const cloudIds = result.data?.catIds || [];
      if (cloudIds.length === 0) return true;

      const raw = wx.getStorageSync('favoriteCats') || [];
      const localIds = new Set(
        (Array.isArray(raw) ? this._normalizeFavorites(raw) : []).map(f => f.id)
      );
      const missing = cloudIds.filter(id => !localIds.has(id));
      if (missing.length === 0) return true;

      const merged = missing.map(id => ({ id, time: Date.now() }));
      // 收藏数组约定是「旧 → 新」，故云端恢复的追加到**头部**（旧的在前）
      wx.setStorageSync('favoriteCats', merged.concat(
        Array.isArray(raw) ? raw : []
      ));

      Logger.info('favorites', '云端收藏已恢复', { restored: missing.length });

      // 必须排队而非直接调loadFavorites：onShow 的 loadFavorites 与本方法
      // 几乎同时发起，若此时 loadFavorites 已占锁（在途），
      // 直接调用会被锁挡下静默返回 → 云端恢复的猫永远不显示。
      // 故置排队标记，由 loadFavorites 的 finally 在锁释放后补跑强制重载。
      if (this._loadingFavorites) {
        this._pendingFavoritesReload = true;
      } else {
        this.loadFavorites(true);
      }
      return true;
    } catch (err) {
      Logger.warn('favorites', '云端收藏恢复失败（非致命）', { error: err.message });
      return false;
    }
  },

  // ==================== 导航 ====================

  /** 错误态重试：先重试云端恢复（本地为空时的错误态来自 _cloudRestoreFailed），再重载列表 */
  async onRetry() {
    this.setData({ loadError: false, page: 1, hasMore: true });
    // 本地为空且云端恢复失败时，错误态挂在 _cloudRestoreFailed 上 ——
    // 只重载列表而不重试恢复，重渲染后错误态原样保留，「重新加载」成为死按钮
    const raw = wx.getStorageSync('favoriteCats') || [];
    if (!(Array.isArray(raw) && raw.length)) {
      await this._restoreCloudFavorites();
    }
    this.loadFavorites(true);
  },

  onGoToDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // ==================== 快速取消关注 ====================

  async onQuickUnfavorite(e) {
    const catId = e.currentTarget.dataset.id;
    const catName = e.currentTarget.dataset.name;
    if (!catId || this._processingAction) return;

    const res = await new Promise(resolve => {
      wx.showModal({
        title: '取消关注',
        content: `确定不再关注「${catName || ''}」吗？`,
        confirmText: '确定',
        confirmColor: getApp().globalData.theme === 'dark' ? '#FF8080' : '#E87C7C',
        success: resolve
      });
    });
    if (!res.confirm) return;

    this._processingAction = true;
    wx.showLoading({ title: '处理中…', mask: true });

    try {
      const raw = wx.getStorageSync('favoriteCats') || [];
      const allFavorites = Array.isArray(raw) ? this._normalizeFavorites(raw) : [];
      const favorites = allFavorites.filter(f => f.id !== catId);
      wx.setStorageSync('favoriteCats', favorites);

      wx.cloud.callFunction({
        name: 'syncFavorites',
        data: { action: 'remove', catId }
      }).catch(err => {
        // 云端取消失败必须回滚本地（与 detail 页同口径）：否则下次进页面时
        // _restoreCloudFavorites 会把「云端有、本地没有」的猫合并回来 —— 取消被静默撤销，
        // 用户看到该猫重新出现在列表与计数里，会认为「数据自己回来了」。
        Logger.warn('favorites', '云端同步失败', { error: err.message });
        const latestRaw = wx.getStorageSync('favoriteCats') || [];
        const latest = Array.isArray(latestRaw) ? this._normalizeFavorites(latestRaw) : [];
        if (!latest.some(f => f.id === catId)) {
          latest.push({ id: catId, time: Date.now() });
          wx.setStorageSync('favoriteCats', latest);
        }
        this.loadFavorites(true);
        wx.showToast({ title: '取消失败，请重试', icon: 'none' });
      });

      const favoriteCats = this.data.favoriteCats.filter(c => c._id !== catId);

      // hasMore 按「已展示条数 vs 本地收藏总数」重算，而不是无条件 true：
      // 本地已少一条，硬编码 hasMore:true 会让下次「加载更多」白跑一趟空请求。
      // page 仍置 1（其作用是选择 loadFavorites 的重载/追加分支），
      // 追加起点由 favoriteCats.length 决定，故不会跳条目、也不会重复追加。
      this.safeSetData({
        favoriteCats,
        favoriteCount: favorites.length,
        page: 1,
        hasMore: favoriteCats.length < favorites.length
      });

      wx.hideLoading();
      ErrorHandler.showSuccess('已取消关注');
    } catch (err) {
      wx.hideLoading();
      Logger.warn('favorites', '取消关注失败', { catId, error: err.message });
      ErrorHandler.handle(err, { title: '操作失败' });
    } finally {
      this._processingAction = false;
    }
  },

  // ==================== 分享 ====================

  /**
   * 关注列表是「我」的数据，接收方打开看到的会是**他自己**的关注，
   * 所以分享路径落在首页（而不是关注页）。文案可以带上我的关注数量，
   * 让卡片有具体信息；封面统一用品牌卡（聚合页没有某一张具体的猫图）。
   */
  onShareAppMessage() {
    const count = this._shareFavoriteCount();
    const titles = count > 0
      ? [
        `我在校园猫猫关注了 ${count} 只猫，一起来看看`,
        `我的关注列表里有 ${count} 只校园毛孩子`
      ]
      : [
        '校园猫猫 · 校园猫咪图鉴',
        '每一只校园猫咪都值得被记录'
      ];
    const share = { title: ShareHelper.pickTitle(titles), path: '/pages/index/index' };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  onShareTimeline() {
    const count = this._shareFavoriteCount();
    const share = {
      title: count > 0
        ? `我关注的 ${count} 只校园猫咪`
        : '校园猫猫 · 校园猫咪图鉴',
      query: ''
    };
    const imageUrl = this._shareImage();
    if (imageUrl) share.imageUrl = imageUrl;
    return share;
  },

  /** 关注数：优先服务端口径，列表尚未加载时按已加载的算 */
  _shareFavoriteCount() {
    const count = Number(this.data.favoriteCount) || 0;
    return count > 0 ? count : (this.data.favoriteCats || []).length;
  },

  /**
   * 分享图：关注页是「我」的数据聚合，没有某一张具体的猫图；
   * 统一用随机品牌卡，避免把某只关注猫的头像裁成 5:4 大头照。
   */
  _shareImage() {
    return ShareHelper.randomBrandImage();
  },

  // ==================== 辅助函数 ====================

  _sortByFavoritesOrder(cats, favoriteIds) {
    const idOrder = {};
    favoriteIds.forEach((item, idx) => { idOrder[item.id] = idx; });
    return cats
      .filter(cat => cat && cat._id)
      .sort((a, b) => (idOrder[a._id] ?? 999) - (idOrder[b._id] ?? 999));
  },

  _attachFollowInfo(cats, favoriteIds) {
    const favMap = {};
    favoriteIds.forEach(item => { favMap[item.id] = item.time; });
    cats.forEach(cat => {
      cat._followDuration = this._formatFollowDuration(favMap[cat._id] || null);
    });
  },

  _formatFollowDuration(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = now - ts;
    const days = Math.floor(diff / 86400000);

    if (days < 1) return '今天关注';
    if (days === 1) return '关注1天';
    if (days < 30) return `关注${days}天`;

    const months = Math.floor(days / 30);
    const remainDays = days % 30;
    if (months < 12) {
      return remainDays > 0 ? `关注${months}个月${remainDays}天` : `关注${months}个月`;
    }

    const years = Math.floor(months / 12);
    const remainMonths = months % 12;
    return remainMonths > 0 ? `关注${years}年${remainMonths}个月` : `关注${years}年`;
  },

  stopPropagation() {},

  /**
   * 归一化本地关注列表，并**按 catId 去重**（保留最后一次出现的那条）。
   *
   * 去重是必需的，不是优化：`_restoreCloudFavorites` 把云端独有的 ID 前插到头部、
   * `detail` 页关注是 push 到尾部，两条写入路径都可能在同一只猫上重复写入
   *（例如「云端恢复后又在详情页关注过同一只」）。
   * 原实现不去重 → `favoriteCount` 计入重复项（显示 3），
   * 而 `getCatsByIds` 用 `_.in()` 查询 + 各返回一份 → 列表只有 2 只，
   * 造成「关注 3 只、只显示 2 只」且两个数字自相矛盾。
   */
  _normalizeFavorites(favorites) {
    const list = favorites.map(f => {
      if (typeof f === 'string') return { id: f, time: Date.now() };
      if (f && f.id) return f;
      return null;
    }).filter(Boolean);

    // Map 保插入序、同 key 后写覆盖先写 → 重复项保留最后一次（时间最新）的记录
    const deduped = new Map();
    list.forEach(item => deduped.set(item.id, item));
    return Array.from(deduped.values());
  }
});

function syncFavoritesToCloud() {
  const raw = wx.getStorageSync('favoriteCats') || [];
  const favorites = Array.isArray(raw) ? raw : [];
  if (!favorites.length) return;

  const catIds = favorites.map(f => typeof f === 'string' ? f : f.id).filter(Boolean);
  const signature = catIds.slice().sort().join(',');

  // 签名未变就不发：这是「以本地为准」的**全量写**（云端有而本地没有的会被真实删除），
  // 比读贵得多。进入收藏页会固定触发一次（_delayedSync 800ms 后），
  // 用户只是反复进出页面时本地没有任何变化 —— 那一次全量写纯属浪费。
  // 变化来源（关注/取关成功）都会重新走 _delayedSync，届时签名已变，不会被吞掉。
  if (signature === wx.getStorageSync(FAV_SYNC_SIG_KEY)) return;
  if (pendingFavoriteSyncSignatures.has(signature)) return;
  pendingFavoriteSyncSignatures.add(signature);

  wx.cloud.callFunction({
    name: 'syncFavorites',
    data: { action: 'sync', catIds }
  }).then(res => {
    const result = res && res.result || {};
    if (!result.success || result.data && result.data.warnings) {
      Logger.warn('favorites', '云端收藏未完整同步', {
        error: result.error || result.data && result.data.warnings
      });
      return;
    }
    // 只有服务端确认完整成功才记签名；否则下次进入页面还会重试。
    wx.setStorageSync(FAV_SYNC_SIG_KEY, signature);
  }).catch(err => {
    Logger.warn('favorites', '云端同步失败', { error: err.message });
  }).finally(() => {
    pendingFavoriteSyncSignatures.delete(signature);
  });
}

/**
 * 按 ID 批量取猫。
 *
 * 失败时**不能只返回 []**：空数组与「用户没关注任何猫」在页面上完全同形，
 * 都会渲染「还没关注任何猫咪」。云端未部署 / OPENID 取不到时，
 * 用户看到的是「我的关注是空的」而不是任何错误线索，这类问题极难被发现。
 * 故返回 { cats, failed }，由调用方置loadError 并给出可见提示。
 *
 * @returns {Promise<{cats: Array, failed: boolean}>}
 */
async function getCatsByIds(ids) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'getCatsByIds',
      data: { ids }
    });
    const result = res.result || {};
    if (!result.success) {
      Logger.warn('favorites', '批量查询猫咪失败', { error: result.error });
      return { cats: [], failed: true };
    }
    return { cats: result.data?.cats || [], failed: false };
  } catch (err) {
    Logger.warn('favorites', '批量查询猫咪失败', { error: err.message });
    return { cats: [], failed: true };
  }
}
