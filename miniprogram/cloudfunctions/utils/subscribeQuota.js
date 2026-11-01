/**
 * cloudfunctions/utils/subscribeQuota.js - 订阅消息推送次数账本的发送侧消费
 *
 * 账本由 manageSubscribeQuota 云函数维护（授权 accept +1、上限 200 回夹）；
 * 本模块供发送侧（updateCat / recordMeet / addCat）使用：
 *   - fetchQuotaMap()       取指定用户/模板的可用次数
 *   - fetchLegacyByOpenid() 分页拉取历史订阅记录（过渡期兜底数据源）
 *   - dispatchWithQuota()   按「配额优先、历史兜底」发送并完成对账
 *   - isNoQuotaError()      43101（授权已耗尽/拒收）判定
 *
 * 对账规则（与「我的」页展示口径一致）：
 *   - 有配额：发送成功后 -1（原子 inc(-1)）
 *   - 无配额、有历史 accept 记录：发送成功后删除该记录（一次性语义）
 *   - 两者都无：不发送（此前是盲发，失败率全靠 43101 兜底）
 *   - 43101：清零该用户该模板剩余次数 + 回收历史记录（自愈对账）
 *
 * 本文件是 canonical 源，经 scripts/sync-utils.js 同步到上述三个云函数的
 * utils/ 副本（云函数之间无共享运行时，不能跨函数 require）。
 */
const { COLLECTIONS } = require('./constants');

// 单页查询条数（云开发单次 get 上限 100）
const PAGE_SIZE = 100;
// 游标翻页上限：单次事件最多扫描 1000 条记录（校园规模足够，防异常数据拖垮函数）
const MAX_PAGES = 10;

function chunk(list, size) {
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts;
}

/**
 * 拉取某模板下的可用配额（remaining > 0）。
 * @param {Object} db 云函数侧 database 实例
 * @param {string} templateId 模板 ID
 * @param {Array<string>} [openids] 可选：只取这批用户的配额（内部按 100 分片）；
 *                                  不传则全量拉取（游标分页，供 addCat 新猫广播使用）
 * @returns {Promise<Map<string, {rowId: string, remaining: number}>>} openid -> 配额
 */
async function fetchQuotaMap(db, templateId, openids) {
  const _ = db.command;
  const map = new Map();
  const collect = (rows) => {
    (rows || []).forEach(row => {
      if (row && row._openid) {
        map.set(row._openid, { rowId: row._id, remaining: Number(row.remaining) || 0 });
      }
    });
  };

  if (!templateId) return map;

  if (Array.isArray(openids)) {
    // 每人每模板至多一条记录：一次 limit(100) 即可取完，无需排序分页
    const unique = [...new Set(openids.filter(Boolean))];
    if (unique.length === 0) return map;
    for (const part of chunk(unique, PAGE_SIZE)) {
      const res = await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA)
        .where({ templateId, _openid: _.in(part), remaining: _.gt(0) })
        .limit(PAGE_SIZE)
        .get();
      collect(res.data);
    }
    return map;
  }

  // 全量：游标分页（无排序时云数据库返回顺序不稳定，游标会漏数据）
  let lastId = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const where = { templateId, remaining: _.gt(0) };
    if (lastId) where._id = _.gt(lastId);
    const res = await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA)
      .where(where)
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE)
      .get();
    const rows = res.data || [];
    collect(rows);
    if (rows.length < PAGE_SIZE) break;
    lastId = rows[rows.length - 1]._id;
  }
  return map;
}

/**
 * 分页拉取历史订阅记录（userSubscriptions），按 openid 建 Map。
 * 过渡期兜底用：旧模型下「授权一次 + 发一条」，记录消费（发送成功）后删除。
 * @param {Object} where 查询条件（不含游标；由调用方构造，可含 _.in / _.neq 等指令）
 * @returns {Promise<Map<string, Object>>} openid -> 记录（含 _id）
 */
async function fetchLegacyByOpenid(db, where, maxPages = MAX_PAGES) {
  const _ = db.command;
  const map = new Map();
  let lastId = '';
  for (let page = 0; page < maxPages; page++) {
    const query = lastId ? { ...where, _id: _.gt(lastId) } : where;
    const res = await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS)
      .where(query)
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE)
      .get();
    const rows = res.data || [];
    rows.forEach(row => {
      if (row && row._openid) map.set(row._openid, row);
    });
    if (rows.length < PAGE_SIZE) break;
    lastId = rows[rows.length - 1]._id;
  }
  return map;
}

/** 发送成功后扣减一次（原子自增，避免并发下丢扣减） */
async function consumeQuota(db, quota) {
  const _ = db.command;
  await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA).doc(quota.rowId).update({
    data: { remaining: _.inc(-1), updateTime: db.serverDate() }
  });
  quota.remaining = Math.max(0, (Number(quota.remaining) || 0) - 1);
  return quota.remaining;
}

/** 无可用授权（43101）时清零该用户该模板剩余次数（用 where：调用方只有 openid，没有行 id） */
async function clearQuota(db, openid, templateId) {
  await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA)
    .where({ _openid: openid, templateId })
    .update({ data: { remaining: 0, updateTime: db.serverDate() } });
}

/** 回收历史记录（消费成功 或 授权已失效时调用；有 _id 才可删） */
async function removeLegacyRecord(db, legacy) {
  if (legacy && legacy._id) {
    await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS).doc(legacy._id).remove();
  }
}

/**
 * 是否「无可用授权」类错误：43101 = 用户未订阅 / 一次性订阅次数已下发完。
 * 其他错误（网络抖动、43107 能力封禁等）不清零，避免误伤真实剩余次数。
 */
function isNoQuotaError(err) {
  if (!err) return false;
  const code = err.errCode !== undefined ? err.errCode : err.errcode;
  return code === 43101;
}

/**
 * 按「配额优先、历史兜底」向候选用户发送一条订阅消息，并完成账本对账。
 * 单条发送失败只告警、不影响其他接收者与其他对账任务。
 * @param {Object} params
 * @param {Object} params.db
 * @param {string} params.templateId
 * @param {Map} params.quotaMap fetchQuotaMap 的结果
 * @param {Map} params.legacyByOpenid fetchLegacyByOpenid 的结果
 * @param {(openid: string) => Promise} params.sendFn 实际发送函数（各云函数构造各自的模板数据）
 * @param {string} [params.logTag] 日志前缀（如 '[updateCat] '）
 * @returns {Promise<number>} 实际发送尝试数
 */
async function dispatchWithQuota({ db, templateId, quotaMap, legacyByOpenid, sendFn, logTag = '' }) {
  const legacyMap = legacyByOpenid || new Map();
  const candidates = new Set([...quotaMap.keys(), ...legacyMap.keys()]);

  const tasks = [];
  for (const openid of candidates) {
    const quota = quotaMap.get(openid) || null;
    const legacy = legacyMap.get(openid) || null;
    if (!quota && !legacy) continue; // 无额度也无历史授权：跳过盲发

    tasks.push((async () => {
      try {
        await sendFn(openid);
        if (quota) {
          await consumeQuota(db, quota);
        } else {
          await removeLegacyRecord(db, legacy);
        }
      } catch (err) {
        console.warn(`${logTag}订阅消息发送失败: ${openid}`, err && err.message);
        if (isNoQuotaError(err)) {
          await clearQuota(db, openid, templateId).catch(() => null);
          await removeLegacyRecord(db, legacy).catch(() => null);
        }
      }
    })());
  }

  await Promise.all(tasks);
  return tasks.length;
}

module.exports = {
  fetchQuotaMap,
  fetchLegacyByOpenid,
  dispatchWithQuota,
  isNoQuotaError
};
