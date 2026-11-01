// cloudfunctions/updateCat/index.js - 编辑猫咪信息云函数
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { checkAdmin } = require('./utils/auth');
const { checkImage, checkText } = require('./utils/contentSecurity');
const { isAllowedStorageFileUnder } = require('./utils/filePathGuard');
const { logOperation } = require('./common/operationLogger');
const { diffCatFields, buildSummary } = require('./common/changeSummary');
const { COLLECTIONS, CAT_ALLOWED_FIELDS, CAT_FIELD_LENGTH_LIMITS, CAT_FIELD_LABELS, CAT_NUMERIC_FIELDS, CAT_VALID_STATUS, CAT_VALID_HEALTH_STATUS, isValidAdoptLevel } = require('./utils/constants');
const { ok, fail } = require('./utils/response');
// 状态变更通知（站内 notifications + 订阅推送）已抽成 canonical 模块，
// 与 recordMeet（走失猫再次被遇到）和 sweepLostCats（久未相遇自动走失）共用
// 同一份实现与文案表。改文案/改推送口径请改 cloudfunctions/utils/statusNotify.js。
const { STATUS_NOTIFICATIONS, notifyCatStatusChange } = require('./utils/statusNotify');
// 列表排序值（首页/搜索顺序）：编辑/改状态时必须同步重算，见 utils/listSort.js 的维护纪律
const { computeListSort } = require('./utils/listSort');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 健康状态变更通知（与状态变更共用「活动状态变更通知」订阅模板，无需新模板）
const HEALTH_NOTIFICATIONS = {
  healthy: { type: 'cat_health_ok', title: '康复提醒', tip: '已恢复健康', template: '好消息！你关注的「{name}」身体已恢复健康。' },
  stomatitis: { type: 'cat_health_stomatitis', title: '口炎提醒', tip: '请注意口腔健康', template: '你关注的「{name}」出现口炎症状，请多留意。' },
  skin: { type: 'cat_health_skin', title: '皮肤病提醒', tip: '请注意皮肤状况', template: '你关注的「{name}」出现皮肤问题，请多留意。' },
  other: { type: 'cat_health_other', title: '健康提醒', tip: '身体不适，请多留意', template: '你关注的「{name}」身体不适，请多留意。' }
};

// 订阅消息推送已随通知逻辑一起抽到 utils/statusNotify.js（canonical 源）。

/**
 * HTTP 触发器适配：若 event.body 是 JSON 字符串则解析并合并进 event
 * @returns {Object} 合并后的 event
 */
function normalizeEvent(event) {
  if (!event.body || typeof event.body !== 'string') return event;

  try {
    return { ...event, ...JSON.parse(event.body) };
  } catch (e) {
    // body 不是合法 JSON，保持原样
    return event;
  }
}

/**
 * 校验各字段长度是否超限
 * @param {Object} updateData - 待更新数据
 * @returns {string|null} 超限时的错误文案，通过时返回 null
 */
function validateFieldLengths(updateData) {
  for (const [field, maxLength] of Object.entries(CAT_FIELD_LENGTH_LIMITS)) {
    const value = updateData[field];
    if (typeof value === 'string' && value.length > maxLength) {
      console.warn(`[updateCat] 字段 ${field} 超长: ${value.length}/${maxLength}`);
      return `${CAT_FIELD_LABELS[field] || field}内容过长，请缩短后重试`;
    }
  }
  return null;
}

/**
 * 按字段白名单消毒更新数据
 * @param {Object} updateData - 客户端提交的原始数据
 * @returns {{data?: Object, error?: string}} 成功返回 data，失败返回 error
 */
function buildSanitizedData(updateData) {
  const sanitizedData = {};

  for (const field of CAT_ALLOWED_FIELDS) {
    if (updateData[field] === undefined) continue;
    const value = updateData[field];

    if (typeof value === 'string') {
      if (field === 'avatar') {
        const urlValidation = sanitizer.validateUrl(value);
        if (!urlValidation.isValid) {
          return { error: '头像URL格式不正确' };
        }
        // 头像必须是 cats/ 下的云存储文件（客户端只在更换头像时下发该字段，
        // 存量旧值不会被触碰）。收窄路径 + 拒绝 https 外链的原因同 addCat：
        // 防止「传任意已知 fileID 触发服务端删除」与「https 跳过 imgSecCheck」。
        if (!isAllowedStorageFileUnder(urlValidation.url, ['cats/'])) {
          return { error: '头像文件路径不正确' };
        }
        sanitizedData[field] = urlValidation.url;
        continue;
      }

      const maxLen = CAT_FIELD_LENGTH_LIMITS[field] || 500;
      const sanitized = sanitizer.sanitize(value, { maxLength: maxLen, fieldName: field });
      if (!sanitized && value.trim()) {
        return { error: `${field}包含不安全内容，请调整后重试` };
      }
      sanitizedData[field] = sanitized;
      continue;
    }

    if (Array.isArray(value)) {
      const sanitizedArr = value
        .map(item => typeof item === 'string'
          ? sanitizer.sanitize(item, { maxLength: 200, fieldName: field })
          : item)
        .filter(item => item !== null && item !== '');
      if (sanitizedArr.length !== value.length) {
        return { error: `${field}包含不安全内容，请调整后重试` };
      }
      sanitizedData[field] = sanitizedArr;
      continue;
    }

    // 同 addCat：白名单只管字段名不类型，对象值会原样落库并污染查询语义。
    if (!CAT_NUMERIC_FIELDS.includes(field)) {
      return { error: `${field}类型不正确` };
    }
    sanitizedData[field] = value;
  }

  // 枚举字段必须落在合法取值集合内。status 决定猫咪是否可见
  // （filterCats / catRelation 都按 where.status = _.in([...]) 取数），
  // 一个枚举外的值就会让这只猫从前台永久消失且接口仍返回成功。
  if (sanitizedData.status !== undefined && !CAT_VALID_STATUS.includes(sanitizedData.status)) {
    return { error: '猫咪状态取值不合法' };
  }
  if (sanitizedData.healthStatus !== undefined && !CAT_VALID_HEALTH_STATUS.includes(sanitizedData.healthStatus)) {
    return { error: '健康状态取值不合法' };
  }
  // 好猫星级：0 = 未评级（管理员把星级清空时下发的就是 0），3/4/5 = 星级。
  // 与 addCat 同口径校验整数范围，避免字符串/小数落库后前台渲染与筛选异常。
  if (sanitizedData.adoptLevel !== undefined && !isValidAdoptLevel(sanitizedData.adoptLevel)) {
    return { error: '好猫星级取值不合法' };
  }
  return { data: sanitizedData };
}

// 字段名 → 中文标签：统一取自 utils/constants 的 CAT_FIELD_LABELS
// （管理端编辑表单与 addCat 长度错误共用同一份文案，避免各写一套漂移）

// checkText 对超过其单次上限（500 字）的输入返回「内容长度不能超过500字」，
// 需与「真正的内容违规」区分：前者是可操作的长度问题，后者是审核不通过。
const TEXT_LENGTH_ERROR_PATTERN = /^内容长度不能超过(\d+)字$/;

/**
 * 对本次更新的文本字段逐项做 msgSecCheck（单次限 500 字，失败关闭）。
 * 与 addCat 的 checkCatTextContent 保持同一合规口径，防止编辑路径绕过文本审核。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkCatTextContent(sanitizedData, openid) {
  const contentCheckFields = ['name', 'description', 'appearance', 'notes'];
  for (const field of contentCheckFields) {
    const fieldValue = sanitizedData[field];
    if (fieldValue && typeof fieldValue === 'string' && fieldValue.trim()) {
      const result = await checkText(fieldValue, { scene: 2, openid });
      if (!result.ok) {
        console.warn(`[updateCat] 字段 ${field} 内容安全检测未通过`);
        const label = CAT_FIELD_LABELS[field] || field;
        const rawError = result.error || '';
        const lengthMatch = TEXT_LENGTH_ERROR_PATTERN.exec(rawError);
        if (lengthMatch) {
          return { ok: false, error: `${label}长度不能超过 ${lengthMatch[1]} 字，请精简后保存` };
        }
        return { ok: false, error: `${label}${rawError.replace(/^内容/, '')}` };
      }
    }
  }
  return { ok: true };
}

/**
 * 内容安全检测：头像图片 + 文本字段（失败关闭）。
 * 与 addCat 保持同一合规口径，编辑路径不得绕过审核。
 * refId 一并传给异步检测：回调据此给违规头像打标记（此路径 catId 已知，无需事后补绑）。
 * @param {object} sanitizedData - 待写入的猫档案
 * @param {string} openid - 调用者 openid
 * @param {string} refId - 被编辑的猫咪 ID
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkCatContent(sanitizedData, openid, refId = '') {
  const imgResult = await checkImage(sanitizedData.avatar, { scene: 2, openid, target: 'avatar', refId });
  if (!imgResult.ok) {
    console.warn('[updateCat] 头像图片内容安全检测未通过');
    return imgResult;
  }
  return checkCatTextContent(sanitizedData, openid);
}

exports.main = async (event, _context) => {
  event = normalizeEvent(event);

  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  try {
    const { catId, updateData } = event;

    if (!catId) {
      return fail('缺少猫咪ID');
    }

    if (!updateData || typeof updateData !== 'object') {
      return fail('缺少更新数据');
    }

    if (!sanitizer.isValidObjectId(catId)) {
      return fail('无效的猫咪ID格式');
    }

    const lengthError = validateFieldLengths(updateData);
    if (lengthError) {
      return fail(lengthError);
    }

    const authResult = await checkAdmin(db, OPENID, { useCache: false, operation: '编辑猫咪', adminAccount, permission: 'cat' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    // wx-server-sdk 的 doc().get() 在文档不存在时**直接 reject**（throwOnNotFound
    // 默认 true，错误文本 "document with _id xxx does not exist"），`if (!catRes.data)`
    // 是死代码 —— 编辑已被删除的猫会得到「保存失败，请重试」并被管理员反复重试。
    // 与 getShareData 同口径：把「不存在」映射为 null，其余错误继续抛。
    const catRes = await db.collection(COLLECTIONS.CATS).doc(catId).get().catch(err => {
      const msg = String(err && err.message || err || '');
      if (msg.indexOf('does not exist') >= 0 || msg.indexOf('not exist') >= 0) return null;
      throw err;
    });
    if (!catRes || !catRes.data) {
      return fail('猫咪不存在');
    }

    const built = buildSanitizedData(updateData);
    if (built.error) {
      return fail(built.error);
    }
    const sanitizedData = built.data;

    // 内容安全检测（合规要求）：图片 + 文本，失败关闭
    const contentCheck = await checkCatContent(sanitizedData, OPENID, catId);
    if (!contentCheck.ok) {
      return fail(contentCheck.error);
    }

    // 手动把走失的猫改回「正常」= 管理员确认它还在（哪怕没人打卡过）：
    // 重置自动走失判定的起算点（lostResetAt），否则次日 04:00 的定时扫描
    // 会依据同一批旧数据把它再标一次走失、再推一轮通知，形成无法摆脱的循环。
    // 只对 lost → normal 这一条路径生效，其余状态变更不写该字段。
    const revertingFromLost = sanitizedData.status === 'normal' && catRes.data.status === 'lost';

    await db.collection(COLLECTIONS.CATS).doc(catId).update({
      data: {
        ...sanitizedData,
        ...revertingFromLost ? { lostResetAt: Date.now() } : {},
        // 列表排序值随 updateTime 一起刷新（改状态/改资料都算「最近更新」）：
        // 档位取新状态，未改状态时沿用原状态。漏写会让排序漂移（改了状态沉不下去）。
        listSort: computeListSort(sanitizedData.status || catRes.data.status, Date.now()),
        updateTime: db.serverDate()
      }
    });

    const statusChanged = !!(sanitizedData.status && catRes.data.status !== sanitizedData.status);
    const healthChanged = !!(sanitizedData.healthStatus && catRes.data.healthStatus !== sanitizedData.healthStatus);

    if (statusChanged) {
      const statusEvent = STATUS_NOTIFICATIONS[sanitizedData.status];
      if (statusEvent) {
        try {
          await notifyCatStatusChange({
            db, cloud, catId,
            catName: catRes.data.name,
            catAvatar: catRes.data.avatar,
            event: statusEvent,
            logTag: '[updateCat] '
          });
        } catch (notifyErr) {
          console.warn('[updateCat] 状态变更通知失败（非致命）:', notifyErr.message);
        }
      }
    }

    if (healthChanged) {
      const healthEvent = HEALTH_NOTIFICATIONS[sanitizedData.healthStatus];
      if (healthEvent) {
        try {
          // 同时改了状态时，健康变更只写站内通知不推送（一条订阅只能收一条消息）
          await notifyCatStatusChange({
            db, cloud, catId,
            catName: catRes.data.name,
            catAvatar: catRes.data.avatar,
            event: healthEvent,
            skipPush: statusChanged,
            logTag: '[updateCat] '
          });
        } catch (notifyErr) {
          console.warn('[updateCat] 健康变更通知失败（非致命）:', notifyErr.message);
        }
      }
    }

    // 摘要层：changes 是给人看的「到底改了啥」。
    // 必须用 catRes.data（本次更新前的完整文档）与 sanitizedData（实际下发字段）比对，
    // 不能沿用下面的 beforeData/afterData —— 那两个只记了 3 个字段，
    // 校区/年龄/毛色/头像/图片等改动在源头就丢了，管理端无从展示。
    const changes = diffCatFields(catRes.data, sanitizedData);

    await logOperation(db, OPENID, {
      module: 'cat', action: 'edit',
      description: `编辑猫咪: ${catRes.data.name}${sanitizedData.name && sanitizedData.name !== catRes.data.name ? ' → ' + sanitizedData.name : ''}`,
      result: 'success',
      summary: buildSummary(`编辑猫咪「${catRes.data.name}」`, changes),
      changes,
      beforeData: { name: catRes.data.name, status: catRes.data.status, healthStatus: catRes.data.healthStatus },
      afterData: {
        name: sanitizedData.name || catRes.data.name,
        status: sanitizedData.status || catRes.data.status,
        healthStatus: sanitizedData.healthStatus || catRes.data.healthStatus
      }
    });

    return ok(null, '保存成功');
  } catch (err) {
    console.error('[updateCat] 更新失败:', err);
    return fail('保存失败，请重试');
  }
};
