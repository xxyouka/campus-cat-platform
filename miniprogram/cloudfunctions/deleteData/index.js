// cloudfunctions/deleteData/index.js - 通用删除云函数
const cloud = require('wx-server-sdk');
const { CloudLogger, CloudErrorHandler } = require('./utils/logger');
const { checkAdmin } = require('./utils/auth');
const audit = require('./utils/audit');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 允许的删除类型白名单（防止非法操作类型）
const ALLOWED_DELETE_TYPES = ['album', 'photo', 'cat'];

/**
 * 验证ID格式（兼容MongoDB ObjectId 24位 + 云开发自定义ID 20-40位）
 * @param {string} id - 待验证的ID
 * @returns {boolean} 是否合法
 */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[a-fA-F0-9]{20,40}$/.test(id);
}

/**
 * 删除相册（已开通「照片管理」即可）：标记删除中 → 分批解绑关联照片 → 删除相册
 * @param {string} id - 相册ID
 * @param {string} openid - 调用者 OPENID
 * @returns {Promise<object>} 云函数响应
 */
async function deleteAlbum(id, openid) {
  // 修复（v4.2）：相册删除增加事务保护 + 分页处理
  // 步骤1：先标记为"删除中"
  try {
    await db.collection(COLLECTIONS.ALBUMS).doc(id).update({
      data: { _deleting: true, _deleteStartTime: new Date().toISOString() }
    });
  } catch (e) {
    CloudLogger.warn('deleteData', '标记相册删除状态失败，可能不存在', { albumId: id, err: e });
  }

  try {
    // 步骤2：分批把相册照片改为「未分类」（修复默认20条限制）
    //
    // 原实现是「取100条 → for 循环逐条 doc().update()」，N 张照片 = N 次串行 DB 往返，
    // 上千张必然超过函数超时；而超时被杀时外层 catch 里的 _deleting 回滚不会执行，
    // 相册永久卡在「删除中」中间态：前台不可见、管理端也不显示，只能进控制台手工清。
    // 改为 where 批量 update（云函数端支持，本仓库 markNotificationRead 已用同一范式），
    // 100 条一次往返；另加 MAX_ALBUM_ROUNDS 轮次上限兜底，防止 update 不生效时死循环。
    const ALBUM_PAGE_SIZE = 100;
    const MAX_ALBUM_ROUNDS = 50;
    let totalUpdated = 0;

    for (let round = 0; round < MAX_ALBUM_ROUNDS; round++) {
      const res = await db.collection(COLLECTIONS.PHOTOS)
        .where({ albumId: id })
        .limit(ALBUM_PAGE_SIZE)
        .update({
          data: { albumId: '', albumName: '未分类', updateTime: new Date().toISOString() }
        });

      const updated = res && res.stats && res.stats.updated || 0;
      totalUpdated += updated;
      // updated 为 0 说明已无关联照片；不足一批说明本轮已是尾批，都可以收尾
      if (updated === 0) break;
    }

    if (totalUpdated >= MAX_ALBUM_ROUNDS * ALBUM_PAGE_SIZE) {
      // 触到轮次上限：说明有照片改了却没生效（正常情况下 50 轮 = 5000 张够用），
      // 此时不能继续往下删相册，否则这些照片会指向一个不存在的相册
      CloudLogger.warn('deleteData', '相册照片改分类触到轮次上限，已中止删除', {
        albumId: id, totalUpdated
      });
      return fail('相册照片过多或更新未生效，删除已中止，请重试或联系开发');
    }

    // 步骤3：最后删除相册记录
    await db.collection(COLLECTIONS.ALBUMS).doc(id).remove();

    CloudLogger.log('deleteData', '相册删除成功（事务完整）', { albumId: id, photosUpdated: totalUpdated });
    await audit.log({ action: 'delete', operator: openid, targetType: 'album', targetId: id, result: 'success' });
    return ok({ photosUpdated: totalUpdated }, '删除成功');

  } catch (err) {
    // 异常回滚：清除删除标记
    CloudLogger.error('deleteData', '相册删除过程中发生异常，尝试回滚', { albumId: id, err });
    try {
      await db.collection(COLLECTIONS.ALBUMS).doc(id).update({
        data: { _deleting: false, _deleteStartTime: null }
      });
    } catch (rollbackErr) {
      CloudLogger.error('deleteData', '回滚相册删除标记失败', { albumId: id, err: rollbackErr });
    }
    return CloudErrorHandler.handle('deleteData', err);
  }
}

/**
 * 删除照片：管理员可删任意照片，普通用户只能删自己的
 * @param {string} id - 照片ID
 * @param {string} openid - 调用者 OPENID
 * @param {boolean} isAdmin - 是否管理员
 * @returns {Promise<object>} 云函数响应
 */
async function deletePhoto(id, openid, isAdmin) {
  // wx-server-sdk 的 doc().get() 文档不存在时直接 reject（throwOnNotFound 默认 true），
  // 原 `if (!photoRes.data)` 是死代码 —— 删除已不存在的照片会走外层 catch 返回
  // 「服务器错误」，而不是「照片不存在」。与 getShareData 同口径映射为 null。
  const photoRes = await db.collection(COLLECTIONS.PHOTOS).doc(id).get().catch(err => {
    const msg = String(err && err.message || err || '');
    if (msg.indexOf('does not exist') >= 0 || msg.indexOf('not exist') >= 0) return null;
    throw err;
  });
  if (!photoRes || !photoRes.data) {
    CloudLogger.warn('deleteData', '照片不存在', { photoId: id });
    return fail('照片不存在');
  }

  // 产品口径（2026-10-05 确认）：**普通用户不允许上传照片**。
  // addPhoto 已有 checkAdmin 硬门（见 cloudfunctions/addPhoto/index.js），
  // 照片一律由管理员上传，因此本函数不存在「普通用户删自己照片」的场景。
  //
  // 原实现保留了一段 `if (!isAdmin) { 比较 _openid }` 的归属校验：
  // 它读 photoRes.data._openid，而 addPhoto 从不写该字段，且非管理员在 main 的
  // checkAdmin 处就已被拒、根本到不了这里 —— 是双重死代码。
  // 更糟的是它**暗示存在用户自助删照片的能力**，会让后续维护者以为该能力可用而
  // 依赖它。这里按实际口径删除，改为显式的管理员门禁。
  if (!isAdmin) {
    CloudLogger.warn('deleteData', '无权限删除照片', { photoId: id, openid });
    return fail('无权限删除照片');
  }

  await db.collection(COLLECTIONS.PHOTOS).doc(id).remove();

  // 清理该照片的点赞记录：与删猫分支的 photoLikes 清理口径一致。
  // 不清理会持续累积指向已删照片的孤儿记录（用户量越大越多）。
  try {
    await db.collection(COLLECTIONS.PHOTO_LIKES).where({ photoId: id }).remove();
  } catch (likesErr) {
    CloudLogger.warn('deleteData', '清理照片点赞失败（非致命）', { photoId: id, err: likesErr.message });
  }

  const photoUrl = photoRes.data.url;
  if (photoUrl && photoUrl.startsWith('cloud://')) {
    try {
      await cloud.deleteFile({ fileList: [photoUrl] });
      CloudLogger.log('deleteData', '照片云存储文件已清理', { fileId: photoUrl });
    } catch (e) {
      CloudLogger.warn('deleteData', '删除照片云存储文件失败', { fileId: photoUrl, err: e });
    }
  }

  CloudLogger.log('deleteData', '照片删除成功', { photoId: id });
  await audit.log({ action: 'delete', operator: openid, targetType: 'photo', targetId: id, result: 'success' });
  return ok(null, '删除成功');
}

/**
 * 批量移除打卡记录（分页，最多清理100条/批）
 * @param {string} catId - 猫咪ID
 * @returns {Promise<number>} 删除条数
 */
async function removeMeetRecords(catId) {
  let totalMeetsDeleted = 0;
  let hasMoreMeets = true;
  while (hasMoreMeets) {
    const meetBatch = await db.collection(COLLECTIONS.RECORD_MEET)
      .where({ catId })
      .limit(100)
      .get();

    const meets = meetBatch.data || [];
    if (meets.length === 0) {
      hasMoreMeets = false;
      break;
    }

    await Promise.all(meets.map(m =>
      db.collection(COLLECTIONS.RECORD_MEET).doc(m._id).remove()
    ));
    totalMeetsDeleted += meets.length;

    if (meets.length < 100) hasMoreMeets = false;
  }
  return totalMeetsDeleted;
}

/**
 * 批量删除猫咪关联照片记录（分页），收集云存储文件ID与照片ID
 * @param {string} catId - 猫咪ID
 * @returns {Promise<{totalDeleted: number, fileIds: string[], photoIds: string[], error: Error|null}>}
 */
async function removeCatPhotos(catId) {
  let totalDeleted = 0;
  const fileIds = [];
  const photoIds = [];
  let error = null;

  let hasMorePhotos = true;
  while (hasMorePhotos) {
    const photoBatch = await db.collection(COLLECTIONS.PHOTOS)
      .where({ catId })
      .limit(100)
      .get();

    const photos = photoBatch.data || [];
    if (photos.length === 0) {
      hasMorePhotos = false;
      break;
    }

    try {
      const batchDeletes = photos.map(p =>
        db.collection(COLLECTIONS.PHOTOS).doc(p._id).remove()
      );
      await Promise.all(batchDeletes);
      totalDeleted += photos.length;
      photos.forEach(p => photoIds.push(p._id));
    } catch (e) {
      CloudLogger.error('deleteData', '删除关联照片记录失败，中止操作', { catId, err: e });
      error = e;
      break;  // 出错立即停止
    }

    photos.forEach(p => {
      if (p.url && p.url.startsWith('cloud://')) {
        fileIds.push(p.url);
      }
    });

    if (photos.length < 100) hasMorePhotos = false;
  }

  return { totalDeleted, fileIds, photoIds, error };
}

/**
 * 批量删除云存储文件（每次最多50个），失败不阻止主流程
 * @param {string[]} fileIds - 云存储文件ID列表
 * @param {string} logLabel - 日志标签
 */
async function deleteCloudFiles(fileIds, logLabel) {
  if (!fileIds || fileIds.length === 0) return;
  try {
    const CHUNK = 50;
    for (let i = 0; i < fileIds.length; i += CHUNK) {
      await cloud.deleteFile({ fileList: fileIds.slice(i, i + CHUNK) });
    }
    CloudLogger.log('deleteData', `${logLabel}已清理`, { count: fileIds.length });
  } catch (e) {
    // 云存储删除失败不阻止主流程（记录已删，文件可后续手动清理）
    CloudLogger.warn('deleteData', `${logLabel}删除失败（非致命）`, { err: e });
  }
}

/**
 * 删除猫咪（已开通「猫咪管理」即可）：标记待删除 → 分批删除关联照片记录与云存储 →
 * 清理通知/收藏/打卡/健康档案/关系/订阅/照片点赞 → 最后删除猫咪记录
 * @param {string} id - 猫咪ID
 * @param {string} openid - 调用者 OPENID
 * @returns {Promise<object>} 云函数响应
 */
async function deleteCat(id, openid) {
  // 安全增强（v4.0）：使用标记+补偿机制保证数据一致性
  // 步骤1：先标记为"待删除"状态
  try {
    // doc().get() 不存在时直接 reject（throwOnNotFound 默认 true），
    // 原 `if (!catRes.data)` 是死代码 —— 删除已不存在的猫会返回通用失败。
    const catRes = await db.collection(COLLECTIONS.CATS).doc(id).get().catch(err => {
      const msg = String(err && err.message || err || '');
      if (msg.indexOf('does not exist') >= 0 || msg.indexOf('not exist') >= 0) return null;
      throw err;
    });
    if (!catRes || !catRes.data) {
      CloudLogger.warn('deleteData', '猫咪不存在', { catId: id });
      return fail('猫咪不存在');
    }

    // 标记为删除中
    await db.collection(COLLECTIONS.CATS).doc(id).update({
      data: { _deleting: true, _deleteStartTime: new Date().toISOString() }
    });
    CloudLogger.log('deleteData', '已标记猫咪为待删除状态', { catId: id });

    // 步骤2：分批删除关联照片记录
    const { totalDeleted, fileIds, photoIds, error } = await removeCatPhotos(id);

    // 如果步骤2失败：回滚标记让管理员能重试（管理列表只显示未标记的猫），
    // 同时落修复日志——此中间态是「部分照片记录已删、云文件未动」，再删一次即可收敛。
    if (error) {
      CloudLogger.warn('deleteData', '删除照片记录失败，回滚删除标记待重试', { catId: id, error: String(error) });
      await db.collection(COLLECTIONS.CATS).doc(id).update({
        data: { _deleting: false, _deleteStartTime: null }
      });
      try {
        await db.collection('repair_logs').add({
          data: {
            type: 'cat_delete_partial',
            catId: id,
            deletedPhotoRecords: totalDeleted || 0,
            timestamp: Date.now(),
            error: String(error)
          }
        });
      } catch (logErr) { /* 日志非致命 */ }
      return fail('删除未完成（部分照片记录已清理），请再删除一次以完成');
    }

    // 步骤3：批量删除照片云存储文件
    await deleteCloudFiles(fileIds, '照片云存储文件');

    // 步骤4：收集并删除猫咪头像等云存储文件
    const catData = catRes.data;
    const catFileIDs = [];
    if (catData.avatar && catData.avatar.startsWith('cloud://')) catFileIDs.push(catData.avatar);
    if (catData.images) {
      catData.images.forEach(img => {
        if (img && img.startsWith('cloud://')) catFileIDs.push(img);
      });
    }
    await deleteCloudFiles(catFileIDs, '猫咪云存储文件');

    // 步骤5：清理关联通知
    try {
      await db.collection(COLLECTIONS.NOTIFICATIONS).where({ catId: id }).remove();
      CloudLogger.log('deleteData', '关联通知已清理', { catId: id });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理通知失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6：清理关联收藏
    try {
      await db.collection(COLLECTIONS.USER_FAVORITES).where({ catId: id }).remove();
      CloudLogger.log('deleteData', '关联收藏已清理', { catId: id });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理收藏失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6.5：清理关联打卡记录
    try {
      const totalMeetsDeleted = await removeMeetRecords(id);
      CloudLogger.log('deleteData', '关联打卡记录已清理', { catId: id, meetsDeleted: totalMeetsDeleted });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理打卡记录失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6.6：清理健康档案
    try {
      await db.collection(COLLECTIONS.HEALTH_RECORDS).where({ catId: id }).remove();
      CloudLogger.log('deleteData', '关联健康档案已清理', { catId: id });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理健康档案失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6.7：清理猫咪关系（任一端引用该猫的关系记录）
    try {
      await db.collection(COLLECTIONS.CAT_RELATIONS).where(
        _.or([{ catId: id }, { relatedCatId: id }])
      ).remove();
      CloudLogger.log('deleteData', '关联猫咪关系已清理', { catId: id });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理猫咪关系失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6.8：清理状态订阅
    try {
      await db.collection(COLLECTIONS.USER_SUBSCRIPTIONS).where({ catId: id }).remove();
      CloudLogger.log('deleteData', '关联订阅已清理', { catId: id });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理订阅失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤6.9：按已删除照片ID清理点赞记录（photoId 分批 in 查询）
    try {
      let likesDeleted = 0;
      const CHUNK = 50;
      for (let i = 0; i < photoIds.length; i += CHUNK) {
        const res = await db.collection(COLLECTIONS.PHOTO_LIKES)
          .where({ photoId: _.in(photoIds.slice(i, i + CHUNK)) })
          .remove();
        likesDeleted += res.stats?.removed || 0;
      }
      CloudLogger.log('deleteData', '关联照片点赞已清理', { catId: id, likesDeleted });
    } catch (e) {
      CloudLogger.warn('deleteData', '清理照片点赞失败（非致命）', { catId: id, err: e.message });
    }

    // 步骤7：最后删除猫咪记录（所有前置步骤成功后）
    await db.collection(COLLECTIONS.CATS).doc(id).remove();

    CloudLogger.log('deleteData', '猫咪删除成功（事务完整）', {
      catId: id,
      photosDeleted: totalDeleted,
      filesCleaned: fileIds.length + catFileIDs.length
    });

    await audit.log({ action: 'delete', operator: openid, targetType: 'cat', targetId: id, detail: `photosDeleted:${totalDeleted}`, result: 'success' });
    return ok({ photosDeleted: totalDeleted }, '删除成功');

  } catch (err) {
    // 异常回滚：清除删除标记
    CloudLogger.error('deleteData', '删除猫咪过程中发生异常，尝试回滚', { catId: id, err });
    try {
      await db.collection(COLLECTIONS.CATS).doc(id).update({
        data: { _deleting: false, _deleteStartTime: null }
      });
    } catch (rollbackErr) {
      CloudLogger.error('deleteData', '回滚删除标记也失败了', { catId: id, err: rollbackErr });
    }
    return CloudErrorHandler.handle('deleteData', err);
  }
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
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  const { type, id } = event;

  // 参数完整性检查
  if (!type || !id) {
    CloudLogger.warn('deleteData', '参数不完整', { type, id });
    return fail('参数不完整');
  }

  // 类型白名单验证（防止非法操作）
  if (!ALLOWED_DELETE_TYPES.includes(type)) {
    CloudLogger.warn('deleteData', '不允许的删除类型', { type, allowedTypes: ALLOWED_DELETE_TYPES });
    return fail('无效的操作类型');
  }

  // ID格式验证（防止NoSQL注入和非法ID）
  if (!isValidObjectId(id)) {
    CloudLogger.warn('deleteData', '无效的ID格式', { type, id: id ? id.substring(0, 8) + '...' : null });
    return fail('无效的数据ID');
  }

  try {
    CloudLogger.log('deleteData', '开始执行删除', { type, id, openid });

    // 入口权限即能力边界：删猫属于「猫咪管理」，删相册/照片属于「照片管理」。
    // 这里必须按 type 动态取，不能在整个函数上写死一个权限。
    //
    // 不再额外要求 superadmin：超管为普通管理员开通入口后，删除是该模块的应有能力。
    // 旧口径「页面能看到照片、按钮却只给超管」会让被授权的管理员实际不可用。
    const permission = type === 'cat' ? 'cat' : 'photo';
    const authResult = await checkAdmin(db, openid, { useCache: false, operation: '删除数据', adminAccount, permission });
    if (!authResult.isAdmin) {
      CloudLogger.warn('deleteData', '无权限删除数据', { type, openid, error: authResult.error });
      return fail(authResult.error || '无权限删除数据');
    }

    const isAdmin = authResult.isAdmin;
    CloudLogger.log('deleteData', '权限检查完成', {
      type,
      permission,
      role: authResult.adminInfo?.role || ''
    });

    // 根据类型删除（权限已由上一步按 type 校验）
    switch (type) {
      case 'album':
        return deleteAlbum(id, openid);

      case 'photo':
        return deletePhoto(id, openid, isAdmin);

      case 'cat':
        return deleteCat(id, openid);

      default:
        CloudLogger.warn('deleteData', '未知删除类型', { type });
        return fail('未知类型');
    }
  } catch (err) {
    return CloudErrorHandler.handle('deleteData', err);
  }
};
