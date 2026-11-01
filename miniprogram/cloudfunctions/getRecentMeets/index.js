// cloudfunctions/getRecentMeets/index.js - 获取最近相遇打卡动态
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 文档ID格式校验：防止对象/操作符注入改变查询语义（同 getPhotosByCat）
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;

function toTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    if (typeof value.getTime === 'function') return value.getTime();
    if (value.$date) {
      if (typeof value.$date === 'number') return value.$date;
      if (typeof value.$date === 'string') {
        const parsed = Date.parse(value.$date);
        return isNaN(parsed) ? null : parsed;
      }
    }
  }
  return null;
}

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { catId, limit = 10 } = event;

  try {
    if (!catId || typeof catId !== 'string' || !CAT_ID_PATTERN.test(catId)) {
      return fail('缺少或无效的 catId 参数');
    }

    const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 50);

    const countRes = await db.collection(COLLECTIONS.RECORD_MEET)
      .where({ catId })
      .count();

    if (countRes.total === 0) {
      return ok({ meets: [], total: 0 }, '暂无相遇记录');
    }

    const res = await db.collection(COLLECTIONS.RECORD_MEET)
      .where({ catId })
      .orderBy('createTime', 'desc')
      .limit(safeLimit)
      .get();

    const meets = (res.data || []).map(log => {
      const createTime = toTimestamp(log.createTime) || toTimestamp(log.meetTime) || Date.now();
      const meetTime = toTimestamp(log.meetTime) || createTime;

      return {
        _id: log._id,
        statusTag: log.statusTag || '',
        location: log.location || log.campus || '',
        createTime: createTime,
        meetTime: meetTime
      };
    });

    return ok({
      meets,
      total: countRes.total
    });
  } catch (err) {
    console.error('[getRecentMeets] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};
