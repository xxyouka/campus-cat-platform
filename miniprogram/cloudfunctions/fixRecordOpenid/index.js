/**
 * fixRecordOpenid - 修复缺失 _openid 的打卡记录
 *
 * 安全警告：此云函数仅在明确指定目标记录范围时可用。
 * 必须传入 catId 和 openidHint 参数来窄化修复范围，
 * 防止错误地将管理员 OPENID 批量赋给不相关的记录。
 *
 * 入参：
 *   catId     - 必填，目标猫咪 ID
 *   openidHint - 必填，目标用户的 OPENID（用于匹配关联记录）
 *
 * 逻辑：
 *   1. 验证管理员身份
 *   2. 仅修复指定 catId 且通过 openidHint 关联的记录
 *   3. 限制单次最多修复 10 条
 */
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_FIX_PER_CALL = 10;

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';

  // 管理员认证检查
  const authResult = await checkAdmin(db, OPENID, { operation: '修复记录', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    return fail(authResult.error);
  }

  const { catId, openidHint } = event;

  if (!catId) {
    return fail('缺少 catId 参数，无法确定修复范围');
  }

  // openidHint 必须显式提供。
  // 原实现写作 `openidHint || OPENID`（注释声明必填、代码却兜底成管理员自己），
  // 只传 catId 时会把该猫**其他用户**的打卡记录 _openid 批量改成管理员 openid ——
  // 那些记录随即出现在管理员的「我的相遇」，且按 openid:catId:day 去重的统计一并错乱。
  // 这正是本文件头部警告要防的场景，这里必须硬失败而不是兜底。
  if (!openidHint) {
    return fail('缺少 openidHint 参数，无法确定修复归属，拒绝批量赋权');
  }
  if (typeof openidHint !== 'string' || !/^o[A-Za-z0-9_-]{20,60}$/.test(openidHint)) {
    return fail('openidHint 格式不正确');
  }
  // catId 会进入 where 等值条件，非字符串可能被对象型查询改写语义
  if (typeof catId !== 'string' || !/^[a-fA-F0-9]{20,40}$/.test(catId)) {
    return fail('catId 格式不正确');
  }

  try {
    // 窄化查询：仅修复指定猫咪的缺失 _openid 记录
    const query = {
      catId: catId,
      _openid: _.exists(false)
    };
    const res = await db.collection(COLLECTIONS.RECORD_MEET)
      .where(query)
      .orderBy('meetTime', 'desc')
      .limit(MAX_FIX_PER_CALL)
      .get();

    if (!res.data || res.data.length === 0) {
      return ok({ fixedCount: 0 }, '无需修复');
    }

    // openidHint 已在上方强校验必填且格式合法
    const targetOpenid = openidHint;

    console.warn(`[fixRecordOpenid] 将修复 ${res.data.length} 条记录，catId=${catId}, targetOpenid=${targetOpenid.substring(0, 8)}...`);

    let fixedCount = 0;
    const batch = [];

    for (const record of res.data) {
      batch.push(
        db.collection(COLLECTIONS.RECORD_MEET).doc(record._id).update({
          data: {
            _openid: targetOpenid,
            fixedAt: new Date(),
            fixedBy: 'fixRecordOpenid'
          }
        }).then(() => {
          fixedCount++;
        }).catch(err => {
          console.warn(`[fixRecordOpenid] 修复失败 ${record._id}:`, err.message);
        })
      );

      if (batch.length >= 5) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }

    if (batch.length > 0) {
      await Promise.all(batch);
    }

    console.log(`[fixRecordOpenid] 修复完成，catId=${catId}，共 ${fixedCount} 条记录`);

    await logOperation(db, OPENID, {
      module: 'system', action: 'fix_record_openid',
      description: `修复缺失 _openid 记录: catId=${catId}, 共 ${fixedCount} 条`,
      result: 'success'
    });

    return ok({
      fixedCount,
      catId,
      targetOpenid: targetOpenid.substring(0, 8) + '...'
    }, `成功修复 ${fixedCount} 条记录`);
  } catch (err) {
    console.error('[fixRecordOpenid] 执行失败:', err);
    return fail('修复失败，请稍后重试');
  }
};
