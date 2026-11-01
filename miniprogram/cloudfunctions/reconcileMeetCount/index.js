// cloudfunctions/reconcileMeetCount/index.js - 数据修复：校准猫咪相遇计数
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LOG_SOURCE = 'reconcileMeetCount';
// 定时触发器名称，与 config.json 中 triggers[0].name 保持一致
const TIMER_TRIGGER_NAME = 'reconcileTimer';
// 定时器运行状态集合：作为定时对账的节流（纵深防御，不是鉴权手段）
const SYSTEM_STATE_COLLECTION = 'system_state';
const TIMER_MIN_INTERVAL_MS = 20 * 3600 * 1000;

/**
 * 汇总定时触发判定所需的现场信息（仅用于日志，不参与放行判定）。
 * 对抗性审核 P2-3：第 3 层判据是 fail-open 的（SOURCE 缺失即放行），但它同时是
 * 「定时对账静默失效」的唯一现场——本机无法验证线上 SOURCE 的真实取值。
 * 上线后必须检查一次定时触发日志（见下方 console.warn），确认 SOURCE 实际取值。
 */
function timerDiagnostics(event) {
  const wxContext = cloud.getWXContext() || {};
  const source = String(wxContext.SOURCE || '');
  return {
    TriggerName: event && event.TriggerName || '',
    SOURCE: source,
    hasOpenid: !!wxContext.OPENID,
    httpShaped: !!(event && (typeof event.body === 'string' || event.httpMethod ||
      event.headers || event.queryStringParameters || event.isBase64Encoded))
  };
}

/**
 * 判断事件是否来自平台定时触发器。
 *
 * 为什么不能只看 event.Type / event.TriggerName：wx.cloud.callFunction 的 data 会被
 * 完整合并进 event，这两个字段完全由客户端控制（HTTP 访问服务的 event.body 同理）。
 * 定时触发调用则没有任何用户上下文，因此以「确实没有用户上下文」为主判据：
 *   1) 有 OPENID → 必为客户端调用，直接拒绝（客户端调用一定带 OPENID）；
 *   2) 事件呈 HTTP 触发器形状 → 拒绝（body 可控且同样没有 OPENID）；
 *   3) 来源（SOURCE）存在但不是 wx_trigger → 拒绝（微信侧非定时触发来源，如 wx_client/wx_http）。
 * 三者全部通过才认定为真实定时触发。
 *
 * 判定逻辑**保持 fail-open 不变**（SOURCE 缺失仍放行），代价是不能靠这一层发现
 * SOURCE 漂移，故每个拒绝分支都打 warn 留现场。
 *
 * @param {object} event - 云函数入参
 * @param {string} triggerName - 触发器名称
 * @returns {boolean}
 */
function isTrustedTimerEvent(event, triggerName) {
  if (!event || event.Type !== 'Timer' || event.TriggerName !== triggerName) {
    // 探测器（P2-3）：事件声称定时触发（Type=Timer）但触发器名不是本函数配置的名字
    // ——平台改名/配置漂移时真实定时器会走到这里被静默丢弃，日志必须留下现场。
    // 客户端伪造成其他 TriggerName 也会落在这里（属预期噪声）。
    if (event && event.Type === 'Timer') {
      console.warn(`[${LOG_SOURCE}] 事件声称定时触发但 TriggerName 不匹配，未进入定时分支`,
        { ...timerDiagnostics(event), expectedTriggerName: triggerName });
    }
    return false;
  }

  const diag = timerDiagnostics(event);
  const reject = (reason) => {
    console.warn(`[${LOG_SOURCE}] 拒绝定时触发分支: ${reason}`, diag);
    return false;
  };

  // 1) 有用户上下文 → 来自客户端（或经调用链），绝不能进定时分支
  if (diag.hasOpenid) {
    return reject('事件自称定时触发但携带用户上下文，已按客户端调用处理');
  }

  // 2) HTTP 访问服务事件：body/httpMethod 等由平台注入，且 body 可被调用方任意构造
  if (diag.httpShaped) {
    return reject('事件呈 HTTP 触发器形状，已按客户端调用处理');
  }

  // 3) 微信侧来源不是定时触发器
  if (diag.SOURCE && diag.SOURCE.split(',').indexOf('wx_trigger') === -1) {
    return reject('SOURCE 不含 wx_trigger（若线上确实如此，定时对账会永远不执行）');
  }

  return true;
}

async function reconcileMeetCount() {
  const results = { scanned: 0, repaired: 0, skipped: 0, errors: 0 };

  try {
    const logsRes = await db.collection(COLLECTIONS.REPAIR_LOGS)
      .where({ type: 'meetCount_mismatch', reconciled: _.neq(true) })
      .limit(500)
      .get();

    const logs = logsRes.data || [];
    results.scanned = logs.length;

    if (logs.length === 0) {
      console.log(`[${LOG_SOURCE}] 无待修复记录`);
      return results;
    }

    const catIds = [...new Set(logs.map(l => l.catId))];
    console.log(`[${LOG_SOURCE}] 发现 ${logs.length} 条待修复记录，涉及 ${catIds.length} 只猫咪`);

    const BATCH_SIZE = 5;
    for (let i = 0; i < catIds.length; i += BATCH_SIZE) {
      const batch = catIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async catId => {
        try {
          const countRes = await db.collection(COLLECTIONS.RECORD_MEET)
            .where({ catId })
            .count();
          const actualCount = countRes.total;

          // P2-8：绝不能无条件用 count() 的读数覆写。
          // 实测场景 E：count() 读到 5 之后第 6 次打卡落库（recordMeet 已把计数
          // _.inc 到 6），旧代码再写 5 就把计数**改小**了；同时立刻标 reconciled:true，
          // 而下一轮扫描用 reconciled: _.neq(true) 过滤，于是这个错误值再也不会被修正。
          // 现在的规则：只在「实际值 > 当前值」时才覆写（不倒退），并确认写入生效，
          // 成功后才标 reconciled；否则保持未修复，交给下一轮重试自愈。
          const catRes = await db.collection(COLLECTIONS.CATS).doc(catId).get();
          const storedCount = catRes && catRes.data && catRes.data.meetCount || 0;

          if (actualCount <= storedCount) {
            results.skipped++;
            console.warn(`[${LOG_SOURCE}] ${catId}: 实际打卡数 ${actualCount} 不大于当前计数 ` +
              `${storedCount}（并发交错或计数已自愈），不覆写计数；` +
              '对应日志按「无需修复」关闭，避免陈旧日志反复占用扫描窗口');
            // 旧实现在这里直接 return，日志永久保持「未修复」：
            // 每轮对账都会重扫（.limit(500) 且无 orderBy，取哪 500 条不确定），
            // 陈旧日志堆积超过窗口后，新产生的 mismatch 可能永远扫不到 —— 对账静默失效。
            // 关闭语义 = 按既定规则处理完毕（计数不倒退覆写），并在 reconciledNote 留原因；
            // 若计数后续再次偏低，recordMeet 会重新写入新的 mismatch 日志。
            const skipLogs = logs.filter(l => l.catId === catId);
            for (const log of skipLogs) {
              await db.collection(COLLECTIONS.REPAIR_LOGS).doc(log._id).update({
                data: {
                  reconciled: true,
                  reconciledAt: new Date(),
                  reconciledValue: actualCount,
                  reconciledNote: 'actual<=stored：不倒退覆写，按已一致关闭'
                }
              }).catch(() => {});
            }
            return;
          }

          const updateRes = await db.collection(COLLECTIONS.CATS).doc(catId).update({
            data: { meetCount: actualCount }
          });
          const updated = updateRes && updateRes.stats && updateRes.stats.updated;
          if (!updated) {
            results.errors++;
            console.warn(`[${LOG_SOURCE}] ${catId}: meetCount 写入未生效，保持未修复待下轮重试`);
            return;
          }

          // 只有写入确认成功后才标记已修复（标记失败不影响下一轮：_.neq(true) 仍会扫到）
          const batchLogs = logs.filter(l => l.catId === catId);
          const logIds = batchLogs.map(l => l._id);

          for (const logId of logIds) {
            await db.collection(COLLECTIONS.REPAIR_LOGS).doc(logId).update({
              data: {
                reconciled: true,
                reconciledAt: new Date(),
                reconciledValue: actualCount
              }
            }).catch(() => {});
          }

          results.repaired++;
          console.log(`[${LOG_SOURCE}] ${catId}: ${storedCount} → meetCount 修复为 ${actualCount}`);
        } catch (err) {
          results.errors++;
          console.error(`[${LOG_SOURCE}] ${catId} 修复失败:`, err.message);
        }
      }));

      if (i + BATCH_SIZE < catIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (err) {
    console.error(`[${LOG_SOURCE}] 对账扫描失败:`, err.message);
    results.errors++;
  }

  return results;
}

async function fullReconcile() {
  const results = { total: 0, repaired: 0, skipped: 0, errors: 0 };

  try {
    // 游标分页（_id > lastId）而非 .limit(500)：
    // 原实现只取前 500 只猫，第 501 只起**永远不会被对账**，但仍返回 ok，
    // 管理端显示「对账完成」——静默截断比报错更难发现。写法对齐 getAdminStats。
    // orderBy('_id','asc') 同为必需：无排序时云数据库不保证顺序，lastId 之后
    // 可能残留更小的 _id 未被取到 → 漏对账且同样返回 ok。
    const PAGE_SIZE = 500;
    const cats = [];
    let lastId = null;
    do {
      let query = db.collection(COLLECTIONS.CATS)
        .field({ _id: true, name: true, meetCount: true })
        .orderBy('_id', 'asc')
        .limit(PAGE_SIZE);
      if (lastId) {
        query = query.where({ _id: _.gt(lastId) });
      }
      const batch = await query.get();
      if (!batch.data || batch.data.length === 0) break;
      cats.push(...batch.data);
      lastId = batch.data[batch.data.length - 1]._id;
    } while (lastId);

    results.total = cats.length;

    const BATCH_SIZE = 5;
    for (let i = 0; i < cats.length; i += BATCH_SIZE) {
      const batch = cats.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async cat => {
        try {
          const countRes = await db.collection(COLLECTIONS.RECORD_MEET)
            .where({ catId: cat._id })
            .count();

          const actualCount = countRes.total;
          const storedCount = cat.meetCount || 0;

          if (actualCount !== storedCount) {
            await db.collection(COLLECTIONS.CATS).doc(cat._id).update({
              data: { meetCount: actualCount }
            });
            results.repaired++;
            console.log(`[${LOG_SOURCE}] 全量对账 ${cat.name || cat._id}: ${storedCount} → ${actualCount}`);
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.errors++;
          console.error(`[${LOG_SOURCE}] 全量对账 ${cat._id} 失败:`, err.message);
        }
      }));

      if (i + BATCH_SIZE < cats.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (err) {
    console.error(`[${LOG_SOURCE}] 全量对账失败:`, err.message);
    results.errors++;
  }

  return results;
}

/**
 * 定时器节流（只读）：距离上次**成功**运行不足 TIMER_MIN_INTERVAL_MS 则跳过本次。
 *
 * 对抗性审核 P2-7：旧实现在这里先落盘 lastRunAt 再执行对账，对账一旦失败
 * 就只返回 fail、节流记录不回滚，于是当天对账静默丢失且 20 小时内不再补跑。
 * 现拆成「读（本函数）→ 执行 → 成功后 markTimerRun 落盘 / 失败后 rollbackTimerRun」。
 *
 * @returns {Promise<{allowed: boolean, record: object|null}>} record 为既有节流记录
 */
async function shouldRunTimer(triggerName) {
  try {
    const stateRes = await db.collection(SYSTEM_STATE_COLLECTION)
      .where({ key: `timer_${triggerName}` })
      .limit(1)
      .get();
    const record = stateRes.data[0] || null;
    if (record && record.lastRunAt && Date.now() - record.lastRunAt < TIMER_MIN_INTERVAL_MS) {
      return { allowed: false, record };
    }
    return { allowed: true, record };
  } catch (e) {
    console.warn(`[${LOG_SOURCE}] 定时器节流查询失败，继续执行:`, e.message);
    return { allowed: true, record: null };
  }
}

/**
 * 对账成功后才写 lastRunAt（P2-7：写入时机＝成功之后）。
 */
async function markTimerRun(triggerName, record) {
  const data = { key: `timer_${triggerName}`, lastRunAt: Date.now() };
  try {
    if (record) {
      await db.collection(SYSTEM_STATE_COLLECTION).doc(record._id).update({ data });
    } else {
      await db.collection(SYSTEM_STATE_COLLECTION).add({ data });
    }
  } catch (e) {
    console.warn(`[${LOG_SOURCE}] 定时器节流写入失败，下次触发可能重复对账:`, e.message);
  }
}

/**
 * 失败回滚：只删除**本次运行期间写入**的节流记录（lastRunAt >= runStartAt），
 * 保证一次失败不会留下 20 小时窗口把下一次触发挡在门外。
 */
async function rollbackTimerRun(triggerName, runStartAt) {
  try {
    const stateRes = await db.collection(SYSTEM_STATE_COLLECTION)
      .where({ key: `timer_${triggerName}` })
      .limit(1)
      .get();
    const record = stateRes.data[0];
    if (!record || !record.lastRunAt || record.lastRunAt < runStartAt) return;
    await db.collection(SYSTEM_STATE_COLLECTION).doc(record._id).remove();
    console.warn(`[${LOG_SOURCE}] 已回滚本次运行的节流记录，下次触发将立即补跑`);
  } catch (e) {
    console.warn(`[${LOG_SOURCE}] 节流回滚失败（可能被 20 小时窗口挡住下一次）:`, e.message);
  }
}

exports.main = async (event, _context) => {
  // 定时触发器分支：必须确认事件确实来自平台定时触发（见 isTrustedTimerEvent），
  // 绝不能只凭客户端可控的 event.Type / event.TriggerName 进入。伪造的调用会落到
  // 下方的管理员鉴权路径上，无 OPENID 时 checkAdmin 必然拒绝。
  //
  // 上线后需检查一次定时触发日志，确认 isTrustedTimerEvent 第 3 层判据里
  // SOURCE 的实际取值（本机无法验证）。若线上 SOURCE 不是 wx_trigger，定时对账会被
  // 静默拒绝、永不执行；拒绝分支已打 warn，日志里搜 "拒绝定时触发分支" 即可。
  if (isTrustedTimerEvent(event, TIMER_TRIGGER_NAME)) {
    const timerRunStartAt = Date.now();
    const timerState = await shouldRunTimer(TIMER_TRIGGER_NAME);
    if (!timerState.allowed) {
      console.log(`[${LOG_SOURCE}] 距上次运行不足 20 小时，跳过本次定时对账`);
      return ok({ skipped: true });
    }
    try {
      const startTime = Date.now();
      const results = await reconcileMeetCount();
      // P2-7：lastRunAt 只在对账成功（未抛错）后写入，失败不占用 20 小时窗口
      await markTimerRun(TIMER_TRIGGER_NAME, timerState.record);
      console.log(`[${LOG_SOURCE}] 定时对账完成 (${Date.now() - startTime}ms):`, JSON.stringify(results));
      return ok({ mode: 'timer', results });
    } catch (err) {
      console.error(`[${LOG_SOURCE}] 定时对账失败:`, err.message);
      await rollbackTimerRun(TIMER_TRIGGER_NAME, timerRunStartAt);
      return fail('定时对账失败，请稍后重试');
    }
  }

  // 对账会全量重写计数，属于管理操作。
  // 权限口径：full 模式会重写**全部**猫咪的 meetCount，破坏性大于 deleteData 的删猫，
  // 因此要求 superadmin（其余 deleteData / exportData / backupData / deleteDonation 同样口径），
  // 不能只判 isAdmin —— 否则普通 admin 就能一次性改写全库计数。
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event && event._adminAccount || '';

  const authResult = await checkAdmin(db, OPENID, { operation: '对账修复', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    console.warn(`[${LOG_SOURCE}] 非管理员调用被拒绝`);
    return fail(authResult.error || '无权限执行对账操作');
  }

  const mode = event && event.mode || 'repair';

  if (mode === 'full' && authResult.adminInfo && authResult.adminInfo.role !== 'superadmin') {
    console.warn(`[${LOG_SOURCE}] full 模式需要 superadmin，当前角色: ${authResult.adminInfo.role}`);
    return fail('全量对账仅限超级管理员');
  }

  console.log(`[${LOG_SOURCE}] 开始执行对账，模式: ${mode}`);

  const startTime = Date.now();

  let results;
  if (mode === 'full') {
    results = await fullReconcile();
  } else {
    results = await reconcileMeetCount();
  }

  const duration = Date.now() - startTime;

  console.log(`[${LOG_SOURCE}] 对账完成 (${duration}ms):`, JSON.stringify(results));

  return ok({
    mode,
    duration,
    results
  });
};
