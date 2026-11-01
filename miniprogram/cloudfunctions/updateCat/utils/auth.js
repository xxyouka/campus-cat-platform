// cloudfunctions/utils/auth.js - 统一权限校验工具
/**
 * 提供标准化的权限检查接口
 * 所有写操作云函数都应使用此模块进行权限验证
 *
 * 验证方式：基于调用者真实 OPENID（cloud.getWXContext().OPENID）
 * 在 admins 集合中匹配 openid 字段，确认 role 为 admin/superadmin/founder。
 *
 * 角色三档（2026-10）：
 * - founder 创始人：由环境变量 SUPER_ACCOUNT 唯一指定（adminLogin 登录时升格），
 *   与超管一样拥有全部入口权限，且是唯一能调整管理员角色的档位。
 * - superadmin 超级管理员：全部入口权限，恒全量、不可调整。
 * - admin 普通管理员：按 admins.permissions 授权。
 *
 * 入口权限（2026-10）：
 * - checkAdmin(db, openid, { permission: '<key>' }) 会额外校验 admins.permissions；
 *   无权限时返回 isAdmin:false，既有调用点天然 fail-closed。
 * - 超管/创始人永远通过；普通管理员字段缺失时按默认 3 项（addCat/cat/photo）解释。
 * - 权限 key 与客户端 utils/adminPermissions.js 必须完全一致。
 *
 * 安全说明：
 * - 客户端传入的 adminAccount 仅用于日志/展示，绝不可作为身份凭据；
 * - 只有服务端 getWXContext().OPENID 才是可信身份，任何客户端可控字段
 *   （如 _adminAccount）都不得参与鉴权判定。
 */

const cloud = require('wx-server-sdk');

// 三档角色：创始人（founder，环境变量 SUPER_ACCOUNT 唯一指定）> 超级管理员 > 普通管理员。
// founder 只能由 adminLogin 在 SUPER_ACCOUNT 凭据验证通过时写入/升格，
// 任何管理接口都不得把 role 设为 founder。
const ADMIN_ROLES = ['admin', 'superadmin', 'founder'];
const SUPER_LEVEL_ROLES = ['superadmin', 'founder'];

const ADMIN_COLLECTION = 'admins';
const MAX_CACHE_SIZE = 1000;

// 管理后台首页「功能管理」中可授权的入口。
// 「管理员管理」不在此列：该模块永远仅超级管理员可用，不能下放给普通管理员。
// key 必须与客户端 utils/adminPermissions.js 完全一致；manageAdmin 保存权限时
// 以此白名单校验，未知 key 一律拒绝/丢弃，避免手误写入脏数据。
const ADMIN_PERMISSION_KEYS = [
  'ops', 'addCat', 'photo', 'cat', 'notice', 'relation',
  'logs', 'catActivity', 'mediaReview', 'report'
];

// 新建管理员、以及历史文档尚未写 permissions 字段时的默认开放项：
// 添加新猫 / 猫咪管理 / 照片管理。
const DEFAULT_ADMIN_PERMISSIONS = ['addCat', 'cat', 'photo'];

const ADMIN_PERMISSION_KEY_SET = new Set(ADMIN_PERMISSION_KEYS);

/**
 * 归一化管理员权限名单。
 * - 字段不存在（undefined / null / 非数组）→ 默认 3 项（历史账号自动落到该默认值）
 * - 显式空数组 → 一项都不开（允许超管主动全关）
 * - 未知 key 丢弃、重复项去重
 *
 * @param {*} value - admins.permissions 原始值
 * @returns {string[]}
 */
function normalizePermissions(value) {
  if (!Array.isArray(value)) return DEFAULT_ADMIN_PERMISSIONS.slice();
  const result = [];
  for (const key of value) {
    if (ADMIN_PERMISSION_KEY_SET.has(key) && !result.includes(key)) result.push(key);
  }
  return result;
}

/**
 * 计算某管理员实际生效的开放名单（超管/创始人恒为全部 13 项）。
 *
 * @param {object|null} adminInfo - admins 文档
 * @returns {string[]}
 */
function getEffectivePermissions(adminInfo) {
  if (!adminInfo) return [];
  if (SUPER_LEVEL_ROLES.includes(adminInfo.role)) return ADMIN_PERMISSION_KEYS.slice();
  return normalizePermissions(adminInfo.permissions);
}

/**
 * 判断某管理员文档是否开通了指定入口权限。
 *
 * @param {object|null} adminInfo - admins 文档
 * @param {string} key - ADMIN_PERMISSION_KEYS 中的 key
 * @returns {boolean}
 */
function hasPermission(adminInfo, key) {
  if (!adminInfo) return false;
  if (SUPER_LEVEL_ROLES.includes(adminInfo.role)) return true;
  return getEffectivePermissions(adminInfo).includes(key);
}

/**
 * 是否「超管及以上」角色（超级管理员或创始人）。
 * @param {string} role
 * @returns {boolean}
 */
function isSuperLevelRole(role) {
  return SUPER_LEVEL_ROLES.includes(role);
}

// 幂等初始化（与 cloud.js 保持一致，避免重复 init）
if (!cloud.isInit) {
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  cloud.isInit = true;
}

class AuthChecker {
  constructor() {
    this._cache = new Map();
    this.cacheTTL = 1 * 60 * 1000; // 1分钟，减少权限撤销延迟
  }

  /**
   * 获取当前调用者真实 OPENID
   * @returns {string} openid（无则返回空字符串）
   */
  _getCallerOpenid() {
    try {
      const ctx = cloud.getWXContext();
      return ctx && ctx.OPENID || '';
    } catch (err) {
      console.error('[AuthCheck] 获取 OPENID 失败:', err);
      return '';
    }
  }

  /**
   * 检查管理员权限（基于真实 OPENID）
   * @param {object} db - 数据库实例
   * @param {string} _openid - 兼容旧签名参数（实际以服务端 OPENID 为准，不再使用）
   * @param {object} options - 可选配置
   * @param {boolean} options.useCache - 是否使用缓存（默认 true）
   * @param {string} options.operation - 操作名称（用于错误提示）
   * @param {string} [options.permission] - 需要的入口权限 key；不传则不校验权限
   * @returns {Promise<{isAdmin: boolean, hasPermission: boolean, error?: string, adminInfo?: object}>}
   */
  async checkAdmin(db, _openid, options = {}) {
    const { useCache = true, operation = '操作', permission = '' } = options;

    if (!db) {
      return {
        isAdmin: false,
        hasPermission: false,
        error: '数据库连接异常'
      };
    }

    const openid = this._getCallerOpenid();
    if (!openid) {
      return {
        isAdmin: false,
        hasPermission: false,
        error: '无法获取用户身份信息'
      };
    }

    const cached = this._readAdminCache(openid, useCache);
    let adminDoc = cached.adminDoc;

    if (!cached.hit) {
      const lookup = await this._queryAdminDoc(db, openid);
      if (lookup.error) {
        return { isAdmin: false, hasPermission: false, error: lookup.error };
      }
      adminDoc = lookup.adminDoc;
      this._cacheAdminDoc(openid, adminDoc, useCache);
    }

    const isAdmin = !!(adminDoc && ADMIN_ROLES.includes(adminDoc.role));
    // permission 未传 → 保持旧语义（只校验管理员身份）；
    // 传了但无权 → isAdmin 也置 false，让所有既有 `if (!authResult.isAdmin) return fail(...)`
    // 调用点天然 fail-closed，不会因为漏改某一处而放行。
    const permitted = !permission || !isAdmin || hasPermission(adminDoc, permission);
    const response = {
      isAdmin: isAdmin && permitted,
      hasPermission: isAdmin && permitted,
      error: !isAdmin
        ? `无权限执行此${operation}，仅管理员可操作`
        : !permitted
          ? `该账号未开通「${operation}」权限，请联系超级管理员开启`
          : null,
      adminInfo: adminDoc
    };

    return response;
  }

  /**
   * 读取短期管理员文档缓存。缓存文档而非权限结论，调用方按当前 permission 单独判定。
   */
  _readAdminCache(openid, useCache) {
    if (!useCache || !this._cache.has(openid)) return { hit: false, adminDoc: null };

    const cached = this._cache.get(openid);
    if (Date.now() - cached.timestamp < this.cacheTTL) {
      return { hit: true, adminDoc: cached.adminDoc };
    }

    this._cache.delete(openid);
    return { hit: false, adminDoc: null };
  }

  /** 查询并验证管理员文档；重复绑定与数据库异常均失败关闭。 */
  async _queryAdminDoc(db, openid) {
    try {
      const result = await db.collection(ADMIN_COLLECTION)
        .where({ openid })
        .limit(2)
        .get();

      if (result && result.data && result.data.length > 1) {
        this._cache.delete(openid);
        console.error('[AuthCheck] 管理员身份绑定重复，拒绝授权');
        return { error: '管理员绑定异常，请联系超级管理员处理' };
      }

      return { adminDoc: result && result.data && result.data[0] || null };
    } catch (err) {
      console.error('[AuthCheck] 权限验证异常:', err);
      return { error: '权限验证服务暂时不可用，请稍后重试' };
    }
  }

  /** 保存新查到的文档，并保留 useCache:false 对撤权缓存的清理语义。 */
  _cacheAdminDoc(openid, adminDoc, useCache) {
    const isAdminDoc = !!(adminDoc && ADMIN_ROLES.includes(adminDoc.role));
    if (useCache) {
      this._evictIfNeeded();
      this._cache.set(openid, { adminDoc, timestamp: Date.now() });
    } else if (!isAdminDoc) {
      // 写操作发现已撤权时清除旧文档，避免缓存接口继续短暂放行。
      this._cache.delete(openid);
    }
  }

  _evictIfNeeded() {
    if (this._cache.size < MAX_CACHE_SIZE) return;

    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, value] of this._cache) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._cache.delete(oldestKey);
    }
  }

  cleanExpired() {
    const now = Date.now();
    for (const [key, value] of this._cache) {
      if (now - value.timestamp >= this.cacheTTL) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * 检查资源所有权
   *
   * 与 checkAdmin 同一原则：签名里的 openid 参数仅兼容旧签名，**不参与判定**。
   * 决定 isOwner 的必须是服务端 getWXContext().OPENID —— 若拿调用方传入的 openid
   * 比对 doc._openid，任何客户端可控字段都会变成所有权凭据（本模块头部已明确禁止）。
   * @param {object} db
   * @param {string} _openid - 兼容旧签名参数（不参与判定）
   * @param {string} collection
   * @param {string} docId
   */
  async checkOwnership(db, _openid, collection, docId) {
    const openid = this._getCallerOpenid();
    if (!openid) {
      return { isOwner: false, isAdmin: false, error: '无法获取用户身份信息' };
    }

    try {
      const res = await db.collection(collection).doc(docId).get();
      const doc = res.data;

      if (!doc) {
        return { isOwner: false, isAdmin: false, error: '资源不存在' };
      }

      const isOwner = doc._openid === openid;

      // 管理员判断基于服务端真实 OPENID（checkAdmin 内部已获取）
      const adminCheck = await this.checkAdmin(db, openid, { useCache: true });

      return {
        isOwner,
        isAdmin: adminCheck.isAdmin,
        canOperate: isOwner || adminCheck.isAdmin
      };

    } catch (err) {
      console.error('[AuthCheck] 所有权检查失败:', err);
      return { isOwner: false, isAdmin: false, error: '权限检查失败' };
    }
  }

  clearCache() {
    this._cache.clear();
  }

  getCacheStats() {
    return {
      size: this._cache.size,
      maxSize: MAX_CACHE_SIZE,
      usageRatio: (this._cache.size / MAX_CACHE_SIZE * 100).toFixed(1) + '%',
      keys: [...this._cache.keys()]
    };
  }
}

const authChecker = new AuthChecker();

module.exports = {
  checkAdmin: (db, openid, options) => authChecker.checkAdmin(db, openid, options),
  checkOwnership: (db, openid, collection, docId) =>
    authChecker.checkOwnership(db, openid, collection, docId),
  clearCache: () => authChecker.clearCache(),
  getCacheStats: () => authChecker.getCacheStats(),
  ADMIN_PERMISSION_KEYS,
  DEFAULT_ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  normalizePermissions,
  getEffectivePermissions,
  hasPermission,
  isSuperLevelRole
};
