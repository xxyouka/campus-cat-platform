// cloudfunctions/compressImages/index.js - 图片压缩与优化链接获取（管理员权限校验）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { COLLECTIONS } = require('./utils/constants');
const { isAllowedStorageFile } = require('./utils/filePathGuard');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ALLOWED_COLLECTIONS = ['photos'];
// field 会直接拼进 where 条件（{[field]: _.exists(true)}）并用于 doc[field] 取值。
// 原先完全由客户端控制：传 catId 会把非 fileID 值当 URL 处理并写回，
// 传 likeCount（数字）会在 originalUrl.startsWith 处抛 TypeError 被 catch 吞掉（静默 0 优化）。
const ALLOWED_FIELDS = ['url', 'cloudFileID'];
const MAX_BATCH = 200;

/**
 * 把 cloud:// fileID 换成可直接访问的临时 URL。
 * 非 cloud:// 原样返回；cloud:// 但换链失败时返回 null（由调用方决定回退策略）。
 * @returns {Promise<string|null>}
 */
async function getTempUrlOrNull(fileID) {
  if (!fileID.startsWith('cloud://')) return fileID;

  const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] });
  if (fileList && fileList[0] && fileList[0].tempFileURL) {
    return fileList[0].tempFileURL;
  }
  return null;
}

/**
 * 追加 imageMogr2 图片处理参数（已带 imageMogr2 的 URL 不重复追加）
 */
function appendImageMogr2(url, { quality, width, height }) {
  if (url.includes('imageMogr2')) return url;

  const params = [];
  if (width) params.push(`imageView2/2/w/${width}`);
  if (height) params.push(`imageView2/2/h/${height}`);
  params.push(`q/${quality}`);
  params.push('format/webp');

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}imageMogr2/${params.join('/')}`;
}

/**
 * 单张图片换链（action: getOptimizedUrl）
 */
async function handleGetOptimizedUrl({ openid, adminAccount, fileID, quality, width, height }) {
  if (!fileID) {
    return fail('fileID 参数必填');
  }

  // 换链会为任意 fileID 签发临时 URL，属于资源敏感操作，仅管理员可用
  const urlAuth = await checkAdmin(db, openid, { operation: '图片换链', adminAccount });
  if (!urlAuth.isAdmin) {
    return fail(urlAuth.error);
  }

  // 路径白名单：只放行业务目录，防止用 backups/、exports/ 等路径换取敏感文件下载链接
  // （非 cloud:// 的普通 URL 不走换链，保持原样返回）
  if (typeof fileID === 'string' && fileID.startsWith('cloud://') && !isAllowedStorageFile(fileID)) {
    console.warn('[compressImages] 拒绝非业务目录的 fileID:', fileID);
    return fail('不允许访问的云存储路径');
  }

  const tempUrl = await getTempUrlOrNull(fileID);
  const baseUrl = tempUrl || fileID;
  const optimizedUrl = appendImageMogr2(baseUrl, { quality, width, height });

  // 注意：ok() 自身已包一层 data，此处直接传业务字段，
  // 避免出现 result.data.data 的双层嵌套（与项目其他云函数保持一致）
  return ok({
    originalUrl: fileID,
    optimizedUrl,
    quality,
    format: 'webp'
  });
}

/**
/**
 * 批量「体检」未优化过的图片（action: batchOptimize）
 *
 * 【重要】为什么**不再**把优化后的链接写进 displayUrl（2026-10-09 修正）：
 * 云存储没有「永久 https 链接」这回事 —— https 形式的地址一定是
 * `cloud.getTempFileURL()` 换出来的**临时链接，约 2 小时过期**。
 * 原实现把它落库，而客户端 `services/photoService.js` 读图时 `displayUrl` 优先于
 * cloud fileID（`p.displayUrl || p._cloudFileID || ...`），于是跑过一次批量优化后，
 * 两小时左右全站照片会在「全屏预览」里集体裂图。
 *
 * 现在的定位：本函数只做**统计与标记**（哪些图还没走过客户端侧的按需压缩），
 * 真正的图片压缩由客户端 `utils/imageLoader.js` 在渲染时按 optimizeType 现算 ——
 * 那条链路本来就在跑，且永远不会过期。
 * 若确实需要「拿到一批优化后的链接」，用下面的 samples 返回（临时有效，请即用即取）。
 */
async function handleBatchOptimize({ openid, adminAccount, collection, field, limit, quality }) {
  const authResult = await checkAdmin(db, openid, { operation: '批量图片体检', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    return fail(authResult.error);
  }

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    return fail('不允许操作的集合');
  }

  if (!ALLOWED_FIELDS.includes(field)) {
    return fail('不允许操作的字段');
  }

  // limit 无上限时 limit=99999 会触发全表逐条写循环，长时间占用函数配额
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), MAX_BATCH);

  const res = await db.collection(collection)
    .where({
      [field]: _.exists(true),
      _optimized: _.neq(true)
    })
    .limit(safeLimit)
    .get();

  let marked = 0;
  // 临时链接只回传给调用方看，不落库（见函数头注释）
  const samples = [];

  for (const doc of res.data) {
    const originalUrl = doc[field];
    if (!originalUrl || !originalUrl.startsWith('cloud://')) continue;

    try {
      const tempUrl = await getTempUrlOrNull(originalUrl);
      if (!tempUrl) continue;

      await db.collection(collection).doc(doc._id).update({
        data: {
          _optimized: true,
          _optimizedAt: new Date()
        }
      });
      marked++;
      if (samples.length < 5) {
        samples.push({ _id: doc._id, preview: `${tempUrl}?imageMogr2/format/webp/q/${quality}` });
      }
    } catch (e) {
      console.error(`[compressImages] 标记失败: ${doc._id}`, e.message);
    }
  }

  // 同上：直接返回业务字段，保持 result.data 为业务对象
  return ok({
    total: res.data.length,
    marked,
    collection,
    // 临时预览链接（约 2 小时有效），仅供本次查看
    samples,
    note: '云存储无永久 https 链接，优化链接不落库；客户端按需压缩链路照常工作'
  });
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, fileID, quality = 80, width, height } = event;
  const adminAccount = event._adminAccount || '';
  const collection = event.collection || COLLECTIONS.PHOTOS;
  const { field = 'url', limit = 50 } = event;

  try {
    switch (action) {
      case 'getOptimizedUrl':
        return await handleGetOptimizedUrl({ openid: OPENID, adminAccount, fileID, quality, width, height });

      case 'batchOptimize':
        return await handleBatchOptimize({
          openid: OPENID, adminAccount, collection, field, limit, quality
        });

      default:
        return fail('未知操作，支持: getOptimizedUrl, batchOptimize');
    }
  } catch (err) {
    console.error('[compressImages] 操作失败:', err);
    return fail('操作失败，请稍后重试');
  }
};
