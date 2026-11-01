// 云函数：获取公告列表
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, _context) => {
  event = event && typeof event === 'object' ? event : {};
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
  // 分页参数钳制：page/pageSize 均需 parseInt，否则非法字符串会得到 NaN 导致查询异常
  const page = Math.min(Math.max(1, parseInt(event.page, 10) || 1), 1000);
  const pageSize = Math.min(Math.max(1, parseInt(event.pageSize, 10) || 20), 100);

  try {
    // 历史公告（manageNotice 修复前发布的）没有 status 字段，
    // 查询时将其视为已发布，避免存量公告对客户端不可见
    const whereCondition = _.or([
      { status: 'published' },
      { status: _.exists(false) }
    ]);

    // 首页只需检查最新一条公告时间，不依赖总数/分页状态；跳过 count()，
    // 避免每次冷启动都对公告集合做一次全量计数。
    if (event.latestOnly === true) {
      const latestRes = await db.collection(COLLECTIONS.NOTICES)
        .where(whereCondition)
        .orderBy('createTime', 'desc')
        .limit(1)
        .get();
      return ok({ notices: latestRes.data || [], page: 1, pageSize: 1 });
    }

    const [countRes, dataRes] = await Promise.all([
      db.collection(COLLECTIONS.NOTICES).where(whereCondition).count(),
      db.collection(COLLECTIONS.NOTICES)
        .where(whereCondition)
        .orderBy('createTime', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get()
    ]);

    return ok({
      notices: dataRes.data || [],
      total: countRes.total || 0,
      page,
      pageSize,
      hasMore: page * pageSize < (countRes.total || 0)
    });
  } catch (err) {
    console.error('[getNotices] 失败:', err);
    return fail('获取公告失败，请稍后重试');
  }
};
