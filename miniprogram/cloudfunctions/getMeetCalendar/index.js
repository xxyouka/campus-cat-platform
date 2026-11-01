// cloudfunctions/getMeetCalendar/index.js - 获取相遇打卡日历数据
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { toBeijingDate, beijingMonthRange, beijingTodayStart, beijingDayKey } = require('./utils/beijingTime');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 单次查询的总量硬顶：防止用户打卡累积到数十万条时把云函数内存跑满。
// 达到上限会打warn 并截断，而不是静默当作全量。
const MAX_SCAN_ROWS = 20000;

/**
 * 按游标分页拉取记录（串行，不再并发skip 分页）
 *
 * 原实现用 `Promise.all` 把 N 个 `skip(i*1000)` 全部并发发出——
 * N = ceil(total/1000)，用户打卡累积到数千条时一次性打满数据库并发配额，
 * 且 skip 分页在无 orderBy 时顺序不稳定，连续打卡天数 allDays 可能算错。
 * 改为 `_id > lastId` 游标 + 串行，语义稳定且不冲击并发配额。
 *
 * @param {object} where 查询条件
 * @param {object} field 投影字段
 * @param {number} maxRows 总量硬顶，防止无边界把内存跑满
 * @returns {Promise<Array<object>>}
 */
async function getAllRecords(collection, where, field, maxRows = MAX_SCAN_ROWS) {
  const PAGE_SIZE = 1000;
  const records = [];
  let lastId = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 游标条件必须与原条件**合并进同一个 where 对象**：
    // wx-server-sdk 的 Query.where() 是整体替换 _fieldFilters，不会合并。
    // 第二页若再链 .where({_id: _.gt(lastId)})，原 _openid / meetTime 条件会被
    // 静默丢弃 —— 第二页起会把全站用户的打卡并进当前用户的日历/累计天数。
    const condition = lastId ? { ...where, _id: _.gt(lastId) } : where;
    const query = db.collection(collection)
      .where(condition)
      .field({ ...field, _id: true })
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE);

    const res = await query.get();
    if (!res.data || res.data.length === 0) break;

    records.push(...res.data);
    lastId = res.data[res.data.length - 1]._id;

    if (res.data.length < PAGE_SIZE) break;
    if (records.length >= maxRows) {
      console.warn(`[getMeetCalendar] ${collection} 扫描达上限 ${maxRows} 条，结果可能不完整`);
      break;
    }
  }

  return records;
}

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { OPENID } = cloud.getWXContext();
  const { year, month } = event;

  try {
    // 默认年月取北京时间的「现在」（容器是 UTC，直接用本地方法在 0:00-8:00 会错位）
    const bjNow = toBeijingDate(Date.now());
    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10);
    const targetYear = Number.isNaN(parsedYear) ? bjNow.getUTCFullYear() : parsedYear;
    if (!Number.isNaN(parsedMonth) && (parsedMonth < 0 || parsedMonth > 11)) {
      return fail('month 参数无效（0-11）');
    }
    const targetMonth = Number.isNaN(parsedMonth) ? bjNow.getUTCMonth() : parsedMonth;

    const { start: monthStart, end: monthEnd } = beijingMonthRange(targetYear, targetMonth);

    const monthRecords = await getAllRecords(COLLECTIONS.RECORD_MEET, {
      _openid: OPENID,
      meetTime: _.gte(monthStart).and(_.lt(monthEnd))
    }, { meetTime: true, catId: true, catName: true, catAvatar: true, location: true, statusTag: true });

    const meetDays = [...new Set(
      monthRecords.map(r => toBeijingDate(r.meetTime).getUTCDate())
    )].sort((a, b) => a - b);

    const dayDetails = {};
    monthRecords.forEach(r => {
      const day = toBeijingDate(r.meetTime).getUTCDate();
      if (!dayDetails[day]) dayDetails[day] = [];
      dayDetails[day].push({
        catId: r.catId,
        catName: r.catName || '',
        catAvatar: r.catAvatar || '',
        location: r.location || r.campus || '',
        statusTag: r.statusTag || ''
      });
    });

    // totalDays 是**累计**相遇天数，语义上必须扫全量（加 MAX_SCAN_ROWS 硬顶兜底）
    const allRecords = await getAllRecords(COLLECTIONS.RECORD_MEET, {
      _openid: OPENID
    }, { meetTime: true }, MAX_SCAN_ROWS);

    const allDays = [...new Set(allRecords.map(r => beijingDayKey(r.meetTime)))];
    const totalDays = allDays.length;

    const todayStart = beijingTodayStart();

    // streakDays 只回看 365 天（下方循环上限即 365），故单独发一次**带时间窗**的查询。
    // 原实现靠上面那份全量 allDays 算连续天数，等于让第二次调用也付全量扫描成本。
    // 365 天窗口把这次的扫描量压到与实际需求匹配。
    const streakWindowStart = todayStart - 365 * 86400000;
    // 上界必须取当前时刻而不是今日 0 点：否则今天打卡被排除，
    // streakDays 永远少算今天、todayChecked 恒为 false。
    const streakRecords = await getAllRecords(COLLECTIONS.RECORD_MEET, {
      _openid: OPENID,
      meetTime: _.gte(streakWindowStart)
    }, { meetTime: true }, MAX_SCAN_ROWS);
    const streakDaySet = new Set(streakRecords.map(r => beijingDayKey(r.meetTime)));

    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const key = beijingDayKey(todayStart - i * 86400000);
      if (streakDaySet.has(key)) {
        streakDays++;
      } else {
        if (i === 0) continue;
        break;
      }
    }

    const todayChecked = streakDaySet.has(beijingDayKey(todayStart));

    return ok({
      meetDays,
      dayDetails,
      totalDays,
      streakDays,
      todayChecked,
      monthDays: meetDays.length
    });
  } catch (err) {
    console.error('[getMeetCalendar] 查询失败:', err);
    return fail('查询失败');
  }
};
