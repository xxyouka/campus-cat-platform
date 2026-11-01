/**
 * utils/filterService.js - 猫咪筛选服务
 *
 * 从 index.js 提取的筛选逻辑
 * 包含服务端筛选、全量加载筛选、校区筛选
 */

const { Logger } = require('./logger');
const AvatarHelper = require('./avatarHelper');
const offlineCache = require('./offlineCache');
const config = require('../config');
const { safePageSetData } = require('./safePageSetData');
// 客户端直连读 cats 时必须与云函数出口同语义：过滤删除中的猫咪 + 剔除内部字段
// （详见 utils/dbFields.js 的模块说明）
const { CAT_LIST_FIELDS, withCatVisibility } = require('./dbFields');

// 使用惰性求值函数，避免模块加载时 wx.cloud 尚未初始化
// 必须在 wx.cloud.init() 完成之后才能调用
function getDbCmd() {
  return wx.cloud.database().command;
}

/**
 * 分批拉取全量猫咪（带安全上限、批间让渡与单批超时保护）
 *
 * @param {Object} db - 云数据库实例
 * @param {number} batchSize - 单批条数
 * @param {number} maxCats - 总量安全上限
 * @returns {Promise<{cats: Array, batches: number}>} 已加载的猫咪与实际执行批次数
 */
async function fetchAllCats(db, batchSize, maxCats) {
  const maxBatches = Math.ceil(maxCats / batchSize);
  const cats = [];
  let batches = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    batches++;
    const res = await Promise.race([
      db.collection('cats')
        .where(withCatVisibility({ status: getDbCmd().in(['normal', 'lost', 'deceased', 'adopted']) }))
        .field(CAT_LIST_FIELDS)
        // 与首屏同一排序字段（降级全量加载也要保持「领养垫底」的口径）
        .orderBy('listSort', 'desc')
        .skip(batch * batchSize)
        .limit(batchSize)
        .get(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('查询超时')), config.performance.queryTimeout)
      )
    ]);

    if (res.data.length === 0) break;
    cats.push(...res.data);

    if (cats.length >= maxCats) {
      Logger.warn('FilterService', '达到安全上限，停止加载', {
        current: cats.length,
        limit: maxCats
      });
      break;
    }

    if (res.data.length < batchSize) break;

    // 每两批让渡一次事件循环，避免长时间占用主线程
    if (batch % 2 === 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { cats, batches };
}

const FilterService = {
  /**
   * 在已加载的列表上应用当前筛选条件（纯本地，不发起任何云调用）。
   *
   * 降级路径必须在这里止步：这里原先调用 pageContext.filterCats()，而页面该入口会以
   * fire-and-forget 方式重新进入 filterFromServer（index.js 的 .then() 链）。当 filterCats
   * 云函数持续失败（未部署 / 超时 / success:false）且本地搜索索引不存在或 0 命中时，
   * 「云函数失败 → 全量加载 → filterCats() → 云函数再次失败 …」构成无界异步递归：
   * 每轮都重新分页拉取全量（最多 500 条 / 每批 100 条），数据量大时还会每轮弹一次 wx.showModal。
   * 改为只消费当前 this.data.cats，降级链路在结构上不可能再回到页面筛选入口。
   */
  _applyLocalFilter(pageContext) {
    // FilterService 是 util，调用页面的本地兜底筛选前先做存在性检查
    if (typeof pageContext._fallbackClientFilter !== 'function') return;
    const kw = (pageContext.data.searchKeyword || '').toLowerCase().trim();
    pageContext._fallbackClientFilter(kw);

    // 与页面筛选入口 filterCats()（index.js）保持同一口径：它也是在「存在筛选条件」时
    // 才置 hasSearched: true（无任何筛选会提前 return 走还原全量）。降级路径同样要置位，
    // 否则「有关键词但 0 结果」时，index.wxml 的「没找到这只主子」空态依赖的
    // hasSearched 不成立，空态不会显示。
    const hasFilters = !!(pageContext.data.searchKeyword ||
      pageContext.data.genderFilter ||
      pageContext.data.colorFilter ||
      pageContext.data.ageFilter ||
      pageContext.data.campusFilter ||
      pageContext.data.adoptFilter);
    if (hasFilters) {
      safePageSetData(pageContext, { hasSearched: true });
    }
  },

  async filterFromServer(pageContext, kw, options = {}) {
    const page = options.page || 1;
    const append = options.append === true;
    // 注意：这里不做 _loadingAll 早退——并发筛选请求由页面侧的请求序号（_filterSeq）
    // 丢弃过期响应；早退会让新筛选请求被静默丢弃，旧响应反而覆盖新筛选结果
    pageContext._loadingAll = true;

    // 入口快照请求序号。页面筛选入口（filterCats）、还原全量（_restoreFullList）
    // 与校区切换（loadCatsByCampus）都会自增它，任何一方在云调用/头像解析期间自增，
    // 本次结果就整体作废。
    // 判定必须在这里做：页面 .then() 里的 seq 校验只能拦住「页面自己发起的筛选」，
    // 拦不住本函数内部的裸 setData。此前校区切关键「互斥」是单向的——
    // 关键词在途时点校区，校区响应先落盘、随后关键词响应返回又把 filteredCats 覆盖回
    // 关键词结果，而页面的 seq 校验早已因序号变化早退，无人纠正 →
    // 最终「校区 chip 高亮、列表是关键词结果」。
    const seqAtStart = pageContext._filterSeq;

    try {
      const result = await FilterService._executeFilterCall(pageContext, kw, page);

      if (!result) {
        throw new Error('云函数筛选失败');
      }

      const serverCats = result.cats;
      const photoCountsMap = pageContext._photoCountsMap || {};
      // type: 'gallery' 与首屏 loadCats / loadMoreCats 同一档位：筛选结果渲染在
      // 与首屏完全相同的 220rpx 卡片里，档位不同会让搜索结果比首屏糊一截
      const catsWithUrl = await AvatarHelper.resolveCatAvatars(serverCats, pageContext.data.cats, { photoCountsMap, type: 'gallery' });

      // 落盘前校验：期间发生过校区切换/新筛选/还原全量则丢弃本次响应
      if (seqAtStart !== pageContext._filterSeq) {
        Logger.info('FilterService', '筛选结果已过期（请求序号变化），丢弃', {
          seqAtStart,
          current: pageContext._filterSeq
        });
        return null;
      }

      // 筛选结果落盘：
      //  - 第 1 页（append=false）在服务端返回空时保留客户端兜底筛选的结果（原行为）；
      //  - 追加页（append=true）即使为空也要落盘 hasMore:false，
      //    否则空页不会关闭分页开关，上拉会反复请求同一页。
      const shouldWrite = serverCats.length > 0 || append;

      if (shouldWrite) {
        let nextCats = catsWithUrl;
        if (append) {
          // 追加与本页内去重：分页边界重叠或取消关注导致索引前移时，同一只猫不重复渲染
          const existing = Array.isArray(pageContext.data.filteredCats) ? pageContext.data.filteredCats : [];
          const existingIds = new Set(existing.map(c => c._id));
          nextCats = [...existing, ...catsWithUrl.filter(c => !existingIds.has(c._id))];
        }
        // 只更新筛选视图，不覆盖 cats 全量基准列表：
        // cats 供「清空筛选还原全量」与 loadMore 追加去重使用，被筛选结果覆写后无法还原
        safePageSetData(pageContext, {
          filteredCats: nextCats,
          filteredCatCount: result.total,
          hasMore: result.hasMore
        });
      } else {
        Logger.info('FilterService', '服务端返回空结果，保留客户端筛选结果');
      }

      if (pageContext._resolveAvatarsAsync) {
        pageContext._resolveAvatarsAsync(catsWithUrl);
      }

      Logger.info('FilterService', '服务端筛选完成', { total: result.total, returned: catsWithUrl.length });

      return { success: true, cats: catsWithUrl, total: result.total, hasMore: result.hasMore };
    } catch (err) {
      Logger.warn('FilterService', '服务端筛选失败，降级为客户端全量加载', { error: err.message });
      // 过期请求的降级同样要丢弃：loadAllAndFilter 会整体覆写 cats/filteredCats，
      // 若校区切换已经落盘，这次降级会把校区视图又冲成关键词的本地筛选结果
      if (seqAtStart !== pageContext._filterSeq) return null;
      // 先释放标志再降级，否则 loadAllAndFilter 会被自身守卫直接挡掉（降级变死代码）
      pageContext._loadingAll = false;
      await FilterService.loadAllAndFilter(pageContext);
      return null;
    } finally {
      pageContext._loadingAll = false;
    }
  },

  async _executeFilterCall(pageContext, kw, page = 1) {
    const genderMap = { male: '公', female: '母' };
    const filters = {};

    const keyword = kw || pageContext.data.searchKeyword;
    if (keyword) filters.keyword = keyword;
    if (pageContext.data.genderFilter) filters.gender = genderMap[pageContext.data.genderFilter];
    if (pageContext.data.statusFilter) filters.status = pageContext.data.statusFilter;
    if (pageContext.data.colorFilter) filters.color = pageContext.data.colorFilter;
    if (pageContext.data.campusFilter) filters.campus = pageContext.data.campusFilter;
    if (pageContext.data.ageFilter) filters.age = pageContext.data.ageFilter;
    // 好猫星级：'' 表示不筛；'3'/'4'/'5' 表示「至少 N 星」，云函数侧做白名单校验
    if (pageContext.data.adoptFilter) filters.adoptLevelMin = Number(pageContext.data.adoptFilter);
    // page 必须显式下发：此前从未赋值 → 云函数永远只返回第 1 页，
    // 命中数 > pageSize 时第 101 条起对用户不可达（列表计数显示总数却翻不出）。
    filters.page = page;
    filters.pageSize = 100;

    const res = await wx.cloud.callFunction({
      name: 'filterCats',
      data: { filters }
    });

    if (!res.result?.success) {
      throw new Error(res.result?.error || '云函数筛选失败');
    }

    return res.result.data;
  },

  async loadAllAndFilter(pageContext) {
    if (pageContext._loadingAll) return;
    pageContext._loadingAll = true;
    const allFilterStartTime = Date.now();

    try {
      const db = wx.cloud.database();
      const MAX_CATS_LIMIT = config.performance.maxCatsLoadLimit || 500;

      if (pageContext._searchEngine && pageContext._searchEngine.hasIndex()) {
        Logger.info('FilterService', '使用本地搜索索引进行筛选');
        const results = pageContext._searchFromIndex();
        if (results.length > 0) {
          // 只更新过滤视图，不覆盖 cats 全量列表：
          // cats 供 loadMore 追加去重使用，被搜索结果替换会导致全量列表丢失
          safePageSetData(pageContext, {
            filteredCats: results,
            filteredCatCount: results.length,
            hasSearched: true
          });
          return;
        }
      }

      const hasActiveFilter = !!(pageContext.data.searchKeyword ||
        pageContext.data.genderFilter || pageContext.data.colorFilter ||
        pageContext.data.campusFilter || pageContext.data.adoptFilter);
      const batchSize = hasActiveFilter ? 100 : 50;

      const { cats: allCats, batches } = await fetchAllCats(db, batchSize, MAX_CATS_LIMIT);

      Logger.info('FilterService', '分批加载完成', {
        totalLoaded: allCats.length,
        batches,
        duration: `${Date.now() - allFilterStartTime}ms`
      });

      const photoCountsMap = pageContext._photoCountsMap || {};
      // 同首屏幕档位（gallery，220rpx 卡片），避免全量筛选结果比首屏糊
      const catsWithUrl = await AvatarHelper.resolveCatAvatars(allCats, pageContext.data.cats, { photoCountsMap, type: 'gallery' });

      if (pageContext._searchEngine) {
        pageContext._buildSearchIndex(catsWithUrl);
      }

      safePageSetData(pageContext, {
        cats: catsWithUrl,
        colorOptions: pageContext._extractColorOptions(catsWithUrl)
      });
      // 降级：把当前筛选条件应用到刚加载的全量列表（本地筛选，不回页面筛选入口）
      FilterService._applyLocalFilter(pageContext);

      offlineCache.saveCats(catsWithUrl);

      if (allCats.length >= MAX_CATS_LIMIT * 0.8) {
        wx.showModal({
          title: '数据量较大',
          content: `已加载${allCats.length}只猫咪，建议使用更精确的筛选条件以获得更好体验`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      Logger.warn('FilterService', '加载全量数据失败，尝试离线缓存', err);

      const cachedCats = offlineCache.getCats();
      if (cachedCats && cachedCats.length > 0) {
        safePageSetData(pageContext, { cats: cachedCats });
        FilterService._applyLocalFilter(pageContext);
        wx.showToast({ title: '网络不佳，使用缓存数据', icon: 'none', duration: 2000 });
      } else {
        wx.showToast({ title: '加载失败，请重试', icon: 'none', duration: 2000 });
      }
    } finally {
      pageContext._loadingAll = false;
    }
  },

  async loadCatsByCampus(campus, pageContext) {
    // 复用页面的列表视图请求序号：校区切换与关键词筛选互斥，共用同一序号后，
    // 快速连点校区时只有最新一次请求能落盘，旧校区响应（含其失败降级）到达即丢弃。
    // 反方向（关键词在途时点校区）由 filterFromServer 的入口快照 seqAtStart 拦下，
    // 两边都自增/快照同一序号，互斥才是双向的
    pageContext._filterSeq = (pageContext._filterSeq || 0) + 1;
    const seq = pageContext._filterSeq;

    // FE-1（P1，2026-10-11 修）：此前这里自己做「count + .limit(20)」的客户端直连查询，
    // 既不写 _filterPage 也不写 hasMore；而触底走 _loadMoreFilteredCats → filterFromServer
    // 是按 `filters.page` 递增请求的。两套分页契约混用造成**必然**丢数据：
    //   第 1 页 pageSize=20（已交付第 1~20 条）
    //   第 2 页 page=2,pageSize=100 → 云函数 skip=(2-1)*100=100 → 取第 101~200 条
    //   第 21~100 条既没交付过、也永远不会被 skip 命中 → 静默丢失。
    // 表现是「共 45 只」只出 20 张卡、底部既无加载更多也无到底提示。
    //
    // 现在统一走 filterFromServer：它本来就支持 campus 筛选（_executeFilterCall 会带上
    // pageContext.data.campusFilter），且返回 total / hasMore、做了请求序号守卫、
    // 头像档位与筛选路径一致（gallery），失败还会降级到客户端全量筛选 ——
    // 也就是说这条路径原本就是为「带筛选条件的列表」设计的，不该另起一套。
    // 保留这里的序号自增：校区切换必须让在途的关键词请求作废。
    pageContext.data.campusFilter = campus || '';
    await FilterService.filterFromServer(pageContext, '', { page: 1, append: false });
    if (seq !== pageContext._filterSeq) return;

    // 校区态必须显式置 hasSearched：index.wxml 的加载态/空态分支按它决定是否渲染
    // （!hasSearched 才显示列表级 loading）。服务端返回空时 filterFromServer 会保留
    // 客户端兜底结果，这里补齐标记，避免空校区被渲染成「正在加载」。
    safePageSetData(pageContext, { hasSearched: !!campus });
  }
};

module.exports = FilterService;
