process.env.SUBSCRIBE_STATUS_TEMPLATE_ID = 'tmpl-status';
/**
 * __tests__/cloudfunctions/updateCat.test.js
 * 覆盖编辑猫咪的参数校验、鉴权与正常更新路径。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/updateCat/utils/sanitizer', () => ({
  sanitize: jest.fn((str, opts) => {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').substring(0, opts && opts.maxLength || 500).trim();
  }),
  isValidObjectId: jest.fn(id => /^[a-fA-F0-9]{20,40}$/.test(id)),
  validateUrl: jest.fn(url => {
    if (!url || typeof url !== 'string') return { isValid: false, url: '' };
    // 与真实 sanitizer 一致：https 与 cloud:// 均合法
    if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('cloud://')) {
      return { isValid: true, url };
    }
    return { isValid: false, url: '' };
  }),
  strict: jest.fn(str => typeof str === 'string' ? str : '')
}));
jest.mock('../../cloudfunctions/updateCat/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/updateCat/common/operationLogger', () => ({
  logOperation: jest.fn()
}));
jest.mock('../../cloudfunctions/updateCat/utils/constants', () => ({
  COLLECTIONS: {
    CATS: 'cats', PHOTOS: 'photos', NOTIFICATIONS: 'notifications',
    USER_FAVORITES: 'userFavorites', RECORD_MEET: 'recordMeet',
    USER_SUBSCRIPTIONS: 'userSubscriptions', SUBSCRIBE_QUOTA: 'subscribeQuota'
  },
  CAT_ALLOWED_FIELDS: ['name', 'avatar', 'campus', 'status', 'gender', 'age', 'color', 'personality', 'description', 'location', 'healthStatus', 'healthNote', 'adoptLevel'],
  CAT_FIELD_LENGTH_LIMITS: {
    name: 20, avatar: 500, campus: 50, status: 20, gender: 10,
    age: 20, color: 30, personality: 200, description: 500, location: 100,
    healthStatus: 50, healthNote: 500
  },
  // 与真实 constants 保持同口径：摘要层（changeSummary）直接消费这张表，
  // 少了 status/healthStatus/campus 等标签，日志里会直接出现英文字段名
  CAT_FIELD_LABELS: {
    name: '名字', gender: '性别', age: '年龄', color: '毛色',
    description: '性格描述', appearance: '外貌描述', location: '出没地点',
    campus: '校区', status: '状态', avatar: '头像',
    notes: '备注', healthStatus: '健康状态', healthNote: '健康备注',
    deceasedReason: '离世原因', lostLocation: '走失地点',
    adoptLevel: '好猫星级'
  },
  CAT_VALID_STATUS: ['normal', 'lost', 'deceased', 'adopted'],
  CAT_VALID_HEALTH_STATUS: ['healthy', 'stomatitis', 'skin', 'other'],
  // 好猫星级与真实 constants 同口径：0 = 未评级，3/4/5 = 星级，其余拒绝
  isValidAdoptLevel: jest.fn(v => v === 0 || [3, 4, 5].includes(v)),
  CAT_NUMERIC_FIELDS: ['sterilized', 'adoptLevel']
}));

const VALID_CAT_ID = 'a'.repeat(24);

describe('updateCat 云函数', () => {
  let auth;
  let main;

  beforeEach(() => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    // jest.mock 工厂进程级缓存：恢复可能被其他测试文件覆盖的 database 实现
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });
    main = require('../../cloudfunctions/updateCat/index').main;
  });

  test('缺少 catId 返回失败', async () => {
    const res = await main({ updateData: { name: 'x' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少猫咪ID');
  });

  test('缺少 updateData 返回失败', async () => {
    const res = await main({ catId: VALID_CAT_ID }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少更新数据');
  });

  test('无效猫咪ID格式返回失败', async () => {
    const res = await main({ catId: 'bad-id', updateData: { name: 'x' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无效的猫咪ID格式');
  });

  test('非管理员被拒绝', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限执行此操作，仅管理员可操作' });
    const res = await main({ catId: VALID_CAT_ID, updateData: { name: 'x' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
  });

  test('正常更新猫咪信息成功', async () => {
    const res = await main({ catId: VALID_CAT_ID, updateData: { name: '改名的小橘' } }, {});
    expect(res.success).toBe(true);
  });

  test('adoptLevel 为 3/4/5 之外的值必须拒绝（字符串/小数/枚举外值）', async () => {
    // 回归防护：好猫星级只开放 3/4/5（0 = 未评级）。脏值落库后
    // 前台星级渲染与「>= 3」筛选都会出现静默漏检。
    for (const bad of [1, 2, 6, 4.5, '4']) {
      const res = await main({ catId: VALID_CAT_ID, updateData: { adoptLevel: bad } }, {});
      expect(res.success).toBe(false);
      expect(res.error).toContain('好猫星级取值不合法');
    }
  });

  test('adoptLevel = 0 表示取消评级，正常通过', async () => {
    const res = await main({ catId: VALID_CAT_ID, updateData: { adoptLevel: 0 } }, {});
    expect(res.success).toBe(true);
  });

  test('非法头像URL返回失败', async () => {
    const res = await main({ catId: VALID_CAT_ID, updateData: { avatar: 'not-a-url' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('头像URL格式不正确');
  });

  test('头像不在 cats/ 目录（备份/他人照片）：拒绝更新', async () => {
    const res = await main({
      catId: VALID_CAT_ID,
      updateData: { avatar: 'cloud://env.bucket/backups/2026-10-06/cats.json' }
    }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('路径不正确');
  });

  test('https 外链头像被拒绝（堵住 imgSecCheck 对非云存储来源的跳过分支）', async () => {
    const res = await main({
      catId: VALID_CAT_ID,
      updateData: { avatar: 'https://example.com/cat.jpg' }
    }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('路径不正确');
  });

  test('云存储头像更新会调用图片安全检测', async () => {
    const cloud = require('wx-server-sdk');
    const res = await main({
      catId: VALID_CAT_ID,
      updateData: { avatar: 'cloud://env.bucket/cats/avatar/cat.png' }
    }, {});
    expect(res.success).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalled();
  });

  test('图片安全检测失败时拒绝更新', async () => {
    const cloud = require('wx-server-sdk');
    cloud.openapi.security.imgSecCheck.mockRejectedValue(new Error('87014 图片违规'));
    const res = await main({
      catId: VALID_CAT_ID,
      updateData: { avatar: 'cloud://env.bucket/cats/avatar/bad.png' }
    }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('不当');
  });

  test('不存在的猫咪返回失败', async () => {
    // 模块级 db 在 require 时创建，需先固定 database 实例再加载
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });
    // 自定义可控 db：doc().get() 返回空数据 → 视为猫咪不存在
    cloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: null })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        })),
        where: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: [] }))
        }))
      })),
      command: { in: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { name: 'x' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('猫咪不存在');
  });

  // ── 通知链路（状态/健康变更 → 站内通知 + 一次性订阅推送）────────────

  afterEach(() => {
    // 推送用例会临时注入 openapi.subscribeMessage，防止污染后续用例
    const cloud = require('wx-server-sdk');
    delete cloud.openapi.subscribeMessage;
  });

  /**
   * 构造通知链路专用 db mock（订阅消息账本改造后）：
   * - cats.doc().get() 返回带 name/status/healthStatus 的猫咪
   * - userFavorites（关注者）/ userSubscriptions（历史授权）/ subscribeQuota（配额账本）查询链返回给定数据
   * - notifications.add 由调用方传入 spy 收集写入内容
   * - 账本对账的写操作以 spy 暴露：
   *   quotaDocUpdate（doc.update → 发送成功 -1）、quotaWhereUpdate（where.update → 43101 清零）、legacyDocRemove（doc.remove → 历史记录消费）、
   *   catDocUpdate（cats 文档更新 → 断言 listSort 等写入负载）
   */
  function mockNotifyDb(cloud, { cat, favorites = [], subscriptions = [], quotas = [], notifAdd }) {
    const quotaDocUpdate = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
    const quotaWhereUpdate = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
    const legacyDocRemove = jest.fn(() => Promise.resolve({ stats: { removed: 1 } }));
    // cats 文档更新 spy：此前是匿名 jest.fn，无法断言写入负载（listSort 需要）
    const catDocUpdate = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));

    const makeChain = (data) => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data })),
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data })) })),
        orderBy: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data })) })) })),
        field: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data })) })) })),
        update: quotaWhereUpdate
      }))
    });

    cloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') {
          return {
            doc: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: cat })),
              update: catDocUpdate
            }))
          };
        }
        if (name === 'userFavorites') return makeChain(favorites);
        if (name === 'userSubscriptions') {
          return { ...makeChain(subscriptions), doc: jest.fn(() => ({ remove: legacyDocRemove })) };
        }
        if (name === 'subscribeQuota') {
          return { ...makeChain(quotas), doc: jest.fn(() => ({ update: quotaDocUpdate })) };
        }
        if (name === 'notifications') return { add: notifAdd };
        return makeChain([]);
      }),
      command: {
        in: jest.fn(v => v),
        neq: jest.fn(v => v),
        gt: jest.fn(v => v),
        inc: jest.fn(v => ({ $inc: v }))
      },
      serverDate: jest.fn(() => 'SERVER_DATE')
    });

    return { quotaDocUpdate, quotaWhereUpdate, legacyDocRemove, catDocUpdate };
  }

  test('状态改为「被收养」时向关注者写入站内通知（新文案）', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n1' }));
    mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { status: 'adopted' } }, {});
    expect(res.success).toBe(true);
    expect(notifAdd).toHaveBeenCalledTimes(1);
    const payload = notifAdd.mock.calls[0][0].data;
    expect(payload.type).toBe('cat_adopted');
    expect(payload.content).toContain('找到新家');
  });

  test('改状态时同步重算 listSort（「被领养」→ 垫底档）', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });
    const { LIST_SORT_TIERS } = require('../../cloudfunctions/updateCat/utils/listSort');

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n1' }));
    const { catDocUpdate } = mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const before = Date.now();
    const res = await main({ catId: VALID_CAT_ID, updateData: { status: 'adopted' } }, {});
    const after = Date.now();

    expect(res.success).toBe(true);
    expect(catDocUpdate).toHaveBeenCalledTimes(1);
    const data = catDocUpdate.mock.calls[0][0].data;
    expect(data.status).toBe('adopted');
    // 列表排序值 = 领养档偏移 + 本次编辑时刻：漏写会让改了状态的猫按旧排序值留在原位
    expect(data.listSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.adopted + before);
    expect(data.listSort).toBeLessThanOrEqual(LIST_SORT_TIERS.adopted + after);
    // 垫底语义：领养档必须低于离世档（两档相差 1e13 级）
    expect(data.listSort).toBeLessThan(LIST_SORT_TIERS.deceased);
  });

  test('未改状态的普通编辑也刷新 listSort 时间戳（组内按最近更新倒序）', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });
    const { LIST_SORT_TIERS } = require('../../cloudfunctions/updateCat/utils/listSort');

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n2' }));
    const { catDocUpdate } = mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const before = Date.now();
    const res = await main({ catId: VALID_CAT_ID, updateData: { name: '改名的小橘' } }, {});
    const after = Date.now();

    expect(res.success).toBe(true);
    const data = catDocUpdate.mock.calls[0][0].data;
    // 状态未变：沿用原状态（normal 档），时间戳刷新为本次编辑
    expect(data.listSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.normal + before);
    expect(data.listSort).toBeLessThanOrEqual(LIST_SORT_TIERS.normal + after);
  });

  test('健康状态改为「口炎」时向关注者写入站内通知', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n2' }));
    mockNotifyDb(cloud, {
      cat: { name: '金豆', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { healthStatus: 'stomatitis' } }, {});
    expect(res.success).toBe(true);
    expect(notifAdd).toHaveBeenCalledTimes(1);
    const payload = notifAdd.mock.calls[0][0].data;
    expect(payload.type).toBe('cat_health_stomatitis');
    expect(payload.content).toContain('口炎');
  });

  test('同时改状态与健康：站内通知两条，订阅推送只发一条（状态优先）', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n3' }));
    cloud.openapi.subscribeMessage = { send: jest.fn(() => Promise.resolve({})) };
    const { legacyDocRemove } = mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      subscriptions: [{ _id: 'legacy-2', _openid: 'f2' }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({
      catId: VALID_CAT_ID,
      updateData: { status: 'lost', healthStatus: 'stomatitis' }
    }, {});
    expect(res.success).toBe(true);
    // 两条站内通知（状态 + 健康都写）
    expect(notifAdd).toHaveBeenCalledTimes(2);
    // 订阅推送只发一条：状态优先，health 被 skipPush
    expect(cloud.openapi.subscribeMessage.send).toHaveBeenCalledTimes(1);
    const sendArg = cloud.openapi.subscribeMessage.send.mock.calls[0][0];
    expect(sendArg.data.thing3.value).toBe('走失提醒');
    // f2 走「历史记录兜底」：发送成功后消费（删除）该记录；
    // f1 既无配额也无历史授权 → 跳过（旧实现会在此盲发）
    expect(legacyDocRemove).toHaveBeenCalledTimes(1);
  });

  test('关注者持有配额：发送成功后配额 -1，不消费历史记录', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n4' }));
    cloud.openapi.subscribeMessage = { send: jest.fn(() => Promise.resolve({})) };
    const { quotaDocUpdate, legacyDocRemove } = mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      quotas: [{ _id: 'q1', _openid: 'f1', remaining: 3 }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { status: 'lost' } }, {});
    expect(res.success).toBe(true);
    expect(cloud.openapi.subscribeMessage.send).toHaveBeenCalledTimes(1);
    expect(quotaDocUpdate).toHaveBeenCalledTimes(1);
    expect(quotaDocUpdate.mock.calls[0][0].data.remaining).toEqual({ $inc: -1 });
    expect(legacyDocRemove).not.toHaveBeenCalled();
  });

  test('无配额且无历史授权：跳过发送（不再盲发换 43101）', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n5' }));
    cloud.openapi.subscribeMessage = { send: jest.fn(() => Promise.resolve({})) };
    mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { status: 'lost' } }, {});
    expect(res.success).toBe(true);
    expect(cloud.openapi.subscribeMessage.send).not.toHaveBeenCalled();
  });

  test('43101（授权已耗尽）：清零该用户配额并回收历史记录', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/updateCat/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true });

    const notifAdd = jest.fn(() => Promise.resolve({ _id: 'n6' }));
    const noQuotaErr = new Error('user refuse to accept the msg');
    noQuotaErr.errCode = 43101;
    cloud.openapi.subscribeMessage = { send: jest.fn(() => Promise.reject(noQuotaErr)) };
    const { quotaDocUpdate, quotaWhereUpdate, legacyDocRemove } = mockNotifyDb(cloud, {
      cat: { name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' },
      favorites: [{ _openid: 'f1' }],
      quotas: [{ _id: 'q1', _openid: 'f1', remaining: 2 }],
      subscriptions: [{ _id: 'legacy-1', _openid: 'f1' }],
      notifAdd
    });
    main = require('../../cloudfunctions/updateCat/index').main;

    const res = await main({ catId: VALID_CAT_ID, updateData: { status: 'lost' } }, {});
    expect(res.success).toBe(true);
    expect(cloud.openapi.subscribeMessage.send).toHaveBeenCalledTimes(1);
    // 发送失败：不扣减、改为清零校正（where().update 至 0）
    expect(quotaDocUpdate).not.toHaveBeenCalled();
    expect(quotaWhereUpdate).toHaveBeenCalledTimes(1);
    expect(quotaWhereUpdate.mock.calls[0][0].data.remaining).toBe(0);
    // 历史记录同样已失效，回收
    expect(legacyDocRemove).toHaveBeenCalledTimes(1);
  });

  // ── 操作日志摘要层（summary / changes）─────────────────────────────
  // 「改了啥」的答案必须来自**本次实际下发的字段**，
  // 而不是既有 beforeData/afterData —— 那两个只记了 3 个字段，
  // 其余改动在源头就丢了，管理端日志页无法展示。
  describe('操作日志摘要层', () => {
    function setupUpdate(cat, updateData) {
      jest.resetModules();
      const cloud = require('wx-server-sdk');
      auth = require('../../cloudfunctions/updateCat/utils/auth');
      cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
      auth.checkAdmin.mockResolvedValue({ isAdmin: true });
      mockNotifyDb(cloud, {
        cat: Object.assign({ name: '小橘', avatar: '', status: 'normal', healthStatus: 'healthy' }, cat),
        favorites: [],
        notifAdd: jest.fn(() => Promise.resolve({ _id: 'n1' }))
      });
      main = require('../../cloudfunctions/updateCat/index').main;
      return main({ catId: VALID_CAT_ID, updateData }, {});
    }

    function logInfo() {
      const logger = require('../../cloudfunctions/updateCat/common/operationLogger');
      return logger.logOperation.mock.calls[0][2];
    }

    test('改状态：摘要与明细都用管理端按钮上的中文', async () => {
      const res = await setupUpdate({}, { status: 'adopted' });
      expect(res.success).toBe(true);

      const info = logInfo();
      expect(info.summary).toBe('编辑猫咪「小橘」：状态 在校 → 已领养');
      expect(info.changes).toEqual([{ label: '状态', from: '在校', to: '已领养' }]);
    });

    test('一次改多个字段：逐项列出，不只记状态', async () => {
      // 历史实现只把 name/status/healthStatus 写进 beforeData/afterData，
      // 于是「改了校区和年龄」在日志里完全看不见
      const res = await setupUpdate({ campus: '中心校区', age: '3岁' }, { campus: '南校区', age: '4岁' });
      expect(res.success).toBe(true);

      const info = logInfo();
      // 顺序跟随 CAT_ALLOWED_FIELDS（此处为本文件 mock 的顺序：campus 在 age 之前），
      // 而非 updateData 的键序 —— 同一次操作每次生成的明细必须一致，否则日志无法比对
      expect(info.changes).toEqual([
        { label: '校区', from: '中心校区', to: '南校区' },
        { label: '年龄', from: '3岁', to: '4岁' }
      ]);
      expect(info.summary).toBe('编辑猫咪「小橘」：校区 中心校区 → 南校区；年龄 3岁 → 4岁');
    });

    test('提交了但值没变：明细为空，摘要不留孤零零的冒号', async () => {
      const res = await setupUpdate({ campus: '中心校区' }, { campus: '中心校区' });
      expect(res.success).toBe(true);

      const info = logInfo();
      expect(info.changes).toEqual([]);
      expect(info.summary).toBe('编辑猫咪「小橘」');
    });

    test('未下发的字段不进明细（只改名字不该刷出十几行噪音）', async () => {
      const res = await setupUpdate({ campus: '中心校区', age: '3岁', color: '橘白' }, { name: '小橘仔' });
      expect(res.success).toBe(true);

      const info = logInfo();
      expect(info.changes).toEqual([{ label: '名字', from: '小橘', to: '小橘仔' }]);
    });

    test('摘要层是纯增量：审计层 beforeData/afterData 保持既有 3 字段口径', async () => {
      // 审计层被多个测试与合规追溯依赖，改造只允许「加一层」，不允许顺手改它
      const res = await setupUpdate({ campus: '中心校区' }, { campus: '南校区' });
      expect(res.success).toBe(true);

      const info = logInfo();
      expect(Object.keys(info.beforeData).sort()).toEqual(['healthStatus', 'name', 'status']);
      expect(Object.keys(info.afterData).sort()).toEqual(['healthStatus', 'name', 'status']);
    });

    test('description 旧字段照常保留（老代码/关键词搜索仍依赖它）', async () => {
      const res = await setupUpdate({}, { status: 'lost' });
      expect(res.success).toBe(true);

      expect(logInfo().description).toContain('小橘');
    });
  });
});
