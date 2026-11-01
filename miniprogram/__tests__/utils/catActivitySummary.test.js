/**
 * __tests__/utils/catActivitySummary.test.js（被测模块随管理端下沉到 pages/admin/utils/）
 *
 * 展示层装配（结论句 / 离散度文案 / 聚集圈合并 / 脚注）的回归。
 * 这些函数决定了页面上「人话」的每一句，口径改了必须留下痕迹：
 *   - 结论句缺哪块就少说一句，不硬凑（小样本不许被读成规律）；
 *   - 聚集圈同名合并按次数加权取中心，无名圈不许合并（可能是相隔很远的两个点）；
 *   - 脚注把样本量摊开讲，含截断与点位采样。
 */
const summary = require('../../pages/admin/utils/catActivitySummary');

describe('pages/admin/utils/catActivitySummary', () => {
  describe('rangeText / weekLabel / formatMeetTime', () => {
    test('时间窗文案：days>0 走「近 N 天」，0 是全部', () => {
      expect(summary.rangeText(30)).toBe('近30天');
      expect(summary.rangeText(90)).toBe('近90天');
      expect(summary.rangeText(0)).toBe('全部记录');
    });

    test('星期：1=周一 … 7=周日，越界返回空串', () => {
      expect(summary.weekLabel(1)).toBe('周一');
      expect(summary.weekLabel(6)).toBe('周六');
      expect(summary.weekLabel(7)).toBe('周日');
      expect(summary.weekLabel(0)).toBe('');
      expect(summary.weekLabel(8)).toBe('');
    });

    test('时间格式：MM-DD HH:mm，非法时间戳返回空串', () => {
      // 用本地时间构造 + 本地读取，断言不受测试机时区影响
      const ts = new Date(2026, 5, 1, 9, 5).getTime();
      expect(summary.formatMeetTime(ts)).toBe('06-01 09:05');
      expect(summary.formatMeetTime(NaN)).toBe('');
    });
  });

  describe('spreadLabel / topBlock / topTag', () => {
    test('离散度阈值：越集中措辞越确定，非法值不评价', () => {
      expect(summary.spreadLabel(0.03)).toBe('活动范围很集中');
      expect(summary.spreadLabel(0.06)).toBe('活动范围很集中');
      expect(summary.spreadLabel(0.1)).toBe('活动范围比较集中');
      expect(summary.spreadLabel(0.2)).toBe('活动范围比较大');
      expect(summary.spreadLabel(0.4)).toBe('活动范围很广');
      expect(summary.spreadLabel(null)).toBe('');
      expect(summary.spreadLabel(NaN)).toBe('');
    });

    test('topBlock：次数最多的时段；并列取展示顺序靠前者；全 0 返回 null', () => {
      const blocks = [
        { key: 'dawn', label: '清晨', count: 2 },
        { key: 'morning', label: '上午', count: 5 },
        { key: 'night', label: '深夜', count: 5 }
      ];
      expect(summary.topBlock(blocks).label).toBe('上午');
      expect(summary.topBlock(blocks.map((b) => ({ ...b, count: 0 })))).toBeNull();
      expect(summary.topBlock(null)).toBeNull();
    });

    test('topTag：同样的并列口径', () => {
      const tags = [{ text: '相遇了', count: 3 }, { text: '在睡觉', count: 3 }];
      expect(summary.topTag(tags).text).toBe('相遇了');
      expect(summary.topTag([])).toBeNull();
    });
  });

  describe('buildConclusion', () => {
    const totals = { meets: 10, activeDays: 6, withPoint: 4 };
    const blocks = [{ key: 'dusk', label: '傍晚', count: 6 }, { key: 'night', label: '深夜', count: 4 }];
    const locations = [{ text: '食堂旁', count: 5 }];

    test('信息齐时逐句拼出：次数/天数、时段、场景、地点、范围', () => {
      const text = summary.buildConclusion({
        rangeDays: 90,
        totals,
        blocks,
        tags: [{ text: '在睡觉', count: 6 }, { text: '相遇了', count: 4 }],
        locations,
        spreadP90: 0.1
      });
      expect(text).toBe('近90天相遇 10 次，出现在 6 天里，多在傍晚出没，最多的相遇场景是「在睡觉」，常出现在「食堂旁」，活动范围比较集中。');
    });

    test('默认标签「相遇了」占多数时不点名场景（等于没说），看到 1 次的自定义标签也不点名', () => {
      const onlyDefault = summary.buildConclusion({ totals, blocks, tags: [{ text: '相遇了', count: 10 }] });
      expect(onlyDefault).not.toContain('相遇场景');

      // 默认标签更多时同样不点名，避免把「在睡觉」说成「最多的场景」
      const dominated = summary.buildConclusion({
        totals,
        blocks,
        tags: [{ text: '相遇了', count: 6 }, { text: '在睡觉', count: 4 }]
      });
      expect(dominated).not.toContain('相遇场景');

      const once = summary.buildConclusion({ totals, blocks, tags: [{ text: '在开会', count: 1 }] });
      expect(once).not.toContain('相遇场景');
    });

    test('没有相遇记录 → 空串（页面走空态，不显示半句话）', () => {
      expect(summary.buildConclusion({ rangeDays: 90, totals: { meets: 0 } })).toBe('');
      expect(summary.buildConclusion()).toBe('');
    });

    test('点位不足 3 个时不说「范围集中/分散」', () => {
      const text = summary.buildConclusion({
        rangeDays: 30,
        totals: { meets: 2, activeDays: 1, withPoint: 2 },
        spreadP90: 0.02
      });
      expect(text).toBe('近30天相遇 2 次。');
    });

    test('只有 1 天数据时不写「出现在 N 天里」（1 天不是规律）', () => {
      const text = summary.buildConclusion({ rangeDays: 30, totals: { meets: 1, activeDays: 1 } });
      expect(text).toBe('近30天相遇 1 次。');
    });
  });

  describe('mergeNamedClusters', () => {
    test('同名聚集圈合并：次数相加、中心按次数加权、半径取最大', () => {
      const merged = summary.mergeNamedClusters([
        { u: 0.4, v: 0.4, count: 1, radius: 0.01 },
        { u: 0.5, v: 0.5, count: 3, radius: 0.02 }
      ], () => '食堂');
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({
        name: '食堂',
        label: '食堂一带',
        count: 4,
        u: 0.475,
        v: 0.475,
        radius: 0.02
      });
    });

    test('无名圈不合并（可能相隔很远，强行合并等于编造位置）', () => {
      const merged = summary.mergeNamedClusters([
        { u: 0.1, v: 0.1, count: 3 },
        { u: 0.9, v: 0.9, count: 4 }
      ], () => '');
      expect(merged).toHaveLength(2);
      expect(merged.map((c) => c.label)).toEqual(['校园内某处', '校园内某处']);
      // 按次数降序，且各自保留自己的坐标
      expect(merged[0]).toMatchObject({ count: 4, u: 0.9 });
      expect(merged[1]).toMatchObject({ count: 3, u: 0.1 });
    });

    test('命名函数缺失 / 空输入 / 脏数据都不抛错', () => {
      expect(summary.mergeNamedClusters(undefined, () => '食堂')).toEqual([]);
      expect(summary.mergeNamedClusters([null, { u: 0.1, v: 0.1, count: 0 }], () => '食堂')).toEqual([]);
      expect(summary.mergeNamedClusters([{ u: 0.2, v: 0.2, count: 2 }]).at(0).label).toBe('校园内某处');
    });
  });

  describe('buildFootnote', () => {
    test('常规样本：扫过条数 + 地点/点位条数', () => {
      const lines = summary.buildFootnote({
        totals: { withLocation: 5, withPoint: 8, defaultLocation: 0 },
        range: { scanned: 20, truncated: false },
        points: { sampled: false, items: [] }
      });
      expect(lines).toEqual([
        '时间窗内共扫过 20 条相遇记录',
        '其中 5 条填了具体地点、8 条在打卡时选了地图位置'
      ]);
    });

    test('截断 / 默认地点 / 点位采样 / 点位过少都会写明', () => {
      const lines = summary.buildFootnote({
        totals: { withLocation: 2, withPoint: 2, defaultLocation: 7 },
        range: { scanned: 5000, truncated: true, maxScan: 5000 },
        points: { sampled: true, items: new Array(1500).fill({}) }
      });
      expect(lines).toContain('记录量超过 5000 条，本次只分析了最近的部分');
      expect(lines).toContain('另有 7 条没填具体地点（默认「校园内」），未计入地点榜');
      expect(lines).toContain('地图点位较多，只画了最近 1500 个点');
      expect(lines).toContain('地图点位样本还太少，活动范围图仅供参考，会随打卡越来越准');
    });

    test('全空输入也给两行可读文案（不出现 undefined）', () => {
      const lines = summary.buildFootnote();
      expect(lines).toEqual(['时间窗内共扫过 0 条相遇记录', '其中 0 条填了具体地点、0 条在打卡时选了地图位置']);
    });
  });

  describe('总轨迹：配色与脚注', () => {
    test('trailColorFor：同一 catId 永远同色，且取自色板', () => {
      const c = summary.trailColorFor('aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(c).toBe(summary.trailColorFor('aaaaaaaaaaaaaaaaaaaaaaaa'));
      expect(summary.TRAIL_COLORS).toContain(c);
      // 空 id 也必须有确定的颜色（渲染不用特判）
      expect(summary.TRAIL_COLORS).toContain(summary.trailColorFor(''));
      expect(summary.TRAIL_COLORS.length).toBeGreaterThanOrEqual(8);
    });

    test('buildTrailFootnote：截断 / 猫数上限 / 单猫采样各有各的说法', () => {
      const lines = summary.buildTrailFootnote({
        range: { scanned: 12000, truncated: true, maxScan: 10000, maxTrailPoints: 200 },
        totals: { points: 9000, cats: 65, catsTruncated: true, returned: 60 },
        sampledCats: 2
      });
      expect(lines[0]).toBe('时间窗内共扫过 12000 条相遇记录');
      expect(lines).toContain('记录量超过 10000 条，本次只覆盖了最新的部分');
      expect(lines).toContain('其中 9000 条打卡选了地图位置，来自 65 只猫');
      expect(lines).toContain('带位置的猫较多，图上只画了最近活跃的 60 只');
      expect(lines).toContain('有 2 只猫的点位过多，每只最多画最近 200 个点');
    });

    test('buildTrailFootnote：常规样本不多话；点位太少如实提示；全空可读', () => {
      const few = summary.buildTrailFootnote({
        range: { scanned: 5, truncated: false, maxScan: 10000, maxTrailPoints: 200 },
        totals: { points: 2, cats: 1, catsTruncated: false, returned: 1 }
      });
      expect(few).toEqual([
        '时间窗内共扫过 5 条相遇记录',
        '其中 2 条打卡选了地图位置，来自 1 只猫',
        '地图点位样本还太少，轨迹图会随打卡越来越准'
      ]);
      expect(summary.buildTrailFootnote()).toEqual([
        '时间窗内共扫过 0 条相遇记录',
        '其中 0 条打卡选了地图位置，来自 0 只猫'
      ]);
    });
  });
});
