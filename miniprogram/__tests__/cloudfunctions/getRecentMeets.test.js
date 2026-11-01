jest.mock('wx-server-sdk');

describe('getRecentMeets bounds and empty fast path', () => {
  beforeEach(() => jest.resetModules());

  function prepare({ total = 1, rows = [] } = {}) {
    const cloud = require('wx-server-sdk');
    const where = jest.fn();
    const count = jest.fn().mockResolvedValue({ total });
    const get = jest.fn().mockResolvedValue({ data: rows });
    const limit = jest.fn();
    const query = {
      count,
      orderBy: jest.fn(() => query),
      limit: jest.fn(value => {
        limit(value);
        return query;
      }),
      get
    };
    where.mockReturnValue(query);
    const collection = jest.fn(() => ({ where }));
    cloud.database.mockReturnValue({ collection });
    const { main } = require('../../cloudfunctions/getRecentMeets/index');
    return { main, where, count, get, limit, collection };
  }

  test('caps the requested list size and maps a valid recent record', async () => {
    const { main, count, get, limit, where } = prepare({
      rows: [{ _id: 'meet-1', statusTag: '吃饭', createTime: 1000, meetTime: 900 }]
    });

    const result = await main({ catId: 'a'.repeat(24), limit: 5000 });

    expect(result.success).toBe(true);
    expect(result.data.meets[0]).toMatchObject({ _id: 'meet-1', createTime: 1000, meetTime: 900 });
    expect(result.data.total).toBe(1);
    expect(limit).toHaveBeenCalledWith(50);
    expect(count).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledWith({ catId: 'a'.repeat(24) });
  });

  test('skips the recent-record query when there are no meets', async () => {
    const { main, count, get } = prepare({ total: 0 });

    const result = await main({ catId: 'b'.repeat(24), limit: 5 });

    expect(result.success).toBe(true);
    expect(result.data.meets).toEqual([]);
    expect(result.data.total).toBe(0);
    expect(count).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  test('rejects an invalid cat ID before accessing the database', async () => {
    const { main, collection } = prepare();

    const result = await main({ catId: { $ne: null } });

    expect(result.success).toBe(false);
    expect(collection).not.toHaveBeenCalled();
  });
});
