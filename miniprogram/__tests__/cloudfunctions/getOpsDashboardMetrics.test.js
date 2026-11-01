/**
 * 运营面板口径回归（纯计算层）
 *
 * 这里锁的是「率」的分母与窗口，不是数字好不好看：
 *   1. 新用户只算首见落在本周的人；未满 7 天的 cohort 不进分母；
 *   2. 首个打卡完成率是激活的子集，但两者都不能把「还没到 7 天」算成「没做」；
 *   3. 关注后回访必须是**另一天**，同一天再打开不算；
 *   4. 识猫确认率的分母是全部识猫结果；结果日志不完整时主指标必须为空，
 *      不能退化成「已反馈中确认率」还冒充全量；
 *   5. 入口淘汰在满 28 天前一律「观测中」，不能因为数据少就判 0 使用。
 */
const { analyze, weekStartMs, buildWeeks } = require('../../cloudfunctions/getOpsDashboard/metrics');

/** 北京时间某日某点 → 毫秒时间戳 */
function bj(y, m, d, hour = 0) {
  return Date.UTC(y, m - 1, d, hour) - 8 * 3600 * 1000;
}

const NOW = bj(2026, 10, 22, 12); // 周四中午，当前周从 10-19 开始

function baseInput(overrides = {}) {
  return {
    now: NOW,
    weeks: 4,
    users: [
      { userKey: 'u1', firstSeenAt: bj(2026, 10, 6, 10), lastSeenAt: bj(2026, 10, 10, 10) },
      { userKey: 'u2', firstSeenAt: bj(2026, 10, 7, 10), lastSeenAt: bj(2026, 10, 12, 10) },
      { userKey: 'u3', firstSeenAt: bj(2026, 10, 8, 10), lastSeenAt: bj(2026, 10, 8, 12) },
      { userKey: 'u4', firstSeenAt: bj(2026, 10, 20, 10), lastSeenAt: bj(2026, 10, 20, 10) },
      // 只用来把观测起点推到 9 月，保证前几周都有数据
      { userKey: 'old', firstSeenAt: bj(2026, 9, 20, 10), lastSeenAt: bj(2026, 9, 20, 10) }
    ],
    activeDays: [
      { userKey: 'u1', day: '2026-10-06' },
      { userKey: 'u1', day: '2026-10-10' },
      { userKey: 'u2', day: '2026-10-07' },
      { userKey: 'u2', day: '2026-10-09' },
      { userKey: 'u2', day: '2026-10-10' },
      { userKey: 'u3', day: '2026-10-08' },
      { userKey: 'u4', day: '2026-10-20' }
    ],
    meets: [
      { userKey: 'u1', at: bj(2026, 10, 8, 9) }
    ],
    favorites: [
      { userKey: 'u2', at: bj(2026, 10, 9, 23) }
    ],
    recognitions: [
      { key: 'a1', userKey: 'u2', at: bj(2026, 10, 10, 10), candidateCount: 2 },
      { key: 'a2', userKey: 'u1', at: bj(2026, 10, 11, 10), candidateCount: 1 },
      // 观测起点前就在用的老用户，不应影响本周新用户 cohort
      { key: 'a3', userKey: 'old', at: bj(2026, 10, 11, 10), candidateCount: 0 }
    ],
    feedbacks: [
      { key: 'a1', userKey: 'u2', at: bj(2026, 10, 10, 10), outcome: 'top1' },
      { key: 'a2', userKey: 'u1', at: bj(2026, 10, 11, 11), outcome: 'none' }
    ],
    entries: [
      { name: 'rank', userKey: 'u1', day: '2026-10-19' },
      { name: 'rank', userKey: 'u2', day: '2026-10-20' }
    ],
    attemptLogStartAt: bj(2026, 9, 1),
    ...overrides
  };
}

function weekByKey(result, key) {
  return result.weeks.find(w => w.key === key);
}

describe('运营面板纯计算层', () => {
  test('周起点按北京时间周一 0 点计算', () => {
    // 北京时间周四 12:00 → 本周一 10-19 00:00（UTC 10-18 16:00）
    expect(weekStartMs(NOW)).toBe(bj(2026, 10, 19, 0));
    const weeks = buildWeeks(NOW, 4);
    expect(weeks.map(w => w.key)).toEqual([
      '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'
    ]);
    expect(weeks[3].isCurrent).toBe(true);
  });

  test('新用户激活 / 首个打卡：只算满 7 天的 cohort，且打卡是激活的子集', () => {
    const result = analyze(baseInput());
    const week = weekByKey(result, '2026-10-05');

    expect(week.newUsers).toBe(3);           // u1/u2/u3
    expect(week.maturedNewUsers).toBe(3);
    expect(week.activatedUsers).toBe(2);     // u1 打卡、u2 关注；u3 没动作
    expect(week.activationRate).toBeCloseTo(2 / 3, 6);
    expect(week.firstMeetUsers).toBe(1);     // 只有 u1 在 7 天内打卡
    expect(week.firstMeetRate).toBeCloseTo(1 / 3, 6);
  });

  test('当前周新用户未满 7 天：人数照常显示，率值必须是 null 而不是 0', () => {
    const result = analyze(baseInput());
    const week = weekByKey(result, '2026-10-19');

    expect(week.newUsers).toBe(1);           // u4
    expect(week.maturedNewUsers).toBe(0);
    expect(week.activationRate).toBeNull();
    expect(week.firstMeetRate).toBeNull();
  });

  test('关注后回访只认关注日之后的另一天；同一天再打开不算', () => {
    const result = analyze(baseInput());
    const week = weekByKey(result, '2026-10-05');

    expect(week.followers).toBe(1);
    expect(week.maturedFollowers).toBe(1);
    expect(week.returnedFollowers).toBe(1);  // 10-09 关注 → 10-10 回访
    expect(week.followReturnRate).toBe(1);
  });

  test('关注当天多次活跃但没有次日回访 → 回访率为 0，不是 null', () => {
    const input = baseInput({
      activeDays: [
        { userKey: 'u2', day: '2026-10-09' }
      ]
    });
    const week = weekByKey(analyze(input), '2026-10-05');
    expect(week.maturedFollowers).toBe(1);
    expect(week.returnedFollowers).toBe(0);
    expect(week.followReturnRate).toBe(0);
  });

  test('识猫确认率：分母是全部识猫结果，未反馈也计入', () => {
    const result = analyze(baseInput());
    const week = weekByKey(result, '2026-10-05');

    expect(week.recognitionAttempts).toBe(3);
    expect(week.recognitionFeedbacks).toBe(2);
    expect(week.recognitionConfirmed).toBe(1);   // top1 算确认，none 不算
    expect(week.confirmRate).toBeCloseTo(1 / 3, 6);
    expect(week.feedbackRate).toBeCloseTo(2 / 3, 6);
    expect(week.confirmRateAmongFeedback).toBeCloseTo(1 / 2, 6);
    expect(week.top1Rate).toBeCloseTo(1 / 3, 6);
    expect(week.noneRate).toBeCloseTo(1 / 3, 6);
  });

  test('「认不出」上报不进入反馈分母', () => {
    const base = baseInput();
    const input = baseInput({
      feedbacks: base.feedbacks.concat([{
        key: 'r1',
        userKey: 'u2',
        at: bj(2026, 10, 10, 12),
        outcome: 'report'
      }])
    });
    const week = weekByKey(analyze(input), '2026-10-05');

    expect(week.recognitionFeedbacks).toBe(2);
    expect(week.confirmRateAmongFeedback).toBeCloseTo(1 / 2, 6);
  });

  test('识猫结果日志未覆盖整周：主确认率必须为空，只保留已反馈口径', () => {
    const input = baseInput({ attemptLogStartAt: bj(2026, 10, 20) });
    const week = weekByKey(analyze(input), '2026-10-19');
    expect(week.recognitionCoverageComplete).toBe(false);
    expect(week.confirmRate).toBeNull();
    // 当前周没有识猫记录；再补一条验证已反馈口径仍然可用
    const withAttempt = analyze(baseInput({
      attemptLogStartAt: bj(2026, 10, 20),
      recognitions: [{ key: 'c1', userKey: 'u4', at: bj(2026, 10, 20, 11), candidateCount: 1 }],
      feedbacks: [{ key: 'c1', userKey: 'u4', at: bj(2026, 10, 20, 11), outcome: 'not_top' }]
    }));
    const current = weekByKey(withAttempt, '2026-10-19');
    expect(current.confirmRate).toBeNull();
    expect(current.confirmRateAmongFeedback).toBe(1);
  });

  test('观测起点之前的周：新用户与回访都标为无数据，不能显示成 0', () => {
    const input = baseInput({
      users: [
        { userKey: 'u1', firstSeenAt: bj(2026, 10, 6, 10), lastSeenAt: bj(2026, 10, 10, 10) }
      ],
      activeDays: [{ userKey: 'u1', day: '2026-10-06' }],
      favorites: [],
      recognitions: [],
      feedbacks: []
    });
    const result = analyze(input);
    const before = weekByKey(result, '2026-09-28');
    expect(before.hasData).toBe(false);
    expect(before.newUsers).toBeNull();
    expect(before.followReturnRate).toBeNull();
  });

  test('入口使用：满 28 天前一律观测中；满 28 天后 0 使用才是淘汰候选', () => {
    const observing = analyze(baseInput({
      users: [
        { userKey: 'u1', firstSeenAt: bj(2026, 10, 10), lastSeenAt: bj(2026, 10, 20) },
        { userKey: 'u2', firstSeenAt: bj(2026, 10, 10), lastSeenAt: bj(2026, 10, 20) }
      ],
      activeDays: [
        { userKey: 'u1', day: '2026-10-20' },
        { userKey: 'u2', day: '2026-10-20' }
      ],
      entries: [{ name: 'rank', userKey: 'u1', day: '2026-10-20' }]
    }));
    expect(observing.entries.pruneReady).toBe(false);
    expect(observing.entries.items[0].status).toBe('observing');

    const ready = analyze(baseInput());
    expect(ready.entries.pruneReady).toBe(true);
    expect(ready.entries.activeUsers28).toBeGreaterThan(0);
    expect(ready.entries.items[0].name).toBe('rank');
    expect(ready.entries.items[0].status).toBe('keep');
  });

  test('入口 share 低于活跃用户 1% → 观察；0 使用 → 淘汰候选', () => {
    const users = [];
    const activeDays = [];
    for (let i = 0; i < 200; i++) {
      const key = `m${i}`;
      users.push({ userKey: key, firstSeenAt: bj(2026, 9, 1), lastSeenAt: bj(2026, 10, 20) });
      activeDays.push({ userKey: key, day: '2026-10-20' });
    }
    const input = baseInput({
      users,
      activeDays,
      meets: [],
      favorites: [],
      recognitions: [],
      feedbacks: [],
      entries: [{ name: 'help', userKey: 'm0', day: '2026-10-20' }]
    });
    const result = analyze(input);
    expect(result.entries.activeUsers28).toBe(200);
    expect(result.entries.items[0].share).toBeCloseTo(0.005, 6);
    expect(result.entries.items[0].status).toBe('watch');
  });
});
