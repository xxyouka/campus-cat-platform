// 云函数：批量获取相册信息（猫咪 + 照片数）
// 照片数走 utils/photoCounts.js 的共享实现：聚合**必须显式 limit**，
// 否则运行时只回 20 组且不报错（「有照片却显示 0 张」的根因），
// 并用「分组计数之和 == 照片总数」校验完整性，不成立就降级逐只 count。
const cloud = require('wx-server-sdk');
const { CloudLogger, CloudErrorHandler } = require('./utils/logger');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { COLLECTIONS } = require('./utils/constants');
const { AGG_LIMIT, readGroupedCounts, fillCountsByCount } = require('./utils/photoCounts');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

/**
 * 安全转义正则特殊字符（与 filterCats 同实现，避免关键词把 $regex 写成非法表达式）
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造 cats 查询条件：删除中的不可见 + 可选关键词过滤。
 *
 * 抽成独立函数是为了让 main 压回行数上限内，也让「列表与计数必须共用同一份
 * where」这件事在结构上无法分开 —— 一旦拆成两处，搜索态的 total 就会退回全库数，
 * hasMore 与「找到 N 个」一起失真，且不报任何错。
 *
 * @param {string} keyword 已 trim 的搜索词（空串 = 不过滤）
 * @returns {Object} 可直接交给 .where() 的条件
 */
function buildCatsWhere(keyword) {
  const where = { _deleting: _.neq(true) };
  if (!keyword) return where;

  // 口径与 filterCats 完全一致：匹配 name / color / location，大小写不敏感
  const regex = { $regex: escapeRegex(keyword), $options: 'i' };
  where.$or = [
    { name: regex },
    { color: regex },
    { location: regex }
  ];
  return where;
}

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  // 入口权限：相册列表只服务「照片管理」入口，关闭该入口后云函数也必须拒绝。
  const { OPENID } = cloud.getWXContext();
  const authResult = await checkAdmin(db, OPENID, {
    operation: '照片管理',
    adminAccount: event._adminAccount || '',
    permission: 'photo'
  });
  if (!authResult.isAdmin) return fail(authResult.error);

  // 分页参数钳制：防止恶意大 page/pageSize 造成深分页资源消耗
  const page = Math.min(Math.max(0, parseInt(event.page, 10) || 0), 1000);
  const pageSize = Math.min(Math.max(1, parseInt(event.pageSize, 10) || 50), 100);
  const skip = page * pageSize;

  // 关键词搜索（管理端相册列表用）：口径与 filterCats 完全一致 ——
  // 匹配 name / color / location，同样转义后按大小写不敏感匹配。
  // 为什么必须放服务端而不是客户端过滤：本页只加载了 pageSize（管理端取 100）条，
  // 客户端过滤只能搜到**已加载的那部分**。超过 100 只猫时，管理员搜一只在第 3 页的猫
  // 会得到「没有找到」，而它明明在库里 —— 又是一个静默给错答案的地方。
  const keyword = typeof event.keyword === 'string' ? event.keyword.trim() : '';

  // 列表与计数共用同一份 where：否则 total 永远是全库数，
  // 搜索态下的 hasMore / 「找到 N 个」全是错的。
  const baseWhere = buildCatsWhere(keyword);

  try {
    CloudLogger.log('getAlbumsWithInfo', '开始执行', { page, pageSize, keyword });

    const [catsRes, countResult] = await Promise.all([
      // 过滤删除中的猫（_deleting 标记）：与 filterCats / 客户端可见性口径一致。
      // 不滤会出现「首页/管理端已看不到、公开相册列表却永久留存」的幽灵相册，
      // 而 cat-manage 看不到它 → 无法再次发起删除，只能进数据库控制台清理。
      db.collection(COLLECTIONS.CATS)
        .where(baseWhere)
        .orderBy('updateTime', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get(),
      db.collection(COLLECTIONS.CATS).where(baseWhere).count()
    ]);

    const cats = catsRes.data || [];
    if (cats.length === 0) {
      // total 必须一起给：搜索到底时客户端要靠它把「找到 N 只」清零，
      // 缺了这个字段就会一直保留上一次搜索的数字。
      CloudLogger.log('getAlbumsWithInfo', '无更多数据', { keyword });
      return ok({ albums: [], total: countResult.total || 0, hasMore: false });
    }

    const catIds = cats.map(c => c._id);

    let photoCountsMap = {};
    let countsDegraded = false;

    try {
      // **定向聚合**（2026-10-18 性能）：先 match 到本页的 catIds 再 group。
      //
      // 旧实现是全表 group + 全表 count，两次全表扫描；热态实测 0.64~0.86s
      // （线上日志 1.1~1.6s），已经把 1000ms 阈值吃掉 64~86%，稍微一冷必超。
      // match 走 photos 的 catId 索引（catId+status+createTime 已在），
      // 扫描范围从「全部照片」缩到「本页 N 只猫的照片」。
      //
      // 注意 in 用的是**查询命令** `_.in`（db.command.in），不是聚合表达式 `$.in`：
      // 历史两轮「match 无效」的误判就是因为写成了 `$.in(catIds)` —— 那是聚合算子，
      // 放进 match 里匹配不到任何文档，看起来就像 match 本身不工作。
      //
      // **显式 .limit() 不能省**：聚合不写 limit 时只返回前 20 条结果且不抛异常 ——
      // 第 21 组起的猫会静默显示「0 张」（2026-10-12 线上复现：955 张照片 / 65 只猫，
      // 只回 20 组、45 只猫显示 0 张）。详见 utils/photoCounts.js。
      //
      // 完整性基准必须与分组**同一范围**：旧实现拿全集合 count 当分母，
      // 只要库里存在一条 catId 缺失/为空的记录，分组之和就永远小于它 →
      // 不变式恒不成立 → 每次调用都静默降级逐只 count（慢一倍 + 每次一条 error 日志）。
      // 改成 where({ catId: in(catIds) }).count() 后，两边同范围，那个雷一并拆掉。
      const [countRes, photosTotalRes] = await Promise.all([
        db.collection(COLLECTIONS.PHOTOS)
          .aggregate()
          .match({ catId: _.in(catIds), _mediaBlocked: _.neq(true) })
          .group({
            _id: '$catId',
            count: $.sum(1)
          })
          .limit(AGG_LIMIT)
          .end(),
        db.collection(COLLECTIONS.PHOTOS)
          .where({ catId: _.in(catIds), _mediaBlocked: _.neq(true) })
          .count()
      ]);

      const grouped = readGroupedCounts(countRes && countRes.list);
      photoCountsMap = grouped.counts;

      // 完整性不变式：分组是「本页 catIds 范围内照片」的一个划分，计数之和必须等于
      // 该范围内的照片数。不等 → 结果被截断（隐式 20 条上限、或本页猫数超过 AGG_LIMIT）
      // 或分组键形态不对；此时缺的键会退化成「0 张」，必须降级而不是照发。
      // 旧实现在这里只判「本页一只猫都没命中」，漏掉了「部分截断」——
      // 而部分截断正是线上真实形态（每次调用截到哪 20 组都不一定相同）。
      const photosTotal = photosTotalRes && photosTotalRes.total || 0;
      if (grouped.sum !== photosTotal) {
        countsDegraded = true;
        CloudLogger.error('getAlbumsWithInfo', '分组计数与照片总数不一致，判定聚合结果被截断，降级逐只 count', {
          groupedSum: grouped.sum,
          photosTotal,
          catCount: catIds.length,
          groupedKeys: Object.keys(grouped.counts).length
        });
        photoCountsMap = await fillCountsByCount(db, COLLECTIONS.PHOTOS, catIds, { _mediaBlocked: _.neq(true) });
      }
    } catch (photoErr) {
      // 兜底必须留着：聚合一旦失败，photoCountsMap 为空 → **所有相册静默显示 0 张**，
      // 而管理端唯一的线索是「点进去其实有照片」，矛盾且无从排查。
      countsDegraded = true;
      CloudLogger.error('getAlbumsWithInfo', '聚合查询失败，降级为逐只 count', {
        error: photoErr.message,
        catCount: catIds.length
      });
      photoCountsMap = await fillCountsByCount(db, COLLECTIONS.PHOTOS, catIds, { _mediaBlocked: _.neq(true) });
    }

    // 计数表按 catId 查表，缺省即 0（真的没照片的猫不会出现在分组结果里）。
    // 降级时这张表已由逐只 count 填好（含 0 张的猫），取值口径完全一致。
    const albumsWithInfo = cats.map(cat => {
      const photoCount = Number(photoCountsMap[cat._id]) || 0;
      // 头像被内容安全拦截时不能再把 fileID 下发给公开页（读侧兜底；
      // 正常处置路径是 mediaReview 的 block 直接清空 cats.avatar）
      const publicAvatar = cat._mediaBlocked === true ? '' : cat.avatar || '';

      let coverUrl = publicAvatar;
      if (!coverUrl && cat.images && cat.images.length > 0) {
        coverUrl = cat.images[0];
      }

      return {
        catId: cat._id,
        catName: cat.name || '未知',
        catAvatar: publicAvatar,
        catStatus: cat.status,
        photoCount,
        coverUrl,
        _hasAvatar: !!publicAvatar,
        _hasImages: !!(cat.images && cat.images.length > 0)
      };
    });

    // 本函数 page 从 0 起（skip = page*pageSize）；用 total 判断，恰好整页时不会多发一次空请求
    const hasMore = (page + 1) * pageSize < (countResult.total || 0);

    CloudLogger.log('getAlbumsWithInfo', '执行成功', {
      count: albumsWithInfo.length,
      total: countResult.total,
      hasMore,
      countsDegraded,
      photoCountsSample: albumsWithInfo.slice(0, 5).map(a => `${a.catName}:${a.photoCount}`)
    });

    return ok({
      albums: albumsWithInfo,
      total: countResult.total,
      hasMore,
      // 计数降级标记：聚合不可用/结果被截断，已改走逐只 count。
      // 降级后的计数是**逐只 count 的精确值**（不是估算），代价只是更慢；
      // 客户端可据此提示/记录，避免再次出现「列表 0 张、点进去有照片」
      // 这种只有用户能发现的矛盾（本次问题就是这么被发现的）。
      countsDegraded
    });

  } catch (err) {
    return CloudErrorHandler.handle('getAlbumsWithInfo', err);
  }
};
