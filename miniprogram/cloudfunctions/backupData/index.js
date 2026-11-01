// cloudfunctions/backupData/index.js - 备份数据库数据（管理员权限校验，输出 JSON 备份）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { backupCollection } = require('./backupCollection');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const BACKUP_COLLECTIONS = [
  COLLECTIONS.CATS, COLLECTIONS.PHOTOS, COLLECTIONS.RECORD_MEET,
  COLLECTIONS.NOTICES, COLLECTIONS.HEALTH_RECORDS, COLLECTIONS.OPERATION_LOGS
];
// 定时备份只覆盖业务数据：ADMINS 含密码哈希不入备份，OPERATION_LOGS 含 openid 备份价值低
const TIMER_BACKUP_COLLECTIONS = [
  COLLECTIONS.CATS, COLLECTIONS.PHOTOS, COLLECTIONS.RECORD_MEET,
  COLLECTIONS.NOTICES, COLLECTIONS.HEALTH_RECORDS
];
const MAX_RECORDS_PER_BATCH = 100;
// 定时触发器名称，与 config.json 中 triggers[0].name 保持一致
const TIMER_TRIGGER_NAME = 'dailyBackupTimer';
// 定时器运行状态集合：作为定时备份的节流（纵深防御，不是鉴权手段）
const SYSTEM_STATE_COLLECTION = 'system_state';
const TIMER_MIN_INTERVAL_MS = 20 * 3600 * 1000;

/**
 * 汇总定时触发判定所需的现场信息（仅用于日志，不参与放行判定）。
 * 对抗性审核 P2-3：第 3 层判据是 fail-open 的（SOURCE 缺失即放行），但它同时是
 * 「定时备份静默失效」的唯一现场——本机无法验证线上 SOURCE 的真实取值。
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
 * 完整合并进 event，这两个字段完全由客户端控制；HTTP 访问服务（已为 /backupData 配路由）
 * 的 event.body 同样可被调用方任意构造。定时触发调用则没有任何用户上下文，
 * 因此以「确实没有用户上下文」为主判据：
 *   1) 有 OPENID → 必为客户端调用，直接拒绝（客户端调用一定带 OPENID）；
 *   2) 事件呈 HTTP 触发器形状 → 拒绝（body 可控且同样没有 OPENID）；
 *   3) 来源（SOURCE）存在但不是 wx_trigger → 拒绝（微信侧非定时触发来源，如 wx_client/wx_http）。
 * 三者全部通过才认定为真实定时触发。
 *
 * 判定逻辑**保持 fail-open 不变**（SOURCE 缺失仍放行），否则环境变量异常会让每日备份
 * 静默死亡；代价是不能靠这一层发现 SOURCE 漂移，故每个拒绝分支都打 warn 留现场。
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
      console.warn('[backupData] 事件声称定时触发但 TriggerName 不匹配，未进入定时分支',
        { ...timerDiagnostics(event), expectedTriggerName: triggerName });
    }
    return false;
  }

  const diag = timerDiagnostics(event);
  const reject = (reason) => {
    console.warn(`[backupData] 拒绝定时触发分支: ${reason}`, diag);
    return false;
  };

  // 1) 有用户上下文 → 来自客户端（或经客户端调用链），绝不能进定时分支
  if (diag.hasOpenid) {
    return reject('事件自称定时触发但携带用户上下文，已按客户端调用处理');
  }

  // 2) HTTP 访问服务事件：body/httpMethod 等由平台注入，且 body 可被调用方任意构造
  if (diag.httpShaped) {
    return reject('事件呈 HTTP 触发器形状，已按客户端调用处理');
  }

  // 3) 微信侧来源不是定时触发器
  if (diag.SOURCE && diag.SOURCE.split(',').indexOf('wx_trigger') === -1) {
    return reject('SOURCE 不含 wx_trigger（若线上确实如此，定时备份会永远不执行）');
  }

  return true;
}

/**
 * 去掉 manifest 中的云存储路径，仅用于返回给调用方的响应体。
 * manifest 本身（写入云存储的那份）保留 path，便于按时间戳目录恢复数据。
 * @param {object} manifest
 * @returns {object}
 */
function toResponseManifest(manifest) {
  const collections = {};
  for (const [col, info] of Object.entries(manifest.collections || {})) {
    collections[col] = info.error
      ? { count: info.count, error: info.error }
      : { count: info.count };
  }
  return { ...manifest, collections };
}

function hasCollectionFailures(manifest) {
  return Object.values(manifest.collections || {}).some(info => !!info.error);
}

/**
 * P1-2：daysOld 必须是 1-3650 之间的整数。
 * 旧代码只判真值（`!daysOld`），daysOld = -1 会让截止日落在「明天」，
 * 从而把全表当作历史数据归档并删除（createTime < 明天 恒真）。
 */
function isValidArchiveDays(daysOld) {
  return Number.isInteger(daysOld) && daysOld >= 1 && daysOld <= 3650;
}

async function archiveOldRecords(collectionName, daysOld, archiveCollectionName) {
  // 纵深防御（P1-2）：入口已校验 daysOld，这里再挡一次——本函数会真删数据，
  // 不能依赖任何单一调用点（-1/NaN 会让截止日落在未来 = 全表归档并删除）。
  if (!isValidArchiveDays(daysOld)) {
    throw new Error(`非法的 daysOld: ${daysOld}`);
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  let archived = 0;
  let hasMore = true;
  let offset = 0;

  while (hasMore) {
    // 稳定排序键：与 backupCollection 同因，删除过程中分页顺序必须确定
    const res = await db.collection(collectionName)
      .where({
        createTime: _.lt(cutoffDate)
      })
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(MAX_RECORDS_PER_BATCH)
      .get();

    if (res.data.length === 0) {
      hasMore = false;
      break;
    }

    // 1) 先复制本批到归档集合，全部就位并校验后才删除源记录。
    //    归档 _id 沿用原始 _id：重跑天然幂等（已归档的跳过，不产生双份）。
    //    注意保留 _openid（备份是灾备恢复的唯一来源，丢了无法还原归属）。
    const batchIds = res.data.map(r => r._id);
    let alreadyArchived = new Set();
    try {
      const existRes = await db.collection(archiveCollectionName)
        .where({ _id: _.in(batchIds) })
        .field({ _id: true })
        .limit(MAX_RECORDS_PER_BATCH)
        .get();
      alreadyArchived = new Set((existRes.data || []).map(d => d._id));
    } catch (existErr) {
      console.warn('[backupData] 归档去重查询失败，按全量归档处理:', existErr.message);
    }

    let archivedOk = 0;
    for (const record of res.data) {
      const { _id, ...data } = record;
      if (alreadyArchived.has(_id)) {
        archivedOk++;
        continue;
      }
      await db.collection(archiveCollectionName).add({
        data: {
          _id: _id,
          ...data,
          _originalId: _id,
          _archivedAt: new Date(),
          _archivedFrom: collectionName
        }
      });
      archivedOk++;
    }

    if (archivedOk !== res.data.length) {
      // 归档不完整：中断本批删除，源数据保持完好（重跑可收敛）
      throw new Error(`归档校验失败：${archivedOk}/${res.data.length}，已停止删除源记录`);
    }

    // 2) 归档全部就位后再删除源记录（删除失败时源数据仍在，重跑幂等收敛）
    for (const id of batchIds) {
      await db.collection(collectionName).doc(id).remove();
    }

    archived += res.data.length;
    offset = 0;
  }

  return archived;
}

/**
 * 定时器节流（只读）：判断距离上次成功运行是否已超过 TIMER_MIN_INTERVAL_MS。
 *
 * 对抗性审核 P2-7：旧实现在这里**先落盘 lastRunAt 再执行备份**，备份一旦超时/写失败
 * 就只返回 fail、节流记录不回滚，导致当天备份静默丢失且 20 小时内不再补跑。
 * 现在拆成「读（本函数）→ 执行 → 成功后 markTimerRun 落盘 / 失败后 rollbackTimerRun」。
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
    // 状态集合异常时不阻塞备份（宁可多备一次也不漏备）
    console.warn('[backupData] 定时器节流查询失败，继续执行:', e.message);
    return { allowed: true, record: null };
  }
}

/**
 * 全量备份成功后才写 lastRunAt（P2-7：写入时机＝成功之后）。
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
    // 节流写入失败不改变「备份已成功」这一事实，下次触发会多备一次（无害）
    console.warn('[backupData] 定时器节流写入失败，下次触发可能重复备份:', e.message);
  }
}

/**
 * 失败回滚：只删除**本次运行期间写入**的节流记录（lastRunAt >= runStartAt），
 * 保证一次失败不会留下 20 小时窗口把下一次触发挡在门外。
 * 正常流程下 markTimerRun 只在成功后调用，这里是兜底（防将来有人把写入提前）。
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
    console.warn('[backupData] 已回滚本次运行的节流记录，下次触发将立即补跑');
  } catch (e) {
    console.warn('[backupData] 节流回滚失败（可能被 20 小时窗口挡住下一次）:', e.message);
  }
}

/**
 * 备份指定集合列表并写 manifest
 */
async function runBackup(targetCollections) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const results = {};

  for (const col of targetCollections) {
    // 单集合失败不再拖垮整份备份：记录失败详情并继续（manifest 中可见）。
    // 历史事故：operation_logs 集合缺失时 runBackup 整体 reject，
    // 手动备份与每日定时备份全部静默失败（2026-10-07 定位）。
    try {
      const data = await backupCollection(db, _, col);
      const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
      const filePath = `backups/${timestamp}/${col}.json`;

      await cloud.uploadFile({
        cloudPath: filePath,
        fileContent: buffer
      });

      results[col] = { count: data.length, path: filePath };
    } catch (colErr) {
      console.error(`[backupData] 集合 ${col} 备份失败:`, colErr && colErr.message);
      results[col] = { count: 0, error: colErr && colErr.message || '备份失败' };
    }
  }

  const manifest = {
    timestamp,
    collections: results,
    totalRecords: Object.values(results).reduce((sum, r) => sum + r.count, 0),
    environment: cloud.DYNAMIC_CURRENT_ENV
  };

  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  await cloud.uploadFile({
    cloudPath: `backups/${timestamp}/manifest.json`,
    fileContent: manifestBuffer
  });

  return manifest;
}

/**
 * 定时备份分支（仅在 isTrustedTimerEvent 放行后调用）
 */
async function runTimerBackup() {
  const timerRunStartAt = Date.now();
  try {
    const timerState = await shouldRunTimer(TIMER_TRIGGER_NAME);
    if (!timerState.allowed) {
      console.log('[backupData] 距上次运行不足 20 小时，跳过本次定时备份');
      return ok({ data: { skipped: true } });
    }
    const manifest = await runBackup(TIMER_BACKUP_COLLECTIONS);
    if (hasCollectionFailures(manifest)) {
      console.error('[backupData] 定时备份未完整完成，不更新节流记录');
      return { ...fail('部分集合备份失败，未记为成功；请检查备份清单并重试'), data: toResponseManifest(manifest) };
    }
    // P2-7：lastRunAt 只在全量备份成功后写入，失败不会占用 20 小时窗口
    await markTimerRun(TIMER_TRIGGER_NAME, timerState.record);
    console.log('[backupData] 定时备份完成', { totalRecords: manifest.totalRecords });
    return ok({ data: toResponseManifest(manifest) });
  } catch (err) {
    console.error('[backupData] 定时备份失败:', err);
    await rollbackTimerRun(TIMER_TRIGGER_NAME, timerRunStartAt);
    return fail('定时备份失败，请稍后重试');
  }
}

exports.main = async (event) => {
  // 定时触发器分支：必须确认事件确实来自平台定时触发（见 isTrustedTimerEvent），
  // 绝不能只凭客户端可控的 event.Type / event.TriggerName 进入。伪造的调用会落到
  // 下方的管理员鉴权路径上，无 OPENID 时 checkAdmin 必然拒绝。
  // 注意：TIMER_BACKUP_COLLECTIONS 含 RECORD_MEET（全体用户 openid）、HEALTH_RECORDS，
  // 属于敏感数据，该分支只能由定时触发器进入；
  // system_state 的 20 小时节流只是纵深防御。
  // 该判断放在 body 合并之前，避免 HTTP body 影响判定。
  //
  // 上线后需检查一次定时触发日志，确认 isTrustedTimerEvent 第 3 层判据里
  // SOURCE 的实际取值（本机无法验证）。若线上 SOURCE 不是 wx_trigger，定时备份会被
  // 静默拒绝、永不执行；拒绝分支已打 warn，日志里搜 "拒绝定时触发分支" 即可。
  if (isTrustedTimerEvent(event, TIMER_TRIGGER_NAME)) {
    return runTimerBackup();
  }

  // HTTP触发器适配：解析body中的JSON数据
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }

  const { action, collection, daysOld } = event;

  const wxContext = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';
  const { checkAdmin } = require('./utils/auth');
  const authResult = await checkAdmin(db, wxContext.OPENID || '', { operation: '备份归档', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    return fail('权限不足');
  }
  // 备份/归档会导出全量数据（含 OPERATION_LOGS 中的 openid），仅超级管理员可操作
  const isSuperAdmin = authResult.adminInfo?.role === 'superadmin';
  if (!isSuperAdmin) {
    return fail('仅超级管理员可执行备份/归档');
  }

  try {
    switch (action) {
      case 'backup': {
        const targetCollections = collection
          ? [collection]
          : BACKUP_COLLECTIONS;
        // 集合白名单：防止遍历/导出任意集合（含未来新增的敏感集合）
        const invalidCollections = targetCollections.filter(c => !BACKUP_COLLECTIONS.includes(c));
        if (invalidCollections.length > 0) {
          return fail(`不允许备份的集合: ${invalidCollections.join(', ')}`);
        }

        const manifest = await runBackup(targetCollections);
        // 响应中不含备份文件路径/文件ID：调用方可通过云存储控制台查看 backups/ 目录
        if (hasCollectionFailures(manifest)) {
          return { ...fail('部分集合备份失败，请检查备份清单并重试'), data: toResponseManifest(manifest) };
        }
        return ok({ data: toResponseManifest(manifest) });
      }

      case 'list': {
        const _listResult = await cloud.getTempFileURL({
          fileList: []
        });
        return ok({ data: { message: '请通过云存储控制台查看 backups/ 目录' } });
      }

      case 'archive': {
        if (!collection || !daysOld) {
          return fail('需要提供 collection 和 daysOld 参数');
        }
        // daysOld 必须是 1-3650 的整数（对抗性审核 P1-2，见 isValidArchiveDays）
        if (!isValidArchiveDays(daysOld)) {
          return fail('daysOld 必须是 1-3650 之间的整数（单位：天）');
        }
        // 归档同样限制在白名单集合内，防止误删/转移任意集合数据
        if (!BACKUP_COLLECTIONS.includes(collection)) {
          return fail(`不允许归档的集合: ${collection}`);
        }

        const archiveCollectionName = `${collection}_archive`;
        const archived = await archiveOldRecords(collection, daysOld, archiveCollectionName);

        return ok({
          data: {
            collection,
            archiveCollection: archiveCollectionName,
            archivedCount: archived,
            daysOld
          }
        });
      }

      default:
        return fail('未知操作，支持: backup, list, archive');
    }
  } catch (err) {
    console.error('[backupData] 备份失败:', err);
    return fail('备份失败，请稍后重试');
  }
};
