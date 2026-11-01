// @ts-nocheck — 项目 tsconfig 中 checkJs: false，此标记为冗余
/**
 * services/imageService.js - 图片处理服务
 *
 * 职责：猫咪头像加载、错误重试、首屏/下一页预加载
 */
const imageLoader = require('../utils/imageLoader');
const imageRetryManager = require('../utils/imageRetryManager');
const AvatarHelper = require('../utils/avatarHelper');
const { Logger } = require('../utils/logger');
const { monitorApi } = require('../utils/performanceMonitor');

module.exports = {
  /**
   * 异步获取头像临时链接并更新列表
   * @param {Array} cats - 猫咪列表
   * @param {object} page - 页面上下文
   */
  async resolveAvatarsAsync(cats, page) {
    if (!cats?.length) return;
    try {
      // type: 'gallery' —— 首页大头照专用，理由见 services/catService.js 的同档位注释
      const catsWithTempUrl = await monitorApi(
        'loadCats-resolve-avatars',
        () => AvatarHelper.resolveCatAvatars(cats, page.data.cats, { type: 'gallery' })
      );

      const patches = [];
      catsWithTempUrl.forEach((newCat) => {
        if (newCat._id && newCat.avatar) {
          patches.push({
            catId: newCat._id,
            avatar: newCat.avatar,
            _cloudFileID: newCat._cloudFileID,
            avatarLoaded: newCat.avatarLoaded
          });
        }
      });

      if (patches.length > 0) {
        const BATCH_SIZE = 8;
        for (let batchStart = 0; batchStart < patches.length; batchStart += BATCH_SIZE) {
          const batchPatches = patches.slice(batchStart, batchStart + BATCH_SIZE);
          // 批间 await 期间列表可能被下拉刷新整体替换，索引会失效：
          // 每批重建索引并校验 _id 一致后才 patch，防止错位覆盖
          const currentCatsMap = {};
          (page.data.cats || []).forEach((c, i) => { if (c._id) currentCatsMap[c._id] = i; });
          const filteredIdxMap = {};
          (page.data.filteredCats || []).forEach((c, i) => { if (c._id) filteredIdxMap[c._id] = i; });

          const setDataObj = {};
          batchPatches.forEach(p => {
            const ci = currentCatsMap[p.catId];
            if (ci !== undefined && page.data.cats[ci]?._id === p.catId) {
              // 值未变化时跳过 patch：重复转链/已就绪的 http 头像不再产生一次 setData
              if (page.data.cats[ci].avatar !== p.avatar) {
                setDataObj[`cats[${ci}].avatar`] = p.avatar;
                setDataObj[`cats[${ci}]._cloudFileID`] = p._cloudFileID;
                setDataObj[`cats[${ci}].avatarLoaded`] = p.avatarLoaded;
              }
            }
            const fi = filteredIdxMap[p.catId];
            if (fi !== undefined && page.data.filteredCats[fi]?._id === p.catId) {
              if (page.data.filteredCats[fi].avatar !== p.avatar) {
                setDataObj[`filteredCats[${fi}].avatar`] = p.avatar;
                setDataObj[`filteredCats[${fi}]._cloudFileID`] = p._cloudFileID;
                setDataObj[`filteredCats[${fi}].avatarLoaded`] = p.avatarLoaded;
              }
            }
          });
          if (Object.keys(setDataObj).length > 0) {
            try {
              // 优先走 safeSetData（若页面已标记卸载则直接丢弃）；try/catch 作为兜底，
              // 覆盖未接 behavior 的调用方与页面已销毁的场景
              if (typeof page.safeSetData === 'function') {
                page.safeSetData(setDataObj);
              } else {
                page.setData(setDataObj);
              }
            } catch (e) {
              // 页面已卸载，静默退出
              return;
            }
          }
          if (batchStart + BATCH_SIZE < patches.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      Logger.info('index', '异步头像更新完成', { total: catsWithTempUrl.length, updated: patches.length });
    } catch (err) {
      Logger.error('index', '异步获取头像临时链接失败', err);
    }
  },

  /**
   * 预加载首屏图片
   *
   * 两档都要预热，少一档就会退化成「每张卡片各发一次单文件转链」：
   *   - gallery：卡片实际渲染的档位（首页 wxml 的 lazy-image type="gallery"）；
   *   - thumbnail：gallery 档的渐进式占位档（lazy-image 先取 thumbnail 再取 gallery）。
   * 只预热 gallery 时，每张卡的 thumbnail 档都是缓存未命中，各发一次单文件
   * getTempFileURL —— 首屏最多 10 次。两档各一次批量预热即可把这一串收敛掉。
   * @param {Array} cats
   */
  preloadFirstScreen(cats) {
    if (cats.length === 0) return;
    const avatarIds = cats
      .slice(0, 10)
      .map(cat => cat.avatar || cat._cloudFileID)
      .filter(id => id?.startsWith('cloud://'));
    if (avatarIds.length > 0) {
      // 档位必须与首页 wxml 的 lazy-image type 一致（gallery，400×400）：
      // imageLoader 的缓存键是「fileID@档位」，用 avatar 档预热出来的条目
      // 永远不会被渲染侧的 gallery 请求命中，预热等于白做。
      imageLoader.preloadAboveFold(avatarIds, 'gallery');
      // 渐进式占位档：imageLoader 的在途复用也会命中这两批，进一步减少重复调用
      imageLoader.preloadAboveFold(avatarIds, 'thumbnail');
    }
  },

  /**
   * 图片加载完成事件处理
   * @param {object} e - 事件对象
   * @param {object} page
   */
  onImageLoad(e, page) {
    const catId = e.currentTarget.dataset.id;
    if (page._retryingCatIds) page._retryingCatIds.delete(catId);
    const catsIdx = page.data.cats.findIndex(c => c._id === catId);
    const filteredIdx = page.data.filteredCats.findIndex(c => c._id === catId);
    const patch = {};
    if (catsIdx !== -1) patch[`cats[${catsIdx}].avatarLoaded`] = true;
    if (filteredIdx !== -1) patch[`filteredCats[${filteredIdx}].avatarLoaded`] = true;
    if (Object.keys(patch).length > 0) page.setData(patch);
  },

  /**
   * 图片加载失败事件处理（带重试去重）
   * @param {object} e - 事件对象
   * @param {object} page
   */
  onImageError(e, page) {
    const catId = e.currentTarget.dataset.id;
    if (!page._retryingCatIds) page._retryingCatIds = new Set();
    if (page._retryingCatIds.has(catId)) return;
    page._retryingCatIds.add(catId);

    Logger.warn('index', '图片加载失败，将尝试重试', { catId, error: e.detail?.errMsg });
    const cat = page.data.cats.find(c => c._id === catId);
    if (!cat) { page._retryingCatIds.delete(catId); return; }
    // 第四个参数 'gallery' 必须与首屏解析档位一致，否则重试成功后
    // 会把清晰的头像替换成 100x100 的糊图（同屏两张图清晰度不一致）
    imageRetryManager.handleError(catId, cat._cloudFileID, page, 'gallery');
  }
};
