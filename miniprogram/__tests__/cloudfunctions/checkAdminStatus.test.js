jest.mock('wx-server-sdk');

describe('checkAdminStatus caller permissions', () => {
  beforeEach(() => jest.resetModules());

  test('returns only the current caller permission summary and ignores client account identity', async () => {
    const cloud = require('wx-server-sdk');
    const db = {};
    cloud.database.mockReturnValue(db);
    const checkAdmin = jest.fn().mockResolvedValue({
      isAdmin: true,
      adminInfo: { role: 'admin', permissions: ['cat'] }
    });
    const getEffectivePermissions = jest.fn(() => ['cat']);
    const isSuperLevelRole = jest.fn(role => role === 'superadmin' || role === 'founder');
    jest.doMock('../../cloudfunctions/checkAdminStatus/utils/auth', () => ({
      checkAdmin,
      getEffectivePermissions,
      isSuperLevelRole
    }));
    const { main } = require('../../cloudfunctions/checkAdminStatus/index');

    const result = await main({ _adminAccount: 'client-supplied-account' });

    expect(checkAdmin).toHaveBeenCalledWith(db, '');
    expect(result).toEqual({
      success: true,
      data: { isAdmin: true, isSuperAdmin: false, role: 'admin', permissions: ['cat'] },
      message: ''
    });
    expect(result.data).not.toHaveProperty('adminInfo');
  });

  test('returns a safe non-admin summary without exposing database identity data', async () => {
    const cloud = require('wx-server-sdk');
    cloud.database.mockReturnValue({});
    jest.doMock('../../cloudfunctions/checkAdminStatus/utils/auth', () => ({
      checkAdmin: jest.fn().mockResolvedValue({ isAdmin: false, adminInfo: null }),
      getEffectivePermissions: jest.fn(() => []),
      isSuperLevelRole: jest.fn(() => false)
    }));
    const { main } = require('../../cloudfunctions/checkAdminStatus/index');

    const result = await main({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ isAdmin: false, isSuperAdmin: false, role: '', permissions: [] });
  });

  test.each([undefined, null, 'invalid-event'])('normalizes invalid event %p and returns a response', async event => {
    const cloud = require('wx-server-sdk');
    const db = {};
    cloud.database.mockReturnValue(db);
    const checkAdmin = jest.fn().mockResolvedValue({ isAdmin: false, adminInfo: null });
    jest.doMock('../../cloudfunctions/checkAdminStatus/utils/auth', () => ({
      checkAdmin,
      getEffectivePermissions: jest.fn(() => []),
      isSuperLevelRole: jest.fn(() => false)
    }));
    const { main } = require('../../cloudfunctions/checkAdminStatus/index');

    const result = await main(event);

    expect(result.success).toBe(true);
    expect(checkAdmin).toHaveBeenCalledWith(db, '');
  });

  test('keepWarm exits before business authorization and lookup', async () => {
    const cloud = require('wx-server-sdk');
    const checkAdmin = jest.fn();
    jest.doMock('../../cloudfunctions/checkAdminStatus/utils/auth', () => ({
      checkAdmin,
      getEffectivePermissions: jest.fn(),
      isSuperLevelRole: jest.fn()
    }));
    const { main } = require('../../cloudfunctions/checkAdminStatus/index');

    const result = await main({ _keepWarm: true });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ _keepWarm: true });
    // db 句柄在模块加载时创建；预热请求只跳过业务鉴权与查询。
    expect(cloud.database).toHaveBeenCalledTimes(1);
    expect(checkAdmin).not.toHaveBeenCalled();
  });
});
