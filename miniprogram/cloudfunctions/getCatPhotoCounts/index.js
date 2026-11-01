// cloudfunctions/getCatPhotoCounts/index.js - 获取各猫咪照片数量（带缓存）
const cloud = require('wx-server-sdk');
const CloudCache = require('./utils/cache');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { AGG_LIMIT, readGroupedCounts, fillCountsByCount } = require('./utils/photoCounts');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

/** 单页猫咪数（取全量猫 id 用） */
const CAT_PAGE = 100;
/** 取全量猫 id 的翻页上限（100 × 50 = 5000 只），防御性死循环保护 */
const CAT_PAGE_MAX = 50;

function handleError(err, operation = '操作') {
  console.error(`${operation}失败:`, err);
  return fail(`${operation}失败，请稍后重试`);
}

function successResponse(message = '操作成功', data = {}) {
  return ok(data, message);
}

/**
 * 分页取全部猫咪 _id。
 *
 * 只在「聚合结果不完整」的降级分支里用：逐只 count 兜底需要知道有哪些猫，
 * 而本函数的正常路径**不需要**猫列表（前端只做 map[catId] 查表）。
 */
async function getAllCatIds() {
  const ids = [];

  for (let page = 0; page < CAT_PAGE_MAX; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await db.collection(COLLECTIONS.CATS)
      .field({ _id: true })
      .skip(page * CAT_PAGE)
      .limit(CAT_PAGE)
      .get();
    const rows = res.data || [];
    rows.forEach(cat => ids.push(cat._id));
    if (rows.length < CAT_PAGE) break;
  }

  return ids;
}

exports.main = async (_event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (_event && _event._keepWarm) return ok({ _keepWarm: true });

  try {
    const cacheKey = 'catPhotoCounts:all';

    // 缓存 TTL 30s（原先 10s）：照片数是极低频变更的统计值，
    // 而这是首页首屏 await 的三请求之一，TTL 直接决定冷缓存频率。
    // 10s 缓存几乎不命中（用户两次进首页间隔通常大于 10s），
    // 等于每次首屏都付一次聚合成本。30s 命中率高得多，统计口径无感知。
    const result = await CloudCache.getOrSet(cacheKey, async () => {
      // 不再先调 getAllCatIds() 拿全量猫 ID 做 $.in() 白名单。
      // 原实现为了让聚合只统计「现存猫」而先全表扫一遍 cats，
      // 但：
      //   1. 前端只做 `photoCountsMap[cat._id] ?? 0` 的按需查表，
      //      聚合多返回已删猫的键根本用不到（mediaHelper.js:86）；
      //   2. 那个白名单的唯一实际用途是 `existingCatIds.size` —— 只用于打日志。
      // 白名单既无业务价值，又让首页首屏串行多等一次全表扫
      // （实测冷缓存下 loadCats-parallel 达2166ms，阈值 1000ms）。
      // 改为直接对全部 photos 按 catId 分组，查询从「扫 cats + 分批聚合」
      // 缩成单次聚合，与totalPhotos / totalViews 两次聚合并发。
      // （只有下面的降级分支才会去调 getAllCatIds() 取全量猫 id。）
      //
      // **limit 必须显式写**：聚合不写 limit 时只回 20 组且不报错，
      // 第 21 只猫起在首页/详情页会静默显示 0 张（2026-10-12 线上复现：
      // 65 只有照片的猫只回 20 组、计数之和 398 对 真值 955）。
      // 详见 utils/photoCounts.js。
      const [countAggRes, photosCountRes, viewAggRes] = await Promise.all([
        db.collection(COLLECTIONS.PHOTOS)
          .aggregate()
          .match({ _mediaBlocked: _.neq(true) })
          .group({
            _id: '$catId',
            count: $.sum(1)
          })
          .limit(AGG_LIMIT)
          .end(),
        db.collection(COLLECTIONS.PHOTOS)
          .where({ _mediaBlocked: _.neq(true) })
          .count(),
        db.collection(COLLECTIONS.CATS)
          .aggregate()
          .group({
            _id: null,
            totalViews: $.sum('$viewCount')
          })
          .end()
      ]);

      const totalPhotos = photosCountRes && photosCountRes.total || 0;
      const totalViews = viewAggRes.list && viewAggRes.list[0] && viewAggRes.list[0].totalViews || 0;

      const grouped = readGroupedCounts(countAggRes && countAggRes.list);
      let countMap = grouped.counts;
      let countsDegraded = false;

      // 完整性不变式：分组是 photos 的一个划分，计数之和必须等于照片总数。
      // 不等 → 被截断（隐式 20 条上限、或照片数超过 AGG_LIMIT）或分组键形态不对，
      // 缺的猫会退化成「0 张」。此时降级为逐只 count：宁可慢，不能给错数。
      if (grouped.sum !== totalPhotos) {
        countsDegraded = true;
        console.error('[getCatPhotoCounts] 分组计数与照片总数不一致，判定聚合结果被截断，降级逐只 count:', {
          groupedSum: grouped.sum,
          totalPhotos,
          groupedKeys: Object.keys(grouped.counts).length
        });
        const catIds = await getAllCatIds();
        countMap = await fillCountsByCount(
          db,
          COLLECTIONS.PHOTOS,
          catIds,
          { _mediaBlocked: _.neq(true) }
        );
      }

      console.info(
        '[getCatPhotoCounts] 查询完成, 有照片的猫咪数:', Object.keys(countMap).length,
        '照片总数:', totalPhotos,
        '计数降级:', countsDegraded
      );
      return { counts: countMap, totalPhotos, totalViews, countsDegraded };
    }, 30);

    return successResponse('获取成功', result);
  } catch (err) {
    return handleError(err, '获取猫咪照片数量');
  }
};
