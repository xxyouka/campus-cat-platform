jest.mock('wx-server-sdk');

describe('initDatabase authorization boundary', () => {
  beforeEach(() => jest.resetModules());

  test('rejects a non-admin before querying or creating collections', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'visitor-openid' });
    const checkAdmin = jest.fn().mockResolvedValue({ isAdmin: false });
    jest.doMock('../../cloudfunctions/initDatabase/utils/auth', () => ({ checkAdmin }));
    const collection = jest.fn();
    const createCollection = jest.fn();
    const db = { collection, createCollection };
    cloud.database.mockReturnValue(db);

    const { main } = require('../../cloudfunctions/initDatabase/index');
    const result = await main({});

    expect(result.success).toBe(false);
    expect(checkAdmin).toHaveBeenCalledWith(db, 'visitor-openid', expect.objectContaining({
      operation: '数据库初始化',
      useCache: false
    }));
    expect(collection).not.toHaveBeenCalled();
    expect(createCollection).not.toHaveBeenCalled();
  });

  test('returns an exists summary for an authorized administrator', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    jest.doMock('../../cloudfunctions/initDatabase/utils/auth', () => ({
      checkAdmin: jest.fn().mockResolvedValue({ isAdmin: true })
    }));
    const count = jest.fn().mockResolvedValue({ total: 0 });
    const collection = jest.fn(() => ({ count }));
    const createCollection = jest.fn();
    cloud.database.mockReturnValue({ collection, createCollection });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const { main } = require('../../cloudfunctions/initDatabase/index');
    const result = await main({});

    expect(result.success).toBe(true);
    expect(result.data.summary.errors).toBe(0);
    expect(result.data.summary.exists).toBe(result.data.summary.total);
    expect(collection).toHaveBeenCalledTimes(result.data.summary.total);
    expect(createCollection).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([message]) =>
      message.includes('索引配置核对: photoLikes 建议项 photoId_openid_unique (photoId:1, _openid:1; 唯一)')
    )).toBe(true);
  });
});
