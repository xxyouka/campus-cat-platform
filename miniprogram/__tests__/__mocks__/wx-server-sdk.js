const createMockCollection = () => {
  const mockLimit = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ data: [] })),
    skip: jest.fn()
  }));

  const mockOrderBy = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ data: [] })),
    limit: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ data: [] })),
      skip: jest.fn()
    }))
  }));

  const mockWhere = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ data: [] })),
    count: jest.fn(() => Promise.resolve({ total: 0 })),
    limit: mockLimit,
    orderBy: mockOrderBy,
    update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
    remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
  }));

  return {
    where: mockWhere,
    doc: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ data: {} })),
      update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
      remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
    })),
    add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
    count: jest.fn(() => Promise.resolve({ total: 0 })),
    limit: mockLimit,
    orderBy: mockOrderBy,
    skip: jest.fn()
  };
};

const mockCloud = {
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'mock-env',
  database: jest.fn(() => ({
    collection: jest.fn(createMockCollection),
    command: {
      eq: jest.fn(v => v),
      neq: jest.fn(v => v),
      gt: jest.fn(v => v),
      gte: jest.fn(v => v),
      lt: jest.fn(v => v),
      lte: jest.fn(v => v),
      in: jest.fn(v => v),
      and: jest.fn(v => v),
      or: jest.fn(v => v)
    },
    serverDate: jest.fn(() => 'SERVER_DATE'),
    // 原子自增 / 字段存在性判断：云函数写库用到（此前缺失会让调用方在 undefined 上抛错，
    // 被 .catch 吞掉后测试「通过」但什么都没验证）
    inc: jest.fn(v => ({ $inc: v })),
    exists: jest.fn(v => ({ $exists: v })),
    // 聚合算子：getOperationLogs 等用 db.command.aggregate 的 $.sum(1)
    aggregate: {
      sum: jest.fn(v => ({ $sum: v })),
      in: jest.fn(v => ({ $in: v })),
      max: jest.fn(v => ({ $max: v }))
    }
  })),
  callFunction: jest.fn(() => Promise.resolve({ result: { success: true } })),
  downloadFile: jest.fn(() => Promise.resolve({ fileContent: Buffer.from('mock-image') })),
  // addCat / addPhoto 在内容安全检测不通过时会回收「已上传但未入库」的文件
  deleteFile: jest.fn(() => Promise.resolve({ fileList: [] })),
  openapi: {
    security: {
      msgSecCheck: jest.fn(() => Promise.resolve({ errCode: 0 })),
      imgSecCheck: jest.fn(() => Promise.resolve({ errCode: 0 })),
      // 现役的多媒体异步检测（替代配额紧张的旧版 imgSecCheck）：
      // 提交成功只返回 trace_id，结果经 wxa_media_check 事件回调
      mediaCheckAsync: jest.fn(() => Promise.resolve({ errcode: 0, trace_id: 'mock-trace-id' }))
    }
  },
  // mediaCheckAsync 需要可下载的临时链接（contentSecurity.checkImageAsync 用）
  getTempFileURL: jest.fn(() => Promise.resolve({
    fileList: [{ tempFileURL: 'https://mock-cdn.example/mock-image.jpg' }]
  })),
  getWXContext: jest.fn(() => ({
    OPENID: 'test-openid',
    APPID: 'test-appid',
    UNIONID: 'test-unionid',
    ENV: 'mock-env'
  }))
};

// jest.mock 工厂结果在进程级缓存（resetModules 不清理），
// 覆盖 database 实现的测试文件必须用 __restoreDatabase 恢复，防止跨文件污染。
const __defaultDatabaseImpl = mockCloud.database.getMockImplementation();
mockCloud.__restoreDatabase = function restoreDatabase() {
  mockCloud.database.mockImplementation(__defaultDatabaseImpl);
};

module.exports = mockCloud;
