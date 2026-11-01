// cloudfunctions/sweepLostCats/index.js - 定时任务：久未相遇的猫自动转为「走失」
//
// 规则（2026-10-12 与产品确认）：
//   1. 只处理 status === 'normal' 的猫；被领养 / 已离世 / 已在走失名单的**一律不动**；
//   2. 基准时间 = max(最后一次相遇时间 lastMeetTime, 建档时间 createTime, 手动复位时间 lostResetAt)，
//      三个都缺失（脏数据）时只进报告、不写库；
//   3. 基准时间距今 >= LOST_THRESHOLD_DAYS（60 天，即「两个月」）→ status 改 'lost'，
//      lostTime 记为**最后被遇到的那一天**（不是今天：失踪时间＝最后一次确认看到它的时间），
//      lostLocation 取档案里的常出没地点，lostSource 标 'auto' 以区分管理员手动标记；
//   4. 反向流程（走失猫被再次遇到 → 自动去掉走失标签）在 recordMeet 里，不在这里。
//
// 触发方式：
//   - 定时器（每天 04:00，错开 03:00 的备份与对账）：全自动写库，不需要人工确认；
//   - 超管手动：dryRun（默认，只出报告）/ write（正式写库），破坏性口径同 reconcileMeetCount。
//
// 安全阀（无人值守 + 会给关注者推送，必须防「数据源异常导致全库一次性走失」）：
//   - 单轮上限 MAX_AUTO_LOST_PER_RUN：超出部分不写库，留给下一轮（每轮通知量可控）；
//   - 异常闸门：候选数同时超过单轮上限与在册正常猫的一半 → 整轮放弃写库，只报警。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { COLLECTIONS } = require('./utils/constants');
const { STATUS_NOTIFICATIONS, notifyCatStatusChange } = require('./utils/statusNotify');
// 列表排序值（首页/搜索顺序）：自动走失（normal → lost）与 updateTime 同步重算，见 utils/listSort.js
const { computeListSort } = require('./utils/listSort');
const { toBeijingDate } = require('./utils/beijingTime');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LOG_SOURCE = 'sweepLostCats';
// 定时触发器名称，与 config.json / cloudbaserc.json 中 triggers[0].name 保持一致
const TIMER_TRIGGER_NAME = 'lostSweepTimer';
// 定时器运行状态集合：作为定时扫描的节流（纵深防御，不是鉴权手段）
const SYSTEM_STATE_COLLECTION = 'system_state';
const TIMER_MIN_INTERVAL_MS = 20 * 3600 * 1000;

// 「两个月」阈值的唯一事实源：改这里即改判定口径
const LOST_THRESHOLD_DAYS = 60;
// 单轮最多自动标记多少只（超出的下一轮再处理，避免一轮内批量推送）
const MAX_AUTO_LOST_PER_RUN = 20;
// 猫档案扫描分页大小（云数据库单次 get 上限 100，游标分页不能靠 offset）
const SCAN_PAGE_SIZE = 100;
// 扫描兜底上限：异常膨胀的数据集不允许把一次定时任务拖到超时
const MAX_SCAN_CATS = 5000;

/**
 * 汇总定时触发判定所需的现场信息（仅用于日志，不参与放行判定）。
 */
function timerDiagnostics(event) {
  const wxContext = cloud.getWXContext() || {};
  return {
    TriggerName: event && event.TriggerName || '',
    SOURCE: String(wxContext.SOURCE || ''),
    hasOpenid: !!wxContext.OPENID,
    httpShaped: !!(event && (typeof event.body === 'string' || event.httpMethod ||
      event.headers || event.queryStringParameters || event.isBase64Encoded))
  };
}

/**
 * 判断事件是否来自平台定时触发器。
 *
 * 与 reconcileMeetCount / backupData 同一口径（三处保持一致，勿单方面放宽）：
 *   1) 有 OPENID → 必为客户端调用，直接拒绝（客户端调用一定带 OPENID）；
 *   2) 事件呈 HTTP 触发器形状 → 拒绝（body 可控且同样没有 OPENID）；
 *   3) 来源（SOURCE）存在但不是 wx_trigger → 拒绝（微信侧非定时触发来源）。
 * 三者全部通过才认定为真实定时触发；判定保持 fail-open（SOURCE 缺失仍放行），
 * 代价是不能靠这一层发现 SOURCE 漂移，故每个拒绝分支都打 warn 留现场。
 */
function isTrustedTimerEvent(event, triggerName) {
  if (!event || event.Type !== 'Timer' || event.TriggerName !== triggerName) {
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

  if (diag.hasOpenid) {
    return reject('事件自称定时触发但携带用户上下文，已按客户端调用处理');
  }
  if (diag.httpShaped) {
    return reject('事件呈 HTTP 触发器形状，已按客户端调用处理');
  }
  if (diag.SOURCE && diag.SOURCE.split(',').indexOf('wx_trigger') === -1) {
    return reject('SOURCE 不含 wx_trigger（若线上确实如此，定时扫描会永远不执行）');
  }

  return true;
}

/**
 * 把云数据库里的各种时间表示统一成毫秒时间戳。
 * 三种来源口径不同：lastMeetTime 是 Date.now() 数字（与 recordMeet.meetTime 同源）、
 * createTime/updateTime 是 db.serverDate() 的 Date、lostTime 是 'YYYY-MM-DD' 字符串。
 * @returns {number} 无法解析时返回 0（调用方据此判「基准缺失」）
 */
function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 判定基准 = max(最后相遇, 建档, 手动复位)。
 *
 * lostResetAt 用于「管理员把自动走失的猫改回正常」之后重启倒计时：
 * 少了它，管理员当晚改回正常、次日 04:00 就会被再标一次走失并再推一轮通知，
 * 形成无法摆脱的循环（该字段由 updateCat 在「lost → normal」时写入）。
 * @returns {number} 毫秒时间戳；0 表示三个基准都缺失（脏数据，只能报告）
 */
function buildBaselineMs(cat) {
  return Math.max(
    toMillis(cat && cat.lastMeetTime),
    toMillis(cat && cat.createTime),
    toMillis(cat && cat.lostResetAt)
  );
}

/** 北京时间 'YYYY-MM-DD'（与管理端日期选择器、lostTime 的存量口径一致） */
function beijingDateStr(ms) {
  const d = toBeijingDate(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 游标扫描在册正常猫，挑出「基准时间已超过阈值」的候选。
 * 游标键用 _id（不能 offset：扫描期间记录增删会让分页漂移、漏猫）。
 * @returns {Promise<{scanned: number, candidates: Array, invalid: number, capped: boolean}>}
 */
async function scanCandidates(now) {
  const candidates = [];
  let scanned = 0;
  let invalid = 0;
  let capped = false;
  let lastId = '';

  while (scanned < MAX_SCAN_CATS) {
    const where = { status: 'normal' };
    if (lastId) where._id = _.gt(lastId);

    const page = await db.collection(COLLECTIONS.CATS)
      .where(where)
      .orderBy('_id', 'asc')
      .field({
        name: true, avatar: true, location: true, lostLocation: true,
        lastMeetTime: true, createTime: true, lostResetAt: true
      })
      .limit(SCAN_PAGE_SIZE)
      .get();

    const rows = page.data || [];
    if (rows.length === 0) break;

    for (const cat of rows) {
      scanned++;
      const baselineMs = buildBaselineMs(cat);
      if (!baselineMs) {
        // 三个基准全缺：无据可依，绝不写库（报告里单独计数）
        invalid++;
        continue;
      }
      const daysSince = Math.floor((now - baselineMs) / (24 * 3600 * 1000));
      if (daysSince >= LOST_THRESHOLD_DAYS) {
        candidates.push({
          catId: cat._id,
          name: cat.name || '',
          avatar: cat.avatar || '',
          location: cat.lostLocation || cat.location || '',
          daysSince,
          baselineMs
        });
      }
    }

    if (rows.length < SCAN_PAGE_SIZE) break;
    lastId = rows[rows.length - 1]._id;
    if (scanned >= MAX_SCAN_CATS) capped = true;
  }

  // 最久没被遇到的先处理（单轮上限被截断时，先救「最可能已经不在」的那批）
  candidates.sort((a, b) => b.daysSince - a.daysSince);
  return { scanned, candidates, invalid, capped };
}

/**
 * 把候选猫标记为走失，并给关注者发走失提醒。
 *
 * 写库用 `where({_id, status:'normal'}).update()` 而不是 doc().update()：
 * 状态是条件，只有真正由本轮从 normal 翻到 lost 的那次更新（stats.updated > 0）
 * 才发通知 —— 期间被管理员改过状态、或被人遇到（自动找回）的猫自动跳过，
 * 重复运行也不会二次推送（幂等）。
 */
async function markLost(candidates) {
  const results = { marked: 0, skipped: 0, errors: 0, notified: 0, pushed: 0, markedCats: [] };

  for (const candidate of candidates) {
    const { catId, name, daysSince, baselineMs, location } = candidate;
    try {
      const updateRes = await db.collection(COLLECTIONS.CATS)
        .where({ _id: catId, status: 'normal' })
        .update({
          data: {
            status: 'lost',
            // 失踪时间 = 最后一次确认看到它的那天（不是今天）
            lostTime: beijingDateStr(baselineMs),
            lostLocation: location || '',
            lostSource: 'auto',
            // 与 updateTime 同步重算列表排序值（本写的前提是 normal → lost，档位取 lost）
            listSort: computeListSort('lost', Date.now()),
            updateTime: db.serverDate()
          }
        });

      const updated = updateRes && updateRes.stats && updateRes.stats.updated || 0;
      if (updated === 0) {
        // 与扫描之间被改动（人工改状态 / 刚被人遇到）：本轮不通知，交给下一轮重新判定
        results.skipped++;
        continue;
      }

      results.marked++;
      results.markedCats.push({ catId, name, daysSince });
      console.log(`[${LOG_SOURCE}] 《${name || catId}》已有 ${daysSince} 天没人遇到，已标记为走失`);

      // 文案如实写明是「系统按天数判定」，不冒充有人确认过
      const notifyRes = await notifyCatStatusChange({
        db,
        cloud,
        catId,
        catName: name,
        catAvatar: candidate.avatar,
        logTag: `[${LOG_SOURCE}] `,
        event: {
          type: STATUS_NOTIFICATIONS.lost.type,
          title: STATUS_NOTIFICATIONS.lost.title,
          tip: `已有${daysSince}天没人遇到`,
          template: `你关注的「{name}」已有 ${daysSince} 天没人遇到，已标记为走失，请帮忙留意！`
        }
      });
      results.notified += notifyRes.notified;
      results.pushed += notifyRes.pushed;
    } catch (err) {
      // 单只失败不影响其余候选：计数后继续
      results.errors++;
      console.error(`[${LOG_SOURCE}] 标记走失失败 catId=${catId}:`, err && err.message);
    }
  }

  return results;
}

/** 定时器节流（只读）：距离上次**成功**运行不足 TIMER_MIN_INTERVAL_MS 则跳过本次 */
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

/** 扫描与写库成功后才写 lastRunAt（失败不占用 20 小时窗口） */
async function markTimerRun(triggerName, record) {
  const data = { key: `timer_${triggerName}`, lastRunAt: Date.now() };
  try {
    if (record) {
      await db.collection(SYSTEM_STATE_COLLECTION).doc(record._id).update({ data });
    } else {
      await db.collection(SYSTEM_STATE_COLLECTION).add({ data });
    }
  } catch (e) {
    console.warn(`[${LOG_SOURCE}] 定时器节流写入失败，下次触发可能重复扫描:`, e.message);
  }
}

/** 失败回滚：只删除**本次运行期间写入**的节流记录（lastRunAt >= runStartAt） */
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

/** 报告里给人工看的样本（全量候选可能很长，日志与返回值都只带前 20 条） */
function sampleOf(candidates) {
  return candidates.slice(0, 20).map(c => ({
    catId: c.catId, name: c.name, daysSince: c.daysSince, baselineDate: beijingDateStr(c.baselineMs)
  }));
}

/**
 * 扫描一轮并按需写库。
 * @param {boolean} write - true 写库（定时器 / 超管 write）；false 只出报告
 * @param {string} callerOpenid - 手动调用的管理员（定时器为空）
 */
async function runSweep(write, callerOpenid) {
  const now = Date.now();
  const report = { mode: write ? 'write' : 'dryRun' };

  const { scanned, candidates, invalid, capped } = await scanCandidates(now);
  report.scanned = scanned;
  report.invalidBaseline = invalid;
  report.scanCapped = capped;
  report.candidates = candidates.length;
  report.samples = sampleOf(candidates);

  if (!write) return report;

  // 异常闸门：候选同时超过单轮上限、且占在册正常猫的一半以上 —— 大概率是数据源异常
  // （历史基准整体失真 / 大批猫的记录被清），整轮放弃写库并落一条失败操作日志
  const anomaly = candidates.length > MAX_AUTO_LOST_PER_RUN && candidates.length * 2 > scanned;
  if (anomaly) {
    report.aborted = true;
    report.reason = 'anomaly_ratio';
    console.error(`[${LOG_SOURCE}] 候选 ${candidates.length}/${scanned} 只，超过异常闸门，本轮未写库`);
    await logOperation(db, callerOpenid || '', {
      module: 'cat',
      action: 'auto_lost',
      description: `自动走失扫描已放弃：候选 ${candidates.length}/${scanned} 只，疑似数据异常`,
      result: 'blocked',
      afterData: { candidates: candidates.length, scanned }
    });
    return report;
  }

  // 单轮上限：最久没被遇到的先处理，其余留给下一轮
  const batch = candidates.slice(0, MAX_AUTO_LOST_PER_RUN);
  report.deferred = candidates.length - batch.length;

  const results = await markLost(batch);
  report.marked = results.marked;
  report.skipped = results.skipped;
  report.errors = results.errors;
  report.notified = results.notified;
  report.pushed = results.pushed;
  report.markedCats = results.markedCats;

  await logOperation(db, callerOpenid || '', {
    module: 'cat',
    action: 'auto_lost',
    description: `自动走失扫描：扫描 ${scanned} 只，标记 ${results.marked} 只` +
      (report.deferred ? `，顺延 ${report.deferred} 只` : '') +
      (results.errors ? `，失败 ${results.errors} 只` : ''),
    result: results.errors > 0 ? 'partial' : 'success',
    afterData: { marked: results.marked, deferred: report.deferred || 0, catIds: results.markedCats.map(c => c.catId) }
  });

  return report;
}

exports.main = async (event, _context) => {
  // 定时触发器分支：必须确认事件确实来自平台定时触发（见 isTrustedTimerEvent），
  // 绝不能只凭客户端可控的 event.Type / event.TriggerName 进入。伪造的调用会落到
  // 下方的管理员鉴权路径上，无 OPENID 时 checkAdmin 必然拒绝。
  if (isTrustedTimerEvent(event, TIMER_TRIGGER_NAME)) {
    const timerRunStartAt = Date.now();
    const timerState = await shouldRunTimer(TIMER_TRIGGER_NAME);
    if (!timerState.allowed) {
      console.log(`[${LOG_SOURCE}] 距上次运行不足 20 小时，跳过本次定时扫描`);
      return ok({ skipped: true });
    }
    try {
      const startTime = Date.now();
      const report = await runSweep(true, '');
      await markTimerRun(TIMER_TRIGGER_NAME, timerState.record);
      console.log(`[${LOG_SOURCE}] 定时扫描完成 (${Date.now() - startTime}ms):`, JSON.stringify(report));
      return ok({ mode: 'timer', report });
    } catch (err) {
      console.error(`[${LOG_SOURCE}] 定时扫描失败:`, err && err.message);
      await rollbackTimerRun(TIMER_TRIGGER_NAME, timerRunStartAt);
      return fail('定时扫描失败，请稍后重试');
    }
  }

  // 手动分支：扫描本身只读，但 write 会成批改写全库猫咪状态并推送，
  // 破坏性口径同 reconcileMeetCount 的 full 模式 —— 写库仅限超级管理员。
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event && event._adminAccount || '';

  const authResult = await checkAdmin(db, OPENID, { operation: '自动走失扫描', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    console.warn(`[${LOG_SOURCE}] 非管理员调用被拒绝`);
    return fail(authResult.error || '无权限执行自动走失扫描');
  }

  const mode = event && event.mode === 'write' ? 'write' : 'dryRun';
  if (mode === 'write' && authResult.adminInfo && authResult.adminInfo.role !== 'superadmin') {
    console.warn(`[${LOG_SOURCE}] write 模式需要 superadmin，当前角色: ${authResult.adminInfo.role}`);
    return fail('正式写库仅限超级管理员');
  }

  try {
    const startTime = Date.now();
    const report = await runSweep(mode === 'write', OPENID);
    console.log(`[${LOG_SOURCE}] 手动扫描（${mode}）完成 (${Date.now() - startTime}ms):`, JSON.stringify(report));
    return ok({ mode, report });
  } catch (err) {
    console.error(`[${LOG_SOURCE}] 手动扫描失败:`, err && err.message);
    return fail('扫描失败，请稍后重试');
  }
};
