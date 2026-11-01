/**
 * utils/imageOptimizer.js - 图片优化工具
 *
 * 提供图片压缩、格式转换、缩略图生成等功能
 * 支持微信小程序云存储图片处理
 */

/**
 * imageMogr2 是腾讯云数据万象处理参数，仅对 cloud:// 与 TCB 临时域名有效；
 * 第三方图床拼参数只会得到错误 URL。历史上只认 https:// 会让遗留的 http:// TCB 直链静默返回全尺寸原图，
 * 故这里显式同时接受 http:// 与 https://
 */
const TCB_TEMP_URL_RE = /^https?:\/\/[\w-]+\.tcb\.qcloud\.la\//;

function isOptimizableUrl(url) {
  if (typeof url !== 'string') return false;
  return url.startsWith('cloud://') || TCB_TEMP_URL_RE.test(url);
}

class ImageOptimizer {
  /**
   * 优化图片URL，添加压缩和格式参数
   * @param {string} url - 原始图片URL
   * @param {Object} options - 优化选项
   * @param {number} options.width - 宽度（默认 300）
   * @param {number} options.height - 高度（默认 300）
   * @param {number} options.quality - 质量 0-100（默认 80）
   * @param {string} options.format - 格式 jpg/png/webp（默认 jpg）
   * @param {boolean} options.isThumbnail - 是否缩略图（默认 false）
   * @returns {string} 优化后的URL
   *
   * @example
   * const optimizedUrl = ImageOptimizer.optimizeImageUrl('cloud://xxx.jpg', {
   *   width: 400,
   *   height: 400,
   *   quality: 85,
   *   format: 'webp'
   * })
   */
  static optimizeImageUrl(url, options = {}) {
    if (!url) {
      return url;
    }

    if (!isOptimizableUrl(url)) {
      return url;
    }

    if (url.includes('imageMogr2')) {
      return url;
    }

    const {
      width = 300,
      height = 300,
      quality = 80,
      format = 'jpg'
    } = options;

    // 数据万象的参数分隔符是 "/"（单个 imageMogr2 请求内的多个操作），
    // "|" 是「多请求管道」操作符：每段都必须自带 imageMogr2/ 前缀，否则只有第一段生效
    // （实测：`imageMogr2/format/webp|quality/85|thumbnail/100x100>` 返回 136010B 全尺寸原图，
    //  改成 `imageMogr2/thumbnail/100x100>/format/webp/quality/85` 后为 2344B）
    // thumbnail 必须放在首位：先缩放再转码，否则先转码仍按原图尺寸编解码，起不到减小体积的作用
    const params = `thumbnail/${width}x${height}>/format/${format}/quality/${quality}`;

    // 云存储临时链接自带 ?sign=xxx&t=xxx，直接再拼 "?" 会让 imageMogr2 落进上一个参数的值里，
    // 导致处理参数失效（甚至取图失败），因此已有查询串时用 "&" 追加
    const separator = url.includes('?') ? '&' : '?';

    return `${url}${separator}imageMogr2/${params}`;
  }

  /**
   * 获取头像优化URL
   * @param {string} url - 头像URL
   * @returns {string} 优化后的头像URL
   */
  static getAvatarUrl(url) {
    return this.optimizeImageUrl(url, {
      width: 100,
      height: 100,
      quality: 85,
      format: 'webp'
    });
  }

  /**
   * 获取缩略图URL
   * @param {string} url - 图片URL
   * @returns {string} 缩略图URL
   */
  static getThumbnailUrl(url) {
    return this.optimizeImageUrl(url, {
      width: 200,
      height: 200,
      quality: 80,
      format: 'webp',
      isThumbnail: true
    });
  }

  /**
   * 获取相册图片URL
   * @param {string} url - 相册图片URL
   * @returns {string} 优化后的相册图片URL
   */
  static getGalleryUrl(url) {
    return this.optimizeImageUrl(url, {
      width: 400,
      height: 400,
      quality: 85,
      format: 'webp'
    });
  }

  /**
   * 获取详情页图片URL
   * @param {string} url - 详情页图片URL
   * @returns {string} 高清图片URL
   */
  static getDetailUrl(url) {
    return this.optimizeImageUrl(url, {
      width: 600,
      height: 600,
      quality: 90,
      format: 'jpg'
    });
  }

  /**
   * 获取分享卡片图 URL（微信聊天/朋友圈卡片建议 5:4）
   *
   * 与 optimizeImageUrl 的关键差异：**替换**已存在的 imageMogr2 段，而不是幂等跳过——
   * 页面展示用的头像档（100×100 / 400×400）直接当分享图，会被微信卡片放大成糊图
   * （2026-10-12 反馈：详情页分享「超级糊」）。
   * 仅对 TCB 链接生效；第三方直链原样返回。
   * @param {string} url - 已解析的图片链接（可能已带旧 imageMogr2 参数）
   * @returns {string} 分享图 URL（thumbnail/800x640> + jpg，兼容分享卡片）
   */
  static getShareUrl(url) {
    if (!url) return url;
    if (!isOptimizableUrl(url)) return url;

    // 先剥掉旧 imageMogr2 段（连带其前导 ? 或 &）：不剥的话数据万象只认第一个
    // 尺寸参数，800x640 会被旧参数挡掉——这正是分享图糊的根因
    const cleaned = url.replace(/[?&]imageMogr2[^&]*/, '');
    const separator = cleaned.includes('?') ? '&' : '?';
    return `${cleaned}${separator}imageMogr2/thumbnail/800x640>/format/jpg/quality/85`;
  }

  /**
   * 按类型优化单个图片URL（类型分发的统一入口）
   * @param {string} url - 图片URL
   * @param {string} type - 优化类型: avatar|thumbnail|gallery|detail（非法值回退 thumbnail）
   * @returns {string} 优化后的URL
   */
  static getOptimizedUrl(url, type = 'thumbnail') {
    const optimizer = {
      avatar: this.getAvatarUrl.bind(this),
      thumbnail: this.getThumbnailUrl.bind(this),
      gallery: this.getGalleryUrl.bind(this),
      detail: this.getDetailUrl.bind(this)
    }[type] || this.getThumbnailUrl.bind(this);

    return optimizer(url);
  }

  /**
   * 批量优化图片URL
   * @param {string[]} urls - 图片URL数组
   * @param {string} type - 优化类型: avatar|thumbnail|gallery|detail
   * @returns {string[]} 优化后的URL数组
   */
  static optimizeBatch(urls, type = 'thumbnail') {
    if (!Array.isArray(urls)) return [];

    return urls.map(url => this.getOptimizedUrl(url, type));
  }

  /**
   * 检查图片URL是否需要优化
   *
   * 注意判定口径与 optimizeImageUrl 不同，二者刻意不共用：
   * 本方法只看「URL 形态上是否还没带 imageMogr2」，对第三方域名（如 https://example.com/x.jpg）
   * 也返回 true；而 optimizeImageUrl 受 isOptimizableUrl 限制，对第三方域名会原样返回。
   * 因此**不要**写成 `if (needsOptimization(u)) u = optimizeImageUrl(u)` 期待一定生效——
   * 该分支对第三方域名是空操作。本方法目前无生产调用方。
   * @param {string} url - 图片URL
   * @returns {boolean} 是否需要优化
   */
  static needsOptimization(url) {
    if (!url) return false;
    // 历史 http:// 直链同样需要优化（与 optimizeImageUrl 的域名判定保持一致）
    const isValidUrl = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('cloud://');
    if (!isValidUrl) return false;
    return !url.includes('imageMogr2');
  }

  /**
   * 获取图片信息（用于预加载）
   * @param {string} url - 图片URL
   * @returns {Promise<Object>} 图片信息
   */
  static async getImageInfo(url) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: url,
        success: resolve,
        fail: reject
      });
    });
  }

  /**
   * 预加载图片到缓存
   * @param {string[]} urls - 要预加载的图片URL
   */
  static preloadImages(urls) {
    if (!Array.isArray(urls)) return;

    urls.forEach(url => {
      if (url) {
        this.getImageInfo(url).catch(() => {
          // 静默失败，不影响主流程
        });
      }
    });
  }

  // 说明：原 loadImageWithRetry / batchLoadWithRetry 已删除。
  // 它们直接用 wx.cloud.getTempFileURL 取链接、返回的 URL 不含任何 imageMogr2 尺寸参数，
  // 任何调用方都会静默绕过 imageLoader 的尺寸档位与缓存（全量 grep 确认无调用方）。
  // 需要「取云文件临时链接」请统一走 utils/imageLoader.getTempUrls / getSingleTempUrl。
}

module.exports = ImageOptimizer;