/**
 * __tests__/cloudfunctions/exportData.pagination.test.js
 *
 * 回归：loadAll 的无序 skip 分页。
 *
 * 云数据库在**无 orderBy** 时不保证返回顺序稳定，skip/limit 分页会随底层存储变化
 * 漂移 → 同一文档可能在第 3 页和第 47 页各出现一次（导出金额/次数被重复计入），
 * 也可能整段丢失。导出是审计与对账场景的输出，重复计数会直接误导管理员。
 *
 * 本测试锁定契约：loadAll 内部**必须**自带稳定唯一排序键 orderBy('_id','asc')。
 */
jest.mock('wx-server-sdk');
jest.mock('archiver', () => jest.fn(() => ({
  on: jest.fn(),
  append: jest.fn(),
  finalize: jest.fn(() => Promise.resolve())
})), { virtual: true });
jest.mock('../../cloudfunctions/exportData/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/exportData/utils/audit', () => ({
  log: jest.fn(() => Promise.resolve())
}));
jest.mock('../../cloudfunctions/exportData/utils/logger', () => ({
  CloudLogger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), performance: jest.fn() },
  CloudErrorHandler: { handle: jest.fn(msg => ({ success: false, error: msg })) }
}));

const CAT = {
  _id: 'a'.repeat(24), name: '橘猫', gender: 'male', age: '2', color: '橘',
  campus: '东区', status: 'normal', sterilized: true, meetCount: 3,
  photoCount: 2, description: '亲人', updateTime: '2025-01-01'
};

describe('exportData.loadAll 分页排序契约', () => {
  let cloud;
  let main;
  let orderByCalls;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();

    orderByCalls = [];
    // 每次 collection() 返回独立 query，以便断言 orderBy 被调用
    const makeQuery = (list) => {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn((field, dir) => {
          orderByCalls.push({ field, dir });
          return q;
        }),
        skip: jest.fn(() => q),
        limit: jest.fn(() => q),
        count: jest.fn(() => Promise.resolve({ total: list.length })),
        get: jest.fn(() => Promise.resolve({ data: list }))
      };
      return q;
    };

    const rows = { cats: [CAT], health_records: [] };
    const fakeDb = {
      collection: jest.fn(() => makeQuery(rows.cats)),
      // neq：BE-7 起导出查询恒带 _deleting: _.neq(true)（删除中的猫不进导出）
      command: { gte: jest.fn(v => v), lte: jest.fn(v => v), neq: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    };
    cloud.database.mockReturnValue(fakeDb);

    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://export-file' }));
    cloud.getTempFileURL = jest.fn(() => Promise.resolve({
      fileList: [{ fileID: 'cloud://export-file', tempFileURL: 'https://temp/export.json' }]
    }));

    const auth = require('../../cloudfunctions/exportData/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });

    main = require('../../cloudfunctions/exportData/index').main;
  });

  test('导出查询链上必须存在 orderBy("_id","asc")', async () => {
    const res = await main({ type: 'cats', format: 'json' });
    expect(res.success).toBe(true);

    expect(orderByCalls.length).toBeGreaterThan(0);
    // loadAll 内部对每个分页查询补的稳定排序键
    expect(orderByCalls.some(c => c.field === '_id' && c.dir === 'asc')).toBe(true);
  });

  test('orderBy 在 skip/limit 之前调用（排序键被真正下发到查询）', async () => {
    // 复用 beforeEach 里已require 的 main，只把记录链式顺序的数组换成新的
    const calls = [];
    const makeOrderedQuery = (list) => {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => { calls.push('orderBy'); return q; }),
        skip: jest.fn(() => { calls.push('skip'); return q; }),
        limit: jest.fn(() => { calls.push('limit'); return q; }),
        count: jest.fn(() => Promise.resolve({ total: list.length })),
        get: jest.fn(() => Promise.resolve({ data: list }))
      };
      return q;
    };

    cloud.database.mockReturnValue({
      collection: () => makeOrderedQuery([CAT]),
      command: { gte: v => v, lte: v => v, neq: v => v },
      serverDate: () => 'SERVER_DATE'
    });

    // index.js 在 require 时就捕获了 db，必须在换库后重新加载模块
    jest.resetModules();
    const freshCloud = require('wx-server-sdk');
    if (freshCloud.__restoreDatabase) freshCloud.__restoreDatabase();
    freshCloud.database.mockReturnValue({
      collection: () => makeOrderedQuery([CAT]),
      command: { gte: v => v, lte: v => v, neq: v => v },
      serverDate: () => 'SERVER_DATE'
    });
    freshCloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://export-file' }));
    freshCloud.getTempFileURL = jest.fn(() => Promise.resolve({
      fileList: [{ fileID: 'cloud://export-file', tempFileURL: 'https://temp/export.json' }]
    }));
    const freshAuth = require('../../cloudfunctions/exportData/utils/auth');
    freshAuth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });

    const freshMain = require('../../cloudfunctions/exportData/index').main;
    await freshMain({ type: 'cats', format: 'json' });

    expect(calls[0]).toBe('orderBy');
    expect(calls.indexOf('orderBy')).toBeLessThan(calls.indexOf('skip'));
    expect(calls.indexOf('skip')).toBeLessThan(calls.indexOf('limit'));
  });
});
