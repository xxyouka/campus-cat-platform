/**
 * cloudfunctions/utils/opsIdentity.js - 运营数据面板的匿名身份与文档 ID
 *
 * 为什么单独一份：
 *   - 运营面板要跨 recordMeet / userFavorites / face_feedback 关联同一个用户，
 *     但这份关联只需要「稳定、不可反查」的键，不需要也不应该落原始 openid；
 *   - 文档 ID 一旦在 trackOps 写、在 getOpsDashboard 读时算法不一致，
 *     统计会静默少算（没有报错，只是数字变小）。所以只在这里定义一次。
 *
 * 隐私边界：
 *   - userKey = sha256(openid) 前 32 位，无法从 ops_* 集合反推出 openid；
 *   - 目前没有加盐：openid 本身是微信侧随机串，且 ops_* 集合不对外开放读写。
 *     若未来要进一步提高抗碰撞/抗彩虹表能力，需要在**写入前**统一加盐并重算，
 *     不能在读侧单方面改算法（否则存量数据全部对不上）。
 */

const crypto = require('crypto');
const { toBeijingDate } = require('./beijingTime');

/** 稳定的匿名用户键（32 位十六进制，碰撞概率可忽略） */
function userKey(openid) {
  if (!openid) return '';
  return crypto.createHash('sha256').update(String(openid)).digest('hex').slice(0, 32);
}

/**
 * 一次识猫尝试的稳定键：同一次识别（openid + taskId）在
 * ops_recognitions 与 face_feedback 两侧必须算出同一个值。
 */
function attemptKey(openid, taskId) {
  if (!openid || !taskId) return '';
  return crypto.createHash('sha256')
    .update(`${openid}|${taskId}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 北京时间日期键，**零填充**成 YYYY-MM-DD。
 *
 * 不使用 beijingDayKey 的 `YYYY-M-D`：运营集合用「日期前缀 + _id 范围扫描」，
 * 不补零会让 2026-10-9 排在 2026-10-22 之后，区间查询静默漏数据。
 */
function opsDayKey(value) {
  const d = toBeijingDate(value);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function userDocId(uk) {
  return `u_${uk}`;
}

/** 一天一个用户一条，用于计算 DAU / 回访（关注后任意一天再活跃） */
function dayDocId(day, uk) {
  return `d_${day}_${uk}`;
}

/**
 * 一天一个用户一条，entries 数组存当天用过的入口。
 *
 * 不用「一天一用户一入口一条」：11 个入口 × 用户数 × 365 天会让集合膨胀得很快，
 * 而看板只需要「最近 28 天每个入口的去重人数」。一天一条能把文档量压到 1/3 左右，
 * 28 天扫描也不容易撞到 5 万条上限。
 */
function entryDocId(day, uk) {
  return `e_${day}_${uk}`;
}

/** 一次识猫结果一条；日期放在前缀，面板可按日期范围直接扫 _id */
function recognitionDocId(day, key) {
  return `r_${day}_${key}`;
}

module.exports = {
  userKey,
  attemptKey,
  opsDayKey,
  userDocId,
  dayDocId,
  entryDocId,
  recognitionDocId
};
