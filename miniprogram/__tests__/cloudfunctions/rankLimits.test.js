jest.mock('wx-server-sdk');

function makeDatabase() {
  const limit = jest.fn();
  const pipeline = {
    group: jest.fn(() => pipeline),
    sort: jest.fn(() => pipeline),
    limit,
    end: jest.fn(() => Promise.resolve({ list: [] }))
  };
  return {
    db: {
      command: { aggregate: { sum: jest.fn(v => v), max: jest.fn(v => v) } },
      collection: jest.fn(() => ({ aggregate: jest.fn(() => pipeline) }))
    },
    limit
  };
}

describe('management ranking limit validation', () => {
  beforeEach(() => jest.resetModules());

  test('getMeetRank bounds excessive limits and defaults malformed values', async () => {
    const cloud = require('wx-server-sdk');
    const { db, limit } = makeDatabase();
    cloud.database.mockReturnValue(db);
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin' });
    jest.doMock('../../cloudfunctions/getMeetRank/utils/auth', () => ({
      checkAdmin: jest.fn().mockResolvedValue({ isAdmin: true })
    }));
    const { main } = require('../../cloudfunctions/getMeetRank/index');

    await main({ limit: 1000 });
    await main({ limit: -1 });
    await main({ limit: 'many' });
    expect(limit.mock.calls.map(([value]) => value)).toEqual([100, 50, 50]);
  });

  test('getFavRank bounds excessive limits and defaults malformed values', async () => {
    const cloud = require('wx-server-sdk');
    const { db, limit } = makeDatabase();
    cloud.database.mockReturnValue(db);
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin' });
    jest.doMock('../../cloudfunctions/getFavRank/utils/auth', () => ({
      checkAdmin: jest.fn().mockResolvedValue({ isAdmin: true })
    }));
    const { main } = require('../../cloudfunctions/getFavRank/index');

    await main({ limit: 1000 });
    await main({ limit: -1 });
    await main({ limit: 'many' });
    expect(limit.mock.calls.map(([value]) => value)).toEqual([100, 50, 50]);
  });
});
