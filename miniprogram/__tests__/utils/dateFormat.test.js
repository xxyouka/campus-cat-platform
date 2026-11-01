const {
  timeAgo,
  formatTimeAgo,
  formatDate,
  formatDateShort,
  formatDateTime,
  toStorageFormat,
  TIME_CONSTANTS
} = require('../../utils/dateFormat');

describe('timeAgo', () => {
  test('should return empty for null/undefined/empty', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(undefined)).toBe('');
    expect(timeAgo('')).toBe('');
  });

  test('should return 刚刚 for <1 minute', () => {
    expect(timeAgo(Date.now() - 30000)).toBe('刚刚');
  });

  test('should return X分钟前 for <1 hour', () => {
    expect(timeAgo(Date.now() - 60000)).toBe('1分钟前');
    expect(timeAgo(Date.now() - 180000)).toBe('3分钟前');
  });

  test('should return X小时前 for <24 hours', () => {
    expect(timeAgo(Date.now() - 3600000)).toBe('1小时前');
    expect(timeAgo(Date.now() - 7200000)).toBe('2小时前');
  });

  test('should return X天前 for <7 days', () => {
    expect(timeAgo(Date.now() - 86400000)).toBe('1天前');
    expect(timeAgo(Date.now() - 172800000)).toBe('2天前');
  });

  test('should return M月D日 for >=7 days', () => {
    const date = new Date(Date.now() - 7 * 86400000);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    expect(timeAgo(Date.now() - 604800000)).toBe(`${month}月${day}日`);
  });

  test('should return 刚刚 for future time', () => {
    expect(timeAgo(Date.now() + 10000)).toBe('刚刚');
  });

  test('should accept Date object', () => {
    expect(timeAgo(new Date(Date.now() - 30000))).toBe('刚刚');
  });

  test('should accept ISO string', () => {
    expect(timeAgo(new Date(Date.now() - 180000).toISOString())).toBe('3分钟前');
  });

  test('should return empty for invalid date string', () => {
    expect(timeAgo('invalid-date')).toBe('');
  });
});

describe('formatTimeAgo', () => {
  test('should be alias of timeAgo', () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 30000)).toBe(timeAgo(now - 30000));
  });
});

describe('formatDate', () => {
  test('should return empty for null/undefined/empty', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
  });

  test('should return 刚刚 for <1 minute', () => {
    expect(formatDate(Date.now() - 30000)).toBe('刚刚');
  });

  test('should return X分钟前 for <1 hour', () => {
    expect(formatDate(Date.now() - 120000)).toBe('2分钟前');
  });

  test('should return X小时前 for <24 hours', () => {
    expect(formatDate(Date.now() - 7200000)).toBe('2小时前');
  });

  test('should return X天前 for <7 days', () => {
    expect(formatDate(Date.now() - 172800000)).toBe('2天前');
  });

  test('should return date string for >=7 days same year', () => {
    const now = new Date();
    const d = new Date(now.getFullYear(), 0, 15);
    const result = formatDate(d);
    expect(result).toMatch(/^\d{2}-\d{2}$/);
  });

  test('should return full date for different year', () => {
    const result = formatDate(new Date('2020-06-20'));
    expect(result).toBe('2020-06-20');
  });

  test('should return empty for invalid date', () => {
    expect(formatDate('invalid')).toBe('');
  });
});

describe('formatDateShort', () => {
  test('should return empty for null/undefined/empty', () => {
    expect(formatDateShort(null)).toBe('');
    expect(formatDateShort(undefined)).toBe('');
    expect(formatDateShort('')).toBe('');
  });

  test('should return MM-DD for same year', () => {
    const now = new Date();
    const date = new Date(now.getFullYear(), 3, 15);
    expect(formatDateShort(date)).toBe('04-15');
  });

  test('should return YYYY-MM-DD for different year', () => {
    expect(formatDateShort(new Date('2020-06-20'))).toBe('2020-06-20');
  });

  test('should return empty for invalid date', () => {
    expect(formatDateShort('invalid')).toBe('');
  });
});

describe('formatDateTime', () => {
  test('should return empty for null/undefined/empty', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
  });

  test('should return YYYY-MM-DD HH:mm format', () => {
    expect(formatDateTime(new Date('2026-04-06T14:30:00'))).toBe('2026-04-06 14:30');
  });

  test('should accept ISO string', () => {
    expect(formatDateTime('2026-04-06T14:30:00')).toBe('2026-04-06 14:30');
  });

  test('should return empty for invalid date', () => {
    expect(formatDateTime('invalid')).toBe('');
  });
});

describe('toStorageFormat', () => {
  test('should return ISO string', () => {
    const result = toStorageFormat(new Date('2026-01-15T10:30:00.000Z'));
    expect(result).toBe('2026-01-15T10:30:00.000Z');
  });

  test('should default to current date', () => {
    const result = toStorageFormat();
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('TIME_CONSTANTS', () => {
  test('should have correct values', () => {
    expect(TIME_CONSTANTS.MINUTE).toBe(60000);
    expect(TIME_CONSTANTS.HOUR).toBe(3600000);
    expect(TIME_CONSTANTS.DAY).toBe(86400000);
    expect(TIME_CONSTANTS.WEEK).toBe(604800000);
  });
});
