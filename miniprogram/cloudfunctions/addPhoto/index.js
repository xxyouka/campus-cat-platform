// cloudfunctions/addPhoto/index.js - 添加照片云函数（服务端权限校验）
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { checkAdmin } = require('./utils/auth');
const { checkImage, bindMediaCheckRef } = require('./utils/contentSecurity');
const { isAllowedStorageFileUnder } = require('./utils/filePathGuard');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

// 照片只允许 photos/ 目录下的云存储文件
const PHOTO_STORAGE_PREFIXES = ['photos/'];

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  try {
    const { catId, url } = event;

    if (!catId || !url) {
      return fail('缺少必要参数');
    }

    if (!sanitizer.isValidObjectId(catId)) {
      return fail('无效的猫咪ID格式');
    }

    const urlValidation = sanitizer.validateUrl(url);
    if (!urlValidation.isValid) {
      return fail(`照片URL校验失败: ${urlValidation.error}`);
    }
    const safeUrl = urlValidation.url;

    // 路径白名单（必须先于任何「检测失败就删文件」的分支）：
    // 照片必须是 photos/ 下的云存储文件。这同时关闭两条攻击面：
    //   1. 普通管理员传任意已知 fileID（他人头像、backups/ 快照、exports/ 导出），
    //      让内容检测必然失败，从而借服务端的删除分支销毁任意文件 —— 这是绕过
    //      「照片删除仅超管」的任意文件删除原语；
    //   2. https 外链：checkImage 对非云存储来源直接放行，等于跳过 imgSecCheck 审核。
    if (!isAllowedStorageFileUnder(safeUrl, PHOTO_STORAGE_PREFIXES)) {
      return fail('照片文件路径不合法');
    }

    const authResult = await checkAdmin(db, OPENID, { useCache: false, operation: '添加照片', adminAccount, permission: 'photo' });
    // 产品口径（2026-10-05 确认）：普通用户不允许上传照片，这里是唯一入口门禁。
    // 因此数据里**不写 _openid**（写了反而会让人误以为存在用户上传路径），
    // uploaderName 固定为「管理员」与此口径一致。
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    // 内容安全检测（合规要求）：云存储图片经检测后才允许落库（内联公共模块）。
    // target 供异步检测回调定位处置对象；refId 在落库拿到 res._id 后补绑。
    const imgCheck = await checkImage(safeUrl, { scene: 2, openid: OPENID, target: 'photo' });
    if (!imgCheck.ok) {
      console.warn('[addPhoto] 图片内容安全检测未通过');
      // 文件已由客户端上传到云存储；检测不过就没有入库记录，留着只会成为无主垃圾
      // （除控制台外没有入口能清掉它）。此处顺手回收，删除失败不影响返回结果。
      try {
        await cloud.deleteFile({ fileList: [safeUrl] });
      } catch (cleanupErr) {
        console.warn('[addPhoto] 未入库文件回收失败:', cleanupErr.message || cleanupErr);
      }
      return fail(imgCheck.error);
    }

    // 安全优化：服务端查询真实 catName，防止客户端篡改
    let catName = '';
    try {
      const catRes = await db.collection(COLLECTIONS.CATS).doc(catId).field({ name: true, _deleting: true }).get();
      if (!catRes.data) {
        return fail('猫咪不存在');
      }
      // 删除中的猫（_deleting 标记）：与 filterCats / 客户端可见性口径一致，拒绝再挂照片
      if (catRes.data._deleting) {
        return fail('猫咪不存在');
      }
      catName = catRes.data.name || '';
    } catch (err) {
      return fail('猫咪不存在或查询失败');
    }

    const res = await db.collection(COLLECTIONS.PHOTOS).add({
      data: {
        catId,
        catName,
        url: safeUrl,
        uploaderName: '管理员',
        likeCount: 0,
        createTime: db.serverDate()
      }
    });

    // 异步内容检测（mediaCheckAsync）：补绑 photoId，回调据此给违规照片打标记
    await bindMediaCheckRef(imgCheck.traceId, res._id);

    await logOperation(db, OPENID, {
      module: 'photo', action: 'create',
      description: `上传照片: ${catName || catId}`,
      result: 'success',
      // 摘要层：「上传了什么」的答案是张数 + 归属，而不是 fileID。
      // 管理端相册页面对每个文件单独调一次 addPhoto（album-detail.js 的上传循环），
      // 因此这里固定 1 张：传 5 张会落 5 条日志，各记 1 张，与真实操作一一对应。
      summary: `上传照片 1 张 → ${catName || catId}`,
      changes: [{ label: '新增照片', text: `1 张（归属：${catName || '未知猫咪'}）` }],
      afterData: { catName: catName || 'unknown', catId }
    });

    return ok({ id: res._id }, '上传成功');
  } catch (err) {
    console.error('[addPhoto] 添加照片失败:', err);
    return fail('上传失败，请重试');
  }
};
