/**
 * cloudfunctions/utils/listSort.js - 猫咪列表排序值（canonical 源）
 *
 * 列表（首页/搜索/筛选）按单一字段 `listSort` 降序取数
 * （orderBy('listSort', 'desc')）。规则（2026-10-12 与产品确认）：
 *   1. 在校(normal) / 走失(lost)：最前，组内按最近更新倒序；
 *   2. 已离世(deceased)：整组其后；
 *   3. 被领养(adopted)：整组垫底。
 *
 * 实现：listSort = 档位偏移 + 更新时间毫秒数。数值越大越靠前，
 * 单字段排序即可同时表达「档位」与「组内按时间」两层顺序，
 * 分页（skip/limit）与原先按 updateTime 排序时完全一致，
 * 也不需要多字段排序的复合索引。
 *
 * 【维护纪律，务必遵守】任何改写 cats.updateTime 或 cats.status 的写库路径
 * 都必须同步重算 listSort，否则排序漂移（改了状态却沉不下去/浮不上来）。
 * 当前写方：
 *   - addCat          建档
 *   - updateCat       编辑 / 改状态
 *   - recordMeet      走失猫被再次遇到 → 自动找回（lost → normal）
 *   - sweepLostCats   久未相遇 → 自动走失（normal → lost）
 * 存量数据由一次性函数 migrateCatListSort 回填；它幂等，可随时重跑核对。
 *
 * 本文件是 canonical 源，经 scripts/sync-utils.js 分发到各调用方的 utils/ 副本
 * （云函数之间无共享运行时，不能跨函数 require）。
 */

/**
 * 档位偏移表。间隔取 1e13：
 *   - 毫秒时间戳当前约 1.76e12，到公元 9999 年约 2.5e14 也仍小于「档位数 × 1e13」的
 *     有效范围（JS 双精度整数安全区 2^53 ≈ 9e15，2e13 + 2.5e14 远在安全区内）；
 *   - 相邻档位区间（偏移 ± 时间戳）在数百年内不会交叠，
 *     desc 排序下恒定给出 normal/lost > deceased > adopted。
 * 未来若要在档位间插入新档（例如让走失也沉底），在空隙里取偏移并回填存量即可。
 */
const LIST_SORT_TIERS = {
  normal: 2 * 1e13,
  lost: 2 * 1e13,
  deceased: 1 * 1e13,
  adopted: 0
};

/**
 * 计算猫咪列表排序值。
 *
 * @param {string} status - 'normal' | 'lost' | 'deceased' | 'adopted'
 * @param {number} timeMs - 更新时间毫秒数（写库时传 Date.now()；回填时取
 *   存量 updateTime/createTime 的解析值）
 * @returns {number} 降序排序键。时间缺失（非正有限数）时返回 0：
 *   整条沉到最底，而不是落进某档的组首 —— 脏数据不占头排，也便于对照排查。
 */
function computeListSort(status, timeMs) {
  // 状态缺失/枚举外：按「在校」档兜底。列表本就只取四类合法状态
  // （where.status in [...]），枚举外的值不会出现在前台；
  // 万一陈旧脏数据出现，落在最前档是方向上最安全的兜底（与「在校」同权）。
  const offset = Object.prototype.hasOwnProperty.call(LIST_SORT_TIERS, status)
    ? LIST_SORT_TIERS[status]
    : LIST_SORT_TIERS.normal;

  const ts = typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs > 0
    ? timeMs
    : 0;
  if (!ts) return 0;
  return offset + ts;
}

module.exports = {
  LIST_SORT_TIERS,
  computeListSort
};
