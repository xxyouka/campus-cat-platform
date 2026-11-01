/**
 * __tests__/cloudfunctions/manageAdmin.test.js
 *
 * manageAdmin 云函数回归（此前该文件零测试，覆盖率全项目最低）：
 * 覆盖「创建子管理员 → 编辑 → 移除 → 列表」全链路与角色门禁。
 *
 * 重点锁定本轮修复：编辑一个不存在/已被移除的管理员，必须显式失败，
 * 不得因为 doc().update 对不存在文档「0 行更新且不抛错」而返回「修改成功」。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/manageAdmin/utils/auth', () => ({
  // 保留权限白名单/默认值/生效名单等纯函数，只替换有 IO 的 checkAdmin
  ...jest.requireActual('../../cloudfunctions/manageAdmin/utils/auth'),
  checkAdmin: jest.fn(),
  clearCache: jest.fn()
}));
jest.mock('../../cloudfunctions/manageAdmin/common/operationLogger', () => ({
  logOperation: jest.fn(() => Promise.resolve())
}));

const SUPERADMIN_AUTH = {
  isAdmin: true,
  error: null,
  adminInfo: { _id: 'sa-1', account: 'root', role: 'superadmin' }
};
const OTHER_SUPER_AUTH = {
  isAdmin: true,
  error: null,
  adminInfo: { _id: 'sa-2', account: 'other_root', role: 'superadmin' }
};
const FOUNDER_AUTH = {
  isAdmin: true,
  error: null,
  adminInfo: { _id: 'f-1', account: 'root', role: 'founder' }
};
const ADMIN_AUTH = {
  isAdmin: true,
  error: null,
  adminInfo: { _id: 'a-1', account: 'sub', role: 'admin' }
};
const NOT_ADMIN_AUTH = { isAdmin: false, error: '无权限', adminInfo: null };

function makeDb(initialDocs = []) {
  const store = initialDocs.map((d, i) => ({ _id: d._id || `admin-${i + 1}`, ...d }));
  const updates = [];
  const removes = [];
  const adds = [];

  const collection = {
    where: jest.fn((query) => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: store.filter(d => query.account === undefined || d.account === query.account)
        }))
      }))
    })),
    add: jest.fn(({ data }) => {
      const doc = { _id: `new-${store.length + 1}`, ...data };
      store.push(doc);
      adds.push(doc);
      return Promise.resolve({ _id: doc._id });
    }),
    // 列表接口用的无 where get()
    get: jest.fn(() => Promise.resolve({ data: store })),
    doc: jest.fn((id) => ({
      // 与 wx-server-sdk 真实行为一致：文档不存在时直接 reject（throwOnNotFound 默认 true）
      get: jest.fn(() => {
        const doc = store.find(d => d._id === id);
        if (!doc) return Promise.reject(new Error(`document with _id ${id} does not exist`));
        return Promise.resolve({ data: doc });
      }),
      update: jest.fn(({ data }) => {
        updates.push({ id, data });
        const doc = store.find(d => d._id === id);
        if (doc) {
          // 模拟 db.command.remove() 的字段删除语义（否则 Object.assign 会把哨兵值写进文档）
          for (const [key, value] of Object.entries(data)) {
            if (value === 'CMD_REMOVE') delete doc[key];
            else doc[key] = value;
          }
        }
        return Promise.resolve({ stats: { updated: doc ? 1 : 0 } });
      }),
      remove: jest.fn(() => {
        removes.push(id);
        const idx = store.findIndex(d => d._id === id);
        if (idx >= 0) store.splice(idx, 1);
        return Promise.resolve({ stats: { removed: idx >= 0 ? 1 : 0 } });
      })
    }))
  };

  return {
    db: {
      collection: jest.fn(() => collection),
      command: { neq: jest.fn(v => v), remove: jest.fn(() => 'CMD_REMOVE') },
      serverDate: jest.fn(() => 'SERVER_DATE')
    },
    store,
    updates,
    removes,
    adds
  };
}

describe('manageAdmin 云函数', () => {
  let cloud;
  let auth;
  let logger;
  let main;

  function setup(authResult, initialDocs = []) {
    jest.resetModules();
    const fake = makeDb(initialDocs);
    cloud = require('wx-server-sdk');
    cloud.database.mockReturnValue(fake.db);
    auth = require('../../cloudfunctions/manageAdmin/utils/auth');
    auth.checkAdmin.mockResolvedValue(authResult || SUPERADMIN_AUTH);
    logger = require('../../cloudfunctions/manageAdmin/common/operationLogger');
    logger.logOperation.mockClear();
    main = require('../../cloudfunctions/manageAdmin/index').main;
    return fake;
  }

  afterEach(() => {
    // 所有者判定在模块加载时读取 SUPER_ACCOUNT，测完必须清掉，避免污染后续用例
    delete process.env.SUPER_ACCOUNT;
  });

  describe('add（创建子管理员）', () => {
    test('超级管理员可创建：写入 scrypt 哈希 + 固定 admin 角色', async () => {
      const fake = setup(SUPERADMIN_AUTH);

      const res = await main({ action: 'add', account: 'new_sub', password: 'pass123', displayName: '小助手' });

      expect(res.success).toBe(true);
      const created = fake.store.find(d => d.account === 'new_sub');
      expect(created).toBeTruthy();
      expect(created.role).toBe('admin');
      expect(created.password).toMatch(/^[a-fA-F0-9]{128}$/); // scrypt 64 字节 hex
      expect(created.salt).toMatch(/^[a-fA-F0-9]{32}$/);
      expect(created.hashAlgorithm).toBe('scrypt');
      // 子账号创建时不得写 openid（首次登录时才绑定）
      expect(created.openid).toBeUndefined();
      expect(logger.logOperation).toHaveBeenCalled();
      // 新账号默认只开「添加新猫 / 猫咪管理 / 照片管理」
      expect(created.permissions).toEqual(['addCat', 'cat', 'photo']);
    });

    test('普通管理员被拒绝', async () => {
      const fake = setup(ADMIN_AUTH);
      const res = await main({ action: 'add', account: 'x_1', password: 'pass123' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
      expect(fake.store).toHaveLength(0);
    });

    test('账号重复被拒绝', async () => {
      const fake = setup(SUPERADMIN_AUTH, [{ account: 'dup', password: 'x', salt: 'y', role: 'admin' }]);
      const res = await main({ action: 'add', account: 'dup', password: 'pass123' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('已存在');
      expect(fake.adds).toHaveLength(0);
    });

    test('账号格式 / 密码长度在服务端二次校验', async () => {
      setup(SUPERADMIN_AUTH);
      const badAccount = await main({ action: 'add', account: '非法账号', password: 'pass123' });
      expect(badAccount.success).toBe(false);

      const shortPwd = await main({ action: 'add', account: 'ok_account', password: '123' });
      expect(shortPwd.success).toBe(false);
      expect(shortPwd.error).toContain('至少');
    });

    // 身份字段被客户端字符串污染的回归锁：
    // 旧实现把 `callerOpenid || adminAccount` 同时用作 logOperation 的 callerOpenid
    // 位参与 admins.createdBy，OPENID 为空（控制台测试 / 定时器）时，
    // event._adminAccount 这个客户端可控值就以「操作人」身份落库。
    test('身份只认服务端 OPENID：自称账号不得污染日志身份与 createdBy', async () => {
      const fake = setup(SUPERADMIN_AUTH);

      const res = await main({ action: 'add', account: 'sub_new', password: 'pass123', _adminAccount: '冒充root' });
      expect(res.success).toBe(true);

      // logOperation(db, callerOpenid, {...})：第二个位参必须是真实 openid
      expect(logger.logOperation.mock.calls[0][1]).toBe('test-openid');
      // 自称值只能进 info.adminAccount 这个「待核验旁证」位
      expect(logger.logOperation.mock.calls[0][2].adminAccount).toBe('冒充root');

      const created = fake.store.find(d => d.account === 'sub_new');
      expect(created.createdBy).toBe('test-openid');
    });
  });

  describe('update（编辑）', () => {
    test('目标不存在时显式失败，不得谎报「修改成功」', async () => {
      const fake = setup(SUPERADMIN_AUTH);
      const res = await main({ action: 'update', targetId: 'ghost-id', displayName: '新名字' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('不存在');
      expect(fake.updates).toHaveLength(0);
    });

    test('超级管理员可改显示名与重置密码，且日志不含哈希/盐', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-1', account: 'sub', displayName: '旧名', role: 'admin', password: 'old', salt: 'old_salt' }
      ]);

      const res = await main({
        action: 'update', targetId: 'a-1', displayName: '新名', password: 'newpass1'
      });

      expect(res.success).toBe(true);
      const updated = fake.store.find(d => d._id === 'a-1');
      expect(updated.displayName).toBe('新名');
      expect(updated.password).toMatch(/^[a-fA-F0-9]{128}$/);
      expect(updated.hashAlgorithm).toBe('scrypt');

      const logArg = logger.logOperation.mock.calls[0][2];
      expect(logArg.afterData).toBeDefined();
      expect(logArg.afterData.password).toBeUndefined();
      expect(logArg.afterData.salt).toBeUndefined();
    });

    test('普通管理员被拒绝', async () => {
      setup(ADMIN_AUTH);
      const res = await main({ action: 'update', targetId: 'a-1', displayName: 'x' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
    });

    test('普通管理员不能重置密码（管理员管理仅超管）', async () => {
      setup(ADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'a-2', password: 'newpass1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
    });

    test('不能变更自己的角色（按文档 _id 判定，不依赖客户端字段）', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'update', targetId: 'sa-1', role: 'admin' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('自己的角色');
      expect(fake.updates).toHaveLength(0);
    });

    // 超管可以管理自己提升上来的超管：改显示名/密码，或降级回收权限。
    // 自己仍是不可变更的边界（上一条用例），因此不会出现「零超管」。
    test('超管可编辑并降级另一个超管（角色→admin 写日志）', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'other', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'sa-2', displayName: '新名', role: 'admin' });

      expect(res.success).toBe(true);
      const updated = fake.store.find(d => d._id === 'sa-2');
      expect(updated.role).toBe('admin');
      expect(updated.displayName).toBe('新名');
      const logArg = logger.logOperation.mock.calls[0][2];
      expect(logArg.description).toContain('角色→admin');
    });

    test('配置 SUPER_ACCOUNT 后：非创始人超管不能编辑其他超管', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-3', account: 'third', displayName: 'third', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'sa-3', displayName: 'x' });

      expect(res.success).toBe(false);
      expect(res.error).toContain('仅创始人可管理其他超级管理员');
    });

    test('配置 SUPER_ACCOUNT 后：非创始人超管不能升降其他超管', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      const fake = setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-3', account: 'third', displayName: 'third', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'sa-3', role: 'admin' });

      expect(res.success).toBe(false);
      expect(fake.updates).toHaveLength(0);
    });

    test('配置 SUPER_ACCOUNT 后：创始人（存量 superadmin 文档）仍可降级提升上来的超管', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'other', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'sa-2', role: 'admin' });

      expect(res.success).toBe(true);
      expect(fake.store.find(d => d._id === 'sa-2').role).toBe('admin');
    });

    test('升格后的 founder 调用者可降级其他超管', async () => {
      const fake = setup(FOUNDER_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'other', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'sa-2', role: 'admin' });

      expect(res.success).toBe(true);
      expect(fake.store.find(d => d._id === 'sa-2').role).toBe('admin');
    });

    test('角色入参白名单不含 founder：不能把任何人手动提升为创始人', async () => {
      const fake = setup(FOUNDER_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'update', targetId: 'a-2', role: 'founder' });

      expect(res.success).toBe(false);
      expect(res.error).toContain('无效的角色值');
      expect(fake.updates).toHaveLength(0);
    });

    test('不能变更创始人账号的角色', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'update', targetId: 'sa-1', role: 'admin' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('创始人');
    });
  });

  describe('remove（移除）', () => {
    test('不能移除自己', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'remove', targetId: 'sa-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('自己');
    });

    test('不能移除超级管理员', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'other', role: 'superadmin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'remove', targetId: 'sa-2' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('超级管理员');
      expect(res.error).toContain('请先');
    });

    test('创始人账号不可被其他超管移除', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'remove', targetId: 'sa-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('创始人账号不可移除');
    });

    test('升格后的 founder 文档同样不可被移除（与 SUPER_ACCOUNT 推导同口径）', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'f-1', account: 'root', displayName: 'root', role: 'founder', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'remove', targetId: 'f-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('创始人账号不可移除');
    });

    test('可正常移除普通管理员', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-1', account: 'sub', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'remove', targetId: 'a-1' });
      expect(res.success).toBe(true);
      expect(fake.store).toHaveLength(0);
      expect(fake.removes).toEqual(['a-1']);
    });
  });

  describe('unbind（解绑微信）', () => {
    const boundAdmin = {
      _id: 'a-1', account: 'sub', displayName: '小助手', role: 'admin',
      password: 'p', salt: 's', openid: 'o-bound-1'
    };

    test('超级管理员可解绑：清除 openid 并写入操作日志', async () => {
      const fake = setup(SUPERADMIN_AUTH, [{ ...boundAdmin }]);
      const res = await main({ action: 'unbind', targetId: 'a-1' });

      expect(res.success).toBe(true);
      const updated = fake.store.find(d => d._id === 'a-1');
      // 字段被真正移除（db.command.remove 语义），此后 adminLogin 允许重新绑定
      expect(updated.openid).toBeUndefined();
      // 密码/盐不受影响
      expect(updated.password).toBe('p');
      expect(logger.logOperation).toHaveBeenCalled();
      const logArg = logger.logOperation.mock.calls[0][2];
      expect(logArg.description).toContain('解绑');
      expect(logArg.beforeData.boundOpenid).toBe(true);
      expect(logArg.beforeData.openid).toBeUndefined();
    });

    test('普通管理员被拒绝', async () => {
      const fake = setup(ADMIN_AUTH, [{ ...boundAdmin }]);
      const res = await main({ action: 'unbind', targetId: 'a-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
      expect(fake.updates).toHaveLength(0);
    });

    test('不能解绑自己', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's', openid: 'o-root' }
      ]);
      const res = await main({ action: 'unbind', targetId: 'sa-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('自己');
      expect(fake.updates).toHaveLength(0);
    });

    test('不能解绑超级管理员', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'other', role: 'superadmin', password: 'p', salt: 's', openid: 'o-root-2' }
      ]);
      const res = await main({ action: 'unbind', targetId: 'sa-2' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('超级管理员');
      expect(res.error).toContain('请先');
      expect(fake.updates).toHaveLength(0);
    });

    test('创始人账号不可被其他超管解绑', async () => {
      process.env.SUPER_ACCOUNT = 'root';
      const fake = setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's', openid: 'o-root' }
      ]);
      const res = await main({ action: 'unbind', targetId: 'sa-1' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('创始人账号不可解绑');
      expect(fake.updates).toHaveLength(0);
    });

    test('目标不存在时显式失败', async () => {
      const fake = setup(SUPERADMIN_AUTH, [{ ...boundAdmin }]);
      const res = await main({ action: 'unbind', targetId: 'ghost-id' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('不存在');
      expect(fake.updates).toHaveLength(0);
    });

    test('缺少 targetId 被拒绝', async () => {
      setup(SUPERADMIN_AUTH, [{ ...boundAdmin }]);
      const res = await main({ action: 'unbind' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('缺少');
    });

    test('未绑定微信的账号：明确报错而非假装成功', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-2', account: 'nobind', displayName: 'nobind', role: 'admin', password: 'p', salt: 's' }
      ]);
      const res = await main({ action: 'unbind', targetId: 'a-2' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('尚未绑定');
      expect(fake.updates).toHaveLength(0);
    });
  });

  describe('list（列表）', () => {
    test('超管可查看，且返回不含密码/盐/openid', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'a-1', account: 'sub', displayName: '小助手', role: 'admin', password: 'secret-hash', salt: 'secret-salt', openid: 'ox-1' }
      ]);
      const res = await main({ action: 'list' });
      expect(res.success).toBe(true);
      expect(res.data.admins).toHaveLength(1);
      expect(JSON.stringify(res.data.admins)).not.toContain('secret');
      expect(res.data.admins[0].openid).toBeUndefined();
      expect(res.data.admins[0].boundOpenid).toBe(true);
    });

    test('列表返回绑定状态布尔值（含未绑定），不下发 openid 原文', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'a-1', account: 'bound', displayName: 'B', role: 'admin', password: 'x', salt: 'y', openid: 'o-1' },
        { _id: 'a-2', account: 'unbound', displayName: 'U', role: 'admin', password: 'x', salt: 'y' }
      ]);
      const res = await main({ action: 'list' });
      const byId = {};
      res.data.admins.forEach(a => { byId[a._id] = a; });
      expect(byId['a-1'].boundOpenid).toBe(true);
      expect(byId['a-2'].boundOpenid).toBe(false);
      expect(JSON.stringify(res.data.admins)).not.toContain('o-1');
    });

    test('列表标记本人（isSelf）：客户端据此隐藏本人行的编辑/移除', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'R', role: 'superadmin', password: 'x', salt: 'y' },
        { _id: 'a-2', account: 'sub2', displayName: 'S', role: 'admin', password: 'x', salt: 'y' }
      ]);
      const res = await main({ action: 'list' });
      const byId = {};
      res.data.admins.forEach(a => { byId[a._id] = a; });
      expect(byId['sa-1'].isSelf).toBe(true);
      expect(byId['a-2'].isSelf).toBe(false);
      expect(res.data.founderEnforced).toBe(false);
    });

    test('列表标记创始人：SUPER_ACCOUNT 对应超管 isFounder=true（兼容升格前文档），callerIsFounder 随调用者', async () => {
      process.env.SUPER_ACCOUNT = 'root';

      setup(SUPERADMIN_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'R', role: 'superadmin', password: 'x', salt: 'y' },
        { _id: 'sa-2', account: 'other_root', displayName: 'O', role: 'superadmin', password: 'x', salt: 'y' },
        { _id: 'a-3', account: 'sub', displayName: 'S', role: 'admin', password: 'x', salt: 'y' }
      ]);
      let res = await main({ action: 'list' });
      const byId = {};
      res.data.admins.forEach(a => { byId[a._id] = a; });
      expect(res.data.callerIsFounder).toBe(true);
      expect(res.data.founderEnforced).toBe(true);
      expect(byId['sa-1'].isFounder).toBe(true);
      expect(byId['sa-2'].isFounder).toBe(false);
      expect(byId['a-3'].isFounder).toBe(false);

      setup(OTHER_SUPER_AUTH, [
        { _id: 'sa-1', account: 'root', displayName: 'R', role: 'superadmin', password: 'x', salt: 'y' },
        { _id: 'sa-2', account: 'other_root', displayName: 'O', role: 'superadmin', password: 'x', salt: 'y' }
      ]);
      res = await main({ action: 'list' });
      expect(res.data.callerIsFounder).toBe(false);
    });

    test('列表标记创始人：已升格 founder 文档 isFounder=true（不依赖 SUPER_ACCOUNT 配置）', async () => {
      setup(OTHER_SUPER_AUTH, [
        { _id: 'f-1', account: 'root', displayName: 'R', role: 'founder', password: 'x', salt: 'y' },
        { _id: 'sa-2', account: 'other_root', displayName: 'O', role: 'superadmin', password: 'x', salt: 'y' }
      ]);
      const res = await main({ action: 'list' });
      const byId = {};
      res.data.admins.forEach(a => { byId[a._id] = a; });
      expect(byId['f-1'].isFounder).toBe(true);
      expect(byId['f-1'].role).toBe('founder');
      expect(byId['sa-2'].isFounder).toBe(false);
    });

    test('列表下发生效权限：历史文档默认 3 项，超管全部 10 项', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'a-1', account: 'legacy', displayName: 'L', role: 'admin', password: 'x', salt: 'y' },
        { _id: 'a-2', account: 'granted', displayName: 'G', role: 'admin', password: 'x', salt: 'y', permissions: ['mediaReview'] },
        { _id: 'sa-1', account: 'root', displayName: 'R', role: 'superadmin', password: 'x', salt: 'y' }
      ]);
      const res = await main({ action: 'list' });
      const byId = {};
      res.data.admins.forEach(a => { byId[a._id] = a; });
      expect(byId['a-1'].permissions).toEqual(['addCat', 'cat', 'photo']);
      expect(byId['a-2'].permissions).toEqual(['mediaReview']);
      expect(byId['sa-1'].permissions).toHaveLength(10);
    });

    test('非管理员被拒绝', async () => {
      setup(NOT_ADMIN_AUTH);
      const res = await main({ action: 'list' });
      expect(res.success).toBe(false);
    });

    test('普通管理员不能读全量账号列表（管理员管理仅超管）', async () => {
      setup(ADMIN_AUTH, [
        { _id: 'a-1', account: 'sub', displayName: '小助手', role: 'admin', password: 'x', salt: 'y' }
      ]);
      const res = await main({ action: 'list' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
    });
  });

  describe('updatePermissions（入口权限）', () => {
    test('超管可保存并写操作日志', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'a-2', permissions: ['addCat', 'mediaReview']
      });

      expect(res.success).toBe(true);
      expect(fake.store.find(d => d._id === 'a-2').permissions).toEqual(['addCat', 'mediaReview']);

      const log = logger.logOperation.mock.calls[0][2];
      expect(log.description).toContain('调整管理员权限');
      expect(log.description).toContain('内容复核');
      expect(log.afterData.permissions).toEqual(['addCat', 'mediaReview']);
    });

    test('普通管理员不能调用（管理员管理仅超管）', async () => {
      const fake = setup(ADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'a-2', permissions: ['addCat', 'logs']
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('仅超级管理员');
      expect(fake.updates).toHaveLength(0);
    });

    test('拒绝未知权限 key（不能静默丢弃）', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'a-2', permissions: ['addCat', 'bogus']
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('无效的权限项');
      expect(fake.updates).toHaveLength(0);
    });

    test('管理员管理不再是可授权入口（admins 已从白名单移除）', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'a-2', permissions: ['admins']
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('无效的权限项');
      expect(fake.updates).toHaveLength(0);
    });

    test('不能给超级管理员调权限', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'sa-2', account: 'other_root', displayName: 'root', role: 'superadmin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'sa-2', permissions: ['addCat']
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('超级管理员');
    });

    test('不能给创始人调权限（三档顶级恒全量）', async () => {
      setup(SUPERADMIN_AUTH, [
        { _id: 'f-1', account: 'root', displayName: 'root', role: 'founder', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'f-1', permissions: ['addCat']
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('全部权限');
    });

    test('创始人（founder 角色）可调整普通管理员入口权限', async () => {
      const fake = setup(FOUNDER_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({
        action: 'updatePermissions', targetId: 'a-2', permissions: ['report']
      });

      expect(res.success).toBe(true);
      expect(fake.store.find(d => d._id === 'a-2').permissions).toEqual(['report']);
    });

    test('空数组是合法的「全部关闭」', async () => {
      const fake = setup(SUPERADMIN_AUTH, [
        { _id: 'a-2', account: 'sub2', displayName: '小助手', role: 'admin', password: 'p', salt: 's' }
      ]);

      const res = await main({ action: 'updatePermissions', targetId: 'a-2', permissions: [] });

      expect(res.success).toBe(true);
      expect(fake.store.find(d => d._id === 'a-2').permissions).toEqual([]);
    });
  });

  test('未知操作返回失败', async () => {
    setup(SUPERADMIN_AUTH);
    const res = await main({ action: 'drop-table' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('未知操作');
  });
});
