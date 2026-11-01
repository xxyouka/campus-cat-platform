// __tests__/cloudfunctions/audit.test.js
//
// 定向回归：audit.js 与 common/operationLogger.js 同形（async + 全函数体 try/catch + 写库），
// **同样必须**以 { data: logData } 形式调用，否则写入内容恒空 —— 这是
// operationLogger.test.js:56-82 已经锁过的 P0 类别，但不能只锁一次：
// 两个 canonical 模块会被不同人改，任何一处退化成裸 add 都让该集合长期为空却无人发现。
//
// 加载方式同 operationLogger.test.js：直接读 canonical 源码用最小 require shim 求值，
// 保证被断言的就是 canonical 文件本身。
const fs = require('fs');
const path = require('path');

const CANONICAL_PATH = path.resolve(__dirname, '../../cloudfunctions/utils/audit.js');

/**
 * @param {object} fakeDb 由用例提供的 db 替身
 */
function loadCanonical(fakeDb) {
  const src = fs.readFileSync(CANONICAL_PATH, 'utf8');
  const mod = { exports: {} };
  // audit.js 依赖 ./cloud，而 cloud.js 在 require 时就 cloud.init() ——
  // jest 里没有真实的 wx-server-sdk，整个替换掉，只把 db 句柄接进来
  const shimRequire = (request) => {
    if (request === './cloud') {
      return { db: fakeDb };
    }
    return require(request);
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, shimRequire);
  return mod.exports;
}

describe('cloudfunctions/utils/audit.js', () => {
  let fakeDb;
  let addMock;

  beforeEach(() => {
    addMock = jest.fn(() => Promise.resolve({ _id: 'audit-1' }));
    fakeDb = {
      collection: jest.fn(() => ({ add: addMock })),
      serverDate: jest.fn(() => 'SERVER_DATE')
    };
  });

  test('add 必须以 { data } 形式调用，否则写入内容恒空（P0 复现项）', async () => {
    const { log } = loadCanonical(fakeDb);

    await log({ action: 'delete', operator: 'o-1', targetType: 'album', targetId: 'a-1' });

    expect(addMock).toHaveBeenCalledTimes(1);
    const arg = addMock.mock.calls[0][0];
    // 直接传 logData 会让 wx-server-sdk 读不到 options.data，写入内容为空
    expect(arg).toHaveProperty('data');
    expect(Object.keys(arg)).toEqual(['data']);
    expect(arg.data.action).toBe('delete');
    expect(arg.data.operator).toBe('o-1');
    expect(arg.data.result).toBe('success');
    expect(arg.data.createTime).toBe('SERVER_DATE');
  });

  test('写库失败时不抛出（不阻断主流程）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    addMock.mockImplementation(() => Promise.reject(new Error('collection not exists')));
    const { log } = loadCanonical(fakeDb);

    await expect(log({ action: 'delete' })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('operator 缺省为 system，其余字符串字段缺省为空串', async () => {
    const { log } = loadCanonical(fakeDb);

    await log({ action: 'export' });

    const { data } = addMock.mock.calls[0][0];
    expect(data.operator).toBe('system');
    expect(data.targetType).toBe('');
    expect(data.targetId).toBe('');
    expect(data.detail).toBe('');
  });

  test('写入的是 audit_logs 集合（该集合当前未登记在 COLLECTIONS 中）', async () => {
    const { log } = loadCanonical(fakeDb);

    await log({ action: 'export' });

    expect(fakeDb.collection).toHaveBeenCalledWith('audit_logs');
  });
});
