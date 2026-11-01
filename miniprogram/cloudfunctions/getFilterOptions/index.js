// cloudfunctions/getFilterOptions/index.js - 首页筛选选项与统计（颜色集合 + 照片总数）
// 替代客户端直连数据库分页扫描（原 _loadAllColorOptions / loadPhotoCount）
//
// 本函数无鉴权（首页每次进入都要调），原先无缓存无限流：
//   每次调用都要分页遍历 cats 集合把 color 收成去重集合（只取 color 单字段，
//   但仍是全表扫描）。首页是最高频入口，用户来回切 tab 就重复触发一次。
//   现加内存 TTL 缓存把数据库 QPS 压到 1/TTL，并补 IP 降级限流。
//   注：颜色集合无法像 donations 那样聚合下推（需要 distinct 全量取值），
//   故这里只做缓存与限流，不改查询方式。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS, ALLOWED_STATUS, normalizeColor, COLOR_DISPLAY_ORDER } = require('./utils/constants');
const CloudCache = require('./utils/cache');
const { CloudLogger } = require('./utils/logger');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const BATCH_SIZE = 100;
// 猫咪数硬顶：与 color 的去重基数无关（只需扫到 MAX_SCAN 行），
// 超过即停止并在返回值里标记 truncated，让调用方知道花色集合不完整。
// 原来无上限遍历到集合末尾，在云函数 256MB 内存与默认超时下有跑满风险
//（冷缓存那次调用仍会全量扫描，缓存只压 QPS 不压单次成本）。
const MAX_SCAN = 5000;
const CACHE_TTL = 120;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW = 60 * 1000;

exports.main = async (event, _context) => {
  try {
    const rateLimitKey = cloud.getWXContext().OPENID || getClientIp(event);
    if (rateLimitKey && !checkRateLimit(rateLimitKey).ok) {
      return fail('请求过于频繁，请稍后再试');
    }

    const options = await CloudCache.getOrSet('filter:options', loadOptions, CACHE_TTL);
    return ok(options);
  } catch (err) {
    console.error('[getFilterOptions] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};

async function loadOptions() {
  // 1. 收集全部合法状态的猫咪颜色
  //
  // 用**游标分页**（_id > lastId）而非 skip 递增：
  //   - skip 分页在无 orderBy 时顺序不稳定，会漏采/重采
  //   - skip 随偏移量线性变慢，深分页打满数据库配额
  //   - 游标依赖 _id 递增，故必须显式 orderBy('_id','asc')，否则游标同样失序
  const allColors = new Set();
  // 与 allColors 同一遍扫描累加：花色 → 合法状态猫咪数。
  // 前端筛选面板用它给选项带计数，并置灰 0 只的花色（避免选出必然为空的结果）。
  // MAX_SCAN 截断时计数是下界（偏小），方向安全 —— 只会少显示不会多显示。
  const colorCounts = {};
  let lastId = null;
  let scanned = 0;
  let truncated = false;

  // 照片总数与猫咪花色扫描相互独立；提前启动计数，避免冷缓存时两段查询串行等待。
  // 将 rejection 转为结果对象，确保即使花色扫描先失败，计数 Promise 也已有 rejection handler。
  const photoCountPromise = db.collection(COLLECTIONS.PHOTOS).count()
    .then(result => ({ result }), error => ({ error }));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 游标条件必须与原条件合并进同一个 where 对象：Query.where() 是整体替换
    // 而不是合并（与 getMeetCalendar.getAllRecords 同因）。第二页若独立链
    // .where({_id: _.gt(lastId)})，status 过滤会被静默丢弃，非法/不可见状态的
    // 猫咪颜色会混进筛选选项。
    const condition = lastId
      ? { status: _.in(ALLOWED_STATUS), _id: _.gt(lastId) }
      : { status: _.in(ALLOWED_STATUS) };
    const query = db.collection(COLLECTIONS.CATS)
      .where(condition)
      .field({ _id: true, color: true })
      .orderBy('_id', 'asc')
      .limit(BATCH_SIZE);

    const res = await query.get();
    if (!res.data || res.data.length === 0) break;

    res.data.forEach(cat => {
      const raw = (cat.color || '').trim();
      if (!raw) return;
      const std = normalizeColor(raw);
      allColors.add(std);
      colorCounts[std] = (colorCounts[std] || 0) + 1;
    });

    scanned += res.data.length;
    lastId = res.data[res.data.length - 1]._id;

    if (res.data.length < BATCH_SIZE) break;
    if (scanned >= MAX_SCAN) {
      truncated = true;
      CloudLogger.warn('getFilterOptions', `花色扫描达上限 ${MAX_SCAN} 只，集合可能不完整`);
      break;
    }
  }

  // 2. 取回并检查并发启动的照片总数查询
  const photoCountOutcome = await photoCountPromise;
  if (photoCountOutcome.error) throw photoCountOutcome.error;
  const photoCountRes = photoCountOutcome.result;

  // 3. 按展示顺序输出 4 大分类，计数已在扫描时归一化合并
  const orderedColors = COLOR_DISPLAY_ORDER.filter(c => (colorCounts[c] || 0) > 0);
  const orderedCounts = {};
  orderedColors.forEach(c => { orderedCounts[c] = colorCounts[c] || 0; });

  return {
    colors: orderedColors,
    colorCounts: orderedCounts,
    totalPhotos: photoCountRes.total || 0,
    ...truncated ? { colorsTruncated: true } : {}
  };
}

/**
 * 取客户端 IP 作为限流键。HTTP 触发器下 WXContext.OPENID 恒为空，
 * 若不降级则限流整段被跳过（口径同 filterCats / getPublicDonations）。
 */
function getClientIp(event) {
  const headers = event && (event.headers || event.header) || {};
  const forwardedFor = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const realIp = headers['x-real-ip'] || headers['X-Real-IP'] || '';
  const ip = String(forwardedFor || realIp || '').split(',')[0].trim();
  if (ip) return ip;
  const wxCtx = cloud.getWXContext();
  return wxCtx.CLIENTIP || wxCtx.CLIENT_IP || '';
}

// 限流计数表。Serverless 反模式（实例内存随回收而失、多实例各算各的），
// 仅作廉价兜底；真正的保护来自上面的缓存。
const rateLimitBuckets = new Map();

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW) {
    rateLimitBuckets.set(key, { start: now, count: 1 });
    pruneRateLimit(now);
    return { ok: true };
  }
  bucket.count++;
  return { ok: bucket.count <= RATE_LIMIT_MAX };
}

function pruneRateLimit(now) {
  if (rateLimitBuckets.size < 1000) return;
  for (const [key, value] of rateLimitBuckets) {
    if (now - value.start >= RATE_LIMIT_WINDOW) {
      rateLimitBuckets.delete(key);
    }
  }
}
