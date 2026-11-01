// cloudfunctions/exportData/index.js - 导出数据库数据为 ZIP 归档（管理员权限校验）
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { log: auditLog } = require('./utils/audit');
const { CloudLogger, CloudErrorHandler } = require('./utils/logger');
const archiver = require('archiver');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { AGG_LIMIT, readGroupedCounts, fillCountsByCount } = require('./utils/photoCounts');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
// 聚合指令挂在 db.command.aggregate 上（db.command 本身没有 sum/in）
const $ = db.command.aggregate;

const EXPORT_TYPES = {
  cats: {
    collection: COLLECTIONS.CATS,
    fields: {
      _id: 'ID', name: '名称', gender: '性别', age: '年龄',
      color: '花色', campus: '校区', status: '状态',
      sterilized: '是否绝育', meetCount: '相遇次数',
      photoCount: '照片数', description: '描述', updateTime: '更新时间'
    },
    dateField: 'updateTime'
  },
  cat_complete: {
    collection: COLLECTIONS.CATS,
    fields: {
      _id: 'ID', name: '名称', gender: '性别', age: '年龄',
      color: '花色', campus: '校区', status: '状态',
      sterilized: '是否绝育', meetCount: '相遇次数',
      photoCount: '照片数', description: '描述', updateTime: '更新时间'
    },
    dateField: 'updateTime'
  },
  photos: {
    collection: COLLECTIONS.PHOTOS,
    fields: {
      _id: 'ID', catId: '猫咪ID', catName: '猫咪名称',
      url: '图片地址', likeCount: '点赞数',
      description: '描述', createTime: '创建时间'
    },
    dateField: 'createTime'
  },
  meets: {
    collection: COLLECTIONS.RECORD_MEET,
    fields: {
      _id: 'ID', catId: '猫咪ID', catName: '猫咪名称',
      location: '地点', statusTag: '状态标签',
      meetTime: '相遇时间', createTime: '创建时间'
    },
    dateField: 'meetTime'
  }
};

const MAX_EXPORT_ROWS = 5000;
const MAX_PHOTOS_EXPORT = 1000;
const SUPPORTED_FORMATS = ['csv', 'json', 'txt', 'zip'];

exports.main = async (event) => {
  // HTTP触发器适配：解析body中的JSON数据
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const startTime = Date.now();
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';
  const { type, format = 'csv', startDate, endDate, fields: selectedFields } = event;

  const authResult = await checkAdmin(db, OPENID, { useCache: false, operation: '数据导出', adminAccount });
  if (!authResult.isAdmin) {
    return fail(authResult.error);
  }

  if (authResult.adminInfo?.role !== 'superadmin') {
    return fail('仅超级管理员可导出数据');
  }

  if (!type || !EXPORT_TYPES[type]) {
    return fail('无效的导出类型');
  }

  if (!SUPPORTED_FORMATS.includes(format)) {
    return fail('不支持的导出格式，仅支持 csv, json, txt, zip');
  }

  try {
    let result;

    if (type === 'cat_complete') {
      result = await exportCatComplete({ format, startDate, endDate });
    } else if (type === COLLECTIONS.CATS && format === 'txt') {
      result = await exportCatsAsTxt({ startDate, endDate });
    } else if (type === COLLECTIONS.PHOTOS && format === 'zip') {
      result = await exportPhotosAsZip({ startDate, endDate });
    } else {
      result = await exportAsCsvJson({ type, format, startDate, endDate, selectedFields });
    }

    const duration = Date.now() - startTime;
    CloudLogger.performance('exportData', `导出${type}`, duration);

    await auditLog({
      action: 'export_data', operator: OPENID,
      targetType: type,
      detail: `导出${result.count}条${type}数据，格式: ${format}`,
      result: 'success'
    });

    return ok({
      count: result.count,
      // zip 导出因内存预算被截断时如实回传 skipped，避免管理端误以为"全部导出成功"
      skipped: result.skipped || 0,
      fileID: result.fileID, downloadUrl: result.downloadUrl,
      type, format, duration
    });

  } catch (err) {
    CloudLogger.error('exportData', '导出失败', err);
    await auditLog({
      action: 'export_data', operator: OPENID,
      targetType: type, detail: `导出${type}数据失败`,
      result: 'fail'
    }).catch(() => {});
    return CloudErrorHandler.handle('exportData', err);
  }
};

/**
 * 导出猫咪完整档案（猫咪数据）
 */
async function exportCatComplete({ format, startDate, endDate }) {
  // 获取所有猫咪
  const catsConfig = EXPORT_TYPES.cat_complete;
  const whereCondition = buildWhereCondition(catsConfig, startDate, endDate);
  let query = db.collection(catsConfig.collection);
  if (Object.keys(whereCondition).length > 0) {
    query = query.where(whereCondition);
  }
  const cats = await loadAll(query, Object.keys(catsConfig.fields), MAX_EXPORT_ROWS);

  if (cats.length === 0) {
    throw new Error('没有符合条件的数据可导出');
  }

  // 照片数以 photos 集合为准现算（cats.photoCount 全项目无写入方，读它恒为 0）
  const photoCountMap = await loadPhotoCountMap(cats.map(c => c._id));

  // 转换猫咪数据
  const statusMap = {
    normal: '在校', adopted: '已领养', lost: '走失', deceased: '已离世'
  };

  let fileContent;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  if (format === 'json') {
    // JSON 格式：每只猫咪一个对象
    const exportData = cats.map(cat => {
      return {
        猫咪信息: {
          ID: cat._id,
          名称: cat.name || '未命名',
          性别: cat.gender || '未知',
          年龄: cat.age || '未知',
          花色: cat.color || '未填写',
          校区: cat.campus || '未填写',
          状态: statusMap[cat.status] || cat.status || '未知',
          是否绝育: cat.sterilized === 'true' || cat.sterilized === true ? '已绝育' :
            cat.sterilized === 'false' || cat.sterilized === false ? '未绝育' : '未知',
          相遇次数: cat.meetCount || 0,
          照片数: photoCountMap[cat._id] || 0,
          描述: cat.description || '',
          更新时间: cat.updateTime || ''
        }
      };
    });

    fileContent = JSON.stringify(exportData, null, 2);
    const cloudPath = `exports/cat_complete_${timestamp}.json`;

    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from(fileContent, 'utf-8')
    });
    const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });

    return {
      count: cats.length,
      fileID: uploadRes.fileID,
      downloadUrl: tempUrlRes.fileList[0].tempFileURL
    };
  } else {
    // TXT 格式：友好的文本格式
    const lines = [];
    lines.push('='.repeat(50));
    lines.push('  校园猫猫 · 猫咪完整档案');
    lines.push('  导出时间: ' + new Date().toLocaleString('zh-CN'));
    lines.push('  猫咪总数: ' + cats.length + ' 只');
    lines.push('='.repeat(50));
    lines.push('');

    cats.forEach((cat, index) => {
      lines.push('--- 猫咪 ' + (index + 1) + ' ---');
      lines.push('名称: ' + (cat.name || '未命名'));
      lines.push('性别: ' + (cat.gender || '未知'));
      lines.push('年龄: ' + (cat.age || '未知'));
      lines.push('花色: ' + (cat.color || '未填写'));
      lines.push('校区: ' + (cat.campus || '未填写'));
      lines.push('状态: ' + (statusMap[cat.status] || cat.status || '未知'));
      lines.push('绝育: ' + (cat.sterilized === 'true' || cat.sterilized === true ? '已绝育' :
        cat.sterilized === 'false' || cat.sterilized === false ? '未绝育' : '未知'));
      lines.push('相遇次数: ' + (cat.meetCount || 0));
      lines.push('照片数: ' + (photoCountMap[cat._id] || 0));
      if (cat.description) lines.push('描述: ' + cat.description);
      if (cat.location) lines.push('常驻地: ' + cat.location);
      if (cat.updateTime) lines.push('更新时间: ' + cat.updateTime);

      lines.push('');
    });

    lines.push('='.repeat(50));
    lines.push('  导出完毕 · 共 ' + cats.length + ' 只猫咪');
    lines.push('='.repeat(50));

    fileContent = lines.join('\n');
    const cloudPath = `exports/cat_complete_${timestamp}.txt`;

    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from('\uFEFF' + fileContent, 'utf-8')
    });
    const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });

    return {
      count: cats.length,
      fileID: uploadRes.fileID,
      downloadUrl: tempUrlRes.fileList[0].tempFileURL
    };
  }
}

/**
 * 导出猫咪数据为 TXT 格式
 */
async function exportCatsAsTxt({ startDate, endDate }) {
  const typeConfig = EXPORT_TYPES.cats;
  const whereCondition = buildWhereCondition(typeConfig, startDate, endDate);

  let query = db.collection(typeConfig.collection);
  if (Object.keys(whereCondition).length > 0) {
    query = query.where(whereCondition);
  }

  const data = await loadAll(query, Object.keys(typeConfig.fields), MAX_EXPORT_ROWS);
  if (data.length === 0) {
    throw new Error('没有符合条件的数据可导出');
  }

  // 照片数以 photos 集合为准现算（cats.photoCount 全项目无写入方，读它恒为 0）
  const photoCountMap = await loadPhotoCountMap(data.map(c => c._id));

  const statusMap = {
    normal: '在校', adopted: '已领养', lost: '走失', deceased: '已离世'
  };

  const lines = [];
  lines.push('='.repeat(40));
  lines.push('  校园猫猫 · 猫咪数据导出');
  lines.push('  导出时间: ' + new Date().toLocaleString('zh-CN'));
  lines.push('  猫咪总数: ' + data.length + ' 只');
  lines.push('='.repeat(40));
  lines.push('');

  data.forEach((cat, index) => {
    lines.push('--- 猫咪 ' + (index + 1) + ' ---');
    lines.push('名称: ' + (cat.name || '未命名'));
    lines.push('性别: ' + (cat.gender || '未知'));
    lines.push('年龄: ' + (cat.age || '未知'));
    lines.push('花色: ' + (cat.color || '未填写'));
    lines.push('校区: ' + (cat.campus || '未填写'));
    lines.push('状态: ' + (statusMap[cat.status] || cat.status || '未知'));
    lines.push('绝育: ' + (cat.sterilized === 'true' || cat.sterilized === true ? '已绝育' : cat.sterilized === 'false' || cat.sterilized === false ? '未绝育' : '未知'));
    lines.push('相遇次数: ' + (cat.meetCount || 0));
    lines.push('照片数: ' + (photoCountMap[cat._id] || 0));
    if (cat.description) lines.push('描述: ' + cat.description);
    if (cat.location) lines.push('常驻地: ' + cat.location);
    if (cat.updateTime) lines.push('更新时间: ' + cat.updateTime);
    lines.push('');
  });

  lines.push('='.repeat(40));
  lines.push('  导出完毕 · 共 ' + data.length + ' 只猫咪');
  lines.push('='.repeat(40));

  const fileContent = lines.join('\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const cloudPath = `exports/cats_${timestamp}.txt`;

  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: Buffer.from('\uFEFF' + fileContent, 'utf-8')
  });

  const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });

  return {
    count: data.length,
    fileID: uploadRes.fileID,
    downloadUrl: tempUrlRes.fileList[0].tempFileURL
  };
}

/**
 * 导出照片为 ZIP 格式（按猫咪名称分文件夹）
 */
async function exportPhotosAsZip({ startDate, endDate }) {
  // 同 buildWhereCondition：删除中的猫不进相册导出（cats 侧）
  const catsData = await loadAll(
    db.collection(COLLECTIONS.CATS).where({ _deleting: _.neq(true) }),
    ['_id', 'name'],
    MAX_EXPORT_ROWS
  );
  const catMap = {};
  catsData.forEach(c => { catMap[c._id] = c.name || '未命名'; });

  const query = db.collection(COLLECTIONS.PHOTOS).where(buildPhotoWhereCondition(startDate, endDate));

  const photos = [];
  let skip = 0;
  const batchSize = 100;
  const MAX_PHOTOS = MAX_PHOTOS_EXPORT;

  // 命中 1000 张上限时，余量必须如实计入 skipped（此前只统计「字节预算放不下」的张数，
  // 管理员会看到「导出成功、skipped=0」却少了照片）。count 失败不影响导出本身。
  let totalMatchingPhotos = 0;
  try {
    const countRes = await query.count();
    totalMatchingPhotos = countRes.total || 0;
  } catch (countErr) {
    CloudLogger.warn('exportData', '照片总数统计失败（不影响导出）', { error: countErr.message });
  }

  while (photos.length < MAX_PHOTOS) {
    const res = await query.orderBy('createTime', 'desc').skip(skip).limit(batchSize).get();
    if (!res.data || res.data.length === 0) break;
    for (const p of res.data) {
      if (p.url || p.cloudFileID) {
        photos.push(p);
        if (photos.length >= MAX_PHOTOS) break;
      }
    }
    skip += res.data.length;
    if (res.data.length < batchSize) break;
  }

  if (photos.length === 0) {
    throw new Error('没有符合条件的照片可导出');
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks = [];
  archive.on('data', chunk => chunks.push(chunk));
  archive.on('warning', err => console.warn('[exportData] archiver warning:', err.message));

  // 内存预算（原先只有张数上限，没有字节上限）：
  // chunks 全量驻留内存，结束时还要 Buffer.concat 再复制一份 ≈ 2 倍峰值。
  // 1000 张 × 0.5MB ≈ 500MB，再叠加 concat 就是 1GB —— 云函数默认 256MB 内存必然 OOM，
  // 且 CONCURRENT_BATCH 只限制下载并发、不限制累积量。改为按累计字节收敛，
  // 命中上限即停止并如实告知导出数量（宁可少导，不可崩在云端留下半成品）。
  const MAX_TOTAL_BYTES = 180 * 1024 * 1024;
  let totalBytes = 0;
  let skippedBySize = 0;

  let downloadedCount = 0;
  const CONCURRENT_BATCH = 5;
  for (let i = 0; i < photos.length; i += CONCURRENT_BATCH) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      skippedBySize = photos.length - downloadedCount;
      console.warn(`[exportData] 达到内存预算上限 ${MAX_TOTAL_BYTES} 字节，剩余 ${skippedBySize} 张未导出`);
      break;
    }
    const batch = photos.slice(i, i + CONCURRENT_BATCH);
    const batchResults = await Promise.all(batch.map(async (photo) => {
      try {
        const catName = catMap[photo.catId] || '未分类';
        const sanitizedName = catName.replace(/[/\\?*:|"<>]/g, '_');
        const fileId = photo.url || photo.cloudFileID || '';
        if (!fileId.startsWith('cloud://')) return null;

        const res = await cloud.downloadFile({ fileID: fileId });
        const ext = (fileId.split('.').pop() || 'jpg').split('?')[0];
        const photoName = `${photo._id || Date.now()}.${ext}`;
        return { content: res.fileContent, name: `${sanitizedName}/${photoName}` };
      } catch (err) {
        CloudLogger.warn('exportData', `照片下载失败: ${err.message || '未知错误'}`);
        return null;
      }
    }));

    for (const result of batchResults) {
      if (!result) continue;
      const size = result.content ? result.content.length : 0;
      if (totalBytes + size > MAX_TOTAL_BYTES) {
        skippedBySize++;
        continue;
      }
      totalBytes += size;
      archive.append(result.content, { name: result.name });
      downloadedCount++;
    }
  }

  if (downloadedCount === 0) {
    throw new Error('所有照片下载失败，请检查云存储权限');
  }

  await archive.finalize();
  const zipBuffer = Buffer.concat(chunks);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const cloudPath = `exports/photos_${timestamp}.zip`;

  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: zipBuffer
  });

  const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });

  CloudLogger.log('exportData', `ZIP导出完成: ${downloadedCount}张照片, ${zipBuffer.length / 1024 / 1024}MB`);

  return {
    count: downloadedCount,
    // 命中内存预算 / 1000 张上限而未导出的张数，如实回传给管理端，
    // 避免"导出成功"却少了照片
    skipped: skippedBySize + Math.max(0, totalMatchingPhotos - photos.length),
    fileID: uploadRes.fileID,
    downloadUrl: tempUrlRes.fileList[0].tempFileURL
  };
}

/**
 * 导出为 CSV 或 JSON
 */
async function exportAsCsvJson({ type, format, startDate, endDate, selectedFields }) {
  const typeConfig = EXPORT_TYPES[type];
  const allFieldKeys = Object.keys(typeConfig.fields);
  let exportFields = allFieldKeys;
  if (selectedFields && Array.isArray(selectedFields) && selectedFields.length > 0) {
    exportFields = selectedFields.filter(f => allFieldKeys.includes(f));
    if (exportFields.length === 0) exportFields = allFieldKeys;
  }

  const whereCondition = buildWhereCondition(typeConfig, startDate, endDate);
  let query = db.collection(typeConfig.collection);
  if (Object.keys(whereCondition).length > 0) {
    query = query.where(whereCondition);
  }

  const data = await loadAll(query, exportFields, MAX_EXPORT_ROWS);

  if (data.length === 0) {
    throw new Error('没有符合条件的数据可导出');
  }

  let fileContent;
  const fileExt = format;

  if (format === 'json') {
    const exportData = data.map(row => {
      const obj = {};
      for (const field of exportFields) {
        obj[typeConfig.fields[field] || field] = row[field];
      }
      return obj;
    });
    fileContent = JSON.stringify(exportData, null, 2);
  } else {
    fileContent = convertToCSV(data, exportFields, typeConfig.fields);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const cloudPath = `exports/${type}_${timestamp}.${fileExt}`;

  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: Buffer.from(format === 'csv' ? '\uFEFF' + fileContent : fileContent, 'utf-8')
  });

  const tempUrlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });

  return {
    count: data.length,
    fileID: uploadRes.fileID,
    downloadUrl: tempUrlRes.fileList[0].tempFileURL
  };
}

/**
 * 统计各猫咪的照片数（按 catId 分组）。
 *
 * 不能读 cats.photoCount：该字段全项目**没有任何写入方**
 * （addCat / updateCat / addPhoto 都不写），前端展示的照片数是
 * getCatPhotoCounts 聚合后现算的。直接读它会让导出列恒为 0，
 * 管理员据此对账会得到「所有猫都没有照片」的错误结论。
 * 以 photos 集合为唯一事实源现算。
 *
 * 两次修订（2026-10-12）：
 *   1. 原先按 100 个 id 一批 `.match({ catId: $.in(batch) }).group(...)`，
 *      **不写 .limit()** —— 聚合不写 limit 时只回 20 组且不报错，
 *      每批第 21 只猫起的照片数静默变成 0（导出是审计场景，这种错最致命）；
 *   2. 现在与 getAlbumsWithInfo / getCatPhotoCounts 共用 utils/photoCounts.js：
 *      显式 limit + 「分组计数之和 == 照片总数」完整性校验，
 *      不成立就降级逐只 count（慢但一定对）。
 *
 * 统计失败不阻断导出：导出是审计场景的主功能，不能因为一个统计列而整体失败。
 * 但降级是**逐只 count**（精确），不是「该批按 0 处理」那种静默失真。
 *
 * @param {string[]} catIds
 * @returns {Promise<Record<string, number>>}
 */
async function loadPhotoCountMap(catIds) {
  if (!Array.isArray(catIds) || catIds.length === 0) return {};

  try {
    const [groupRes, totalRes] = await Promise.all([
      db.collection(COLLECTIONS.PHOTOS)
        .aggregate()
        .group({ _id: '$catId', count: $.sum(1) })
        .limit(AGG_LIMIT)
        .end(),
      db.collection(COLLECTIONS.PHOTOS).count()
    ]);

    const grouped = readGroupedCounts(groupRes && groupRes.list);
    const total = totalRes && totalRes.total || 0;
    // 完整 → 直接用（多余键无害：调用方按 cat._id 查表，见 loadPhotoCountMap 的调用点）
    if (grouped.sum === total) return grouped.counts;

    console.warn('[exportData] 照片数分组结果不完整，降级逐只 count:', {
      groupedSum: grouped.sum,
      total,
      groupedKeys: Object.keys(grouped.counts).length
    });
  } catch (e) {
    console.warn('[exportData] 照片数聚合失败，降级逐只 count:', e.message || e);
  }

  return fillCountsByCount(db, COLLECTIONS.PHOTOS, catIds);
}

/**
 * 照片导出的查询条件：恒含「非删除中」，有日期区间时再叠加。
 * photos 目前没有软删写方（deletePhoto 是硬删），仍加过滤是为了口径统一 + 防止后续引入；
 * 单独成函数而不是内联在 exportPhotosAsZip 里，是为了让那段保持 100 行以内
 * （lint max-lines-per-function）。
 */
function buildPhotoWhereCondition(startDate, endDate) {
  const dateFilter = startDate || endDate
    ? buildDateFilter(EXPORT_TYPES.photos.dateField, startDate, endDate)
    : null;
  return { _deleting: _.neq(true), ...dateFilter || {} };
}

function buildWhereCondition(typeConfig, startDate, endDate) {
  const dateFilter = startDate || endDate
    ? buildDateFilter(typeConfig.dateField, startDate, endDate)
    : null;
  // 删除中的猫咪（deleteData 的 _deleting 哨兵）不进导出：
  // 与列表/详情/相册的可见性口径一致，否则管理员会导出一批前台已看不到的记录，
  // 并据此得出「有这只猫但它不在列表里」的错误结论。
  // 注意：即使不传日期区间，条件也非空（三个调用点按 length 判断是否 where，故恒成立）。
  return { _deleting: _.neq(true), ...dateFilter || {} };
}

// 只接受 'YYYY-MM-DD' 纯日期；带时间的字符串仍按原样解析（兼容旧调用方）
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析日期区间端点（毫秒时间戳）。
 * 云函数容器是 UTC：`new Date('2026-09-15')` 得到的是 UTC 0 点 = 北京 8 点，
 * `setHours(23,59,59,999)` 也按 UTC 收尾 —— 区间会变成
 * 「北京 9/15 08:00 ~ 9/16 07:59」，漏掉起始日 00:00-08:00、多出结束日次日
 * 00:00-08:00 的记录（与 getMeetCalendar / getOperationLogs 的北京时间口径不一致）。
 * 纯日期一律按 +08:00 解析。
 */
function parseDateStart(value, label) {
  if (DATE_ONLY_RE.test(value)) {
    const ts = new Date(`${value}T00:00:00+08:00`).getTime();
    if (isNaN(ts)) throw new Error(`${label}格式不正确`);
    return ts;
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error(`${label}格式不正确`);
  return d.getTime();
}

function buildDateFilter(dateField, startDate, endDate) {
  let condition = null;

  if (startDate) {
    condition = _.gte(new Date(parseDateStart(startDate, '起始日期')));
  }
  if (endDate) {
    const endTs = DATE_ONLY_RE.test(endDate)
      // 北京时间当日 23:59:59.999 = 次日 0 点 - 1ms
      ? new Date(`${endDate}T00:00:00+08:00`).getTime() + 24 * 3600 * 1000 - 1
      : parseDateStart(endDate, '结束日期');
    if (isNaN(endTs)) throw new Error('结束日期格式不正确');
    const endOfDay = new Date(endTs);
    condition = condition
      ? condition.and(_.lte(endOfDay))
      : _.lte(endOfDay);
  }

  if (!condition) return null;
  // 日期条件必须绑定到具体字段，此前返回裸 command 导致 where() 不生效
  return { [dateField]: condition };
}

/**
 * 分批拉取全部数据（游标语义靠稳定排序保证）
 *
 * 必须在内部强制加 `orderBy('_id','asc')`：云数据库在**无 orderBy** 时不保证
 * 返回顺序稳定，skip/limit 分页会随底层存储变化而漂移 —— 导出 5000 条时同一文档
 * 可能在第 3 页和第 47 页各出现一次（金额/次数被重复计入），也可能整段丢失。
 * 导出是审计与对账场景的输出，重复计数会直接误导管理员判断。
 * 同文件的 exportPhotosAsZip 早已带orderBy，说明该风险是已知的，此处原先是漏的。
 *
 * 依赖：调用点传入的 query 不得自带 orderBy（重复 orderBy 会抛错）。
 * 现存5 个调用点均未带，新增时须一并遵守。
 */
async function loadAll(query, fields, maxRows) {
  const allData = [];
  let skip = 0;
  const batchSize = 100;
  const orderedQuery = query.orderBy('_id', 'asc');

  while (allData.length < maxRows) {
    const res = await orderedQuery.skip(skip).limit(batchSize).get();
    if (!res.data || res.data.length === 0) break;

    for (const item of res.data) {
      const row = {};
      for (const field of fields) {
        const value = item[field];
        if (value === undefined || value === null) {
          row[field] = '';
        } else if (typeof value === 'object') {
          row[field] = JSON.stringify(value);
        } else {
          row[field] = String(value);
        }
      }
      allData.push(row);
    }

    skip += res.data.length;
    if (res.data.length < batchSize) break;
  }

  if (allData.length >= maxRows) {
    CloudLogger.warn('exportData', `导出数据已达上限 ${maxRows} 条，可能存在未导出数据`);
  }

  return allData;
}

function convertToCSV(data, fields, fieldLabels) {
  const header = fields.map(f => fieldLabels[f] || f);
  const rows = data.map(row =>
    fields.map(field => {
      let val = row[field] || '';
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(',')
  );
  return header.join(',') + '\n' + rows.join('\n');
}
