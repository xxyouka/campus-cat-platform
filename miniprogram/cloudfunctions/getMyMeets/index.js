// cloudfunctions/getMyMeets/index.js - 获取当前用户相遇打卡记录（分页）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { OPENID } = cloud.getWXContext();
  const page = Math.min(Math.max(1, parseInt(event.page) || 1), 1000);
  const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize) || 20));

  try {
    const skip = (page - 1) * pageSize;

    // 总数与当前页只依赖用户身份，彼此独立；并发读取可省去一个数据库往返。
    const [countRes, res] = await Promise.all([
      db.collection(COLLECTIONS.RECORD_MEET)
        .where({ _openid: OPENID })
        .count(),
      db.collection(COLLECTIONS.RECORD_MEET)
        .where({ _openid: OPENID })
        .orderBy('meetTime', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()
    ]);

    const total = countRes.total;

    const meets = res.data || [];

    const catIds = [...new Set(meets.map(m => m.catId).filter(Boolean))];
    const catInfoMap = {};
    if (catIds.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < catIds.length; i += BATCH_SIZE) {
        const batch = catIds.slice(i, i + BATCH_SIZE);
        try {
          const catRes = await db.collection(COLLECTIONS.CATS)
            .where({ _id: _.in(batch) })
            .field({ _id: true, avatar: true, name: true })
            .limit(BATCH_SIZE)
            .get();
          (catRes.data || []).forEach(cat => {
            catInfoMap[cat._id] = { name: cat.name || '', avatar: cat.avatar || '' };
          });
        } catch (catErr) {
          console.warn('[getMyMeets] 查询猫咪信息失败:', catErr.message);
        }
      }
    }

    const result = meets.map(m => {
      const catInfo = catInfoMap[m.catId] || {};
      return {
        _id: m._id,
        catId: m.catId,
        catName: m.catName || catInfo.name || '',
        catAvatar: m.catAvatar || catInfo.avatar || '',
        location: m.location || m.campus || '',
        campus: m.campus || '',
        statusTag: m.statusTag || '',
        note: m.note || '',
        meetTime: m.meetTime,
        createTime: m.createTime
      };
    });

    return ok({
      meets: result,
      total,
      hasMore: result.length === pageSize && skip + result.length < total
    });
  } catch (err) {
    console.error('[getMyMeets] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};
