/**
 * 云函数：filterCats
 * 在服务端进行猫咪筛选，避免客户端全量加载。
 *
 * 入参:
 *   filters: {
 *     keyword?:  string   - 搜索词（匹配 name / color / location）
 *     gender?:   string   - '公' | '母'
 *     color?:    string   - 精确匹配花色
 *     age?:      string   - 精确匹配年龄
 *     campus?:   string   - 精确匹配校区
 *     status?:   string   - 'normal' | 'lost' | 'deceased' | 'adopted' 等
 *     page?:     number   - 页码（从1开始，默认1）
 *     pageSize?: number   - 每页数量（默认20，最大100）
 *   }
 *
 * 出参:
 *   { success, cats: [...], total: number, hasMore: boolean }
 */

const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS, expandColor, getOtherExcludeList, CAT_ADOPT_LEVEL_VALUES } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ========== 内联日志工具（替代 ../utils/logger） ==========
const CloudLogger = {
  log(fn, msg, data) { console.log(`[${fn}] ${msg}`, data || ''); },
  performance(fn, msg, duration) { console.log(`[${fn}] ${msg} ${duration}ms`); }
};
const CloudErrorHandler = {
  handle(fn, err) {
    console.error(`[${fn}] error:`, err);
    return fail('筛选失败，请稍后重试');
  }
};

// ========== 输入校验 ==========

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/**
 * 安全转义正则特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建查询条件
 * @param {Object} filters - 筛选参数
 * @returns {Object} { where, page, pageSize }
 */
function buildQuery(filters = {}) {
  const where = {};
  const page = Math.min(Math.max(1, parseInt(filters.page) || 1), 1000);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(filters.pageSize) || DEFAULT_PAGE_SIZE));

  // 0. 默认查询所有可见状态的猫咪，与客户端 loadAllAndFilter 一致；
  //    调用方显式传 status（白名单校验）时精确匹配该状态（AI 技能「走失的猫」依赖此能力）
  const STATUS_WHITELIST = ['normal', 'lost', 'deceased', 'adopted'];
  const statusFilter = filters.status ? String(filters.status).trim() : '';
  where.status = STATUS_WHITELIST.includes(statusFilter) ? statusFilter : _.in(STATUS_WHITELIST);
  // 删除中的猫咪对列表不可见（deleteData 标记后多步删除，中断时不残留可见数据）
  where._deleting = _.neq(true);

  // 1. 关键词搜索 — 用正则在 name / color / location 中匹配
  if (filters.keyword && filters.keyword.trim()) {
    const escaped = escapeRegex(filters.keyword.trim());
    const regex = { $regex: escaped, $options: 'i' };
    where.$or = [
      { name: regex },
      { color: regex },
      { location: regex }
    ];
  }

  // 2. 精确匹配字段 — 与客户端 filterCats 逻辑一致
  // 强制转为字符串，防止 NoSQL 注入（传入对象改变查询语义）
  if (filters.gender) {
    const gender = String(filters.gender).trim();
    if (gender) where.gender = gender;
  }
  if (filters.color) {
    const color = String(filters.color).trim();
    if (color) {
      if (color === '其他花色') {
        // "其他花色"：排除已知三大类的所有原始变体
        const exclude = getOtherExcludeList();
        where.color = _.nin(exclude);
      } else {
        // 标准分类：展开成所有原始变体做 $in 查询
        const variants = expandColor(color);
        where.color = variants.length === 1 ? variants[0] : _.in(variants);
      }
    }
  }
  if (filters.age) {
    const age = String(filters.age).trim();
    if (age) where.age = age;
  }
  if (filters.campus) {
    const campus = String(filters.campus).trim();
    if (campus) where.campus = campus;
  }

  // 3. 好猫星级（适合家养）：adoptLevelMin = 3/4/5，表示「至少 N 星」（含 N 星本身）。
  // 只接受白名单里的整数：其余值（2、"x"、对象、NaN）一律忽略条件，
  // 而不是把它们当比较值下发 —— 否则筛选语义会随调用方输入漂移。
  // 注意：字段缺失或 0（未评级）的猫咪不会被 gte 命中，这正是「只看适合家养」的口径。
  if (filters.adoptLevelMin !== undefined && filters.adoptLevelMin !== '') {
    const minLevel = Number(filters.adoptLevelMin);
    if (CAT_ADOPT_LEVEL_VALUES.includes(minLevel)) {
      where.adoptLevel = _.gte(minLevel);
    }
  }

  return { where, page, pageSize };
}

// ========== 频率限制（防爬虫） ==========

const RATE_LIMIT_WINDOW = 60 * 1000; // 1分钟窗口
const RATE_LIMIT_MAX = 120; // 每分钟最多120次请求（每秒2次，足够正常使用）

// 简易频率限制：基于内存（云函数实例级别）
const _requestLog = new Map();

function checkRateLimit(openid) {
  // 容量护栏：防止长期驻留实例内存的 key 无上限增长
  if (_requestLog.size > 5000) _requestLog.clear();
  const now = Date.now();
  const records = _requestLog.get(openid);

  if (!records) {
    _requestLog.set(openid, [now]);
    return { allowed: true };
  }

  // 清理过期记录
  const validRecords = records.filter(t => now - t < RATE_LIMIT_WINDOW);
  _requestLog.set(openid, validRecords);

  if (validRecords.length >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((validRecords[0] + RATE_LIMIT_WINDOW - now) / 1000) };
  }

  validRecords.push(now);
  return { allowed: true };
}

/**
 * 取客户端 IP 作为匿名限流键
 *
 * HTTP 触发器下 WXContext.OPENID 为空，若不降级则限流形同虚设。
 * 取不到时返回空字符串（此时跳过限流，避免把正常请求误伤）。
 *
 * @param {object} event - 云函数事件对象（含 HTTP 触发器注入的 headers）
 * @param {object} wxCtx - WXContext（部分环境会把来源 IP 放在这里）
 * @returns {string} 限流键，取不到时为空串
 */
function getClientIp(event, wxCtx) {
  const headers = event && (event.headers || event.header) || {};
  const candidates = [
    headers['x-forwarded-for'],
    headers['X-Forwarded-For'],
    headers['x-real-ip'],
    headers['X-Real-IP'],
    event && event.clientIP,
    wxCtx && (wxCtx.CLIENTIP || wxCtx.clientIP)
  ];

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    // X-Forwarded-For 可能是 "client, proxy1, proxy2"，取第一段
    const ip = raw.split(',')[0].trim();
    if (ip) return `ip:${ip}`;
  }
  return '';
}

// 说明：不在此处使用顶层 setInterval 定时清理。
// 云函数为无状态短生命周期，顶层 setInterval 会随容器常驻且永不清理，
// 属于 Serverless 反模式。过期记录已在 checkRateLimit 中按需清理。
// 注意：_requestLog 为实例级内存，仅作轻量防爬，冷启动即重置（详见审查报告 P3-4）。

// ========== 主函数 ==========

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
  const startTime = Date.now();
  const wxCtx = cloud.getWXContext();
  const openid = wxCtx.OPENID;

  // 频率限制检查
  // 原先写作 `if (openid)`：本函数同时挂了 HTTP 触发器，而 HTTP 调用时
  // WXContext.OPENID 为空 → 限流整段被跳过，筛选接口可被无限制刷。
  // 降级策略：取不到 OPENID 时改用客户端 IP 作为限流键（匿名维度），
  // 保证「无论走哪种触发器都有限流」，IP 缺失才退回不记（无法定位调用方）。
  const rateLimitKey = openid || getClientIp(event, wxCtx);
  if (rateLimitKey) {
    const rateCheck = checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return fail(`请求过于频繁，请 ${rateCheck.retryAfter} 秒后重试`, 'RATE_LIMITED');
    }
  }

  try {
    const { where, page, pageSize } = buildQuery(event.filters || {});

    CloudLogger.log('filterCats', '开始查询', { filters: event.filters, page, pageSize });

    // 并行获取：总数 + 当前页数据
    const [countRes, catsRes] = await Promise.all([
      db.collection(COLLECTIONS.CATS).where(where).count(),
      db.collection(COLLECTIONS.CATS)
        .where(where)
        // 列表排序：按 listSort 降序（在校+走失 → 离世 → 领养垫底，见 utils/listSort.js）。
        // 原先按 updateTime 排：改状态/编辑会把猫顶到最前，与被领养「沉底」的口径相反。
        .orderBy('listSort', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get()
    ]);

    const total = countRes.total || 0;
    // 与 getCatDetail / getCatsByIds / getShareData 同因：本函数无鉴权（不 require auth.js）
    // 且整文档下发，而存量 cats 文档带着管理员建档时写入的 _openid。
    // 该字段全端零引用、无任何按 cats._openid 的查询，剔除无副作用。
    const cats = (catsRes.data || []).map((cat) => {
      // 与 getCatDetail / getCatsByIds / getShareData 同口径：整文档下发时逐条剔除内部字段。
      // where 已滤 _deleting≠true，但剔除动作不依赖调用方自觉（存量脏数据、后续改动都可能带出标记）。
      delete cat._openid;
      delete cat._deleting;
      delete cat._deleteStartTime;
      return cat;
    });
    const hasMore = (page - 1) * pageSize + cats.length < total;

    const duration = Date.now() - startTime;
    CloudLogger.performance('filterCats', '查询完成', duration);

    return ok({
      cats,
      total,
      page,
      pageSize,
      hasMore
    });
  } catch (err) {
    return CloudErrorHandler.handle('filterCats', err);
  }
};
