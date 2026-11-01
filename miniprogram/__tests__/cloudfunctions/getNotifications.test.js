jest.mock('wx-server-sdk');

describe('getNotifications query concurrency', () => {
  beforeEach(() => jest.resetModules());

  test('starts page, filtered total, and unread count queries before awaiting results', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'user-openid' });
    let resolvePage;
    const countResolvers = [];
    const get = jest.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const count = jest.fn(() => new Promise(resolve => countResolvers.push(resolve)));
    const queryBuilder = condition => {
      const query = {
        where: jest.fn(() => query),
        orderBy: jest.fn(() => query),
        skip: jest.fn(() => query),
        limit: jest.fn(() => query),
        field: jest.fn(() => query),
        get,
        count
      };
      query.condition = condition;
      return query;
    };
    const queries = [];
    cloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(condition => {
          const query = queryBuilder(condition);
          queries.push(query);
          return query;
        })
      }))
    });
    const { main } = require('../../cloudfunctions/getNotifications/index');

    const pending = main({ page: 1, pageSize: 20 });

    expect(get).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(2);
    expect(queries.map(query => query.condition)).toEqual([
      { _openid: 'user-openid' },
      { _openid: 'user-openid' },
      { _openid: 'user-openid', isRead: false }
    ]);

    resolvePage({ data: [] });
    countResolvers[0]({ total: 0 });
    countResolvers[1]({ total: 3 });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.data.unreadCount).toBe(3);
  });
});
