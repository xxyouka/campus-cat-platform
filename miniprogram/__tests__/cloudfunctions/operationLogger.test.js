// __tests__/cloudfunctions/operationLogger.test.js
// 定向回归：wx-server-sdk 的 add 签名为 add(options) 且内部读取 options.data，
// 写成 .add(logData) 会导致日志集合恒为空（P0），此处锁定正确调用形状。
//
// 注意：canonical 源文件位于 cloudfunctions/common/，其 require('../utils/constants')
// 会被 jest.config.js 的 moduleNameMapper（'^../utils/(.*)$' → '<rootDir>/utils/$1'）
// 误映射到不存在的小程序根目录 utils/constants，导致无法通过 jest 的模块系统加载。
// 这里直接读取磁盘上的 canonical 源码，用最小 require shim 求值，
// 保证被断言的正是 canonical 文件本身（其余依赖仍走真实模块）。
const fs = require('fs');
const path = require('path');

const CANONICAL_PATH = path.resolve(__dirname, '../../cloudfunctions/common/operationLogger.js');

function loadCanonical() {
  const src = fs.readFileSync(CANONICAL_PATH, 'utf8');
  const mod = { exports: {} };
  const shimRequire = (request) => {
    // canonical 在 cloudfunctions/<fn>/common/ 下的同层依赖为云函数自带 utils
    if (request === '../utils/constants') {
      return require('../../cloudfunctions/utils/constants');
    }
    // 同层依赖 changeSummary（清洗 changes）：canonical 源在 cloudfunctions/common/，
    // 副本在 <fn>/common/，两条路径都指向同一份 canonical
    if (request === './changeSummary') {
      return require('../../cloudfunctions/common/changeSummary');
    }
    return require(request);
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, shimRequire);
  return mod.exports;
}

const { logOperation } = loadCanonical();

/**
 * 构造一个可区分 admins / operation_logs 的最小 db mock
 * @param {object|null} adminDoc 管理员解析结果（null 表示未命中）
 */
function buildDb(adminDoc) {
  const addMock = jest.fn(() => Promise.resolve({ _id: 'log-id-1' }));
  const db = {
    collection: jest.fn((name) => {
      if (name === 'admins') {
        return {
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: adminDoc ? [adminDoc] : [] }))
            }))
          }))
        };
      }
      return { add: addMock };
    })
  };
  return { db, addMock };
}

describe('operationLogger (cloudfunctions/common/operationLogger.js)', () => {
  test('add 必须以 { data: logData } 形式调用，且落库字段完整', async () => {
    const { db, addMock } = buildDb({ account: 'admin1', displayName: '管理员一' });

    const id = await logOperation(db, 'openid-1', {
      module: 'cats',
      action: 'create',
      description: '新增猫咪'
    });

    expect(id).toBe('log-id-1');
    expect(addMock).toHaveBeenCalledTimes(1);

    const arg = addMock.mock.calls[0][0];
    // 关键断言：参数必须是 { data } 包裹，直接传 logData 会让写入内容为空
    expect(arg).toHaveProperty('data');
    expect(Object.keys(arg)).toEqual(['data']);

    expect(arg.data.module).toBe('cats');
    expect(arg.data.action).toBe('create');
    expect(arg.data.description).toBe('新增猫咪');
    expect(arg.data.result).toBe('success');
    expect(arg.data.adminAccount).toBe('admin1');
    expect(arg.data.adminDisplayName).toBe('管理员一');
    expect(arg.data.adminOpenid).toBe('openid-1');
    expect(arg.data.operateTime).toBeInstanceOf(Date);
    expect(arg.data.expireAt).toBeInstanceOf(Date);
  });

  test('beforeData / afterData 为空时不应写入字段', async () => {
    const { db, addMock } = buildDb({ account: 'admin1' });

    await logOperation(db, 'openid-1', { module: 'cats', action: 'update' });

    const arg = addMock.mock.calls[0][0];
    expect(arg.data).not.toHaveProperty('beforeData');
    expect(arg.data).not.toHaveProperty('afterData');
  });

  // ── 摘要层（summary / changes）────────────────────────────────────────
  // 管理端日志列表读的是这一层，而不是 beforeData/afterData 原始 JSON。
  describe('摘要层 summary / changes', () => {
    test('summary 与 changes 正常落库', async () => {
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', {
        module: 'cat', action: 'edit',
        description: '编辑猫咪: 小花',
        summary: '编辑猫咪「小花」：状态 在校 → 走失',
        changes: [{ label: '状态', from: '在校', to: '走失' }]
      });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data.summary).toBe('编辑猫咪「小花」：状态 在校 → 走失');
      expect(arg.data.changes).toEqual([{ label: '状态', from: '在校', to: '走失' }]);
    });

    test('摘要层与审计层互不干扰：两者可同时存在', async () => {
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', {
        module: 'cat', action: 'edit',
        summary: '编辑猫咪「小花」：校区 A → B',
        changes: [{ label: '校区', from: 'A', to: 'B' }],
        beforeData: { name: '小花' },
        afterData: { name: '小花' }
      });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data.summary).toBeTruthy();
      expect(arg.data.beforeData).toEqual({ name: '小花' });
      expect(arg.data.afterData).toEqual({ name: '小花' });
    });

    test('summary / changes 缺失时不写字段（老调用方不受影响）', async () => {
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', { module: 'photo', action: 'create' });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data).not.toHaveProperty('summary');
      expect(arg.data).not.toHaveProperty('changes');
    });

    test('空值不写字段：避免前端「有摘要」的判断为真却渲染出空白', async () => {
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', {
        module: 'photo', action: 'create',
        summary: '',
        changes: []
      });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data).not.toHaveProperty('summary');
      expect(arg.data).not.toHaveProperty('changes');
    });

    test('脏 changes 被清洗：非对象项/空 label 丢弃，文本与条数封顶', async () => {
      // 超长或畸形的 changes 会让日志文档超限 → 写库失败 →
      // 又被 logOperation 的 catch 吞掉 → 这条操作彻底没有日志。
      // 所以清洗必须发生在写入前，而不是指望调用方守规矩。
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', {
        module: 'cat', action: 'edit',
        changes: [
          null,
          'not an object',
          { label: '备注', from: 'x'.repeat(800), to: 'y' },
          { label: '  ' },
          ...Array.from({ length: 40 }, (_, i) => ({ label: `字段${i}`, from: 'a', to: 'b' }))
        ]
      });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data.changes.length).toBeLessThanOrEqual(12);
      expect(arg.data.changes[0].from.length).toBeLessThanOrEqual(61);
      expect(arg.data.changes.every(c => c.label && c.label.trim())).toBe(true);
    });

    test('summary 超长被硬截断，保证单条日志文档不会失控', async () => {
      const { db, addMock } = buildDb({ account: 'admin1' });

      await logOperation(db, 'openid-1', {
        module: 'cat', action: 'edit',
        summary: 'x'.repeat(5000)
      });

      const arg = addMock.mock.calls[0][0];
      expect(arg.data.summary.length).toBe(300);
    });
  });

  test('写失败时不抛出（不阻断主流程），返回 null 并留下含 module/action 的错误日志', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { db, addMock } = buildDb({ account: 'admin1' });
    addMock.mockImplementation(() => Promise.reject(new Error('collection not exists')));

    const id = await logOperation(db, 'openid-1', { module: 'cats', action: 'delete' });

    expect(id).toBeNull();
    const logged = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('cats');
    expect(logged).toContain('delete');
    errSpy.mockRestore();
  });

  // 「logOperation 永不 reject」是所有调用点敢直接 await 它的前提 ——
  // await 一个 reject 会把已经成功的业务操作回报成失败（日志写不进去是小事，
  // 把删除成功报成删除失败、并触发上层回滚，是大事）。
  // 这条不变式原本靠「参数列表里解构」承担：info 为 undefined/null 时会在进入函数体前抛错，
  // 被 async 转成 rejected promise。现在解构移入 try 内，由函数体自己保证。
  test('第三个参数缺失 / undefined / null 时都不 reject，且照常落库', async () => {
    const { db, addMock } = buildDb({ account: 'admin1' });

    await expect(logOperation(db, 'openid-1')).resolves.toBe('log-id-1');
    await expect(logOperation(db, 'openid-1', undefined)).resolves.toBe('log-id-1');
    await expect(logOperation(db, 'openid-1', null)).resolves.toBe('log-id-1');

    // 防空：确认不是「因为压根没写」才 resolve —— 三次都真的落库了
    expect(addMock).toHaveBeenCalledTimes(3);
  });

  test('db 为 undefined 时同样不 reject，返回 null（失败关闭在函数体内）', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logOperation(undefined, 'openid-1', { module: 'cats', action: 'delete' })
    ).resolves.toBeNull();

    errSpy.mockRestore();
  });

  // 操作日志的价值全在「谁做的」这一栏可信。explicitAccount 一路来自
  // event._adminAccount（客户端可控字符串），旧实现解析不出身份时直接
  // adminAccount = explicitAccount —— 日志于是可以「自称」，事后追责失去意义。
  test('解析不出身份时不采信自称账号：身份标 unverified，自称值另存 claimedAccount', async () => {
    const { db, addMock } = buildDb(null); // admins 未命中

    await logOperation(db, '', { module: 'cats', action: 'create', adminAccount: 'root' });

    const data = addMock.mock.calls[0][0].data;
    expect(data.adminAccount).toBe('unverified');
    expect(data.adminDisplayName).toBe('unknown');
    expect(data.adminOpenid).toBe('');
    // 自称值不丢，但绝不占身份位
    expect(data.claimedAccount).toBe('root');
  });

  test('解析成功时身份以服务端为准，自称值只留档', async () => {
    const { db, addMock } = buildDb({ account: 'admin1', displayName: '管理员一' });

    await logOperation(db, 'openid-1', { module: 'cats', action: 'create', adminAccount: '冒充root' });

    const data = addMock.mock.calls[0][0].data;
    expect(data.adminAccount).toBe('admin1');
    expect(data.claimedAccount).toBe('冒充root');
  });

  test('既无 openid 也无自称：身份 unknown，且不写 claimedAccount 字段', async () => {
    const { db, addMock } = buildDb(null);

    await logOperation(db, '', { module: 'cats', action: 'create' });

    const data = addMock.mock.calls[0][0].data;
    expect(data.adminAccount).toBe('unknown');
    expect(data).not.toHaveProperty('claimedAccount');
  });

  test('openid 为空时不去查 admins（定时器/控制台测试场景不做无谓查询）', async () => {
    const { db, addMock } = buildDb({ account: 'admin1' });

    await logOperation(db, '', { module: 'cats', action: 'create' });

    const queried = db.collection.mock.calls.filter(call => call[0] === 'admins');
    expect(queried).toHaveLength(0);
    expect(addMock).toHaveBeenCalledTimes(1);
  });
});
