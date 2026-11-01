// cloudfunctions/manageReport/index.js - 管理端「反馈处理」队列
//
// 用户端 submitReport 只写 pending；本函数负责 list / resolve（已处理 / 未采纳）。
// 权限只认服务端 OPENID + checkAdmin；处理结果同时写站内通知给反馈人，
// 通知失败不阻断审核结论（反馈已处理才是主流程）。
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const sanitizer = require('./utils/sanitizer');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const STATUSES = ['pending', 'resolved', 'rejected'];
// 用户端已不再提供「疑似走失」；历史 lost 记录仍可按「全部」查看，但不进类型统计/筛选。
const REPORT_TYPES = ['info_error', 'injured', 'other'];
const RESOLVE_STATUSES = new Set(['resolved', 'rejected']);
const NOTE_MAX = 100;
const STATS_WINDOW_DAYS = 30;
const STATS_TOP_CATS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const $ = db.command.aggregate;

function publicItem(record) {
  return {
    _id: record._id,
    catId: record.catId || '',
    catName: record.catName || '',
    catAvatar: record.catAvatar || '',
    catStatus: record.catStatus || '',
    type: record.type || '',
    description: record.description || '',
    status: record.status || 'pending',
    handleNote: record.handleNote || '',
    createTime: record.createTime || null,
    updateTime: record.updateTime || record.createTime || null
  };
}

async function listReports(event) {
  const page = Math.min(Math.max(1, parseInt(event.page, 10) || 1), 1000);
  const pageSize = Math.min(
    Math.max(1, parseInt(event.pageSize, 10) || PAGE_SIZE_DEFAULT),
    PAGE_SIZE_MAX
  );
  const status = STATUSES.includes(event.status) ? event.status : '';
  const type = REPORT_TYPES.includes(event.type) ? event.type : '';
  const catId = sanitizer.isValidObjectId(event.catId) ? String(event.catId).trim() : '';

  const where = {};
  if (status) {
    where.status = status;
  } else {
    where.status = _.in(STATUSES);
  }
  if (type) where.type = type;
  if (catId) where.catId = catId;

  const [res, countRes] = await Promise.all([
    db.collection(COLLECTIONS.USER_REPORTS)
      .where(where)
      .orderBy('createTime', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    db.collection(COLLECTIONS.USER_REPORTS).where(where).count()
  ]);

  const total = countRes.total || 0;
  return ok({
    items: (res.data || []).map(publicItem),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total
  });
}

async function safeCount(where) {
  try {
    const query = db.collection(COLLECTIONS.USER_REPORTS);
    const res = await (where && Object.keys(where).length ? query.where(where) : query).count();
    return res.total || 0;
  } catch (err) {
    // 集合未建 / 单条统计失败时不要拖垮整张统计卡：
    // 列表仍可正常加载，统计按 0 展示。
    console.warn('[manageReport] 统计查询失败:', err.message || err);
    return 0;
  }
}

function normalizeTopCats(rows) {
  const merged = new Map();

  (rows || []).forEach(row => {
    const id = row._id && row._id.catId || '';
    if (!id) return;
    const name = row._id && row._id.catName || '未知猫咪';
    const count = Number(row.count) || 0;
    const lastAt = row.lastAt || null;
    const prev = merged.get(id);

    if (!prev) {
      merged.set(id, { catId: id, catName: name, count, lastAt });
      return;
    }
    prev.count += count;
    if (new Date(lastAt).getTime() > new Date(prev.lastAt).getTime()) {
      prev.catName = name;
      prev.lastAt = lastAt;
    }
  });

  return Array.from(merged.values())
    .filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, STATS_TOP_CATS);
}

async function getStats() {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * DAY_MS);
  const recentWhere = { createTime: _.gte(since) };

  const totalPromise = safeCount({});
  const statusPromises = STATUSES.map(status => safeCount({ status }));
  const recent7Promise = safeCount({ createTime: _.gte(new Date(Date.now() - 7 * DAY_MS)) });
  const recentPromise = safeCount(recentWhere);
  const typePromises = REPORT_TYPES.map(type => safeCount({ ...recentWhere, type }));

  let topRows = [];
  const topPromise = db.collection(COLLECTIONS.USER_REPORTS)
    .aggregate()
    .match(recentWhere)
    .group({
      _id: { catId: '$catId', catName: '$catName' },
      count: $.sum(1),
      lastAt: $.max('$createTime')
    })
    .sort({ count: -1 })
    .limit(20)
    .end()
    .then(res => {
      topRows = res && res.list || [];
    })
    .catch(err => {
      // 聚合失败只影响「高频猫咪」一块，其余统计照常返回。
      console.warn('[manageReport] 高频猫咪统计失败:', err.message || err);
    });

  const [total, ...statusAndRecent] = await Promise.all([
    totalPromise,
    ...statusPromises,
    recent7Promise,
    recentPromise,
    ...typePromises,
    topPromise
  ]);

  const statusCounts = {
    pending: statusAndRecent[0] || 0,
    resolved: statusAndRecent[1] || 0,
    rejected: statusAndRecent[2] || 0
  };
  const recent7 = statusAndRecent[3] || 0;
  const recent30 = statusAndRecent[4] || 0;
  const typeCounts = statusAndRecent.slice(5, 5 + REPORT_TYPES.length);

  return ok({
    windowDays: STATS_WINDOW_DAYS,
    total,
    status: statusCounts,
    recent: {
      days7: recent7,
      days30: recent30
    },
    byType: REPORT_TYPES.map((type, index) => ({
      type,
      count: typeCounts[index] || 0
    })),
    topCats: normalizeTopCats(topRows)
  });
}

async function getReport(id) {
  if (!sanitizer.isValidObjectId(id)) return null;
  try {
    const found = await db.collection(COLLECTIONS.USER_REPORTS).doc(id).get();
    return found && found.data || null;
  } catch (err) {
    return null;
  }
}

async function notifyReporter(report, status, note) {
  const catName = sanitizer.strict(report.catName || '猫咪', 50);
  const suffix = note ? `（${note}）` : '';
  const content = `关于「${catName}」的反馈：${status === 'resolved' ? '已处理' : '未采纳'}${suffix}`;

  try {
    await db.collection(COLLECTIONS.NOTIFICATIONS).add({
      data: {
        _openid: report._openid,
        type: 'report_result',
        catId: report.catId || '',
        catName,
        catAvatar: report.catAvatar || '',
        content,
        isRead: false,
        createTime: db.serverDate(),
        // 与 statusNotify 同口径：notifications.expireAt 上有 30 天 TTL。
        expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
  } catch (err) {
    console.warn('[manageReport] 反馈结果通知写入失败（非致命）:', err.message || err);
  }
}

async function resolveReport(event, openid) {
  const id = String(event.id || '').trim();
  if (!sanitizer.isValidObjectId(id)) return fail('无效的反馈ID', 'INVALID_ID');

  const status = String(event.status || '').trim();
  if (!RESOLVE_STATUSES.has(status)) return fail('无效的处理结果', 'INVALID_STATUS');

  const note = sanitizer.sanitizeWithEmoji(String(event.note || '').trim(), NOTE_MAX);
  const report = await getReport(id);
  if (!report) return fail('反馈不存在或已删除', 'NOT_FOUND');

  // 已处理过的回执，避免管理端重复点击把结论来回翻、重复通知用户。
  if (RESOLVE_STATUSES.has(report.status)) {
    return ok({
      id,
      status: report.status,
      handleNote: report.handleNote || '',
      alreadyResolved: true
    }, '该反馈已处理');
  }

  try {
    await db.collection(COLLECTIONS.USER_REPORTS).doc(id).update({
      data: {
        status,
        handleNote: note,
        handledBy: openid,
        handledAt: db.serverDate(),
        updateTime: db.serverDate()
      }
    });
  } catch (err) {
    console.error('[manageReport] 更新反馈失败:', err.message || err);
    return fail('处理失败，请稍后重试', 'WRITE_FAILED');
  }

  await notifyReporter(report, status, note);

  await logOperation(db, openid, {
    module: 'userReport',
    action: 'edit',
    result: 'success',
    description: `反馈处理${status === 'resolved' ? '已处理' : '未采纳'}: ${report.catName || ''} ${id}`.trim(),
    afterData: {
      reportId: id,
      status,
      note
    }
  }).catch(err => {
    console.warn('[manageReport] 操作日志写入失败（非致命）:', err.message || err);
  });

  return ok({ id, status, handleNote: note }, status === 'resolved' ? '已标记处理' : '已标记未采纳');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const auth = await checkAdmin(db, OPENID, {
    useCache: false,
    operation: '反馈处理',
    adminAccount: event._adminAccount || '',
    permission: 'report'
  });
  if (!auth.isAdmin) return fail(auth.error || '无权限', 'FORBIDDEN');

  const action = event.action || 'list';
  try {
    if (action === 'list') return await listReports(event);
    if (action === 'stats') return await getStats();
    if (action === 'resolve') return await resolveReport(event, OPENID);
    return fail('未知操作', 'INVALID_ACTION');
  } catch (err) {
    console.error('[manageReport]', action, err.message || err);
    return fail('操作失败，请稍后重试', 'INTERNAL_ERROR');
  }
};
