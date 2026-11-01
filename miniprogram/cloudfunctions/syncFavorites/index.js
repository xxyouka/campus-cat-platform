// cloudfunctions/syncFavorites/index.js
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 校验 catId 参数
 * @returns {string|null} 错误文案，通过时返回 null
 */
function validateCatId(catId) {
  if (!catId) return '缺少catId';
  if (!sanitizer.isValidObjectId(catId)) return '无效的catId格式';
  return null;
}

/** action: add —— 关注一只猫（幂等） */
async function handleAdd(openid, catId, catName) {
  const invalid = validateCatId(catId);
  if (invalid) return fail(invalid);

  const existing = await db.collection(COLLECTIONS.USER_FAVORITES)
    .where({ _openid: openid, catId: catId })
    .count();

  if (existing.total > 0) {
    return ok(null, '已关注');
  }

  await db.collection(COLLECTIONS.USER_FAVORITES).add({
    data: {
      _openid: openid,
      catId: catId,
      catName: sanitizer.strict(catName || '', 50),
      createTime: db.serverDate()
    }
  });

  return ok(null, '关注已同步');
}

/** action: remove —— 取消关注 */
async function handleRemove(openid, catId) {
  const invalid = validateCatId(catId);
  if (invalid) return fail(invalid);

  await db.collection(COLLECTIONS.USER_FAVORITES)
    .where({ _openid: openid, catId: catId })
    .remove();

  return ok(null, '已取消关注');
}

/** action: list —— 拉取云端收藏（新设备/清缓存后恢复本地列表） */
async function handleList(openid) {
  const res = await db.collection(COLLECTIONS.USER_FAVORITES)
    .where({ _openid: openid })
    .field({ catId: true, createTime: true })
    .limit(1000)
    .get();

  const ids = (res.data || [])
    .filter(f => f.catId && sanitizer.isValidObjectId(f.catId))
    .map(f => f.catId);

  return ok({ catIds: ids });
}

/**
 * 游标分页拉取云端全部收藏的 catId
 * @returns {Promise<Array<string>>}
 */
async function fetchAllCloudCatIds(openid) {
  const BATCH_SIZE = 100;
  const ids = [];
  let lastId = null;

  do {
    let query = db.collection(COLLECTIONS.USER_FAVORITES)
      .where({ _openid: openid })
      .field({ catId: true })
      // 游标分页必须配稳定排序：无 orderBy 时返回顺序不稳定，
      // 取「最后一条 _id」作游标会漏掉小于游标却又没被取到的记录，
      // 导致云端收藏列表不完整（sync 差集据此计算，属数据面风险）。
      .orderBy('_id', 'asc')
      .limit(BATCH_SIZE);

    if (lastId) {
      query = query.where({
        _openid: openid,
        _id: db.command.gt(lastId)
      });
    }

    const batch = await query.get();
    const data = batch.data || [];
    ids.push(...data.map(f => f.catId));
    lastId = data.length > 0 ? data[data.length - 1]._id : null;
  } while (lastId);

  return ids;
}

/**
 * 按差异批量增删收藏，单项失败不影响其他项
 * @returns {Promise<{removeFailed: number, addFailed: number}>}
 */
async function applyFavoriteDiff(openid, toRemove, toAdd) {
  const removePromises = toRemove.map(id =>
    db.collection(COLLECTIONS.USER_FAVORITES)
      .where({ _openid: openid, catId: id })
      .remove()
      .catch(err => {
        console.warn('[syncFavorites] 删除失败:', id, err.message);
        return null;
      })
  );

  const addPromises = toAdd.map(id =>
    db.collection(COLLECTIONS.USER_FAVORITES).add({
      data: {
        _openid: openid,
        catId: id,
        catName: '',
        createTime: db.serverDate()
      }
    }).catch(err => {
      console.warn('[syncFavorites] 添加失败:', err.message);
      return null;
    })
  );

  const removeResults = await Promise.all(removePromises);
  const addResults = await Promise.all(addPromises);

  return {
    removeFailed: removeResults.filter(r => !r || r instanceof Error).length,
    addFailed: addResults.filter(r => !r || r instanceof Error).length
  };
}

/** action: sync —— 以本地列表为准对齐云端收藏 */
async function handleSync(openid, catIds) {
  if (!Array.isArray(catIds)) {
    return fail('catIds 必须是数组；未提供有效收藏列表，已拒绝同步');
  }

  // 上限保护：超大数组会一次性制造大量写操作。
  // 超限时整体拒绝，不能截断——截断后条目会落进 toRemove，被当作「本地已取消关注」误删。
  if (catIds.length > 200) {
    return fail('收藏数量超过200条上限，请减少后重试');
  }

  // 差集同步会把「输入里没有的云端收藏」当成用户主动取消并删除。
  // 任一 ID 无效都拒绝整批，避免损坏的本地缓存被误当成取消指令。
  if (catIds.some(id => typeof id !== 'string' || !sanitizer.isValidObjectId(id))) {
    return fail('收藏列表含有无效猫咪ID，已拒绝同步以保护云端收藏');
  }

  const uniqueCatIds = [...new Set(catIds)];

  const cloudCatIds = await fetchAllCloudCatIds(openid);

  const toRemove = cloudCatIds.filter(id => !uniqueCatIds.includes(id));
  const toAdd = uniqueCatIds.filter(id => !cloudCatIds.includes(id));

  const { removeFailed, addFailed } = await applyFavoriteDiff(openid, toRemove, toAdd);

  return ok({
    added: toAdd.length,
    removed: toRemove.length,
    total: uniqueCatIds.length,
    warnings: removeFailed > 0 || addFailed > 0
      ? `部分操作失败: 删除${removeFailed}条, 添加${addFailed}条`
      : undefined
  });
}

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext() || {};
  if (!OPENID) return fail('请先登录后再同步收藏', 'UNAUTHORIZED');
  const { action, catId, catName, catIds } = event;

  try {
    switch (action) {
      case 'add':
        return await handleAdd(OPENID, catId, catName);
      case 'remove':
        return await handleRemove(OPENID, catId);
      case 'list':
        return await handleList(OPENID);
      case 'sync':
        return await handleSync(OPENID, catIds);
      default:
        return fail('未知操作类型');
    }
  } catch (err) {
    console.error('[syncFavorites] 失败:', err);
    return fail('同步失败，请稍后重试');
  }
};
