/**
 * pages/admin/utils/campusLandmark.js - 归一化坐标 → 最近地物名（猫咪行动分析页专用）
 *
 * 数据源与 subpackages/map/components/campus-map 相同（images/campus-map/campus-map.js，编辑器导出的权威源），
 * 但对底图只做**只读查询**，不参与任何绘制 —— 地图组件的绘制逻辑保持独立，互不改动。
 *
 * 距离按**像素**算而不是 uv 坐标：两轴的分母不同（1580×840），直接在 uv 空间
 * 算欧氏距离会把横向差距算小、选错最近的楼（与 campus-map._nearestName 同口径，
 * 那边是为选点标注服务，这里是给聚集圈起名）。
 *
 * 超过 maxDistance 一律返回 ''：圈心离所有地物都很远时，硬报一个远处的楼名
 * 会让「XX一带」变成假信息，此时交给页面显示「校园内某处」。
 *
 * 校区：底图一个校区一张（utils/campusMapRegistry），查名字必须按点位所在校区查 ——
 * 拿本部的地物去解释东区坐标，会得到一个看着像真的、其实毫无关系的楼名。
 * 索引按校区各建一份（首次用到才算）。
 */
const { getMap, resolveZone } = require('../../../utils/campusMapRegistry');

// 默认搜索半径（底图像素）。120px ≈ 校园宽度的 7%，落在空旷区域时不至于
// 攀上隔着一整片操场的建筑名。
const DEFAULT_MAX_DISTANCE = 120;

let index = null;
/** 已建过索引的校区（校区 → index），切校区不会互相污染 */
const indexes = {};

/**
 * 把底图数据整理成「名字 + 像素包围盒」清单，每个校区只算一次。
 * 地物在底图里是多边形（p 为像素点数组），查询只用包围盒近似 ——
 * 够准且便宜（同 campus-map 的注释口径）。
 */
function buildIndex(zone) {
  const raw = getMap(zone);
  if (!raw) return null;
  const size = raw.imageSize || [1000, 1000];
  const W = size[0] || 1000;
  const H = size[1] || 1000;
  const items = [];

  const pushPolys = (arr) => {
    (arr || []).forEach((f) => {
      if (!f || !f.name || !f.p || f.p.length < 3) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of f.p) {
        if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
        if (p[0] < x0) x0 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0];
        if (p[1] > y1) y1 = p[1];
      }
      if (x0 === Infinity) return;
      items.push({ name: f.name, x0, y0, x1, y1 });
    });
  };

  // 与 campus-map 标注口径一致：建筑与运动场是有名字的地标，POI 是点
  pushPolys(raw.buildings);
  pushPolys(raw.sports);
  (raw.pois || []).forEach((p) => {
    if (!p || !p.name || typeof p.x !== 'number' || typeof p.y !== 'number') return;
    items.push({ name: p.name, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  });

  return { W, H, items };
}

/**
 * (u, v) 最近的有名地物；找不到、超出搜索半径、或该校区没底图时返回 ''。
 * @param {number} u - 0~1
 * @param {number} v - 0~1
 * @param {number} [maxDistance] - 搜索半径（底图像素）
 * @param {string} [zone] - 校区（点位所属校区；缺省按本部）
 * @returns {string}
 */
function nearestFeatureName(u, v, maxDistance = DEFAULT_MAX_DISTANCE, zone) {
  if (!isFinite(u) || !isFinite(v)) return '';
  const z = resolveZone(zone);
  if (!indexes[z]) indexes[z] = buildIndex(z);
  index = indexes[z];
  if (!index) return '';       // 该校区还没画底图：宁可不命名，也不拿别的校区硬套
  const x = u * index.W;
  const y = v * index.H;

  let best = '';
  let bestD = Infinity;
  for (const it of index.items) {
    const dx = x < it.x0 ? it.x0 - x : x > it.x1 ? x - it.x1 : 0;
    const dy = y < it.y0 ? it.y0 - y : y > it.y1 ? y - it.y1 : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = it.name;
    }
  }

  if (!best) return '';
  return Math.sqrt(bestD) <= maxDistance ? best : '';
}

module.exports = {
  nearestFeatureName,
  DEFAULT_MAX_DISTANCE
};
