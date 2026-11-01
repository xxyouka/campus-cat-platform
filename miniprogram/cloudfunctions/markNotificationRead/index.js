// cloudfunctions/markNotificationRead/index.js - 标记通知为已读
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 「全部已读」批量更新的最大轮次（防止极端情况下循环不退出的兜底）
const MAX_UPDATE_ROUNDS = 20;

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext();
  const { notificationId, notificationIds, markAll } = event;

  try {
    if (markAll) {
      // 云函数端 where().update() 支持批量更新，一次即可覆盖全部命中记录；
      // 旧实现用 .field().limit(100).get() 后只更新前 100 条且不分页续跑，
      // 活跃用户未读通知超过 100 条时红点永远消不掉。
      // 仍保留循环兜底：若单次更新存在记录数上限，后续轮次继续清直到没有未读为止。
      // 归属校验必须保留：where 中的 _openid 限定只能改本人通知。
      let updatedCount = 0;

      for (let round = 0; round < MAX_UPDATE_ROUNDS; round++) {
        const updateRes = await db.collection(COLLECTIONS.NOTIFICATIONS)
          .where({ _openid: OPENID, isRead: false })
          .update({ data: { isRead: true, readTime: new Date() } });

        const updated = updateRes && updateRes.stats && updateRes.stats.updated || 0;
        if (updated === 0) break;

        updatedCount += updated;
      }

      // updatedCount 语义 = 本次实际标记为已读的条数，与「全部已读」后的未读数归零一致
      return ok({ updatedCount });
    }

    const rawIds = notificationIds
      ? Array.isArray(notificationIds) ? notificationIds : [notificationIds]
      : notificationId ? [notificationId] : [];

    if (rawIds.length === 0) {
      return fail('缺少通知ID参数');
    }

    // 归属校验：仅允许标记本人名下的通知，防止越权修改他人已读状态
    const ownedRes = await db.collection(COLLECTIONS.NOTIFICATIONS)
      .where({ _id: _.in(rawIds.slice(0, 100)), _openid: OPENID })
      .field({ _id: true })
      .limit(100)
      .get();
    const ownedIds = (ownedRes.data || []).map(n => n._id);

    if (ownedIds.length === 0) {
      return ok({ updatedCount: 0, totalRequested: rawIds.length });
    }

    const updatePromises = ownedIds.map(id =>
      db.collection(COLLECTIONS.NOTIFICATIONS).doc(id).update({
        data: { isRead: true, readTime: new Date() }
      }).catch(() => null)
    );

    const results = await Promise.all(updatePromises);
    const successCount = results.filter(r => r !== null).length;

    return ok({ updatedCount: successCount, totalRequested: rawIds.length });

  } catch (err) {
    console.error('[markNotificationRead] 失败:', err);
    return fail('标记已读失败');
  }
};
