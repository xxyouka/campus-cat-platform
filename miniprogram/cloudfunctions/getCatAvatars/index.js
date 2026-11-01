// cloudfunctions/getCatAvatars/index.js - 批量获取猫咪图片临时链接
const cloud = require('wx-server-sdk');
const { CloudLogger, CloudErrorHandler } = require('./utils/logger');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { splitByStoragePath } = require('./utils/filePathGuard');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 单次最多换链的文件数，避免一次调用打满云调用配额
const MAX_FILE_IDS = 100;

/**
 * 云函数：批量获取猫咪图片临时链接
 * 使用云函数调用（有管理员权限），可访问业务目录下的云存储文件
 *
 * 入参: { fileIDs: string[] }  cloud:// 开头的文件ID列表
 * 出参: { success, urlMap: { [fileID]: tempURL }, total, resolved, rejected, failed }
 *
 * 注意：fileID 由调用方提供，必须限制在业务目录（cats/、photos/）内，
 * 否则调用方可用 backups/ 等路径换取全量备份的临时下载链接（见 utils/filePathGuard.js）。
 */

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

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

  // 鉴权必须排在路径判定之前（对抗性审核 P2-5，与 compressImages 的顺序对齐）：
  // 否则未鉴权调用者可以从 rejected 回包里逐个试探 fileID，探测「某个云存储路径
  // 是否属于业务白名单目录」——白名单归属本身即内部信息。
  try {
    const authResult = await checkAdmin(db, OPENID, { operation: '获取猫咪头像', adminAccount });
    if (!authResult.isAdmin) {
      CloudLogger.warn('getCatAvatars', '无管理员权限', { openid: OPENID });
      return fail(authResult.error);
    }
  } catch (err) {
    return CloudErrorHandler.handle('getCatAvatars', err);
  }

  // 路径白名单：只放行业务目录，非业务前缀（如 backups/、exports/）如实回传不接受
  const { allowed, rejected } = splitByStoragePath(event.fileIDs);
  const requestedFiles = allowed.slice(0, MAX_FILE_IDS);

  if (rejected.length > 0) {
    CloudLogger.warn('getCatAvatars', '拒绝非业务目录的 fileID', {
      count: rejected.length,
      fileIDs: rejected
    });
  }

  if (requestedFiles.length === 0) {
    CloudLogger.log('getCatAvatars', '无有效文件ID');
    return ok({ urlMap: {}, total: 0, resolved: 0, rejected, failed: [] });
  }

  try {
    CloudLogger.log('getCatAvatars', '开始获取临时链接', { count: requestedFiles.length });

    // 云函数环境有管理员权限，可以直接获取所有文件的临时链接
    const result = await cloud.getTempFileURL({ fileList: requestedFiles });
    const urlMap = {};
    const failed = [];
    let successCount = 0

    ;(result.fileList || []).forEach(item => {
      // status === 0 表示成功
      if (item.status === 0 && item.tempFileURL) {
        urlMap[item.fileID] = item.tempFileURL;
        successCount++;
      } else {
        failed.push(item.fileID);
        CloudLogger.warn('getCatAvatars', '文件获取失败', { fileID: item.fileID, status: item.status });
      }
    });

    CloudLogger.log('getCatAvatars', '获取完成', {
      total: requestedFiles.length,
      success: successCount,
      failed: failed.length,
      rejected: rejected.length
    });

    return ok({
      urlMap,
      total: requestedFiles.length,
      resolved: successCount,
      rejected,
      failed
    });
  } catch (err) {
    return CloudErrorHandler.handle('getCatAvatars', err);
  }
};
