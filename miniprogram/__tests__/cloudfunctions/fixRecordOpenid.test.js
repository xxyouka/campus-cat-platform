// Mock auth
jest.mock('../../cloudfunctions/fixRecordOpenid/utils/auth', () => ({
  checkAdmin: jest.fn()
}));

// Mock operationLogger
jest.mock('../../cloudfunctions/fixRecordOpenid/common/operationLogger', () => ({
  logOperation: jest.fn()
}));

describe('fixRecordOpenid 云函数', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('非管理员应被拒绝', async () => {
    const { checkAdmin } = require('../../cloudfunctions/fixRecordOpenid/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限' });

    const fixRecordOpenid = require('../../cloudfunctions/fixRecordOpenid/index');
    const result = await fixRecordOpenid.main({ _adminAccount: 'user1' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('无权限');
  });

  test('缺少 openidHint 时必须拒绝，不得把管理员 openid 批量赋给他人记录', async () => {
    // 回归防护：原实现写作 `openidHint || OPENID`（注释声明必填、代码却兜底成
    // 管理员自己）。只传 catId 时，该猫**其他用户**的打卡记录 _openid 会被改成
    // 管理员 openid —— 那些记录随即出现在管理员的「我的相遇」，
    // 按 openid:catId:day 去重的统计一并错乱。
    const { checkAdmin } = require('../../cloudfunctions/fixRecordOpenid/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockUpdate = jest.fn();
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: [{ _id: 'r1' }, { _id: 'r2' }] }))
            }))
          }))
        })),
        doc: jest.fn(() => ({ update: mockUpdate }))
      })),
      command: { exists: jest.fn(v => v) }
    });

    const fixRecordOpenid = require('../../cloudfunctions/fixRecordOpenid/index');
    const result = await fixRecordOpenid.main(
      { _adminAccount: 'admin', catId: 'a1b2c3d4e5f6a7b8c9d0' },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('openidHint');
    // 关键断言：一条都不能改
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('无记录需要修复时应返回 fixedCount: 0', async () => {
    const { checkAdmin } = require('../../cloudfunctions/fixRecordOpenid/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: [] }))
            }))
          }))
        }))
      })),
      command: { exists: jest.fn(v => v) }
    });

    const fixRecordOpenid = require('../../cloudfunctions/fixRecordOpenid/index');
    const result = await fixRecordOpenid.main({ _adminAccount: 'admin', catId: 'a1b2c3d4e5f6a7b8c9d0', openidHint: 'oTEST_OPENID_1234567890abc' }, {});
    expect(result.success).toBe(true);
    expect(result.data.fixedCount).toBe(0);
    expect(result.message).toContain('无需修复');
  });

  test('管理员调用时应正确修复记录', async () => {
    const { checkAdmin } = require('../../cloudfunctions/fixRecordOpenid/utils/auth');
    const { logOperation } = require('../../cloudfunctions/fixRecordOpenid/common/operationLogger');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockUpdate = jest.fn(() => Promise.resolve({}));
    const mockDoc = jest.fn(() => ({ update: mockUpdate }));

    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({
                data: [
                  { _id: 'record1' },
                  { _id: 'record2' },
                  { _id: 'record3' }
                ]
              }))
            }))
          }))
        })),
        doc: mockDoc
      })),
      command: { exists: jest.fn(v => v) }
    });

    const fixRecordOpenid = require('../../cloudfunctions/fixRecordOpenid/index');
    const result = await fixRecordOpenid.main({ _adminAccount: 'admin', catId: 'a1b2c3d4e5f6a7b8c9d0', openidHint: 'oTEST_OPENID_1234567890abc' }, {});
    expect(result.success).toBe(true);
    expect(result.data.fixedCount).toBe(3);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(logOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        module: 'system',
        action: 'fix_record_openid',
        description: expect.stringContaining('3')
      })
    );
  });

  test('修复失败的记录应被跳过', async () => {
    const { checkAdmin } = require('../../cloudfunctions/fixRecordOpenid/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockUpdate = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('更新失败'))
      .mockResolvedValueOnce({});

    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({
                data: [
                  { _id: 'record1' },
                  { _id: 'record2' },
                  { _id: 'record3' }
                ]
              }))
            }))
          }))
        })),
        doc: jest.fn(() => ({ update: mockUpdate }))
      })),
      command: { exists: jest.fn(v => v) }
    });

    const fixRecordOpenid = require('../../cloudfunctions/fixRecordOpenid/index');
    const result = await fixRecordOpenid.main({ _adminAccount: 'admin', catId: 'a1b2c3d4e5f6a7b8c9d0', openidHint: 'oTEST_OPENID_1234567890abc' }, {});
    expect(result.success).toBe(true);
    expect(result.data.fixedCount).toBe(2);
  });
});
