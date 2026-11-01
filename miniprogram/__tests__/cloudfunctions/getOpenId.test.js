jest.mock('wx-server-sdk');

describe('getOpenId caller identity contract', () => {
  beforeEach(() => jest.resetModules());

  test('returns the platform caller OPENID and ignores client supplied identity fields', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'trusted-openid' });
    const { main } = require('../../cloudfunctions/getOpenId/index');

    const result = await main({ OPENID: 'forged-openid', openid: 'forged-openid' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ openid: 'trusted-openid' });
    expect(cloud.getWXContext).toHaveBeenCalledTimes(1);
  });

  test('returns a failure response when the platform context has no OPENID', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({});
    const { main } = require('../../cloudfunctions/getOpenId/index');

    const result = await main({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('无法获取用户身份');
  });

  test('normalizes a platform context exception', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockImplementation(() => { throw new Error('context unavailable'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { main } = require('../../cloudfunctions/getOpenId/index');

    const result = await main({ openid: 'forged-openid' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('获取用户身份失败，请稍后重试');
  });
});
