/**
 * __tests__/cloudfunctions/deleteData.photoRole.test.js
 *
 * 删除操作的入口权限回归（2026-10-24 校准）：
 * - 删除能力跟随入口权限：照片/相册 → photo，猫咪 → cat；
 *   超管恒通过，普通管理员被开通入口后同样可删。
 * - 未开通对应入口时由 checkAdmin 返回 isAdmin:false，错误原样透传。
 *
 * 历史：2026-10-06 曾把三类删除统一收紧为「仅超级管理员」，
 * 造成「已开通照片管理的普通管理员能进页面却删不了」，现按权限模型还原。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/deleteData/utils/auth', () => ({ checkAdmin: jest.fn() }));
jest.mock('../../cloudfunctions/deleteData/utils/logger', () => ({
  CloudLogger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  CloudErrorHandler: { handle: jest.fn() }
}));
jest.mock('../../cloudfunctions/deleteData/utils/audit', () => ({
  log: jest.fn(() => Promise.resolve()),
  logDelete: jest.fn(() => Promise.resolve())
}));

describe('deleteData 删除类型角色门禁', () => {
  let cloud;
  let auth;
  let main;

  const VALID_ID = 'a'.repeat(24);

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    cloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: null })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        })),
        where: jest.fn(() => ({
          limit: jest.fn(function() { return this; }),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        }))
      })),
      command: { in: jest.fn(v => v), eq: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });

    auth = require('../../cloudfunctions/deleteData/utils/auth');
    main = require('../../cloudfunctions/deleteData/index').main;
  });

  test('普通管理员（已开通照片管理）删除照片：不再被角色门禁拦下', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'admin' } });

    const res = await main({ type: 'photo', id: VALID_ID }, {});

    // fake db 查不到照片 → 如实报「不存在」，而不是「仅超级管理员可删除照片」
    expect(res.success).toBe(false);
    expect(res.error).toContain('不存在');
    expect(res.error).not.toContain('超级管理员');
  });

  test('普通管理员（已开通猫咪管理/照片管理）删除猫咪/相册同样不被角色门禁拦下', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'admin' } });

    const cat = await main({ type: 'cat', id: VALID_ID }, {});
    expect(cat.success).toBe(false);
    expect(cat.error).toContain('不存在');
    expect(cat.error).not.toContain('超级管理员');

    // 相册链路：fake db 无关联照片，可直接完成删除
    const album = await main({ type: 'album', id: VALID_ID }, {});
    expect(album.success).toBe(true);
  });

  test('非管理员任何删除都被拒绝', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限执行此操作' });

    const res = await main({ type: 'photo', id: VALID_ID }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
  });

  test('未开通对应入口权限：透传 checkAdmin 的权限提示', async () => {
    auth.checkAdmin.mockResolvedValue({
      isAdmin: false,
      error: '该账号未开通「照片管理」权限，请联系超级管理员开启'
    });

    const photo = await main({ type: 'photo', id: VALID_ID }, {});
    expect(photo.success).toBe(false);
    expect(photo.error).toContain('未开通');

    const cat = await main({ type: 'cat', id: VALID_ID }, {});
    expect(cat.success).toBe(false);
    expect(cat.error).toContain('未开通');
  });

  test('超级管理员可进入各类型删除链路（不存在的目标如实报错/空相册可完成）', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });

    const photo = await main({ type: 'photo', id: VALID_ID }, {});
    expect(photo.success).toBe(false);
    expect(photo.error).toContain('不存在');

    // 相册链路：无关联照片时可直接删除成功（fake db 返回空照片集）
    const album = await main({ type: 'album', id: VALID_ID }, {});
    expect(album.success).toBe(true);

    const cat = await main({ type: 'cat', id: VALID_ID }, {});
    expect(cat.success).toBe(false);
    expect(cat.error).toContain('不存在');
  });

  test('非法 ID 在鉴权前即被拒绝', async () => {
    const res = await main({ type: 'photo', id: 'not-valid' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无效');
  });

  test('删除照片成功：清理该照片的点赞记录并删除云文件', async () => {
    // 模块级 db 在 require 时创建：必须 resetModules 后重新加载，才能拿到自定义 db
    jest.resetModules();
    cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/deleteData/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });

    const photoLikesWhere = jest.fn(() => ({
      remove: jest.fn(() => Promise.resolve({ stats: { removed: 3 } }))
    }));
    const PHOTO_URL = 'cloud://env.bucket/photos/1.jpg';
    cloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'photoLikes') return { where: photoLikesWhere };
        return {
          doc: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: { _id: VALID_ID, url: PHOTO_URL } })),
            remove: jest.fn(() => Promise.resolve({ stats: { removed: 1 } }))
          }))
        };
      }),
      command: { in: jest.fn(v => v), eq: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });
    cloud.deleteFile = jest.fn(() => Promise.resolve({ fileList: [] }));
    main = require('../../cloudfunctions/deleteData/index').main;

    const res = await main({ type: 'photo', id: VALID_ID }, {});

    expect(res.success).toBe(true);
    // 与删猫分支同口径：不留指向已删照片的孤儿点赞
    expect(photoLikesWhere).toHaveBeenCalledWith({ photoId: VALID_ID });
    expect(cloud.deleteFile).toHaveBeenCalledWith({ fileList: [PHOTO_URL] });
  });

  test('照片 doc().get() reject（已不存在）时如实返回「照片不存在」', async () => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/deleteData/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    cloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.reject(new Error(`document with _id ${VALID_ID} does not exist`)))
        }))
      })),
      command: { in: jest.fn(v => v), eq: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });
    main = require('../../cloudfunctions/deleteData/index').main;

    const res = await main({ type: 'photo', id: VALID_ID }, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('照片不存在');
  });
});
