jest.mock('wx-server-sdk');

describe('recordView write reliability', () => {
  let cloud;
  let main;
  let update;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'visitor-openid' });
    update = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
    cloud.database.mockReturnValue({
      command: { inc: jest.fn(value => ({ $inc: value })) },
      collection: jest.fn(() => ({ doc: jest.fn(() => ({ update })) }))
    });
    main = require('../../cloudfunctions/recordView/index').main;
  });

  test('database failure is not cached, so retry can record the view', async () => {
    update
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValueOnce({ stats: { updated: 1 } });

    const failed = await main({ catId: 'a'.repeat(24) });
    const retried = await main({ catId: 'a'.repeat(24) });

    expect(failed.success).toBe(false);
    expect(retried.success).toBe(true);
    expect(retried.data.duplicated).toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
  });

  test('concurrent requests for the same user and cat increment once', async () => {
    let resolveWrite;
    update.mockImplementation(() => new Promise(resolve => { resolveWrite = resolve; }));

    const first = main({ catId: 'b'.repeat(24) });
    const second = main({ catId: 'b'.repeat(24) });
    resolveWrite({ stats: { updated: 1 } });
    const [a, b] = await Promise.all([first, second]);

    expect(update).toHaveBeenCalledTimes(1);
    expect([a.success, b.success]).toEqual([true, true]);
    expect([a.data.duplicated, b.data.duplicated].sort()).toEqual([false, true]);
  });
});
