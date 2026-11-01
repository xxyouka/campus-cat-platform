// cloudfunctions/getCatRank/index.js - 获取猫咪人气排行榜
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const $ = db.command.aggregate;
const MAX_OFFSET = 10000;

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { type, limit = 50, offset = 0 } = event;
  const requestedOffset = Number(offset);
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > MAX_OFFSET) {
    return fail(`offset 必须是 0-${MAX_OFFSET} 之间的整数`);
  }

  try {
    const maxLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const skip = requestedOffset;
    let rankRes;

    if (type === 'view') {
      const catsRes = await db.collection(COLLECTIONS.CATS)
        .where({ viewCount: db.command.gt(0) })
        .field({ _id: true, name: true, avatar: true, campus: true, viewCount: true })
        .orderBy('viewCount', 'desc')
        .skip(skip)
        .limit(maxLimit)
        .get();

      const list = (catsRes.data || []).map((item, index) => ({
        rank: skip + index + 1,
        catId: item._id,
        catName: item.name || '未知猫咪',
        avatar: item.avatar || '',
        campus: item.campus || '',
        count: item.viewCount || 0
      }));

      return ok({ list, total: list.length });
    }

    if (type === 'fav') {
      const collection = COLLECTIONS.USER_FAVORITES;
      rankRes = await db.collection(collection)
        .aggregate()
        .group({ _id: '$catId', count: $.sum(1) })
        .sort({ count: -1 })
        .skip(skip)
        .limit(maxLimit)
        .end();
    } else if (type === 'meet') {
      rankRes = await db.collection(COLLECTIONS.RECORD_MEET)
        .aggregate()
        .group({ _id: '$catId', count: $.sum(1) })
        .sort({ count: -1 })
        .skip(skip)
        .limit(maxLimit)
        .end();
    } else {
      return fail('无效的排行类型');
    }

    if (!rankRes.list || rankRes.list.length === 0) {
      return ok({ list: [], total: 0 });
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
        rank: skip + index + 1,
        catId: item._id,
        catName: catMap[item._id].name || '未知猫咪',
        avatar: catMap[item._id].avatar || '',
        campus: catMap[item._id].campus || '',
        count: item.count
      }));

    return ok({ list, total: list.length });
  } catch (err) {
    console.error('[getCatRank] 获取排行榜失败:', err);
    return fail('获取排行榜失败，请稍后重试');
  }
};
