// cloudfunctions/utils/contentSecurity.js - 内容安全检测公共模块
// 将 msgSecCheck（文本）/ mediaCheckAsync（图片·异步）/ imgSecCheck（旧版兜底）内联到各云函数，
// 避免每次检测都跨函数调用 contentCheck（省一次冷启动与调用费用）。
// 由 scripts/build-cloud.js 同步到各云函数 utils/ 目录。
const cloud = require('wx-server-sdk');
const { COLLECTIONS } = require('./constants');

// imgSecCheck v2 接口的图片大小上限（1M）—— 仅旧版兜底路径用得到
const IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * 是否启用 mediaCheckAsync（官方现役的多媒体内容安全接口）。
 *
 * 为什么要有开关：异步方案的完整性依赖两件**外部**配置 ——
 *   ① 公众平台把 `wxa_media_check` 事件订阅到 mediaCheckCallback 云函数；
 *   ② `mediaChecks` 集合已创建（待检记录要落库，回调要按 trace_id 反查）。
 * 任一没到位，异步提交出去的检测就没人回收 = 静默失去内容审核。
 * 因此未显式置 1 时一律走旧版同步接口（限流时降级放行），行为与此前一致。
 *
 * 环境变量：MEDIA_CHECK_ASYNC=1
 */
function isAsyncMediaCheckEnabled() {
  return process.env.MEDIA_CHECK_ASYNC === '1';
}

/**
 * 文本内容安全检测（msgSecCheck）
 * @param {string} content - 待检测文本（≤500 字）
 * @param {object} [options]
 * @param {number} [options.scene] - 场景（默认 2）
 * @param {string} [options.openid] - 调用者 openid
 * @returns {Promise<{ok: boolean, error?: string}>} 检测异常时失败关闭
 */
async function checkText(content, { scene = 2, openid = '' } = {}) {
  if (!content || typeof content !== 'string') {
    return { ok: false, error: '缺少待检测内容' };
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: '内容不能为空' };
  }
  if (trimmed.length > 500) {
    return { ok: false, error: '内容长度不能超过500字' };
  }

  try {
    await cloud.openapi.security.msgSecCheck({
      content: trimmed,
      version: 2,
      scene,
      openid
    });
    return { ok: true };
  } catch (err) {
    console.warn('[contentSecurity] 文本安全检测未通过:', err.message || err);
    return { ok: false, error: '内容可能包含不当词语，请修改后再试' };
  }
}

/**
 * 判定 imgSecCheck 的异常是否为「内容违规」类（确定性拒绝）。
 * 微信返回 errCode 87014 表示内容含违规；其余（限流 45009、网络抖动、系统错误）
 * 属可重试的瞬时故障，不应按「图片包含不当内容」处理。
 * @private
 */
function isContentViolationError(err) {
  const code = err && (err.errCode || err.code);
  if (code === 87014 || code === '87014') return true;
  const msg = String(err && (err.errMsg || err.message) || '');
  return /risky|87014/i.test(msg);
}

/**
 * 判定异常是否为「接口不可用 / 未开通 / 未支持」类 —— 这类错误不该重试，
 * 应当退回兜底路径（旧版同步接口），否则异步方案一上线就会让上传全部失败。
 * @private
 */
function isUnsupportedApiError(err) {
  const code = err && (err.errCode || err.code);
  if ([40001, 41005, 48001].includes(Number(code))) return true;
  const msg = String(err && (err.errMsg || err.message) || '');
  return /is not a function|not found|unauthorized|invalid media_url|media_url is invalid/i.test(msg);
}

/**
 * 异步图片内容安全检测（mediaCheckAsync，官方现役接口）
 *
 * 流程：取云存储临时链接 → 提交检测拿 trace_id → 落一条「待检」记录。
 * 微信随后把结果通过 `wxa_media_check` 事件投递给 mediaCheckCallback 云函数，
 * 由它按 trace_id 反查本记录并决定放行 / 复核 / 拦截。
 *
 * 之所以不在这里等结果：接口是异步的（官方说明检测约 10 秒内出结果），
 * 同步等待会把每次上传的云函数耗时拉长，且旧版接口的限流问题正是出在同步调用上。
 *
 * @param {string} fileID - 云存储 fileID（cloud://）
 * @param {object} [options]
 * @param {number} [options.scene]
 * @param {string} [options.openid] - 上传者 openid（v2 接口要求，且用户近 2 小时访问过小程序）
 * @param {string} [options.target] - 业务对象类型（'avatar' | 'photo'），供回调定位处置对象
 * @param {string} [options.refId] - 业务对象 ID（catId / photoId）
 * @returns {Promise<{ok: boolean, async?: boolean, traceId?: string,
 *   fallback?: boolean, degraded?: boolean, reason?: string}>}
 */
async function checkImageAsync(fileID, { scene = 2, openid = '', target = '', refId = '' } = {}) {
  // 1) 取临时链接：微信服务器需要能下载到这个地址
  let tempUrl = '';
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileID] });
    const item = res && res.fileList && res.fileList[0];
    tempUrl = item && (item.tempFileURL || item.tempFileUrl) || '';
  } catch (err) {
    console.warn('[contentSecurity] 取临时链接失败:', err.message || err);
  }
  if (!tempUrl) {
    // 拿不到链接 = 异步方案无从提交，退回旧版同步接口
    return { ok: true, fallback: true, reason: '取不到云存储临时链接' };
  }

  // 2) 提交检测
  let traceId = '';
  try {
    const res = await cloud.openapi.security.mediaCheckAsync({
      media_url: tempUrl,
      media_type: 1, // 1 = 图片
      version: 2,
      openid,
      scene
    });
    traceId = res && (res.trace_id || res.traceId) || '';
  } catch (err) {
    if (isUnsupportedApiError(err)) {
      console.warn('[contentSecurity] mediaCheckAsync 不可用，退回旧版接口:', err.message || err);
      return { ok: true, fallback: true, reason: 'mediaCheckAsync 不可用' };
    }
    // 提交失败（含 1008 下载错误、openid 未访问小程序等）：与旧版同口径，放行并告警
    console.warn('[contentSecurity] 异步检测提交失败，按放行处理:', err.message || err);
    return { ok: true, degraded: true, reason: '异步检测提交失败' };
  }
  if (!traceId) {
    return { ok: true, degraded: true, reason: '未返回 trace_id' };
  }

  // 3) 落待检记录：回调只认 trace_id，没有这条记录就无法定位处置对象
  try {
    const db = cloud.database();
    await db.collection(COLLECTIONS.MEDIA_CHECKS).add({
      data: {
        traceId,
        fileID,
        target,
        refId,
        openid,
        scene,
        status: 'pending',
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    });
  } catch (err) {
    // 记录落库失败：上传仍放行（内容检测是合规兜底，不阻断业务），
    // 但必须留下告警 —— 否则这次检测彻底无人回收。
    console.warn('[contentSecurity] 待检记录落库失败（回调将无法反查）:', err.message || err);
  }

  return { ok: true, async: true, traceId };
}

/**
 * 图片内容安全检测入口
 *
 * 默认走旧版同步接口 imgSecCheck（限流时降级放行，行为见文末注释）；
 * 置 MEDIA_CHECK_ASYNC=1 后改用官方现役的 mediaCheckAsync（异步 + 回调复核），
 * 接口不可用时自动退回旧版路径，保证任何情况下都不会把上传卡死。
 *
 * 调用方（addPhoto/addCat/updateCat）应先用 filePathGuard 把 fileID 收窄到
 * 本业务目录（photos/、cats/）再调本函数 —— 否则「检测失败即删文件」会变成
 * 「传任意已知 fileID 触发服务端删除」的原语。
 *
 * @param {string} [fileID] - 云存储 fileID（cloud://），为空则跳过
 * @param {object} [options]
 * @param {number} [options.scene]
 * @param {string} [options.openid]
 * @param {string} [options.target] - 'avatar' | 'photo'（异步路径需要，供回调处置）
 * @param {string} [options.refId] - catId / photoId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkImage(fileID, { scene = 2, openid = '', target = '', refId = '' } = {}) {
  // 无图可检（调用方未传图片）时直接放行，避免误拦截正常请求
  if (!fileID || typeof fileID !== 'string') {
    return { ok: true };
  }
  if (!fileID.startsWith('cloud://')) {
    return { ok: true };
  }

  if (isAsyncMediaCheckEnabled()) {
    const asyncRes = await checkImageAsync(fileID, { scene, openid, target, refId });
    // fallback=true 表示异步链路不可用，走下面的旧版同步实现
    if (!asyncRes.fallback) {
      return asyncRes;
    }
    console.warn('[contentSecurity] 已退回 imgSecCheck 兜底路径:', asyncRes.reason || '');
  }

  let fileContent;
  try {
    const dl = await cloud.downloadFile({ fileID });
    fileContent = dl.fileContent;
  } catch (err) {
    console.warn('[contentSecurity] 图片下载失败:', err.message || err);
    return { ok: false, error: '图片下载失败，请稍后重试' };
  }

  if (!fileContent || fileContent.length === 0) {
    return { ok: false, error: '图片数据为空' };
  }
  if (fileContent.length > IMAGE_MAX_BYTES) {
    return { ok: false, error: '图片超过1M限制，请压缩后重试' };
  }

  const runImgSecCheck = () => cloud.openapi.security.imgSecCheck({
    media: fileContent,
    version: 2,
    scene,
    openid
  });

  try {
    await runImgSecCheck();
    return { ok: true };
  } catch (err) {
    // 内容违规 = 确定性拒绝，必然拦截
    if (isContentViolationError(err)) {
      console.warn('[contentSecurity] 图片安全检测未通过（违规）:', err.message || err);
      return { ok: false, error: '图片可能包含不当内容，请更换后再试' };
    }
    // 非违规（旧版接口限流 45009 / 接口异常 / 超时）：重试一次
    try {
      await runImgSecCheck();
      return { ok: true };
    } catch (retryErr) {
      if (isContentViolationError(retryErr)) {
        console.warn('[contentSecurity] 图片安全检测未通过（重试命中违规）:', retryErr.message || retryErr);
        return { ok: false, error: '图片可能包含不当内容，请更换后再试' };
      }
      // 旧版 imgSecCheck 配额紧张（限流常见 45009，且官方已只维护 mediaCheckAsync）。
      // 管理员上传属半可信内容：限流/接口异常时放行并记录警告，不再把「接口限流」
      // 伪装成「内容违规」挡住全部上传。异步方案 mediaCheckAsync 已接管内容复核：
      // addPhoto（10-09）/ addCat / updateCat（10-13）均已置 MEDIA_CHECK_ASYNC=1，
      // 本同步路径只在异步链路不可用时兜底（见 checkImage 入口的分支）。
      console.warn('[contentSecurity] 图片检测服务异常（重试后仍失败），按放行处理:', retryErr.message || retryErr);
      return { ok: true, degraded: true };
    }
  }
}

/**
 * 把异步检测的待检记录绑定到业务对象 ID。
 *
 * 为什么需要：addCat / addPhoto 都是「先检测 → 再落库」，检测时对象还不存在
 * （`add()` 返回的 _id 才有），所以 checkImage 调用方拿不到 refId。落库后调本函数
 * 补写，回调就能定位到具体是哪个对象需要处置。
 *
 * 非异步路径（未返回 traceId）或记录已非 pending 时静默跳过 —— 不阻断主流程。
 *
 * @param {string} [traceId] - checkImage 返回的 traceId
 * @param {string} [refId] - 业务对象 ID（catId / photoId）
 * @returns {Promise<boolean>} 是否成功绑定
 */
async function bindMediaCheckRef(traceId, refId) {
  if (!traceId || !refId) return false;
  try {
    const db = cloud.database();
    const found = await db.collection(COLLECTIONS.MEDIA_CHECKS)
      .where({ traceId, status: 'pending' })
      .limit(1)
      .get();
    const record = found.data && found.data[0];
    if (!record) return false;
    await db.collection(COLLECTIONS.MEDIA_CHECKS).doc(record._id).update({
      data: { refId, updateTime: db.serverDate() }
    });
    return true;
  } catch (err) {
    console.warn('[contentSecurity] 绑定待检记录失败（非致命）:', err.message || err);
    return false;
  }
}

module.exports = { checkText, checkImage, checkImageAsync, bindMediaCheckRef, isAsyncMediaCheckEnabled };
