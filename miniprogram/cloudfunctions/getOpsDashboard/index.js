// cloudfunctions/getOpsDashboard/index.js - 运营数据面板（管理端 · 只读）
//
// 三个固定指标：
//   1. 新用户激活率       —— 本周首见用户中，7 天内完成打卡/关注任一核心动作；
//   2. 首个打卡完成率     —— 本周首见用户中，7 天内完成第一次相遇打卡；
//   3. 关注后回访率       —— 本周首次关注某只猫的用户中，7 天内另一天再打开小程序。
//
// 数据来源全部是小程序服务端已有记录 + 三个 ops_* 匿名集合：
//   recordMeet / userFavorites 提供历史事实；
//   ops_users / ops_days 提供「来过」与 7 天观察窗；
//   ops_entry_usage 提供入口使用。
//
// 本函数只读、不写库。容器内缓存 5 分钟：这是管理端低频入口，
// 但一次要扫多张表；缓存键只含 weeks，鉴权永远在缓存之前。
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { userKey, opsDayKey } = require('./utils/opsIdentity');
const { analyze, DAY_MS, buildWeeks } = require('./metrics');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_WEEKS = [4, 8, 12];
const DEFAULT_WEEKS = 8;

const cache = new Map(); // `${weeks}` -> { payload, at }

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
}

/**
 * 按 _id 升序游标扫描。
 *
 * ops_* 集合的文档 ID 以「日期前缀」开头，所以只要给 startPrefix / endPrefix
 * 就能按日期范围扫，不依赖额外索引，也不会像 skip 分页那样在并发写入时漏行。
 *
 * @param {string} name 集合名
 * @param {object} options
 * @param {string} [options.startPrefix] 包含下界（_id >= startPrefix）
 * @param {string} [options.endPrefix]   排除上界（遇到 _id >= endPrefix 即停）
 * @param {object} options.field         字段投影
 * @param {number} [options.maxRows]
 * @returns {Promise<{rows: Array, truncated: boolean}>}
 */
async function scanById(name, { startPrefix = '', endPrefix = '', field, maxRows = MAX_ROWS } = {}) {
  const rows = [];
  let lastId = '';
  let truncated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const conditions = [];
    if (startPrefix) conditions.push(_.gte(startPrefix));
    if (lastId) conditions.push(_.gt(lastId));
    // 同一字段的多个条件用可变参数形式的 _.and（与 getOperationLogs 同口径）；
    // 传数组形式在部分基础库/服务端版本上会被当成「查询对象列表」而语义不符。
    const idCondition = conditions.length === 1
      ? conditions[0]
      : conditions.length > 1
        ? _.and(...conditions)
        : null;

    let query = db.collection(name);
    if (idCondition) query = query.where({ _id: idCondition });
    const res = await query
      .field({ ...field, _id: true })
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE)
      .get();

    const batch = res.data || [];
    if (batch.length === 0) break;

    for (const doc of batch) {
      if (endPrefix && doc._id >= endPrefix) {
        return { rows, truncated };
      }
      rows.push(doc);
      if (rows.length >= maxRows) {
        truncated = true;
        return { rows, truncated };
      }
    }

    lastId = batch[batch.length - 1]._id;
    if (batch.length < PAGE_SIZE) break;
  }

  return { rows, truncated };
}

async function scanRequired(name, options) {
  return scanById(name, options);
}

async function scanOptional(name, options, warnings) {
  try {
    return await scanById(name, options);
  } catch (err) {
    warnings.push(`${name} 读取失败，相关指标暂缺：${err.message || 'unknown'}`);
    return { rows: [], truncated: false, failed: true };
  }
}

async function collectData(weeks) {
  const now = Date.now();
  const weekList = buildWeeks(now, weeks);
  const oldestStart = weekList[0].startAt;
  const startDay = opsDayKey(oldestStart);
  const endDay = opsDayKey(now + DAY_MS);
  const entryStartDay = opsDayKey(now - 28 * DAY_MS);
  const warnings = [];

  // 两张核心历史事实表：读失败不能当成 0，直接失败关闭，避免面板给出错误结论。
  const [meetsRes, favoritesRes] = await Promise.all([
    scanRequired(COLLECTIONS.RECORD_MEET, {
      field: { _openid: true, meetTime: true }
    }),
    scanRequired(COLLECTIONS.USER_FAVORITES, {
      field: { _openid: true, createTime: true }
    })
  ]);

  // ops_* 是本次新上线的集合：缺失时页面仍应能打开，只是对应指标标注「暂无」。
  const usersRes = await scanOptional(COLLECTIONS.OPS_USERS, {
    startPrefix: 'u_',
    endPrefix: 'v_',
    field: { userKey: true, firstSeenAt: true, lastSeenAt: true }
  }, warnings);
  const daysRes = await scanOptional(COLLECTIONS.OPS_DAYS, {
    startPrefix: `d_${startDay}_`,
    endPrefix: `d_${endDay}_`,
    field: { userKey: true, day: true }
  }, warnings);
  const entryRes = await scanOptional(COLLECTIONS.OPS_ENTRY_USAGE, {
    startPrefix: `e_${entryStartDay}_`,
    endPrefix: `e_${endDay}_`,
    field: { entries: true, userKey: true, day: true }
  }, warnings);

  for (const [label, res] of [
    ['recordMeet', meetsRes],
    ['userFavorites', favoritesRes],
    ['ops_users', usersRes],
    ['ops_days', daysRes],
    ['ops_entry_usage', entryRes]
  ]) {
    if (res.truncated) warnings.push(`${label} 数据量超过扫描上限 ${MAX_ROWS} 条，指标只覆盖最近一部分`);
  }

  const meets = [];
  for (const doc of meetsRes.rows) {
    const at = toMs(doc.meetTime);
    if (!at || at < oldestStart || at > now) continue;
    const uk = userKey(doc._openid);
    if (uk) meets.push({ userKey: uk, at });
  }

  const favorites = [];
  for (const doc of favoritesRes.rows) {
    const at = toMs(doc.createTime);
    if (!at) continue;
    const uk = userKey(doc._openid);
    if (uk) favorites.push({ userKey: uk, at });
  }

  return {
    now,
    users: usersRes.rows.map(doc => ({
      userKey: doc.userKey,
      firstSeenAt: toMs(doc.firstSeenAt),
      lastSeenAt: toMs(doc.lastSeenAt)
    })),
    activeDays: daysRes.rows.map(doc => ({ userKey: doc.userKey, day: doc.day })),
    meets,
    favorites,
    recognitions: [],
    feedbacks: [],
    // 一天一用户一条：把 entries 数组展开成 { name, userKey, day }，
    // metrics 只关心「某个入口在 28 天内被哪些人去重使用过」。
    entries: entryRes.rows.flatMap((doc) => {
      if (!doc || !doc.userKey || !doc.day || !Array.isArray(doc.entries)) return [];
      return doc.entries
        .filter(name => typeof name === 'string' && name)
        .map(name => ({ name, userKey: doc.userKey, day: doc.day }));
    }),
    // 入口集合读失败/未创建时，绝不能把所有入口当成「0 人使用」——
    // 页面会据此关闭淘汰判定，只保留告警。
    entryDataAvailable: !entryRes.failed,
    // 识猫指标不在公开版内，反馈数据视为不可用。
    feedbackDataAvailable: false,
    // 日活明细读不到时，「关注后回访率」的分母还在、分子会恒为 0，
    // 必须标成不可用，不能让页面显示成「没人回访」。
    activeDaysAvailable: !daysRes.failed,
    attemptLogStartAt: 0,
    warnings
  };
}

exports.main = async (event = {}) => {
  // keepWarm 预热早退：预热没有 OPENID，直接返回，不触发任何扫描。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  // HTTP 触发器适配（与 getAdminStats / getCatActivity 同口径）
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) { /* ignore */ }
  }

  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';
  const weeks = ALLOWED_WEEKS.includes(event.weeks) ? event.weeks : DEFAULT_WEEKS;

  try {
    const authResult = await checkAdmin(db, OPENID, {
      operation: '查看运营数据面板',
      adminAccount,
      permission: 'ops'
    });
    if (!authResult.isAdmin) return fail(authResult.error);

    const hit = cache.get(String(weeks));
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return ok({ ...hit.payload, computedAt: hit.at });
    }

    const data = await collectData(weeks);
    const payload = analyze({
      now: data.now,
      weeks,
      users: data.users,
      activeDays: data.activeDays,
      meets: data.meets,
      favorites: data.favorites,
      recognitions: data.recognitions,
      feedbacks: data.feedbacks,
      entries: data.entries,
      attemptLogStartAt: data.attemptLogStartAt,
      activeDaysAvailable: data.activeDaysAvailable,
      feedbackDataAvailable: data.feedbackDataAvailable
    });

    payload.entries.dataAvailable = data.entryDataAvailable;
    if (!data.entryDataAvailable) {
      // 数据缺失时不启用淘汰判定：0 使用必须是「确实没人用」，不是「没读到」。
      payload.entries.pruneReady = false;
    }
    payload.dataWarnings = data.warnings;
    payload.computedAt = Date.now();
    cache.set(String(weeks), { payload, at: payload.computedAt });
    return ok(payload);
  } catch (err) {
    console.error('[getOpsDashboard] 获取运营数据失败:', err && err.message);
    return fail('获取运营数据失败，请稍后重试');
  }
};
