/**
 * utils/adminPermissions.js - 管理后台入口权限的唯一事实源（客户端）
 *
 * 10 个可授权入口；「管理员管理」不在此列，永远仅超管及以上（超级管理员/创始人）可用。
 * key 必须与云端 cloudfunctions/utils/auth.js 的 ADMIN_PERMISSION_KEYS 完全一致。
 * 云函数负责真实拦截，本模块只驱动菜单渲染与页面门禁。
 *
 * 角色三档（2026-10）：
 * - founder 创始人：全部入口 + 唯一能升降级管理员角色（由 SUPER_ACCOUNT 环境变量指定）
 * - superadmin 超级管理员：全部入口，恒全量、不可调整
 * - admin 普通管理员：按入口权限授权
 *
 * 默认值口径：
 * - 新建管理员、以及历史文档未写 permissions 字段 → 默认 3 项
 * - 超管/创始人 → 永远全部开放
 *
 * @module adminPermissions
 */

// 顺序与首页菜单一致，便于排查对不上的入口
const ALL_PERMISSIONS = [
  { key: 'ops', label: '运营看板', group: '运营工具' },
  { key: 'addCat', label: '添加新猫', group: '内容维护' },
  { key: 'photo', label: '照片管理', group: '内容维护' },
  { key: 'cat', label: '猫咪管理', group: '内容维护' },
  { key: 'notice', label: '公告管理', group: '发布与互动' },
  { key: 'relation', label: '关系管理', group: '内容维护' },
  { key: 'logs', label: '操作日志', group: '系统与审计' },
  { key: 'catActivity', label: '猫咪行动分析', group: '系统与审计' },
  { key: 'mediaReview', label: '内容复核', group: '运营工具' },
  { key: 'report', label: '反馈处理', group: '运营工具' }
];

// 新建管理员默认开放：添加新猫 / 猫咪管理 / 照片管理
const DEFAULT_PERMISSION_KEYS = ['addCat', 'cat', 'photo'];

const PERMISSION_KEYS = ALL_PERMISSIONS.map((item) => item.key);

const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);

// 弹窗分组顺序（未列出的 key 会落到「其他」）
const PERMISSION_GROUPS = [
  { name: '内容维护', keys: ['addCat', 'cat', 'photo', 'relation'] },
  { name: '运营工具', keys: ['ops', 'mediaReview', 'report'] },
  { name: '发布与互动', keys: ['notice'] },
  { name: '系统与审计', keys: ['logs', 'catActivity'] }
];

const PERMISSION_LABELS = ALL_PERMISSIONS.reduce((map, item) => {
  map[item.key] = item.label;
  return map;
}, {});

/**
 * 归一化权限名单：丢未知 key、去重。
 * 字段不存在时返回默认 3 项；显式空数组保留为空。
 *
 * @param {*} value
 * @returns {string[]}
 */
function normalizePermissionKeys(value) {
  if (!Array.isArray(value)) return DEFAULT_PERMISSION_KEYS.slice();
  const result = [];
  for (const key of value) {
    if (PERMISSION_KEY_SET.has(key) && !result.includes(key)) result.push(key);
  }
  return result;
}

/**
 * 是否合法权限 key
 * @param {string} key
 * @returns {boolean}
 */
function isPermissionKey(key) {
  return PERMISSION_KEY_SET.has(key);
}

/**
 * 权限 key 的中文名
 * @param {string} key
 * @returns {string}
 */
function getPermissionLabel(key) {
  return PERMISSION_LABELS[key] || key;
}

/**
 * 按分组组装开关列表（权限弹窗直接渲染）
 * @param {object} granted - { [key]: boolean }
 * @returns {Array<{name: string, items: Array<{key: string, label: string, checked: boolean}>}>}
 */
function buildPermissionGroups(granted = {}) {
  const used = new Set();
  const groups = PERMISSION_GROUPS.map((group) => {
    const items = [];
    for (const key of group.keys) {
      if (!PERMISSION_KEY_SET.has(key)) continue;
      used.add(key);
      items.push({ key, label: getPermissionLabel(key), checked: !!granted[key] });
    }
    return { name: group.name, items };
  });

  // 兜底：分组表漏登记的新 key 不能让它在 UI 里消失
  const rest = ALL_PERMISSIONS.filter((item) => !used.has(item.key));
  if (rest.length > 0) {
    groups.push({
      name: '其他',
      items: rest.map((item) => ({
        key: item.key,
        label: item.label,
        checked: !!granted[item.key]
      }))
    });
  }
  return groups.filter((group) => group.items.length > 0);
}

module.exports = {
  ALL_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_GROUPS,
  DEFAULT_PERMISSION_KEYS,
  normalizePermissionKeys,
  isPermissionKey,
  getPermissionLabel,
  buildPermissionGroups
};
