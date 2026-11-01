// cloudfunctions/getAdminStats/index.js - 获取管理后台统计数据
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { beijingDayKey } = require('./utils/beijingTime');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 统计结果的容器内缓存时长（毫秒）。
//
// 统计是「全表扫描 + 去重」的重活：每次调用都要扫 cats（游标）、meets（游标，按
// 北京时间自然日去重）、userFavorites（游标，按 openid+catId 去重）三张表。
// 而管理端一次会话里会反复进出控制台（首页 → 子页 → 返回），每次都重算等于把同一份
// 结果算好几遍（2026-10-15 性能复盘：admin 页切换均值 3758ms）。
//
// 容器由 keepWarm 每 5 分钟保活，所以这里 60s 的命中率显著高于冷容器场景。
// 两条边界：① 鉴权（checkAdmin）永远在缓存**之前**执行，缓存不绕过权限；
// ② 缓存只写成功结果，任何异常都回落成真实计算 —— 缓存永远不是数据源。
const STATS_CACHE_TTL_MS = 60 * 1000;
let statsCache = null; // { stats, at }

async function getExistingCatIds() {
  const catIds = new Set();
  const MAX_LIMIT = 1000;
  const _ = db.command;
  let lastId = null;

  do {
    // orderBy('_id','asc') 是游标分页的前提：云数据库不对结果顺序做任何保证，
    // 无排序时 lastId 之后可能出现更小的 _id 未被取到 → 统计静默少算。
    // 同 syncFavorites:87 / getMeetCalendar:42 / getFilterOptions:69 的口径。
    let query = db.collection(COLLECTIONS.CATS)
      .field({ _id: true })
      .orderBy('_id', 'asc')
      .limit(MAX_LIMIT);

    if (lastId) {
      query = query.where({ _id: _.gt(lastId) });
    }

    const batch = await query.get();
    if (!batch.data || batch.data.length === 0) break;

    batch.data.forEach(item => catIds.add(item._id));
    lastId = batch.data[batch.data.length - 1]._id;
  } while (lastId);

  return catIds;
}

async function countUniqueFavorites(existingCatIds) {
  try {
    const MAX_LIMIT = 1000;
    const _ = db.command;
    let lastId = null;
    const seen = new Set();

    do {
      // 同 getExistingCatIds：游标分页必须配 orderBy，否则记录被静默跳过
      let query = db.collection(COLLECTIONS.USER_FAVORITES)
        .field({ _openid: true, catId: true })
        .orderBy('_id', 'asc')
        .limit(MAX_LIMIT);

      if (lastId) {
        query = query.where({ _id: _.gt(lastId) });
      }

      const batch = await query.get();
      if (!batch.data || batch.data.length === 0) break;

      batch.data.forEach(item => {
        if (existingCatIds.has(item.catId)) {
          const key = `${item._openid}:${item.catId}`;
          seen.add(key);
        }
      });

      lastId = batch.data[batch.data.length - 1]._id;
    } while (lastId);

    return seen.size;
  } catch (err) {
    console.warn('[countUniqueFavorites] 去重计数失败，使用普通计数:', err.message);
    const res = await db.collection(COLLECTIONS.USER_FAVORITES).count().catch(() => ({ total: 0 }));
    return res.total || 0;
  }
}

async function countUniqueMeets(existingCatIds) {
  try {
    const MAX_LIMIT = 1000;
    const _ = db.command;
    let lastId = null;
    const seen = new Set();

    do {
      // 同 getExistingCatIds：游标分页必须配 orderBy，否则去重键漏算
      let query = db.collection(COLLECTIONS.RECORD_MEET)
        .field({ _openid: true, catId: true, meetTime: true })
        .orderBy('_id', 'asc')
        .limit(MAX_LIMIT);

      if (lastId) {
        query = query.where({ _id: _.gt(lastId) });
      }

      const batch = await query.get();
      if (!batch.data || batch.data.length === 0) break;

      batch.data.forEach(item => {
        if (existingCatIds.has(item.catId)) {
          // 按北京时间自然日去重：toDateString() 走容器本地时区(UTC)，
          // 会把北京时间 0:00-8:00 的打卡归到前一天，与 getMeetCalendar 的日历口径对不上
          const day = beijingDayKey(item.meetTime);
          const key = `${item._openid}:${item.catId}:${day}`;
          seen.add(key);
        }
      });

      lastId = batch.data[batch.data.length - 1]._id;
    } while (lastId);

    return seen.size;
  } catch (err) {
    console.warn('[countUniqueMeets] 去重计数失败，使用普通计数:', err.message);
    const res = await db.collection(COLLECTIONS.RECORD_MEET).count().catch(() => ({ total: 0 }));
    return res.total || 0;
  }
}

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  // HTTP触发器适配：解析body中的JSON数据
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  try {
    const authResult = await checkAdmin(db, OPENID, { operation: '获取统计数据', adminAccount });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    // 鉴权通过后才看缓存（顺序不能反：缓存不能成为绕过权限的路径）
    if (statsCache && Date.now() - statsCache.at < STATS_CACHE_TTL_MS) {
      return ok({ stats: statsCache.stats, computedAt: statsCache.at });
    }

    const existingCatIds = await getExistingCatIds();

    const [catsRes, photosRes, uniqueMeets, uniqueFavorites] = await Promise.all([
      db.collection(COLLECTIONS.CATS).count().catch(() => ({ total: 0 })),
      db.collection(COLLECTIONS.PHOTOS).count().catch(() => ({ total: 0 })),
      countUniqueMeets(existingCatIds),
      countUniqueFavorites(existingCatIds)
    ]);

    const result = {
      stats: {
        totalCats: catsRes.total || 0,
        totalPhotos: photosRes.total || 0,
        totalMeets: uniqueMeets,
        totalFavorites: uniqueFavorites
      }
    };

    // computedAt 是**这份数字算出来的时刻**（命中缓存时早于本次请求）：
    // 客户端用它渲染「更新于」，避免把 60s 前的快照显示成「刚更新」。
    statsCache = { stats: result.stats, at: Date.now() };

    return ok({ ...result, computedAt: statsCache.at });
  } catch (err) {
    console.error('[getAdminStats] 获取统计数据失败:', err);
    return fail('获取统计数据失败，请重试');
  }
};
