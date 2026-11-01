/**
 * __tests__/cloudfunctions/beijingTime.test.js
 * 东八区日期工具测试：重点覆盖云函数容器 UTC 环境下
 * 北京时间 0:00-8:00 的记录被错误归到前一天的回归场景（审查报告 P2-2）。
 */
const {
  BEIJING_OFFSET_MS,
  toBeijingDate,
  beijingMonthRange,
  beijingTodayStart,
  beijingDayKey
} = require('../../cloudfunctions/utils/beijingTime');

describe('beijingTime 东八区日期工具', () => {
  describe('BEIJING_OFFSET_MS', () => {
    test('固定偏移为 8 小时', () => {
      expect(BEIJING_OFFSET_MS).toBe(8 * 3600 * 1000);
    });
  });

  describe('toBeijingDate', () => {
    test('UTC 16:30 = 北京时间次日 0:30（getUTC 字段读墙上时间）', () => {
      // 2026-09-11T16:30:00Z（北京时间 2026-09-12 00:30）
      const ts = Date.UTC(2026, 8, 11, 16, 30, 0);
      const bj = toBeijingDate(ts);
      expect(bj.getUTCFullYear()).toBe(2026);
      expect(bj.getUTCMonth()).toBe(8); // 9 月
      expect(bj.getUTCDate()).toBe(12);
      expect(bj.getUTCHours()).toBe(0);
      expect(bj.getUTCMinutes()).toBe(30);
    });

    test('UTC 15:59 = 北京时间当日 23:59，仍归当天', () => {
      const ts = Date.UTC(2026, 8, 11, 15, 59, 0);
      const bj = toBeijingDate(ts);
      expect(bj.getUTCDate()).toBe(11);
      expect(bj.getUTCHours()).toBe(23);
    });
  });

  describe('beijingMonthRange', () => {
    test('2026 年 9 月（month=8）边界为北京时间 9-1 00:00 至 10-1 00:00', () => {
      const { end } = beijingMonthRange(2026, 8);
      expect(beijingMonthRange(2026, 8).start).toBe(Date.UTC(2026, 8, 1) - BEIJING_OFFSET_MS);
      expect(end).toBe(Date.UTC(2026, 9, 1) - BEIJING_OFFSET_MS);
    });

    test('跨年：2026 年 12 月（month=11）end 落在 2027-01-01', () => {
      const { end } = beijingMonthRange(2026, 11);
      expect(end).toBe(Date.UTC(2027, 0, 1) - BEIJING_OFFSET_MS);
    });
  });

  describe('beijingTodayStart', () => {
    afterEach(() => jest.useRealTimers());

    test('北京时间当天任意时刻都归到北京时间 0 点', () => {
      jest.useFakeTimers();
      // 北京时间 2026-09-12 07:59（UTC 2026-09-11 23:59）——容器本地日期仍是"前一天"
      jest.setSystemTime(Date.UTC(2026, 8, 11, 23, 59, 0));
      expect(beijingTodayStart()).toBe(Date.UTC(2026, 8, 12) - BEIJING_OFFSET_MS);

      // 北京时间 2026-09-12 00:00 整
      jest.setSystemTime(Date.UTC(2026, 8, 11, 16, 0, 0));
      expect(beijingTodayStart()).toBe(Date.UTC(2026, 8, 12) - BEIJING_OFFSET_MS);
    });
  });

  describe('beijingDayKey', () => {
    // 键格式沿用 getMeetCalendar 原实现（getMonth 为 0 基月份），保证 allDays/streak 键口径不变
    test('0:00-8:00 的打卡归到当天而不是前一天（核心回归）', () => {
      // 北京时间 2026-09-12 00:30 打卡（UTC 2026-09-11 16:30）
      const ts = Date.UTC(2026, 8, 11, 16, 30, 0);
      expect(beijingDayKey(ts)).toBe('2026-8-12');
    });

    test('23:59 的打卡归当天', () => {
      // 北京时间 2026-09-11 23:59（UTC 15:59）
      const ts = Date.UTC(2026, 8, 11, 15, 59, 0);
      expect(beijingDayKey(ts)).toBe('2026-8-11');
    });

    test('接受 Date 入参', () => {
      const d = new Date(Date.UTC(2026, 8, 11, 16, 30, 0));
      expect(beijingDayKey(d)).toBe('2026-8-12');
    });
  });
});
