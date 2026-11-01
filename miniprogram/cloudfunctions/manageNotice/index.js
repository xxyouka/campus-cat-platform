// 云函数：管理公告（增删改），带管理员权限校验
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const FIELD_LIMITS = {
  title: 100,
  content: 5000
};

const ACTIONS = ['add', 'update', 'delete', 'list'];

/** HTTP 触发器适配：若 event.body 是 JSON 字符串则解析并合并进 event */
function normalizeEvent(event) {
  if (!event.body || typeof event.body !== 'string') return event;

  try {
    return { ...event, ...JSON.parse(event.body) };
  } catch (e) {
    return event;
  }
}

/**
 * 校验并消毒公告标题与内容
 * @returns {{title?: string, content?: string, error?: string}}
 */
function sanitizeNoticeInput(title, content) {
  if (!title?.trim() || !content?.trim()) {
    return { error: '标题和内容不能为空' };
  }

  const cleanTitle = sanitizer.sanitize(title, { maxLength: FIELD_LIMITS.title, fieldName: 'title' });
  const cleanContent = sanitizer.sanitize(content, { maxLength: FIELD_LIMITS.content, fieldName: 'content' });
  if (!cleanTitle || !cleanContent) {
    return { error: '标题或内容包含不合法字符' };
  }

  return { title: cleanTitle, content: cleanContent };
}

/** action: add —— 新增公告 */
async function handleAdd(openid, title, content) {
  const input = sanitizeNoticeInput(title, content);
  if (input.error) return fail(input.error);

  const now = db.serverDate();
  const res = await db.collection(COLLECTIONS.NOTICES).add({
    data: {
      title: input.title,
      content: input.content,
      // getNotices 按 status:'published' 过滤，新增公告必须携带该字段
      status: 'published',
      createTime: now,
      updateTime: now
    }
  });

  await logOperation(db, openid, {
    module: 'notice', action: 'create',
    description: `添加公告: ${input.title}`,
    result: 'success',
    afterData: { title: input.title }
  });

  return ok({ noticeId: res._id }, '添加成功');
}

/** action: update —— 编辑公告 */
async function handleUpdate(openid, noticeId, title, content) {
  if (!noticeId) {
    return fail('缺少公告ID');
  }

  const input = sanitizeNoticeInput(title, content);
  if (input.error) return fail(input.error);

  const existing = await db.collection(COLLECTIONS.NOTICES).doc(noticeId).get();
  if (!existing.data) {
    return fail('公告不存在或已被删除');
  }

  await db.collection(COLLECTIONS.NOTICES).doc(noticeId).update({
    data: {
      title: input.title,
      content: input.content,
      // 兼容历史无 status 字段的公告：更新时回填为已发布
      ...existing.data.status ? {} : { status: 'published' },
      updateTime: db.serverDate()
    }
  });

  await logOperation(db, openid, {
    module: 'notice', action: 'edit',
    description: `编辑公告: ${input.title}`,
    result: 'success',
    beforeData: { title: existing.data.title },
    afterData: { title: input.title }
  });

  return ok(null, '更新成功');
}

/** action: delete —— 删除公告 */
async function handleDelete(openid, noticeId) {
  if (!noticeId) {
    return fail('缺少公告ID');
  }

  const existing = await db.collection(COLLECTIONS.NOTICES).doc(noticeId).get();
  if (!existing.data) {
    return fail('公告不存在或已被删除');
  }

  await db.collection(COLLECTIONS.NOTICES).doc(noticeId).remove();

  await logOperation(db, openid, {
    module: 'notice', action: 'delete',
    description: `删除公告: ${existing.data.title}`,
    result: 'success',
    beforeData: { title: existing.data.title }
  });

  return ok(null, '删除成功');
}

/** action: list —— 管理端公告列表 */
async function handleList() {
  const res = await db.collection(COLLECTIONS.NOTICES)
    .orderBy('createTime', 'desc')
    .limit(200)
    .get();

  return ok({ notices: res.data || [] });
}

exports.main = async (event, _context) => {
  event = normalizeEvent(event);

  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';
  const { action, noticeId, title, content } = event;

  if (!ACTIONS.includes(action)) {
    return fail('缺少有效操作类型');
  }

  try {
    const authResult = await checkAdmin(db, OPENID, { operation: '管理公告', adminAccount, useCache: false, permission: 'notice' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    // 删除是「公告管理」入口的应有能力：已通过 permission: 'notice' 校验即可执行。
    // 不再额外要求 superadmin，否则被开通入口的普通管理员能进页面却不能删。
    switch (action) {
      case 'add':
        return await handleAdd(OPENID, title, content);
      case 'update':
        return await handleUpdate(OPENID, noticeId, title, content);
      case 'delete':
        return await handleDelete(OPENID, noticeId);
      default:
        return await handleList();
    }
  } catch (err) {
    console.error('[manageNotice] 操作失败:', err);
    return fail('操作失败，请重试');
  }
};
