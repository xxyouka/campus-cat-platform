jest.mock('wx-server-sdk');

describe('markNotificationRead ownership', () => {
  beforeEach(() => jest.resetModules());

  test('updates only notification IDs owned by the caller', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'caller-openid' });
    const updatedIds = [];
    const query = {
      field: jest.fn(() => query),
      limit: jest.fn(() => query),
      get: jest.fn(() => Promise.resolve({ data: [{ _id: 'owned-id' }] }))
    };
    const collection = jest.fn(() => ({
      where: jest.fn(() => query),
      doc: jest.fn(id => ({
        update: jest.fn(() => {
          updatedIds.push(id);
          return Promise.resolve({ stats: { updated: 1 } });
        })
      }))
    }));
    cloud.database.mockReturnValue({
      command: { in: jest.fn(ids => ({ $in: ids })) },
      collection
    });

    const { main } = require('../../cloudfunctions/markNotificationRead/index');
    const result = await main({ notificationIds: ['owned-id', 'foreign-id'] });

    expect(result.success).toBe(true);
    expect(result.data.updatedCount).toBe(1);
    expect(updatedIds).toEqual(['owned-id']);
    expect(query.get).toHaveBeenCalledTimes(1);
  });
});
