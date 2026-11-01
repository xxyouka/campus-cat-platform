// cloudfunctions/migrateCatListSort/index.js - 一次性数据回填：猫咪列表排序值 listSort
//
// 背景：列表（首页/搜索/筛选）的排序字段 listSort（见 utils/listSort.js）自本次
// 改动起由写库路径维护；存量猫档案没有该字段，需要按 status + 更新时间回填一遍，
// 否则新版排序上线后这些猫会因缺字段沉底，与既定顺序（在校+走失 → 离世 → 领养垫底）不符。
//
// 口径：
//   - listSort = 档位偏移(status) + 毫秒时间戳，时间取 updateTime，缺失时退回 createTime；
//     两者都缺失（脏数据）→ computeListSort 返回 0，沉到最底 —— 与现行「按 updateTime
//     排序时缺失字段沉底」的表现一致，不让脏数据占到组首；
//   - 逐页扫描 cats（游标 _id，不用 offset：分页会随记录增删漂移）；
//   - 只写与现值不同的记录（幂等：写完后重跑一遍，updated 应为 0）；
//   - dryRun 默认开启：先出报告核对，显式 mode:'write' 才写库；
//   - 可分页续跑：返回 done=false 时带 nextCursor 继续。
//
// 权限：成批改写全库猫档案，破坏性口径同 backfillLastMeetTime —— 仅超级管理员可调用。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { checkAdmin } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { COLLECTIONS } = require('./utils/constants');
const { computeListSort } = require('./utils/listSort');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LOG_SOURCE = 'migrateCatListSort';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const SAMPLES_MAX = 10;

/**
 * 把云数据库里的各种时间表示统一成毫秒时间戳。
 * updateTime/createTime 是 db.serverDate() 写入的 Date；历史数据里也可能混入数字/字符串。
 * @returns {number} 无法解析返回 0
 */
function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** 排序基准时间：updateTime 优先，缺失时退回 createTime；都缺失返回 0（沉底） */
function resolveTimeMs(row) {
  return toMillis(row && row.updateTime) || toMillis(row && row.createTime) || 0;
}

/**
 * 扫描一批并（按需）回填。
 * @param {{write: boolean, limit: number, cursor: string}} params
 * @returns {Promise<{scanned: number, updated: number, upToDate: number, errors: number,
 *   samples: Array, nextCursor: string, done: boolean}>}
 */
async function runBatch({ write, limit, cursor }) {
  const where = cursor ? { _id: _.gt(cursor) } : {};
  const res = await db.collection(COLLECTIONS.CATS)
    .where(where)
    .orderBy('_id', 'asc')
    .field({ status: true, updateTime: true, createTime: true, listSort: true })
    .limit(limit)
    .get();

  const rows = res.data || [];
  const results = { scanned: rows.length, updated: 0, upToDate: 0, errors: 0, samples: [] };
  let nextCursor = cursor;

  for (const row of rows) {
    nextCursor = row._id;
    const expected = computeListSort(row.status, resolveTimeMs(row));
    const current = typeof row.listSort === 'number' ? row.listSort : null;

    if (current === expected) {
      results.upToDate++;
      continue;
    }

    results.updated++;
    if (results.samples.length < SAMPLES_MAX) {
      results.samples.push({ catId: row._id, status: row.status || '(缺失)', from: current, to: expected });
    }

    if (write) {
      try {
        await db.collection(COLLECTIONS.CATS).doc(row._id).update({ data: { listSort: expected } });
      } catch (err) {
        // 单条失败不中断整批：计数后继续，报告里可见，重跑即可补上
        results.errors++;
        console.error(`[${LOG_SOURCE}] 回填失败 catId=${row._id}:`, err && err.message);
      }
    }
  }

  const done = rows.length < limit;
  return { ...results, nextCursor: done ? '' : nextCursor, done };
}

exports.main = async (event, _context) => {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event && event._adminAccount || '';

  const authResult = await checkAdmin(db, OPENID, { operation: '回填列表排序值', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    console.warn(`[${LOG_SOURCE}] 非管理员调用被拒绝`);
    return fail(authResult.error || '无权限执行回填操作');
  }
  if (authResult.adminInfo && authResult.adminInfo.role !== 'superadmin') {
    console.warn(`[${LOG_SOURCE}] 需要 superadmin，当前角色: ${authResult.adminInfo.role}`);
    return fail('回填仅限超级管理员');
  }

  const write = !!(event && event.mode === 'write');
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(event && event.limit) || DEFAULT_LIMIT));
  const cursor = typeof (event && event.cursor) === 'string' ? event.cursor : '';
  const startTime = Date.now();

  try {
    const batch = await runBatch({ write, limit, cursor });
    const report = {
      mode: write ? 'write' : 'dryRun',
      ...batch,
      duration: Date.now() - startTime
    };

    console.log(`[${LOG_SOURCE}] 回填（${report.mode}）完成:`, JSON.stringify(report));

    await logOperation(db, OPENID, {
      module: 'migrateCatListSort',
      action: 'migrate',
      description: `回填列表排序值（${report.mode}）：扫描 ${report.scanned} 只，` +
        `${write ? '写入' : '待写入'} ${report.updated} 只，跳过 ${report.upToDate} 只`,
      result: report.errors > 0 ? 'partial' : 'success',
      adminAccount,
      afterData: {
        mode: report.mode,
        updated: report.updated,
        upToDate: report.upToDate,
        errors: report.errors,
        done: report.done
      }
    });

    return ok(report, write ? '本批回填完成' : '试运行完成（未写库）');
  } catch (err) {
    console.error(`[${LOG_SOURCE}] 回填失败:`, err && err.message);
    return fail('回填失败，请查看云函数日志');
  }
};
