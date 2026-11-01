// cloudfunctions/getFavRank/index.js - 猫咪收藏排行榜（管理端）
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const $ = db.command.aggregate;

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  // HTTP触发器适配
  if (event.body && typeof event.body === 'string') {
    try { const parsed = JSON.parse(event.body); event = { ...event, ...parsed }; } catch (e) { /* ignore */ }
  }
  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';

  try {
    const authResult = await checkAdmin(db, OPENID, { operation: '查看收藏排行', adminAccount });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    const requestedLimit = Number(event.limit ?? 50);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;

    const rankRes = await db.collection(COLLECTIONS.USER_FAVORITES)
      .aggregate()
      .group({
        _id: '$catId',
        count: $.sum(1)
      })
      .sort({ count: -1 })
      .limit(limit)
      .end();

    if (!rankRes.list || rankRes.list.length === 0) {
      return ok({ list: [] });
    }

    const catIds = rankRes.list.map(item => item._id);

    const catsRes = await db.collection(COLLECTIONS.CATS)
      .where({ _id: db.command.in(catIds) })
      .field({ name: true, avatar: true, campus: true })
      .get();

    const catMap = {}
    ;(catsRes.data || []).forEach(cat => {
      catMap[cat._id] = cat;
    });

    const list = rankRes.list
      .filter(item => catMap[item._id])
      .map((item, index) => ({
        rank: index + 1,
        catId: item._id,
        catName: catMap[item._id].name || '未知猫咪',
        avatar: catMap[item._id].avatar || '',
        campus: catMap[item._id].campus || '',
        count: item.count
      }));

    return ok({ list });
  } catch (err) {
    console.error('[getFavRank] 获取排行榜失败:', err);
    return fail('获取排行榜失败，请稍后重试');
  }
};
