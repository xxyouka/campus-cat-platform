/**
 * cloudfunctions/utils/photoCounts.js - 按 catId 统计照片数的共享实现
 *
 * 为什么单独成模块：同一个坑（聚合的隐式 20 条上限）在 getAlbumsWithInfo、
 * getCatPhotoCounts、exportData 三处都在踩，各写一份必然再次漂移。
 *
 * 【坑本身】云函数端聚合在**不显式写 .limit()** 时只返回前 20 条结果，
 * 而且**不抛异常、不报错**。任何「按 catId 分组」的结果一旦超过 20 组，
 * 第 21 组起的键就会凭空消失 —— 界面表现为「相册/首页有照片却显示 0 张」，
 * 点进去又能看到照片，日志里什么都不留。
 *
 * 2026-10-12 线上复现（env your-cloud-env-id）：photos 955 条、
 * 65 只猫有照片，`group + end()` 只回 20 组、计数之和 398（真值 955）；
 * 于是 45 只猫在相册列表显示「0 张照片」。此前两轮修复（2026-10-10 / 10-11）
 * 都以为根因是 `.match({ catId: $.in(catIds) })` —— 其实那次「几乎全 0」
 * 只是本坑在 pageSize=100 下的另一种表现（截断落在哪 20 组取决于扫描顺序，
 * 每次调用都可能不同），去掉 match 并不能修好它。
 *
 * 【纪律】任何按 catId 分组的聚合都必须做两件事：
 *   1. 显式 `.limit(...)`，且上限 ≥ 可能的分组数（见 AGG_LIMIT）；
 *   2. 用「分组计数之和 == 该范围内的照片总数」做完整性校验
 *      （见 readGroupedCounts 的返回值），不成立就降级为逐只 count
 *      （见 fillCountsByCount）—— 慢，但一定对。
 */

/** 聚合显式 limit 的取值上限（云函数端 limit 最大 1000） */
const AGG_LIMIT = 1000;

/** 逐只 count 兜底的并发上限：串行会被 N 次往返拖死，10 并发又容易触发数据库限流 */
const COUNT_CONCURRENCY = 5;

/**
 * 解析聚合 group 结果，并给出**计数之和**（完整性校验的基准）。
 *
 * 调用方用「sum == 该范围内的照片总数」判断分组结果是否完整：
 * 分组是照片集合的一个划分，只要没被截断，和必然等于总数。
 * 少了就说明聚合被截断（隐式 20 条上限）或分组键形态不对，
 * 此时缺的键会退化成「0 张」直达用户界面 —— 必须走降级。
 *
 * @param {Array<{_id: string, count: number}>|undefined} list aggregate().end() 的 list
 * @returns {{counts: Object<string, number>, sum: number}} counts 为 { catId: 张数 }，sum 为张数之和
 */
function readGroupedCounts(list) {
  const counts = {};
  let sum = 0;

  (list || []).forEach(item => {
    // 缺 catId 的分组无法归属到任何一只猫，直接忽略（它的张数也不该计入 sum，
    // 否则和会凭空变大、完整性校验被判成「完整」）
    if (!item || !item._id) return;
    const n = Number(item.count) || 0;
    counts[item._id] = n;
    sum += n;
  });

  return { counts, sum };
}

/**
 * 逐只 count 兜底：结果一定准确，代价是 N 次 count。
 *
 * 单只失败只把该猫记 0 并留日志：一只猫查不动不能让整页计数变成错误态
 * （宁可这一只为 0 + 日志留痕，也不要整页降级失败）。
 *
 * @param {object} db                cloud.database() 实例
 * @param {string} photosCollection  photos 集合名（调用方传 COLLECTIONS.PHOTOS）
 * @param {string[]} catIds
 * @param {Object} [extraWhere]       额外过滤条件（如 `_mediaBlocked: _.neq(true)`）。
 *                                    必须与聚合侧同口径，否则降级后计数会把被拦截照片又算回来。
 * @returns {Promise<Object<string, number>>} { catId: 张数 }
 */
async function fillCountsByCount(db, photosCollection, catIds, extraWhere = {}) {
  const counts = {};

  for (let i = 0; i < catIds.length; i += COUNT_CONCURRENCY) {
    const batch = catIds.slice(i, i + COUNT_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const rows = await Promise.all(batch.map(async (catId) => {
      try {
        const res = await db.collection(photosCollection)
          .where({ catId, ...extraWhere })
          .count();
        return [catId, res.total || 0];
      } catch (err) {
        console.warn('[photoCounts] 单只 count 失败，该猫按 0 计:', catId, err.message || err);
        return [catId, 0];
      }
    }));
    rows.forEach(([catId, total]) => { counts[catId] = total; });
  }

  return counts;
}

module.exports = {
  AGG_LIMIT,
  COUNT_CONCURRENCY,
  readGroupedCounts,
  fillCountsByCount
};
