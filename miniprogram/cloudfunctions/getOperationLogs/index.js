// cloudfunctions/getOperationLogs/index.js - 获取操作日志列表（管理员权限校验）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { COLLECTIONS } = require('./utils/constants');
const { toBeijingDate, BEIJING_OFFSET_MS } = require('./utils/beijingTime');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
// 聚合指令挂在 db.command.aggregate 上，db.command 本身没有 sum（照 getCatRank 写法）
const $ = db.command.aggregate;

const MODULES = ['cat', 'photo', 'mediaCheck', 'notice', 'health', 'admin', 'export', 'system'];
// 必须与各云函数实际写入 operationLogger 的 action 枚举一致：
// 除常规增删改导入导出登录外，fixRecordOpenid 写 'fix_record_openid'、
// exportData 写 'export_data'。两者原先都不在白名单里，传入时会静默取消过滤并返回全量日志。
const ACTIONS = ['create', 'edit', 'delete', 'import', 'export', 'login', 'logout', 'fix_record_openid', 'export_data'];
const RESULTS = ['success', 'fail'];
const COLLECTION_NOT_EXIST_CODE = -502005;
// 模块统计的分组上限：显式 limit 是硬要求（云函数端聚合缺省只回 20 条且不报错），
// 模块数量远小于 20，取 100 留足余量并在触顶时留日志。
const MODULE_STATS_LIMIT = 100;

/**
 * 将筛选用的日期值按「北京时间自然日」解析为起止毫秒时间戳。
 *
 * 云函数容器时区为 UTC：new Date('2026-09-15') 得到的是 UTC 0 点（=北京时间 8 点），
 * setHours(23,59,59,999) 也会按 UTC 收尾，会把北京时间 00:00-08:00 的日志整段漏掉、
 * 并把次日凌晨的日志错误并入。故统一按东八区换算（中国无夏令时，固定偏移安全）。
 *
 * @param {string|number|Date} value - 日期值，通常为 'YYYY-MM-DD'
 * @returns {{ start: number, end: number }|null} 当日 [0点, 23:59:59.999] 的时间戳
 */
function beijingDayRange(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;

  const bj = toBeijingDate(d);
  const y = bj.getUTCFullYear();
  const m = bj.getUTCMonth();
  const day = bj.getUTCDate();

  return {
    start: Date.UTC(y, m, day) - BEIJING_OFFSET_MS,
    end: Date.UTC(y, m, day + 1) - BEIJING_OFFSET_MS - 1
  };
}

/**
 * 按过滤条件构建 where 查询条件
 *
 * @returns {{ok: true, where: object}|{ok: false, error: string}}
 *   非法枚举值时返回 `{ok:false, error}`。
 *
 * 这里**不能**直接 `return fail('...')`：fail() 返回的是响应对象，
 * 原实现在此处 return fail()，调用点却把返回值当where 塞进 `.where()`，
 * 于是非法筛选变成「匹配不到任何文档」→ 接口返回 success:true + 空列表 +
 * total:0。这恰恰是本函数注释里要避免的「静默误导性输出」的另一种形态 ——
 * 校验写了，却被调用点丢弃，退化成另一种更隐蔽的误导。
 * 故用ok/error 双态返回，由调用点显式判别。
 */
function buildWhereClause({ adminAccount, startTime, endTime, module, action, result, keyword }) {
  const where = {};

  const invalid = (error) => ({ ok: false, error });

  if (adminAccount) {
    where.adminAccount = adminAccount.trim();
  }

  if (startTime || endTime) {
    const startRange = startTime ? beijingDayRange(startTime) : null;
    const endRange = endTime ? beijingDayRange(endTime) : null;

    if (startRange && endRange) {
      where.operateTime = _.and(_.gte(new Date(startRange.start)), _.lte(new Date(endRange.end)));
    } else if (startRange) {
      where.operateTime = _.gte(new Date(startRange.start));
    } else if (endRange) {
      where.operateTime = _.lte(new Date(endRange.end));
    }
  }

  // 筛选值非法时**必须报错**，不能静默忽略：
  // 原实现写作 `if (action && ACTIONS.includes(action))`，传入枚举外的值
  // （如 fixRecordOpenid 实际写入的 'fix_record_openid'）时 where.action 根本不被设置，
  // 接口返回**全量日志**且 total 也是全量数 —— 管理员在界面上看到的是
  // 「按该条件筛选的结果」，实际是全部记录，审计场景下属误导性输出。
  if (module && !MODULES.includes(module)) {
    return invalid('无效的模块筛选条件');
  }
  if (action && !ACTIONS.includes(action)) {
    return invalid('无效的操作类型筛选条件');
  }
  if (result && !RESULTS.includes(result)) {
    return invalid('无效的结果筛选条件');
  }

  if (module) {
    where.module = module;
  }

  if (action) {
    where.action = action;
  }

  if (result) {
    where.result = result;
  }

  if (keyword) {
    where.description = db.RegExp({
      regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      options: 'i'
    });
  }

  return { ok: true, where };
}

/**
 * 查询各模块操作次数统计（失败不阻断主流程）
 *
 * 两处曾静默给错答案（2026-10-12 修）：
 *   1. 结果取的是 `moduleStats.data` —— 聚合 `end()` 返回的是 **`list`**，
 *      于是 `for (const s of undefined || [])` 一次都不进，**各模块计数恒为空**，
 *      而 `stats` 空对象又会一路返给管理端（没有报错、没有日志，只有空数字）。
 *   2. 分组没有显式 `.limit()` —— 云函数端聚合缺省只回 20 条且不报错
 *      （同一批次的相册计数就是被它打成「0 张」的，见 utils/photoCounts.js）。
 *      模块数量当前远小于 20，但口径必须一致，否则新增模块时同样静默丢数。
 *
 * @returns {Promise<object>} module -> count
 */
async function fetchModuleStats() {
  const stats = {};
  try {
    const moduleStats = await db.collection(COLLECTIONS.OPERATION_LOGS)
      .aggregate()
      .group({
        _id: '$module',
        count: $.sum(1)
      })
      .limit(MODULE_STATS_LIMIT)
      .end();

    const rows = moduleStats && moduleStats.list || [];
    for (const s of rows) {
      if (!s || s._id === undefined || s._id === null) continue;
      stats[s._id] = s.count;
    }

    // 命中上限说明分组被截断（模块数 ≥ 上限）：日志留痕，别让计数悄悄少几项
    if (rows.length >= MODULE_STATS_LIMIT) {
      console.warn('[getOperationLogs] 模块统计触及 limit 上限，结果可能被截断:', {
        limit: MODULE_STATS_LIMIT,
        rows: rows.length
      });
    }
  } catch (statsErr) {
    console.warn('[getOperationLogs] 统计查询失败:', statsErr.message);
  }
  return stats;
}

/**
 * 构造分页查询的空结果响应（集合不存在时使用）
 */
function emptyResult(page, pageSize, collectionNotExists = false) {
  const result = {
    logs: [],
    total: 0,
    page,
    pageSize,
    hasMore: false,
    stats: {}
  };
  if (collectionNotExists) {
    result.collectionNotExists = true;
  }
  return result;
}

exports.main = async (event) => {
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
  const { OPENID } = cloud.getWXContext();
  const authResult = await checkAdmin(db, OPENID, {
    operation: '查看操作日志',
    adminAccount: event._adminAccount || '',
    permission: 'logs'
  });
  if (!authResult.isAdmin) return fail(authResult.error);

  // 操作日志含全体管理员的操作明细（账号、描述、before/after 数据）。
  // 入口权限由 checkAdmin({ permission: 'logs' }) 统一裁决：
  // 超管恒通过，普通管理员必须在「管理员管理 → 权限」里显式开通「操作日志」。

  const {
    page = 1,
    pageSize = 20,
    adminAccount,
    startTime,
    endTime,
    module,
    action,
    result,
    keyword
  } = event;

  const safePage = Math.max(1, parseInt(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, parseInt(pageSize) || 20));

  try {
    const clause = buildWhereClause({ adminAccount, startTime, endTime, module, action, result, keyword });
    // 非法筛选值必须报错返回，绝不能让它降级成 where 条件
    if (!clause.ok) return fail(clause.error);
    const where = clause.where;

    const [countRes, listRes] = await Promise.all([
      db.collection(COLLECTIONS.OPERATION_LOGS).where(where).count(),
      db.collection(COLLECTIONS.OPERATION_LOGS)
        .where(where)
        .orderBy('operateTime', 'desc')
        .skip((safePage - 1) * safePageSize)
        .limit(safePageSize)
        .get()
    ]);

    const total = countRes.total || 0;
    const logs = (listRes.data || []).map(item => ({
      ...item,
      operateTime: item.operateTime,
      timeStr: formatTime(item.operateTime)
    }));

    const stats = await fetchModuleStats();

    console.log(`[getOperationLogs] 查询完成: ${logs.length}条, 共${total}条`);

    return ok({
      logs,
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: safePage * safePageSize < total,
      stats
    });

  } catch (err) {
    if (err.errCode === COLLECTION_NOT_EXIST_CODE || err.message && err.message.includes('collection not exists')) {
      console.warn('[getOperationLogs] operation_logs 集合不存在，返回空数据');
      return ok(emptyResult(safePage, safePageSize, true));
    }
    console.error('[getOperationLogs] 失败:', err);
    return fail('查询失败，请重试');
  }
};

function formatTime(date) {
  if (!date) return '';
  const ts = new Date(date).getTime();
  if (isNaN(ts)) return '';
  // 容器为 UTC 时区，用本地方法读会少 8 小时，须按北京时间读取「墙上时间」
  const d = toBeijingDate(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}
