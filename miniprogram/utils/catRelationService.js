// utils/catRelationService.js - 猫咪关系类型定义与关系查询
const RELATION_TYPES = {
  mother: { label: '妈妈', color: '#E8927C', colorDark: '#F5A593' },
  father: { label: '爸爸', color: '#E8927C', colorDark: '#F5A593' },
  child: { label: '子女', color: '#7EB5E8', colorDark: '#80C8FF' },
  sibling: { label: '同胞', color: '#7EB5E8', colorDark: '#80C8FF' },
  litter: { label: '同窝', color: '#DDA0DD', colorDark: '#E8A8E8' },
  // 社交关系：与现实里的「朋友 / 敌对」口径一致，两端语义相同，不需要正反向区分
  friend: { label: '朋友', color: '#E8C87E', colorDark: '#F2D79B' },
  hostile: { label: '敌对', color: '#DE7C8D', colorDark: '#EE9AA8' },
  other: { label: '其他', color: '#98D8AA', colorDark: '#80E0A0' }
};

/**
 * 获取当前主题下的关系类型颜色
 * @param {string} key - 关系类型 key
 * @param {string} [theme] - 主题 'light' | 'dark'，不传则自动检测
 * @returns {string} 颜色值
 */
function getRelationColor(key, theme) {
  const type = RELATION_TYPES[key];
  if (!type) return '#999';
  if (!theme) {
    try {
      const app = getApp();
      theme = app && app.globalData && app.globalData.theme || 'light';
    } catch (e) {
      theme = 'light';
    }
  }
  return theme === 'dark' ? type.colorDark || type.color : type.color;
}

/**
 * 关系方向口径（单一事实来源）：
 * 关系记录 (catId=A, relatedCatId=B, type=T) 表示「B 是 A 的 T」——
 * 类型描述的是 relatedCatId 相对 catId 的角色（与用户端「在我的页面选另一只猫 + 类型」的
 * 交互直觉一致：选「妈妈」= 所选猫咪是我的妈妈）。
 *
 * 因此当某只猫处于 toCat 端（relatedCatId）时，展示该关系必须使用反向标签，
 * 否则两端会显示同一文案、语义反一端（历史问题：A 的页面和 B 的页面都显示「妈妈」）。
 */
const REVERSE_LABELS = {
  mother: '子女',
  father: '子女',
  sibling: '同胞',
  litter: '同窝',
  // 朋友 / 敌对 是对称关系：A 是 B 的朋友，B 也是 A 的朋友，反向不改口
  friend: '朋友',
  hostile: '敌对',
  other: '其他'
};

/**
 * 获取关系标签（正向 / 反向）
 * @param {string} type - 关系类型 key
 * @param {object} [options]
 * @param {boolean} [options.isReverse] - true 时返回反向标签（当前猫处于 toCat 端）
 * @param {string} [options.otherGender] - 对方性别（'公'/'母'），仅 child 反向时需要（妈妈/爸爸）
 * @returns {string}
 */
function getRelationLabel(type, options) {
  const opts = options || {};
  const base = RELATION_TYPES[type] || RELATION_TYPES.other;
  if (!opts.isReverse) return base.label;
  // child（B 是 A 的子女）的反向：A 是 B 的妈妈/爸爸，按对方性别判定
  if (type === 'child') {
    if (opts.otherGender === '母') return '妈妈';
    if (opts.otherGender === '公') return '爸爸';
    return '父母';
  }
  return REVERSE_LABELS[type] || base.label;
}

/**
 * 将云函数返回的关系记录归一化为前端统一字段：
 * fromCatId / toCatId / fromCat / toCat / description / relationInfo
 */
function normalizeRelation(rel) {
  return {
    _id: rel._id,
    fromCatId: rel.catId,
    toCatId: rel.relatedCatId,
    fromCat: rel.cat || { _id: rel.catId, name: '未知猫咪' },
    toCat: rel.relatedCat || { _id: rel.relatedCatId, name: '未知猫咪' },
    type: rel.type,
    description: rel.note || '',
    createTime: rel.createTime,
    relationInfo: rel.relationInfo || RELATION_TYPES[rel.type] || RELATION_TYPES.other
  };
}

async function getRelationsByCatId(catId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'catRelation',
      data: { action: 'getByCatId', catId: catId }
    });
    if (res.result && res.result.success) {
      const list = res.result.data || [];
      // 兼容旧版云函数不返回 total 的情况
      const total = typeof res.result.total === 'number' ? res.result.total : list.length;
      return { success: true, data: list.map(normalizeRelation), total };
    }
    return { success: false, error: res.result && res.result.error || '获取关系失败' };
  } catch (err) {
    console.error('获取猫咪关系失败', err);
    return { success: false, error: err.message || '网络错误' };
  }
}

async function addRelation(data) {
  try {
    // 页面使用 fromCatId/toCatId/relationType/description，云函数契约是 catId/relatedCatId/type/note
    const payload = {
      catId: data.catId || data.fromCatId,
      relatedCatId: data.relatedCatId || data.toCatId,
      type: data.type || data.relationType,
      note: data.note !== undefined ? data.note : data.description || ''
    };
    // 读取管理员账号标识
    let adminAccount = data._adminAccount || '';
    if (!adminAccount) {
      try {
        adminAccount = wx.getStorageSync('_adminAccount') || '';
      } catch (e) { /* ignore */ }
    }
    const callData = { action: 'add', data: payload, _adminAccount: adminAccount };
    const res = await wx.cloud.callFunction({
      name: 'catRelation',
      data: callData
    });
    if (res.result && res.result.success) {
      return { success: true, data: res.result.data };
    }
    return { success: false, error: res.result?.error || '添加失败' };
  } catch (err) {
    console.error('添加关系失败', err);
    return { success: false, error: err.message || '网络错误' };
  }
}

/**
 * 修改一条关系的类型 / 备注 / 方向。
 *
 * 管理端按猫聚合展示，同一条关系在双方卡片各出现一次；从哪张卡片点进去，
 * 这句话的主语就是那张卡片的猫。因此调用方传的是**主语视角**的
 * { catId: 主语, relatedCatId: 对方 }，服务端按此重写方向（见云函数 update）。
 *
 * @param {object} data - { id, catId, relatedCatId, type, note }
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateRelation(data) {
  try {
    const payload = data || {};
    const catId = payload.catId || '';
    const relatedCatId = payload.relatedCatId || '';
    const type = payload.type || '';
    const note = payload.note !== undefined ? payload.note : '';
    if (!payload.id) return { success: false, error: '关系ID不能为空' };
    if (!catId || !relatedCatId || !type) {
      return { success: false, error: '关系信息不完整' };
    }
    let adminAccount = '';
    try {
      adminAccount = wx.getStorageSync('_adminAccount') || '';
    } catch (e) { /* ignore */ }
    const res = await wx.cloud.callFunction({
      name: 'catRelation',
      data: {
        action: 'update',
        data: { id: payload.id, catId, relatedCatId, type, note },
        _adminAccount: adminAccount
      }
    });
    if (res.result && res.result.success) {
      return { success: true };
    }
    return { success: false, error: res.result && res.result.error || '保存失败' };
  } catch (err) {
    console.error('修改关系失败', err);
    return { success: false, error: err.message || '网络错误' };
  }
}

async function removeRelation(id) {
  try {
    let adminAccount = '';
    try {
      adminAccount = wx.getStorageSync('_adminAccount') || '';
    } catch (e) { /* ignore */ }
    const res = await wx.cloud.callFunction({
      name: 'catRelation',
      data: { action: 'remove', id, _adminAccount: adminAccount }
    });
    if (res.result && res.result.success) {
      return { success: true };
    }
    return { success: false, error: res.result?.error || '删除失败' };
  } catch (err) {
    console.error('删除关系失败', err);
    return { success: false, error: err.message || '网络错误' };
  }
}

function getRelationTypes() {
  return RELATION_TYPES;
}

/**
 * D2（2026-10-11 定案）：关系类型色板**以云函数为唯一事实源**。
 *
 * 此前色板在两处各写一份：cloudfunctions/catRelation/index.js:13-19 与本文件顶部。
 * 两份当时逐字相同，但客户端这份既没登记进 scripts/managed-modules.js、
 * 磁盘上也没有对应的云函数副本 —— 于是 build-cloud:verify / verify-sync 两道
 * 门禁对它**恒绿**，改一侧漏另一侧会静默漂移，表现为深色模式取色不一致（UX-3）。
 *
 * 定案选「云端为准」而不是「登记为受管 canonical 源」的���因：
 * sync-utils 的分发方向是 cloudfunctions/utils → 各云函数副本，**到不了客户端**；
 * 把客户端文件登记进去也只是形式上的单一来源，实际仍要手工同步两次。
 * 云函数本来就有 getRelationTypes action（index.js 直接 ok(RELATION_TYPES)），
 * 客户端多发一次调用就能拿到权威值 —— 于是本地副本降级为**离线兜底**：
 * 网络不通、云函数报错时仍然有颜色可用（且由测试锁住与云端一致）。
 *
 * 调用方：`pages/admin/relation-manage` 的 onLoad（2026-10-20 补上 —— 此前该函数
 * 没有任何生产调用方，色板实际一直用本地副本，注释里的「云端为准」是空转的）。
 *
 * @returns {Promise<boolean>} 是否成功刷新（失败时保持本地兜底）
 */
async function refreshRelationTypes() {
  try {
    // action 必须是云函数 exports.main 里真实存在的分支名（getRelationTypes）。
    // 曾误写成 getTypes —— 云端没有该分支，恒返回「未知操作」，而本函数静默兜底，
    // 所以从未被发现（色板刷新一直等于没生效）。
    const res = await wx.cloud.callFunction({ name: 'catRelation', data: { action: 'getRelationTypes' } });
    const types = res && res.result && res.result.success && res.result.data;
    if (!types || typeof types !== 'object' || !Object.keys(types).length) return false;
    // 只接受形状正确的条目：云端若返回残缺结构，宁可用兜底也不要写出半份色板
    const valid = Object.keys(types).every(k => types[k] && typeof types[k].color === 'string');
    if (!valid) return false;
    Object.keys(types).forEach(k => {
      RELATION_TYPES[k] = { ...RELATION_TYPES[k], ...types[k] };
    });
    return true;
  } catch (err) {
    // 静默失败是刻意的：色板拿不到不该打扰用户，本地兜底足以渲染
    console.warn('[catRelationService] 色板刷新失败，使用本地兜底', err && err.message);
    return false;
  }
}

module.exports = {
  getRelationsByCatId: getRelationsByCatId,
  addRelation: addRelation,
  updateRelation: updateRelation,
  removeRelation: removeRelation,
  getRelationTypes: getRelationTypes,
  refreshRelationTypes: refreshRelationTypes,
  getRelationColor: getRelationColor,
  getRelationLabel: getRelationLabel,
  RELATION_TYPES: RELATION_TYPES
};
