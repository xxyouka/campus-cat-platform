/**
 * utils/campusMapRegistry.js - 校区 → 底图数据 的唯一登记表
 *
 * 为什么要有这个文件：底图从「只有本部一张」变成「一个校区一张」之后，
 * 组件、地图页、详情页选点、行动分析四处都要回答同一个问题 ——
 * 「这个校区有没有底图？是哪一份？」。分散写死会在加校区时漏掉某处，
 * 表现是「点进去一片空白」或「拿本部图配东区坐标」（后者更糟：坐标看着正常，位置全错）。
 *
 * 加新校区的完整步骤：
 *   1. 用 tools/campus-map-editor 选该校区、画完导出（文件名见编辑器 README）；
 *   2. 把文件放进 images/campus-map/；
 *   3. 在下面 MAPS 里加一行（名字必须与 cats.campus / 首页校区筛选完全一致）。
 *
 * 没登记的校区 = 没有底图：调用方据此**不给**选点入口、不画错图，
 * 而不是拿本部底图凑合（那会产出一份永远显示不出来的坐标）。
 */
const MAPS = {
  本部: require('../images/campus-map/campus-map.js'),
  东区: require('../images/campus-map/campus-map-north.js')
};

/** 与首页校区筛选同一套顺序（pages/index 的 campusOptions） */
const ZONE_ORDER = ['本部', '东区', '西区', '南区'];

/**
 * 校区名规整：只去空白；空值按本部（底图缺省就是本部）。
 * **不认识的校区保持原样** —— 调用方据此发现「没这张图」，
 * 而不是被悄悄换成本部（换错了图不会报错，只会把坐标画到别处）。
 * @param {*} raw
 * @returns {string}
 */
function normalizeZone(raw) {
  const z = String(raw === null || raw === undefined ? '' : raw).trim();
  return z || '本部';
}

/**
 * 校区名规整 + 兜底：认得的返回原名，不认得的一律退回本部。
 * 用在「有兜底才安全」的地方（页面取校区、给猫判选点入口）。
 * @param {*} raw
 * @returns {string}
 */
function resolveZone(raw) {
  const z = normalizeZone(raw);
  return MAPS[z] ? z : '本部';
}

/**
 * 取该校区的底图数据；没登记返回 null（**不要**回退本部 —— 调用方要能区分）。
 * @param {string} zone
 * @returns {object|null}
 */
function getMap(zone) {
  const z = String(zone === null || zone === undefined ? '' : zone).trim();
  return MAPS[z] || null;
}

/**
 * 这个校区有没有底图。
 * @param {string} zone
 * @returns {boolean}
 */
function hasMap(zone) {
  return !!getMap(zone);
}

/** 已有底图的校区（按首页顺序），供地图页的校区切换条用 */
function availableZones() {
  return ZONE_ORDER.filter((z) => !!MAPS[z]);
}

module.exports = {
  normalizeZone,
  resolveZone,
  getMap,
  hasMap,
  availableZones
};
