/**
 * migrateMeetStatusTag - 一次性运维：清理历史 emoji 口径（图标统一 2026-10）
 *
 * 背景：图标统一后，相遇状态标签落库改为纯文本（'相遇了'），
 * 但历史 `recordMeet.statusTag` 与 `notifications.content`（cat_meet 类型）
 * 里仍带旧 emoji 前缀（'😺 相遇了'、'✏️ 在开会' 等）。本函数把两处存量清洗为纯文本。
 *
 * 入参：
 *   target  string  必填，'meets' | 'notifications'（先跑 meets 再跑 notifications）
 *   dryRun  boolean 默认 true（只报告不写库）；显式 false 才真正更新
 *   limit   number  单次处理条数（1~500，默认 100）
 *   cursor  string  分页游标：上一轮返回的 nextCursor，空串从头开始
 *
 * 返回：{ dryRun, target, scanned, changed, samples, nextCursor, done }
 *   done=true 表示该 target 已处理完，可换下一个 target。
 *
 * 幂等：清洗规则只命中「前缀是已知 emoji」的记录，重复执行无副作用；
 * 清洗表与主包 utils/statusTag.js（及 skills 共享副本）保持一致，勿单独漂移。
 *
 * ⚠️ 安全：仅管理员可调用；默认 DRY-RUN，必须先出报告核对再显式 dryRun=false。
 */
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const SAMPLES_MAX = 5;

// 与主包 utils/statusTag.js 的 LEGACY_PREFIX_ICONS 同一张表
const TAG_PREFIX_RE = /^(😺|😴|🍽️?|🎮|🐾|🤗|✏️?)\s*/u;
// 通知正文模板为 `…相遇啦！<statusTag>`，只清理「！之后」的前缀，避免误伤猫名里的用户 emoji
const CONTENT_PREFIX_RE = /(！\s*)(😺|😴|🍽️?|🎮|🐾|🤗|✏️?)\s*/gu;

/** 清洗 statusTag：命中已知 emoji 前缀时返回清洗后文本，否则返回 null */
function cleanStatusTag(tag) {
  if (typeof tag !== 'string') return null;
  const s = tag.trim();
  if (!s) return null;
  const stripped = s.replace(TAG_PREFIX_RE, '').trim();
  return stripped && stripped !== s ? stripped : null;
}

/** 清洗通知正文：仅剥离「！」之后的已知 emoji 前缀 */
function cleanNotifyContent(content) {
  if (typeof content !== 'string') return null;
  const cleaned = content.replace(CONTENT_PREFIX_RE, '$1');
  return cleaned !== content ? cleaned : null;
}

/** 校验并归一化入参 */
function parseParams(event) {
  const target = event.target;
  if (target !== 'meets' && target !== 'notifications') {
    return { error: 'target 必须是 meets 或 notifications' };
  }
  return {
    target,
    dryRun: event.dryRun !== false, // 默认 DRY-RUN
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(event.limit) || DEFAULT_LIMIT)),
    cursor: typeof event.cursor === 'string' ? event.cursor : ''
  };
}

/** 分页查询条件（游标为上一轮最后一条 _id） */
function buildWhere(target, cursor) {
  if (target === 'meets') return cursor ? { _id: _.gt(cursor) } : {};
  return cursor ? { type: 'cat_meet', _id: _.gt(cursor) } : { type: 'cat_meet' };
}

/** 单条记录的清洗结果：命中返回清洗后文本，否则 null */
function cleanRow(target, row) {
  return target === 'meets' ? cleanStatusTag(row.statusTag) : cleanNotifyContent(row.content);
}

/** 执行一批：扫描 → 清洗 →（非 DRY-RUN 时）写库 */
async function runBatch({ target, dryRun, limit, cursor }) {
  const collection = target === 'meets' ? COLLECTIONS.RECORD_MEET : COLLECTIONS.NOTIFICATIONS;
  const res = await db.collection(collection)
    .where(buildWhere(target, cursor))
    .orderBy('_id', 'asc')
    .limit(limit)
    .get();
  const rows = res.data || [];

  const samples = [];
  let changed = 0;
  let nextCursor = cursor;

  for (const row of rows) {
    nextCursor = row._id;
    const cleaned = cleanRow(target, row);
    if (!cleaned) continue;
    changed++;
    if (samples.length < SAMPLES_MAX) {
      samples.push({
        id: row._id,
        before: target === 'meets' ? row.statusTag : row.content,
        after: cleaned
      });
    }
    if (!dryRun) {
      await db.collection(collection).doc(row._id).update({
        data: target === 'meets' ? { statusTag: cleaned } : { content: cleaned }
      });
    }
  }

  const done = rows.length < limit;
  return { dryRun, target, scanned: rows.length, changed, samples, nextCursor: done ? '' : nextCursor, done };
}

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext();
  const adminAccount = event._adminAccount || '';

  const authResult = await checkAdmin(db, OPENID, { operation: '数据迁移', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    return fail(authResult.error);
  }

  const params = parseParams(event);
  if (params.error) return fail(params.error);

  try {
    const summary = await runBatch(params);

    await logOperation(db, OPENID, {
      module: 'migrateMeetStatusTag',
      action: 'migrate',
      description: `${summary.dryRun ? '[DRY-RUN] ' : ''}清理 ${summary.target} 历史 emoji 口径`,
      result: 'success',
      adminAccount,
      afterData: { scanned: summary.scanned, changed: summary.changed, done: summary.done }
    });

    return ok(summary, summary.done ? '本批处理完成' : '还有剩余，请用 nextCursor 继续');
  } catch (err) {
    console.error('[migrateMeetStatusTag] 失败:', err);
    return fail('迁移执行失败，请查看云函数日志');
  }
};
