/**
 * cloudfunctions/getOpsDashboard/metrics.js - 运营面板的纯计算层
 *
 * 这个文件刻意不碰数据库：输入是几张表里已经归一化好的行，输出是四周/八周/十二周
 * 的固定指标。这样可以：
 *   1. 用单元测试锁住「口径」——分母是谁、7 天窗口怎么算、未满 7 天的 cohort 不参与；
 *   2. 在 index.js 里替换数据源时不会顺手改掉口径。
 *
 * 四个固定指标（不随新功能增加而改）：
 *   新用户激活率 / 首个打卡完成率 / 关注后回访率 / 识猫「确认是它」比例。
 * 所有「率」的分母都只算**已经满 7 天观察窗**的用户；未满的用户单独计入
 * pending，绝不把「还没来得及做」算成「没做」。
 */

const { toBeijingDate } = require('./utils/beijingTime');
const { opsDayKey } = require('./utils/opsIdentity');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const OBSERVE_WINDOW_MS = 7 * DAY_MS;
const ENTRY_WINDOW_DAYS = 28;

/**
 * 任意时间值 → 毫秒。云数据库 serverDate 在序列化后可能是 Date / ISO 字符串 / 数字，
 * 统一收口，避免某一个类型让整段统计静默变成 NaN。
 * @param {*} value
 * @returns {number} 无法解析时返回 0
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
}

/** 北京时间所在自然周的周一 00:00（中国无夏令时，固定 +8 偏移安全） */
function weekStartMs(value) {
  const d = toBeijingDate(toMs(value));
  const weekday = d.getUTCDay(); // 0=周日
  const offset = (weekday + 6) % 7; // 周一=0
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - offset
  ) - 8 * 3600 * 1000;
}

function weekLabel(startAt, endAt, isCurrent) {
  const s = toBeijingDate(startAt);
  const e = toBeijingDate(endAt - 1);
  const label = `${s.getUTCMonth() + 1}/${s.getUTCDate()}–${e.getUTCMonth() + 1}/${e.getUTCDate()}`;
  return isCurrent ? `本周 ${label}` : label;
}

/**
 * 生成连续的 N 个自然周（最后一个是当前周）。
 * @param {number} now
 * @param {number} count
 */
function buildWeeks(now, count) {
  const thisWeekStart = weekStartMs(now);
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const startAt = thisWeekStart - i * WEEK_MS;
    const endAt = startAt + WEEK_MS;
    const isCurrent = i === 0;
    weeks.push({
      key: opsDayKey(startAt),
      label: weekLabel(startAt, endAt, isCurrent),
      startAt,
      endAt,
      isCurrent
    });
  }
  return weeks;
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

/**
 * 取「每个用户的最早一次时间」。
 * @param {Array<{userKey:string, at:number}>} rows
 * @returns {Map<string, number>}
 */
function firstByUser(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.userKey) continue;
    const at = toMs(row.at);
    if (!at) continue;
    const prev = map.get(row.userKey);
    if (!prev || at < prev) map.set(row.userKey, at);
  }
  return map;
}

function dedupeUsers(users) {
  const map = new Map();
  for (const user of users) {
    if (!user || !user.userKey) continue;
    const firstSeenAt = toMs(user.firstSeenAt);
    if (!firstSeenAt) continue;
    const prev = map.get(user.userKey);
    if (!prev) {
      map.set(user.userKey, {
        userKey: user.userKey,
        firstSeenAt,
        lastSeenAt: toMs(user.lastSeenAt) || firstSeenAt
      });
    } else {
      prev.firstSeenAt = Math.min(prev.firstSeenAt, firstSeenAt);
      prev.lastSeenAt = Math.max(prev.lastSeenAt, toMs(user.lastSeenAt) || 0);
    }
  }
  return [...map.values()];
}

function buildRecognitionMaps(recognitions, feedbacks) {
  const attemptByKey = new Map();
  for (const row of recognitions) {
    if (!row || !row.key) continue;
    const at = toMs(row.at);
    if (!at) continue;
    attemptByKey.set(row.key, {
      key: row.key,
      userKey: row.userKey || '',
      at,
      candidateCount: Number(row.candidateCount || 0)
    });
  }

  const feedbackByKey = new Map();
  for (const row of feedbacks) {
    if (!row || !row.key || row.outcome === 'report') continue;
    const at = toMs(row.at);
    if (!at) continue;
    const outcome = ['top1', 'not_top', 'none'].includes(row.outcome) ? row.outcome : '';
    feedbackByKey.set(row.key, { key: row.key, userKey: row.userKey || '', at, outcome });
    if (!attemptByKey.has(row.key)) {
      attemptByKey.set(row.key, {
        key: row.key,
        userKey: row.userKey || '',
        at,
        candidateCount: 1
      });
    }
  }
  return { attemptByKey, feedbackByKey };
}

function buildRecognitionWeek(week, attemptByKey, feedbackByKey, attemptLogStartAt, feedbackDataAvailable) {
  const weekAttempts = [...attemptByKey.values()].filter(
    attempt => attempt.at >= week.startAt && attempt.at < week.endAt
  );
  let confirmed = 0;
  let top1 = 0;
  let none = 0;
  let withFeedback = 0;
  let candidateAttempts = 0;
  for (const attempt of weekAttempts) {
    if (attempt.candidateCount > 0) candidateAttempts++;
    const feedback = feedbackByKey.get(attempt.key);
    if (!feedback) continue;
    withFeedback++;
    if (feedback.outcome === 'top1') { confirmed++; top1++; }
    else if (feedback.outcome === 'not_top') confirmed++;
    else if (feedback.outcome === 'none') none++;
  }

  const recognitionCoverageComplete = !!attemptLogStartAt && attemptLogStartAt <= week.startAt;
  const recognitionCoverageStarted = !!attemptLogStartAt && week.endAt > attemptLogStartAt;
  return {
    weekAttempts,
    confirmed,
    top1,
    none,
    withFeedback,
    candidateAttempts,
    recognitionCoverageComplete,
    recognitionCoverageStarted,
    feedbackDataAvailable
  };
}

/**
 * @param {object} input
 * @param {number} input.now
 * @param {Array} input.users       ops_users 行 { userKey, firstSeenAt, lastSeenAt }
 * @param {Array} input.activeDays  ops_days 行 { userKey, day }
 * @param {Array} input.meets       recordMeet 行 { userKey, at }
 * @param {Array} input.favorites   userFavorites 行 { userKey, at }
 * @param {Array} input.recognitions ops_recognitions 行 { key, userKey, at, candidateCount }
 * @param {Array} input.feedbacks   face_feedback 行 { key, userKey, at, outcome }
 * @param {Array} input.entries     ops_entry_usage 行 { name, userKey, day }
 * @param {number} input.weeks      4 / 8 / 12
 */
function analyze(input) {
  const now = toMs(input.now);
  const weekCount = input.weeks || 8;
  const weeks = buildWeeks(now, weekCount);
  const users = dedupeUsers(input.users || []);
  const activeDaysAvailable = input.activeDaysAvailable !== false;
  const feedbackDataAvailable = input.feedbackDataAvailable !== false;

  const firstMeet = firstByUser(input.meets || []);
  const firstFavorite = firstByUser(input.favorites || []);
  const firstRecognition = firstByUser(input.recognitions || []);
  const firstFeedback = firstByUser(input.feedbacks || []);

  const activeDaysByUser = new Map();
  for (const row of input.activeDays || []) {
    if (!row || !row.userKey || !row.day) continue;
    let set = activeDaysByUser.get(row.userKey);
    if (!set) {
      set = new Set();
      activeDaysByUser.set(row.userKey, set);
    }
    set.add(row.day);
  }

  // 历史反馈可能早于 attempts 埋点；将其补成有结果的尝试，保持分母口径。
  const { attemptByKey, feedbackByKey } = buildRecognitionMaps(
    input.recognitions || [],
    input.feedbacks || []
  );

  const trackingStartAt = users.reduce((min, user) => {
    if (!min || user.firstSeenAt < min) return user.firstSeenAt;
    return min;
  }, 0);
  const trackingDays = trackingStartAt
    ? Math.floor((now - trackingStartAt) / DAY_MS) + 1
    : 0;
  const entryPruneReadyAt = trackingStartAt
    ? trackingStartAt + ENTRY_WINDOW_DAYS * DAY_MS
    : 0;
  // ops_recognitions 的上线时刻：在此之前的周只有 face_feedback（没有全量分母），
  // 只能看「已反馈中确认率」，不能把它当成「全部识猫结果确认率」。
  const attemptLogStartAt = toMs(input.attemptLogStartAt) || 0;

  const weekResults = weeks.map((week) => {
    const hasData = !!trackingStartAt && week.endAt > trackingStartAt;
    const isPartial = !!trackingStartAt && trackingStartAt > week.startAt;

    const weekNewUsers = hasData
      ? users.filter(user => user.firstSeenAt >= week.startAt && user.firstSeenAt < week.endAt)
      : [];
    const maturedNewUsers = weekNewUsers.filter(
      user => user.firstSeenAt + OBSERVE_WINDOW_MS <= now
    );

    const activated = [];
    const firstMeetDone = [];
    for (const user of maturedNewUsers) {
      const deadline = user.firstSeenAt + OBSERVE_WINDOW_MS;
      const actions = [
        firstMeet.get(user.userKey),
        firstFavorite.get(user.userKey),
        firstRecognition.get(user.userKey),
        firstFeedback.get(user.userKey)
      ];
      const hasAction = actions.some(at => at && at >= user.firstSeenAt && at <= deadline);
      if (hasAction) activated.push(user.userKey);

      const meetAt = firstMeet.get(user.userKey);
      if (meetAt && meetAt >= user.firstSeenAt && meetAt <= deadline) {
        firstMeetDone.push(user.userKey);
      }
    }

    // 关注后回访：cohort = 首次关注发生在这一周的用户。
    // 回访 = 关注日之后、7 天窗口内，任意一天有 session（ops_days）。
    const followerCohort = [];
    for (const [userKey, favAt] of firstFavorite.entries()) {
      if (favAt >= week.startAt && favAt < week.endAt) followerCohort.push({ userKey, favAt });
    }
    const maturedFollowers = followerCohort.filter(
      follower => follower.favAt + OBSERVE_WINDOW_MS <= now
    );
    const returnedFollowers = maturedFollowers.filter((follower) => {
      const days = activeDaysByUser.get(follower.userKey);
      if (!days || days.size === 0) return false;
      const favDay = opsDayKey(follower.favAt);
      const endDay = opsDayKey(follower.favAt + OBSERVE_WINDOW_MS);
      for (const day of days) {
        if (day > favDay && day <= endDay) return true;
      }
      return false;
    });

    // 识猫按尝试发生周归属；feedback 跟随对应 attempt。
    const recognition = buildRecognitionWeek(
      week, attemptByKey, feedbackByKey, attemptLogStartAt, feedbackDataAvailable
    );
    const {
      weekAttempts, confirmed, top1, none, withFeedback, candidateAttempts,
      recognitionCoverageComplete, recognitionCoverageStarted
    } = recognition;

    return {
      key: week.key,
      label: week.label,
      startAt: week.startAt,
      endAt: week.endAt,
      isCurrent: week.isCurrent,
      hasData,
      isPartial,
      newUsers: hasData ? weekNewUsers.length : null,
      maturedNewUsers: maturedNewUsers.length,
      activatedUsers: activated.length,
      activationRate: rate(activated.length, maturedNewUsers.length),
      firstMeetUsers: firstMeetDone.length,
      firstMeetRate: rate(firstMeetDone.length, maturedNewUsers.length),
      // 关注后回访依赖 ops_days；在埋点上线前的周没有日活明细，
      // 不能把「没有数据」显示成「没人回访」。
      followers: hasData ? followerCohort.length : null,
      maturedFollowers: hasData ? maturedFollowers.length : 0,
      returnedFollowers: hasData ? returnedFollowers.length : 0,
      followReturnDataAvailable: hasData && activeDaysAvailable,
      followReturnRate: hasData && activeDaysAvailable
        ? rate(returnedFollowers.length, maturedFollowers.length)
        : null,
      recognitionAttempts: recognitionCoverageStarted ? weekAttempts.length : null,
      candidateAttempts: recognitionCoverageStarted ? candidateAttempts : null,
      feedbackDataAvailable,
      recognitionFeedbacks: feedbackDataAvailable ? withFeedback : null,
      recognitionConfirmed: feedbackDataAvailable ? confirmed : null,
      recognitionTop1: feedbackDataAvailable ? top1 : null,
      recognitionNone: feedbackDataAvailable ? none : null,
      recognitionCoverageStarted,
      recognitionCoverageComplete,
      // 主指标只在整周都有 attempts 日志、且反馈表可读时给出；
      // 否则用「已反馈中确认率」（反馈表也不可读时返回 null）。
      confirmRate: feedbackDataAvailable && recognitionCoverageComplete
        ? rate(confirmed, weekAttempts.length)
        : null,
      confirmRateAmongCandidates: feedbackDataAvailable && recognitionCoverageComplete
        ? rate(confirmed, candidateAttempts)
        : null,
      feedbackRate: feedbackDataAvailable && recognitionCoverageComplete
        ? rate(withFeedback, weekAttempts.length)
        : null,
      confirmRateAmongFeedback: feedbackDataAvailable
        ? rate(confirmed, withFeedback)
        : null,
      top1Rate: feedbackDataAvailable && recognitionCoverageComplete
        ? rate(top1, weekAttempts.length)
        : null,
      noneRate: feedbackDataAvailable && recognitionCoverageComplete
        ? rate(none, weekAttempts.length)
        : null
    };
  });

  // 入口使用：最近 28 天（不是自然周）—— 每周淘汰看板都复用同一个窗口，
  // 避免「周一刚清零」导致某个入口被误判成无人使用。
  const entrySinceAt = now - ENTRY_WINDOW_DAYS * DAY_MS;
  const entrySinceDay = opsDayKey(entrySinceAt);
  const active28 = new Set();
  for (const row of input.activeDays || []) {
    if (row && row.userKey && row.day && row.day >= entrySinceDay) active28.add(row.userKey);
  }
  for (const user of users) {
    if (user.lastSeenAt >= entrySinceAt) active28.add(user.userKey);
  }

  const entryMap = new Map();
  for (const row of input.entries || []) {
    if (!row || !row.name || !row.userKey || !row.day) continue;
    if (row.day < entrySinceDay) continue;
    let item = entryMap.get(row.name);
    if (!item) {
      item = { name: row.name, users: new Set(), lastDay: '' };
      entryMap.set(row.name, item);
    }
    item.users.add(row.userKey);
    if (row.day > item.lastDay) item.lastDay = row.day;
  }

  const entryItems = [...entryMap.values()]
    .map((item) => {
      const users28 = item.users.size;
      const share = active28.size ? users28 / active28.size : 0;
      let status = 'keep';
      if (!trackingStartAt || now < entryPruneReadyAt) {
        // 不足 28 天时，任何 0 都可能是「还没轮到」，不做淘汰判定。
        status = 'observing';
      } else if (users28 === 0) {
        status = 'unused';
      } else if (active28.size > 0 && share < 0.01) {
        status = 'watch';
      }
      return {
        name: item.name,
        users28,
        share,
        lastDay: item.lastDay,
        status
      };
    })
    .sort((a, b) => b.users28 - a.users28 || (a.name < b.name ? -1 : 1));

  return {
    generatedAt: now,
    weeks: weekResults,
    entries: {
      windowDays: ENTRY_WINDOW_DAYS,
      sinceDay: entrySinceDay,
      activeUsers28: active28.size,
      pruneReady: !!trackingStartAt && now >= entryPruneReadyAt,
      pruneReadyAt: entryPruneReadyAt || null,
      items: entryItems
    },
    coverage: {
      trackingStartAt: trackingStartAt || null,
      trackingDays,
      firstFullWeekStartAt: trackingStartAt
        ? weekStartMs(trackingStartAt) + (trackingStartAt === weekStartMs(trackingStartAt) ? 0 : WEEK_MS)
        : null,
      newUserMetricReadyAt: trackingStartAt ? trackingStartAt + OBSERVE_WINDOW_MS : null,
      entryPruneReadyAt: entryPruneReadyAt || null,
      recognitionLogStartAt: attemptLogStartAt || null,
      activeDaysAvailable,
      feedbackDataAvailable
    }
  };
}

module.exports = {
  DAY_MS,
  WEEK_MS,
  OBSERVE_WINDOW_MS,
  ENTRY_WINDOW_DAYS,
  toMs,
  weekStartMs,
  buildWeeks,
  analyze
};
