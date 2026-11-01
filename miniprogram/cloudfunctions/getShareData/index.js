// 云函数：获取分享页数据（猫咪信息 + 照片 + 统计）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 文档ID格式校验：防止对象/操作符注入改变查询语义（同 getPhotosByCat）
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;

exports.main = async (event, _context) => {
  const { catId } = event;

  if (!catId || typeof catId !== 'string' || !CAT_ID_PATTERN.test(catId)) {
    return fail('缺少或无效的猫咪ID');
  }

  try {
    console.log('[getShareData] 开始执行', { catId });

    // 并行获取猫咪信息和照片。
    // wx-server-sdk 的 doc().get() 在文档不存在时**直接 reject**
    // （throwOnNotFound 默认 true，错误文本为 "document with _id xxx does not exist"），
    // 永远不会以「空 data」形式返回 —— 原先下方的 `if (!cat)` 是死代码，
    // 分享页专为失效卡片写的 code==='NOT_FOUND' 自动返回分支因此不可达。
    // 这里把「不存在」映射为 null 交给下方统一返回；其他错误（网络等）继续抛出。
    const [catRes, photoRes] = await Promise.all([
      db.collection(COLLECTIONS.CATS).doc(catId).get().catch(err => {
        const msg = String(err && err.message || err || '');
        if (msg.indexOf('does not exist') >= 0 || msg.indexOf('not exist') >= 0) return null;
        throw err;
      }),
      db.collection(COLLECTIONS.PHOTOS)
        .where({ catId: catId, _mediaBlocked: _.neq(true) })
        .orderBy('createTime', 'desc')
        .limit(6)
        .get()
    ]);

    if (!catRes || !catRes.data) {
      return fail('猫咪不存在', 'NOT_FOUND');
    }
    const cat = catRes.data;

    // 删除中的猫咪视为不存在（deleteData 标记 _deleting 后分多步删除）：
    // 与 getCatDetail / filterCats 的可见性口径一致 —— 否则删除窗口内
    // 「列表已看不到、分享链接仍能打开」，删除中断时更会留下永久可见的幽灵猫。
    if (cat._deleting === true) {
      return fail('猫咪不存在', 'NOT_FOUND');
    }

    // 分享页对所有人开放（无鉴权），整文档下发会把内部字段一并给出：
    // _openid 是管理员建档时写入的（addCat 曾显式写、存量仍在），
    // _deleting/_deleteStartTime 是删除流程的内部哨兵。三者全端零引用，剔除无副作用。
    delete cat._openid;
    delete cat._deleting;
    delete cat._deleteStartTime;
    // 头像被内容安全拦截时不再向分享页下发（正常处置会清空 avatar，这里兜底）
    if (cat._mediaBlocked === true) cat.avatar = '';
    delete cat._mediaBlocked;
    delete cat._mediaReview;

    console.log('[getShareData] 执行成功', { catName: cat.name, photoCount: photoRes.data.length });

    return ok({
      cat,
      photos: photoRes.data || []
    });
  } catch (err) {
    console.error('[getShareData] 执行失败', err);
    return fail('获取分享数据失败');
  }
};
