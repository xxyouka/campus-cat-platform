process.env.SUBSCRIBE_NEW_CAT_TEMPLATE_ID = 'tmpl-new-cat';
// Mock sanitizer
jest.mock('../../cloudfunctions/addCat/utils/sanitizer', () => ({
  sanitize: jest.fn((str, opts) => {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').substring(0, opts && opts.maxLength || 500).trim();
  }),
  isValidObjectId: jest.fn((id) => /^[a-fA-F0-9]{20,40}$/.test(id)),
  validateUrl: jest.fn((url) => {
    if (!url || typeof url !== 'string') return { isValid: false, url: '' };
    if (url.startsWith('https://')) return { isValid: true, url };
    if (url.startsWith('http://')) return { isValid: true, url };
    // 与真实实现 utils/sanitizer.js 的协议白名单对齐：allowedProtocols 含 'cloud:'
    // （头像是客户端先上传到云存储再传 fileID，真实链路几乎都是 cloud://）
    if (url.startsWith('cloud://')) return { isValid: true, url };
    return { isValid: false, url: '' };
  }),
  strict: jest.fn((str, maxLen) => {
    if (typeof str !== 'string') return '';
    return str.substring(0, maxLen || 200).trim();
  }),
  escape: jest.fn((str) => str)
}));

// Mock auth
jest.mock('../../cloudfunctions/addCat/utils/auth', () => ({
  checkAdmin: jest.fn()
}));

// Mock operationLogger
jest.mock('../../cloudfunctions/addCat/common/operationLogger', () => ({
  logOperation: jest.fn()
}));

// Mock constants
jest.mock('../../cloudfunctions/addCat/utils/constants', () => ({
  COLLECTIONS: {
    CATS: 'cats',
    PHOTOS: 'photos',
    ADMINS: 'admins',
    OPERATION_LOGS: 'operation_logs',
    USER_FAVORITES: 'userFavorites',
    RECORD_MEET: 'recordMeet',
    CAT_RELATIONS: 'cat_relations',
    HEALTH_RECORDS: 'health_records',
    ALBUMS: 'albums',
    NOTIFICATIONS: 'notifications',
    NOTICES: 'notices',
    LOGIN_ATTEMPTS: 'login_attempts',
    USER_SUBSCRIPTIONS: 'userSubscriptions',
    SUBSCRIBE_QUOTA: 'subscribeQuota',
    PHOTO_LIKES: 'photoLikes',
    REPAIR_LOGS: 'repair_logs'
  },
  CAT_ALLOWED_FIELDS: ['name', 'avatar', 'campus', 'status', 'gender', 'age', 'color', 'personality', 'description', 'location', 'adoptLevel'],
  // 与 cloudfunctions/utils/constants.js 保持一致：status 决定猫咪是否可见，
  // 枚举外的值会让这只猫从所有列表永久消失却仍返回成功
  CAT_VALID_STATUS: ['normal', 'lost', 'deceased', 'adopted'],
  // 字段名 → 中文标签：长度超限提示使用（缺失会让超长分支抛错、被 main 的 catch 吞成通用文案）
  CAT_FIELD_LABELS: {
    name: '名字', gender: '性别', age: '年龄', color: '毛色',
    description: '性格描述', appearance: '外貌描述', location: '出没地点',
    campus: '校区', status: '状态', notes: '备注', healthStatus: '健康状态',
    healthNote: '健康备注', deceasedReason: '离世原因', lostLocation: '走失地点',
    adoptLevel: '好猫星级'
  },
  CAT_VALID_HEALTH_STATUS: ['healthy', 'unhealthy', 'recovering', 'unknown'],
  // 好猫星级与真实 constants 同口径：0 = 未评级，3/4/5 = 星级
  isValidAdoptLevel: jest.fn(v => v === 0 || [3, 4, 5].includes(v)),
  CAT_NUMERIC_FIELDS: ['sterilized', 'adoptLevel'],
  CAT_FIELD_LENGTH_LIMITS: {
    name: 20,
    avatar: 500,
    campus: 50,
    status: 20,
    gender: 10,
    age: 20,
    color: 30,
    personality: 200,
    description: 500,
    location: 100
  }
}));

describe('addCat 云函数', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // 回收用例用 spyOn 改写共享的 wx-server-sdk mock（jest.mock 工厂结果进程级缓存，
  // resetModules 不还原它）——不恢复会污染后续用例与文件
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('缺少 catData 应返回错误', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });
    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({ _adminAccount: 'admin' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少猫咪数据');
  });

  test('缺少 name 应返回错误', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });
    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg' },
      _adminAccount: 'admin'
    }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('猫咪名字不能为空');
  });

  test('缺少 avatar 应返回错误', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });
    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { name: '小橘' },
      _adminAccount: 'admin'
    }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('猫咪大头照不能为空');
  });

  test('非管理员应被拒绝', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限' });
    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { name: '小橘', avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg' },
      _adminAccount: 'user1'
    }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('无权限');
  });

  test('超长字段应返回错误', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });
    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: {
        name: 'a'.repeat(50),
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg'
      },
      _adminAccount: 'admin'
    }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('内容过长');
  });

  test('status 为枚举外的值时必须拒绝，不得静默写入', async () => {
    // 回归防护：status 决定猫咪在所有列表里的可见性
    //（filterCats / catRelation 均按 where.status = _.in([...]) 取数）。
    // 枚举外的值（'健康'、'Normal'、对象）一旦落库，这只猫就从所有前台永久消失，
    // 而接口仍返回成功 —— 静默的数据丢失比报错更难排查。
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'never' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: {
        name: '小橘',
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
        status: '健康'
      },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('状态取值不合法');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('adoptLevel 为 3/4/5 之外的值必须拒绝，不得静默落库', async () => {
    // 回归防护：好猫星级只开放 3/4/5（0 = 未评级）。字符串 "4"、小数 4.5、
    // 枚举外的 1/2/6 一旦落库，前台星级渲染与「>= 3」筛选都会出现静默漏检。
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'never' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');

    for (const bad of [1, 2, 6, 4.5, '4']) {
      const result = await addCat.main({
        catData: {
          name: '小橘',
          avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
          adoptLevel: bad
        },
        _adminAccount: 'admin'
      }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('好猫星级取值不合法');
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('adoptLevel 为 5 时随档案一起入库', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-cat-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: {
        name: '小橘',
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
        adoptLevel: 5
      },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(true);
    const written = mockAdd.mock.calls[0][0].data;
    expect(written.adoptLevel).toBe(5);
  });

  test('管理员成功添加猫咪', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    const { logOperation } = require('../../cloudfunctions/addCat/common/operationLogger');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-cat-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: {
        name: '小橘',
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
        campus: '本部',
        status: 'normal',
        color: '橘色'
      },
      _adminAccount: 'admin'
    }, {});

    // 如果失败，输出错误信息以便调试
    if (!result.success) {
      console.log('addCat 失败:', JSON.stringify(result));
    }    expect(result.success).toBe(true);
    expect(result.message).toContain('添加成功');
    expect(result.data.id).toBe('new-cat-id');
    expect(logOperation).toHaveBeenCalled();
  });

  test('写入 payload 不得含 _openid（管理员 openid 会随公开集合下发给所有用户）', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-cat-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    // 防空断言的前提：本 harness 里必须真的有身份，
    // 否则「没写 _openid」可能只是因为压根没拿到 OPENID，断言就失去意义
    expect(mockCloud.getWXContext().OPENID).toBeTruthy();

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: {
        name: '小橘',
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
        campus: '本部',
        status: 'normal'
      },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);

    const payload = mockAdd.mock.calls[0][0].data;
    // 先确认业务字段确实写进去了，避免「不含 _openid」是因为 payload 本来就空
    expect(payload.name).toBe('小橘');
    expect(payload).toHaveProperty('createTime');

    // 决定性断言：cats 是所有人可读的公开集合，客户端整文档直连读取，
    // 写 _openid 就是把管理员 openid 泄露给每个用户
    expect(payload).not.toHaveProperty('_openid');
    expect(Object.keys(payload)).not.toContain('_openid');
  });

  test('建档写入 listSort（列表排序值：档位 + 时间戳，领养垫底）', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });
    // 与函数内实际 require 的副本同一模块：直接校验写入值的档位语义
    const { LIST_SORT_TIERS } = require('../../cloudfunctions/addCat/utils/listSort');

    const mockCloud = require('wx-server-sdk');
    const mockAdd = jest.fn(() => Promise.resolve({ _id: 'new-cat-id' }));
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({ add: mockAdd })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');

    const before = Date.now();
    const res = await addCat.main({
      catData: {
        name: '小橘',
        avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg',
        campus: '本部',
        status: 'normal'
      },
      _adminAccount: 'admin'
    }, {});
    const after = Date.now();

    expect(res.success).toBe(true);
    const normalSort = mockAdd.mock.calls[0][0].data.listSort;
    // 在校档：档位偏移 + 建档时刻毫秒（排序只关心先后，用区间断言）
    expect(normalSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.normal + before);
    expect(normalSort).toBeLessThanOrEqual(LIST_SORT_TIERS.normal + after);

    // 领养档必须显著低于在校档（垫底语义：档位间隔为 1e13 级，时间戳量级远小于它）
    const before2 = Date.now();
    const res2 = await addCat.main({
      catData: {
        name: '蛋黄',
        avatar: 'cloud://mock-env.bucket/cats/avatar/2.jpg',
        campus: '本部',
        status: 'adopted'
      },
      _adminAccount: 'admin'
    }, {});
    const after2 = Date.now();

    expect(res2.success).toBe(true);
    const adoptedSort = mockAdd.mock.calls[1][0].data.listSort;
    expect(adoptedSort).toBeGreaterThanOrEqual(LIST_SORT_TIERS.adopted + before2);
    expect(adoptedSort).toBeLessThanOrEqual(LIST_SORT_TIERS.adopted + after2);
    expect(adoptedSort).toBeLessThan(LIST_SORT_TIERS.deceased);
  });

  test('HTTP body 解析应正常工作', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => ({
        add: jest.fn(() => Promise.resolve({ _id: 'new-cat-id' }))
      })),
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      body: JSON.stringify({
        catData: { name: '小橘', avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg' },
        _adminAccount: 'admin'
      })
    }, {});

    if (!result.success) {
      console.log('addCat body 解析失败:', result);
    }
    expect(result.success).toBe(true);
  });

  // 头像由客户端先上传到云存储，再调本函数；内容安全检测在写库前进行。
  // 检测不通过时文件已经落盘、库里却没有记录 —— 必须当场回收，否则成为无主垃圾
  // （除控制台外没有任何入口能清掉它）。
  describe('未入库文件的回收', () => {
    const CLOUD_AVATAR = 'cloud://mock-env.bucket/cats/avatar/1.jpg';

    test('图片内容安全检测不通过时删除已上传的头像', async () => {
      const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
      checkAdmin.mockResolvedValue({ isAdmin: true });

      const mockCloud = require('wx-server-sdk');
      const deleteSpy = jest.spyOn(mockCloud, 'deleteFile');
      // 走云存储分支：文件存在 → imgSecCheck 拒绝
      jest.spyOn(mockCloud, 'downloadFile').mockResolvedValue({ fileContent: Buffer.from('thumb') });
      jest.spyOn(mockCloud.openapi.security, 'imgSecCheck')
        .mockRejectedValueOnce(new Error('risky image'));

      const addCat = require('../../cloudfunctions/addCat/index');
      const result = await addCat.main({
        catData: { name: '小橘', avatar: CLOUD_AVATAR },
        _adminAccount: 'admin'
      }, {});

      expect(result.success).toBe(false);
      expect(mockCloud.openapi.security.imgSecCheck).toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalledWith({ fileList: [CLOUD_AVATAR] });
    });

    test('文本内容安全检测不通过时同样删除已上传的头像', async () => {
      const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
      checkAdmin.mockResolvedValue({ isAdmin: true });

      const mockCloud = require('wx-server-sdk');
      const deleteSpy = jest.spyOn(mockCloud, 'deleteFile');
      jest.spyOn(mockCloud, 'downloadFile').mockResolvedValue({ fileContent: Buffer.from('thumb') });
      // 图片通过、文本被拒：头像同样没能入库
      jest.spyOn(mockCloud.openapi.security, 'imgSecCheck').mockResolvedValue({ errCode: 0 });
      jest.spyOn(mockCloud.openapi.security, 'msgSecCheck')
        .mockRejectedValueOnce(new Error('risky text'));

      const addCat = require('../../cloudfunctions/addCat/index');
      const result = await addCat.main({
        catData: { name: '小橘', avatar: CLOUD_AVATAR, description: '描述' },
        _adminAccount: 'admin'
      }, {});

      expect(result.success).toBe(false);
      expect(deleteSpy).toHaveBeenCalledWith({ fileList: [CLOUD_AVATAR] });
    });
  });
});

describe('头像路径守卫（2026-10-06）', () => {
  test('头像不在 cats/ 目录：拒绝且不删文件（任意文件删除原语已封死）', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const mockCloud = require('wx-server-sdk');
    const deleteSpy = jest.spyOn(mockCloud, 'deleteFile').mockResolvedValue({});
    const downloadSpy = jest.spyOn(mockCloud, 'downloadFile').mockResolvedValue({ fileContent: Buffer.from('x') });
    jest.spyOn(mockCloud.openapi.security, 'imgSecCheck').mockRejectedValueOnce(new Error('risky image'));
    // 前面的用例共享同一批进程级 mock：先清历史调用，断言才能只反映本次
    deleteSpy.mockClear();
    downloadSpy.mockClear();

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { name: '小橘', avatar: 'cloud://mock-env.bucket/backups/2026-10-06/cats.json' },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('路径不正确');
    // 关键：路径不合法时既不下载也不删除 —— 备份文件/他人文件不会被动到
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('https 外链头像被拒绝（堵住 imgSecCheck 对非云存储来源的跳过分支）', async () => {
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { name: '小橘', avatar: 'https://example.com/cat.jpg' },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('路径不正确');
  });
});

describe('新猫推送账本（订阅消息额度）', () => {
  afterEach(() => {
    // 临时注入的 openapi.subscribeMessage 需清理，防止污染后续用例
    const mockCloud = require('wx-server-sdk');
    delete mockCloud.openapi.subscribeMessage;
  });

  test('配额持有者发送成功 -1，历史记录兜底消费', async () => {
    jest.resetModules();
    const mockCloud = require('wx-server-sdk');
    const { checkAdmin } = require('../../cloudfunctions/addCat/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true });

    const sendSpy = jest.fn(() => Promise.resolve({}));
    mockCloud.openapi.subscribeMessage = { send: sendSpy };

    const quotaDocUpdate = jest.fn(() => Promise.resolve({}));
    const legacyDocRemove = jest.fn(() => Promise.resolve({}));

    // 读取链：where().limit().get() / where().orderBy().limit().get()
    const makeChain = (data) => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data })),
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data })) })),
        orderBy: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data })) })) }))
      }))
    });

    mockCloud.database.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'cats') return { add: jest.fn(() => Promise.resolve({ _id: 'new-cat-id' })) };
        if (name === 'userSubscriptions') {
          return {
            ...makeChain([{ _id: 'legacy-1', _openid: 'legacy-user', status: 'accept' }]),
            doc: jest.fn(() => ({ remove: legacyDocRemove }))
          };
        }
        if (name === 'subscribeQuota') {
          return {
            ...makeChain([{ _id: 'q1', _openid: 'quota-user', remaining: 2 }]),
            doc: jest.fn(() => ({ update: quotaDocUpdate }))
          };
        }
        return { add: jest.fn(() => Promise.resolve({})) };
      }),
      command: {
        in: jest.fn(v => v),
        gt: jest.fn(v => v),
        inc: jest.fn(v => v)
      },
      serverDate: jest.fn(() => new Date())
    });

    const addCat = require('../../cloudfunctions/addCat/index');
    const result = await addCat.main({
      catData: { name: '小橘', avatar: 'cloud://mock-env.bucket/cats/avatar/1.jpg' },
      _adminAccount: 'admin'
    }, {});

    expect(result.success).toBe(true);
    // 两位可推对象：配额持有者（发送 + -1）、历史订阅者（发送 + 消费记录）
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(quotaDocUpdate).toHaveBeenCalledTimes(1);
    expect(quotaDocUpdate.mock.calls[0][0].data.remaining).toBe(-1);
    expect(legacyDocRemove).toHaveBeenCalledTimes(1);
  });
});
