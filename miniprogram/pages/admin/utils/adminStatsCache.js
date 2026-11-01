/**
 * utils/adminStatsCache.js - 管理端统计快照（本地缓存）
 *
 * 背景（2026-10-14 性能复盘）：管理后台 `pages/admin/admin` 的「页面切换耗时」
 * 均值 3758ms，是站内第二名的 19 倍 —— 首屏 LCP 要等「云端鉴权 → 统计」两个
 * **串行**云函数，而管理端是低频入口，两个函数还各带一次冷启动。
 * 本模块提供 stale-while-revalidate 的本地快照：进后台先用上次的数字把内容渲染出来，
 * 云调用回来再刷新。
 *
 * 信任级别：快照只含 4 个聚合数字，读取方（admin 页）在渲染前仍要求本地
 * `checkAdminAuth()` 通过，随后仍会走 `requireAdminAuth()` 的云端严格校验 ——
 * 与「我的」页的管理员入口同一口径（本地校验只是 UI 层门禁）。
 *
 * 缓存不是数据源：读取失败、结构异常一律按「没有缓存」处理，绝不抛错打断页面。
 *
 * @module adminStatsCache
 */

const { Logger } = require('../../../utils/logger');

const STATS_CACHE_KEY = 'adminStatsCache';

/**
 * 时间戳 → 展示用「更新于」文案。
 *
 * 同一天只给 `HH:mm`；跨天的快照必须带上 `MM-DD` —— 否则昨天的数字会被读成
 * 「刚更新」。与 admin 页 `loadStats` 失败时保留旧时间的口径一致：
 * 宁可显得旧，不可假装新鲜。
 *
 * @param {number} ts - 毫秒时间戳
 * @returns {string} `HH:mm` 或 `MM-DD HH:mm`
 */
function formatStatsTime (ts) {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

/**
 * 读快照。缺失或结构异常（含存储层抛错）一律返回 null。
 * @returns {{stats: object, updateTime?: string, savedAt?: number}|null}
 */
function readStatsCache () {
  try {
    const cache = wx.getStorageSync(STATS_CACHE_KEY);
    if (!cache || typeof cache !== 'object' || !cache.stats) return null;
    return cache;
  } catch (e) {
    return null;
  }
}

/**
 * 写快照。写失败只记日志，不影响主流程（缓存永远是可选的）。
 * @param {object} stats - 聚合统计
 * @param {string} updateTime - 与快照同时展示的「更新于」文案
 */
function saveStatsCache (stats, updateTime) {
  try {
    wx.setStorageSync(STATS_CACHE_KEY, { stats, updateTime, savedAt: Date.now() });
  } catch (e) {
    Logger.debug('admin', '统计快照写入失败', e.message);
  }
}

/**
 * 清快照。退出登录 / 鉴权失败时调用 —— 同一台设备可能换人登录，
 * 不能让下个身份先看到上个人的数字。
 */
function clearStatsCache () {
  try {
    wx.removeStorageSync(STATS_CACHE_KEY);
  } catch (e) {
    Logger.debug('admin', '统计快照清理失败', e.message);
  }
}

module.exports = {
  STATS_CACHE_KEY,
  formatStatsTime,
  readStatsCache,
  saveStatsCache,
  clearStatsCache
};
