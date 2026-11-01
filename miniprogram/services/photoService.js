// @ts-nocheck — 项目 tsconfig 中 checkJs: false，此标记为冗余
/**
 * services/photoService.js - 照片数据服务
 *
 * 职责：猫咪照片的加载、预取、点赞、预览
 */
const { Logger } = require('../utils/logger');
const { monitorApi } = require('../utils/performanceMonitor');
const imageLoader = require('../utils/imageLoader');
const { formatDateShort } = require('../utils/dateFormat');
const { resolvePhotoUrls } = require('../utils/photoUtils');
const ErrorHandler = require('../utils/errorHandler');
const AvatarHelper = require('../utils/avatarHelper');
const { safePageSetData } = require('../utils/safePageSetData');

// ========== 预取缓存应用辅助（抽到模块级，避免 applyPrefetchCache 复杂度过高）==========

/**
 * 追加照片时按 _id 去重。
 *
 * 预取只缓存 20 条、翻页按 30/页，因此 applyPrefetchCache 会把 photoPage 记 0，
 * 第一次翻页必然重取前 30 条 —— 与预取那 20 条是重叠的。
 * 没有这层去重，前 20 张照片会在网格里各出现两次。
 * 口径同 operation-logs / donation-manage 的翻页去重（都是 skip/limit 窗口位移导致）。
 */
function dedupePhotos(list) {
  const seen = new Set();
  return list.filter(p => {
    // 没有 _id 的条目不去重：宁可重复也不能误删（filter 掉真实照片更严重）
    const key = p && (p._id || p._cloudFileID || p.cloudFileID);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function photoIdentity(photo) {
  return photo && (photo._id || photo._cloudFileID || photo.url || photo.cloudFileID);
}

/**
 * 归一化猫咪的时间字段为短日期展示（原地修改）
 */
function normalizeCatDates(cat) {
  if (cat.updateTime) cat.updateTime = formatDateShort(cat.updateTime);
  if (cat.deceasedTime) cat.deceasedTime = formatDateShort(cat.deceasedTime);
  if (cat.lostTime) cat.lostTime = formatDateShort(cat.lostTime);
}

/**
 * 解析猫咪头像临时链接并写入 _tempAvatarUrl（原地修改）
 * @returns {Promise<string>} 解析后的头像 URL（无头像时为空串）
 */
async function resolveCatAvatarUrl(cat) {
  const fallback = cat.avatar || cat.images?.[0] || '';
  if (!fallback) {
    cat._tempAvatarUrl = '';
    return '';
  }

  const resolved = await AvatarHelper.resolveCatAvatars([cat], []);
  const avatarUrl = resolved[0]?.avatar || fallback;
  cat._tempAvatarUrl = avatarUrl;
  return avatarUrl;
}

/**
 * 预加载首屏照片，并在照片未取全时安排一次后台补齐
 * 定时器句柄挂到页面实例，onUnload 时可清理，避免页面销毁后仍 setData
 */
function schedulePhotoWarmup(page, photos, totalPhotoCount) {
  const list = photos || [];

  const photoIds = list.slice(0, 8)
    .map(p => p._cloudFileID || p.cloudFileID)
    .filter(id => id?.startsWith('cloud://'));
  if (photoIds.length > 0) {
    imageLoader.preloadAboveFold(photoIds, 'gallery');
  }

  // 预取缓存路径的照片来自客户端直读（无 liked 字段）：缺点赞标注时也安排一次后台补齐，
  // 否则秒开路径的心形图标恒为未赞（重进丢态、二次点击误翻）
  const missingLiked = list.some(p => typeof p.liked !== 'boolean');
  if (list.length < (totalPhotoCount || 0) || missingLiked) {
    if (page._fullPhotosTimer) clearTimeout(page._fullPhotosTimer);
    page._fullPhotosTimer = setTimeout(() => {
      page._fullPhotosTimer = null;
      page._loadFullPhotosQuietly();
    }, 500);
  }
}

/**
 * 下载网络图片到本地临时文件
 * wx.saveImageToPhotosAlbum 只接受本地临时文件路径（wxfile:// / http://tmp/…），
 * 直接传网络 URL 必然失败，必须先 downloadFile
 * @param {string} url - 图片网络地址
 * @returns {Promise<string>} 本地临时文件路径
 */
async function downloadToLocalFile(url) {
  const res = await wx.downloadFile({ url });
  // 非 200（含 403 链接过期、404）同样视为失败，否则会把错误页面写进相册
  if (!res || res.statusCode !== 200 || !res.tempFilePath) {
    throw new Error(`下载失败（statusCode: ${res && res.statusCode}）`);
  }
  return res.tempFilePath;
}

module.exports = {
  /**
   * 加载照片列表（分页）
   */
  async loadPhotos(page, reset = false) {
    try {
      const currentPage = reset ? 0 : page.data.photoPage;
      const pageSize = page.data.photoPageSize;
      // 过期守卫：与文件末尾 loadFullPhotosQuietly:185-201 是同一条逻辑的两个副本，
      // 那边已加、这边一直漏。detail 页可在两段 await（云调用 + 转链）期间切换猫咪
      // （点关系猫跳详情）或用户翻页，此时旧响应回来会覆盖新数据。
      const catIdAtStart = page.data.catId;

      if (reset) {
        page.setData({ photos: [], hasMorePhotos: true, loadingMore: false, totalLikes: 0 });
      } else {
        page.setData({ loadingMore: true });
      }

      const res = await monitorApi('detail-getPhotos', () =>
        wx.cloud.callFunction({
          name: 'getPhotosByCat',
          // 服务端页码从 1 开始（photoPage 记录已加载页数，本次请求下一页）
          data: { catId: page.data.catId, page: currentPage + 1, pageSize },
          timeout: 10000
        })
      );

      // 等待期间已切换猫咪或用户已翻页：丢弃本次结果
      if (page.data.catId !== catIdAtStart || (page.data.photoPage || 0) > (reset ? 0 : currentPage)) {
        return;
      }

      const photoData = res.result?.data || res.result || {};
      let newPhotos = photoData.photos || [];
      if (!res.result?.success && (res.result?.error || res.result?.message)) {
        throw new Error(res.result.error || res.result.message);
      }

      newPhotos = newPhotos.map(p => {
        const fileID = p._cloudFileID || p.url || p.cloudFileID;
        return {
          ...p,
          url: p.url || fileID,
          displayUrl: p.displayUrl || p.url || fileID,
          _cloudFileID: fileID,
          createTime: formatDateShort(p.createTime),
          _liked: p.liked === true
        };
      });

      // 先启动同档位批量转链，再下发可渲染的 cloud:// 数据。详情页 lazy-image
      // 关闭渐进双转链后会加入这批在途请求；链接返回后只异步补 displayUrl。
      const resolveUrls = resolvePhotoUrls(newPhotos, { keepCloudFileID: true, logTag: 'detail' });
      const allPhotos = reset ? newPhotos : dedupePhotos([...page.data.photos, ...newPhotos]);

      // 照片卡片/点赞交互先出现，不等 getTempFileURL 往返；转换期间页面可能被复用，
      // 后台补丁还会校验猫咪、记录 ID 和原始 fileID，避免旧链接覆盖新照片。
      safePageSetData(page, {
        photos: allPhotos,
        photoPage: currentPage + 1,
        hasMorePhotos: photoData.hasMore !== false && newPhotos.length === pageSize,
        // 回填服务端照片总数：头部「N 张」不能再用 photos.length（那只是已加载页数）
        photoTotal: typeof photoData.total === 'number' ? photoData.total : page.data.photoTotal
      });
      page._computeTotalLikes(allPhotos);

      resolveUrls.then((resolvedPhotos) => {
        if (page.data.catId !== catIdAtStart) return;
        const resolvedById = new Map((resolvedPhotos || []).map(photo => [photoIdentity(photo), photo]));
        const patchedPhotos = (page.data.photos || []).map(photo => {
          const resolved = resolvedById.get(photoIdentity(photo));
          const currentFileID = photo._cloudFileID || photo.url || photo.cloudFileID;
          const resolvedFileID = resolved && (resolved._cloudFileID || resolved.url || resolved.cloudFileID);
          if (!resolved || !currentFileID || resolvedFileID !== currentFileID) return photo;
          if (!resolved.displayUrl || resolved.displayUrl === photo.displayUrl) return photo;
          return { ...photo, displayUrl: resolved.displayUrl };
        });
        safePageSetData(page, { photos: patchedPhotos });
      }).catch(err => {
        Logger.warn('detail', '照片链接后台解析失败，保留云文件地址供图片组件重试', { error: err.message });
      });

      if (allPhotos.length > 0) {
        const photoIds = allPhotos.slice(0, 8)
          .map(p => p._cloudFileID || p.cloudFileID)
          .filter(id => id?.startsWith('cloud://'));
        if (photoIds.length > 0) imageLoader.preloadAboveFold(photoIds, 'gallery');
      }
    } catch (err) {
      Logger.error('detail', '加载照片失败', err);
      ErrorHandler.handle(err, { title: '加载照片失败' });
    } finally {
      safePageSetData(page, { loadingMore: false });
    }
  },

  /**
   * 应用预取缓存中的照片数据
   */
  async applyPrefetchCache(page, prefetchCache, catId) {
    const { cat, photos, totalPhotoCount } = prefetchCache;
    if (!cat) return false;

    page._photoCountsMap = page._photoCountsMap || {};

    normalizeCatDates(cat);
    await resolveCatAvatarUrl(cat);

    // 预取的 photos 是数据库原始记录（仅 cloud:// url），需转链出 displayUrl 才能渲染，
    // 否则照片格空白，只能靠 500ms 后的补载定时器自愈
    const resolvedPhotos = await resolvePhotoUrls(photos || [], { keepCloudFileID: true, logTag: 'detail-prefetch' });

    page.setData({
      cat, catId,
      updateTime: cat.updateTime || '',
      photos: resolvedPhotos,
      // 记 0 页而不是 1 页：预取只缓存了 20 条，而翻页是 30/页。
      // 记 1 页会让下一次翻页直接要第 2 页（skip=30），**永久跳过第 21~30 条**；
      // 而 hasMorePhotos 仍按总数算出 true，用户只会看到照片凭空少了一截、
      // 没有任何报错。记 0 页后第一次翻页重取前 30 条，重叠部分由 dedupePhotos 去掉。
      photoPage: 0,
      photoTotal: typeof totalPhotoCount === 'number' ? totalPhotoCount : photos?.length || 0,
      hasMorePhotos: (photos?.length || 0) < (totalPhotoCount || Infinity),
      loading: false,
      showSkeleton: false,
      loadingMore: false,
      viewCountDisplay: cat.viewCount >= 1000 ? (cat.viewCount / 1000).toFixed(1) + 'k' : cat.viewCount || 0
    });
    page._computeTotalLikes(resolvedPhotos);

    schedulePhotoWarmup(page, resolvedPhotos, totalPhotoCount);

    return true;
  },

  /**
   * 后台静默加载完整照片列表
   */
  async loadFullPhotosQuietly(page) {
    try {
      // 用户已开始手动翻页（photoPage > 1）时不再整体覆盖，避免列表回退
      if ((page.data.photoPage || 0) > 1) return;
      const catIdAtStart = page.data.catId;

      Logger.info('detail', '开始后台加载完整照片列表');
      const pageSize = page.data.photoPageSize;
      const res = await wx.cloud.callFunction({
        name: 'getPhotosByCat',
        // 服务端页码从 1 开始
        data: { catId: catIdAtStart, page: 1, pageSize }
      });

      const photoData = res.result?.data || res.result || {};
      let newPhotos = photoData.photos || [];
      newPhotos = newPhotos.map(p => ({ ...p, createTime: formatDateShort(p.createTime), _liked: p.liked === true }));
      newPhotos = await resolvePhotoUrls(newPhotos, { keepCloudFileID: true, logTag: 'detail-full' });

      // 等待期间页面已切换猫咪或用户已翻页，丢弃本次结果
      if (page.data.catId !== catIdAtStart || (page.data.photoPage || 0) > 1) return;

      page.setData({
        photos: newPhotos,
        photoPage: 1,
        hasMorePhotos: photoData.hasMore !== false && newPhotos.length === pageSize
      });
      page._computeTotalLikes(newPhotos);
      Logger.info('detail', '后台加载完成', { count: newPhotos.length });
    } catch (err) {
      Logger.warn('detail', '后台加载完整照片失败（非致命）', { error: err.message });
    }
  },

  /**
   * 预览图片（详情页大图按 detail(600px) 档换链，只换当前点开的那一张）
   */
  async onPreviewPhoto(page, e) {
    const index = e.currentTarget.dataset.index;
    const photos = page.data.photos;

    if (!photos || photos.length === 0) return;
    const safeIndex = Math.min(Math.max(index || 0, 0), photos.length - 1);

    // 记录每个可预览项对应的 photos 原下标：无 displayUrl 也无 fileID 的项会被过滤掉，
    // 直接拿 photos 的原下标去取 urls 会「点第 3 张打开第 1 张」
    //
    // displayUrl 在这里是「客户端刚解析出来的 https 链接」（见 mediaHelper.resolvePhotoUrls），
    // 不是库里的字段：云端已不再回填 displayUrl（compressImages 落临时链接会过期，见其注释）。
    // 万一某条只有 fileID（预取未覆盖到），下面会批量换链后再交给 previewImage ——
    // cloud:// 交给 wx.previewImage 是渲染不出来的。
    const entries = [];
    photos.forEach((p, photoIndex) => {
      const url = p.displayUrl || p._cloudFileID || p.cloudFileID;
      if (url) entries.push({ url, photoIndex });
    });

    if (entries.length === 0) {
      wx.showToast({ title: '图片加载中…', icon: 'none' });
      return;
    }

    // 兜底换链：预取没覆盖到的项只有 cloud fileID，而 wx.previewImage 只认 http(s)，
    // 直接把 cloud:// 塞进 urls 会左右滑动全白。这里一次批量换链（getTempUrls 自带缓存），
    // 换不到的就从 urls 里剔除，避免把坏图交给用户看。
    const needResolve = entries.filter(entry => typeof entry.url === 'string' && entry.url.startsWith('cloud://'));
    if (needResolve.length > 0 && typeof imageLoader.getTempUrls === 'function') {
      try {
        // getTempUrls 返回 { [fileID]: httpsUrl }（自带缓存，50 个/批自动分页）
        const urlMap = await imageLoader.getTempUrls(needResolve.map(entry => entry.url), { optimizeType: 'detail' });
        entries.forEach((entry, i) => {
          const replaced = urlMap && urlMap[entry.url];
          if (replaced) entries[i].url = replaced;
        });
      } catch (err) {
        Logger.warn('photoService', '预览批量换链失败，按原样预览', { error: err.message });
      }
    }

    const playable = entries.filter(entry => !(typeof entry.url === 'string' && entry.url.startsWith('cloud://')));
    if (playable.length === 0) {
      wx.showToast({ title: '图片加载中…', icon: 'none' });
      return;
    }

    const urls = playable.map(entry => entry.url);
    let position = playable.findIndex(entry => entry.photoIndex === safeIndex);
    if (position < 0) position = 0;

    // 列表里的 displayUrl 是 gallery(400px) 档，全屏预览会明显拉伸；
    // 只为当前这一张换 detail 档（走 imageLoader 的 fileID@detail 缓存，重复点开不再发请求）
    const photo = photos[safeIndex] || {};
    const fileID = photo._cloudFileID || photo.cloudFileID;

    if (typeof fileID === 'string' && fileID.startsWith('cloud://')) {
      const detailUrl = await imageLoader.getSingleTempUrl(fileID, { optimizeType: 'detail' });
      if (detailUrl) {
        // 替换而不是追加：current 必须仍然出现在 urls 里，否则左右滑动会错位
        urls[position] = detailUrl;
        wx.previewImage({ current: detailUrl, urls });
        return;
      }
    }

    // 拿不到云文件 ID 或换链失败：退回列表用的链接，至少保证能预览
    wx.previewImage({ current: urls[position], urls });
  },

  /**
   * 保存图片到相册
   */
  async saveImageToAlbum(page, e) {
    try {
      const index = e.currentTarget.dataset.index;
      const photo = page.data.photos[index];
      if (!photo) return;

      // 优先用 fileID 取原图临时链接：displayUrl 已被 imageLoader 按 optimizeType 压缩（如 gallery 400px），
      // 保存到相册应保留原图；fileID 换链失败时回退 displayUrl（它至少是可渲染的 https）
      const fileID = photo._cloudFileID || photo.cloudFileID;
      let imageUrl = photo.displayUrl || '';

      if (fileID) {
        wx.showLoading({ title: '正在获取图片…', mask: true });
        try {
          const res = await wx.cloud.getTempFileURL({ fileList: [fileID] });
          imageUrl = res.fileList?.[0]?.tempFileURL || imageUrl;
        } finally {
          wx.hideLoading();
        }
      } else if (imageUrl.includes('imageMogr2')) {
        // 没有 fileID 就拿不到原图，而 displayUrl 是压过的派生链接（带 imageMogr2 尺寸参数）。
        // 静默把它存进相册 = 用户以为存了原图、实际得到 400px 糊图，故明确提示并终止。
        // 纯第三方 https 直链（不含 imageMogr2）本身即原图，仍按原逻辑保存
        wx.showToast({ title: '原图暂不可用，请稍后再试', icon: 'none' });
        return;
      }

      if (!imageUrl || imageUrl.startsWith('cloud://')) {
        wx.showToast({ title: '图片加载中，请稍后再试', icon: 'none' });
        return;
      }

      // 网络 URL 无法直接保存，先落本地临时文件（已是本地路径时跳过下载）
      let localPath = imageUrl;
      if (!imageUrl.startsWith('wxfile://') && !imageUrl.startsWith('/')) {
        wx.showLoading({ title: '正在保存…', mask: true });
        try {
          localPath = await downloadToLocalFile(imageUrl);
        } finally {
          wx.hideLoading();
        }
      }

      await wx.saveImageToPhotosAlbum({ filePath: localPath });
      wx.showToast({ title: '已保存到相册', icon: 'none' });
    } catch (err) {
      if (err.errMsg?.includes('auth deny') || err.errMsg?.includes('fail auth')) {
        wx.showModal({
          title: '需要权限',
          content: '请在设置中开启「保存到相册」权限',
          confirmText: '去设置',
          success: (res) => { if (res.confirm) wx.openSetting(); }
        });
      } else {
        Logger.warn('detail', '保存图片失败', { error: err.message });
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
  },

  /**
   * 切换照片点赞状态
   * per-photo 锁防止连点并发；成功时以服务端返回的最终状态为准
   */
  async togglePhotoLike(page, e) {
    const index = e.currentTarget.dataset.index;
    const photoId = e.currentTarget.dataset.photoId;
    const photos = [...page.data.photos];
    const photo = photos[index];
    if (!photo) return;

    // 同一照片请求在途时忽略重复点击，防止并发响应互相回滚错乱
    if (!page._photoLikeLocks) page._photoLikeLocks = {};
    if (page._photoLikeLocks[photoId]) return;
    page._photoLikeLocks[photoId] = true;

    const wasLiked = photo._liked;
    const likeCount = photo.likeCount || 0;
    // 乐观更新：翻转本张照片的点赞态与计数（其余字段保持）
    const nextLiked = !wasLiked;
    const nextLikeCount = wasLiked ? Math.max(0, likeCount - 1) : likeCount + 1;
    photos[index] = { ...photos[index], _liked: nextLiked, likeCount: nextLikeCount };

    safePageSetData(page, { photos });
    page._computeTotalLikes(photos);

    // 回滚时基于最新列表只重置该照片字段，避免覆盖其他照片的并发变化
    const rollback = () => {
      const latest = [...page.data.photos];
      const latestPhoto = latest[index];
      if (latestPhoto && latestPhoto._id === photo._id) {
        latest[index] = { ...latestPhoto, _liked: wasLiked, likeCount };
        safePageSetData(page, { photos: latest });
        page._computeTotalLikes(latest);
      }
    };

    try {
      const res = await wx.cloud.callFunction({ name: 'togglePhotoLike', data: { photoId } });
      const resultData = res.result?.data || {};
      if (!res.result?.success) {
        rollback();
        wx.showToast({ title: '网络开小差，点赞没成功', icon: 'none' });
      } else if (typeof resultData.liked === 'boolean') {
        // 以服务端最终状态为准，修正乐观更新可能存在的偏差
        const latest = [...page.data.photos];
        const latestPhoto = latest[index];
        if (latestPhoto && latestPhoto._id === photo._id && latestPhoto._liked !== resultData.liked) {
          latest[index] = {
            ...latestPhoto,
            _liked: resultData.liked,
            likeCount: Math.max(0, (latestPhoto.likeCount || 0) + (resultData.liked ? 1 : -1))
          };
          safePageSetData(page, { photos: latest });
          page._computeTotalLikes(latest);
        }
      }
    } catch (err) {
      Logger.warn('detail', '点赞操作失败', err.message);
      rollback();
      wx.showToast({ title: '网络开小差，点赞没成功', icon: 'none' });
    } finally {
      page._photoLikeLocks[photoId] = false;
    }
  }
};
