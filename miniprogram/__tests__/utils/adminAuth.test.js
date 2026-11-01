/**
 * __tests__/utils/adminAuth.test.js
 * 覆盖管理员鉴权的完整矩阵：本地标记与签名校验、严格/非严格两条云端校验路径、
 * 云端重试、失败即拒绝、登录态写入与清除。
 *
 * 说明：adminAuth 大量依赖 wx.getStorageSync / setStorageSync，这里用内存 store
 * 实现三个存储 API，使读写行为与真机一致（默认 setup.js 的 getStorageSync 恒返回 ''）。
 */
const adminAuth = require('../../utils/adminAuth');

const {
  checkAdminAuth,
  requireAdminAuth,
  setAdminAuth,
  clearAdminAuth,
  checkAdminAuthAsync,
  refreshSignature,
  getAdminRole,
  getAdminPermissions,
  hasAdminPermission,
  isSuperAdminLevel,
  isFounder
} = adminAuth;

const {
  PERMISSION_KEYS,
  DEFAULT_PERMISSION_KEYS
} = require('../../utils/adminPermissions');

const SIG_KEY = '_adminSig';
const SIG_TIME_KEY = '_adminSigTime';
const VALID_SIG = 'a'.repeat(64);
const HOUR_MS = 60 * 60 * 1000;

/** 用内存对象实现存储三兄弟，返回 store 便于断言 */
function useMemoryStorage(initial = {}) {
  const store = { ...initial };
  wx.getStorageSync.mockImplementation(key => key in store ? store[key] : '');
  wx.setStorageSync.mockImplementation((key, value) => { store[key] = value; });
  wx.removeStorageSync.mockImplementation(key => { delete store[key]; });
  return store;
}

let realSetTimeout;

beforeEach(() => {
  jest.clearAllMocks();
  // requireAdminAuth 的重试用 `await new Promise(r => setTimeout(r, 2000))`，
  // 测试里让它立即触发，避免真的等 2 秒
  realSetTimeout = global.setTimeout;
  global.setTimeout = fn => { fn(); return 0; };
});

afterEach(() => {
  global.setTimeout = realSetTimeout;
  jest.restoreAllMocks();
});

describe('checkAdminAuth（本地标记，仅用于 UI 显隐）', () => {
  test('未登录时返回 false', () => {
    useMemoryStorage();
    expect(checkAdminAuth()).toBe(false);
  });

  test('已登录且无签名记录时返回 true（兼容旧数据）', () => {
    useMemoryStorage({ isAdmin: true });
    expect(checkAdminAuth()).toBe(true);
  });

  test('签名有效时返回 true，并同步 globalData.isAdmin', () => {
    useMemoryStorage({ isAdmin: true, [SIG_KEY]: VALID_SIG, [SIG_TIME_KEY]: Date.now() });
    const app = { globalData: {} };
    getApp.mockReturnValue(app);

    expect(checkAdminAuth()).toBe(true);
    expect(app.globalData.isAdmin).toBe(true);
  });

  test('签名过期不再判失败：放行到云端校验并触发静默续期（不再每小时被踢一次）', () => {
    const store = useMemoryStorage({
      isAdmin: true,
      [SIG_KEY]: VALID_SIG,
      [SIG_TIME_KEY]: Date.now() - HOUR_MS - 1000
    });

    // 过期不等于被篡改：签名仅 UI 层，真实门禁是云端 OPENID 校验；
    // 原实现过期即清登录态 → 所有管理子页每小时必被踢且卡骨架屏
    expect(checkAdminAuth()).toBe(true);
    expect(store.isAdmin).toBe(true);
  });

  test('签名格式非法时返回 false 并清除本地权限', () => {
    const store = useMemoryStorage({
      isAdmin: true,
      [SIG_KEY]: 'not-a-valid-signature',
      [SIG_TIME_KEY]: Date.now()
    });

    expect(checkAdminAuth()).toBe(false);
    expect(store.isAdmin).toBeUndefined();
  });
});

describe('requireAdminAuth（云端强校验）', () => {
  test('本地非管理员时直接拒绝并提示登录', async () => {
    useMemoryStorage();

    const result = await requireAdminAuth();

    expect(result).toBe(false);
    expect(wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '请先登录管理员账号' })
    );
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('silent 模式下不弹 toast', async () => {
    useMemoryStorage();

    await requireAdminAuth({ silent: true });

    expect(wx.showToast).not.toHaveBeenCalled();
  });

  test('兼容旧版布尔参数（requireAdminAuth(false) 等价 strict:false）', async () => {
    useMemoryStorage({ isAdmin: true, _adminLastVerifyTime: Date.now() });

    // 非严格 + 1小时内已验证 → 不再调云函数
    await expect(requireAdminAuth(false)).resolves.toBe(true);
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('严格模式下 _adminAccount 为空时拒绝并清除权限', async () => {
    const store = useMemoryStorage({ isAdmin: true });

    const result = await requireAdminAuth({ strict: true });

    expect(result).toBe(false);
    expect(store.isAdmin).toBeUndefined();
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('严格模式下云端校验通过则放行，并同步 isSuperAdmin', async () => {
    useMemoryStorage({ isAdmin: true, _adminRole: 'superadmin', _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: true, role: 'superadmin' } }
    });
    const app = { globalData: {} };
    getApp.mockReturnValue(app);

    await expect(requireAdminAuth({ strict: true })).resolves.toBe(true);
    expect(app.globalData.isSuperAdmin).toBe(true);
  });

  test('云端角色变化时回写本地 _adminRole（降权后超管菜单立即消失）', async () => {
    const store = useMemoryStorage({ isAdmin: true, _adminRole: 'superadmin', _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: true, role: 'admin' } }
    });
    const app = { globalData: {} };
    getApp.mockReturnValue(app);

    await expect(requireAdminAuth({ strict: true })).resolves.toBe(true);

    // 此前 _adminRole 只在登录时写一次：降权者仍能看到超管菜单，调用时才被服务端拒绝
    expect(store._adminRole).toBe('admin');
    expect(app.globalData.isSuperAdmin).toBe(false);
  });

  test('云端未返回角色（旧版云函数）时不改动本地角色，也不误清', async () => {
    const store = useMemoryStorage({ isAdmin: true, _adminRole: 'superadmin', _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: true } }
    });
    getApp.mockReturnValue({ globalData: {} });

    await expect(requireAdminAuth({ strict: true })).resolves.toBe(true);

    expect(store._adminRole).toBe('superadmin');
  });

  test('云端明确返回非管理员时会重试一次，仍失败则拒绝并清除', async () => {
    const store = useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: false } }
    });

    const result = await requireAdminAuth({ strict: true });

    expect(result).toBe(false);
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
    expect(store.isAdmin).toBeUndefined();
  });

  // 性能回归（2026-10-15）：重试等待原为**阻塞**的 2000ms —— 管理页每次进入都要先过
  // 这道云端校验，命中重试就等于首屏白等 2 秒（pages/admin/admin 页面切换均值 3758ms）。
  // 这里钉住「等待有上限」：若有人把延迟调回秒级，本用例变红。
  test('云端校验重试的等待时间有上限（原为阻塞 2 秒）', async () => {
    useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: false } }
    });

    const delays = [];
    global.setTimeout = (fn, delay) => { delays.push(delay); fn(); return 0; };

    await requireAdminAuth({ strict: true });

    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1000);
  });

  test('云端调用抛异常时按「失败即拒绝」处理', async () => {
    const store = useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });
    wx.cloud.callFunction.mockRejectedValue(new Error('network down'));

    const result = await requireAdminAuth({ strict: true });

    expect(result).toBe(false);
    expect(wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '网络异常，请重试' })
    );
    // 网络异常不清除登录态，便于用户恢复网络后继续使用
    expect(store.isAdmin).toBe(true);
  });

  test('非严格模式且距上次校验未超 1 小时时不调云函数', async () => {
    useMemoryStorage({ isAdmin: true, _adminLastVerifyTime: Date.now() - 1000 });

    await expect(requireAdminAuth({ strict: false })).resolves.toBe(true);
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('非严格模式超过 1 小时未校验时执行云端校验并刷新时间戳', async () => {
    const store = useMemoryStorage({
      isAdmin: true,
      _adminAccount: 'root',
      _adminLastVerifyTime: Date.now() - HOUR_MS - 1000
    });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: true } }
    });

    await expect(requireAdminAuth({ strict: false })).resolves.toBe(true);
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(store._adminLastVerifyTime).toBeGreaterThan(Date.now() - 1000);
  });

  test('非严格模式定期校验失败时清除权限并拒绝', async () => {
    const store = useMemoryStorage({
      isAdmin: true,
      _adminAccount: 'root',
      _adminLastVerifyTime: 0
    });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { isAdmin: false } }
    });

    const result = await requireAdminAuth({ strict: false });

    expect(result).toBe(false);
    // 定期校验路径不做重试
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(store.isAdmin).toBeUndefined();
  });
});

describe('setAdminAuth / clearAdminAuth / getAdminRole', () => {
  test('setAdminAuth 写入角色与账号，并保存服务端签名', async () => {
    const store = useMemoryStorage();
    wx.cloud.callFunction.mockResolvedValue({
      result: {
        success: true,
        data: { signature: VALID_SIG, timestamp: 123456, salt: 's', algorithm: 'HMAC-SHA256' }
      }
    });

    await setAdminAuth(true, 'superadmin', 'root');

    expect(store.isAdmin).toBe(true);
    expect(store._adminRole).toBe('superadmin');
    expect(store._adminAccount).toBe('root');
    expect(store[SIG_KEY]).toBe(VALID_SIG);
    expect(store[SIG_TIME_KEY]).toBe(123456);
  });

  test('签名生成失败时仍保留登录状态且不抛错', async () => {
    const store = useMemoryStorage();
    wx.cloud.callFunction.mockRejectedValue(new Error('sign fail'));

    await expect(setAdminAuth(true, 'admin', 'ops')).resolves.toBeUndefined();
    expect(store.isAdmin).toBe(true);
    expect(store[SIG_KEY]).toBeUndefined();
  });

  test('setAdminAuth(false) 不请求签名', async () => {
    const store = useMemoryStorage();

    await setAdminAuth(false);

    expect(store.isAdmin).toBe(false);
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('clearAdminAuth 清空全部权限与签名相关键', () => {
    const store = useMemoryStorage({
      isAdmin: true,
      _adminRole: 'admin',
      _adminAccount: 'ops',
      _adminPermissions: ['mediaReview'],
      [SIG_KEY]: VALID_SIG,
      [SIG_TIME_KEY]: Date.now(),
      _adminLastVerifyTime: Date.now()
    });

    clearAdminAuth();

    expect(Object.keys(store)).toHaveLength(0);
  });

  test('setAdminAuth 写入入口权限缓存', async () => {
    const store = useMemoryStorage();
    wx.cloud.callFunction.mockRejectedValue(new Error('sign fail'));

    await setAdminAuth(true, 'admin', 'ops', ['mediaReview', 'bogus']);

    expect(store._adminPermissions).toEqual(['mediaReview']);
    expect(hasAdminPermission('mediaReview')).toBe(true);
    expect(hasAdminPermission('addCat')).toBe(false);
  });

  test('getAdminRole 返回已保存的角色', () => {
    useMemoryStorage({ _adminRole: 'admin' });
    expect(getAdminRole()).toBe('admin');
  });
});

describe('入口权限缓存（14 项）', () => {
  test('超管永远拥有全部权限', () => {
    useMemoryStorage({ _adminRole: 'superadmin' });

    expect(getAdminPermissions()).toEqual(PERMISSION_KEYS);
    expect(hasAdminPermission('logs')).toBe(true);
    expect(hasAdminPermission('catActivity')).toBe(true);
  });

  test('创始人（founder）与超管同口径：全量权限 + isSuperAdminLevel', () => {
    useMemoryStorage({ _adminRole: 'founder' });

    expect(getAdminPermissions()).toEqual(PERMISSION_KEYS);
    expect(hasAdminPermission('logs')).toBe(true);
    expect(isSuperAdminLevel()).toBe(true);
    expect(isFounder()).toBe(true);

    // 超管是「超管及以上」但不是创始人
    useMemoryStorage({ _adminRole: 'superadmin' });
    expect(isSuperAdminLevel()).toBe(true);
    expect(isFounder()).toBe(false);

    useMemoryStorage({ _adminRole: 'admin' });
    expect(isSuperAdminLevel()).toBe(false);
    expect(isFounder()).toBe(false);
  });

  test('普通管理员没有缓存时回落默认 3 项', () => {
    useMemoryStorage({ _adminRole: 'admin' });

    expect(getAdminPermissions()).toEqual(DEFAULT_PERMISSION_KEYS);
    expect(hasAdminPermission('addCat')).toBe(true);
    expect(hasAdminPermission('cat')).toBe(true);
    expect(hasAdminPermission('photo')).toBe(true);
    expect(hasAdminPermission('mediaReview')).toBe(false);
  });

  test('普通管理员按缓存名单生效：去重并丢弃未知 key', () => {
    useMemoryStorage({
      _adminRole: 'admin',
      _adminPermissions: ['mediaReview', 'bogus', 'mediaReview', 'logs']
    });

    expect(getAdminPermissions()).toEqual(['mediaReview', 'logs']);
    expect(hasAdminPermission('mediaReview')).toBe(true);
    expect(hasAdminPermission('bogus')).toBe(false);
    expect(hasAdminPermission('addCat')).toBe(false);
  });

  test('未登录 / 非管理员角色一律拒绝', () => {
    useMemoryStorage();
    expect(hasAdminPermission('addCat')).toBe(false);

    useMemoryStorage({ _adminRole: 'user' });
    expect(hasAdminPermission('addCat')).toBe(false);
  });
});

describe('checkAdminAuthAsync / refreshSignature', () => {
  test('checkAdminAuthAsync 兼容 data.isAdmin 与顶层 isAdmin 两种结构', async () => {
    useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });

    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { isAdmin: true } } });
    await expect(checkAdminAuthAsync()).resolves.toEqual({ verified: true });

    wx.cloud.callFunction.mockResolvedValue({ result: { isAdmin: true } });
    await expect(checkAdminAuthAsync()).resolves.toEqual({ verified: true });
  });

  test('checkAdminAuthAsync 在云端异常时返回 verified:false', async () => {
    useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });
    wx.cloud.callFunction.mockRejectedValue(new Error('boom'));

    await expect(checkAdminAuthAsync()).resolves.toEqual({ verified: false });
  });

  test('refreshSignature 对非管理员直接返回 false', async () => {
    useMemoryStorage();

    await expect(refreshSignature()).resolves.toBe(false);
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('refreshSignature 成功后写入新签名并返回 true', async () => {
    const store = useMemoryStorage({ isAdmin: true, _adminAccount: 'root' });
    wx.cloud.callFunction.mockResolvedValue({
      result: { success: true, data: { signature: VALID_SIG, timestamp: 999 } }
    });

    await expect(refreshSignature()).resolves.toBe(true);
    expect(store[SIG_KEY]).toBe(VALID_SIG);
  });
});
