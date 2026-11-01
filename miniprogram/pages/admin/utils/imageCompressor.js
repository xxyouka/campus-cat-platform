/**
 * utils/imageCompressor.js - 图片压缩工具
 *
 * 提供图片压缩、尺寸调整、质量优化等功能
 * 在上传前压缩图片，减少流量和存储成本
 *
 * @module imageCompressor
 */

const { Logger } = require('../../../utils/logger');

/**
 * 压缩选项
 * @typedef {Object} CompressOptions
 * @property {number} maxWidth - 最大宽度（默认 1920）
 * @property {number} maxHeight - 最大高度（默认 1920）
 * @property {number} quality - 压缩质量 0-100（默认 85）
 * @property {string} format - 输出格式（默认 'jpg'）
 */

/**
 * 默认压缩配置
 */
const DEFAULT_OPTIONS = {
  maxWidth: 1920,
  maxHeight: 1920,
  quality: 85,
  format: 'jpg'
};

/**
 * 压缩图片
 * @param {string} filePath - 图片临时路径
 * @param {CompressOptions} options - 压缩选项
 * @returns {Promise<string>} 压缩后的临时文件路径
 */
async function compressImage(filePath, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  try {
    // 获取原始图片信息
    const imageInfo = await wx.getImageInfo({ src: filePath });
    Logger.info('imageCompressor', '原始图片信息', {
      width: imageInfo.width,
      height: imageInfo.height,
      path: filePath
    });

    const CANVAS_MAX_SIZE = 2048;
    if (imageInfo.width > CANVAS_MAX_SIZE || imageInfo.height > CANVAS_MAX_SIZE) {
      const canvasScale = Math.min(CANVAS_MAX_SIZE / imageInfo.width, CANVAS_MAX_SIZE / imageInfo.height);
      Logger.info('imageCompressor', '大图限制Canvas尺寸', {
        original: `${imageInfo.width}x${imageInfo.height}`,
        canvasScale: canvasScale.toFixed(2)
      });
      imageInfo.width = Math.floor(imageInfo.width * canvasScale);
      imageInfo.height = Math.floor(imageInfo.height * canvasScale);
    }

    let { width, height } = imageInfo;
    const { maxWidth, maxHeight } = config;

    // 如果图片尺寸超过限制，等比例缩放
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.floor(width * ratio);
      height = Math.floor(height * ratio);
    }

    // 如果图片已经很小，不需要压缩
    if (width === imageInfo.width && height === imageInfo.height && config.quality >= 90) {
      Logger.info('imageCompressor', '图片尺寸合适，跳过压缩');
      return filePath;
    }

    // 使用离屏 Canvas 压缩图片
    const compressedPath = await compressWithCanvas(
      filePath,
      imageInfo.width,   // Canvas 用原图尺寸绘制
      imageInfo.height,
      width,             // destWidth 控制输出尺寸
      height,            // destHeight 控制输出尺寸
      config.quality
    );

    // 不要在这里读压缩后的大小：`wx.getFileInfo` 并非所有基础库/平台都可靠
    // （PC 端开发者工具与部分低版本基础库会fail 或返回 undefined），而它只服务于
    // 下面这条日志。此前直接读 `fileStat.size`，一旦 getFileInfo 异常就会抛 TypeError，
    // 被外层 catch 捕获后「压缩失败返回原图」—— 而原图必然超过 1M，于是云函数
    // checkImage 拒绝，表现为**管理员怎么传头像都失败**。
    // 体积校验统一由 compressToLimit 通过 getFileSizeSafe 完成（读不到时返回 Infinity，
    // 按超限处理，不会误放行）。
    Logger.info('imageCompressor', '压缩完成', {
      width,
      height,
      quality: config.quality
    });

    return compressedPath;

  } catch (err) {
    Logger.error('imageCompressor', '压缩失败', err);
    // 压缩失败返回原图
    return filePath;
  }
}

/**
 * 把「挂起型」API 调用包一层超时。
 *
 * 为什么需要：wx.canvasToTempFilePath 在部分环境（PC 端开发者工具、离屏 Canvas 不可用）
 * 会**既不触发 success 也不触发 fail**，直接把 Promise 挂在那里。
 * compressWithCanvas 里的 `await new Promise(...)` 于是永不 settle，整条
 * compressToLimit 链路死锁 —— 用户界面停在「压缩中...」的 loading 遮罩，
 * 既不报错也不返回，只能杀进程。
 *
 * 注意：这里必须自己 reject，而不是给回调补 fail —— 回调不来的时候没有任何代码在跑。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} 超时（${ms}ms），该环境可能不支持离屏 Canvas`));
    }, ms);
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 单步操作的超时上限。
 * 真机压缩一张图通常在 1-3 秒内完成（含大图首次解码），给到 15 秒足够宽松，
 * 又能保证「无限挂起」不会变成「界面永久卡死」。
 */
const CANVAS_STEP_TIMEOUT = 15000;

/**
 * 使用离屏 Canvas 压缩图片（不依赖页面 WXML 节点）
 * Canvas 用原图尺寸绘制，通过 destWidth/destHeight 控制输出尺寸
 * @private
 */
async function compressWithCanvas(filePath, srcWidth, srcHeight, destWidth, destHeight, quality) {
  try {
    const canvas = wx.createOffscreenCanvas({
      type: '2d',
      width: srcWidth,
      height: srcHeight
    });
    const ctx = canvas.getContext('2d');

    const img = canvas.createImage();
    await withTimeout(new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = filePath;
    }), CANVAS_STEP_TIMEOUT, '图片解码');

    // 用原图尺寸绘制到 Canvas
    ctx.drawImage(img, 0, 0, srcWidth, srcHeight);

    // 通过 destWidth/destHeight 控制输出尺寸，quality 控制压缩质量
    const res = await withTimeout(new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        width: srcWidth,
        height: srcHeight,
        destWidth: destWidth,
        destHeight: destHeight,
        fileType: 'jpg',
        quality: quality / 100,
        success: resolve,
        fail: reject
      });
    }), CANVAS_STEP_TIMEOUT, 'Canvas 导出');

    return res.tempFilePath;
  } catch (err) {
    // 返回原图而不是 rethrow：本模块的契约是「压缩是增强，不是前置条件」。
    // 此前这里 `throw err`，异常会穿透 compressImage 自己的 catch（那段「压缩失败返回原图」
    // 因此永远不可达），最终让整张照片上传失败 —— 例如 PC 端离屏 Canvas 不可用时。
    Logger.error('imageCompressor', 'OffscreenCanvas 压缩失败，回退原图', err);
    return filePath;
  }
}

/**
 * 批量压缩图片
 * @param {Array<string>} filePaths - 图片路径数组
 * @param {CompressOptions} options - 压缩选项
 * @param {Function} onProgress - 进度回调 (current, total)
 * @returns {Promise<Array<string>>} 压缩后的路径数组
 */
async function compressImages(filePaths, options = {}, onProgress) {
  const results = [];
  const total = filePaths.length;

  for (let i = 0; i < filePaths.length; i++) {
    try {
      const compressed = await compressImage(filePaths[i], options);
      results.push(compressed);

      if (typeof onProgress === 'function') {
        onProgress(i + 1, total);
      }
    } catch (err) {
      Logger.error('imageCompressor', `压缩第 ${i + 1} 张失败`, err);
      // 失败时使用原图
      results.push(filePaths[i]);
    }
  }

  return results;
}

/**
 * 获取压缩配置（根据网络类型）
 * @returns {CompressOptions}
 */
function getCompressConfigByNetwork() {
  return new Promise((resolve) => {
    // 官方仅提供异步 wx.getNetworkType（getNetworkTypeSync 不存在，真机会抛错走默认配置）
    wx.getNetworkType({
      success: (res) => resolve(_configForNetwork(res.networkType)),
      fail: () => resolve(DEFAULT_OPTIONS)
    });
  });
}

function _configForNetwork(networkType) {
  {
    switch (networkType) {
      case 'wifi':
        // WiFi 使用较高质量
        return { maxWidth: 1920, maxHeight: 1920, quality: 90 };
      case '4g':
        // 4G 使用标准质量
        return { maxWidth: 1600, maxHeight: 1600, quality: 85 };
      case '3g':
      case '2g':
        // 弱网使用较低质量
        return { maxWidth: 1280, maxHeight: 1280, quality: 75 };
      default:
        return DEFAULT_OPTIONS;
    }
  }
}

/**
 * 智能压缩（自动根据网络选择配置）
 * @param {string} filePath - 图片路径
 * @returns {Promise<string>} 压缩后的路径
 */
async function smartCompress(filePath) {
  const config = await getCompressConfigByNetwork();
  Logger.info('imageCompressor', '智能压缩配置', config);
  return compressImage(filePath, config);
}

/**
 * 读取文件字节数；读不到时返回 Infinity（未知大小一律当作超限，交由下一档继续压）
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getFileSizeSafe(filePath) {
  return new Promise((resolve) => {
    if (typeof wx.getFileInfo !== 'function') {
      resolve(Infinity);
      return;
    }
    wx.getFileInfo({
      filePath,
      success: (res) => resolve(typeof res.size === 'number' ? res.size : Infinity),
      fail: () => resolve(Infinity)
    });
  });
}

/**
 * 压到指定字节上限以内（多档递减，逐档实测字节数，达标即停）
 *
 * 为什么需要：云函数 checkImage 用 imgSecCheck v2 校验服务端下载的实际字节数，
 * **超过 1M 一律拒绝**（IMAGE_MAX_BYTES）。而「1920px / quality 85」这类常规压缩
 * 对高频细节图常常仍大于 1M，于是压缩做了、上传仍被拒，且失败发生在文件已落盘之后。
 * 这里按「尺寸 + 质量」两维递减，直到实测字节数达标或档位用尽。
 *
 * @param {string} filePath - 原始临时文件路径
 * @param {number} maxBytes - 字节上限
 * @returns {Promise<{path: string, size: number, withinLimit: boolean}>}
 */
async function compressToLimit(filePath, maxBytes) {
  const hasFileInfo = typeof wx.getFileInfo === 'function';

  const attempts = [
    { maxWidth: 1600, maxHeight: 1600, quality: 75 },
    { maxWidth: 1200, maxHeight: 1200, quality: 70 },
    { maxWidth: 1024, maxHeight: 1024, quality: 65 }
  ];

  let currentPath = filePath;
  let currentSize = await getFileSizeSafe(filePath);

  // 原图本身就够小：不必做任何处理（getFileInfo 不可用时不走这条，避免「读不到大小 = 合规」的误判）
  if (hasFileInfo && currentSize <= maxBytes) {
    return { path: currentPath, size: currentSize, withinLimit: true };
  }

  for (const options of attempts) {
    // 单档压缩失败不终止：compressImage 内部已保证退回原图，继续试下一档
    const compressed = await compressImage(currentPath, options);
    const size = await getFileSizeSafe(compressed);

    if (size <= maxBytes) {
      Logger.info('imageCompressor', '已达到体积上限', { quality: options.quality, size });
      return { path: compressed, size, withinLimit: true };
    }

    Logger.warn('imageCompressor', '压缩后仍超限，继续降档', { quality: options.quality, size, maxBytes });
    currentPath = compressed;
    currentSize = size;
  }

  // 档位用尽仍超限：返回最后一档结果（已是过程中最小的一版），由调用方决定是否继续上传
  return { path: currentPath, size: currentSize, withinLimit: false };
}

module.exports = {
  compressImage,
  compressImages,
  smartCompress,
  compressToLimit,
  getCompressConfigByNetwork,
  DEFAULT_OPTIONS
};
