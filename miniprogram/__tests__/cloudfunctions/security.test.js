/**
 * __tests__/cloudfunctions/security.test.js
 *
 * P0 越权回归测试：
 * 鉴权必须只信任服务端 cloud.getWXContext().OPENID——客户端传入的
 * _adminAccount 等任何字段都不得作为身份凭据。
 *
 * 策略：不 mock utils/auth（走真实 auth.js），只 mock wx-server-sdk，
 * 让服务端身份与数据库查询都处于可控状态，验证「非管理员 OPENID
 * 调用管理云函数必须被拒绝，且不得写入任何数据」。
 */
jest.mock('wx-server-sdk');

// operationLogger 内部 require('../utils/constants') 会被 jest moduleNameMapper
// 的 '^../utils/(.*)$' 规则错误重定向到主包 utils/，故 mock 掉审计日志模块
// （审计日志不影响越权判定；业务写入的拒绝才是本测试的目标）。
jest.mock('../../cloudfunctions/addCat/common/operationLogger', () => ({
  logOperation: jest.fn()
}));
jest.mock('../../cloudfunctions/updateCat/common/operationLogger', () => ({
  logOperation: jest.fn()
}));
jest.mock('../../cloudfunctions/manageAdmin/common/operationLogger', () => ({
  logOperation: jest.fn()
}));

const VALID_CAT_ID = 'a'.repeat(24); // 24 位 hex，满足 isValidObjectId

// 本文件会覆盖 wx-server-sdk mock 上的这两个方法，用后在 afterAll 恢复，
// 避免污染同进程的其他测试文件
const ORIGINAL_GET_TEMP_FILE_URL = require('wx-server-sdk').getTempFileURL;
const ORIGINAL_UPLOAD_FILE = require('wx-server-sdk').uploadFile;

/**
 * 构造可控数据库 mock：
 * - 'admins' 集合按 adminDoc 参数返回（null 表示无管理员记录）；
 *   admins 的 doc().get() 返回 targetAdminDoc（P2-9：被操作的管理员文档）
 * - 其余集合返回空数据（add/update/remove 均成功但可被断言调用）
 * 同时记录每个 collection(name) 调用，用于断言「未发生写入」。
 */
function makeDatabaseMock(adminDoc, targetAdminDoc) {
  const collectionCalls = [];

  const emptyChain = () => ({
    get: jest.fn(() => Promise.resolve({ data: [] })),
    count: jest.fn(() => Promise.resolve({ total: 0 })),
    limit: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ data: [] })),
      skip: jest.fn()
    })),
    orderBy: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ data: [] })),
      limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
    })),
    update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
    remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
  });

  const db = {
    collection: jest.fn((name) => {
      collectionCalls.push(name);
      if (name === 'admins') {
        return {
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: adminDoc ? [adminDoc] : [] }))
            }))
          })),
          doc: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve(
              targetAdminDoc ? { data: targetAdminDoc } : { data: {} }
            )),
            update: jest.fn(() => Promise.resolve({ stats: { updated: 1 } })),
            remove: jest.fn(() => Promise.resolve({ stats: { removed: 1 } }))
          })),
          add: jest.fn(() => Promise.resolve({ _id: 'mock-id' }))
        };
      }
      return {
        where: jest.fn(emptyChain),
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: {} })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        })),
        add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
        count: jest.fn(() => Promise.resolve({ total: 0 })),
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })),
        skip: jest.fn()
      };
    }),
    command: {
      eq: jest.fn(v => v),
      neq: jest.fn(v => v),
      in: jest.fn(v => v),
      and: jest.fn(v => v),
      or: jest.fn(v => v)
    },
    serverDate: jest.fn(() => 'SERVER_DATE')
  };

  return { db, collectionCalls };
}

/** 重新加载 cloud mock，并把调用者身份设为指定 openid */
function loadCloud(openid) {
  const cloud = require('wx-server-sdk');
  cloud.getWXContext.mockReturnValue({ OPENID: openid || '', APPID: 'app', ENV: 'env' });
  return cloud;
}

/**
 * 定时任务链路（backupData / reconcileMeetCount）所需的数据库 mock：
 * - admins 按 adminDoc 返回（null 表示非管理员）
 * - system_state 无记录（节流放行）且可 add
 * - 其余集合的分页查询一律返回空数据（备份循环立即结束）
 */
function makeTimerDatabaseMock(adminDoc) {
  const collectionCalls = [];
  let systemStateWrites = 0;

  const db = {
    collection: jest.fn((name) => {
      collectionCalls.push(name);
      if (name === 'admins') {
        return {
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: adminDoc ? [adminDoc] : [] }))
            }))
          }))
        };
      }
      return {
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
          })),
          limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          count: jest.fn(() => Promise.resolve({ total: 0 }))
        })),
        // 备份与归档使用稳定排序；备份继续使用 _id 游标避免 offset 在数据变更时漂移
        orderBy: jest.fn(() => ({
          skip: jest.fn(() => ({
            limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
          })),
          limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
        })),
        skip: jest.fn(() => ({
          limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
        })),
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })),
        add: jest.fn(() => {
          if (name === 'system_state') systemStateWrites++;
          return Promise.resolve({ _id: 'mock-state-id' });
        }),
        doc: jest.fn(() => ({
          update: jest.fn(() => {
            if (name === 'system_state') systemStateWrites++;
            return Promise.resolve({ stats: { updated: 1 } });
          })
        }))
      };
    }),
    command: {
      eq: jest.fn(v => v),
      neq: jest.fn(v => v),
      gt: jest.fn(v => v),
      gte: jest.fn(v => v),
      lt: jest.fn(v => v),
      in: jest.fn(v => v),
      and: jest.fn(v => v),
      or: jest.fn(v => v)
    },
    serverDate: jest.fn(() => 'SERVER_DATE')
  };

  return { db, collectionCalls, get systemStateWrites() { return systemStateWrites; } };
}

/** 构造可控的 getWXContext 返回值：定时触发没有 OPENID */
function loadTimerCloud({ openid = '', source = 'wx_trigger' } = {}) {
  const cloud = require('wx-server-sdk');
  cloud.getWXContext.mockReturnValue({ OPENID: openid, ENV: 'env', SOURCE: source });
  return cloud;
}

describe('P0 越权防护：非管理员 OPENID 调用管理云函数必须被拒绝', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    // 恢复被覆盖的 database 实现，防止泄漏到同进程的其他测试文件
    const cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
  });

  test('非管理员调用 addCat：拒绝且不写库（伪造 _adminAccount 无效）', async () => {
    const cloud = loadCloud('hacker-openid-1');
    const { db, collectionCalls } = makeDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/addCat/index');
    const result = await main({
      _adminAccount: 'root', // 客户端伪造的管理员账号，不得生效
      catData: {
        name: '小橘', avatar: 'https://example.com/cat.jpg',
        campus: '本部', status: 'normal', gender: '公',
        color: '橘色', description: '测试猫咪', location: '图书馆'
      }
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权限');
    // 鉴权只查过 admins，绝不允许触碰 cats 写入
    expect(collectionCalls).not.toContain('cats');
    expect(db.collection('cats').add).not.toHaveBeenCalled();
  });

  test('非管理员调用 updateCat：拒绝且不写库', async () => {
    const cloud = loadCloud('hacker-openid-2');
    const { db, collectionCalls } = makeDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/updateCat/index');
    const result = await main({
      _adminAccount: 'root',
      catId: VALID_CAT_ID,
      updateData: { name: '改名的小橘' }
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权限');
    expect(collectionCalls).not.toContain('cats');
  });

  test('非管理员调用 manageAdmin 增删管理员：拒绝', async () => {
    const cloud = loadCloud('hacker-openid-3');
    const { db } = makeDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/manageAdmin/index');

    const addResult = await main({
      action: 'add',
      account: 'newadmin',
      password: '123456',
      displayName: '新管理员',
      _adminAccount: 'root'
    }, {});

    const listResult = await main({ action: 'list', _adminAccount: 'root' }, {});

    expect(addResult.success).toBe(false);
    expect(addResult.error).toContain('超级管理员');
    expect(listResult.success).toBe(false);
    expect(listResult.error).toContain('仅管理员');
  });

  test('无法获取 OPENID 时同样拒绝', async () => {
    const cloud = loadCloud('');
    const { db } = makeDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/addCat/index');
    const result = await main({
      _adminAccount: 'root',
      catData: { name: '小橘', avatar: 'https://example.com/cat.jpg' }
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('无法获取用户身份');
  });

  test('管理员 OPENID 正常放行（对照组：证明 mock 链路有效）', async () => {
    const cloud = loadCloud('real-admin-openid');
    const { db, collectionCalls } = makeDatabaseMock({
      _id: 'admin-1', openid: 'real-admin-openid', role: 'admin',
      account: 'realadmin', displayName: '真管理员'
    });
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/addCat/index');
    const { logOperation } = require('../../cloudfunctions/addCat/common/operationLogger');
    const result = await main({
      catData: {
        name: '小橘', avatar: 'cloud://env.bucket/cats/avatar/1.jpg',
        campus: '本部', status: 'normal', gender: '公',
        color: '橘色', description: '测试猫咪', location: '图书馆'
      }
    }, {});

    expect(result.success).toBe(true);
    expect(collectionCalls).toContain('cats');
    expect(logOperation).toHaveBeenCalled();
  });
});

describe('P0 越权防护：伪造定时触发器事件不得绕过鉴权', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    const cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.getTempFileURL = ORIGINAL_GET_TEMP_FILE_URL;
    cloud.uploadFile = ORIGINAL_UPLOAD_FILE;
  });

  test('客户端伪造 Timer 事件调用 backupData：拒绝且不产生任何备份文件', async () => {
    // 客户端 callFunction 一定带 OPENID，data 会原样合并进 event
    const cloud = loadTimerCloud({ openid: 'hacker-openid', source: 'wx_client' });
    const { db } = makeTimerDatabaseMock(null);
    cloud.database.mockImplementation(() => db);
    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://mock/backups/x.json' }));

    const { main } = require('../../cloudfunctions/backupData/index');
    const result = await main({ Type: 'Timer', TriggerName: 'dailyBackupTimer' }, {});

    expect(result.success).toBe(false);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  test('HTTP 访问服务伪造成定时触发（无 OPENID）：拒绝且不产生任何备份文件', async () => {
    const cloud = loadTimerCloud({ openid: '', source: 'wx_http' });
    const { db } = makeTimerDatabaseMock(null);
    cloud.database.mockImplementation(() => db);
    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://mock/backups/x.json' }));

    const { main } = require('../../cloudfunctions/backupData/index');
    const result = await main({
      httpMethod: 'POST',
      headers: {},
      path: '/backupData',
      body: '{"Type":"Timer","TriggerName":"dailyBackupTimer"}'
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('权限不足');
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  test('真实定时触发（无 OPENID + SOURCE=wx_trigger）正常备份，且响应不含云存储路径', async () => {
    const cloud = loadTimerCloud({ openid: '', source: 'wx_trigger' });
    const { db, collectionCalls } = makeTimerDatabaseMock(null);
    cloud.database.mockImplementation(() => db);
    cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://mock/backups/x.json' }));

    const { main } = require('../../cloudfunctions/backupData/index');
    const result = await main({
      Type: 'Timer', TriggerName: 'dailyBackupTimer', Time: '2026-09-15T03:00:00Z'
    }, {});

    expect(result.success).toBe(true);
    expect(collectionCalls).toContain('cats');
    // 5 个业务集合 + 1 份 manifest；backups/ 只能出现在上传参数里，不能出现在响应里
    expect(cloud.uploadFile).toHaveBeenCalledTimes(6);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('"path"');
    expect(payload).not.toContain('backups/');
  });

  test('客户端伪造 Timer 事件调用 reconcileMeetCount：拒绝且不执行对账', async () => {
    const cloud = loadTimerCloud({ openid: 'hacker-openid', source: 'wx_client' });
    const { db, collectionCalls } = makeTimerDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/reconcileMeetCount/index');
    const result = await main({ Type: 'Timer', TriggerName: 'reconcileTimer' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('仅管理员');
    expect(collectionCalls).not.toContain('repair_logs');
  });

  // ==================== isTrustedTimerEvent 三层纵深防御逐层覆盖 ====================
  //
  // 上面三条用例的输入各自同时触发了两层以上，三层互为冗余：
  //   带 OPENID 的伪造调用→第1层拦；HTTP 形状→第2层拦；SOURCE=wx_client→第3层拦。
  // 于是「删掉任意单层，其余层仍能拦住这三条输入」→ 变异测试全部 green（假测试）。
  //
  // 实务上「第1层是唯一屏障」的场景真实存在：客户端 callFunction 若 SOURCE 为空/缺失，
  // 且事件不带 body/httpMethod，就只剩 OPENID 这一道。
  // 以下输入刻意只留该层可拦，保证删掉任意单层都会有测试变红。
  describe('isTrustedTimerEvent 三层纵深防御逐层可证伪', () => {
    const backupTimerEvent = () => ({ Type: 'Timer', TriggerName: 'dailyBackupTimer' });
    const reconcileTimerEvent = () => ({ Type: 'Timer', TriggerName: 'reconcileTimer' });

    /** backupData 的「未进定时分支」断言：不写备份文件、不碰备份集合、不做定时节流 */
    function expectBackupRejected(result, cloud, collectionCalls) {
      expect(result.success).toBe(false);
      expect(cloud.uploadFile).not.toHaveBeenCalled();
      expect(collectionCalls).not.toContain('cats');
      expect(collectionCalls).not.toContain('system_state');
    }

    async function runBackup({ openid, source }, event) {
      const cloud = loadTimerCloud({ openid, source });
      const { db, collectionCalls } = makeTimerDatabaseMock(null);
      cloud.database.mockImplementation(() => db);
      cloud.uploadFile = jest.fn(() => Promise.resolve({ fileID: 'cloud://mock/backups/x.json' }));

      const { main } = require('../../cloudfunctions/backupData/index');
      const result = await main(event, {});
      return { result, cloud, collectionCalls };
    }

    async function runReconcile({ openid, source }, event) {
      const cloud = loadTimerCloud({ openid, source });
      const { db, collectionCalls } = makeTimerDatabaseMock(null);
      cloud.database.mockImplementation(() => db);

      const { main } = require('../../cloudfunctions/reconcileMeetCount/index');
      const result = await main(event, {});
      return { result, collectionCalls };
    }

    test('backupData · 仅第1层可拦：带 OPENID，无 HTTP 形状，SOURCE 为空', async () => {
      const { result, cloud, collectionCalls } = await runBackup(
        { openid: 'hacker-openid', source: '' }, backupTimerEvent()
      );

      expect(result.error).toContain('权限不足');
      expectBackupRejected(result, cloud, collectionCalls);
    });

    test('backupData · 仅第2层可拦：无 OPENID、SOURCE 为空，但事件带 httpMethod', async () => {
      const { result, cloud, collectionCalls } = await runBackup(
        { openid: '', source: '' }, { ...backupTimerEvent(), httpMethod: 'POST' }
      );

      expectBackupRejected(result, cloud, collectionCalls);
    });

    test('backupData · 仅第3层可拦：无 OPENID、无 HTTP 形状，但 SOURCE=wx_client', async () => {
      const { result, cloud, collectionCalls } = await runBackup(
        { openid: '', source: 'wx_client' }, backupTimerEvent()
      );

      expectBackupRejected(result, cloud, collectionCalls);
    });

    test('reconcileMeetCount · 仅第1层可拦：带 OPENID，无 HTTP 形状，SOURCE 为空', async () => {
      const { result, collectionCalls } = await runReconcile(
        { openid: 'hacker-openid', source: '' }, reconcileTimerEvent()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('仅管理员');
      // 对账会全量重写计数：拒绝时必须连读都没读
      expect(collectionCalls).not.toContain('repair_logs');
      expect(collectionCalls).not.toContain('system_state');
    });

    test('reconcileMeetCount · 仅第2层可拦：无 OPENID、SOURCE 为空，但事件带 httpMethod', async () => {
      const { result, collectionCalls } = await runReconcile(
        { openid: '', source: '' }, { ...reconcileTimerEvent(), httpMethod: 'POST' }
      );

      expect(result.success).toBe(false);
      expect(collectionCalls).not.toContain('repair_logs');
      expect(collectionCalls).not.toContain('system_state');
    });

    test('reconcileMeetCount · 仅第3层可拦：无 OPENID、无 HTTP 形状，但 SOURCE=wx_client', async () => {
      const { result, collectionCalls } = await runReconcile(
        { openid: '', source: 'wx_client' }, reconcileTimerEvent()
      );

      expect(result.success).toBe(false);
      expect(collectionCalls).not.toContain('repair_logs');
      expect(collectionCalls).not.toContain('system_state');
    });
  });

  test('真实定时触发调用 reconcileMeetCount：正常执行对账（对照组）', async () => {
    const cloud = loadTimerCloud({ openid: '', source: 'wx_trigger' });
    const { db, collectionCalls } = makeTimerDatabaseMock(null);
    cloud.database.mockImplementation(() => db);

    const { main } = require('../../cloudfunctions/reconcileMeetCount/index');
    const result = await main({ Type: 'Timer', TriggerName: 'reconcileTimer' }, {});

    expect(result.success).toBe(true);
    expect(result.data.mode).toBe('timer');
    expect(collectionCalls).toContain('repair_logs');
  });

  test('定时备份任一集合上传失败时必须失败且不写入节流标记', async () => {
    const cloud = loadTimerCloud({ openid: '', source: 'wx_trigger' });
    const timerDb = makeTimerDatabaseMock(null);
    const { db } = timerDb;
    cloud.database.mockImplementation(() => db);
    cloud.uploadFile = jest.fn(({ cloudPath }) => {
      if (cloudPath.endsWith('/cats.json')) return Promise.reject(new Error('storage unavailable'));
      return Promise.resolve({ fileID: 'cloud://mock/manifest.json' });
    });

    const { main } = require('../../cloudfunctions/backupData/index');
    const result = await main({ Type: 'Timer', TriggerName: 'dailyBackupTimer' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('部分集合备份失败');
    expect(result.data.collections.cats.error).toBe('storage unavailable');
    expect(timerDb.systemStateWrites).toBe(0);
  });

  test('getCatAvatars 拒绝 backups/ 路径，仅放行业务目录并如实回传被拒项', async () => {
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: 'real-admin-openid', ENV: 'env' });
    const { db } = makeDatabaseMock({
      _id: 'admin-1', openid: 'real-admin-openid', role: 'admin',
      account: 'realadmin', displayName: '真管理员'
    });
    cloud.database.mockImplementation(() => db);

    const requested = [];
    cloud.getTempFileURL = jest.fn(({ fileList }) => {
      requested.push(...fileList);
      return Promise.resolve({
        fileList: fileList.map(id => ({ fileID: id, status: 0, tempFileURL: `https://cdn/${id}` }))
      });
    });

    const backupFileID = 'cloud://env.bucket/backups/2026-09-05T03-00-00/recordMeet.json';
    const avatarFileID = 'cloud://env.bucket/cats/avatar/1.jpg';

    const { main } = require('../../cloudfunctions/getCatAvatars/index');
    const result = await main({ fileIDs: [backupFileID, avatarFileID] }, {});

    expect(result.success).toBe(true);
    // 备份文件根本没进入换链请求
    expect(requested).toEqual([avatarFileID]);
    expect(result.data.rejected).toEqual([backupFileID]);
    expect(result.data.urlMap[avatarFileID]).toBeDefined();
    expect(result.data.urlMap[backupFileID]).toBeUndefined();
  });
});
