/**
 * cloudfunctions/utils/mapPoint.js - 校园地图坐标的校验与规范化
 *
 * 坐标口径：campus-map.json 里是底图像素，落库到 cats/recordMeet 的是
 * 归一化坐标 u/v（0~1）。这样底图分辨率变化不影响历史数据。
 *
 * 两条硬规则：
 *   1. campusZone **不取客户端值** —— 服务端从猫档案的 campus 字段取，
 *      否则可以把坐标写进别的校区底图上。
 *   2. 解析数值不能直接用 Number(x) —— Number(null) 是 0、Number([]) 也是 0，
 *      会把「没传坐标」变成「合法坐标 (0,0)」，用户就能把点打到地图左上角。
 */

// 与 constants.CAT_FIELD_LENGTH_LIMITS.campus 同口径
const CAMPUS_ZONE_MAX_LEN = 20;

/**
 * 有限数解析：只接受 number 或非空数字字符串。
 * @returns {?number} 合法返回数字，否则 null
 */
function toFiniteNum(x) {
  if (typeof x === 'number') return isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 校验并规范化客户端传来的地图坐标。
 *
 * u/v 必须落在 0~1。缺失、越界、NaN、Infinity、非对象、数组一律视为「没选点」，
 * 返回 null —— 调用方据此跳过写入，而不是报错中断打卡（选点是可选功能）。
 *
 * @param {*} raw - 客户端传入的 { u, v, campusZone? }
 * @param {string} campusZone - 服务端从猫档案取到的校区
 * @returns {?{campusZone: string, u: number, v: number}} 不合法返回 null
 */
function sanitizePoint(raw, campusZone) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = toFiniteNum(raw.u);
  const v = toFiniteNum(raw.v);
  if (u === null || v === null) return null;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  // 读侧（getCampusMapCats）用去空白后的校区名做等值查询，写侧必须同口径：
  // 存进带空白的校区名 → 永远查不到 → 用户选了点猫却不出现。校区为空
  // （fetchCatBrief 失败兜底 ''、非字符串）时整个点作废：否则会把 lastMeetPoint
  // 覆盖成一个任何校区都查不到的「隐形点」，等于把猫从地图上踢下去。
  const zone = typeof campusZone === 'string' ? campusZone.trim().slice(0, CAMPUS_ZONE_MAX_LEN) : '';
  if (!zone) return null;
  return {
    campusZone: zone,
    // 4 位小数：归一化坐标不需要更高精度，存进去也是白占空间
    u: Math.round(u * 10000) / 10000,
    v: Math.round(v * 10000) / 10000
  };
}

/**
 * 只判断「这是个像样的坐标」，不做规整 —— 读侧用。
 *
 * 落库时 sanitizePoint 已经过滤过一遍；这里是防御性检查：脏数据（历史迁移、
 * 手工改库、别的入口写入）不该让整张地图崩掉，只跳过这一只猫。
 *
 * @param {*} p - 任意值（通常是 cats.lastMeetPoint）
 * @returns {boolean}
 */
function isValidPoint(p) {
  return !!p
    && typeof p === 'object'
    && !Array.isArray(p)
    && typeof p.u === 'number' && isFinite(p.u)
    && typeof p.v === 'number' && isFinite(p.v)
    && p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1;
}

/**
 * 构造打卡后写回 cats 的统计字段。
 *
 * lastMeetPoint 只在用户**确实选了位置**时才写：用户可以只填文字地点、
 * 不选地图坐标（老用户没这个入口、纯手输都合法）。此时若一并清空
 * lastMeetPoint，猫会从地图上凭空消失 —— 所以是「不写该字段」而非「写 null」。
 *
 * @param {Object} recordData - 本次打卡记录（含 meetTime / 可选 point）
 * @param {Function} inc - db.command.inc
 * @returns {Object} 可直接传给 doc.update({ data }) 的字段对象
 */
function buildStatsUpdate(recordData, inc) {
  const update = {
    meetCount: inc(1),
    lastMeetTime: recordData.meetTime
  };
  if (recordData.point) {
    update.lastMeetPoint = {
      campusZone: recordData.point.campusZone,
      u: recordData.point.u,
      v: recordData.point.v,
      at: recordData.meetTime
    };
  }
  return update;
}

module.exports = {
  sanitizePoint,
  buildStatsUpdate,
  isValidPoint,
  toFiniteNum,
  CAMPUS_ZONE_MAX_LEN
};