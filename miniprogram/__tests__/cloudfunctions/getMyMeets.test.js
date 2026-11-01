jest.mock('wx-server-sdk');

describe('getMyMeets query concurrency', () => {
  beforeEach(() => jest.resetModules());

  test('starts the caller-scoped page and count queries together', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'current-user' });
    let resolvePage;
    let resolveCount;
    const get = jest.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const count = jest.fn(() => new Promise(resolve => { resolveCount = resolve; }));
    const conditions = [];
    const db = {
      command: { in: jest.fn(ids => ({ $in: ids })) },
      collection: jest.fn(() => ({
        where: jest.fn(condition => {
          conditions.push(condition);
          const query = {
            orderBy: jest.fn(() => query),
            skip: jest.fn(() => query),
            limit: jest.fn(() => query),
            count,
            get
          };
          return query;
        })
      }))
    };
    cloud.database.mockReturnValue(db);
    const { main } = require('../../cloudfunctions/getMyMeets/index');

    const pending = main({ page: 1, pageSize: 20 });

    expect(count).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(conditions).toEqual([
      { _openid: 'current-user' },
      { _openid: 'current-user' }
    ]);

    resolveCount({ total: 0 });
    resolvePage({ data: [] });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.data.total).toBe(0);
  });
});
