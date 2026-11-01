/**
 * 回归：exportData 的日期区间必须按北京时间自然日解析。
 *
 * 云函数容器是 UTC：`new Date('2026-09-15')` = UTC 0 点 = 北京 8 点，
 * `setHours(23,59,59,999)` 也按 UTC 收尾 —— 区间会变成
 * 「北京 9/15 08:00 ~ 9/16 07:59」，漏掉起始日 00:00-08:00 的记录、
 * 多出结束日次日 00:00-08:00 的记录。
 *
 * 本测试锁定：'YYYY-MM-DD' 必须解析为
 *   起点 = 北京当日 00:00:00.000（UTC 前一日 16:00）
 *   终点 = 北京当日 23:59:59.999
 * 与 getMeetCalendar / getOperationLogs 的北京时间口径一致。
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

describe('exportData 日期区间（北京时间口径）', () => {
  test('纯日期起点/终点按 +08:00 解析', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();

    const captured = [];
    const query = {
      where: jest.fn(cond => { captured.push(cond); return query; }),
      orderBy: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      get: jest.fn(() => Promise.resolve({ data: [] }))
    };
    cloud.database.mockReturnValue({
      collection: jest.fn(() => query),
      command: {
        gte: jest.fn(value => ({
          __gte: value,
          and: jest.fn(other => ({ __gte: value, __lte: other && other.__lte }))
        })),
        lte: jest.fn(value => ({ __lte: value })),
        // BE-7：导出查询恒带 _deleting: _.neq(true)（删除中的猫不进导出）
        neq: jest.fn(value => value)
      },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });
    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://export-file' }));
    cloud.getTempFileURL = jest.fn(() => Promise.resolve({
      fileList: [{ fileID: 'cloud://export-file', tempFileURL: 'https://temp/export.txt' }]
    }));

    const auth = require('../../cloudfunctions/exportData/utils/auth');
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });

    const { main } = require('../../cloudfunctions/exportData/index');
    // 空结果会以业务失败收尾，本测试只关心下发的 where 条件
    await main({ type: 'cats', format: 'txt', startDate: '2026-09-15', endDate: '2026-09-15' });

    const cond = captured.find(c => c && c.updateTime);
    expect(cond).toBeDefined();
    // 北京 2026-09-15 00:00:00 = UTC 2026-09-14T16:00:00.000Z
    expect(cond.updateTime.__gte.toISOString()).toBe('2026-09-14T16:00:00.000Z');
    // 北京 2026-09-15 23:59:59.999 = UTC 2026-09-15T15:59:59.999Z
    expect(cond.updateTime.__lte.toISOString()).toBe('2026-09-15T15:59:59.999Z');
  });
});
