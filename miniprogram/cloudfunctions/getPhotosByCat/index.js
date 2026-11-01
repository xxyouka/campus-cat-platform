// 云函数：根据猫咪ID获取照片列表（分页）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;

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
  const { catId } = event;
  const page = Math.min(Math.max(1, parseInt(event.page) || 1), 1000);
  const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize) || 20));

  // 输入校验（防 NoSQL 注入）：确保 catId 是合法格式
  if (!catId || typeof catId !== 'string' || !CAT_ID_PATTERN.test(catId)) {
    return fail('猫咪ID格式无效');
  }

  const skip = (page - 1) * pageSize;

  try {
    // count 与 get 之间**没有数据依赖**（hasMore 只是两个数比大小），必须并行。
    // 旧实现是串行两次 await：每次翻页都白付一整个 RTT（热态实测该接口 ~0.53s，
    // 冷态 1.1s，其中约 1/3 就是这段等待）。
    const [countRes, res] = await Promise.all([
      // 先获取总数，确保 hasMore 判断准确。
      // `_mediaBlocked` 是内容安全回调打的拦截标记：被拦截的照片不能再出现在
      // 公开相册里（计数与列表必须同一口径，否则会出现「显示 N 张、点进去 N-1 张」）。
      db.collection(COLLECTIONS.PHOTOS)
        .where({ catId: catId, _mediaBlocked: _.neq(true) })
        .count(),
      db.collection(COLLECTIONS.PHOTOS)
        .where({ catId: catId, _mediaBlocked: _.neq(true) })
        .orderBy('likeCount', 'desc')
        .orderBy('createTime', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()
    ]);

    const total = countRes.total || 0;

    // 修复：用总数判断是否还有更多，避免最后一页正好等于 pageSize 时的误判
    const hasMore = skip + pageSize < total;

    // 标注当前用户对这批照片的点赞状态：详情页心形图标依赖 liked（客户端映射为 _liked）。
    // 缺少该字段会导致重进详情页点赞态重置、二次点击把「已赞」误翻成「未赞」。
    const photos = res.data || [];
    const likedIds = new Set();
    if (photos.length > 0) {
      const { OPENID } = cloud.getWXContext();
      const photoIds = photos.map(p => p._id).filter(Boolean);
      if (OPENID && photoIds.length > 0) {
        const likeRes = await db.collection(COLLECTIONS.PHOTO_LIKES)
          .where({ _openid: OPENID, photoId: _.in(photoIds) })
          .field({ photoId: true })
          .limit(photoIds.length)
          .get();
        for (const doc of likeRes.data || []) {
          likedIds.add(doc.photoId);
        }
      }
    }

    return ok({
      photos: photos.map(p => ({ ...p, liked: likedIds.has(p._id) })),
      total,
      hasMore
    });
  } catch (err) {
    console.error('[getPhotosByCat] 执行失败', err);
    return fail('获取照片失败，请稍后重试');
  }
};
