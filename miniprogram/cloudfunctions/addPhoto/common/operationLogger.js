// cloudfunctions/common/operationLogger.js - 操作日志公共模块（记录管理员操作到日志集合）
const { COLLECTIONS } = require('../utils/constants');
// 清洗 changes 复用同一份实现，避免「封顶长度/条数」在两处各写一遍而漂移
const { sanitizeChanges } = require('./changeSummary');

const LOG_RETENTION_DAYS = 90;

// 服务端没能把调用方解析成 admins 里的某个管理员时，身份字段写这个值，
// 而不是「客户端声称的账号」—— 声称值只能进 claimedAccount 这个旁证字段。
const UNVERIFIED_ACCOUNT = 'unverified';

/**
 * 按调用者 openid 解析管理员身份。
 * 依次尝试三种字段口径（新 → 历史兼容）：
 *   1. openid  —— 与 utils/auth.js checkAdmin 一致的主口径
 *   2. _openid —— 部分存量 admins 记录使用的字段
 *   3. account —— callerOpenid 实际为账号名的历史场景
 *
 * 注意口径 3：它让「账号名」也能解析出管理员，因此**调用方绝不能把客户端可控的
 * event._adminAccount 塞进 callerOpenid**（manageAdmin 历史上就这么干过，
 * 已于 2026-10-09 修正为只传服务端真实 OPENID）。日志身份的可信度取决于这个前提。
 * @param {Object} db - 云数据库实例
 * @param {string} callerOpenid - 调用者 openid 或账号名
 * @returns {Promise<{account: string, displayName: string}|null>} 未命中返回 null
 */
async function resolveAdminByOpenid(db, callerOpenid) {
  const candidates = [
    { openid: callerOpenid },
    { _openid: callerOpenid },
    { account: callerOpenid }
  ];

  for (const where of candidates) {
    const res = await db.collection(COLLECTIONS.ADMINS).where(where).limit(1).get();
    const admin = res.data && res.data[0];
    if (admin) {
      return {
        account: admin.account || 'unknown',
        displayName: admin.displayName || admin.account || 'unknown'
      };
    }
  }

  return null;
}

async function logOperation(db, callerOpenid, info) {
  // 解构必须放在**函数体**里，不能写在形参列表里：形参列表中的解构在 info 为
  // undefined/null 时会在进入函数体前抛错，而 async 函数会把参数解构抛错转成
  // rejected promise —— 于是「logOperation 永不 reject」这条所有调用点的 await
  // 都依赖的假设就不成立（await 一个 reject 会把已成功的业务操作回报成失败）。
  // 又必须留在 try 之外：下方 catch 的失败日志要用 module/action。
  // summary / changes 是给人看的摘要层（由 changeSummary 生成），
  // 与下面的 beforeData/afterData 审计层并列且互不影响：
  // 老日志没有这两个字段，前端回退渲染 description，不会出现空白。
  const {
    module, action, description, result, beforeData, afterData,
    summary, changes, adminAccount: explicitAccount
  } = info || {};

  try {
    let adminAccount = 'unknown';
    let adminDisplayName = 'unknown';

    // callerOpenid 只在能解析出 admins 记录时才当身份用；
    // 空值时没必要白跑一次查询（定时器、控制台测试等无 OPENID 的场景）
    if (callerOpenid) {
      const resolved = await resolveAdminByOpenid(db, callerOpenid);
      if (resolved) {
        adminAccount = resolved.account;
        adminDisplayName = resolved.displayName;
      }
    }

    // 解析不出身份时**不采信** explicitAccount：它一路来自 event._adminAccount，
    // 是客户端可控字符串（SECURITY.md：客户端字段不得参与身份判定）。
    // 旧实现直接 adminAccount = explicitAccount，于是日志会把「谁做的」显示成
    // 调用方自称的账号 —— 操作日志一旦能自称，事后追责就失去意义。
    // 现在身份标 unverified，自称值另存 claimedAccount 供人工比对。
    const claimed = explicitAccount ? String(explicitAccount).slice(0, 64) : '';

    const now = new Date();
    const expireAt = new Date(now.getTime() + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    if (adminAccount === 'unknown') {
      adminAccount = claimed ? UNVERIFIED_ACCOUNT : 'unknown';
    }

    const logData = {
      adminAccount,
      adminDisplayName,
      adminOpenid: callerOpenid || '',
      module,
      action,
      description: description || `${module}-${action}`,
      result: result || 'success',
      operateTime: now,
      createTime: now,
      expireAt
    };

    if (claimed) {
      logData.claimedAccount = claimed;
    }

    if (beforeData !== undefined && beforeData !== null) {
      logData.beforeData = beforeData;
    }
    if (afterData !== undefined && afterData !== null) {
      logData.afterData = afterData;
    }

    // 摘要层：管理端列表优先渲染这一层，读不出「改了啥」时才回退 description。
    // 空值一律不写字段（与 beforeData/afterData 同口径）：
    // 写入 null / '' 会让前端「有摘要」的判断为真，却渲染出空白卡片。
    if (summary) {
      logData.summary = String(summary).slice(0, 300);
    }
    const cleanChanges = sanitizeChanges(changes);
    if (cleanChanges.length) {
      logData.changes = cleanChanges;
    }

    // wx-server-sdk 的 add 签名为 add(options) 且内部读取 options.data，
    // 直接传 logData 会导致写入内容为空，必须包一层 { data }
    const addRes = await db.collection(COLLECTIONS.OPERATION_LOGS).add({ data: logData });
    console.log(`[OpLog] ${module}/${action} by ${adminAccount}`);

    return addRes._id;
  } catch (err) {
    // 日志失败不阻断业务主流程，但必须留下可定位的错误上下文
    console.error(`[OpLog] 记录失败 module=${module} action=${action} caller=${callerOpenid || 'anonymous'}:`, err && err.message);
    return null;
  }
}

module.exports = { logOperation };
