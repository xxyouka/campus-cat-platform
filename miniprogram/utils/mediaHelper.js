/**
 * utils/mediaHelper.js - 统一的媒体资源处理工具
 *
 * 合并自 avatarHelper.js + photoUtils.js
 * 统一处理头像选择、URL解析、cloud://临时链接转换
 */

const ImageOptimizer = require('./imageOptimizer');
const imageLoader = require('./imageLoader');
const { Logger } = require('./logger');
const { formatDateShort } = require('./dateFormat');

// 与 imageLoader 的 TEMP_URL_BATCH_SIZE 保持一致（平台单次 getTempFileURL 上限 50）
const FALLBACK_BATCH_SIZE = 50;

/**
 * 临时链接 → 头像最终展示URL
 * 主路径（imageLoader.getTempUrls）与降级路径共用此函数，
 * 避免同一 fileID 在批量成功/失败时返回不同形态的 URL（optimizeImageUrl 对已带 imageMogr2 的 URL 幂等）
 *
 * type 决定尺寸档位：调用方按**实际渲染尺寸**选档，不能一律用 avatar 100x100 ——
 * 首页大头照是 220rpx（@2x/@3x 需 220/330 物理像素），100x100 源图要被放大 2~3 倍，
 * 「优化」反而把图压糊了（2026-10-10 修正）。
 * @param {string} tempFileURL - getTempFileURL 返回的临时链接
 * @param {string} type - 尺寸档位 avatar|thumbnail|gallery|detail（默认 avatar，向后兼容）
 * @returns {string} 优化后的URL；无法优化时回退原值
 */
function toAvatarUrl(tempFileURL, type = 'avatar') {
  if (!tempFileURL) return '';
  return ImageOptimizer.getOptimizedUrl(tempFileURL, type) || tempFileURL;
}

const MediaHelper = {
  selectAvatar(cat) {
    if (!cat) return null;
    if (cat.avatar) return cat.avatar;
    if (cat.images && cat.images.length > 0) return cat.images[0];
    return null;
  },

  async resolveSingleUrl(url, options = {}) {
    if (!url) return '';

    if (url.startsWith('http')) {
      // getAvatarUrl 只接收 url（内部固定头像尺寸 100x100）；options.type 仅对 cloud:// 分支的 optimizeType 生效
      return options.optimize !== false
        ? ImageOptimizer.getAvatarUrl(url)
        : url;
    }

    if (url.startsWith('cloud://')) {
      try {
        const urlMap = await imageLoader.getTempUrls([url], {
          optimizeType: options.type || 'avatar'
        });
        return urlMap[url] || url;
      } catch (err) {
        Logger.error('MediaHelper', '获取临时链接失败', { url, error: err.message });
        return url;
      }
    }

    return url;
  },

  async resolveCatAvatars(cats, existingCats = [], options = {}) {
    if (!cats?.length) return cats;

    // type：头像尺寸档位。默认 avatar（100x100）只为向后兼容 —— 7 处调用方里有 6 处
    // 渲染的是 80~112rpx 小头像（avatar 够用），唯独首页是 220rpx 大头照，必须传
    // 'gallery'（400x400）才够 @2x/@3x 的 220/330 物理像素。见 toAvatarUrl 注释。
    const { photoCountsMap = {}, type = 'avatar' } = options;

    const existingLoadedMap = {};
    existingCats.forEach(cat => {
      if (cat._id) existingLoadedMap[cat._id] = cat.avatarLoaded;
    });

    const needResolve = [];
    const processedCats = cats.map((cat, index) => {
      const avatar = this.selectAvatar(cat);

      if (avatar?.startsWith('cloud://')) {
        needResolve.push({ cat, index, cloudID: avatar });
      }

      return {
        ...cat,
        avatar: avatar,
        // initialName：wxml 不支持 JS 方法调用，头像缺失时占位圈要显示的名字首字符。
        // 在这个全项目猫咪头像的统一出口统一预计算，首页/详情/关注/相遇/排行等页面一次覆盖。
        initialName: (cat.name || '').charAt(0),
        photoCount: photoCountsMap[cat._id] ?? 0,
        updateTime: cat.updateTime ? formatDateShort(cat.updateTime) : ''
      };
    });

    if (needResolve.length === 0) {
      return processedCats.map(cat => ({
        ...cat,
        avatarLoaded: existingLoadedMap[cat._id] ?? false
      }));
    }

    let urlMap = {};
    try {
      urlMap = await imageLoader.getTempUrls(
        needResolve.map(n => n.cloudID),
        { optimizeType: type }
      );
      Logger.info('MediaHelper', '批量获取头像成功', {
        total: needResolve.length,
        success: Object.keys(urlMap).length
      });
    } catch (err) {
      // 降级：分批（每批 ≤50）并行获取，避免整批失败后退化为 N 次串行云调用（N 可达整页 500 条）
      Logger.error('MediaHelper', '批量失败，降级分批获取', err);
      const uniqueIds = [...new Set(needResolve.map(n => n.cloudID))];
      for (let i = 0; i < uniqueIds.length; i += FALLBACK_BATCH_SIZE) {
        const batch = uniqueIds.slice(i, i + FALLBACK_BATCH_SIZE);
        const settled = await Promise.all(batch.map(async (cloudID) => {
          try {
            const res = await wx.cloud.getTempFileURL({ fileList: [cloudID] });
            const item = res.fileList?.[0];
            // 只存原始临时链接，最终形态统一由 toAvatarUrl 决定
            if (item?.status === 0 && item.tempFileURL) return [cloudID, item.tempFileURL];
          } catch (_) { /* 单个失败不影响整体 */ }
          return null;
        }));
        settled.forEach(entry => { if (entry) urlMap[entry[0]] = entry[1]; });
      }
    }

    const urlMapEntries = {};
    needResolve.forEach(n => { urlMapEntries[n.index] = n.cloudID; });

    return processedCats.map((cat, index) => {
      const cloudID = urlMapEntries[index];
      // 统一出口：主路径的 urlMap 已由 imageLoader 按 optimizeType 优化过，这里再套一层是幂等的，
      // 目的是让两条路径必然产出同一形态的头像 URL
      const optimizedUrl = cloudID ? toAvatarUrl(urlMap[cloudID], type) : null;

      let avatar = cat.avatar;
      if (optimizedUrl) {
        avatar = optimizedUrl;
      } else if (cloudID) {
        avatar = cloudID;
      }

      const prevLoaded = existingLoadedMap[cat._id];
      const avatarLoaded = prevLoaded !== undefined ? prevLoaded : false;

      return {
        ...cat,
        avatar,
        _cloudFileID: cloudID || cat.avatar,
        avatarLoaded
      };
    });
  },

  async resolvePhotoUrls(photos, options = {}) {
    const {
      optimizeType = 'gallery',
      keepCloudFileID = false,
      logTag = 'MediaHelper'
    } = options;

    // 同文件其他方法的空值守卫口径：传 null 会直接抛 TypeError。
    // 这里的调用方（photoService / share）恰好都做了 `|| []` 兜底，
    // 属于「靠调用方守规矩」的潜伏缺陷 —— 补上守卫让方法自身自洽。
    if (!Array.isArray(photos)) return photos;

    // 无论成功还是失败，都必须给出可渲染字段：
    // detail.wxml 的 `wx:if="{{item.displayUrl || item._cloudFileID}}"` 在两者都缺失时
    // 会把整格照片隐藏 —— 页面仍显示「3 张」，网格却一张都没有，且无任何错误提示。
    // 兜底为原始 url（cloud:// 交给 lazy-image 的转链/重试链路自愈，http 可直接渲染）。
    const withRenderableUrl = (list) => list.map(p => {
      const result = { ...p, displayUrl: p.displayUrl || p.url };
      if (keepCloudFileID) {
        result._cloudFileID = p._cloudFileID || p.url;
      }
      return result;
    });

    const needConvert = photos.filter(p => p.url?.startsWith('cloud://'));
    if (needConvert.length === 0) return withRenderableUrl(photos);

    try {
      const urlMap = await imageLoader.getTempUrls(
        needConvert.map(p => p.url),
        { optimizeType }
      );

      return photos.map(p => {
        const result = {
          ...p,
          displayUrl: urlMap && urlMap[p.url] || p.url
        };
        if (keepCloudFileID) {
          result._cloudFileID = p.url;
        }
        return result;
      });
    } catch (e) {
      if (logTag) {
        Logger.error(logTag, '获取临时链接失败', e);
      }
      return withRenderableUrl(photos);
    }
  },

  isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.startsWith('http') ||
           url.startsWith('cloud://') ||
           url.startsWith('/') ||
           url.startsWith('wxfile://');
  }
};

module.exports = MediaHelper;
