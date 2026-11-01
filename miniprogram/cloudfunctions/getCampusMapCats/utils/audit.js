// cloudfunctions/utils/audit.js - 审计日志公共模块（记录写操作到审计集合，失败不阻塞主流程）
const { db } = require('./cloud');

const AUDIT_COLLECTION = 'audit_logs';

async function log({ action, operator, targetType, targetId, detail, result }) {
  try {
    await db.collection(AUDIT_COLLECTION).add({
      data: {
        action,
        operator: operator || 'system',
        targetType: targetType || '',
        targetId: targetId || '',
        detail: detail || '',
        result: result || 'success',
        createTime: db.serverDate()
      }
    });
  } catch (err) {
    console.warn('[audit] 审计日志写入失败（非致命）:', err.message);
  }
}

module.exports = { log };
