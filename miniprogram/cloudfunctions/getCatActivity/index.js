// cloudfunctions/getCatActivity/index.js - 猫咪行动分析（管理端 · 仅超级管理员）
//
// 两种模式共用一个入口（鉴权与硬闸完全一致，差别只在扫描与聚合）：
//   scope='single'（默认）：单只猫的行动规律 + 活动轨迹（catId 必填）；
//   scope='all'：全部小猫的总轨迹 —— 按猫分组的点位轨迹，供一张图看所有路线。
//
// 数据来源：recordMeet 的相遇打卡。**纯只读** —— 不写库、不改打卡流程，
// 页面上的一切结论都由这里每次现算（60 秒容器内缓存），永远跟最新打卡同步。
//
// 两条数据质量边界在响应体里如实标注，页面据此提示用户：
//   1. location 是用户手输/快捷短语，默认「校园内」= 没填具体地点 → 不进地点榜；
//   2. point 是地图选点上线（2026-10）后才有的字段，存量极少 → 地图部分随打卡慢慢长出来。
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const CloudCache = require('./utils/cache');
const { CloudLogger } = require('./utils/logger');
const { analyze, analyzeTrails, LIMITS } = require('./analysis');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 与 getPhotosByCat / getRecentMeets 同口径：猫 _id 是云数据库自动生成的十六进制串
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;
// 时间窗白名单（0 = 全部）。白名单之外一律按默认 90 天，不做「任意天数」的入口 ——
// 扫描成本与时长强相关，入口收窄到固定三档，缓存键也才有有限枚举。
const RANGE_DAYS = [0, 30, 90];
const DEFAULT_RANGE_DAYS = 90;
const CACHE_TTL = 60;

/**
 * 游标分页拉全量（与 getMeetCalendar.index.js:27 的 getAllRecords 同口径）。
 *
 * 不用 skip 分页：`skip` 在并发写入下顺序不稳定且并发发起会打满数据库配额；
 * `_id > lastId` 游标 + 串行翻页语义稳定、成本可预期。
 *
 * @param {object} where 查询条件
 * @param {object} field 投影字段
 * @param {number} maxRows 扫描硬顶（分析类接口宁可截断并明示，也不无边界把内存跑满）
 * @param {'asc'|'desc'} [direction] 扫描方向：asc 从最早开始（单猫分析沿用既有口径）；
 *   desc 从最新开始（总轨迹模式）—— 截断时保住的是**最近**的一段，与「最近在哪些地方
 *   活动」的用途一致；asc 截断丢掉的恰好是最新记录，那是给单猫页面留的历史口径。
 * @returns {Promise<{records: Array<object>, truncated: boolean}>}
 */
async function getAllRecords(where, field, maxRows, direction = 'asc') {
  const PAGE_SIZE = 1000;
  const fromNewest = direction === 'desc';
  const records = [];
  let lastId = null;
  let truncated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 游标条件必须与原条件**合并进同一个 where 对象**：
    // wx-server-sdk 的 Query.where() 是整体替换 _fieldFilters，不会合并。
    // 第二页若再链 .where({_id: _.gt(lastId)})，原 catId / meetTime 条件会被
    // 静默丢弃 —— 第二页起会把全站所有猫的打卡并进这只猫的分析里。
    const condition = lastId
      ? { ...where, _id: fromNewest ? _.lt(lastId) : _.gt(lastId) }
      : where;
    const res = await db.collection(COLLECTIONS.RECORD_MEET)
      .where(condition)
      .field({ ...field, _id: true })
      .orderBy('_id', fromNewest ? 'desc' : 'asc')
      .limit(PAGE_SIZE)
      .get();

    if (!res.data || res.data.length === 0) break;
    records.push(...res.data);
    lastId = res.data[res.data.length - 1]._id;

    if (res.data.length < PAGE_SIZE) break;
    if (records.length >= maxRows) {
      // 达到硬顶：不是静默当全量，truncated 会随响应体回到页面并明示
      truncated = true;
      console.warn(`[getCatActivity] 扫描达上限 ${maxRows} 条，分析结果仅覆盖最近部分记录`);
      break;
    }
  }

  return { records, truncated };
}

/**
 * 批量取猫档案（名字/头像/状态），供总轨迹图补上身份。
 *
 * 分片查询：`_.in` 的 id 列表不宜过长，20 个一片最稳；查不到的 id 不补档案
 * （调用方据此把该猫从图上剔除，口径与单猫详情「猫咪不存在或已删除」一致）。
 *
 * @param {string[]} ids 猫 _id 列表
 * @returns {Promise<Map<string, object>>} id → 档案文档
 */
async function fetchCatProfiles(ids) {
  const PROFILE_CHUNK = 20;
  const map = new Map();
  for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
    const chunk = ids.slice(i, i + PROFILE_CHUNK);
    const res = await db.collection(COLLECTIONS.CATS)
      .where({ _id: _.in(chunk) })
      .field({ _id: true, name: true, avatar: true, status: true, campus: true, _deleting: true })
      .limit(PROFILE_CHUNK)
      .get();
    (res.data || []).forEach((doc) => map.set(doc._id, doc));
  }
  return map;
}

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
  const scope = event.scope === 'all' ? 'all' : 'single';
  const catId = typeof event.catId === 'string' ? event.catId : '';
  const rangeDays = RANGE_DAYS.includes(event.rangeDays) ? event.rangeDays : DEFAULT_RANGE_DAYS;

  try {
    // 只读页面入口：鉴定结果走默认缓存（1 分钟内重复进入不再回表 admins）。
    // 入口权限由 checkAdmin({ permission: 'catActivity' }) 统一裁决：
    // 超管恒通过，普通管理员必须在「管理员管理 → 权限」里显式开通「猫咪行动分析」。
    const authResult = await checkAdmin(db, OPENID, {
      operation: '查看猫咪行动分析',
      adminAccount,
      permission: 'catActivity'
    });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    const now = Date.now();
    const since = rangeDays > 0 ? now - rangeDays * 86400000 : 0;

    // ── 全部小猫总轨迹：一次扫描全站打卡，按猫分组（见 analysis.analyzeTrails）──
    if (scope === 'all') {
      const payload = await CloudCache.getOrSet(`cat_activity_all_${rangeDays}`, async () => {
        const where = {};
        if (since > 0) where.meetTime = _.gte(since);

        // 倒序扫描：截断时保住最近的一段 —— 总览图看的正是「最近在哪活动」
        const { records, truncated } = await getAllRecords(
          where,
          { meetTime: true, catId: true, point: true },
          LIMITS.maxScanRowsAll,
          'desc'
        );
        const trails = analyzeTrails(records);
        const profiles = await fetchCatProfiles(trails.cats.map((c) => c.id));

        // 已删除 / 查不到档案的猫不再出现在图上（与单猫详情「猫咪不存在或已删除」同口径）
        const cats = trails.cats
          .map((c) => {
            const doc = profiles.get(c.id);
            if (!doc || doc._deleting === true) return null;
            return { ...c, name: doc.name || '', avatar: doc.avatar || '', status: doc.status || '', campus: doc.campus || '' };
          })
          .filter(Boolean);

        return {
          scope: 'all',
          cats,
          range: {
            days: rangeDays,
            since,
            until: now,
            scanned: records.length,
            truncated,
            maxScan: LIMITS.maxScanRowsAll,
            maxTrailPoints: LIMITS.maxTrailPoints
          },
          totals: { ...trails.totals, returned: cats.length }
        };
      }, CACHE_TTL);

      return ok(payload);
    }

    if (!CAT_ID_PATTERN.test(catId)) {
      return fail('参数无效');
    }

    // doc().get() 对不存在的 id 会抛错，这里统一收成 null 走「猫咪不存在」，
    // 而不是让异常冒到最外层变成「获取失败」——两种情况的用户动作不同
    const catRes = await db.collection(COLLECTIONS.CATS).doc(catId).get().catch(() => null);
    const catDoc = catRes && catRes.data;
    if (!catDoc || catDoc._deleting === true) {
      return fail('猫咪不存在或已删除');
    }

    // 猫咪档案不进缓存（读一次 doc 很便宜，且名字/头像改了页面要立刻对）；
    // 缓存包住「扫描 + 聚合」这段，防止反复切换时间窗/进出页面时重复全扫
    const payload = await CloudCache.getOrSet(`cat_activity_${catId}_${rangeDays}`, async () => {
      const where = { catId };
      if (since > 0) where.meetTime = _.gte(since);

      const { records, truncated } = await getAllRecords(
        where,
        { meetTime: true, location: true, statusTag: true, point: true },
        LIMITS.maxScanRows
      );
      const stats = analyze(records);

      return {
        cat: {
          id: catId,
          name: catDoc.name || '',
          avatar: catDoc.avatar || '',
          status: catDoc.status || '',
          campus: catDoc.campus || '',
          meetCount: typeof catDoc.meetCount === 'number' ? catDoc.meetCount : 0,
          lastMeetTime: catDoc.lastMeetTime || 0
        },
        range: {
          days: rangeDays,
          since,
          until: now,
          scanned: records.length,
          truncated,
          maxScan: LIMITS.maxScanRows
        },
        ...stats
      };
    }, CACHE_TTL);

    return ok(payload);
  } catch (err) {
    CloudLogger.error('getCatActivity', '分析失败', err);
    return fail('获取猫咪行动分析失败，请稍后重试');
  }
};
