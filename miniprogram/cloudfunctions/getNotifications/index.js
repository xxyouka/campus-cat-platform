// cloudfunctions/getNotifications/index.js
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { OPENID } = cloud.getWXContext();
  const { unreadOnly = false } = event;
  // 分页参数钳制：防止恶意大 page/pageSize 造成深分页资源消耗
  const page = Math.min(Math.max(1, parseInt(event.page, 10) || 1), 1000);
  const pageSize = Math.min(Math.max(1, parseInt(event.pageSize, 10) || 20), 100);

  try {
    const query = { _openid: OPENID };
    
    if (unreadOnly) {
      query.isRead = false;
    }

    // 页面列表、分页总数与未读总数互不依赖，合并并发请求以少等两个数据库往返。
    const [res, totalRes, unreadCountRes] = await Promise.all([
      db.collection(COLLECTIONS.NOTIFICATIONS)
        .where(query)
        .orderBy('createTime', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        // 不向客户端暴露打卡者 openid（通知文档内部字段）
        .field({ visitorOpenid: false })
        .get(),
      // 对列表同条件做 count：恰好整页时不会多发一次空请求（同 getNotices 口径）
      db.collection(COLLECTIONS.NOTIFICATIONS)
        .where(query)
        .count(),
      db.collection(COLLECTIONS.NOTIFICATIONS)
        .where({ _openid: OPENID, isRead: false })
        .count()
    ]);

    const notifications = res.data || [];
    const total = totalRes.total || 0;

    const catIds = [...new Set(notifications.map(n => n.catId).filter(Boolean))];
    const catAvatarMap = {};
    if (catIds.length > 0) {
      try {
        const BATCH_SIZE = 100;
        for (let i = 0; i < catIds.length; i += BATCH_SIZE) {
          const batch = catIds.slice(i, i + BATCH_SIZE);
          const catRes = await db.collection(COLLECTIONS.CATS)
            .where({ _id: db.command.in(batch) })
            .field({ _id: true, avatar: true, name: true })
            .limit(BATCH_SIZE)
            .get();
          (catRes.data || []).forEach(cat => {
            if (cat.avatar) catAvatarMap[cat._id] = cat.avatar;
          });
        }
      } catch (catErr) {
        console.warn('[getNotifications] 查询猫咪头像失败:', catErr.message);
      }
    }

    const enrichedNotifications = notifications.map(n => ({
      ...n,
      catAvatar: n.catAvatar || catAvatarMap[n.catId] || ''
    }));

    // 用 total 判断分页，恰好整页时不会多发一次空请求
    return ok({
      notifications: enrichedNotifications,
      hasMore: page * pageSize < total,
      unreadCount: unreadCountRes.total || 0
    });
  } catch (err) {
    console.error('[getNotifications] 失败:', err);
    return fail('获取通知失败');
  }
};
