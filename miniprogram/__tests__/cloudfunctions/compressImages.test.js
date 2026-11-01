/**
 * __tests__/cloudfunctions/compressImages.test.js
 * 覆盖图片换链（getOptimizedUrl）与批量优化（batchOptimize）的
 * 鉴权、参数校验、换链失败回退以及计数逻辑。
 *
 * 注意：compressImages 在模块顶层执行 `const db = cloud.database()`，
 * 因此必须在 require 之前配置好 database 的返回实现，否则 db 会指向旧实例。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/compressImages/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/compressImages/utils/constants', () => ({
  COLLECTIONS: { PHOTOS: 'photos' }
}));

const ADMIN_OK = { isAdmin: true, role: 'admin' };
const ADMIN_DENIED = { isAdmin: false, error: '无管理员权限' };

/**
 * 重新加载云函数模块并注入数据库 / 换链行为
 * @param {Object} options
 * @param {Array}  options.docs - where().limit().get() 返回的文档
 * @param {Object} options.tempUrlMap - cloud:// fileID → 临时 URL 的映射；未命中视为换链失败
 * @param {Object} options.authResult - checkAdmin 的返回值
 * @returns {{ main: Function, update: jest.Mock }}
 */
function loadMain({ docs = [], tempUrlMap = {}, authResult = ADMIN_OK } = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  // jest.mock 工厂结果进程级缓存：先恢复可能被其他测试文件覆盖的 database 实现
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  const update = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
  const collection = jest.fn(() => ({
    where: jest.fn(() => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: docs }))
      }))
    })),
    doc: jest.fn(() => ({ update }))
  }));

  cloud.database.mockReturnValue({
    collection,
    command: { exists: jest.fn(v => v), neq: jest.fn(v => v) }
  });

  cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
  cloud.getTempFileURL = jest.fn(({ fileList }) => Promise.resolve({
    fileList: fileList.map(id => tempUrlMap[id] ? { tempFileURL: tempUrlMap[id] } : {})
  }));

  const auth = require('../../cloudfunctions/compressImages/utils/auth');
  auth.checkAdmin.mockResolvedValue(authResult);

  const main = require('../../cloudfunctions/compressImages/index').main;
  return { main, update, getTempFileURL: cloud.getTempFileURL };
}

describe('compressImages 云函数', () => {
  test('未知 action 返回失败', async () => {
    const { main } = loadMain();
    const res = await main({ action: 'not-exist' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('未知操作');
  });

  describe('getOptimizedUrl', () => {
    test('缺少 fileID 返回失败', async () => {
      const { main } = loadMain();
      const res = await main({ action: 'getOptimizedUrl' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('fileID 参数必填');
    });

    test('非管理员被拒绝', async () => {
      const { main } = loadMain({ authResult: ADMIN_DENIED });
      const res = await main({ action: 'getOptimizedUrl', fileID: 'cloud://a/photos/b.jpg' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('无管理员权限');
    });

    test('非业务目录（backups/）的 fileID 被拒绝且不换链', async () => {
      const { main, getTempFileURL } = loadMain();
      const res = await main({
        action: 'getOptimizedUrl',
        fileID: 'cloud://a/backups/2026-09-05T03-00-00/recordMeet.json'
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('不允许访问的云存储路径');
      expect(getTempFileURL).not.toHaveBeenCalled();
    });

    test('换链成功时基于临时 URL 拼接 imageMogr2 参数', async () => {
      const { main } = loadMain({ tempUrlMap: { 'cloud://a/photos/b.jpg': 'https://cdn/a.jpg' } });
      const res = await main({
        action: 'getOptimizedUrl', fileID: 'cloud://a/photos/b.jpg', quality: 70, width: 200
      });
      expect(res.success).toBe(true);
      expect(res.data.originalUrl).toBe('cloud://a/photos/b.jpg');
      expect(res.data.optimizedUrl).toBe('https://cdn/a.jpg?imageMogr2/imageView2/2/w/200/q/70/format/webp');
    });

    test('换链失败时回退为原 fileID', async () => {
      const { main } = loadMain();
      const res = await main({ action: 'getOptimizedUrl', fileID: 'cloud://a/photos/b.jpg' });
      expect(res.success).toBe(true);
      expect(res.data.optimizedUrl).toBe('cloud://a/photos/b.jpg?imageMogr2/q/80/format/webp');
    });

    test('非 cloud:// 直接使用原 URL', async () => {
      const { main } = loadMain();
      const res = await main({ action: 'getOptimizedUrl', fileID: 'https://x/y.png' });
      expect(res.data.optimizedUrl).toBe('https://x/y.png?imageMogr2/q/80/format/webp');
    });

    test('URL 已含 imageMogr2 时不重复追加', async () => {
      const { main } = loadMain();
      const res = await main({ action: 'getOptimizedUrl', fileID: 'https://x/y.png?imageMogr2/q/50' });
      expect(res.data.optimizedUrl).toBe('https://x/y.png?imageMogr2/q/50');
    });
  });

  describe('batchOptimize', () => {
    test('非白名单集合被拒绝', async () => {
      const { main } = loadMain();
      const res = await main({ action: 'batchOptimize', collection: 'admins' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('不允许操作的集合');
    });

    test('非管理员被拒绝', async () => {
      const { main } = loadMain({ authResult: ADMIN_DENIED });
      const res = await main({ action: 'batchOptimize' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('无管理员权限');
    });

    test('只统计换链成功的记录，失败项跳过不写库', async () => {
      const docs = [
        { _id: 'p1', url: 'cloud://a/1.jpg' },
        { _id: 'p2', url: 'cloud://a/2.jpg' }
      ];
      const { main, update } = loadMain({
        docs,
        tempUrlMap: { 'cloud://a/1.jpg': 'https://cdn/1.jpg' }
      });
      const res = await main({ action: 'batchOptimize' });

      expect(res.success).toBe(true);
      expect(res.data.total).toBe(2);
      expect(res.data.marked).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
      // 关键不变量：临时 https 链接**不得落库**（约 2 小时即过期，客户端读到就会裂图）
      expect(update.mock.calls[0][0].data.displayUrl).toBeUndefined();
      expect(update.mock.calls[0][0].data._optimized).toBe(true);
      // 需要看链接时从返回值取，并注明不落库
      expect(res.data.samples[0].preview).toContain('https://cdn/1.jpg');
      expect(res.data.note).toContain('不落库');
    });

    test('跳过非 cloud:// 记录', async () => {
      const docs = [{ _id: 'p1', url: 'https://x/y.png' }];
      const { main, update } = loadMain({ docs });
      const res = await main({ action: 'batchOptimize' });

      expect(res.data.marked).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
