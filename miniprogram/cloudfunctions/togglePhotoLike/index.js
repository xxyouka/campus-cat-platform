// cloudfunctions/togglePhotoLike/index.js - 照片点赞/取消点赞（事务安全版）
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function validatePhotoId(photoId) {
  if (!photoId) return fail('缺少照片ID');
  if (!sanitizer.isValidObjectId(photoId)) return fail('无效的照片ID格式');
  return null;
}

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext() || {};
  if (!OPENID) return fail('请先登录后再操作点赞', 'UNAUTHORIZED');
  const { photoId } = event;
  const validationError = validatePhotoId(photoId);
  if (validationError) return validationError;

  // 校验照片存在：防止对已删除照片点赞，产生孤儿点赞记录
  try {
    const photoCheck = await db.collection(COLLECTIONS.PHOTOS).doc(photoId)
      .field({ _id: true }).get().catch(() => null);
    if (!photoCheck || !photoCheck.data) {
      return fail('照片不存在或已删除');
    }
  } catch (checkErr) {
    console.warn('[togglePhotoLike] 照片存在性校验异常，继续原流程:', checkErr.message);
  }

  try {
    // 存在性查询移到事务外：官方文档对 Transaction.collection 的要求是
    // 「仅能进行单记录操作（add / doc.get|update|set|remove），不能使用 where」。
    // 原实现把 .where().limit(1).get() 放进事务，事务可用时这段必抛，
    // 被外层 catch 吞成通用「操作失败，请稍后重试」；且当时异常路径既不 commit
    // 也不 rollback，事务悬挂到超时。
    // 代价是查询与写入不再原子 —— 见下方注释对并发影响的说明。
    const likeRes = await db.collection(COLLECTIONS.PHOTO_LIKES)
      .where({ photoId, _openid: OPENID })
      .limit(1)
      .get();
    const existingLike = likeRes.data && likeRes.data.length > 0;
    const existingLikeId = existingLike ? likeRes.data[0]._id : null;

    let transaction;
    try {
      transaction = await db.startTransaction();
    } catch (txErr) {
      // 降级：事务不可用时走普通读写；没有 photoLikes 复合唯一索引时，并发仍可能重复。
      console.warn('[togglePhotoLike] 事务不可用，降级为非事务模式:', txErr.message);
      transaction = null;
    }

    if (transaction) {
      // ====== 事务模式（推荐）======
      // 事务内只用单记录接口：where 已在外层查过
      try {
        if (existingLike) {
          // 取消点赞
          await transaction.collection(COLLECTIONS.PHOTO_LIKES)
            .doc(existingLikeId)
            .remove();

          await transaction.collection(COLLECTIONS.PHOTOS).doc(photoId).update({
            data: { likeCount: _.inc(-1) }
          });
        } else {
          // 添加点赞
          await transaction.collection(COLLECTIONS.PHOTO_LIKES).add({
            data: {
              photoId,
              _openid: OPENID,
              createTime: db.serverDate()
            }
          });

          await transaction.collection(COLLECTIONS.PHOTOS).doc(photoId).update({
            data: { likeCount: _.inc(1) }
          });
        }

        await transaction.commit();
      } catch (err) {
        // 任一步失败必须显式回滚，否则事务悬挂到超时、记录锁不释放。
        // rollback 失败时仅记录（可能已提交），异常继续外抛由 catch 兜底。
        await transaction.rollback().catch(rollbackErr => {
          console.error('[togglePhotoLike] 事务回滚失败:', rollbackErr.message);
        });
        throw err;
      }

      return ok({
        liked: !existingLike
      }, existingLike ? '取消点赞' : '点赞成功');

    } else {
      // ====== 非事务模式（降级）======
      // 查询与写入不是原子操作；唯一索引缺失或事务降级时，并发可能造成重复点赞和计数漂移。
      if (existingLike) {
        await db.collection(COLLECTIONS.PHOTO_LIKES)
          .doc(existingLikeId)
          .remove();

        // 降级路径无事务：先读计数再减，避免并发下减成负数（低并发兜底）
        const curRes = await db.collection(COLLECTIONS.PHOTOS).doc(photoId)
          .field({ likeCount: true }).get().catch(() => null);
        const curCount = curRes && curRes.data && curRes.data.likeCount || 0;
        if (curCount > 0) {
          await db.collection(COLLECTIONS.PHOTOS).doc(photoId).update({
            data: { likeCount: _.inc(-1) }
          });
        }

        return ok({ liked: false }, '取消点赞');
      } else {
        await db.collection(COLLECTIONS.PHOTO_LIKES).add({
          data: {
            photoId,
            _openid: OPENID,
            createTime: db.serverDate()
          }
        });

        await db.collection(COLLECTIONS.PHOTOS).doc(photoId).update({
          data: { likeCount: _.inc(1) }
        });

        return ok({ liked: true }, '点赞成功');
      }
    }
  } catch (err) {
    console.error('[togglePhotoLike] 失败:', err);
    return fail('操作失败，请稍后重试');
  }
};
