/**
 * utils/imageRetryManager.js - 图片重试管理器（**全仓唯一的图片重试实现**）
 *
 * 从 index.js 提取的图片加载失败重试逻辑：指数退避 + 并发控制。
 *
 * 【单一事实源】重试策略只有这一处定义（RETRY_POLICY）。utils/imageLoader.js
 * 曾同时存在 MAX_RETRIES / RETRY_DELAY_BASE / RETRY_DELAY_MAX（1000ms/5000ms），
 * 与这里的 800ms/2 次互相矛盾；那套常量随 load() 删除后已全仓零引用，
 * 由 QA-4 删除。改策略请只改 RETRY_POLICY。
 */
const { Logger } = require('./logger');
const imageLoader = require('./imageLoader');
const { safePageSetData } = require('./safePageSetData');

const RETRY_POLICY = Object.freeze({
  MAX_CONCURRENT_RETRIES: 3,
  BASE_RETRY_DELAY: 800,
  MAX_RETRY_ATTEMPTS: 2
});

const MAX_CONCURRENT_RETRIES = RETRY_POLICY.MAX_CONCURRENT_RETRIES;
const BASE_RETRY_DELAY = RETRY_POLICY.BASE_RETRY_DELAY;
const MAX_RETRY_ATTEMPTS = RETRY_POLICY.MAX_RETRY_ATTEMPTS;

class ImageRetryManager {
  constructor() {
    this._retryQueue = {};
    this._retryTimers = {};
  }

  /**
   * @param {string} catId - 猫咪 ID
   * @param {string} cloudFileID - cloud:// 文件ID
   * @param {object} pageContext - 页面上下文
   * @param {string} [optimizeType='avatar'] - 尺寸档位，必须与该页面首屏解析用的档位一致，
   *   否则重试成功会把已经清晰的头像替换成 100x100 的糊图（「同一页面里两张图清晰度不同」）。
   *   首页大头照（220rpx）传 'gallery'。
   */
  handleError(catId, cloudFileID, pageContext, optimizeType = 'avatar') {
    if (!cloudFileID || !cloudFileID.startsWith('cloud://')) return;
    if (this._retryQueue[catId]) return;

    const activeRetries = Object.keys(this._retryQueue).filter(k => this._retryQueue[k] !== true).length;
    if (activeRetries >= MAX_CONCURRENT_RETRIES) {
      Logger.info('ImageRetry', '重试队列已满，跳过', { catId });
      return;
    }

    this._retryQueue[catId] = { attempt: 0, maxAttempt: MAX_RETRY_ATTEMPTS };
    this._scheduleRetry(catId, cloudFileID, pageContext, optimizeType);
  }

  _scheduleRetry(catId, cloudFileID, pageContext, optimizeType = 'avatar') {
    const state = this._retryQueue[catId];
    if (!state) return;

    state.attempt++;
    const delay = BASE_RETRY_DELAY * Math.pow(2, state.attempt - 1);

    Logger.info('ImageRetry', '调度图片重试', { catId, attempt: state.attempt, delay });

    this._retryTimers[catId] = setTimeout(async () => {
      try {
        // 统一走 imageLoader：与首屏解析同一套转链 + 同一种尺寸档位，
        // 避免重试成功后推给 <image> 的仍是不带尺寸参数的原图直链，
        // 或档位不一致导致「重试过的图反而更糊」。
        // force: true 是重试能生效的前提——读穿缓存会拿回与失败前完全相同的 URL，
        // setData 值未变 → <image src> 不变 → 不会重新发起请求，重试沦为空操作
        const urlMap = await imageLoader.getTempUrls([cloudFileID], {
          optimizeType,
          force: true
        });
        const tempFileURL = urlMap[cloudFileID];
        if (tempFileURL) {
          // 写回新的头像 URL 本身就足以触发重渲染（值必然与失败前不同），无需额外的版本号字段
          this._updateCatAvatar(catId, tempFileURL, false, pageContext);
          delete this._retryQueue[catId];
          delete this._retryTimers[catId];
          return;
        }
      } catch (err) {
        Logger.warn('ImageRetry', `头像重试失败 (第${state.attempt}次)`, { error: err.message });
      }

      if (state.attempt < state.maxAttempt) {
        this._scheduleRetry(catId, cloudFileID, pageContext, optimizeType);
      } else {
        Logger.warn('ImageRetry', '头像重试已耗尽最大次数', { catId, maxAttempt: state.maxAttempt });
        delete this._retryQueue[catId];
        delete this._retryTimers[catId];
      }
    }, delay);
  }

  _updateCatAvatar(catId, avatar, avatarLoaded, pageContext) {
    // 调用方可能是无 cats/filteredCats 列表的页面（如详情页），直接 findIndex 会抛 TypeError 中断重试
    const cats = Array.isArray(pageContext.data.cats) ? pageContext.data.cats : [];
    const filtered = Array.isArray(pageContext.data.filteredCats) ? pageContext.data.filteredCats : [];
    const catsIdx = cats.findIndex(c => c._id === catId);
    const filteredIdx = filtered.findIndex(c => c._id === catId);

    const patch = {};
    if (catsIdx !== -1) {
      patch[`cats[${catsIdx}].avatar`] = avatar;
      patch[`cats[${catsIdx}].avatarLoaded`] = avatarLoaded;
    }
    if (filteredIdx !== -1) {
      patch[`filteredCats[${filteredIdx}].avatar`] = avatar;
      patch[`filteredCats[${filteredIdx}].avatarLoaded`] = avatarLoaded;
    }

    if (Object.keys(patch).length > 0) {
      // 必须走 safePageSetData：本方法在 await（force 转链）之后执行，
      // 页面可能已销毁 —— cleanup() 只能清掉尚未触发的定时器，拦不住
      // 已在 await 中的续体；在已销毁 Page 上裸 setData 部分基础库会抛错。
      safePageSetData(pageContext, patch);
    }
  }

  // 说明：原 _refreshCatImage 已删除。它靠 _avatarVersion 触发重渲染，但：
  // 1) 全仓 .wxml 没有任何 _avatarVersion 绑定（列表渲染的是 filteredCats，写进 cats[...] 也不会被用到）；
  // 2) 它写入的 avatar 还是 setData 之前的旧值，反而可能把刚推的新链接覆盖回去。
  // 重试真实生效依靠 _updateCatAvatar 写入的新 URL（force 转链后带新签名的链接），
  // <image src> 变化即可触发重新请求。

  cleanup() {
    Object.keys(this._retryTimers).forEach(catId => {
      try { clearTimeout(this._retryTimers[catId]); } catch (_e) { /* ignore cleanup errors */ }
    });
    this._retryQueue = {};
    this._retryTimers = {};
  }

  getTimers() {
    return this._retryTimers;
  }
}

module.exports = new ImageRetryManager();
// 策略以只读形式挂在单例上：便于测试断言与文档引用，
// 又不会变成第二个可写的事实源（Object.freeze）。
module.exports.RETRY_POLICY = RETRY_POLICY;
