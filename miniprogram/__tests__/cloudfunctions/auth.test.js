/**
 * __tests__/cloudfunctions/auth.test.js
 *
 * 直接 require **canonical** 的 cloudfunctions/utils/auth.js —— 不是各云函数目录下的副本。
 *
 * 为什么需要这个文件：
 * 该模块是全部写操作的鉴权地基（checkAdmin 决定谁能改数据），但此前**从未被任何测试
 * 加载过**：8 个入口测试一律 `jest.mock('.../utils/auth')` 把它整体替换成 jest.fn()，
 * 全库 `requireActual` 出现 0 次。于是 checkAdmin 的缓存/TTL、失败关闭、以及
 * 「身份只取服务端 OPENID」这条安全不变量，全部零覆盖。
 * jest.config.js 的注释早已记下这个缺口与补救办法（先补一个 require canonical 的测试）。
 *
 * 覆盖的真实语义（逐条对应实现）：
 *   - 身份来源：只信 cloud.getWXContext().OPENID，签名里的 _openid 参数不得参与判定
 *   - 失败关闭：无 db / 无身份 / 查询异常 一律 isAdmin:false，绝不放过
 *   - 角色：仅 admin / superadmin 通过
 *   - 缓存：命中不查库、useCache:false 既不读也不写、TTL 到期重查、否定结果同样缓存
 *   - 容量：达上限时逐出最旧一条，不超 MAX_CACHE_SIZE
 */
const cloud = require('wx-server-sdk');
const auth = require('../../cloudfunctions/utils/auth');

const ADMIN_COLLECTION = 'admins';

/**
 * 可控的假库：只需支持 auth.js 用到的两条链路
 *   db.collection('admins').where(cond).limit(1).get()
 *   db.collection(x).doc(id).get()
 *
 * where 必须**忠实按条件过滤**：若无视条件恒返回文档，那么「服务端身份被换成别人」
 * 这类实现缺陷会被测试照样判绿（本文件最初就踩过这个坑）。这里对每个条件字段做等值匹配，
 * 并按 limit(1) 只回一条。
 */
function makeDb({ adminDoc = null, adminDocs = null, doc = undefined, queryThrows = false, docThrows = false } = {}) {
  const state = { whereCalls: [], collectionNames: [], queryCount: 0, docIds: [] };
  const rows = adminDocs !== null ? adminDocs : adminDoc === null ? [] : [adminDoc];

  const db = {
    _state: state,
    collection: jest.fn((name) => {
      state.collectionNames.push(name);
      return {
        where: jest.fn((cond) => {
          state.whereCalls.push(cond);
          return {
            limit: jest.fn((limit) => ({
              get: jest.fn(() => {
                state.queryCount++;
                if (queryThrows) return Promise.reject(new Error('db unavailable'));
                const matched = rows.filter((row) =>
                  Object.entries(cond).every(([field, value]) => row[field] === value)
                );
                return Promise.resolve({ data: matched.slice(0, limit) });
              })
            }))
          };
        }),
        doc: jest.fn((id) => {
          state.docIds.push(id);
          return {
            get: jest.fn(() => {
              if (docThrows) return Promise.reject(new Error('doc unavailable'));
              return Promise.resolve({ data: doc });
            })
          };
        })
      };
    })
  };

  return db;
}

const asCaller = (openid) => cloud.getWXContext.mockReturnValue({ OPENID: openid });

// 「getWXContext 抛错时拒绝」那个用例装了会抛错的实现且从不还原，后续用例全靠
// 「每个都先调 asCaller()」把它覆盖回去才没串味 —— 顺序一变（新增、跳过、重排）
// 就会静默污染，而且症状是「身份取不到」这种和顺序毫无表面关联的失败。
// 这里在每个用例后显式恢复 mock 的默认实现。
const DEFAULT_GET_WX_CONTEXT = cloud.getWXContext.getMockImplementation();
afterEach(() => {
  cloud.getWXContext.mockImplementation(DEFAULT_GET_WX_CONTEXT);
});

describe('checkAdmin —— 身份来源（安全不变量）', () => {
  beforeEach(() => auth.clearCache());

  test('签名里的 _openid 参数不得参与鉴权：查询必须用服务端 OPENID', async () => {
    const db = makeDb({ adminDoc: { openid: 'admin-real', role: 'admin' } });
    asCaller('attacker-openid');

    const res = await auth.checkAdmin(db, 'admin-real');

    // 决定性的断言：where 条件用的是服务端身份，而不是调用方传进来的那个
    expect(db._state.whereCalls[0]).toEqual({ openid: 'attacker-openid' });
    expect(db._state.whereCalls[0]).not.toEqual({ openid: 'admin-real' });
    expect(res.isAdmin).toBe(false);
  });

  test('服务端 OPENID 是管理员时通过，且 _openid 传什么值都不影响', async () => {
    const db = makeDb({ adminDoc: { openid: 'admin-real', role: 'admin' } });
    asCaller('admin-real');

    const res = await auth.checkAdmin(db, 'someone-else-entirely');

    expect(res.isAdmin).toBe(true);
    expect(db._state.whereCalls[0]).toEqual({ openid: 'admin-real' });
  });

  test('只查询 admins 集合', async () => {
    const db = makeDb();
    asCaller('u1');
    await auth.checkAdmin(db, 'u1');
    expect(db._state.collectionNames).toEqual([ADMIN_COLLECTION]);
  });
});

describe('checkAdmin —— 失败关闭（任何异常都不得放行）', () => {
  test('相同身份绑定多个管理员时拒绝授权', async () => {
    asCaller('duplicate');
    const db = makeDb({ adminDocs: [
      { openid: 'duplicate', role: 'admin' },
      { openid: 'duplicate', role: 'superadmin' }
    ] });
    const res = await auth.checkAdmin(db, '', { useCache: false });
    expect(res.isAdmin).toBe(false);
    expect(res.hasPermission).toBe(false);
  });
  beforeEach(() => auth.clearCache());

  test('无 db 时拒绝，且不查询、不读身份', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(null, 'u1');
    expect(res).toEqual({ isAdmin: false, hasPermission: false, error: '数据库连接异常' });
  });

  test('取不到 OPENID 时拒绝', async () => {
    const db = makeDb();
    asCaller('');
    const res = await auth.checkAdmin(db, '');
    expect(res.isAdmin).toBe(false);
    expect(res.error).toBe('无法获取用户身份信息');
    expect(db._state.queryCount).toBe(0);
  });

  test('getWXContext 抛错时拒绝（不冒泡）', async () => {
    const db = makeDb();
    cloud.getWXContext.mockImplementation(() => { throw new Error('context exploded'); });
    const res = await auth.checkAdmin(db, 'u1');
    expect(res.isAdmin).toBe(false);
    expect(res.error).toBe('无法获取用户身份信息');
    expect(db._state.queryCount).toBe(0);
  });

  test('查询抛错时拒绝并给出可重试文案', async () => {
    const db = makeDb({ queryThrows: true });
    asCaller('u1');
    const res = await auth.checkAdmin(db, 'u1');
    expect(res.isAdmin).toBe(false);
    expect(res.error).toBe('权限验证服务暂时不可用，请稍后重试');
  });
});

describe('checkAdmin —— 角色判定', () => {
  beforeEach(() => auth.clearCache());

  test('role=admin 通过', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: { openid: 'u1', role: 'admin' } }), 'u1');
    expect(res.isAdmin).toBe(true);
    expect(res.error).toBeNull();
  });

  test('role=superadmin 通过', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: { openid: 'u1', role: 'superadmin' } }), 'u1');
    expect(res.isAdmin).toBe(true);
  });

  test('role=founder（创始人）通过：三档顶级也是合法管理员', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: { openid: 'u1', role: 'founder' } }), 'u1');
    expect(res.isAdmin).toBe(true);
    expect(res.error).toBeNull();
  });

  test('role=user 拒绝', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: { openid: 'u1', role: 'user' } }), 'u1');
    expect(res.isAdmin).toBe(false);
  });

  test('查无记录时拒绝', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: null }), 'u1');
    expect(res.isAdmin).toBe(false);
    expect(res.adminInfo).toBeNull();
  });

  test('doc 缺失 role 字段时拒绝（不能因字段缺失而通过）', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc: { openid: 'u1' } }), 'u1');
    expect(res.isAdmin).toBe(false);
  });

  test('operation 名称进入错误文案', async () => {
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb(), 'u1', { operation: '删除猫咪' });
    expect(res.error).toBe('无权限执行此删除猫咪，仅管理员可操作');
  });

  test('通过时回传原始管理员文档', async () => {
    const adminDoc = { _id: 'a1', openid: 'u1', role: 'admin', name: '小王' };
    asCaller('u1');
    const res = await auth.checkAdmin(makeDb({ adminDoc }), 'u1');
    expect(res.adminInfo).toEqual(adminDoc);
  });
});

describe('checkAdmin —— 入口权限（10 项）', () => {
  beforeEach(() => auth.clearCache());

  test('客户端与服务端的权限 key / 默认值完全一致', () => {
    const { PERMISSION_KEYS, DEFAULT_PERMISSION_KEYS } = require('../../utils/adminPermissions');
    expect(PERMISSION_KEYS).toEqual(auth.ADMIN_PERMISSION_KEYS);
    expect(DEFAULT_PERMISSION_KEYS).toEqual(auth.DEFAULT_ADMIN_PERMISSIONS);
  });

  test('历史文档没有 permissions 字段 → 默认开放 addCat/cat/photo', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');

    for (const permission of ['addCat', 'cat', 'photo']) {
      const res = await auth.checkAdmin(db, 'u1', { permission });
      expect(res.isAdmin).toBe(true);
    }

    const denied = await auth.checkAdmin(db, 'u1', { permission: 'mediaReview', operation: '内容复核' });
    expect(denied.isAdmin).toBe(false);
    expect(denied.error).toBe('该账号未开通「内容复核」权限，请联系超级管理员开启');
  });

  test('显式空数组 → 一项都不开（不能回落到默认 3 项）', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin', permissions: [] } });
    asCaller('u1');
    const res = await auth.checkAdmin(db, 'u1', { permission: 'addCat', operation: '添加新猫' });
    expect(res.isAdmin).toBe(false);
  });

  test('已知权限按名单放行，未知 key 不生效', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin', permissions: ['mediaReview', 'bogus'] } });
    asCaller('u1');

    const allowed = await auth.checkAdmin(db, 'u1', { permission: 'mediaReview' });
    expect(allowed.isAdmin).toBe(true);

    const unknown = await auth.checkAdmin(db, 'u1', { permission: 'bogus' });
    expect(unknown.isAdmin).toBe(false);
  });

  test('超管始终通过（即使显式空权限）', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'superadmin', permissions: [] } });
    asCaller('u1');
    const res = await auth.checkAdmin(db, 'u1', { permission: 'logs' });
    expect(res.isAdmin).toBe(true);
  });

  test('创始人（founder）恒全量权限，与超管同口径', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'founder', permissions: [] } });
    asCaller('u1');
    const res = await auth.checkAdmin(db, 'u1', { permission: 'logs' });
    expect(res.isAdmin).toBe(true);
    expect(auth.getEffectivePermissions({ role: 'founder', permissions: [] })).toEqual(auth.ADMIN_PERMISSION_KEYS);
    expect(auth.isSuperLevelRole('founder')).toBe(true);
    expect(auth.isSuperLevelRole('superadmin')).toBe(true);
    expect(auth.isSuperLevelRole('admin')).toBe(false);
  });

  test('缓存复用 adminDoc，但不同 permission 不会串结论', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin', permissions: ['addCat'] } });
    asCaller('u1');

    const allow = await auth.checkAdmin(db, 'u1', { permission: 'addCat' });
    const deny = await auth.checkAdmin(db, 'u1', { permission: 'mediaReview' });

    expect(allow.isAdmin).toBe(true);
    expect(deny.isAdmin).toBe(false);
    // 缓存的是文档而不是结论：两次调用只查一次库，但结论各自推导
    expect(db._state.queryCount).toBe(1);
  });
});

describe('checkAdmin —— 缓存', () => {
  beforeEach(() => auth.clearCache());

  test('TTL 内命中缓存，不再查询数据库', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');

    await auth.checkAdmin(db, 'u1');
    const second = await auth.checkAdmin(db, 'u1');

    expect(db._state.queryCount).toBe(1);
    expect(second.isAdmin).toBe(true);
  });

  test('否定结果同样被缓存（非管理员第二次也不查库）', async () => {
    const db = makeDb({ adminDoc: null });
    asCaller('u1');

    await auth.checkAdmin(db, 'u1');
    const second = await auth.checkAdmin(db, 'u1');

    expect(db._state.queryCount).toBe(1);
    expect(second.isAdmin).toBe(false);
  });

  test('useCache:false 既不读也不写缓存', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');

    await auth.checkAdmin(db, 'u1', { useCache: false });
    await auth.checkAdmin(db, 'u1', { useCache: false });

    expect(db._state.queryCount).toBe(2);
    expect(auth.getCacheStats().size).toBe(0);
  });

  test('useCache:false 不会复用已缓存的通过结果（权限撤销立即可见）', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');
    await auth.checkAdmin(db, 'u1'); // 缓存 isAdmin:true

    // 管理员被撤销：库改为查无记录，但缓存仍在 TTL 内
    const revokedDb = makeDb({ adminDoc: null });
    const cached = await auth.checkAdmin(revokedDb, 'u1');
    expect(cached.isAdmin).toBe(true); // 缓存内的旧结论
    expect(revokedDb._state.queryCount).toBe(0);

    const fresh = await auth.checkAdmin(revokedDb, 'u1', { useCache: false });
    expect(fresh.isAdmin).toBe(false); // 绕过缓存立刻拿到真实结论
    expect(revokedDb._state.queryCount).toBe(1);
  });

  test('超过 TTL(1分钟) 后重新查询', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');
    const base = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    try {
      await auth.checkAdmin(db, 'u1');
      expect(db._state.queryCount).toBe(1);

      nowSpy.mockReturnValue(base + 59_000); // TTL 内
      await auth.checkAdmin(db, 'u1');
      expect(db._state.queryCount).toBe(1);

      nowSpy.mockReturnValue(base + 61_000); // 已过期
      await auth.checkAdmin(db, 'u1');
      expect(db._state.queryCount).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('clearCache 后重新查询', async () => {
    const db = makeDb({ adminDoc: { openid: 'u1', role: 'admin' } });
    asCaller('u1');

    await auth.checkAdmin(db, 'u1');
    auth.clearCache();
    expect(auth.getCacheStats().size).toBe(0);

    await auth.checkAdmin(db, 'u1');
    expect(db._state.queryCount).toBe(2);
  });

  test('缓存按 openid 隔离（A 的结论不会给 B）', async () => {
    const db = makeDb({ adminDoc: { openid: 'admin-A', role: 'admin' } });
    asCaller('admin-A');
    await auth.checkAdmin(db, 'admin-A');

    asCaller('user-B');
    const resB = await auth.checkAdmin(db, 'user-B');

    expect(resB.isAdmin).toBe(false);
    expect(db._state.queryCount).toBe(2);
  });

  test('getCacheStats 反映条目数与上限', async () => {
    const db = makeDb();
    asCaller('u1');
    await auth.checkAdmin(db, 'u1');

    const stats = auth.getCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(1000);
    expect(stats.keys).toEqual(['u1']);
  });
});

describe('checkOwnership —— 身份来源与失败关闭', () => {
  beforeEach(() => auth.clearCache());

  test('doc._openid 与服务端 OPENID 一致才算 owner', async () => {
    asCaller('owner-1');
    const db = makeDb({ doc: { _id: 'd1', _openid: 'owner-1' } });
    const res = await auth.checkOwnership(db, 'owner-1', 'cats', 'd1');
    expect(res.isOwner).toBe(true);
    expect(res.canOperate).toBe(true);
  });

  test('伪造 openid 参数不得换来所有权（签名参数不参与判定）', async () => {
    // 服务端身份是攻击者，doc 属于别人；签名里塞上真正 owner 的 openid
    asCaller('attacker');
    const db = makeDb({ doc: { _id: 'd1', _openid: 'real-owner' } });

    const res = await auth.checkOwnership(db, 'real-owner', 'cats', 'd1');

    expect(res.isOwner).toBe(false);
    expect(res.isAdmin).toBe(false);
    expect(res.canOperate).toBe(false);
  });

  test('反过来：服务端是 owner 时，签名参数填别人也不影响', async () => {
    asCaller('real-owner');
    const db = makeDb({ doc: { _id: 'd1', _openid: 'real-owner' } });
    const res = await auth.checkOwnership(db, 'attacker', 'cats', 'd1');
    expect(res.isOwner).toBe(true);
  });

  test('取不到身份时拒绝，且不查文档', async () => {
    asCaller('');
    const db = makeDb({ doc: { _id: 'd1', _openid: 'x' } });
    const res = await auth.checkOwnership(db, 'x', 'cats', 'd1');
    expect(res).toEqual({ isOwner: false, isAdmin: false, error: '无法获取用户身份信息' });
    expect(db._state.docIds).toEqual([]);
  });

  test('文档不存在', async () => {
    asCaller('u1');
    const db = makeDb({ doc: undefined });
    const res = await auth.checkOwnership(db, 'u1', 'cats', 'missing');
    expect(res).toEqual({ isOwner: false, isAdmin: false, error: '资源不存在' });
  });

  test('读文档抛错时拒绝（不冒泡）', async () => {
    asCaller('u1');
    const db = makeDb({ docThrows: true });
    const res = await auth.checkOwnership(db, 'u1', 'cats', 'd1');
    expect(res.isOwner).toBe(false);
    expect(res.error).toBe('权限检查失败');
  });

  test('非 owner 的管理员仍可操作', async () => {
    asCaller('admin-1');
    const db = makeDb({
      doc: { _id: 'd1', _openid: 'someone-else' },
      adminDoc: { openid: 'admin-1', role: 'admin' }
    });
    const res = await auth.checkOwnership(db, 'admin-1', 'cats', 'd1');
    expect(res.isOwner).toBe(false);
    expect(res.isAdmin).toBe(true);
    expect(res.canOperate).toBe(true);
  });

  test('普通用户既非 owner 也非管理员则不可操作', async () => {
    asCaller('user-1');
    const db = makeDb({ doc: { _id: 'd1', _openid: 'someone-else' }, adminDoc: null });
    const res = await auth.checkOwnership(db, 'user-1', 'cats', 'd1');
    expect(res.canOperate).toBe(false);
  });
});

describe('checkAdmin —— 缓存容量上限', () => {
  beforeEach(() => auth.clearCache());

  test('填满后逐出最旧一条，容量不超上限', async () => {
    const db = makeDb({ adminDoc: null });

    for (let i = 0; i < 1000; i++) {
      asCaller(`u${i}`);
      await auth.checkAdmin(db, `u${i}`);
    }
    expect(auth.getCacheStats().size).toBe(1000);
    expect(auth.getCacheStats().keys).toContain('u0');

    asCaller('u1000');
    await auth.checkAdmin(db, 'u1000');

    const stats = auth.getCacheStats();
    expect(stats.size).toBe(1000);
    expect(stats.keys).not.toContain('u0'); // 最旧的被逐出
    expect(stats.keys).toContain('u1000');
  });
});
