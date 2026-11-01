/**
 * cloudfunctions/utils/beijingTime.js - 东八区（北京时间）日期工具
 *
 * 云函数容器默认 UTC 时区，直接用 Date 的本地方法（getDate/setHours 等）
 * 会把北京时间 0:00-8:00 的记录归到前一天（审查报告 P2-2）。
 * 中国无夏令时，东八区固定 UTC+8，可安全使用固定偏移换算。
 *
 * 用法约定：toBeijingDate(ts) 返回的 Date 用 **getUTC* 系列**方法读取，
 * 其 UTC 字段值即北京时间的「墙上时间」。
 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 将时间戳或 Date 转为「北京时间视角」的 Date：
 * 返回值的 UTC 字段（getUTCFullYear/getUTCMonth/getUTCDate/...）
 * 等于北京时间对应时刻的墙上时间。
 * @param {number|Date} value - 毫秒时间戳或 Date
 * @returns {Date}
 */
function toBeijingDate(value) {
  const ts = value instanceof Date ? value.getTime() : value;
  return new Date(ts + BEIJING_OFFSET_MS);
}

/**
 * 北京时间某自然月的起止毫秒时间戳 [start, end)
 * @param {number} year - 年（如 2026）
 * @param {number} month - 月（0-11，与 Date 约定一致）
 * @returns {{ start: number, end: number }}
 */
function beijingMonthRange(year, month) {
  const start = Date.UTC(year, month, 1) - BEIJING_OFFSET_MS;
  const end = Date.UTC(year, month + 1, 1) - BEIJING_OFFSET_MS;
  return { start, end };
}

/**
 * 北京时间「今天 0 点」的毫秒时间戳
 * @returns {number}
 */
function beijingTodayStart() {
  const bj = toBeijingDate(Date.now());
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_OFFSET_MS;
}

/**
 * 北京时间日期键 'YYYY-M-D'（与 getMeetCalendar 的 allDays/streak 键口径一致）
 * @param {number|Date} value - 毫秒时间戳或 Date
 * @returns {string}
 */
function beijingDayKey(value) {
  const d = toBeijingDate(value);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

module.exports = {
  BEIJING_OFFSET_MS,
  toBeijingDate,
  beijingMonthRange,
  beijingTodayStart,
  beijingDayKey
};
