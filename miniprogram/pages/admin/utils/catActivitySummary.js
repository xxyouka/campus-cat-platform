/**
 * pages/admin/utils/catActivitySummary.js - 猫咪行动分析的展示层装配（纯函数）
 *
 * 把 getCatActivity 的原始统计翻译成页面上的「人话」：结论句、离散度文案、
 * 聚集圈命名/合并、星期与时间格式、数据脚注。所有函数无副作用、无 wx 依赖，
 * 口径（阈值与文案）全部集中在这里 —— 改文案不用翻 wxml，测试也只需喂数据。
 */

/** 显示顺序固定为服务端 BLOCKS 的顺序（清晨→深夜），不要依赖数据里的顺序 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 时间窗文案：days=0 表示全部 */
function rangeText(days) {
  return days > 0 ? `近${days}天` : '全部记录';
}

/**
 * 活动离散度 → 文案。阈值按 uv 单位的 p90 距离定：
 * 0.06 ≈ 校园宽度的 6%（几个相邻建筑内打转），0.25 ≈ 四分之一张地图。
 * 样本不足时（score 为 null）不评价 —— 由页面决定提示方式。
 */
function spreadLabel(p90) {
  if (typeof p90 !== 'number' || !isFinite(p90)) return '';
  if (p90 <= 0.06) return '活动范围很集中';
  if (p90 <= 0.14) return '活动范围比较集中';
  if (p90 <= 0.25) return '活动范围比较大';
  return '活动范围很广';
}

/** 次数最多的时段；并列取展示顺序靠前者，全为 0 返回 null（结果必须稳定） */
function topBlock(blocks) {
  let best = null;
  for (const b of blocks || []) {
    if (!b || !b.count) continue;
    if (!best || b.count > best.count) best = b;
  }
  return best;
}

/** 次数最多的状态标签；并列取先出现者 */
function topTag(tags) {
  let best = null;
  for (const t of tags || []) {
    if (!t || !t.count) continue;
    if (!best || t.count > best.count) best = t;
  }
  return best;
}

/**
 * 一句话结论：把已有信息拼成人话，缺哪块就少一句，不硬凑。
 * 例：「近90天相遇 23 次，出现在 18 天里，多在傍晚出没，最多的相遇场景是「在睡觉」，
 *      常出现在「食堂旁」，活动范围比较集中。」
 */
function buildConclusion({
  rangeDays = 0, totals = {}, blocks = [], tags = [], locations = [], spreadP90 = null
} = {}) {
  const meets = totals.meets || 0;
  if (!meets) return '';

  const parts = [];
  const activeDays = totals.activeDays || 0;
  parts.push(`${rangeText(rangeDays)}相遇 ${meets} 次${activeDays > 1 ? `，出现在 ${activeDays} 天里` : ''}`);

  const tb = topBlock(blocks);
  if (tb) parts.push(`多在${tb.label}出没`);

  const tt = topTag(tags);
  // 「相遇了」是默认标签（没特别选），放进去等于没说；自定义/其他标签才值得点名
  if (tt && tt.text && tt.text !== '相遇了' && tt.count >= 2) {
    parts.push(`最多的相遇场景是「${tt.text}」`);
  }

  const tl = (locations || [])[0];
  if (tl && tl.text) parts.push(`常出现在「${tl.text}」`);

  const sp = spreadLabel(spreadP90);
  // 点位少于 3 个时不说「范围集中/分散」——一两个点看不出任何范围
  if (sp && (totals.withPoint || 0) >= 3) parts.push(sp);

  return parts.join('，') + '。';
}

/**
 * 聚集圈的展示层合并：**同一地物名**的圈合成一条。
 *
 * 网格聚类可能把同一个「食堂」分成两簇（隔着一格互不相邻），地图上两个圈
 * 都标「食堂一带」、文字列表也两行同名，看着像 bug。合并后按次数加权取中心、
 * 半径取最大，语义仍是「食堂一带共 N 次」。无名圈不合并 —— 它们可能相隔很远，
 * 强行合并等于编造位置。
 *
 * @param {Array<{u:number,v:number,count:number,radius?:number}>} clusters 服务端原始聚类
 * @param {(u:number,v:number)=>string} nameOf 中心点 → 最近地物名（'' 表示无名）
 * @returns {Array<{name:string,label:string,count:number,u:number,v:number,radius:number}>}
 */
function mergeNamedClusters(clusters, nameOf) {
  const named = new Map();
  const unnamed = [];

  for (const c of clusters || []) {
    if (!c || !c.count) continue;
    const name = (typeof nameOf === 'function' ? nameOf(c.u, c.v) : '') || '';
    if (!name) {
      unnamed.push({ name: '', label: '校园内某处', count: c.count, u: c.u, v: c.v, radius: c.radius || 0 });
      continue;
    }
    const cur = named.get(name);
    if (!cur) {
      named.set(name, { name, label: `${name}一带`, count: c.count, su: c.u * c.count, sv: c.v * c.count, radius: c.radius || 0 });
    } else {
      cur.count += c.count;
      cur.su += c.u * c.count;
      cur.sv += c.v * c.count;
      cur.radius = Math.max(cur.radius, c.radius || 0);
    }
  }

  const merged = [...named.values()].map((c) => ({
    name: c.name,
    label: c.label,
    count: c.count,
    u: Math.round(c.su / c.count * 10000) / 10000,
    v: Math.round(c.sv / c.count * 10000) / 10000,
    radius: c.radius
  }));
  merged.push(...unnamed);
  merged.sort((a, b) => b.count - a.count);
  return merged;
}

/** 星期文案：服务端 d 为 1(周一)~7(周日) */
function weekLabel(d) {
  const i = Number(d) - 1;
  return WEEK_LABELS[i] ? `周${WEEK_LABELS[i]}` : '';
}

/** 时间线时间：MM-DD HH:mm（设备本地时区；小程序用户均在东八区） */
function formatMeetTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 数据脚注：把样本量摊开说清楚，避免用户把小样本读成规律。
 * @param {{totals?:object, range?:object, points?:object}} data
 * @returns {string[]}
 */
function buildFootnote({ totals = {}, range = {}, points = {} } = {}) {
  const lines = [];
  lines.push(`时间窗内共扫过 ${range.scanned || 0} 条相遇记录`);
  if (range.truncated) {
    lines.push(`记录量超过 ${range.maxScan || 0} 条，本次只分析了最近的部分`);
  }
  lines.push(`其中 ${totals.withLocation || 0} 条填了具体地点、${totals.withPoint || 0} 条在打卡时选了地图位置`);
  if (totals.defaultLocation > 0) {
    lines.push(`另有 ${totals.defaultLocation} 条没填具体地点（默认「校园内」），未计入地点榜`);
  }
  if (points.sampled) {
    lines.push(`地图点位较多，只画了最近 ${(points.items || []).length} 个点`);
  }
  if (totals.withPoint > 0 && totals.withPoint < 3) {
    lines.push('地图点位样本还太少，活动范围图仅供参考，会随打卡越来越准');
  }
  return lines;
}

/**
 * 总轨迹图配色的候选色板：在暖珊瑚底图上互相区分度优先（深浅色主题共用一套）。
 * 每只猫按 catId 稳定取色（见 trailColorFor），换时间窗 / 重进页面颜色都不变，
 * 图例与地图上的颜色才对得起来。色数有限，猫多于色数时颜色会复用（图例仍可区分）。
 */
const TRAIL_COLORS = [
  '#E8927C', '#6E9BC5', '#7FA25C', '#C98FBE', '#D9A03F', '#4FA79B',
  '#D96A86', '#8B8FD4', '#A8A33C', '#C97B4A', '#5F9FD9', '#B2708F'
];

/** 稳定取色：同一个 catId 永远同一色（多项式散列，只求分布均匀和可复现） */
function trailColorFor(catId) {
  const s = String(catId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 1000000007;
  }
  return TRAIL_COLORS[h % TRAIL_COLORS.length];
}

/**
 * 总轨迹图的数据脚注。与单猫脚注（buildFootnote）分开：
 * 总览没有地点榜与点位采样一条的对应关系，样本说明的口径不同。
 * @param {{range?:object, totals?:object, sampledCats?:number}} data
 * @returns {string[]}
 */
function buildTrailFootnote({ range = {}, totals = {}, sampledCats = 0 } = {}) {
  const lines = [];
  lines.push(`时间窗内共扫过 ${range.scanned || 0} 条相遇记录`);
  if (range.truncated) {
    lines.push(`记录量超过 ${range.maxScan || 0} 条，本次只覆盖了最新的部分`);
  }
  lines.push(`其中 ${totals.points || 0} 条打卡选了地图位置，来自 ${totals.cats || 0} 只猫`);
  if (totals.catsTruncated) {
    lines.push(`带位置的猫较多，图上只画了最近活跃的 ${totals.returned || 0} 只`);
  }
  if (sampledCats > 0 && range.maxTrailPoints) {
    lines.push(`有 ${sampledCats} 只猫的点位过多，每只最多画最近 ${range.maxTrailPoints} 个点`);
  }
  if ((totals.points || 0) > 0 && (totals.points || 0) < 3) {
    lines.push('地图点位样本还太少，轨迹图会随打卡越来越准');
  }
  return lines;
}

module.exports = {
  rangeText,
  spreadLabel,
  topBlock,
  topTag,
  buildConclusion,
  mergeNamedClusters,
  weekLabel,
  formatMeetTime,
  buildFootnote,
  TRAIL_COLORS,
  trailColorFor,
  buildTrailFootnote
};
