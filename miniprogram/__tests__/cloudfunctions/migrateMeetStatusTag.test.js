jest.mock('wx-server-sdk');

describe('migrateMeetStatusTag write safety', () => {
  beforeEach(() => jest.resetModules());

  function prepare() {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    jest.doMock('../../cloudfunctions/migrateMeetStatusTag/utils/auth', () => ({
      checkAdmin: jest.fn().mockResolvedValue({ isAdmin: true })
    }));
    jest.doMock('../../cloudfunctions/migrateMeetStatusTag/common/operationLogger', () => ({
      logOperation: jest.fn().mockResolvedValue(undefined)
    }));
    const update = jest.fn().mockResolvedValue({ stats: { updated: 1 } });
    const query = {
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      get: jest.fn(() => Promise.resolve({ data: [
        { _id: 'meet-1', statusTag: '\u{1F63A} 相遇了' }
      ] }))
    };
    cloud.database.mockReturnValue({
      command: { gt: jest.fn(value => ({ $gt: value })) },
      collection: jest.fn(() => ({
        where: query.where,
        orderBy: query.orderBy,
        limit: query.limit,
        get: query.get,
        doc: jest.fn(() => ({ update }))
      }))
    });
    const { main } = require('../../cloudfunctions/migrateMeetStatusTag/index');
    return { main, update };
  }

  test('defaults to dry-run and never writes without an explicit opt-in', async () => {
    const { main, update } = prepare();
    const result = await main({ target: 'meets' });

    expect(result.success).toBe(true);
    expect(result.data.dryRun).toBe(true);
    expect(result.data.samples[0].after).toBe('相遇了');
    expect(update).not.toHaveBeenCalled();
  });

  test('writes the cleaned value only when dryRun is explicitly false', async () => {
    const { main, update } = prepare();
    const result = await main({ target: 'meets', dryRun: false });

    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledWith({ data: { statusTag: '相遇了' } });
  });
});
