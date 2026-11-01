/**
 * __tests__/cloudfunctions/adminLogin.test.js
 *
 * 行为测试：全部通过云函数入口 main() 的结果来验证登录、失败计数与锁定。
 * 不在测试内重写 safeEqual / hashPassword / 常量算术——那样只能证明测试自己是对的。
 * 环境变量（PASSWORD_SALT 等）在模块加载时读取，故 beforeEach 先设 env 再 resetModules。
 */
jest.mock('wx-server-sdk');

describe('adminLogin 云函数', () => {
  const PASSWORD_SALT = 'test_salt_for_unit_testing_64_chars_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ADMIN_ACCOUNT = 'test_admin';
  const ADMIN_PASSWORD = 'correct_password';
  // fixture：sha256('correct_password' + PASSWORD_SALT) 的固定值（64 位 hex），
  // 命中 index.js 的 legacy sha256 分支；写成字面量以免用实现算法反推实现。
  const ADMIN_PASSWORD_HASH = 'fab483e1675158ce69fc614935727146b5447f06b53b207cec9b98513ef5bb57';
  const LOGIN_ATTEMPTS = 'login_attempts';

  let main;

  /**
   * 最小 db mock：
   * - login_attempts 用内存表实现原子自增 / 落锁 / 清理语义，使「连续失败锁定」可被真实触发
   * - options.dbAdmin 存在时，admins 集合按 account 返回该文档（走数据库管理员分支）；
   *   options.openidOwnedByOther 模拟「该 openid 已绑定其他管理员文档」的重复绑定场景
   * - 其余查询返回空、写入成功（环境变量管理员分支）
   */
  function buildDatabase(options = {}) {
    const attempts = new Map();
    let seq = 0;

    const applyUpdate = (record, data) => {
      for (const [key, value] of Object.entries(data)) {
        const isInc = value && typeof value === 'object' && '$inc' in value;
        record[key] = isInc ? (record[key] || 0) + value.$inc : value;
      }
    };

    const find = (query) => {
      const record = attempts.get(query.clientId);
      return record ? [record] : [];
    };

    const attemptsCollection = () => ({
      where: jest.fn((query) => ({
        limit: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: find(query) }))
        })),
        update: jest.fn(({ data }) => {
          const record = attempts.get(query.clientId);
          if (!record) return Promise.resolve({ stats: { updated: 0 } });
          applyUpdate(record, data);
          return Promise.resolve({ stats: { updated: 1 } });
        }),
        remove: jest.fn(() => {
          const existed = attempts.delete(query.clientId);
          return Promise.resolve({ stats: { removed: existed ? 1 : 0 } });
        })
      })),
      add: jest.fn(({ data }) => {
        const _id = `attempt-${++seq}`;
        attempts.set(data.clientId, { _id, ...data });
        return Promise.resolve({ _id });
      }),
      doc: jest.fn((id) => ({
        update: jest.fn(({ data }) => {
          for (const record of attempts.values()) {
            if (record._id === id) applyUpdate(record, data);
          }
          return Promise.resolve({ stats: { updated: 1 } });
        })
      }))
    });

    const adminDocs = options.dbAdmin ? [{ _id: 'db-admin-1', ...options.dbAdmin }] : [];
    const adminUpdates = [];

    const adminsCollection = () => ({
      where: jest.fn((query) => ({
        limit: jest.fn(() => ({
          get: jest.fn(() => {
            // 按 account 查（登录入口）
            if (query.account !== undefined) {
              return Promise.resolve({ data: adminDocs.filter(d => d.account === query.account) });
            }
            // 按 openid 反查（首次绑定前的「是否已绑定其他管理员」守卫）
            return Promise.resolve({
              data: options.openidOwnedByOther ? [{ _id: 'other-admin', account: 'other' }] : []
            });
          })
        }))
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'admin-doc-1' })),
      doc: jest.fn((id) => ({
        update: jest.fn(({ data }) => {
          adminUpdates.push({ id, data });
          const doc = adminDocs.find(d => d._id === id);
          if (doc) Object.assign(doc, data);
          return Promise.resolve({ stats: { updated: doc ? 1 : 0 } });
        })
      }))
    });

    return {
      collection: jest.fn((name) => name === LOGIN_ATTEMPTS ? attemptsCollection() : adminsCollection()),
      command: { inc: jest.fn((value) => ({ $inc: value })), neq: jest.fn((value) => ({ $neq: value })) },
      __adminUpdates: adminUpdates,
      __adminDocs: adminDocs
    };
  }

  /** 载入云函数模块（env 与 db mock 必须在此之前就位） */
  function loadAdminLogin(options = {}) {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    const db = buildDatabase(options);
    cloud.database.mockReturnValue(db);
    return { main: require('../../cloudfunctions/adminLogin/index').main, db };
  }

  beforeEach(() => {
    process.env.PASSWORD_SALT = PASSWORD_SALT;
    process.env.ADMIN_ACCOUNT = ADMIN_ACCOUNT;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD_HASH;
    main = loadAdminLogin().main;
  });

  afterEach(() => {
    delete process.env.PASSWORD_SALT;
    delete process.env.ADMIN_ACCOUNT;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SUPER_ACCOUNT;
    delete process.env.SUPER_PASSWORD;
  });

  afterAll(() => {
    // 恢复被覆盖的 database 实现，防止泄漏到同进程的其他测试文件
    const cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
  });

  test('应拒绝空账号和密码', async () => {
    const result1 = await main({}, {});
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('请输入');

    const result2 = await main({ account: 'admin', password: '' }, {});
    expect(result2.success).toBe(false);
  });

  test('账号不存在时应拒绝登录', async () => {
    const result = await main({ account: 'ghost_admin', password: 'any_password' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('账号或密码错误');
  });

  test('正确账号密码可登录成功，且重复登录仍然成功', async () => {
    const first = await main({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(first.success).toBe(true);
    expect(first.data.role).toBe('admin');

    const second = await main({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(second.success).toBe(true);
  });

  test('失败未达阈值仍可登录，成功登录会清零失败计数', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await main({ account: ADMIN_ACCOUNT, password: 'wrong_password' }, {});
      expect(res.error).toContain('账号或密码错误');
    }

    const passed = await main({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(passed.success).toBe(true);

    // 成功后计数若未清零，接下来第 5 次失败就会落锁，这里的错误信息会变成「过于频繁」
    for (let i = 0; i < 4; i++) {
      const res = await main({ account: ADMIN_ACCOUNT, password: 'wrong_password' }, {});
      expect(res.error).toContain('账号或密码错误');
    }
  });

  test('连续 5 次失败后锁定，此时即使密码正确也拒绝', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await main({ account: ADMIN_ACCOUNT, password: 'wrong_password' }, {});
      expect(res.error).toContain('账号或密码错误');
    }

    const locked = await main({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(locked.success).toBe(false);
    expect(locked.error).toContain('登录尝试过于频繁');
  });

  test('网页端不同 IP 的限流桶必须相互独立', async () => {
    // 回归防护：管理后台走 HTTP 触发器，WXContext.OPENID 恒空。
    // 原实现退化成常量 'web_unknown' —— 全体网页端管理员共用一个计数桶，
    // 任意匿名者连打 5 次就能把所有人一起锁死 15 分钟。
    //
    // 用不同账号分别验证两层：IP 桶要独立（否则跨 IP 互相锁死），
    // 账号桶要共享（否则换 IP 撞库无限试）。
    const withIp = (ip) => ({ headers: { 'x-forwarded-for': ip } });

    // 模拟 web 端：HTTP 触发器下 getWXContext().OPENID 为空。
    // 共享 mock 恒返回 OPENID='test-openid'，不置空的话 clientId 永远走 openid 分支，
    // IP 分桶根本不会被执行到。
    const cloud = require('wx-server-sdk');
    const originalCtx = cloud.getWXContext.getMockImplementation
      ? cloud.getWXContext.getMockImplementation()
      : null;
    cloud.getWXContext.mockImplementation(() => ({ OPENID: '', APPID: 'test-appid', ENV: 'mock-env' }));

    try {
      // IP-A 对账号 ghost_a 打满 5 次
      for (let i = 0; i < 5; i++) {
        const res = await main({ account: 'ghost_a', password: 'bad', ...withIp('1.1.1.1') }, {});
        expect(res.error).toContain('账号或密码错误');
      }
      // IP-A 自己被锁
      const lockedA = await main({ account: 'ghost_a', password: 'bad', ...withIp('1.1.1.1') }, {});
      expect(lockedA.error).toContain('过于频繁');

      // IP-B 对**另一个账号**的首次尝试不应被 IP-A 的锁定牵连
      const other = await main({ account: 'ghost_b', password: 'bad', ...withIp('2.2.2.2') }, {});
      expect(other.success).toBe(false);
      expect(other.error).toContain('账号或密码错误');
      expect(other.error).not.toContain('过于频繁');

      // 但换 IP 撞**同一账号**仍会被账号维度限流拦住（防撞库）
      const afterSwitch = await main({ account: 'ghost_a', password: 'bad', ...withIp('3.3.3.3') }, {});
      expect(afterSwitch.error).toContain('过于频繁');
    } finally {
      cloud.getWXContext.mockImplementation(originalCtx);
    }
  });

  test('缺少 PASSWORD_SALT 时拒绝登录，而不是回退到固定盐', async () => {
    delete process.env.PASSWORD_SALT;

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const isolatedMain = loadAdminLogin().main;
    errSpy.mockRestore();

    const res = await isolatedMain({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('服务器配置错误');
  });

  test('环境管理员登录：返回库中真实角色，而不是 env 凭据对应的登录角色', async () => {
    // 库中该账号的角色已被改（如降权/改名），env 登录不得再报 env 侧的 loginRole：
    // 客户端的菜单与徽章按这个返回值渲染，而后端校验只认库里的 role，两者必须一致
    // openid 必须与当前调用者一致：14a2e91 起「已绑定不换绑」对 env 账号分支同样生效，
    // 不一致会在绑定校验处被拒（该拒绝行为由下一条用例单独覆盖）
    const { main: envMain } = loadAdminLogin({
      dbAdmin: { account: ADMIN_ACCOUNT, role: 'superadmin', password: 'x', salt: 'y', openid: 'test-openid' }
    });

    const res = await envMain({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(true);
    expect(res.data.role).toBe('superadmin');
  });

  test('环境管理员登录：库中记录已绑定其他微信时拒绝换绑', async () => {
    // 14a2e91 起与 DB 分支同口径：已有绑定 → 永不换绑（此前缺失会导致
    // 登录成功但 checkAdmin 按真实 OPENID 查不到，所有操作报「无权限」）
    const { main: envMain } = loadAdminLogin({
      dbAdmin: { account: ADMIN_ACCOUNT, role: 'superadmin', password: 'x', salt: 'y', openid: 'bound-openid' }
    });

    const res = await envMain({ account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('已绑定其他微信');
  });

  // ===== 创始人（SUPER_ACCOUNT）三档顶级 =====
  // SUPER_ACCOUNT 是 founder 的唯一事实源：凭据验证通过即创始人，
  // 存量 superadmin 文档登录时自动升格（幂等），无需手改数据库。
  test('SUPER_ACCOUNT 登录：返回创始人角色，存量 superadmin 文档自动升格为 founder', async () => {
    process.env.SUPER_ACCOUNT = 'test_super';
    process.env.SUPER_PASSWORD = ADMIN_PASSWORD_HASH;
    const { main: envMain, db } = loadAdminLogin({
      dbAdmin: { account: 'test_super', role: 'superadmin', password: 'x', salt: 'y', openid: 'test-openid' }
    });

    const res = await envMain({ account: 'test_super', password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(true);
    expect(res.data.role).toBe('founder');
    expect(db.__adminUpdates.some(u => u.data.role === 'founder')).toBe(true);
    expect(db.__adminDocs[0].role).toBe('founder');
  });

  test('SUPER_ACCOUNT 首次登录：直接以 founder 建档并下发全量权限', async () => {
    process.env.SUPER_ACCOUNT = 'test_super';
    process.env.SUPER_PASSWORD = ADMIN_PASSWORD_HASH;
    const { main: envMain } = loadAdminLogin();

    const res = await envMain({ account: 'test_super', password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(true);
    expect(res.data.role).toBe('founder');
    expect(res.data.permissions).toHaveLength(10);
  });

  test('SUPER_ACCOUNT 已是 founder 时登录幂等（不再重复写 role）', async () => {
    process.env.SUPER_ACCOUNT = 'test_super';
    process.env.SUPER_PASSWORD = ADMIN_PASSWORD_HASH;
    const { main: envMain, db } = loadAdminLogin({
      dbAdmin: { account: 'test_super', role: 'founder', password: 'x', salt: 'y', openid: 'test-openid' }
    });

    const res = await envMain({ account: 'test_super', password: ADMIN_PASSWORD }, {});
    expect(res.success).toBe(true);
    expect(res.data.role).toBe('founder');
    expect(db.__adminUpdates.some(u => u.data.role)).toBe(false);
  });

  describe('数据库管理员分支（manageAdmin 创建的账号）', () => {
    const DB_ACCOUNT = 'sub_admin';
    const DB_PASSWORD = 'db_correct_password';
    // fixture：sha256('db_correct_password' + 'db_salt') 的固定值（64 位 hex），
    // 命中 legacy sha256 分支并触发升级为 scrypt
    const DB_PASSWORD_HASH = '7ce02141cddb5f38a2ddb0e79dbc176f85b8f68b84d86febb97f1c0a8b17f65b';

    function loadWithDbAdmin(dbAdminOverrides = {}, options = {}) {
      return loadAdminLogin({
        dbAdmin: {
          account: DB_ACCOUNT,
          salt: 'db_salt',
          password: DB_PASSWORD_HASH,
          role: 'admin',
          openid: '',
          ...dbAdminOverrides
        },
        ...options
      });
    }

    test('正确密码可登录，首次登录绑定 openid', async () => {
      const { main: dbMain, db } = loadWithDbAdmin();
      const res = await dbMain({ account: DB_ACCOUNT, password: DB_PASSWORD }, {});
      expect(res.success).toBe(true);
      expect(res.data.role).toBe('admin');
      expect(db.__adminUpdates.some(u => u.data.openid === 'test-openid')).toBe(true);
    });

    test('该 openid 已绑定其他管理员时拒绝登录（防止一 openid 绑多条记录）', async () => {
      const { main: dbMain, db } = loadWithDbAdmin({ openid: '' }, { openidOwnedByOther: true });
      const res = await dbMain({ account: DB_ACCOUNT, password: DB_PASSWORD }, {});
      expect(res.success).toBe(false);
      expect(res.error).toContain('已绑定其他管理员');
      // 不得写入任何 openid
      expect(db.__adminUpdates.some(u => u.data.openid)).toBe(false);
    });

    test('账号已绑定其他微信时拒绝换绑，且不得覆盖原 openid', async () => {
      const { main: dbMain, db } = loadWithDbAdmin({ openid: 'another-openid' });
      const res = await dbMain({ account: DB_ACCOUNT, password: DB_PASSWORD }, {});
      expect(res.success).toBe(false);
      expect(res.error).toContain('已绑定其他微信');
      expect(db.__adminUpdates.some(u => u.data.openid)).toBe(false);
      // 原绑定保持不变
      expect(db.__adminDocs[0].openid).toBe('another-openid');
    });
  });
});
