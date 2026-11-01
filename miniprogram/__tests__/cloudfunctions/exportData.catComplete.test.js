/**
 * __tests__/cloudfunctions/exportData.catComplete.test.js
 *
 * 回归：cat_complete 导出**不再包含健康档案**。
 *
 * 健康档案模块已于 2026-10-06 整体删除（组件 / 页面 / 云函数 / 测试），
 * 但导出曾把健康记录内嵌进 cat_complete 的每只猫咪对象里
 * （`健康档案: catHealthRecords.map(...)`），若只删 UI 不改云函数，
 * 导出的文件里仍会带一个空数组字段 —— 属于「功能已下线但数据仍外泄」。
 *
 * 本测试锁定：JSON 导出里没有「健康档案」键，TXT 文本里没有「【健康档案】」段。
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

function createFakeDb(rows) {
  const makeQuery = list => {
    const query = {
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      count: jest.fn(() => Promise.resolve({ total: list.length })),
      get: jest.fn(() => Promise.resolve({ data: list }))
    };
    return query;
  };

  // photos：照片数统计走 group → **limit** → end（显式 limit 是硬要求，
  // 缺了会被运行时静默截断到 20 组，见 cloudfunctions/utils/photoCounts.js）；
  // 且分组计数之和（5）必须等于 count()（总照片数），否则会被判成不完整而降级。
  const PHOTO_TOTAL = 5;
  const photosQuery = {
    ...makeQuery([]),
    count: jest.fn(() => Promise.resolve({ total: PHOTO_TOTAL })),
    where: jest.fn(() => ({ count: jest.fn(() => Promise.resolve({ total: PHOTO_TOTAL })) })),
    aggregate: jest.fn(() => ({
      group: jest.fn(() => ({
        limit: jest.fn(() => ({
          end: jest.fn(() => Promise.resolve({ list: [{ _id: CAT._id, count: PHOTO_TOTAL }] }))
        }))
      }))
    }))
  };

  const catsQuery = makeQuery(rows.cats);

  return {
    collection: jest.fn(name => name === 'photos' ? photosQuery : catsQuery),
    command: {
      gte: jest.fn(v => v),
      lte: jest.fn(v => v),
      // BE-7：导出查询恒带 _deleting: _.neq(true)（删除中的猫不进导出）
      neq: jest.fn(v => v),
      aggregate: { in: jest.fn(v => v), sum: jest.fn(v => v) }
    },
    serverDate: jest.fn(() => 'SERVER_DATE')
  };
}

describe('exportData cat_complete 不再输出健康档案', () => {
  let cloud;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.database.mockReturnValue(createFakeDb({ cats: [CAT] }));
    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://export-file' }));
    cloud.getTempFileURL = jest.fn(() => Promise.resolve({
      fileList: [{ fileID: 'cloud://export-file', tempFileURL: 'https://temp/export.json' }]
    }));

    const auth = require('../../cloudfunctions/exportData/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });

    main = require('../../cloudfunctions/exportData/index').main;
  });

  test('JSON 导出中不含「健康档案」键', async () => {
    const res = await main({ type: 'cat_complete', format: 'json' });
    expect(res.success).toBe(true);

    const uploaded = cloud.uploadFile.mock.calls[0][0];
    const parsed = JSON.parse(uploaded.fileContent.toString('utf-8'));
    expect(parsed[0]).toHaveProperty('猫咪信息');
    expect(parsed[0]).not.toHaveProperty('健康档案');
    // 照片数必须以 photos 集合聚合为准（fixture 里的 photoCount:2 是幽灵字段）
    expect(parsed[0].猫咪信息.照片数).toBe(5);
  });

  test('TXT 导出中不含「【健康档案】」段', async () => {
    const res = await main({ type: 'cat_complete', format: 'txt' });
    expect(res.success).toBe(true);

    const content = cloud.uploadFile.mock.calls[0][0].fileContent.toString('utf-8');
    expect(content).toContain('橘猫');
    expect(content).not.toContain('【健康档案】');
  });

  test('导出不查询 health_records 集合', async () => {
    await main({ type: 'cat_complete', format: 'json' });
    const db = cloud.database.mock.results[0].value;
    // 只应查 cats（collection 每次调用都返回新 query，故用调用次数与返回值判断）
    expect(db.collection).toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalledWith('health_records');
  });
});
