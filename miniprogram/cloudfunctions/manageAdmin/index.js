// cloudfunctions/manageAdmin/index.js - 管理员账号管理（增删查 + 解绑微信，管理员权限校验）
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { checkAdmin, clearCache, getEffectivePermissions, isSuperLevelRole, DEFAULT_ADMIN_PERMISSIONS, ADMIN_PERMISSION_KEYS } = require('./utils/auth');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

const ACCOUNT_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_MIN_LENGTH = 6;
const DISPLAY_NAME_MAX_LENGTH = 20;
// update 接口的 role 入参白名单：只有 admin/superadmin 可被手动赋予。
// founder（创始人）只能由 adminLogin 在 SUPER_ACCOUNT 凭据验证通过时写入/升格，
// 任何管理接口都不得把账号设为创始人。
const VALID_ROLES = ['admin', 'superadmin'];

// 创始人账号：由环境变量 SUPER_ACCOUNT 指定，与 adminLogin 使用同一份配置。
// 未配置时退回「所有超管对等」的旧行为 —— 漏配环境变量不应把角色管理整体锁死。
const OWNER_ACCOUNT = (process.env.SUPER_ACCOUNT || '').trim();
const OWNER_ENFORCED = !!OWNER_ACCOUNT;

/**
 * 判断某条管理员文档是否是「创始人」。
 * - role 已升格为 founder（SUPER_ACCOUNT 账号登录后由 adminLogin 写入）；
 * - 兼容升格前的存量文档：SUPER_ACCOUNT 对应的 superadmin 也按创始人对待，
 *   不依赖「登录过一次」的时序。
 * 未配置 SUPER_ACCOUNT 时不存在创始人（role === 'founder' 仍然生效，防手改库）。
 * @param {object|null} adminDoc - admins 集合文档
 * @returns {boolean}
 */
function isFounderAdmin(adminDoc) {
  if (!adminDoc) return false;
  if (adminDoc.role === 'founder') return true;
  if (!OWNER_ENFORCED || adminDoc.role !== 'superadmin') return false;
  return adminDoc.account === OWNER_ACCOUNT;
}

/**
 * 能否调整管理员角色（提升/降级超管）。
 * 配置了 SUPER_ACCOUNT → 仅创始人；未配置 → 所有超管对等（兼容旧部署）。
 * @param {object|null} adminDoc - 调用者的 admins 文档
 * @returns {boolean}
 */
function canManageRoles(adminDoc) {
  if (!OWNER_ENFORCED) return !!(adminDoc && isSuperLevelRole(adminDoc.role));
  return isFounderAdmin(adminDoc);
}

// 权限项中文名：只用于操作日志，让「谁被开了什么」可读。
// key 必须与 utils/auth.js 的 ADMIN_PERMISSION_KEYS 一致。
const PERMISSION_LABELS = {
  ops: '运营看板',
  addCat: '添加新猫',
  photo: '照片管理',
  cat: '猫咪管理',
  notice: '公告管理',
  relation: '关系管理',
  logs: '操作日志',
  catActivity: '猫咪行动分析',
  mediaReview: '内容复核',
  report: '反馈处理'
};

/**
 * 校验并去重权限名单。
 * 与客户端不同：这里**拒绝**未知 key，而不是静默丢弃 —— 保存接口必须让
 * 版本不一致（旧客户端/手写请求）显式失败，避免悄悄把用户刚开的入口又关掉。
 *
 * @returns {{ok: boolean, data?: string[], error?: string}}
 */
function normalizePermissionList(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: '权限参数格式错误' };
  }
  const result = [];
  for (const key of input) {
    if (typeof key !== 'string' || !ADMIN_PERMISSION_KEYS.includes(key)) {
      return { ok: false, error: `无效的权限项: ${String(key)}` };
    }
    if (!result.includes(key)) result.push(key);
  }
  return { ok: true, data: result };
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'&]/g, '');
}

/**
 * 校验并生成管理员密码哈希（scrypt + 独立盐值）
 * @returns {object} { password, salt, hashAlgorithm } 或抛错
 */
function buildPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { password: hash, salt, hashAlgorithm: 'scrypt' };
}

/**
 * 添加管理员（仅超管及以上：超级管理员/创始人）
 */
async function handleAdd({ callerRole, callerOpenid, adminAccount, account, password, displayName }) {
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可添加管理员');
  }

  const cleanAccount = sanitize(account);
  const cleanDisplayName = sanitize(displayName);
  const cleanPassword = password ? password.trim() : '';

  if (!cleanAccount) {
    return fail('请输入登录账号');
  }
  if (!ACCOUNT_REGEX.test(cleanAccount)) {
    return fail('账号仅支持英文、数字和下划线，3-20位');
  }
  if (!cleanPassword) {
    return fail('请输入密码');
  }
  if (cleanPassword.length < PASSWORD_MIN_LENGTH) {
    return fail(`密码至少${PASSWORD_MIN_LENGTH}位`);
  }
  if (cleanPassword.length > 30) {
    return fail('密码最多30位');
  }
  if (cleanDisplayName && cleanDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return fail(`显示名称最多${DISPLAY_NAME_MAX_LENGTH}个字符`);
  }

  const existing = await db.collection(COLLECTIONS.ADMINS)
    .where({ account: cleanAccount })
    .limit(1)
    .get();

  if (existing.data.length > 0) {
    return fail('该账号已存在');
  }

  const finalDisplayName = cleanDisplayName || cleanAccount;

  await db.collection(COLLECTIONS.ADMINS).add({
    data: {
      account: cleanAccount,
      displayName: finalDisplayName,
      ...buildPasswordHash(cleanPassword),
      role: 'admin',
      // 新账号默认只开「添加新猫 / 猫咪管理 / 照片管理」，其余入口由超管
      // 在「管理员管理 → 权限」里按需开放。
      permissions: DEFAULT_ADMIN_PERMISSIONS.slice(),
      createdAt: new Date().toISOString(),
      // createdBy 是身份字段：只认服务端真实 OPENID。
      // 旧实现 `callerOpenid || adminAccount` 会在 OPENID 为空（控制台测试/定时器）时
      // 把客户端可控的 event._adminAccount 写进来，等于让建档人「自称」。
      createdBy: callerOpenid || 'unknown'
    }
  });

  await logOperation(db, callerOpenid, {
    module: 'admin', action: 'create',
    description: `添加管理员: ${finalDisplayName}`,
    result: 'success',
    adminAccount,
    afterData: {
      account: cleanAccount,
      displayName: finalDisplayName,
      role: 'admin',
      permissions: DEFAULT_ADMIN_PERMISSIONS.slice()
    }
  });
  return ok(null, '管理员添加成功');
}

/**
 * 移除管理员（仅超管及以上；不能移除自己、创始人与其他超管）
 */
async function handleRemove({ callerRole, callerAuth, callerOpenid, adminAccount, targetId }) {
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可移除管理员');
  }

  if (!targetId) {
    return fail('缺少管理员ID');
  }

  const target = await db.collection(COLLECTIONS.ADMINS).doc(targetId).get();
  if (!target.data) {
    return fail('管理员不存在');
  }
  // P2-9：旧实现比较 target.openid 与 callerOpenid、target.account 与 _adminAccount。
  // 但 handleAdd 创建的 admin 文档**不含 openid**，第一个子句恒为 false，实际唯一
  // 生效的是**客户端可控**的 _adminAccount——即「不能移除自己」这层保护可被绕过。
  // 改为按文档 _id 比较：callerAuth.adminInfo 是服务端用 OPENID 查出来的文档。
  const callerId = callerAuth && callerAuth.adminInfo && callerAuth.adminInfo._id;
  const isSelf = !!callerId && String(callerId) === String(targetId);
  if (isSelf) {
    return fail('不能移除自己');
  }
  if (isFounderAdmin(target.data)) {
    return fail('创始人账号不可移除');
  }
  if (isSuperLevelRole(target.data.role)) {
    return fail('超级管理员不能直接移除，请先降级为普通管理员');
  }

  await db.collection(COLLECTIONS.ADMINS).doc(targetId).remove();

  await logOperation(db, callerOpenid, {
    module: 'admin', action: 'delete',
    description: `移除管理员: ${target.data.displayName || target.data.account}`,
    result: 'success',
    adminAccount,
    beforeData: { account: target.data.account, displayName: target.data.displayName, role: target.data.role }
  });
  return ok(null, '管理员已移除');
}

/**
 * 角色参数的层级校验（提权/降权是创始人专属动作）。
 * @returns {{ok: boolean, error?: string}}
 */
function validateRoleChange({ role, callerAuth, targetIsFounder }) {
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: `无效的角色值，仅支持: ${VALID_ROLES.join(', ')}` };
  }
  // 角色是提权/降权动作：即使普通管理员拿到了「管理员管理」入口权限，
  // 也只能管理账号本身，绝不能给自己或别人改角色。
  if (!callerAuth || !callerAuth.adminInfo || !isSuperLevelRole(callerAuth.adminInfo.role)) {
    return { ok: false, error: '仅超级管理员可调整管理员角色' };
  }
  // 顶级闸门：配置 SUPER_ACCOUNT 后，只有创始人能调整角色。
  if (!canManageRoles(callerAuth.adminInfo)) {
    return { ok: false, error: '仅创始人可调整管理员角色' };
  }
  if (targetIsFounder) {
    return { ok: false, error: '不能变更创始人账号的角色' };
  }
  return { ok: true };
}

/**
 * 编辑动作的层级校验：非创始人不能修改创始人账号，也不能编辑其他超管。
 * 自己的名字/密码仍可改（角色变更另行拦截）。
 * @returns {string|null} 错误文案；null 表示通过
 */
function getEditLevelError({ callerIsFounder, target, isSelf }) {
  const targetIsFounder = isFounderAdmin(target.data);
  if (targetIsFounder && !callerIsFounder) {
    return '仅创始人可修改创始人账号';
  }
  if (OWNER_ENFORCED && target.data.role === 'superadmin'
      && !targetIsFounder && !isSelf && !callerIsFounder) {
    return '仅创始人可管理其他超级管理员';
  }
  return null;
}

/**
 * 组装修改管理员的 updateData（显示名/密码/角色逐项校验）
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function buildUpdateData({ targetId, displayName, password, role, callerAuth, targetIsFounder }) {
  const updateData = {};

  if (displayName !== undefined) {
    const cleanDisplayName = sanitize(displayName);
    if (!cleanDisplayName) {
      return { ok: false, error: '显示名称不能为空' };
    }
    if (cleanDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
      return { ok: false, error: `显示名称最多${DISPLAY_NAME_MAX_LENGTH}个字符` };
    }
    updateData.displayName = cleanDisplayName;
  }

  if (password !== undefined && password !== '') {
    const cleanPassword = password.trim();
    if (cleanPassword.length < PASSWORD_MIN_LENGTH) {
      return { ok: false, error: `密码至少${PASSWORD_MIN_LENGTH}位` };
    }
    if (cleanPassword.length > 30) {
      return { ok: false, error: '密码最多30位' };
    }
    Object.assign(updateData, buildPasswordHash(cleanPassword));
  }

  if (role !== undefined && role !== '') {
    const roleCheck = validateRoleChange({ role, callerAuth, targetIsFounder });
    if (!roleCheck.ok) {
      return roleCheck;
    }
    // P2-9：同 handleRemove，按文档 _id 判定「是不是自己」，
    // 不再依赖 target.openid（handleAdd 建档时根本不写）与客户端可控的 _adminAccount
    const callerId = callerAuth && callerAuth.adminInfo && callerAuth.adminInfo._id;
    const isSelfRole = !!callerId && String(callerId) === String(targetId);
    if (isSelfRole) {
      return { ok: false, error: '不能变更自己的角色' };
    }
    updateData.role = role;
  }

  return { ok: true, data: updateData };
}

/**
 * 修改管理员（仅超管及以上；不能变更自己的角色）
 */
async function handleUpdate({
  callerRole, callerAuth, callerOpenid, adminAccount, targetId, displayName, password, role
}) {
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可修改管理员');
  }
  if (!targetId) {
    return fail('缺少管理员ID');
  }

  // 目标必须真实存在：doc().update 对不存在的文档是「0 行更新且不抛错」，
  // 不校验会返回「修改成功」但库里什么都没变（列表过期/已被他人移除时必现）
  const target = await db.collection(COLLECTIONS.ADMINS).doc(targetId).get().catch(() => null);
  if (!target || !target.data) {
    return fail('管理员不存在或已被移除');
  }

  const callerAuthDoc = callerAuth && callerAuth.adminInfo;
  const callerIsFounder = isFounderAdmin(callerAuthDoc);
  const targetIsFounder = isFounderAdmin(target.data);
  const callerId = callerAuthDoc && callerAuthDoc._id;
  const isSelf = !!callerId && String(callerId) === String(targetId);

  const levelError = getEditLevelError({ callerIsFounder, target, isSelf });
  if (levelError) {
    return fail(levelError);
  }

  // 密码重置只允许超管及以上：本函数入口已限定 isSuperLevelRole(callerRole)，
  // 普通管理员无论拿到哪些入口权限都无法到达这里。
  const built = await buildUpdateData({
    targetId, displayName, password, role, callerAuth, targetIsFounder
  });
  if (!built.ok) {
    return fail(built.error);
  }

  const updateData = built.data;
  if (Object.keys(updateData).length === 0) {
    return fail('没有要修改的内容');
  }

  await db.collection(COLLECTIONS.ADMINS).doc(targetId).update({ data: updateData });

  const descParts = [];
  if (displayName !== undefined) descParts.push(`显示名称→${sanitize(displayName)}`);
  if (password !== undefined && password !== '') descParts.push('重置密码');
  if (role !== undefined && role !== '') descParts.push(`角色→${role}`);
  // 安全：哈希/盐不入操作日志（任何 admin 可读日志，防止离线爆破）
  const { password: _pw, salt: _salt, ...logSafeData } = updateData;
  await logOperation(db, callerOpenid, {
    module: 'admin', action: 'edit',
    description: `编辑管理员: ${descParts.join(', ')}`,
    result: 'success',
    adminAccount,
    afterData: logSafeData
  });
  return ok(null, '修改成功');
}

/**
 * 解绑微信（仅超管及以上）
 *
 * 背景：服务端鉴权只看 admins.openid，且绑定在首次登录时单向写入、永不自动换绑。
 * 一旦绑定到错误微信（如超管用自己的微信测试子账号）或对方换手机，账号会永久
 * 不可用（登录被拒且无解绑入口）。此操作清除 openid，之后用新微信登录该账号
 * 一次即可重新绑定。
 */
async function handleUnbind({ callerRole, callerAuth, callerOpenid, adminAccount, targetId }) {
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可解绑微信');
  }
  if (!targetId) {
    return fail('缺少管理员ID');
  }

  const target = await db.collection(COLLECTIONS.ADMINS).doc(targetId).get().catch(() => null);
  if (!target || !target.data) {
    return fail('管理员不存在或已被移除');
  }

  // 与 remove / update 同口径：按文档 _id（服务端查出的 callerAuth.adminInfo）判定「是不是自己」
  const callerId = callerAuth && callerAuth.adminInfo && callerAuth.adminInfo._id;
  if (callerId && String(callerId) === String(targetId)) {
    return fail('不能解绑自己的微信');
  }
  if (isFounderAdmin(target.data)) {
    return fail('创始人账号不可解绑');
  }
  if (isSuperLevelRole(target.data.role)) {
    return fail('超级管理员不能直接解绑，请先降级为普通管理员');
  }
  if (!target.data.openid) {
    return fail('该账号尚未绑定微信');
  }

  await db.collection(COLLECTIONS.ADMINS).doc(targetId).update({
    data: { openid: _.remove() }
  });

  await logOperation(db, callerOpenid, {
    module: 'admin', action: 'edit',
    description: `解绑微信: ${target.data.displayName || target.data.account}`,
    result: 'success',
    adminAccount,
    beforeData: { account: target.data.account, displayName: target.data.displayName, boundOpenid: true }
  });
  return ok(null, '已解绑，请使用新的微信登录该账号以完成绑定');
}

/**
 * 调整普通管理员的入口权限（仅超管及以上）
 *
 * 这是提权动作：即使普通管理员拿到了「管理员管理」入口权限，也不能调用，
 * 否则他可以给自己/同伙开放任意入口，等于绕过整个权限模型。
 */
async function handleUpdatePermissions({
  callerRole, callerOpenid, adminAccount, targetId, permissions
}) {
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可调整管理员权限');
  }
  if (!targetId) {
    return fail('缺少管理员ID');
  }

  const target = await db.collection(COLLECTIONS.ADMINS).doc(targetId).get().catch(() => null);
  if (!target || !target.data) {
    return fail('管理员不存在或已被移除');
  }
  if (isSuperLevelRole(target.data.role)) {
    return fail('超级管理员与创始人默认拥有全部权限，无需调整');
  }

  const normalized = normalizePermissionList(permissions);
  if (!normalized.ok) {
    return fail(normalized.error);
  }

  const before = getEffectivePermissions(target.data);
  await db.collection(COLLECTIONS.ADMINS).doc(targetId).update({
    data: { permissions: normalized.data }
  });

  const added = normalized.data.filter((key) => !before.includes(key));
  const removed = before.filter((key) => !normalized.data.includes(key));
  const changes = [];
  if (added.length > 0) changes.push(`开放 ${added.map(k => PERMISSION_LABELS[k] || k).join('、')}`);
  if (removed.length > 0) changes.push(`关闭 ${removed.map(k => PERMISSION_LABELS[k] || k).join('、')}`);

  await logOperation(db, callerOpenid, {
    module: 'admin', action: 'edit',
    description: `调整管理员权限: ${target.data.displayName || target.data.account}${changes.length > 0 ? `（${changes.join('；')}）` : '（无变化）'}`,
    result: 'success',
    adminAccount,
    beforeData: { permissions: before },
    afterData: { permissions: normalized.data }
  });

  return ok({ permissions: normalized.data }, '权限已保存');
}

/**
 * 列出全部管理员（仅管理员）
 */
async function handleList({ callerRole, callerAuth }) {
  if (!callerAuth.isAdmin) {
    return fail('仅管理员可查看管理员列表');
  }
  // 「管理员管理」永远仅超管及以上可用，普通管理员不能读全量账号列表
  if (!isSuperLevelRole(callerRole)) {
    return fail('仅超级管理员可查看管理员列表');
  }

  const res = await db.collection(COLLECTIONS.ADMINS).get();
  const callerId = callerAuth && callerAuth.adminInfo && callerAuth.adminInfo._id;
  const admins = res.data.map(a => ({
    _id: a._id,
    account: a.account || '',
    displayName: a.displayName || a.account || '未知',
    role: a.role || 'admin',
    createdAt: a.createdAt,
    lastLoginTime: a.lastLoginTime,
    // 13 个可授权入口的生效名单（超管/创始人返回全部；历史文档按默认 3 项）。
    // 客户端用它初始化权限弹窗与列表摘要；普通管理员只能看、不能改。
    permissions: getEffectivePermissions(a),
    // 只下发绑定状态布尔值，不下发 openid 原文（管理列表是普通管理员可见的，
    // openid 属敏感身份标识，外泄可被用于伪造/关联攻击）
    boundOpenid: !!a.openid,
    // 客户端据此隐藏「当前登录账号」那一行的编辑/移除入口。
    // 服务端仍按 _id 独立拦截，此字段只用于 UI。
    isSelf: !!callerId && String(a._id) === String(callerId),
    // 创始人为顶级档位：只有它能升降其他超管，且自身不可被降级/移除/解绑。
    isFounder: isFounderAdmin(a)
  }));
  return ok({
    admins,
    callerIsFounder: canManageRoles(callerAuth && callerAuth.adminInfo),
    // 是否启用了「创始人」层级（SUPER_ACCOUNT 已配置）。
    // 未启用时所有超管都能改角色，但不应在界面上自称"创始人"。
    founderEnforced: OWNER_ENFORCED
  });
}

exports.main = async (event) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      /* ignore */
    }
  }
  const { action, targetId, account, password, displayName, role, permissions } = event;
  const wxContext = cloud.getWXContext();
  const callerOpenid = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  try {
    const callerAuth = await checkAdmin(db, callerOpenid, { operation: '管理员管理', useCache: false });
    const callerRole = callerAuth.adminInfo ? callerAuth.adminInfo.role : null;
    const ctx = { callerAuth, callerRole, callerOpenid, adminAccount };

    switch (action) {
      case 'list':
        return handleList(ctx);

      case 'add':
        return handleAdd({ ...ctx, account, password, displayName });

      case 'unbind': {
        const unbindResult = await handleUnbind({ ...ctx, targetId });
        // 权限/绑定变更后清理本实例的鉴权缓存，缩短异常窗口
        clearCache();
        return unbindResult;
      }

      case 'remove': {
        const removeResult = await handleRemove({ ...ctx, targetId });
        // 权限变更后清理本实例的鉴权缓存，缩短被撤销者的可操作窗口
        clearCache();
        return removeResult;
      }

      case 'update': {
        const updateResult = await handleUpdate({ ...ctx, targetId, displayName, password, role });
        clearCache();
        return updateResult;
      }

      case 'updatePermissions': {
        const permResult = await handleUpdatePermissions({ ...ctx, targetId, permissions });
        // 权限变更后清理本实例的鉴权缓存；其他热实例靠 1 分钟 TTL 收敛。
        clearCache();
        return permResult;
      }

      default:
        return fail('未知操作');
    }
  } catch (err) {
    // 异常必须留下可定位信息：这层 catch 兜的是各 handler 之外的意外
    // （db 故障、SDK 行为变更等），只回一句通用文案会让服务端日志一片空白，
    // 与 SECURITY.md §八批评的事故形态完全相同。
    console.error('[manageAdmin] 未预期错误:', err);
    return fail('操作失败，请重试');
  }
};
