/**
 * cloudfunctions/getCatActivity/analysis.js - 猫咪行动分析的纯计算层
 *
 * 为什么拆出来：时段/星期/标签/地点/聚类/离散度六类统计如果都留在入口文件里，
 * main 会变成几百行且无法单独喂样例数据。这里全部是**无副作用的纯函数**，
 * index.js 只负责鉴权、扫库与组装；测试也可以直接对着一组假记录断言结论。
 *
 * 坐标口径：u/v 都是 0~1 的归一化坐标（定义见 utils/mapPoint.js）。
 * 聚类与离散度都在 uv 空间里算——底图两个轴的分母不同（1580×840），
 * uv 欧氏距离是「地图上相对位置」的近似，判断「食堂门口还是教学楼附近」
 * 这个量级足够，不追求像素级精确。
 *
 * 时间口径：容器时区是 UTC，凡是把时间戳折成「第几小时 / 星期几 / 哪一天」
 * 都必须走 beijingTime 的北京时间换算，否则 0:00-8:00 的打卡全部错位。
 */
const { toBeijingDate, beijingDayKey } = require('./utils/beijingTime');
const { isValidPoint } = require('./utils/mapPoint');

// 分析口径常量：改指标就是改这里，index.js 不再散落魔法数
const LIMITS = {
  maxScanRows: 5000,   // 单次分析的扫描硬顶（游标分页在 index.js）
  maxPoints: 1500,     // 回给地图的点位上限，超出时保留**最近**的（见 pickPoints 的说明）
  clusterGrid: 24,     // 聚类网格：把 uv 空间切成 24×24 格
  minCluster: 3,       // 少于 3 次打卡不成「聚集圈」——2 个点是巧合，不是常驻点
  topClusters: 5,
  topTags: 6,
  topLocations: 8,
  recent: 20,          // 轨迹时间线回传的最近记录条数

  // —— 总轨迹模式（scope='all'）专用：与单猫口径分开，互不影响 ——
  maxScanRowsAll: 10000, // 总览一次要覆盖全站打卡，扫描硬顶比单猫高一档（游标倒序，截断时保住最近的一段）
  maxTrailPoints: 200,   // 总轨迹图上单只猫的点位上限，超出保留最近（避免一只高活跃猫挤掉别人）
  maxTrailCats: 60       // 总轨迹图最多画多少只猫（按最近出现取前 N，其余用 catsTruncated 明示）
};

/**
 * 时段分段（展示顺序即数组顺序）。
 * 深夜跨 0 点单独成段：猫的作息里凌晨和白天是两种状态，混进「清晨」会稀释信号。
 */
const BLOCKS = [
  { key: 'dawn', label: '清晨', range: '05:00-08:00' },
  { key: 'morning', label: '上午', range: '08:00-12:00' },
  { key: 'afternoon', label: '下午', range: '12:00-17:00' },
  { key: 'dusk', label: '傍晚', range: '17:00-19:00' },
  { key: 'evening', label: '晚上', range: '19:00-23:00' },
  { key: 'night', label: '深夜', range: '23:00-05:00' }
];

/** 打卡时点 → 时段 key（北京时间） */
function blockOf(ts) {
  const h = toBeijingDate(ts).getUTCHours();
  if (h < 5) return 'night';
  if (h < 8) return 'dawn';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 19) return 'dusk';
  if (h < 23) return 'evening';
  return 'night';
}

/** 打卡时点 → 星期（1=周一 … 7=周日，北京时间） */
function weekdayOf(ts) {
  const d = toBeijingDate(ts).getUTCDay();
  return d === 0 ? 7 : d;
}

// 没填具体位置时客户端回传的兜底值（recordMeet/index.js:354）。
// 它不是「地点」，是「没填」的同义词 —— 不进地点榜，只计入脚注的样本说明。
// '校园里' 是历史口径，'校园内' 是现口径；统计时两者必须一起归为「没填」，
// 否则老数据会突然冒出一个叫「校园里」的地点。
const DEFAULT_LOCATIONS = ['校园里', '校园内'];
const isDefaultLocation = (loc) => DEFAULT_LOCATIONS.indexOf(loc) >= 0;

/** 地点归一化：压缩空白、去首尾空格，上限 40 字（写入侧上限 100，展示没必要那么长） */
function normalizeLocation(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40);
}

// 历史数据可能带 emoji 前缀（'😺 相遇了'）、旧版措辞（'遇见了'），统计前统一剥掉/归并，
// 否则同一个含义会被拆成两行（口径与 utils/statusTag.js 的 EMOJI_PREFIX_RE 一致）。
// 这里刻意**不写字面 emoji**：图标门禁（scripts/check-ui-emoji.js）会拦下源码里的
// emoji 字符，而码位区间能等价覆盖老数据里的那几个前缀（1F300 段见 misc symbols 与
// 表情符号区，变体选择符单列在类外——ESLint 的 no-misleading-character-class 不允许
// 把组合类字符写进字符类）。
const TAG_EMOJI_RE = /^[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]+\u{FE0F}?\s*/u;
const TAG_ALIAS = { '遇见了': '相遇了' };

/** 状态标签归一化：剥 emoji 前缀、合并旧措辞、压缩空白 */
function normalizeTag(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(TAG_EMOJI_RE, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return TAG_ALIAS[text] || text;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * 计数器 → 降序榜单。
 * 次数相同按首次出现顺序（Map 的插入序），保证同样的数据两次跑出同样的结果 ——
 * 分析类页面最怕「刷新一下顺序就变了」。
 */
function rankList(counter, limit, base) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text, count]) => ({
      text,
      count,
      ratio: base > 0 ? Math.round(count / base * 1000) / 1000 : 0
    }));
}

/**
 * 点位采样：超过上限时保留**最近**的 maxPoints 个。
 *
 * 保留最新而不是等距抽样：这张图用来回答「它最近都去哪」，老点位的
 * 参考价值低 —— 与「最近一次」标记、新旧渐变的口径一致。
 */
function pickPoints(points, limit = LIMITS.maxPoints) {
  if (points.length <= limit) return { items: points, sampled: false };
  return { items: points.slice(points.length - limit), sampled: true };
}

/**
 * 网格聚类：把打卡点聚成「常驻区域」。
 *
 * 为什么不用全量距离聚类（DBSCAN 之类）：点数最多几千，格子法一遍扫完就够，
 * 且行为完全确定（同样输入必得同样分组），不做参数调优。相邻 8 格的格内点
 * 用并查集连通 —— 斜着连成一片的位置（食堂门口到旁边小路）会合成一个区域，
 * 而隔着半张校园的两簇永远合不上。
 */
function clusterPoints(points) {
  if (!points.length) return [];
  const G = LIMITS.clusterGrid;
  const cells = new Map();
  const cellKey = (u, v) => `${Math.min(G - 1, Math.floor(u * G))}_${Math.min(G - 1, Math.floor(v * G))}`;

  points.forEach((p, i) => {
    const k = cellKey(p.u, p.v);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });

  const parent = points.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const [key, idxs] of cells) {
    const [gx, gy] = key.split('_').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nb = cells.get(`${gx + dx}_${gy + dy}`);
        if (!nb) continue;
        // 只需连到邻格首个点：并查集传递性会把两格全部成员连起来
        for (const i of idxs) union(i, nb[0]);
      }
    }
  }

  const groups = new Map();
  points.forEach((p, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  });

  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < LIMITS.minCluster) continue;
    const u = members.reduce((s, p) => s + p.u, 0) / members.length;
    const v = members.reduce((s, p) => s + p.v, 0) / members.length;
    let radius = 0;
    for (const m of members) radius = Math.max(radius, Math.hypot(m.u - u, m.v - v));
    clusters.push({ u: round4(u), v: round4(v), count: members.length, radius: round4(radius) });
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters.slice(0, LIMITS.topClusters);
}

/**
 * 活动离散度：重心 + 到重心的 90 分位距离。
 * 取 p90 而不是最大值：一次「跑去校门口」的偶发打卡不该把「活动范围很集中」
 * 的结论翻成「范围很广」。返回值交给客户端翻译成文案（口径要在页面上好调）。
 */
function spreadOf(points) {
  if (!points.length) return null;
  const cu = points.reduce((s, p) => s + p.u, 0) / points.length;
  const cv = points.reduce((s, p) => s + p.v, 0) / points.length;
  const dists = points.map((p) => Math.hypot(p.u - cu, p.v - cv)).sort((a, b) => a - b);
  const idx = Math.min(dists.length - 1, Math.floor(dists.length * 0.9));
  return { centroid: { u: round4(cu), v: round4(cv) }, p90: round4(dists[idx]) };
}

/**
 * 主入口：一组相遇记录 → 分析结果。
 *
 * @param {Array<{meetTime:number, location?:string, statusTag?:string, point?:object}>} records
 * @returns {object} 见下方 return（index.js 直接展开进响应体）
 */
function analyze(records) {
  const list = Array.isArray(records) ? records : [];

  // 时间升序：点位轨迹、最近一次、recent 都依赖顺序。5000 条上限内排序成本可忽略。
  const sorted = list
    .filter((r) => r && typeof r.meetTime === 'number')
    .sort((a, b) => a.meetTime - b.meetTime);

  const blockCounter = new Map();
  const weekCounter = new Map();
  const tagCounter = new Map();
  const locationCounter = new Map();
  const daySet = new Set();
  const points = [];
  let withLocation = 0;   // 填了「具体地点」的条数（不含默认「校园内 / 校园里」）
  let withTag = 0;
  let defaultLocation = 0;

  for (const r of sorted) {
    blockCounter.set(blockOf(r.meetTime), (blockCounter.get(blockOf(r.meetTime)) || 0) + 1);
    weekCounter.set(weekdayOf(r.meetTime), (weekCounter.get(weekdayOf(r.meetTime)) || 0) + 1);
    daySet.add(beijingDayKey(r.meetTime));

    const tag = normalizeTag(r.statusTag);
    if (tag) {
      withTag++;
      tagCounter.set(tag, (tagCounter.get(tag) || 0) + 1);
    }

    const loc = normalizeLocation(r.location);
    if (loc && !isDefaultLocation(loc)) {
      withLocation++;
      locationCounter.set(loc, (locationCounter.get(loc) || 0) + 1);
    } else if (isDefaultLocation(loc)) {
      defaultLocation++;
    }

    if (isValidPoint(r.point)) {
      points.push({ u: round4(r.point.u), v: round4(r.point.v), t: r.meetTime });
    }
  }

  const meets = sorted.length;
  // 点位按时间升序（上面 sorted 已是升序，push 序即时间序）；
  // recent 需要「最近在前」，故取尾部再反转
  const picked = pickPoints(points);
  const recent = sorted.slice(-LIMITS.recent).reverse().map((r) => ({
    t: r.meetTime,
    location: normalizeLocation(r.location),
    tag: normalizeTag(r.statusTag),
    u: isValidPoint(r.point) ? round4(r.point.u) : null,
    v: isValidPoint(r.point) ? round4(r.point.v) : null
  }));

  return {
    totals: {
      meets,
      withLocation,
      withPoint: points.length,
      withTag,
      defaultLocation,
      activeDays: daySet.size,
      firstTime: meets ? sorted[0].meetTime : 0,
      lastTime: meets ? sorted[meets - 1].meetTime : 0
    },
    blocks: BLOCKS.map((b) => ({
      key: b.key,
      label: b.label,
      range: b.range,
      count: blockCounter.get(b.key) || 0
    })),
    // 固定 7 项（周一 → 周日），缺的补 0 —— 页面不用再对空值做特判
    weekdays: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, count: weekCounter.get(d) || 0 })),
    tags: rankList(tagCounter, LIMITS.topTags, meets),
    locations: rankList(locationCounter, LIMITS.topLocations, meets),
    points: {
      total: points.length,
      sampled: picked.sampled,
      items: picked.items
    },
    clusters: clusterPoints(points),
    spread: spreadOf(points),
    // 「最近一次」单独给：points 被采样截断时它也必须是最新的那一个
    lastPoint: points.length ? points[points.length - 1] : null,
    recent
  };
}

/**
 * 总轨迹模式：一次全站扫描的记录 → 每只猫的点位轨迹。
 *
 * 与单猫 analyze 的分工：这里**不做**时段/标签/地点/聚类统计（总览图只要
 * 地图与路线），只回答「哪只猫、最近去过哪、路线长什么样」。每只猫的点位
 * 单独按 maxTrailPoints 截断，避免一只高活跃猫把其他猫挤下画布。
 *
 * @param {Array<{catId?:string, meetTime:number, point?:object}>} records
 * @returns {{cats: Array<{id:string, meets:number, pointTotal:number, sampled:boolean,
 *            lastMeetTime:number, points:Array<{u:number,v:number,t:number}>}>, totals: object}}
 */
function analyzeTrails(records) {
  const list = Array.isArray(records) ? records : [];
  const byCat = new Map();
  let meets = 0;

  for (const r of list) {
    if (!r || typeof r.meetTime !== 'number') continue;
    const catId = typeof r.catId === 'string' ? r.catId : '';
    if (!catId) continue;
    meets++;
    let entry = byCat.get(catId);
    if (!entry) {
      entry = { points: [], meets: 0, lastTime: 0 };
      byCat.set(catId, entry);
    }
    entry.meets++;
    if (r.meetTime > entry.lastTime) entry.lastTime = r.meetTime;
    if (isValidPoint(r.point)) {
      entry.points.push({ u: round4(r.point.u), v: round4(r.point.v), t: r.meetTime });
    }
  }

  const cats = [];
  for (const [id, entry] of byCat) {
    // 没有点位就画不上图 —— 不是本图的对象（其打卡只计入 totals.meets）
    if (!entry.points.length) continue;
    entry.points.sort((a, b) => a.t - b.t);
    const picked = pickPoints(entry.points, LIMITS.maxTrailPoints);
    cats.push({
      id,
      meets: entry.meets,
      pointTotal: entry.points.length,
      sampled: picked.sampled,
      lastMeetTime: entry.lastTime,
      points: picked.items
    });
  }

  // 最近活跃的排前：截断时留下的也是它们。
  // 并列键用点位数与 id 兜底 —— 不兜底就会出现「刷新一下顺序就变」。
  cats.sort((a, b) =>
    b.lastMeetTime - a.lastMeetTime ||
    b.pointTotal - a.pointTotal ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const catsTotal = cats.length;
  const kept = cats.length > LIMITS.maxTrailCats ? cats.slice(0, LIMITS.maxTrailCats) : cats;

  return {
    cats: kept,
    totals: {
      meets,
      cats: catsTotal,
      points: cats.reduce((s, c) => s + c.pointTotal, 0),
      catsTruncated: catsTotal > kept.length
    }
  };
}

module.exports = {
  analyze,
  analyzeTrails,
  LIMITS,
  BLOCKS,
  DEFAULT_LOCATIONS,
  isDefaultLocation,
  blockOf,
  weekdayOf,
  normalizeLocation,
  normalizeTag,
  clusterPoints,
  spreadOf,
  pickPoints
};
