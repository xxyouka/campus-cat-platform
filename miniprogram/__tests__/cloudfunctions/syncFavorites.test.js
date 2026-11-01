describe('syncFavorites 云函数', () => {
  beforeEach(() => {
    jest.resetModules();
    require('wx-server-sdk').getWXContext.mockReturnValue({ OPENID: 'test-openid' });
  });

  test('add 操作缺少 catId 应返回错误', async () => {
    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'add' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少catId');
  });

  test('缺少服务端 OPENID 时拒绝并且不访问收藏集合', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockCollection = jest.fn();
    mockCloud.getWXContext.mockReturnValue({ OPENID: '' });
    mockCloud.database.mockReturnValue({ collection: mockCollection });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'sync', catIds: [] }, {});

    expect(result.success).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(mockCollection).not.toHaveBeenCalled();
  });

  test('add 操作无效 catId 应返回错误', async () => {
    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'add', catId: 'invalid!!!' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的catId');
  });

  test('add 操作重复关注应返回成功', async () => {
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: jest.fn(() => Promise.resolve({ total: 1 })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          remove: jest.fn(() => Promise.resolve({}))
        })),
        add: jest.fn(() => Promise.resolve({ _id: 'mock-id' }))
      })),
      command: { gt: jest.fn(v => v) }
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main(
      { action: 'add', catId: 'abcdef1234567890abcd', catName: '小橘' },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('已关注');
  });

  test('add 操作新关注应添加成功', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-fav-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          remove: jest.fn(() => Promise.resolve({}))
        })),
        add: mockAdd
      })),
      command: { gt: jest.fn(v => v) },
      serverDate: jest.fn(() => new Date())
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main(
      { action: 'add', catId: 'abcdef1234567890abcd', catName: '小橘' },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('关注已同步');
    expect(mockAdd).toHaveBeenCalled();
  });

  test('remove 操作缺少 catId 应返回错误', async () => {
    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'remove' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少catId');
  });

  test('remove 操作无效 catId 应返回错误', async () => {
    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'remove', catId: 'invalid!!!' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的catId');
  });

  test('remove 操作应取消关注', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockRemove = jest.fn(() => Promise.resolve({}));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          remove: mockRemove
        })),
        add: jest.fn(() => Promise.resolve({ _id: 'mock-id' }))
      })),
      command: { gt: jest.fn(v => v) }
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main(
      { action: 'remove', catId: 'abcdef1234567890abcd' },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('已取消关注');
    expect(mockRemove).toHaveBeenCalled();
  });

  test.each([
    ['缺少列表', undefined],
    ['非数组', 'not-an-array'],
    ['列表含无效ID', ['abcdef12345678901234', 'invalid!!!']]
  ])('sync 操作遇到%s时应拒绝且不访问云端收藏', async (_label, catIds) => {
    const mockCloud = require('wx-server-sdk');
    const mockCollection = jest.fn();
    mockCloud.database.mockReturnValue({
      collection: mockCollection,
      command: { gt: jest.fn(v => v) },
      serverDate: jest.fn(() => new Date())
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'sync', catIds }, {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/catIds|无效猫咪ID/);
    // 验证必须发生在读取差集之前，否则坏输入仍可能触发云端批量删除。
    expect(mockCollection).not.toHaveBeenCalled();
  });

  test('sync 操作超过 200 条上限应整体拒绝（不得截断后误删云端收藏）', async () => {
    const mockCloud = require('wx-server-sdk');
    const mockRemove = jest.fn(() => Promise.resolve({}));
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'mock-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          field: jest.fn(() => ({
            // fetchAllCloudCatIds 现在显式 orderBy('_id','asc') 保证游标分页稳定
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve({ data: [] }))
              }))
            }))
          })),
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          remove: mockRemove
        })),
        add: mockAdd
      })),
      command: { gt: jest.fn(v => v) },
      serverDate: jest.fn(() => new Date())
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    // 201 个合法 ID（20 位十六进制）→ 超出上限
    const catIds = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(20, '0'));
    const result = await syncFavorites.main({ action: 'sync', catIds }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('200');
    // 关键：不得对云端收藏执行任何增删（否则第 201 条起会被误判为已取消关注）
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('sync 操作恰好 200 条应正常放行', async () => {
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          field: jest.fn(() => ({
            // fetchAllCloudCatIds 现在显式 orderBy('_id','asc') 保证游标分页稳定
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve({ data: [] }))
              }))
            }))
          })),
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          remove: jest.fn(() => Promise.resolve({}))
        })),
        add: jest.fn(() => Promise.resolve({ _id: 'mock-id' }))
      })),
      command: { gt: jest.fn(v => v) },
      serverDate: jest.fn(() => new Date())
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const catIds = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(20, '0'));
    const result = await syncFavorites.main({ action: 'sync', catIds }, {});

    expect(result.success).toBe(true);
    expect(result.data.total).toBe(200);
  });

  test('未知操作应返回错误', async () => {
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          get: jest.fn(() => Promise.resolve({ data: [] }))
        }))
      })),
      command: { gt: jest.fn(v => v) }
    });

    const syncFavorites = require('../../cloudfunctions/syncFavorites/index');
    const result = await syncFavorites.main({ action: 'unknown' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('未知操作类型');
  });
});
