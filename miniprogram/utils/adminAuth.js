/**
 * utils/adminAuth.js - 管理员权限检查工具
 *
 * 提供管理员权限的同步/异步检查、设置和清除功能
 * 权限信息存储在本地存储和 globalData 中
 *
 * 安全架构升级（v2.0）：
 * - 签名由服务端云函数 generateAdminSignature 生成
 * - 使用 HMAC-SHA256 算法，密钥仅在云函数环境变量中
 * - 客户端不再存储任何密钥，无法伪造签名
 * - 每次登录获取新签名，包含随机盐值
 *
 * 安全说明：
 * - checkAdminAuth() 仅用于 UI 显示/隐藏，不可作为安全依据
 * - requireAdminAuth() 必须配合云函数二次验证使用
 * - 所有写操作（增删改）必须在云函数内校验 admins 集合
 *
 * @module adminAuth
 */

const { Logger } = require('./logger');
const {
  PERMISSION_KEYS,
  normalizePermissionKeys
} = require('./adminPermissions');

// 签名相关存储key
const AUTH_SIGNATURE_KEY = '_adminSig';
const SIG_TIME_KEY = '_adminSigTime';
const ADMIN_ROLE_KEY = '_adminRole';
const ADMIN_ACCOUNT_KEY = '_adminAccount';
// 入口权限缓存：登录/云端校验时由服务端下发，驱动首页菜单与子页门禁。
// 只用于 UI 与本地门禁，真实拦截在云函数 checkAdmin({ permission })。
const ADMIN_PERMISSIONS_KEY = '_adminPermissions';

// 签名有效期：1小时（毫秒），与云函数保持一致
const SIGN_EXPIRY_MS = 1 * 60 * 60 * 1000;

// 首次云端校验未通过时的重试等待（毫秒）。
//
// 原为 2000ms，且是**阻塞**等待 —— 管理页每次进入都要先过这道云端校验，一旦命中重试
// 就等于首屏白等 2 秒（2026-10-15 性能复盘：pages/admin/admin 页面切换均值 3758ms）。
// 500ms 足够覆盖「刚改完 admins 记录的主从复制延迟」这类抖动；而真被撤权时，
// 用户也不用先等 2 秒才被请出去。
const VERIFY_RETRY_DELAY_MS = 500;

/**
 * 验证服务端签名的有效性（简化版）
 * 仅检查：签名存在 + 未过期 + 格式正确
 * 注意：不验证签名内容，因为密钥在服务端
 *
 * @returns {boolean} 签名是否有效
 */
function _verifySignature () {
  try {
    const isAdmin = wx.getStorageSync('isAdmin');
    const sig = wx.getStorageSync(AUTH_SIGNATURE_KEY);
    const sigTime = wx.getStorageSync(SIG_TIME_KEY) || 0;

    if (!isAdmin) {
      return false;
    }

    if (!sig) {
      return true;
    }

    if (Date.now() - sigTime > SIGN_EXPIRY_MS) {
      // 过期不等于「被篡改」：签名只在本地做 UI 层校验，真实门禁是云端 OPENID 校验
      //（requireStrictCloudAuth）。原实现过期即 return false → checkAdminAuth 清除登录态
      // → 所有管理子页每小时必被踢一次、且页面停在骨架屏。这里放行到云端校验并静默续期，
      // 云端失败仍会走 clearAdminAuth。
      console.warn('[AdminAuth] 签名已过期，尝试静默续期');
      refreshSignature().catch(() => {});
      return true;
    }

    if (typeof sig !== 'string' || sig.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(sig)) {
      console.warn('[AdminAuth] 签名格式异常');
      return false;
    }

    return true;
  } catch (e) {
    console.error('[AdminAuth] 签名验证异常:', e);
    return false;
  }
}

/**
 * 读取本地保存的管理员账号
 * @returns {string}
 */
function getStoredAdminAccount () {
  return wx.getStorageSync(ADMIN_ACCOUNT_KEY) || '';
}

/**
 * 统一鉴权提示（silent 模式不弹）
 */
function notifyAuth (silent, title) {
  if (!silent) {
    wx.showToast({ title, icon: 'none' });
  }
}

/**
 * 把 globalData.isSuperAdmin 同步为当前角色判断结果（超管及以上：超管/创始人）
 */
function syncSuperAdminFlag () {
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.isSuperAdmin = isSuperAdminLevel();
    }
  } catch (_e) { /* ignore app instance access errors */ }
}

/**
 * 调用 checkAdminStatus 并归一化响应结构
 * 后端 ok() 包装后业务字段在 data 下，这里同时兼容旧版平铺结构
 *
 * @param {string} adminAccount - 管理员账号
 * @returns {Promise<{isAdmin: boolean, role: *, permissions: Array|undefined, success: *}>}
 */
async function callCheckAdminStatus (adminAccount) {
  const res = await wx.cloud.callFunction({
    name: 'checkAdminStatus',
    data: { _adminAccount: adminAccount }
  });
  const result = res.result || {};
  const resultData = result.data || result;

  Logger.info('AdminAuth', 'checkAdminStatus 结果', {
    verified: resultData.isAdmin,
    success: result.success,
    role: resultData.role
  });

  return {
    isAdmin: !!resultData.isAdmin,
    role: resultData.role,
    permissions: resultData.permissions,
    success: result.success
  };
}

/**
 * 云端校验管理员身份
 *
 * @param {string} adminAccount - 本地保存的管理员账号
 * @param {Object} [opts]
 * @param {boolean} [opts.retry=true] - 首次未通过时是否重试一次（处理数据库复制延迟）
 * @returns {Promise<boolean>}
 */
async function verifyAdminInCloud (adminAccount, { retry = true } = {}) {
  const first = await callCheckAdminStatus(adminAccount);
  let isAdmin = first.isAdmin;
  let role = first.role;
  let permissions = first.permissions;

  if (!isAdmin && first.success !== false && retry) {
    // eslint-disable-next-line no-console
    console.log('[AdminAuth] 首次验证未通过，稍后重试一次（等待 %dms）', VERIFY_RETRY_DELAY_MS);
    await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_DELAY_MS));
    ({ isAdmin, role, permissions } = await callCheckAdminStatus(adminAccount));
  }

  // 角色以服务端为准并回写本地：登录后发生的提权/降权无需重新登录即可生效。
  // 此前 _adminRole 只在登录时写一次 —— 降权者仍能看到超管菜单（调用时才被服务端拒绝）、
  // 提权者看不到新菜单，客户端 UI 与服务端实际权限长期不一致。
  // 仅在云端返回了非空角色时更新，防止旧版 checkAdminStatus（无 role 字段）把本地角色抹掉。
  if (isAdmin && typeof role === 'string' && role) {
    try {
      wx.setStorageSync(ADMIN_ROLE_KEY, role);
      // 权限与角色同一时机回写：服务端未返回 permissions 时保持旧缓存，
      // 避免旧版云函数把已经开通的入口误清空（真实拦截始终在云端）。
      if (Array.isArray(permissions)) {
        wx.setStorageSync(ADMIN_PERMISSIONS_KEY, normalizePermissionKeys(permissions));
      }
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.isSuperAdmin = role === 'superadmin' || role === 'founder';
      }
    } catch (_e) { /* ignore storage/globalData access errors */ }
  }

  return isAdmin;
}

/**
 * 严格模式：每次调用都走云端校验
 * @param {boolean} silent - 是否静默（不弹 Toast）
 * @returns {Promise<boolean>}
 */
async function requireStrictCloudAuth (silent) {
  const adminAccount = getStoredAdminAccount();
  if (!adminAccount) {
    console.warn('[AdminAuth] _adminAccount 为空，无法验证');
    clearAdminAuth();
    notifyAuth(silent, '请先登录管理员账号');
    return false;
  }

  try {
    if (!await verifyAdminInCloud(adminAccount)) {
      clearAdminAuth();
      notifyAuth(silent, '登录已过期，请重新登录');
      return false;
    }
    syncSuperAdminFlag();
    return true;
  } catch (err) {
    console.warn('[AdminAuth] 云端验证失败:', err.message || err);
    notifyAuth(silent, '网络异常，请重试');
    return false;
  }
}

/**
 * 非严格模式：距上次云端校验超过 1 小时才重新校验
 * @returns {Promise<boolean>}
 */
async function requirePeriodicCloudAuth () {
  const lastVerifyTime = wx.getStorageSync('_adminLastVerifyTime') || 0;
  const VERIFY_INTERVAL = 3600000;

  if (Date.now() - lastVerifyTime <= VERIFY_INTERVAL) {
    return true;
  }

  console.warn('[AdminAuth] 非严格模式超过1小时未验证，执行云端校验');
  try {
    if (!await verifyAdminInCloud(getStoredAdminAccount(), { retry: false })) {
      clearAdminAuth();
      return false;
    }
    syncSuperAdminFlag();
    wx.setStorageSync('_adminLastVerifyTime', Date.now());
    return true;
  } catch (err) {
    console.warn('[AdminAuth] 定期验证失败，拒绝访问:', err.message);
    clearAdminAuth();
    return false;
  }
}

/**
 * 检查管理员权限（同步）
 * 此方法仅用于 UI 层显示/隐藏管理入口
 * 绝不可作为安全鉴权依据！安全鉴权必须走云函数。
 *
 * @returns {boolean} 本地是否标记为管理员（不可信）
 */
function checkAdminAuth () {
  const fromStorage = wx.getStorageSync('isAdmin');

  // 签名校验：检测本地存储是否被简单篡改
  if (fromStorage && !_verifySignature()) {
    console.warn('[AdminAuth] 签名校验失败，可能被篡改，已清除');
    clearAdminAuth();
    return false;
  }

  // 同步到 globalData（如果存在）
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.isAdmin = !!fromStorage;
    }
  } catch (e) {
    // ignore
  }

  return !!fromStorage;
}

/**
 * 验证管理员权限（异步 + 云端强校验）
 * 未登录或云端验证失败均返回 false
 * 用于页面 onLoad / onShow 时的权限门禁
 *
 * @param {Object} options - 配置选项
 * @param {boolean} options.strict - 是否为严格模式（默认true，写操作必须传true）
 * @param {boolean} options.silent - 是否静默模式（不显示Toast提示）
 * @returns {Promise<boolean>} 是否有权限（可信）
 */
async function requireAdminAuth (options = {}) {
  // 修复（v4.2）：兼容旧版布尔参数
  if (typeof options === 'boolean') {
    options = { strict: options };
  }
  const { strict = true, silent = false } = options;

  // 第一步：快速检查本地标记（仅用于快速失败）
  if (!checkAdminAuth()) {
    notifyAuth(silent, '请先登录管理员账号');
    return false;
  }

  // 安全修复（v4.0）：所有调用都必须通过云端验证（移除快速路径）
  // 原因：本地Storage可被篡改（开发者工具/越狱设备）
  // 即使本地签名验证通过，也不能作为安全依据
  
  if (strict) {
    return requireStrictCloudAuth(silent);
  }

  return requirePeriodicCloudAuth();
}

/**
 * 设置管理员权限（仅限 adminLogin 云函数验证成功后调用）
 * 调用服务端云函数生成安全签名
 *
 * @param {boolean} isAdmin - 是否是管理员
 * @param {string} [role] - 'founder' | 'superadmin' | 'admin'
 * @param {string} [account] - 登录账号
 * @param {string[]} [permissions] - 入口权限 key 数组（adminLogin 下发）
 * @returns {Promise<void>} - 签名保存完成后 resolve（登录成功时需 await）
 */
async function setAdminAuth (isAdmin, role, account, permissions) {
  wx.setStorageSync('isAdmin', isAdmin);
  wx.setStorageSync(ADMIN_ROLE_KEY, role || '');
  if (account) {
    wx.setStorageSync(ADMIN_ACCOUNT_KEY, account);
  }
  if (isAdmin && Array.isArray(permissions)) {
    wx.setStorageSync(ADMIN_PERMISSIONS_KEY, normalizePermissionKeys(permissions));
  }

  if (isAdmin) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'generateAdminSignature',
        data: { _adminAccount: account || wx.getStorageSync(ADMIN_ACCOUNT_KEY) || '' }
      });

      if (res.result?.success && res.result?.data) {
        const { signature, timestamp, salt, algorithm } = res.result.data;

        wx.setStorageSync(SIG_TIME_KEY, timestamp);
        wx.setStorageSync(AUTH_SIGNATURE_KEY, signature);
        wx.setStorageSync('_adminSigSalt', salt);
        wx.setStorageSync('_adminSigAlgorithm', algorithm);
      } else {
        console.warn('[AdminAuth] 签名生成未成功:', res.result?.message || '未知原因');
      }
    } catch (e) {
      console.warn('[AdminAuth] 签名生成失败，登录状态仍保留:', e.message || e);
    }
  }

  // 尝试更新 globalData
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.isAdmin = isAdmin;
      app.globalData.isSuperAdmin = isAdmin && (role === 'superadmin' || role === 'founder');
    }
  } catch (e) {
    console.warn('[AdminAuth] 更新globalData失败', e.message || e);
  }
}

/**
 * 获取管理员角色
 * @returns {string} 'founder' | 'superadmin' | 'admin' | ''
 */
function getAdminRole () {
  return wx.getStorageSync(ADMIN_ROLE_KEY) || '';
}

/**
 * 是否「超管及以上」角色（超级管理员或创始人）。
 * 创始人与超管都拥有全部入口权限、都能进入「管理员管理」，
 * 区别仅在角色升降级（仅创始人），由 manage-admins 页面按 isFounder 区分。
 * @returns {boolean}
 */
function isSuperAdminLevel () {
  const role = getAdminRole();
  return role === 'superadmin' || role === 'founder';
}

/**
 * 是否创始人（三档中的顶级：唯一能升降级管理员角色）。
 * @returns {boolean}
 */
function isFounder () {
  return getAdminRole() === 'founder';
}

/**
 * 获取当前管理员生效的入口权限 key 数组。
 *
 * - 超管/创始人：永远全部
 * - 本地尚无缓存（旧登录态 / 尚未走 checkAdminStatus）：按默认 3 项
 * - 真实拦截始终由云函数完成，这里只影响菜单与页面门禁
 *
 * @returns {string[]}
 */
function getAdminPermissions () {
  if (isSuperAdminLevel()) return PERMISSION_KEYS.slice();
  return normalizePermissionKeys(wx.getStorageSync(ADMIN_PERMISSIONS_KEY));
}

/**
 * 判断当前管理员是否开通了某个入口权限。
 *
 * @param {string} key - utils/adminPermissions 的权限 key
 * @returns {boolean}
 */
function hasAdminPermission (key) {
  if (!key) return true;
  const role = getAdminRole();
  if (role === 'superadmin' || role === 'founder') return true;
  if (role !== 'admin') return false;
  return getAdminPermissions().includes(key);
}

/**
 * 清除管理员权限（包括所有签名数据）
 */
function clearAdminAuth () {
  // 清除基础权限标识
  wx.removeStorageSync('isAdmin');
  wx.removeStorageSync(ADMIN_ROLE_KEY);
  wx.removeStorageSync(ADMIN_ACCOUNT_KEY);
  wx.removeStorageSync(ADMIN_PERMISSIONS_KEY);

  // 清除所有签名相关数据
  wx.removeStorageSync(AUTH_SIGNATURE_KEY);
  wx.removeStorageSync(SIG_TIME_KEY);
  wx.removeStorageSync('_adminSigSalt');
  wx.removeStorageSync('_adminSigAlgorithm');
  wx.removeStorageSync('_adminLastVerifyTime');

  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.isAdmin = false;
      app.globalData.isSuperAdmin = false;
    }
  } catch (e) {
    console.warn('[AdminAuth] 清除globalData失败', e);
  }
}

/**
 * 异步检查管理员权限（云端验证）
 * 遵循"失败即拒绝"原则：网络异常 = 无权限
 *
 * @returns {Promise<{verified: boolean}>}
 */
async function checkAdminAuthAsync () {
  try {
    const adminAccount = wx.getStorageSync(ADMIN_ACCOUNT_KEY) || '';
    const res = await wx.cloud.callFunction({
      name: 'checkAdminStatus',
      data: { _adminAccount: adminAccount }
    });
    const r = res.result || {};
    return { verified: r.data && r.data.isAdmin || r.isAdmin || false };
  } catch (err) {
    console.warn('[AdminAuth] 云端验证失败，拒绝访问:', err.message || err);
    return { verified: false };
  }
}

/**
 * 刷新签名（可选操作）
 * 在签名即将过期时主动刷新，避免用户需要重新登录
 *
 * @returns {Promise<boolean>} 刷新是否成功
 */
async function refreshSignature () {
  try {
    const isAdmin = wx.getStorageSync('isAdmin');
    if (!isAdmin) return false;

    const adminAccount = wx.getStorageSync(ADMIN_ACCOUNT_KEY) || '';
    const res = await wx.cloud.callFunction({
      name: 'generateAdminSignature',
      data: { _adminAccount: adminAccount }
    });

    if (res.result?.success && res.result?.data) {
      const { signature, timestamp } = res.result.data;
      wx.setStorageSync(SIG_TIME_KEY, timestamp);
      wx.setStorageSync(AUTH_SIGNATURE_KEY, signature);
      return true;
    }

    return false;
  } catch (e) {
    console.warn('[AdminAuth] 签名刷新失败:', e);
    return false;
  }
}

/**
 * 模块导出
 *
 * @exports checkAdminAuth - 同步检查权限
 * @exports requireAdminAuth - 验证权限（带提示）
 * @exports setAdminAuth - 设置权限（调用服务端生成签名）
 * @exports clearAdminAuth - 清除权限
 * @exports checkAdminAuthAsync - 异步云端验证
 * @exports refreshSignature - 刷新签名（新增）
 */
module.exports = {
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
};
