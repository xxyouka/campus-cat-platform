jest.mock('wx-server-sdk');

describe('getCatRank', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('rejects an unbounded or malformed offset before querying the database', async () => {
    const cloud = require('wx-server-sdk');
    const collection = jest.fn();
    cloud.database.mockReturnValue({
      command: { aggregate: {} },
      collection
    });

    const { main } = require('../../cloudfunctions/getCatRank/index');
    const tooLarge = await main({ type: 'view', offset: 10001 });
    const malformed = await main({ type: 'view', offset: '10cats' });

    expect(tooLarge.success).toBe(false);
    expect(malformed.success).toBe(false);
    expect(collection).not.toHaveBeenCalled();
  });

  test('returns a page of view rankings for a valid bounded request', async () => {
    const cloud = require('wx-server-sdk');
    const query = {
      where: jest.fn(() => query),
      field: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      get: jest.fn(() => Promise.resolve({ data: [
        { _id: 'a'.repeat(24), name: '小橘', avatar: 'cloud://avatar', campus: '东区', viewCount: 12 }
      ] }))
    };
    const collection = jest.fn(() => query);
    cloud.database.mockReturnValue({
      command: { aggregate: {}, gt: jest.fn(value => value) },
      collection
    });

    const { main } = require('../../cloudfunctions/getCatRank/index');
    const result = await main({ type: 'view', offset: 0, limit: 20 });

    expect(result.success).toBe(true);
    expect(result.data.list).toEqual([expect.objectContaining({
      rank: 1, catId: 'a'.repeat(24), catName: '小橘', count: 12
    })]);
    expect(query.limit).toHaveBeenCalledWith(20);
  });
});
