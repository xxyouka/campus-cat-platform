jest.mock('wx-server-sdk');

describe('getMyMeetCount input validation', () => {
  beforeEach(() => jest.resetModules());

  function prepare() {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'current-user' });
    const where = jest.fn();
    const count = jest.fn().mockResolvedValue({ total: 7 });
    where.mockReturnValue({ count });
    cloud.database.mockReturnValue({
      command: {
        gte: jest.fn(value => ({ and: other => ({ $and: [value, other] }) })),
        lt: jest.fn(value => ({ $lt: value }))
      },
      collection: jest.fn(() => ({ where }))
    });
    const { main } = require('../../cloudfunctions/getMyMeetCount/index');
    return { main, where, count };
  }

  test('rejects impossible calendar dates and operator-shaped cat IDs before querying', async () => {
    const { main, where } = prepare();

    const impossibleDate = await main({ date: '2026-02-31' });
    const invalidCatId = await main({ catId: { $ne: null } });

    expect(impossibleDate.success).toBe(false);
    expect(invalidCatId.success).toBe(false);
    expect(where).not.toHaveBeenCalled();
  });

  test('uses the exact Beijing calendar-day range for a valid leap day', async () => {
    const { main, where, count } = prepare();

    const result = await main({ catId: 'a'.repeat(24), date: '2024-02-29' });

    expect(result.success).toBe(true);
    expect(result.data.count).toBe(7);
    expect(where).toHaveBeenCalledWith({
      _openid: 'current-user',
      catId: 'a'.repeat(24),
      meetTime: { $and: [
        Date.parse('2024-02-28T16:00:00.000Z'),
        { $lt: Date.parse('2024-02-29T16:00:00.000Z') }
      ] }
    });
    expect(count).toHaveBeenCalledTimes(1);
  });
});
