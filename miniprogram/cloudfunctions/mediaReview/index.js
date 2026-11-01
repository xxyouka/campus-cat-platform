// cloudfunctions/mediaReview/index.js - 管理端「内容复核」
//
// 背景：mediaCheckCallback 只会给照片/头像打 `_mediaBlocked` / `_mediaReview` 标记，
// 真正的处置要有人看、有人点。此前这些标记只写进 operation_logs，管理端既没有队列，
// 也没有入口把「被拦截的照片」找出来 —— 等于内容安全链路只做了一半。
//
// 本函数只做两件事：
//   list   列出待复核（review）/ 已拦截（risky）的多媒体检测记录，并带上目标缩略图；
//   resolve 人工确认：通过（清除标记、恢复头像）或拦截（保留标记、清空头像）。
//
// 边界：
//   - 只信服务端 OPENID + checkAdmin，不接受客户端传管理员身份；
//   - 目标集合只允许 photos / cats 两个白名单，refId 必须像合法 _id；
//   - 不在这里删除照片/猫：删除仍走 deleteData（会清云存储文件与点赞记录），
//     本函数只负责「通过 / 拦截」这两个审核结论，避免再造一套删除逻辑。
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const sanitizer = require('./utils/sanitizer');
const { logOperation } = require('./common/operationLogger');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const REVIEW_STATUSES = ['review', 'risky'];
const TARGET_COLLECTIONS = {
  photo: COLLECTIONS.PHOTOS,
  avatar: COLLECTIONS.CATS
};
const REF_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function isValidRefId(refId) {
  return REF_ID_RE.test(String(refId || ''));
}

/** 从本页记录里收集需要批量查的目标 ID（照片 / 头像所属猫） */
function collectTargetIds(records) {
  const photoIds = [];
  const avatarCatIds = [];
  for (const record of records) {
    if (!record || !isValidRefId(record.refId)) continue;
    if (record.target === 'photo') photoIds.push(record.refId);
    else if (record.target === 'avatar') avatarCatIds.push(record.refId);
  }
  return { photoIds, avatarCatIds };
}

/**
 * 批量取目标对象，避免一页 20 条就发 20 次 doc().get()。
 * 照片额外补猫名（相册页跳转需要 catId）。
 */
async function loadTargetMaps(photoIds, avatarCatIds) {
  const [photoRes, avatarCatRes] = await Promise.all([
    photoIds.length
      ? db.collection(COLLECTIONS.PHOTOS)
        .where({ _id: _.in(photoIds) })
        .field({ _id: true, url: true, catId: true })
        .limit(photoIds.length)
        .get()
      : Promise.resolve({ data: [] }),
    avatarCatIds.length
      ? db.collection(COLLECTIONS.CATS)
        .where({ _id: _.in(avatarCatIds) })
        .field({ _id: true, name: true, avatar: true })
        .limit(avatarCatIds.length)
        .get()
      : Promise.resolve({ data: [] })
  ]);

  const photoMap = new Map((photoRes.data || []).map(photo => [photo._id, photo]));
  const catMap = new Map((avatarCatRes.data || []).map(cat => [cat._id, cat]));

  const missingCatIds = [...new Set(
    (photoRes.data || [])
      .map(photo => photo.catId)
      .filter(catId => catId && !catMap.has(catId))
  )];
  if (missingCatIds.length) {
    const catRes = await db.collection(COLLECTIONS.CATS)
      .where({ _id: _.in(missingCatIds) })
      .field({ _id: true, name: true })
      .limit(missingCatIds.length)
      .get();
    for (const cat of catRes.data || []) catMap.set(cat._id, cat);
  }

  return { photoMap, catMap };
}

/** 把一条检测记录补成管理端可直接渲染的卡片数据 */
function decorateRecord(record, photoMap, catMap) {
  const base = {
    _id: record._id,
    traceId: record.traceId || '',
    status: record.status,
    target: record.target || '',
    refId: record.refId || '',
    fileID: record.fileID || '',
    label: Number(record.label) || 0,
    createTime: record.createTime || null,
    updateTime: record.updateTime || record.createTime || null
  };

  if (record.target !== 'photo') {
    const cat = catMap.get(record.refId);
    return {
      ...base,
      mediaUrl: cat && cat.avatar || '',
      catId: record.refId || '',
      catName: cat && cat.name || '',
      missing: !cat
    };
  }

  const photo = photoMap.get(record.refId);
  const cat = photo && catMap.get(photo.catId);
  return {
    ...base,
    mediaUrl: photo && photo.url || '',
    catId: photo && photo.catId || '',
    catName: cat && cat.name || '',
    missing: !photo
  };
}

async function listRecords(event) {
  const page = Math.min(Math.max(1, parseInt(event.page, 10) || 1), 1000);
  const pageSize = Math.min(
    Math.max(1, parseInt(event.pageSize, 10) || PAGE_SIZE_DEFAULT),
    PAGE_SIZE_MAX
  );
  const status = REVIEW_STATUSES.includes(event.status) ? event.status : '';
  const where = { status: status || _.in(REVIEW_STATUSES) };

  const [res, countRes] = await Promise.all([
    db.collection(COLLECTIONS.MEDIA_CHECKS)
      .where(where)
      .orderBy('updateTime', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    db.collection(COLLECTIONS.MEDIA_CHECKS).where(where).count()
  ]);

  const records = res.data || [];
  const { photoIds, avatarCatIds } = collectTargetIds(records);
  const { photoMap, catMap } = await loadTargetMaps(photoIds, avatarCatIds);
  const items = records.map(record => decorateRecord(record, photoMap, catMap));
  const total = countRes.total || 0;

  return ok({
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total
  });
}

function normalizeDecision(value) {
  if (value === 'keep') return 'keep';
  if (value === 'block') return 'block';
  return '';
}

async function getCheckRecord(id) {
  try {
    const found = await db.collection(COLLECTIONS.MEDIA_CHECKS).doc(id).get();
    return found && found.data || null;
  } catch (err) {
    return null;
  }
}

/**
 * 更新目标对象上的审核标记。
 *
 * keep  → 清掉 `_mediaReview` / `_mediaBlocked`；头像若被之前拦截清空，按记录里的
 *         原始 fileID 恢复（只在当前 avatar 为空时恢复，绝不覆盖管理员新换的头像）。
 * block → 保留 `_mediaBlocked`；头像立即清空（这是唯一需要直接改公开字段的动作，
 *         否则头像会继续在首页/详情页展示）。照片的隐藏由读侧过滤 `_mediaBlocked` 完成。
 *
 * @returns {Promise<boolean>} 是否真的更新到了目标对象（目标已删除时为 false）
 */
async function applyTargetDecision(record, decision) {
  const collection = TARGET_COLLECTIONS[record.target];
  if (!collection || !isValidRefId(record.refId)) return false;

  try {
    const targetRes = await db.collection(collection).doc(record.refId).get();
    const target = targetRes && targetRes.data;
    if (!target) return false;

    const patch = {
      _mediaReview: false,
      _mediaBlocked: decision === 'block',
      mediaCheckTraceId: record.traceId || '',
      mediaCheckedAt: db.serverDate()
    };
    if (decision === 'block' && record.target === 'avatar') {
      patch.avatar = '';
    }
    if (decision === 'keep' && record.target === 'avatar' &&
        !target.avatar && String(record.fileID || '').startsWith('cloud://')) {
      patch.avatar = record.fileID;
    }
    await db.collection(collection).doc(record.refId).update({ data: patch });
    return true;
  } catch (err) {
    // 目标已删除属正常：审核结论仍要落库，否则队列会永远卡住
    console.warn('[mediaReview] 更新目标对象失败（可能已删除）:', err.message || err);
    return false;
  }
}

async function markRecordResolved(record, decision, openid) {
  const nextStatus = decision === 'keep' ? 'pass' : 'blocked';
  await db.collection(COLLECTIONS.MEDIA_CHECKS).doc(record._id).update({
    data: {
      status: nextStatus,
      reviewAction: decision,
      reviewedAt: db.serverDate(),
      reviewedBy: openid,
      updateTime: db.serverDate()
    }
  });

  await logOperation(db, openid, {
    module: 'mediaCheck',
    action: 'edit',
    result: 'success',
    description: `内容复核${decision === 'keep' ? '通过' : '拦截'}: ${record.target || '未知对象'} ${record.refId || ''}`.trim(),
    afterData: {
      mediaCheckId: record._id,
      traceId: record.traceId || '',
      target: record.target || '',
      refId: record.refId || '',
      decision
    }
  }).catch(() => {});

  return nextStatus;
}

async function resolveRecord(event, openid) {
  const id = String(event.id || '').trim();
  if (!sanitizer.isValidObjectId(id)) return fail('无效的记录ID', 'INVALID_ID');

  const decision = normalizeDecision(event.decision);
  if (!decision) return fail('无效的处理结果', 'INVALID_DECISION');

  const record = await getCheckRecord(id);
  if (!record) return fail('记录不存在', 'NOT_FOUND');

  // 已处理过的记录直接回执，避免管理端重复点击把状态来回翻
  if (record.status === 'pass' || record.status === 'blocked') {
    return ok({
      id,
      status: record.status,
      decision: record.reviewAction || '',
      alreadyResolved: true
    }, '该记录已处理');
  }

  const targetUpdated = await applyTargetDecision(record, decision);
  const status = await markRecordResolved(record, decision, openid);

  return ok({
    id,
    status,
    decision,
    targetUpdated
  }, decision === 'keep' ? '已通过' : '已拦截');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';
  const auth = await checkAdmin(db, OPENID, {
    useCache: false,
    operation: '内容复核',
    adminAccount,
    permission: 'mediaReview'
  });
  if (!auth.isAdmin) return fail(auth.error || '无权限', 'FORBIDDEN');

  const action = event.action || 'list';
  try {
    if (action === 'list') return await listRecords(event);
    if (action === 'resolve') return await resolveRecord(event, OPENID);
    return fail('未知操作', 'INVALID_ACTION');
  } catch (err) {
    console.error('[mediaReview]', action, err.message || err);
    return fail('内容复核失败，请稍后重试', 'MEDIA_REVIEW_ERROR');
  }
};
