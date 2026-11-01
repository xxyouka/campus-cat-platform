// cloudfunctions/manageSubscribeQuota/index.js - 订阅消息推送次数账本
//
// 背景：微信一次性订阅消息是「授权一次 +1、发送成功 -1」的计数额度，
// 且微信不提供「查询剩余次数」的接口，剩余次数必须自建账本：
//   - 前端授权（wx.requestSubscribeMessage 返回 accept）后调本函数 action:'add'
//   - 各发送侧云函数（updateCat / recordMeet / addCat）发送成功后 -1
//
// 数据模型（subscribeQuota 集合）：
//   { _openid, templateId, remaining: 0~200, createTime, updateTime }
//   openid + templateId 唯一；200 为产品自设封顶（非平台硬性限制），
//   与「我的」页「剩余通知次数（上限200）」展示口径一致。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 单模板剩余次数封顶（产品口径）
const QUOTA_LIMIT = 200;

// 合法模板白名单（默认与前端 config.js 一致；可用环境变量覆盖，
// 须与发送侧 updateCat / recordMeet / addCat 使用同一份模板 ID）
const ALLOWED_TEMPLATE_IDS = [
  process.env.SUBSCRIBE_STATUS_TEMPLATE_ID || '',
  process.env.SUBSCRIBE_MEET_TEMPLATE_ID || '',
  process.env.SUBSCRIBE_NEW_CAT_TEMPLATE_ID || ''
];

/**
 * 归一化并过滤 templateIds（兼容单个 templateId 字符串写法）。
 * 只允许白名单内的模板，防止写入任意键；一次调用最多取 5 个（前端一次弹窗上限）。
 */
function normalizeTemplateIds(event) {
  const raw = Array.isArray(event.templateIds)
    ? event.templateIds
    : event.templateId ? [event.templateId] : [];
  const unique = [...new Set(raw)];
  return unique
    .filter(id => typeof id === 'string' && ALLOWED_TEMPLATE_IDS.includes(id))
    .slice(0, 5);
}

/**
 * 单模板 +1。
 * 同一用户的并发连点由前端点击锁规避；服务端仍做上限回夹，
 * 保证 remaining 永不越界（极端并发下最多少记一次，不会多记）。
 */
async function bumpOne(openid, templateId) {
  const existing = await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA)
    .where({ _openid: openid, templateId })
    .limit(1)
    .get();
  const row = existing.data && existing.data[0];

  if (!row) {
    await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA).add({
      data: {
        _openid: openid,
        templateId,
        remaining: 1,
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    });
    return 1;
  }

  const current = Math.min(Number(row.remaining) || 0, QUOTA_LIMIT);
  const next = Math.min(current + 1, QUOTA_LIMIT);
  if (next !== current) {
    await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA).doc(row._id).update({
      data: { remaining: next, updateTime: db.serverDate() }
    });
  }
  return next;
}

/** 读取当前用户全量剩余次数（缺省模板补 0，越界值回夹到上限） */
async function readCounts(openid) {
  const res = await db.collection(COLLECTIONS.SUBSCRIBE_QUOTA)
    .where({ _openid: openid })
    .limit(ALLOWED_TEMPLATE_IDS.length + 5)
    .get();

  const counts = {};
  ALLOWED_TEMPLATE_IDS.forEach(id => { counts[id] = 0; });
  (res.data || []).forEach(row => {
    if (counts[row.templateId] !== undefined) {
      // 回夹到 [0, 上限]：发送侧用原子 inc(-1)，极端并发下可能短暂为负
      counts[row.templateId] = Math.max(0, Math.min(Number(row.remaining) || 0, QUOTA_LIMIT));
    }
  });

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, total, limit: QUOTA_LIMIT };
}

/**
 * action:add —— 用户授权 accept 后记账 +1。
 *
 * 返回**全量快照**（三个模板都在，形状与 action:'get' 一致），而不是只回本次涉及的
 * 那几个模板：调用方拿到的 counts 里缺 key 时无从判断「这次没涉及」还是「数字是 0」，
 * 前端按 0 渲染就出现「授权一个模板、另外两类在界面上被清零」的假象
 *（账本其实没变，切页重新 get 才恢复）。账本本来只有三条记录，回读一次即可。
 */
async function handleAdd(openid, event) {
  const templateIds = normalizeTemplateIds(event);
  if (templateIds.length === 0) {
    return fail('缺少有效的模板ID');
  }

  for (const templateId of templateIds) {
    await bumpOne(openid, templateId);
  }
  return ok(await readCounts(openid), '已增加');
}

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
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  try {
    switch (action) {
      case 'add':
        return await handleAdd(OPENID, event);
      case 'get':
        return ok(await readCounts(OPENID), '查询完成');
      default:
        return fail('未知操作类型');
    }
  } catch (err) {
    // 把真实原因带回前端：集合未创建 / 权限 / 网络在前端能直接看出来，
    // 之前一律「操作失败」会把部署问题伪装成业务失败，排查时完全无从下手
    const reason = err && (err.errMsg || err.message) || '未知错误';
    console.error('[manageSubscribeQuota] 操作失败:', err);
    return fail(`操作失败：${reason}`);
  }
};
