/**
 * services/catService.js - 猫咪列表数据服务
 *
 * 类型说明：项目 tsconfig 中 checkJs: false，如需完整类型覆盖请添加 JSDoc 注解
 *
 * 职责：猫咪列表的加载、分页、刷新、预取
 * 接收 page 上下文（this）作为参数，操作其 data/setData
 */
const _config = require('../config');
const AvatarHelper = require('../utils/avatarHelper');
const { Logger } = require('../utils/logger');
const { monitorApi } = require('../utils/performanceMonitor');
const imageLoader = require('../utils/imageLoader');
const { formatDateShort } = require('../utils/dateFormat');
// 启动埋点：只在首屏那次查询上打点，后续翻页/刷新不污染数据
const _trace = require('../utils/startupTrace');
const ErrorHandler = require('../utils/errorHandler');
const { safePageSetData } = require('../utils/safePageSetData');
const offlineCache = require('../utils/offlineCache');
// 客户端直连读 cats 时必须与云函数出口同语义：过滤删除中的猫咪 + 剔除内部字段
// （详见 utils/dbFields.js 的模块说明）
const { CAT_LIST_FIELDS, withCatVisibility } = require('../utils/dbFields');
// 花色归一化：写进 colorOptions 前必须归一，否则原始细项（狸白/橘白…）
// 会与标准分类（狸花/橘猫…）混排显示
const { normalizeColor, sortByDisplayOrder } = require('../utils/colorNormalize');

// 惰性求值：避免模块加载时 wx.cloud 尚未初始化
function getDbCmd() {
  return wx.cloud.database().command;
}

/**
 * 合并花色选项：已有（可能来自 getFilterOptions 的全量花色）与本次列表提取求并集。
 * 不能整体覆盖 —— 两个数据源并发，覆盖会让「后到者」决定最终结果，
 * 而首页列表只含第一页 10 只猫的花色，子集覆盖全集后筛选项会静默缺失。
 * 两个来源都先 normalizeColor 归一化再并入：面板只显示标准分类。
 * @param {string[]} existing - 当前页面上已有的花色选项
 * @param {object[]} cats - 本次加载的猫咪数组
 * @returns {string[]}
 */
function mergeColorOptions(existing, cats) {
  const merged = new Set();
  (Array.isArray(existing) ? existing : []).forEach(c => {
    const std = normalizeColor(c);
    if (std) merged.add(std);
  });
  (cats || []).forEach(cat => {
    const std = normalizeColor(cat && cat.color);
    if (std) merged.add(std);
  });
  return sortByDisplayOrder([...merged]);
}

/**
 * 首屏字段预计算（**纯同步，不碰网络**）
 *
 * 从 mediaHelper.resolveCatAvatars 里拆出来的无网络部分。保留它的理由是
 * wxml 直接用这几个字段，算不出来就得改一堆模板：
 *   - initialName：头像缺失时占位圈要显示的名字首字符（wxml 不能调 JS 方法）
 *   - photoCount：卡片 aria-label 用
 *   - updateTime：格式化后的日期
 *   - avatar：selectAvatar 的选图结果（cloud:// 原样透出，转链交给异步补丁）
 *
 * 拆分的意义：原来这一步和 getTempFileURL 绑在同一条 await 上，首屏白屏时间
 * 硬吃一次云调用往返。现在它瞬时完成，链接由既有的 page._resolveAvatarsAsync
 * （services/imageService.js，带 monitor 埋点）异步补上，不新增第二套转链通道。
 */
function resolveCatFields(cats, existingCats = [], photoCountsMap = {}) {
  const loadedMap = {};
  (existingCats || []).forEach(cat => {
    if (cat && cat._id) loadedMap[cat._id] = cat.avatarLoaded;
  });
  return (cats || []).map(cat => {
    const avatar = AvatarHelper.selectAvatar(cat);
    return {
      ...cat,
      avatar,
      initialName: (cat.name || '').charAt(0),
      photoCount: photoCountsMap[cat._id] ?? 0,
      updateTime: cat.updateTime ? formatDateShort(cat.updateTime) : '',
      avatarLoaded: loadedMap[cat._id] ?? false
    };
  });
}

module.exports = {
  /**
   * 加载猫咪列表（第一页）
   * @param {object} page - 页面上下文 (this)
   */
  async loadCats(page, options = {}) {
    if (page._loadingCats || page._loadingAll) return;
    page._loadingCats = true;

    // 请求序列号：下拉刷新会强制解锁发起新请求，旧请求的响应到达后按序丢弃，
    // 防止旧响应后到覆盖新数据
    page._loadCatsSeq = (page._loadCatsSeq || 0) + 1;
    const seq = page._loadCatsSeq;

    try {
      // silent：SWR 场景（已有本地缓存渲染）不显示骨架屏，只静默刷新
      if (options.silent) {
        safePageSetData(page, { page: 1 });
      } else {
        safePageSetData(page, { loading: true, showSkeleton: true, page: 1 });
      }

      const db = wx.cloud.database();
      page._photosMap = {};

      const pageSize = page.data.pageSize;

      _trace.mark('list-query:start');

      const [catsRes, countRes] = await monitorApi(
        'loadCats-parallel',
        async () => Promise.all([
          db.collection('cats')
            .where(withCatVisibility({ status: getDbCmd().in(['normal', 'lost', 'deceased', 'adopted']) }))
            .field(CAT_LIST_FIELDS)
            // 列表排序：按 listSort 降序（在校+走失 → 离世 → 领养垫底）。
            // 排序值由服务端写库时计算维护（cloudfunctions/utils/listSort.js），客户端只消费。
            .orderBy('listSort', 'desc')
            .limit(pageSize)
            .get(),
          db.collection('cats').count().catch(err => {
            Logger.warn('index', '获取猫咪总数失败', { error: err.message });
            return { total: 0 };
          })
        ])
      );
      _trace.mark('list-query:done');

      // DEBUG: 检查加载的猫咪状态分布
      // 已有更新的请求（如下拉刷新）发起，丢弃本次旧响应
      if (seq !== page._loadCatsSeq) return;
      const statusMap = {};
      catsRes.data.forEach(c => { statusMap[c.status] = (statusMap[c.status] || 0) + 1; });
      Logger.info('catService', '加载猫咪完成', { total: catsRes.data.length, statusMap });

      const totalCatsCount = countRes.total || 0;
      page._totalCatsCount = totalCatsCount;

      // 照片统计（getCatPhotoCounts）冷启动较慢，不再放进首屏关键路径：
      // 列表先渲染，统计数字与每只猫的照片数由 patchPhotoCounts 异步补丁（见文件尾部）。

      // type: 'gallery' —— 首页大头照 .cat-image-wrap 是 220rpx（@2x/@3x 需 220/330 物理像素），
      // avatar 档 100x100 会被放大 2~3 倍，「优化」反把图压糊。只有首页是这么小的图配这么大的框，
      // 其余 7 处调用方都渲染 80~112rpx 小头像，用默认 avatar 即可。
      //
      // **不 await**：首屏等一次 getTempFileURL 才渲染，等于把云调用往返压进白屏时间。
      // lazy-image 自己就 require 了 imageLoader、能吃 cloud:// 原值并转链（第 27 行属性说明），
      // 而 imageLoader 有内存缓存 + _inflight 去重，所以这些并发请求会和下面的
      // patchAvatars 命中同一份缓存，不会退化成 N 次云调用。
      // resolveCatAvatars 真正不可省的是预计算 initialName/photoCount/updateTime，
      // 那部分由下面的同步拆分函数完成（不碰网络）。
      const catsWithAvatar = resolveCatFields(catsRes.data, page.data.cats, page._photoCountsMap || {});
      // 转换是异步的，再次确认期间没有更新的请求发起
      if (seq !== page._loadCatsSeq) return;
      // 与已有集合求并，而不是整体覆盖：
      // getFilterOptions（全量花色）与 loadCats 在 onLoad 并发发起，谁后到谁赢 ——
      // 若 loadCats 晚到并用首页 10 只猫的子集覆盖，筛选面板会只剩第一页出现过的花色，
      // 且此后下拉刷新/返回详情都无法恢复（refreshSingleCat 同样覆盖）。
      const colorOptions = mergeColorOptions(page.data.colorOptions, catsWithAvatar);

      const hasMore = catsRes.data.length >= pageSize;
      // 基准分页状态：筛选期间 data.hasMore 会被筛选分页覆写，清空筛选时由此还原
      page._baseHasMore = hasMore;

      // 加载成功：复位首屏错误态标记（下次失败可重新进入错误态并自动重试一次）
      page._indexErrorShown = false;

      const hasActiveFilter = page.data.campusFilter || page.data.genderFilter ||
        page.data.statusFilter || page.data.colorFilter || page.data.ageFilter ||
        page.data.searchKeyword || page.data.adoptFilter;

      if (hasActiveFilter) {
        safePageSetData(page, {
          cats: catsWithAvatar, totalCats: totalCatsCount,
          hasMore, loading: false, showSkeleton: false, loadingMore: false, colorOptions
        });
        page.filterCats();
      } else {
        safePageSetData(page, {
          cats: catsWithAvatar, filteredCats: catsWithAvatar,
          totalCats: totalCatsCount, filteredCatCount: totalCatsCount,
          hasMore, loading: false, showSkeleton: false, loadingMore: false, colorOptions
        });
      }

      // setData 已提交，视图层的实际渲染在下一个 tick —— 用 nextTick 而不是直接打点，
      // 否则量到的是「数据提交」而非「用户看见」。
      try {
        if (typeof wx.nextTick === 'function') wx.nextTick(() => _trace.mark('list-rendered'));
        else _trace.mark('list-rendered');
      } catch (e) { /* ignore */ }

      // 首屏列表已渲染；照片统计异步补丁，不阻塞关键路径
      patchPhotoCounts(page, seq);

      // SWR：成功后落盘（下次冷启动先渲染缓存再后台刷新）
      offlineCache.saveCats(catsWithAvatar);

      page._resolveAvatarsAsync(catsWithAvatar);
    } catch (err) {
      // 旧请求的失败无需处理，交给最新请求接管 UI 状态
      if (seq !== page._loadCatsSeq) return;
      Logger.error('index', '加载猫咪列表失败', err);
      // 刷新失败时也要顺手解开分页锁：加载更多会因此次刷新提前退出，
      // 若不在这里复位 loadingMore，底部会永久停留在「正在加载」
      safePageSetData(page, { loading: false, showSkeleton: false, loadingMore: false });
      // 首屏（列表为空）失败：进入错误态（「重新加载」按钮 + 5 秒自动重试一次），
      // 与相册页 loadError 模式对齐；已有数据时的刷新失败仅 toast，不清空列表。
      // 自动重试仍失败时只保持错误态（不重启倒计时、不重复 toast），避免 5 秒循环骚扰。
      const hasCats = Array.isArray(page.data && page.data.cats) && page.data.cats.length > 0;
      if (!hasCats && typeof page.showNetworkErrorEnhanced === 'function') {
        if (!page._indexErrorShown) {
          page._indexErrorShown = true;
          page.showNetworkErrorEnhanced();
          ErrorHandler.handle(err, { title: '加载失败' });
        } else {
          safePageSetData(page, { networkError: true, autoRetryCountdown: 0 });
        }
      } else {
        ErrorHandler.handle(err, { title: '加载失败' });
      }
    } finally {
      // 仅最新请求有权释放锁，避免旧请求提前解锁
      if (seq === page._loadCatsSeq) page._loadingCats = false;
    }
  },

  /**
   * 加载更多猫咪
   * @param {object} page - 页面上下文
   */
  async loadMoreCats(page) {
    if (page._loadingMoreCats || page.data.loadingMore || !page.data.hasMore) return;
    // 筛选模式下也允许加载更多 —— 服务端分页 + 客户端重新过滤

    page._loadingMoreCats = true;
    // 记录当前列表版本：期间若发生下拉刷新（_loadCatsSeq 变化），本次分页结果作废
    const seqAtStart = page._loadCatsSeq || 0;
    try {
      safePageSetData(page, { loadingMore: true });
      const db = wx.cloud.database();
      const nextPage = page.data.page + 1;
      const skip = (nextPage - 1) * page.data.pageSize;

      const [catsRes] = await monitorApi('loadMoreCats', () => Promise.all([
        db.collection('cats')
          .where(withCatVisibility({ status: getDbCmd().in(['normal', 'lost', 'deceased', 'adopted']) }))
          .field(CAT_LIST_FIELDS)
          // 与首屏 loadCats 同一排序字段（分页的 skip/limit 口径必须与排序键一致）
          .orderBy('listSort', 'desc')
          .skip(skip)
          .limit(page.data.pageSize)
          .get()
      ]));

      // 空页分支必须先做序号校验：请求在途时用户下拉刷新（_loadCatsSeq 已自增），
      // 旧响应晚到且为空时，若先落盘 hasMore=false / _baseHasMore=false，
      // 会把「刷新后的新列表还有下一页」污染成「已经到底」——用户再也翻不到后面的猫咪，
      // 且 _baseHasMore 被污染后清除筛选也无法恢复。
      if (seqAtStart !== (page._loadCatsSeq || 0)) return;

      if (catsRes.data.length === 0) {
        // 末页同样属于基准列表的分页状态，需与成功分支一致同步，
        // 否则清除筛选还原全量列表时会把 hasMore 错误还原为 true
        page._baseHasMore = false;
        safePageSetData(page, { hasMore: false, loadingMore: false });
        return;
      }

      const photoCountsMap = page._photoCountsMap || {};
      // 预取再下一页改为 fire-and-forget：用户点「加载更多」不应等一次无谓的 N+2 页查询
      Promise.resolve(page._preloadNextPage(nextPage + 1)).catch((e) => {
        Logger.warn('index', '预取下一页失败（非致命）', { error: e && e.message });
      });
      // 与首屏 loadCats 同一档位（gallery）：「加载更多」进来的卡片与首屏卡片
      // 渲染尺寸完全一致，档位不同会让同屏出现清晰度不一致的两批图
      const catsWithTempUrl = await AvatarHelper.resolveCatAvatars(catsRes.data, page.data.cats, { photoCountsMap, type: 'gallery' });

      // 头像转换/预取是异步的，落盘前再次确认没有刷新插入
      if (seqAtStart !== (page._loadCatsSeq || 0)) return;

      const existingIds = new Set(page.data.cats.map(c => c._id));
      const uniqueNewCats = catsWithTempUrl.filter(c => !existingIds.has(c._id));
      const newCats = [...page.data.cats, ...uniqueNewCats];

      const hasMore = catsRes.data.length >= page.data.pageSize;
      page._baseHasMore = hasMore;
      safePageSetData(page, {
        cats: newCats, page: nextPage,
        hasMore, loadingMore: false
      });

      if (page.data.hasSearched) {
        page.filterCats();
      } else {
        safePageSetData(page, { filteredCatCount: page.data.totalCats });
        page.filterCats();
      }
    } catch (err) {
      Logger.error('index', '加载更多猫咪失败', err);
      safePageSetData(page, { loadingMore: false });
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      page._loadingMoreCats = false;
      // 兜底复位，但只复位「仍由本轮拥有」的 loadingMore：
      // 命中「刷新抢占」早退（seqAtStart 不再是本轮序号）时，loadingMore 已归新一轮所有，
      // 此时无条件复位会把新一轮刚置上的状态清掉（按钮文案回退成「加载更多」）。
      // 被抢占后不再由本轮兜底也不会卡死：自增 _loadCatsSeq 的只有 loadCats（下拉刷新），
      // 它在成功与失败两条分支里都会把 loadingMore 复位。
      // 成功/失败分支已复位过（data.loadingMore 为 false），此处不再重复 setData。
      if (seqAtStart === (page._loadCatsSeq || 0) && page.data.loadingMore) {
        safePageSetData(page, { loadingMore: false });
      }
    }
  },

  /**
   * 刷新单个猫咪数据
   * @param {string} catId
   * @param {object} page
   */
  async refreshSingleCat(catId, page) {
    try {
      const db = wx.cloud.database();
      // 单文档读同样要投影：刷新到的若是「删除中」记录，投影后的数据与列表其余项字段一致，
      // 不会因为这一条把 _openid 等内部字段混进 page.data.cats 再渲染/上报
      const { data } = await db.collection('cats').doc(catId).field(CAT_LIST_FIELDS).get();
      if (!data) return;

      const cats = page.data.cats.map(cat => {
        if (cat._id === catId) {
          return { ...cat, ...data,
            avatar: cat._cloudFileID && cat._cloudFileID === data.avatar ? cat.avatar : data.avatar,
            // 头像变更时 _cloudFileID 必须跟随新文件：保留旧 ID 会让图片重试
            //（imageService.onImageError → imageRetryManager 用 _cloudFileID 转链）
            // 把旧头像「复活」写回列表，用户看到改之前的头像且不会自愈
            _cloudFileID: data.avatar || cat._cloudFileID,
            avatarLoaded: false };
        }
        return cat;
      });

      safePageSetData(page, { cats, colorOptions: mergeColorOptions(page.data.colorOptions, cats) });
      if (page.data.hasSearched) {
        page.filterCats();
      } else {
        safePageSetData(page, { filteredCats: cats });
      }
      Logger.info('index', '单个猫咪数据已更新', { catId });
    } catch (err) {
      Logger.error('index', '刷新单个猫咪失败', err);
    }
  },

  /**
   * 预加载下一页数据
   * @param {number} pageNum
   * @param {object} page
   */
  async preloadNextPage(pageNum, page) {
    try {
      const db = wx.cloud.database();
      const skip = (pageNum - 1) * page.data.pageSize;
      const res = await db.collection('cats')
        .where(withCatVisibility({ status: getDbCmd().in(['normal', 'lost', 'deceased', 'adopted']) }))
        .field(CAT_LIST_FIELDS)
        // 与首屏/加载更多同一排序字段：预取的分页位置必须与真实列表对齐
        .orderBy('listSort', 'desc')
        .skip(skip)
        .limit(page.data.pageSize)
        .get();

      if (res.data.length > 0) {
        const avatarIds = res.data
          .map(cat => cat.avatar || cat.images && cat.images[0])
          .filter(id => id?.startsWith('cloud://'));
        if (avatarIds.length > 0) {
          imageLoader.preloadBelowFold(avatarIds, 'avatar');
        }
      }
    } catch (err) {
      Logger.warn('index', '预加载下一页失败', { error: err.message });
    }
  }
};

/**
 * 照片统计异步补丁（loadCats 首屏解耦用）
 *
 * getCatPhotoCounts 云函数冷启动较慢，原先与列表绑在同一条 Promise.all 关键路径上，
 * 冷启动时首屏被统计接口拖住（实测约 1.9s）。现在列表先渲染，统计数字与每只猫的
 * photoCount 到达后异步补丁（值未变化时不 patch，避免无谓 setData）。
 */
async function patchPhotoCounts(page, seq) {
  try {
    const photoCountsResult = await wx.cloud.callFunction({ name: 'getCatPhotoCounts', timeout: 8000 });
    if (seq !== page._loadCatsSeq) return; // 已有更新的请求，丢弃本次补丁

    const inner = photoCountsResult?.result?.data ?? photoCountsResult?.result ?? {};
    const photoCountsMap = inner.counts || {};
    page._photoCountsMap = photoCountsMap;

    const totalPhotos = inner.totalPhotos
      ?? Object.values(photoCountsMap).reduce((sum, n) => sum + n, 0);
    const totalViews = inner.totalViews ?? 0;
    Logger.info('catService', '照片统计（异步补丁）', {
      totalPhotos,
      totalViews,
      mapSize: Object.keys(photoCountsMap).length
    });

    const patch = { totalPhotos, totalViews };
    const applyCounts = (list, prefix) => {
      (list || []).forEach((c, i) => {
        const n = photoCountsMap[c._id];
        if (typeof n === 'number' && n !== c.photoCount) {
          patch[`${prefix}[${i}].photoCount`] = n;
        }
      });
    };
    applyCounts(page.data.cats, 'cats');
    applyCounts(page.data.filteredCats, 'filteredCats');
    safePageSetData(page, patch);

    // 统计数字到达后驱动首页数字动画：首屏统计解绑后动画必须在此触发，
    // 否则 displayPhotos/displayViews 永远停在 0（loadCats 完成时统计还没到）。
    // 猫咪总数以 page.data.totalCats 为准，回退到 _totalCatsCount（loadCats 写入的
    // 权威值）：曾观察到冷启动时 data.totalCats 短暂为 0，补丁会把「只猫」动画到 0。
    if (typeof page._animateStatNumbers === 'function') {
      page._animateStatNumbers(page.data.totalCats || page._totalCatsCount || 0, totalPhotos, totalViews);
    }

    // SWR：统计值一并落盘，下次冷启动先显示上次的数字（避免闪 0）
    offlineCache.saveStats(totalPhotos, totalViews);
  } catch (err) {
    Logger.warn('index', '照片统计云函数失败，降级为空', { error: err.message });
  }
}
