jest.mock('wx-server-sdk');

describe('getNotices public listing contract', () => {
  beforeEach(() => jest.resetModules());

  function setupDatabase({ notices = [], total = notices.length, getError, countError } = {}) {
    const query = {
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      get: jest.fn(() => getError ? Promise.reject(getError) : Promise.resolve({ data: notices })),
      count: jest.fn(() => countError ? Promise.reject(countError) : Promise.resolve({ total }))
    };
    const collection = jest.fn(() => query);
    const command = {
      or: jest.fn(conditions => ({ $or: conditions })),
      exists: jest.fn(value => ({ $exists: value }))
    };
    const cloud = require('wx-server-sdk');
    const db = { command, collection };
    cloud.database.mockReturnValue(db);
    return { db, query, command };
  }

  test('lists published and legacy notices with bounded pagination metadata', async () => {
    const notices = [{ _id: 'notice-1', status: 'published', title: '公告' }];
    const { db, query, command } = setupDatabase({ notices, total: 21 });
    const { main } = require('../../cloudfunctions/getNotices/index');

    const result = await main({ page: 2, pageSize: 10 });

    expect(command.or).toHaveBeenCalledWith([
      { status: 'published' },
      { status: { $exists: false } }
    ]);
    expect(db.collection).toHaveBeenCalledTimes(2);
    expect(query.where).toHaveBeenCalledTimes(2);
    expect(query.orderBy).toHaveBeenCalledWith('createTime', 'desc');
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(result.data).toEqual({ notices, total: 21, page: 2, pageSize: 10, hasMore: true });
  });

  test('caps pagination to prevent oversized scans', async () => {
    const { query } = setupDatabase({ notices: [], total: 0 });
    const { main } = require('../../cloudfunctions/getNotices/index');

    const result = await main({ page: 9999, pageSize: 500 });

    expect(query.skip).toHaveBeenCalledWith(99900);
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(result.data).toMatchObject({ page: 1000, pageSize: 100, hasMore: false });
  });

  test('latestOnly fetches one notice without running a collection count', async () => {
    const notices = [{ _id: 'latest', status: 'published', createTime: '2026-10-31' }];
    const { db, query } = setupDatabase({ notices, total: 99 });
    const { main } = require('../../cloudfunctions/getNotices/index');

    const result = await main({ latestOnly: true });

    expect(db.collection).toHaveBeenCalledTimes(1);
    expect(query.count).not.toHaveBeenCalled();
    expect(query.skip).not.toHaveBeenCalled();
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(result.data).toEqual({ notices, page: 1, pageSize: 1 });
  });

  test('normalizes a missing event and uses default pagination', async () => {
    const { query } = setupDatabase({ notices: [], total: 0 });
    const { main } = require('../../cloudfunctions/getNotices/index');

    const result = await main(undefined);

    expect(query.skip).toHaveBeenCalledWith(0);
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ page: 1, pageSize: 20 });
  });

  test('returns a standard failure response when the database query fails', async () => {
    const { query } = setupDatabase({ getError: new Error('database unavailable') });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { main } = require('../../cloudfunctions/getNotices/index');

    const result = await main({});

    expect(query.get).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe('获取公告失败，请稍后重试');
  });
});
