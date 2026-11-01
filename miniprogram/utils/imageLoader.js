/**
 * utils/imageLoader.js - 高级图片加载管理器
 *
 * 功能：
 * 1. 云存储临时链接批量转换（50/批）
 * 2. 转链结果的缓存读穿（按「fileID@尺寸档位」分键）
 * 3. 图片预加载与缓存观测
 * 4. 加载状态追踪
 *
 * 【图片失败重试不在本文件】唯一实现见 utils/imageRetryManager.js。
 * 原先这里另有 MAX_RETRIES / RETRY_DELAY_BASE / RETRY_DELAY_MAX 三个常量，
 * 是 load() / preload() 的退避参数；那些方法连同其私有辅助已于「代码清理」轮
 * 删除（见下方说明），常量却留了下来 —— 于是仓库里同时存在两套互相矛盾的
 * 退避数值（本文件 1000ms/5000ms、imageRetryManager 800ms/2 次），且本文件那套
 * 全仓零引用。QA-4 已删除这三个僵尸常量；改重试策略请只动 imageRetryManager 的
 * RETRY_POLICY，避免再次分叉。
 */

const { Logger } = require('./logger');
const ImageOptimizer = require('./imageOptimizer');

// 配置常量
const IMAGE_LOADER_CONFIG = {
  LOAD_TIMEOUT: 10000,
  PLACEHOLDER_COLORS: [
    '#E8927C', '#D4765E', '#C4A77D', '#FF8E72',
    '#F5B041', '#82E0AA', '#5DADE2', '#BB8FCE'
  ],
  PLACEHOLDER_COLORS_DARK: [
    '#F5A593', '#E89480', '#D4B896', '#FFA888',
    '#FFC870', '#90F0B8', '#70B8F0', '#D0A0F8'
  ],
  CACHE_PREFIX: 'img_cache_',
  // 缓存按「fileID@尺寸档位」读穿使用：一次预热可能有 50~200 条（整页头像/相册封面、map marker），
  // 50 的容量会被单次批量预热（FIFO 逐出最旧条目）冲掉后续依赖的条目，故放宽到 300
  CACHE_MAX_SIZE: 300,
  CACHE_MAX_AGE: 24 * 60 * 60 * 1000,

  // ===== 跨会话持久化（2026-10-15，加载速度方案 §4）=====
  // 内存缓存冷启动即空 → 重复访客每次打开都要把首屏头像重新转链一遍（1 次批量 RPC，
  // 150~300ms）。把「首屏档位」的少量条目落盘，冷启动懒加载回内存。
  PERSIST_KEY: 'img_temp_url_cache_v1',
  // 只存首屏规模：40 条 × 约 200B ≈ 8KB，远低于存储上限，也不会拖慢 setStorage
  PERSIST_MAX_ENTRIES: 40,
  // **硬约束**：必须严格小于请求侧的 maxAge（24h，见 _requestBatch），否则会拿到过期链接
  PERSIST_TTL: 12 * 60 * 60 * 1000,
  // 只持久化首屏档位；detail 是「保存原图」这类低频路径，没必要占存储
  PERSIST_TYPES: ['avatar', 'thumbnail', 'gallery']
};

// 合法的尺寸档位白名单：key 与转链参数都必须用归一化后的值
const OPTIMIZE_TYPES = ['avatar', 'thumbnail', 'gallery', 'detail'];
const DEFAULT_OPTIMIZE_TYPE = 'avatar';

// 单次 getTempFileURL 的文件数上限（平台限制 50），与 mediaHelper 的降级分批口径一致
const TEMP_URL_BATCH_SIZE = 50;

class ImageLoader {
  constructor() {
    // _loadingImages / _failedImages 只作为 getStats()/cleanup() 的观测与清理面保留
    this._loadingImages = new Map();
    this._imageCache = new Map();
    this._failedImages = new Set();
    // 在途转链批次：`fileID@档位` → 该批次的 Promise。并发命中同一文件时复用它，
    // 而不是各发一次 RPC（见 getTempUrls 的并发去重说明）
    this._inflight = new Map();
    this._loadStats = { total: 0, success: 0, failed: 0, fromCache: 0, retried: 0 };
    this._cleanupPaused = false;
    // 落盘缓存的会话内镜像：懒加载（第一次读缓存时才读存储，不在启动路径上读盘）
    this._persistLoaded = false;
    this._persistStore = null;
  }

  // 说明：原 load() / preload() / batchLoad() 及其私有辅助（_loadWithTimeout、_handleLoadSuccess、
  // _handleLoadError、_createPlaceholderResult、_createErrorResult 等）已删除。
  // 它们用「裸 src」当缓存 key，与 getTempUrls 的「fileID@档位」是两套互不命中的 key 空间
  // （preload 的 _imageCache.has(url) 恒为 false），且全仓库（含测试）无任何调用方。
  // 云文件的加载统一走 getTempUrls / getSingleTempUrl / getTempUrl。

  /**
   * 归一化「尺寸档位 + 是否压缩」，作为缓存 key 与转链参数的唯一来源
   * key 与值必须同源，否则会出现「拿到原图却写进 @avatar 键」的错配
   * @param {string} optimizeType - 尺寸档位 avatar|thumbnail|gallery|detail（大小写/未知值一律回退 avatar）
   * @param {boolean} optimize - 只有显式 false 才关闭压缩（null/undefined 等 falsy 值按开启处理）
   * @returns {{suffix: string, optimize: boolean, optimizeType: string}}
   */
  _resolveVariant(optimizeType, optimize) {
    const useOptimize = optimize !== false;
    const type = OPTIMIZE_TYPES.includes(optimizeType) ? optimizeType : DEFAULT_OPTIMIZE_TYPE;
    return { suffix: useOptimize ? type : 'raw', optimize: useOptimize, optimizeType: type };
  }

  /**
   * 计算缓存 key
   * 临时链接与尺寸档位一一对应，key 必须带上尺寸维度：
   * 否则同一 fileID 先以 thumbnail 请求、再以 gallery 请求时会命中前者的 200px 缩略图
   * @param {string} src - 图片地址 / 云文件ID
   * @param {{suffix: string}} variant - _resolveVariant 的返回值
   * @returns {string} 缓存 key，形如 `cloud://xxx@gallery`
   */
  _cacheKey(src, variant) {
    return `${src}@${variant.suffix}`;
  }

  _setCache(src, data) {
    try {
      if (this._imageCache.size >= IMAGE_LOADER_CONFIG.CACHE_MAX_SIZE) {
        const oldestKey = this._imageCache.keys().next().value;
        this._imageCache.delete(oldestKey);
      }
      this._imageCache.set(src, { ...data, cachedAt: Date.now() });
    } catch (_e) { /* ignore cache write errors */ }
  }

  _getFromCache(src) {
    this._ensurePersistedLoaded();
    const cached = this._imageCache.get(src);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > IMAGE_LOADER_CONFIG.CACHE_MAX_AGE) { this._imageCache.delete(src); return null; }
    // LRU：命中后移到队尾，避免热条目被后续批量预热按插入顺序逐出
    this._imageCache.delete(src);
    this._imageCache.set(src, cached);
    return cached;
  }

  /**
   * 按 fileID 清掉该文件的全部尺寸档位缓存
   * key 形如 `fileID@档位`，按 fileID 精确匹配一个都删不掉，必须按前缀清
   * @param {string} [fileID] - 云文件ID；不传则清空全部缓存（等价 clearAll）
   */
  clearCache(fileID = null) {
    if (!fileID) return this.clearAll();
    const prefix = `${fileID}@`;
    for (const key of [...this._imageCache.keys()]) {
      if (key.startsWith(prefix)) this._imageCache.delete(key);
    }
    this._purgePersisted(prefix);
  }

  /**
   * 清空全部缓存
   */
  clearAll() {
    this._imageCache.clear();
    this._purgePersisted(null);
  }

  // ==================== 跨会话持久化（首屏档位） ====================

  /**
   * 懒加载落盘的转链结果到内存缓存（每个会话只读一次存储）。
   *
   * 过期条目（超过 PERSIST_TTL）在读取时丢弃 —— 绝不把可能失效的链接交给 <image>。
   * 万一仍有链接在有效期内被回收（云存储侧失效），失败会走既有的自愈链路：
   * lazy-image 重试 + imageRetryManager 的 force 重试会重新转链。
   */
  _ensurePersistedLoaded() {
    if (this._persistLoaded) return;
    this._persistLoaded = true;
    try {
      const raw = wx.getStorageSync(IMAGE_LOADER_CONFIG.PERSIST_KEY);
      const entries = raw && raw.entries;
      if (!entries || typeof entries !== 'object') return;
      this._persistStore = entries;
      const now = Date.now();
      for (const key of Object.keys(entries)) {
        const item = entries[key];
        if (!item || !item.src) continue;
        if (now - (item.cachedAt || 0) > IMAGE_LOADER_CONFIG.PERSIST_TTL) continue;
        if (!this._imageCache.has(key)) this._imageCache.set(key, item);
      }
    } catch (_e) {
      // 存储不可用（超限 / 被清）时静默降级：只是少一次加速，不影响任何加载路径
    }
  }

  /**
   * 批量转链成功后落盘一次（不逐张写，避免 setStorage 抖动）。
   * 只存首屏档位（PERSIST_TYPES）；条数上限 PERSIST_MAX_ENTRIES，超出按 cachedAt 淘汰最旧。
   * 写盘失败只影响「下次冷启动的加速」，不影响本次返回结果。
   */
  _persistBatch(batchMap, variant) {
    if (!IMAGE_LOADER_CONFIG.PERSIST_TYPES.includes(variant.suffix)) return;
    try {
      this._ensurePersistedLoaded();
      const store = this._persistStore || (this._persistStore = {});
      const now = Date.now();
      for (const fileID of Object.keys(batchMap)) {
        if (!batchMap[fileID]) continue;
        store[this._cacheKey(fileID, variant)] = {
          success: true,
          src: batchMap[fileID],
          path: batchMap[fileID],
          cachedAt: now,
          isCloudUrl: true,
          optimizeType: variant.optimizeType
        };
      }
      const keys = Object.keys(store);
      const max = IMAGE_LOADER_CONFIG.PERSIST_MAX_ENTRIES;
      if (keys.length > max) {
        keys.sort((a, b) => (store[a].cachedAt || 0) - (store[b].cachedAt || 0));
        keys.slice(0, keys.length - max).forEach(k => { delete store[k]; });
      }
      wx.setStorageSync(IMAGE_LOADER_CONFIG.PERSIST_KEY, { entries: store, savedAt: now });
    } catch (_e) { /* 落盘失败不影响本次结果 */ }
  }

  /**
   * 从落盘缓存里按前缀清（与 clearCache 同口径）。
   * 即使本次会话还没懒加载过，也要先读出来再删：否则下次冷启动会把已作废的链接装回内存。
   * @param {string|null} prefix - `fileID@`；传 null 清空整个落盘缓存
   */
  _purgePersisted(prefix) {
    if (prefix && !this._persistLoaded) this._ensurePersistedLoaded();
    const store = this._persistStore;
    if (!store) return;

    let changed = false;
    for (const key of Object.keys(store)) {
      if (!prefix || key.startsWith(prefix)) { delete store[key]; changed = true; }
    }
    if (!changed) return;

    try {
      if (prefix) wx.setStorageSync(IMAGE_LOADER_CONFIG.PERSIST_KEY, { entries: store, savedAt: Date.now() });
      else wx.removeStorageSync(IMAGE_LOADER_CONFIG.PERSIST_KEY);
    } catch (_e) { /* ignore */ }
  }

  // ==================== 云存储临时链接转换 ====================

  /**
   * 批量获取云文件临时URL（兼容 avatarHelper.js）
   * 缓存读穿：命中「fileID@尺寸档位」直接复用，未命中才发起 getTempFileURL
   *
   * 并发去重：同一 `fileID@档位` 已有一批在途时，本次直接等那批的结果，不再发新请求。
   * 动机是首页首屏的真实竞争：批量转链（resolveCatAvatars）与卡片自身的转链
   *（lazy-image 的渐进式占位）会在同一 tick 内命中同一批 fileID —— 改造前是
   * 每次单文件调用各发一次 RPC（首屏最多 10 次），现在收敛成 1 次批量调用。
   *
   * @param {Array<string>} fileIDs - cloud:// 文件ID列表
   * @param {Object} options
   * @param {string} options.optimizeType - 尺寸档位 avatar|thumbnail|gallery|detail（默认 avatar）
   * @param {boolean} options.optimize - 是否追加 imageMogr2 压缩参数（默认 true；false 返回原图链接）
   * @param {boolean} options.force - 跳过缓存读取、强制重新转链（仍回写缓存）
   *   重试链路必须用 force：读穿缓存会让重试拿回与失败前完全相同的 URL，
   *   setData 值未变 → <image src> 不变 → 根本不会重新发起请求，重试形同空操作。
   *   force 同时不复用在途批次（复用等于又拿回同一个 URL）。
   */
  async getTempUrls(fileIDs, options = {}) {
    if (!fileIDs || !Array.isArray(fileIDs) || fileIDs.length === 0) return {};

    const { optimizeType = 'avatar', optimize = true, force = false } = options;
    // key 与转链参数共用同一份归一化结果（白名单外的档位、null 之类的 falsy optimize 都不会造成错配）
    const variant = this._resolveVariant(optimizeType, optimize);
    const urlMap = {};

    // 统计分母：本次请求涉及的唯一 fileID 数（缓存命中、在途复用与新转链都算一次请求）。
    // total 原先从未被累加 → getStats().successRate 分母恒为 0，监控口径永远 0%。
    const uniqueFileIDs = [...new Set(fileIDs.filter(Boolean))];
    if (uniqueFileIDs.length > 0) this._loadStats.total += uniqueFileIDs.length;

    // 1. 先读缓存，未命中的再拆成「在途可复用」与「本轮实际发起」两拨
    const pending = [];
    const shared = [];
    for (const fileID of uniqueFileIDs) {
      if (!force) {
        const cached = this._getFromCache(this._cacheKey(fileID, variant));
        if (cached && cached.src) {
          urlMap[fileID] = cached.src;
          this._loadStats.fromCache++;
          continue;
        }
        const inflight = this._inflight.get(this._cacheKey(fileID, variant));
        if (inflight) {
          shared.push({ fileID, promise: inflight });
          continue;
        }
      }
      pending.push(fileID);
    }

    // 去重：force 时重复项会造成同一 fileID 重复计费转链
    const uniquePending = [...new Set(pending)];

    if (uniquePending.length > 0) {
      try {
        await this._fetchTempUrlsInBatches(uniquePending, variant, urlMap);
      } catch (error) {
        this._loadStats.failed += uniquePending.length;
        throw error;
      }
    }

    // 2. 等复用的在途批次。失败只记一次失败、不把整包数据一起抛错：
    // 别人那一批转链失败与「本批某几个文件转不出来」是同一种可容忍结果
    //（调用方对缺项本来就有降级：头像退回 cloud://、相册封面标记 _coverUrlFailed）。
    for (const { fileID, promise } of shared) {
      let url = '';
      try {
        const batchMap = await promise;
        url = batchMap && batchMap[fileID] || '';
      } catch (_e) {
        url = '';
      }
      if (url) {
        urlMap[fileID] = url;
        this._loadStats.success++;
      } else {
        this._loadStats.failed++;
      }
    }

    return urlMap;
  }

  /**
   * 按 TEMP_URL_BATCH_SIZE 分批转链，逐批登记「在途」并回写缓存。
   *
   * 登记必须早于 await：晚一个微任务注册，同一 tick 内的第二个调用方就读不到
   * 在途条目、自己再发一次（正是要消除的重复调用）。
   * 清理放在 finally：无论成功、失败还是抛错，都不能把后来的调用方挂在一个
   * 永不结算的 Promise 上。
   */
  async _fetchTempUrlsInBatches(fileIDs, variant, urlMap) {
    for (let i = 0; i < fileIDs.length; i += TEMP_URL_BATCH_SIZE) {
      const batch = fileIDs.slice(i, i + TEMP_URL_BATCH_SIZE);
      const keys = batch.map(id => this._cacheKey(id, variant));
      const batchPromise = this._requestBatch(batch, variant);
      keys.forEach(key => this._inflight.set(key, batchPromise));
      try {
        Object.assign(urlMap, await batchPromise);
      } finally {
        keys.forEach(key => this._inflight.delete(key));
      }
    }
  }

  /**
   * 单批转链：解析响应 → 按档位拼压缩参数 → 回写缓存，返回 `fileID → 优化后 URL`。
   * 失败项不入表（调用方按缺项降级）。统计与缓存写入都只在这里做一次 ——
   * 一批无论被几个调用方复用，都只算一次真实请求。
   */
  _requestBatch(batch, variant) {
    return wx.cloud.getTempFileURL({
      fileList: batch.map(id => ({ fileID: id, maxAge: 24 * 60 * 60 }))
    }).then(res => {
      const batchMap = {};
      if (res.fileList && res.fileList.length > 0) {
        for (const item of res.fileList) {
          if (item.status === 0 && item.tempFileURL) {
            // 关键：按尺寸档位压缩，否则全站拿到的都是原图直链
            const finalUrl = variant.optimize
              ? ImageOptimizer.getOptimizedUrl(item.tempFileURL, variant.optimizeType)
              : item.tempFileURL;
            batchMap[item.fileID] = finalUrl;
            this._loadStats.success++;
            this._setCache(this._cacheKey(item.fileID, variant), {
              success: true, src: finalUrl, path: finalUrl,
              loadedAt: Date.now(), isCloudUrl: true, optimizeType: variant.optimizeType
            });
          } else {
            this._loadStats.failed++;
          }
        }
      }
      // 落盘一次（不逐张写）：下次冷启动直接命中，省掉这一整批 RPC
      this._persistBatch(batchMap, variant);
      return batchMap;
    });
  }

  async getSingleTempUrl(fileID, options = {}) {
    if (!fileID) return '';
    try {
      const urlMap = await this.getTempUrls([fileID], options);
      return urlMap[fileID] || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 获取单个云文件临时URL（兼容 detail.js / share.js / lazy-image.js）
   * 注意：这是 getSingleTempUrl 的别名，保持API兼容性
   */
  async getTempUrl(fileID, options = {}) {
    return this.getSingleTempUrl(fileID, options);
  }

  preloadAboveFold(urls, type = 'avatar') {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return;
    const cloudUrls = urls.filter(url => url?.startsWith('cloud://'));
    if (cloudUrls.length === 0) return;

    this.getTempUrls(cloudUrls, { optimizeType: type })
      .then(() => {})
      .catch(e => Logger.swallow('imageLoader', 'warmupCloudUrls', e));
  }

  /**
   * 预加载下一页/非首屏图片（兼容 index.js）
   * 静默预加载，失败不报错
   * @param {Array<string>} urls - 要预加载的URL列表（通常是 cloud://）
   * @param {string} type - 图片类型 'avatar' | 'gallery'
   */
  preloadBelowFold(urls, type = 'gallery') {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return;

    const cloudUrls = urls.filter(url => url?.startsWith('cloud://'));
    if (cloudUrls.length === 0) return;

    this.getTempUrls(cloudUrls, { optimizeType: type })
      .catch(e => Logger.swallow('imageLoader', 'preloadCloudUrls', e));
  }

  // ==================== 统计与监控 ====================

  getStats() {
    // 成功率 = （新转链成功 + 缓存命中）/ 本次统计周期内的全部请求。
    // 两个口径修正：total 此前从未累加（分母恒 0 → 永远 0%）；
    // 缓存命中也是「成功拿到可用 URL」，必须计入分子。
    const { total, success, fromCache } = this._loadStats;
    const successRate = total > 0
      ? (Math.min(total, success + fromCache) / total * 100).toFixed(1)
      : 0;
    return { ...this._loadStats, successRate: `${successRate}%`, cacheSize: this._imageCache.size, failedCount: this._failedImages.size, loadingCount: this._loadingImages.size };
  }

  resetStats() { this._loadStats = { total: 0, success: 0, failed: 0, fromCache: 0, retried: 0 }; }

  cleanup() {
    for (const [_loadId, info] of this._loadingImages.entries()) { if (info.timeoutId) clearTimeout(info.timeoutId); }
    this._loadingImages.clear();
    this._failedImages.clear();
  }

  /**
   * 暂停清理操作（兼容 app.js）
   * 在页面切换时暂停自动清理，避免误删缓存
   */
  pauseCleanup() {
    this._cleanupPaused = true;
  }

  /**
   * 恢复清理操作（兼容 app.js）
   */
  resumeCleanup() {
    this._cleanupPaused = false;
  }
}

const loader = new ImageLoader();
module.exports = loader;
module.exports.IMAGE_LOADER_CONFIG = IMAGE_LOADER_CONFIG;
