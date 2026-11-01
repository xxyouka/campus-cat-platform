// cloudfunctions/trackOps/index.js - 运营数据面板的最小埋点写入口
//
// 只做两件事：
//   1. session：记录「今天来过」——用户首见 / 最近活跃 / 活跃天数 / 日活；
//   2. entries：记录用户当天用过哪些**页面入口**（用于每周淘汰无人使用的入口）。
//
// 设计边界：
//   - 不记录浏览内容、猫名、搜索词、位置等任何业务数据，只记录入口 slug；
//   - 文档 ID 由「日期 + 匿名用户键 + 入口名」拼成，重复上报天然幂等，
//     所以不需要先读后写，也不需要额外的去重表；
//   - 日期一律用服务端北京时间，客户端传的 at 不采信（防止回填历史数据）；
//   - 写失败不抛给用户：这是运营观测，不能影响主流程。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const {
  userKey,
  opsDayKey,
  userDocId,
  dayDocId,
  entryDocId
} = require('./utils/opsIdentity');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 单次最多 20 个入口：正常一次会话不可能点这么多；上限用于兜住伪造请求。
const MAX_ENTRIES = 20;
// 入口 slug：小写字母开头，只允许小写字母 / 数字 / 下划线，长度 2~32。
// 具体哪些 slug 算「登记入口」由前端 utils/opsTrack.js 的注册表负责；
// 服务端只做形态校验，避免出现任意长字符串或对象把文档 ID 撑坏。
const ENTRY_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;

function normalizeEntryNames(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const names = [];
  for (const item of raw) {
    const name = item && typeof item === 'object' ? item.name : item;
    if (typeof name !== 'string' || !ENTRY_NAME_RE.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_ENTRIES) break;
  }
  return names;
}

async function readUserDoc(id) {
  try {
    const res = await db.collection(COLLECTIONS.OPS_USERS).doc(id).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    // 文档不存在是正常路径（首次进入）；集合未创建也会走到这里，
    // 由后续 add 的失败兜底并返回 0，不在这里区分。
    return null;
  }
}

/**
 * 记录一次「今天来过」。
 * @returns {Promise<boolean>} 是否真正写入了新的一天（同一天重复进入返回 false）
 */
async function touchSession(openid, now) {
  const uk = userKey(openid);
  if (!uk) return false;

  const day = opsDayKey(now);
  const id = userDocId(uk);
  const existing = await readUserDoc(id);

  let saved = false;
  if (existing) {
    // 同一天重复启动不写库：session 只回答「哪几天来过」，
    // 同一天来几次对四个指标没有增量信息，却能省掉一次写。
    if (existing.lastSeenDay === day) return false;
    const res = await db.collection(COLLECTIONS.OPS_USERS).doc(id).update({
      data: {
        lastSeenAt: now,
        lastSeenDay: day,
        activeDays: _.inc(1),
        updateTime: db.serverDate()
      }
    });
    saved = !!(res && res.stats && res.stats.updated > 0);
  } else {
    try {
      await db.collection(COLLECTIONS.OPS_USERS).add({
        data: {
          _id: id,
          userKey: uk,
          firstSeenAt: now,
          firstSeenDay: day,
          lastSeenAt: now,
          lastSeenDay: day,
          activeDays: 1,
          createTime: db.serverDate()
        }
      });
      saved = true;
    } catch (err) {
      // 并发首次进入：另一个请求已经创建。补一次 update 即可，
      // 不能改 firstSeenAt（否则新用户会被反复重置成最新时间）。
      const res = await db.collection(COLLECTIONS.OPS_USERS).doc(id).update({
        data: { lastSeenAt: now, lastSeenDay: day, updateTime: db.serverDate() }
      }).catch(() => null);
      saved = !!(res && res.stats && res.stats.updated > 0);
    }
  }

  // 日活明细：一天一条，重复 add 失败即已存在，静默忽略。
  try {
    await db.collection(COLLECTIONS.OPS_DAYS).add({
      data: {
        _id: dayDocId(day, uk),
        day,
        userKey: uk,
        at: now,
        createTime: db.serverDate()
      }
    });
  } catch (err) {
    // 已存在 / 集合未创建：不影响 session 主记录
  }

  return saved;
}

/**
 * 记录当天的入口使用：一天一个用户一条，entries 数组去重。
 * 重复调用不会放大计数，也不会产生重复文档。
 * @returns {Promise<number>} 实际新增的入口数（已记录过的不算）
 */
async function touchEntries(openid, names, now) {
  if (names.length === 0) return 0;
  const uk = userKey(openid);
  if (!uk) return 0;

  const day = opsDayKey(now);
  const id = entryDocId(day, uk);

  let existing = null;
  try {
    const res = await db.collection(COLLECTIONS.OPS_ENTRY_USAGE).doc(id).get();
    existing = res && res.data ? res.data : null;
  } catch (err) {
    // 当天第一次进入（或集合未创建）；下面 set 会创建 / 失败
  }

  const merged = new Set(existing && Array.isArray(existing.entries) ? existing.entries : []);
  const fresh = names.filter(name => !merged.has(name));
  if (fresh.length === 0) return 0;
  fresh.forEach(name => merged.add(name));

  // 用 set 而不是 push：不同云函数实例对同一天同一用户的并发写很少，
  // 但 set 的语义是「整份当天入口集合」，不会因为重复 push 让数组无限增长。
  await db.collection(COLLECTIONS.OPS_ENTRY_USAGE).doc(id).set({
    data: {
      day,
      userKey: uk,
      entries: [...merged],
      at: now,
      createTime: existing && existing.createTime ? existing.createTime : db.serverDate()
    }
  });
  return fresh.length;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('请先登录', 'UNAUTHORIZED');

  const now = Date.now();
  const names = normalizeEntryNames(event.entries);
  const wantSession = event.session === true;

  if (!wantSession && names.length === 0) {
    return ok({ day: opsDayKey(now), sessionSaved: false, entriesSaved: 0 });
  }

  try {
    const sessionSaved = wantSession ? await touchSession(OPENID, now) : false;
    let entriesSaved = 0;
    try {
      entriesSaved = await touchEntries(OPENID, names, now);
    } catch (entryErr) {
      // 入口集合缺失 / 写入失败不能反过来把已经成功的 session 判成失败
      console.warn('[trackOps] 入口写入失败:', entryErr && entryErr.message);
    }

    if (names.length > 0 && entriesSaved === 0) {
      // 不是用户错误：最常见原因是 initDatabase 还没创建 ops_entry_usage。
      // 只在云端留一条可检索的线索，不把实现细节回传给客户端。
      console.warn('[trackOps] 入口记录未写入（集合可能未创建）', { names: names.length });
    }

    return ok({ day: opsDayKey(now), sessionSaved, entriesSaved });
  } catch (err) {
    console.error('[trackOps] 写入失败:', err && err.message);
    // 观测数据失败不阻塞用户：仍返回成功形状，避免客户端重试风暴
    return ok({ day: opsDayKey(now), sessionSaved: false, entriesSaved: 0 });
  }
};
