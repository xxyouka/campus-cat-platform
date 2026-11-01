// cloudfunctions/subscribeCatStatus/index.js - 记录猫咪状态变更订阅授权（一次性订阅）
//
// 模板 ID：本文件 STATUS_TEMPLATE_ID 已填真实 ID（与前端 config.js 一致）；
// 前端 detail.js 订阅成功后会把实际授权的 templateId 显式传入（优先生效）。
// 如需更换模板：改前端 config.js 的 subscribeTemplateId 并重新发布，
// 云函数侧可用环境变量 SUBSCRIBE_STATUS_TEMPLATE_ID / SUBSCRIBE_MEET_TEMPLATE_ID 覆盖。
//
// 数据模型（userSubscriptions 集合）：
//   { _openid, catId, templateId, status: 'accept'|'ignore', createTime, updateTime }
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 默认模板 ID（与前端 config.js 一致，模板 ID 不敏感）；前端调用时会显式传入
// templateId 参数，此处仅作兜底；如需更换可配环境变量 SUBSCRIBE_STATUS_TEMPLATE_ID。
const STATUS_TEMPLATE_ID = process.env.SUBSCRIBE_STATUS_TEMPLATE_ID || '';
const ALLOWED_STATUS = ['accept', 'ignore'];

exports.main = async (event, _context) => {
  // HTTP触发器适配：解析body中的JSON数据
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const { OPENID } = cloud.getWXContext() || {};
  if (!OPENID) return fail('请先登录后再记录订阅', 'UNAUTHORIZED');
  const { catId, templateId = STATUS_TEMPLATE_ID, status = 'accept' } = event;

  if (!catId) {
    return fail('缺少猫咪信息');
  }
  // 常规订阅绑定具体猫（24-40 位 hex id）；「新猫登场提醒」是全局订阅，
  // 以 'new_cat' 作为集合内标识，不绑定具体猫咪
  const GLOBAL_SUBSCRIBE_IDS = ['new_cat'];
  const isGlobalSubscribe = GLOBAL_SUBSCRIBE_IDS.includes(catId);
  if (typeof catId !== 'string' || !isGlobalSubscribe && !/^[a-fA-F0-9]{20,40}$/.test(catId)) {
    return fail('无效的猫咪ID格式');
  }
  if (!ALLOWED_STATUS.includes(status)) {
    return fail('无效的订阅状态');
  }
  if (!templateId || typeof templateId !== 'string') {
    return fail('缺少模板ID');
  }

  try {
    const existing = await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS)
      .where({ _openid: OPENID, catId, templateId })
      .limit(1)
      .get();

    if (existing.data && existing.data.length > 0) {
      await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS)
        .doc(existing.data[0]._id)
        .update({
          data: { status, updateTime: db.serverDate() }
        });
    } else {
      await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS).add({
        data: {
          _openid: OPENID,
          catId,
          templateId,
          status,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
    }

    return ok(null, status === 'accept' ? '订阅成功' : '已忽略订阅');
  } catch (err) {
    console.error('[subscribeCatStatus] 订阅记录失败:', err);
    return fail('订阅记录失败，请稍后重试');
  }
};
