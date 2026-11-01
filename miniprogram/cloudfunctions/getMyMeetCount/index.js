// cloudfunctions/getMyMeetCount/index.js - 获取当前用户相遇打卡总数
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 入参白名单：与 getRecentMeets / getShareData 同口径（cloudId/日期类参数一律先校验再进 where）
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext();
  const { catId, date } = event;

  try {
    const where = { _openid: OPENID };

    // catId 直接进 where 等值条件：传对象（如 {"$ne": null}）会把「这只猫的本人打卡数」
    // 静默放大成「本人全部打卡数」，接口仍返回 success —— 属误导性输出，必须硬校验。
    if (catId !== undefined && catId !== null && catId !== '') {
      if (typeof catId !== 'string' || !CAT_ID_PATTERN.test(catId)) {
        return fail('无效的 catId 格式');
      }
      where.catId = catId;
    }

    if (date) {
      // 只接受 YYYY-MM-DD：容器时区为 UTC，按 +08:00 解析成北京时间自然日
      if (typeof date !== 'string' || !DATE_ONLY_RE.test(date)) {
        return fail('日期格式不正确（YYYY-MM-DD）');
      }
      const dayStart = new Date(`${date}T00:00:00+08:00`).getTime();
      const parsedBeijingDate = Number.isNaN(dayStart)
        ? ''
        : new Date(dayStart + 8 * 3600 * 1000).toISOString().slice(0, 10);
      if (!parsedBeijingDate || parsedBeijingDate !== date) {
        return fail('日期格式不正确（YYYY-MM-DD）');
      }
      const dayEnd = dayStart + 24 * 3600 * 1000;
      where.meetTime = _.gte(dayStart).and(_.lt(dayEnd));
    }

    const res = await db.collection(COLLECTIONS.RECORD_MEET)
      .where(where)
      .count();

    return ok({ count: res.total });
  } catch (err) {
    console.error('[getMyMeetCount] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};
