// pages/admin/relation-manage/relation-manage.js - 管理端：猫咪关系管理页（按猫聚合卡片版）
const catRelationService = require('../../../utils/catRelationService');
const RELATION_TYPES = catRelationService.RELATION_TYPES;
const getRelationLabel = catRelationService.getRelationLabel;
const { requireAdminAuth } = require('../../../utils/adminAuth');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const imageLoader = require('../../../utils/imageLoader');

/** 关系类型分组：血缘 / 同辈 / 社交 / 其他。
 *  列表页按猫聚合后，分组从「选类型的引导」变成「卡片内的信息分区」，
 *  同一只猫的血缘 / 社交关系在卡内各归各区，一眼看全。 */
const TYPE_GROUP_ORDER = [
  { name: '血缘', keys: ['mother', 'father', 'child'] },
  { name: '同辈', keys: ['sibling', 'litter'] },
  // 朋友 / 敌对 不是血缘或同辈，单列一组，避免落进「其他」后和兜底类型混在一起
  { name: '社交', keys: ['friend', 'hostile'] }
];

/** 卡片内分组与筛选段的排序基准：收录组按推荐序，未收录的 key 一律落「其他」 */
const CANONICAL_GROUPS = TYPE_GROUP_ORDER.map(function(g) { return g.name; }).concat(['其他']);

/** 删除后的反悔窗口时长（ms）：够读完一句话 + 点一次撤销，又不至于一直杵在屏幕上 */
const UNDO_TIMEOUT = 6000;

/** 选猫面板每页条数：filterCats 上限 100，取 30 让首屏不用等太久，滚到底再续 */
const PICKER_PAGE_SIZE = 30;

/** 选猫面板搜索防抖（与 cat-picker 同口径） */
const PICKER_SEARCH_DEBOUNCE = 300;

/** 全量拉取的页数上限（每页 100 条）。聚合视图必须拿全量才能按猫分组，
 *  超过 1000 条时截断并提示 —— 静默截断会让「第 1001 条关系」永远不出现。 */
const MAX_PAGES = 10;

/**
 * 查询参数解码（对已解码值再跑一次 decodeURIComponent 会抛 URIError）。
 *
 * 小程序对 navigateTo 的 query 存在两种行为：部分基础库已经解码、部分版本原样透传，
 * 同一份代码在真机与开发者工具上表现可能不同。这里统一兜一层：
 * 解不出来就原样返回，绝不让一个查询参数把整个 onLoad 带崩。
 *
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  // undefined/null 会让 decodeURIComponent 返回字符串 'undefined'/'null'，
  // 那正好是「把没传的参数变成一个叫 undefined 的猫名」。先挡掉空值。
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return String(value);
  }
}

// safeDecode / inverseType 不是页面方法，但这两条口径值得有单测；
// 挂到 module.exports 上暴露，避免为测纯函数而把它们混进 Page 的实例方法里。
module.exports = { safeDecode, inverseType };

/** 类型 key → 分组名（未收录的 key 兜底「其他」，与 buildTypeGroups 的兜底口径一致） */
function groupOfKey(key) {
  for (let i = 0; i < TYPE_GROUP_ORDER.length; i++) {
    if (TYPE_GROUP_ORDER[i].keys.indexOf(key) >= 0) return TYPE_GROUP_ORDER[i].name;
  }
  return '其他';
}

/**
 * 按语义分组当前全部关系类型（模块级函数：data 初始化与运行时刷新共用）
 * @returns {Array<{name: string, items: Array<{key: string, label: string, color: string}>}>}
 */
function buildTypeGroups() {
  const all = Object.keys(RELATION_TYPES);
  const used = {};
  const groups = TYPE_GROUP_ORDER.map(function(g) {
    const keys = g.keys.filter(function(k) { return all.indexOf(k) >= 0; });
    keys.forEach(function(k) { used[k] = true; });
    return { name: g.name, keys: keys };
  });
  const rest = all.filter(function(k) { return !used[k]; });
  if (rest.length) groups.push({ name: '其他', keys: rest });

  return groups
    .filter(function(g) { return g.keys.length > 0; })
    .map(function(g) {
      return {
        name: g.name,
        items: g.keys.map(function(k) {
          return { key: k, label: RELATION_TYPES[k].label, color: RELATION_TYPES[k].color };
        })
      };
    });
}

/** 添加面板的类型平铺列表：分组展平成一行序（血缘→同辈→社交→其他），
 *  面板里按 2 行 × 4 个网格摆开 —— 分组语义靠各类型固有配色保留，不再占 4 行组名。 */
function buildFlatTypes() {
  return buildTypeGroups().reduce(function(acc, g) { return acc.concat(g.items); }, []);
}

/**
 * 面板默认选中的关系类型。
 * 原实现硬编码 'other'：一旦类型表里没有这一项（云端类型表可被合并覆盖），
 * 面板就停在一个不存在的类型上 —— 预览条显示原始 key、提交必被云端拒绝。
 * 这里取「优先 other，取不到就用推荐顺序里的第一个类型」，保证开面板必是合法类型。
 * （兜底不取「其他」组：那一组装的是未收录杂项，语义上不该成为默认值。）
 * @returns {string}
 */
function defaultRelationType() {
  if (RELATION_TYPES.other) return 'other';
  const groups = buildTypeGroups();
  const firstGroup = groups[0];
  return firstGroup && firstGroup.items[0] && firstGroup.items[0].key || 'other';
}

/**
 * 把「对方是这只猫的 T」翻成「这只猫是对方的 T'」。
 *
 * 管理端按猫聚合，同一条关系在双方卡片各出现一次；点反向卡片的 chip 时，
 * 编辑面板的主语是那张卡片的猫，预设类型必须换成反过来的那种（否则一进面板
 * 就看到一个和自己刚才读到的句子对不上的类型）。
 *   - 妈妈 / 爸爸 → 子女
 *   - 子女 → 妈妈 / 爸爸（取决于**对方**的性别；性别未知时无法反推，返回 null）
 *   - 同胞 / 同窝 / 朋友 / 敌对 / 其他 → 对称，原样返回
 *
 * @param {string} type - 记录里的正向类型（对方是 catId 的 T）
 * @param {string} [otherGender] - 记录里 catId（反向后成为对方）的性别
 * @returns {string|null} 反推后的类型；无法反推时返回 null，调用方回退到记录方向
 */
function inverseType(type, otherGender) {
  if (type === 'mother' || type === 'father') return 'child';
  if (type === 'child') {
    if (otherGender === '母') return 'mother';
    if (otherGender === '公') return 'father';
    return null;
  }
  return RELATION_TYPES[type] ? type : null;
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],
  data: {
    statusBarHeight: 0,
    // 胶囊安全边距（px）：导航栏右侧必须让开系统胶囊，否则动作按钮会被完全盖住
    menuSafeRight: 32,
    loading: true,
    // 加载失败必须是独立状态：否则 catch 后列表保持空数组，
    // wxml 会把「加载失败」渲染成「暂无关系记录」，管理员误以为库里没数据
    loadFailed: false,
    // 增量刷新的细提示（增删改后的重查不再刷整屏骨架）
    refreshing: false,
    // ===== 聚合视图 =====
    // cards：当前筛选下的猫卡片（_cardsBase 过滤而来，单一数据源在实例侧）
    cards: [],
    segments: [],
    activeSegment: 'all',
    searchKeyword: '',
    statsText: '',
    // 全库一条关系都没有（区别于「筛选后为空」）
    hasNoRelations: false,
    // 卡片跳转定位：scroll-into-view 目标 + 一次性高亮
    scrollIntoView: '',
    flashCatId: '',
    // 删除后的撤销条（同一时刻只有一条）
    undoBar: null,
    // ===== 添加面板 =====
    panelScrollTop: 0,
    focusTokenA: 0,
    showAddPanel: false,
    addForm: {
      catId: '',
      // 对方猫可以一次选多只：一窝 4 只猫的关系是 6 条，逐条走完整流程不现实
      relatedCatIds: [],
      type: defaultRelationType(),
      note: ''
    },
    // 选猫器的已选回执（含头像 / 花色），与 addForm 的 id 并存：
    // id 用于提交，对象用于渲染，避免每次重查猫咪详情
    catAObj: null,
    catAName: '',
    // 已选的「对方猫」：chips 渲染 + 批次提交
    pickedCats: [],
    catBSummary: '',
    // 方向预览条：「{A} 的 {类型} 是 {B...}」，随选择实时刷新
    addFormTypeLabel: '其他',
    addFormTypeColor: '',
    // 刚提交成功的一批提示（面板不关，方便接着加下一种关系）
    addSuccessText: '',
    canSubmit: false,
    flatTypes: buildFlatTypes(),
    submitting: false,
    // ===== 选猫面板（多选） =====
    showCatPicker: false,
    pickerKeyword: '',
    pickerOptions: [],
    pickerSelected: [],
    pickerLoading: false,
    pickerPage: 0,
    pickerHasMore: false,
    pickerTotal: 0,
    // ===== 编辑一条关系 =====
    showEditPanel: false,
    // { relId, subjectId, subjectName, objectId, objectName }
    editRel: null,
    editForm: { type: '', note: '' },
    editTypeLabel: '',
    editTypeColor: '',
    // 性别未知时无法反推「妈妈/爸爸」，回退到记录方向时的说明
    editDirNote: '',
    editSaving: false
  },

  onLoad: async function(options) {
    const sysInfo = wx.getWindowInfo();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight || 0,
      menuSafeRight: this._getMenuSafeRight(sysInfo),
      // RELATION_TYPES 可能已被 catRelationService 用云端类型刷新过，平铺序要跟着重建
      flatTypes: buildFlatTypes()
    });
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败必须先解除 loading：否则「加载中」常驻 1.5s，
      // 且 goBack 在页面栈深为 1 时会退不动 → 永久卡在加载态、没有任何出口。
      // 口径同 photo-manage.js:40 / album-detail.js:57
      this.safeSetData({ loading: false });
      // 用 adminBehavior.goBack() 而非裸 navigateBack：栈深 1 时它会兜底 redirectTo 首页
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('relation', '关系管理')) {
      this.safeSetData({ loading: false });
      return;
    }
    // D2（2026-10-11 定案）：关系类型色板以云函数为唯一事实源，本地副本只是离线兜底。
    // 不 await：管理员页不该为一次色板刷新卡住列表；失败时服务内部静默兜底。
    catRelationService.refreshRelationTypes().then((refreshed) => {
      if (!refreshed) return;
      this.safeSetData({ flatTypes: buildFlatTypes() });
      // 已加载过的话，标签 / 配色可能随类型表变化，聚合结果要重建
      if (this._hasLoaded) {
        this._aggregate();
        this._applyFilters();
      }
      this._syncAddPanelMeta();
    }).catch(() => {});
    // 从猫详情页「管理这段关系」进来：加载完成后定位到这只猫的卡片并高亮；
    // 这只猫还没有任何关系（没有卡片）时，维持老入口行为 —— 直接开面板并预填基准猫。
    const entryId = options && options.catId ? String(options.catId) : '';
    this._entryCat = entryId ? { id: entryId, name: options.catName ? safeDecode(options.catName) : '' } : null;
    this.reloadAll();
  },

  /**
   * 预填添加面板的「基准猫咪」（详情页入口且这只猫没有关系卡片时使用；
   * 卡片上的「＋ 添加」入口直接用卡片现成的档案字段，不走网络）。
   *
   * @param {string} catId
   * @param {string} [catName] - URL 带来的名字，作为档案请求失败的兜底
   * @returns {Promise<void>}
   */
  _prefillBaseCat: async function(catId, catName) {
    let cat = null;
    try {
      const res = await wx.cloud.callFunction({ name: 'getCatDetail', data: { catId: catId } });
      if (res.result && res.result.success) {
        const data = res.result.data || {};
        const raw = data.cat || res.result.cat;
        if (raw && raw._id) cat = raw;
      }
    } catch (err) {
      Logger.warn('relation-manage', '预填基准猫档案失败', { error: err.message });
    }

    const name = cat && cat.name || catName || '未知';
    const brief = {
      _id: catId,
      name: name,
      color: cat && cat.color || '',
      avatar: cat && cat.avatar || '',
      initialName: name.charAt(0)
    };
    if (brief.avatar.indexOf('cloud://') === 0) {
      try {
        const urlMap = await imageLoader.getTempUrls([brief.avatar], { optimizeType: 'avatar' });
        brief.avatar = urlMap[brief.avatar] || brief.avatar;
      } catch (e) { /* 头像转链失败不影响预填本身 */ }
    }

    this.setData({
      showAddPanel: true,
      addForm: { ...this.data.addForm, catId: brief._id, relatedCatIds: [], note: '' },
      catAObj: brief,
      catAName: brief.name,
      pickedCats: [],
      catBSummary: '',
      addSuccessText: '',
      submitting: false
    });
    this._syncAddPanelMeta();
  },

  onUnload: function() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
    // 撤销条自动消失定时器
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    // 卡片高亮的自动消退定时器
    if (this._flashTimer) { clearTimeout(this._flashTimer); this._flashTimer = null; }
    // 选猫面板的搜索防抖
    if (this._pickerTimer) { clearTimeout(this._pickerTimer); this._pickerTimer = null; }
  },

  onPullDownRefresh: function() {
    this.reloadAll().then(function() {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 导航栏右侧安全边距（px）。
   * @param {object} [sysInfo] - 复用 onLoad 已取到的 getWindowInfo 结果
   * @returns {number} padding-right 的 px 值
   */
  _getMenuSafeRight: function(sysInfo) {
    try {
      const info = sysInfo || wx.getWindowInfo();
      if (!wx.getMenuButtonBoundingClientRect) return 32;
      const rect = wx.getMenuButtonBoundingClientRect();
      if (!rect || !rect.left || !info || !info.windowWidth) return 32;
      return Math.round(info.windowWidth - rect.left + 8);
    } catch (e) {
      return 32;
    }
  },

  /** 空实现：面板用 catchtap 阻止冒泡，必须有同名方法，否则控制台每次点击都报
   *  "does not have a method stopProp" 警告。 */
  stopProp: function() {},

  /**
   * 把列表里指定字段上的裸 cloud:// fileID 批量转成 avatar 档位临时链接。
   * @param {Array<Object>} list - 待处理列表
   * @param {string[]} fields - 需要转链的字段名
   * @returns {Promise<Array<Object>>} 转链后的新列表（无 cloud:// 字段时原样返回）
   */
  async _resolveAvatarFields(list, fields) {
    const ids = [];
    list.forEach(item => fields.forEach(f => {
      const value = item && item[f];
      if (typeof value === 'string' && value.startsWith('cloud://')) ids.push(value);
    }));
    if (ids.length === 0) return list;

    const urlMap = await imageLoader.getTempUrls(ids, { optimizeType: 'avatar' });
    return list.map(item => {
      const patch = {};
      fields.forEach(f => {
        if (urlMap[item[f]]) patch[f] = urlMap[item[f]];
      });
      return Object.keys(patch).length > 0 ? { ...item, ...patch } : item;
    });
  },

  /**
   * 全量拉取关系并重建聚合视图。
   *
   * 按猫聚合必须拿到**全量**关系（分页只到第 1 页会出现「猫卡片缺了半截关系」），
   * 这里循环拉到 hasMore 为止（上限 MAX_PAGES）。关系量级是几十条，
   * 通常 1 页就结束；搜索 / 筛选全部转为客户端过滤，不再每击键打一次云函数。
   *
   * @returns {Promise<void>}
   */
  reloadAll: function() {
    const that = this;
    // 请求序号：并发重查时丢弃在途旧响应，防止慢响应覆盖新结果
    const seq = (this._querySeq || 0) + 1;
    this._querySeq = seq;
    const isFirstLoad = !this._hasLoaded;
    this.setData(isFirstLoad ? { loading: true } : { refreshing: true });

    return (async function() {
      let all = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await that.callAdminFunction('catRelation', {
          action: 'listAll', page: page, pageSize: 100
        });
        if (seq !== that._querySeq) return null;
        if (!res.result || !res.result.success) {
          throw new Error(res.result && res.result.error || '加载失败');
        }
        const data = res.result.data || res.result;
        const rows = data.relations || [];
        all = all.concat(rows);
        if (data.hasMore !== true) break;
      }
      const resolved = await that._resolveAvatarFields(all, ['catAvatar', 'relatedCatAvatar']);
      if (seq !== that._querySeq) return null;
      return resolved;
    })().then(function(resolved) {
      if (resolved === null) return;
      that._relations = resolved;
      that._aggregate();
      that._applyFilters();
      that._hasLoaded = true;
      that.safeSetData({ loading: false, refreshing: false, loadFailed: false });
      if (allOverLimit(that._relations)) {
        // 上限兜底要说破：不说破就成了「明明加了关系却搜不到」的死胡同
        wx.showToast({ title: '关系超过 ' + MAX_PAGES * 100 + ' 条，仅显示前 ' + MAX_PAGES * 100 + ' 条', icon: 'none', duration: 2500 });
      }
      that._handleEntry();
    }).catch(function(err) {
      if (seq !== that._querySeq) return;
      Logger.error('relation-manage', '加载关系失败', err);
      // 已加载过一次后失败：保留现有卡片只提示，不把页面刷成失败态
      that.safeSetData({
        loading: false,
        refreshing: false,
        loadFailed: !that._hasLoaded
      });
      ErrorHandler.handle(err, { title: '加载失败' });
    });
  },

  /**
   * 把平铺的关系记录聚合成「一猫一卡」。
   * 每条关系 (a=A, b=B, type=T → B 是 A 的 T) 同时落进两张卡：
   *   A 卡上 B 的角色 = 正向标签；B 卡上 A 的角色 = 反向标签（child 按对方性别显示妈妈/爸爸）。
   * raw 行留在实例字段 _relations（撤销快照 / 删除定位用），不进 data。
   */
  _aggregate: function() {
    const rels = this._relations || [];
    const cardsMap = {};
    const touchCard = function(catId, name, color, avatar) {
      if (!cardsMap[catId]) {
        cardsMap[catId] = {
          catId: catId,
          name: name || '未知',
          color: color || '',
          avatar: avatar || '',
          initialName: (name || '未知').charAt(0),
          chipsByGroup: {},
          count: 0,
          lastTime: 0
        };
      }
      return cardsMap[catId];
    };

    rels.forEach(function(rel) {
      const meta = RELATION_TYPES[rel.type] || {};
      const color = rel.typeColor || meta.color || '';
      const group = groupOfKey(rel.type);
      const ts = new Date(rel.createTime).getTime() || 0;

      const cardA = touchCard(rel.catId, rel.catName, rel.catColor, rel.catAvatar);
      (cardA.chipsByGroup[group] = cardA.chipsByGroup[group] || []).push({
        relId: rel._id,
        otherId: rel.relatedCatId,
        otherName: rel.relatedCatName || '未知',
        label: getRelationLabel(rel.type),
        color: color
      });
      cardA.count += 1;
      cardA.lastTime = Math.max(cardA.lastTime, ts);

      const cardB = touchCard(rel.relatedCatId, rel.relatedCatName, rel.relatedCatColor, rel.relatedCatAvatar);
      (cardB.chipsByGroup[group] = cardB.chipsByGroup[group] || []).push({
        relId: rel._id,
        otherId: rel.catId,
        otherName: rel.catName || '未知',
        // B 卡视角：A 相对 B 的角色是反向（isReverse 语义见 catRelationService.getRelationLabel）
        label: getRelationLabel(rel.type, { isReverse: true, otherGender: rel.catGender }),
        color: color
      });
      cardB.count += 1;
      cardB.lastTime = Math.max(cardB.lastTime, ts);
    });

    // 卡内分组按 推荐序（血缘→同辈→社交→其他）排列；实际出现的分组集合以数据为准
    const usedNames = [];
    Object.keys(cardsMap).forEach(function(id) {
      Object.keys(cardsMap[id].chipsByGroup).forEach(function(name) {
        if (usedNames.indexOf(name) < 0) usedNames.push(name);
      });
    });
    usedNames.sort(function(a, b) {
      const ia = CANONICAL_GROUPS.indexOf(a); const ia2 = ia < 0 ? 99 : ia;
      const ib = CANONICAL_GROUPS.indexOf(b); const ib2 = ib < 0 ? 99 : ib;
      return ia2 - ib2;
    });

    const cards = Object.keys(cardsMap).map(function(id) {
      const c = cardsMap[id];
      const groups = usedNames
        .filter(function(name) { return c.chipsByGroup[name] && c.chipsByGroup[name].length > 0; })
        .map(function(name) { return { name: name, chips: c.chipsByGroup[name] }; });
      return {
        catId: c.catId, name: c.name, color: c.color, avatar: c.avatar,
        initialName: c.initialName, count: c.count, lastTime: c.lastTime, groups: groups
      };
    }).sort(function(a, b) {
      // 关系多的猫靠前（管理频率高）；同数按最近变动；再同名次按名字稳定排
      return b.count - a.count || b.lastTime - a.lastTime || (a.name > b.name ? 1 : -1);
    });

    // 分组段（带计数）：只保留有卡片的组，不出死入口
    const segments = [{ key: 'all', label: '全部', count: cards.length }];
    usedNames.forEach(function(name) {
      const count = cards.filter(function(c) {
        return c.groups.some(function(g) { return g.name === name; });
      }).length;
      if (count > 0) segments.push({ key: name, label: name, count: count });
    });

    this._cardsBase = cards;
    this.safeSetData({
      segments: segments,
      statsText: cards.length + ' 只猫 · ' + rels.length + ' 条关系',
      hasNoRelations: rels.length === 0
    });
  },

  /** 按搜索词（猫名 / 花色）+ 分组段过滤卡片（纯客户端，无网络请求） */
  _applyFilters: function() {
    const kw = (this.data.searchKeyword || '').trim().toLowerCase();
    const seg = this.data.activeSegment || 'all';
    const cards = (this._cardsBase || []).filter(function(c) {
      if (seg !== 'all' && !c.groups.some(function(g) { return g.name === seg; })) return false;
      if (!kw) return true;
      return (c.name || '').toLowerCase().indexOf(kw) >= 0 ||
        (c.color || '').toLowerCase().indexOf(kw) >= 0;
    });
    this.safeSetData({ cards: cards });
  },

  /** 详情页入口的落地处理：有卡片 → 定位高亮；没有（这只猫还没有关系）→ 开面板预填 */
  _handleEntry: function() {
    const entry = this._entryCat;
    if (!entry || !entry.id) return;
    this._entryCat = null;
    const card = (this._cardsBase || []).some(function(c) { return c.catId === entry.id; });
    if (!card) {
      this._prefillBaseCat(entry.id, entry.name);
      return;
    }
    // 先复位筛选（入口猫可能被搜索词 / 分组段滤掉），再滚动定位 + 高亮
    this.setData({ searchKeyword: '', activeSegment: 'all' });
    this._applyFilters();
    this._flashCard(entry.id);
  },

  /** 滚动定位到某张卡片并短暂高亮（chip 跳转 / 详情页入口共用） */
  _flashCard: function(catId) {
    const that = this;
    this.safeSetData({ scrollIntoView: '' });
    wx.nextTick(function() {
      that.safeSetData({ scrollIntoView: 'card-' + catId, flashCatId: catId });
      if (that._flashTimer) clearTimeout(that._flashTimer);
      that._flashTimer = setTimeout(function() {
        that.safeSetData({ flashCatId: '' });
      }, 1400);
    });
  },

  onRetryLoad: function() {
    this.reloadAll();
  },

  /** 搜索输入：聚合视图下是纯客户端过滤，直接生效（无防抖、无云调用） */
  onSearchInput: function(e) {
    this.setData({ searchKeyword: e.detail.value });
    this._applyFilters();
  },

  onClearSearch: function() {
    this.setData({ searchKeyword: '' });
    this._applyFilters();
  },

  /** 切换分组段（全部 / 血缘 / 同辈 / 社交 / 其他） */
  onFilterSegment: function(e) {
    const key = e.currentTarget.dataset.seg;
    if (!key || key === this.data.activeSegment) return;
    this.setData({ activeSegment: key });
    this._applyFilters();
  },

  /** 复位搜索词与分组段（筛选空态的 CTA） */
  onClearFilters: function() {
    this.setData({ searchKeyword: '', activeSegment: 'all' });
    this._applyFilters();
  },

  /** 点卡片头部的猫：跳该猫详情 */
  onCatTap: function(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  // ===== 删除 / 撤销 =====

  /**
   * 删除一条关系（chip 上的 ×）。
   * 不再弹确认框：撤销条就是安全网（6 秒内可原样恢复），少一步就是少一次打断；
   * 服务端有双向查重，「撤销时期间又建了同一条」会被自然挡住。
   */
  onDeleteChip: function(e) {
    // 防重入锁：快速双击会发两次 removeRelation，第二次因「记录已不存在」误报失败
    if (this._deleting) return;
    const id = e.currentTarget.dataset.id;
    const that = this;
    // 先抓撤销快照：恢复只能靠记录本身，删完就从列表里找不回来了
    const snapshot = (this._relations || []).find(function(r) { return r._id === id; });

    this._deleting = true;
    wx.showLoading({ title: '删除中…', mask: true });
    catRelationService.removeRelation(id).then(function(result) {
      wx.hideLoading();
      if (result.success) {
        wx.showToast({ title: '已删除', icon: 'success' });
        if (snapshot) that._showUndoBar(snapshot);
        that.reloadAll();
      } else {
        wx.showToast({ title: result.error || '删除失败', icon: 'none' });
      }
    }).catch(function() {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    }).finally(function() {
      that._deleting = false;
    });
  },

  /**
   * 弹出撤销条。语义与系统 snackbar 对齐：**同一时刻只有一条**，连删两条时后一条
   * 覆盖前一条（不做队列，避免管理员对着已经过期的状态点「撤销」）。
   * @param {Object} snapshot - 删除前的完整记录
   */
  _showUndoBar: function(snapshot) {
    if (this._undoTimer) clearTimeout(this._undoTimer);
    this.safeSetData({
      undoBar: {
        catId: snapshot.catId,
        relatedCatId: snapshot.relatedCatId,
        type: snapshot.type,
        note: snapshot.note || '',
        catName: snapshot.catName || '',
        relatedCatName: snapshot.relatedCatName || ''
      }
    });
    this._undoTimer = setTimeout(() => this.safeSetData({ undoBar: null }), UNDO_TIMEOUT);
  },

  /** 撤销删除 = 用同一份字段重新建立关系；服务端有重复校验，挡住「期间又建了一条」 */
  onUndoDelete: function() {
    const bar = this.data.undoBar;
    if (!bar || this._undoing) return;
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    const that = this;
    this._undoing = true;
    this.safeSetData({ undoBar: null });
    wx.showLoading({ title: '恢复中…', mask: true });
    catRelationService.addRelation({
      catId: bar.catId,
      relatedCatId: bar.relatedCatId,
      type: bar.type,
      note: bar.note
    }).then(function(res) {
      wx.hideLoading();
      if (res.success) {
        wx.showToast({ title: '关系已恢复', icon: 'success' });
      } else {
        wx.showToast({ title: res.error || '恢复失败', icon: 'none' });
      }
      that.reloadAll();
    }).catch(function() {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    }).finally(function() {
      that._undoing = false;
    });
  },

  onDismissUndo: function() {
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    this.setData({ undoBar: null });
  },

  // ===== 添加面板 =====

  /** 刷新方向预览条与提交按钮可用态 */
  _syncAddPanelMeta: function() {
    const form = this.data.addForm;
    // 三级兜底：RELATION_TYPES 由云端类型表合并而来，兜底键 'other' 一旦缺失，
    // 这里会直接抛 TypeError 把整个面板废掉（提交按钮永远不可用）
    const meta = RELATION_TYPES[form.type] || RELATION_TYPES.other || { label: '其他', color: '' };
    const ids = form.relatedCatIds || [];
    const names = (this.data.pickedCats || []).map(function(c) { return c.name; });
    this.setData({
      addFormTypeLabel: meta.label,
      addFormTypeColor: meta.color,
      // 预览条里把这一批对方猫都念出来；名字太长由 CSS 截断
      catBSummary: names.join('、'),
      canSubmit: !!(form.catId && ids.length) && !this.data.submitting
    });
  },

  /**
   * 打开添加面板。
   * data-cat-id 存在时（猫卡片上的「＋ 添加」）：基准猫直接用卡片现成档案预填，
   * 管理员点完按钮只剩「选类型 + 选对方猫」两件事。
   */
  onOpenAddPanel: function(e) {
    const catId = e && e.currentTarget && e.currentTarget.dataset.catId || '';
    let brief = null;
    if (catId) {
      const card = (this._cardsBase || []).find(function(c) { return c.catId === catId; });
      if (card) {
        brief = {
          _id: card.catId,
          name: card.name,
          color: card.color,
          avatar: card.avatar,
          initialName: card.initialName
        };
      }
    }
    // 选猫面板的跨页选择缓存：关面板即作废，避免把上一轮的选择带进新一批
    this._pickerSeq = (this._pickerSeq || 0) + 1;
    this.setData({
      showAddPanel: true,
      addForm: { catId: brief ? brief._id : '', relatedCatIds: [], type: defaultRelationType(), note: '' },
      catAObj: brief,
      catAName: brief ? brief.name : '',
      pickedCats: [],
      catBSummary: '',
      addSuccessText: '',
      submitting: false,
      // 每次开面板都要回到顶部：上一次可能已经滚到最下面，直接打开会看到半截内容
      panelScrollTop: 0
    });
    this._syncAddPanelMeta();
  },

  onCloseAddPanel: function() {
    this.setData({ showAddPanel: false });
  },

  onSelectType: function(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ 'addForm.type': type, addSuccessText: '' });
    this._syncAddPanelMeta();
  },

  onNoteInput: function(e) {
    this.setData({ 'addForm.note': e.detail.value });
  },

  onPickCatA: function(e) {
    const cat = e.detail.cat;
    // 换基准猫 = 换主语：之前选的对方猫不再属于这个出发点，留着只会误提交
    this.setData({
      'addForm.catId': cat._id,
      catAObj: cat,
      catAName: cat.name,
      'addForm.relatedCatIds': [],
      pickedCats: [],
      catBSummary: '',
      // 备注属于上一组猫（同一窝 / 同一段经历），换主语后不能顺手带过去
      'addForm.note': '',
      addSuccessText: ''
    });
    this._syncAddPanelMeta();
  },

  onClearCatA: function() {
    this.setData({
      'addForm.catId': '',
      catAObj: null,
      catAName: '',
      'addForm.relatedCatIds': [],
      pickedCats: [],
      catBSummary: '',
      'addForm.note': ''
    });
    this._syncAddPanelMeta();
  },

  /**
   * 点预览条里的基准猫 → 清空已选并聚焦选猫器。
   * 令牌必须自增（Boolean 型 focus 第二次就失效），而反复点击正是这里的核心交互。
   */
  onEditCatA: function() {
    if (this.data.addForm.catId) this.onClearCatA();
    this.setData({ panelScrollTop: 0, focusTokenA: this.data.focusTokenA + 1 });
  },

  /**
   * 基准猫已经建过关系的对方 id 集合。
   *
   * 服务端对同一对猫只允许一条关系（与类型无关），所以这里提前拦掉：
   * 选猫面板里置灰标「已有关系」，不让管理员点完一整轮才收到「该关系已存在」。
   *
   * @param {string} catId
   * @returns {Object<string, boolean>}
   */
  _relatedIdsOf: function(catId) {
    const map = {};
    if (!catId) return map;
    (this._relations || []).forEach(function(rel) {
      if (rel.catId === catId) map[rel.relatedCatId] = true;
      else if (rel.relatedCatId === catId) map[rel.catId] = true;
    });
    return map;
  },

  // ===== 选猫面板（多选） =====

  /** 打开多选面板：先算出基准猫的既有关系，避免选到注定失败的那几只 */
  onOpenCatPicker: function() {
    if (!this.data.addForm.catId) {
      // 没主语就选不了「对方」：提示的同时把焦点送回基准猫，而不是让用户自己找
      wx.showToast({ title: '请先选择基准猫咪', icon: 'none' });
      this.onEditCatA();
      return;
    }
    this._existingOfBase = this._relatedIdsOf(this.data.addForm.catId);
    // 中途换过基准猫时，旧选择里可能有「已有关系」的，提交前就剔掉
    const existing = this._existingOfBase;
    const selected = (this.data.addForm.relatedCatIds || []).filter(function(id) { return !existing[id]; });
    // 缓存里先放进已选的猫：重开面板后直接点确定，不能把上一轮选的人弄丢
    this._pickerCatMap = {};
    const that = this;
    (this.data.pickedCats || []).forEach(function(c) { that._pickerCatMap[c._id] = c; });
    this.setData({
      showCatPicker: true,
      pickerKeyword: '',
      pickerSelected: selected,
      pickerOptions: [],
      pickerPage: 0,
      pickerHasMore: false,
      pickerTotal: 0,
      addSuccessText: ''
    });
    this._loadPicker(true);
  },

  onCloseCatPicker: function() {
    if (this._pickerTimer) { clearTimeout(this._pickerTimer); this._pickerTimer = null; }
    // 作废在途请求：关掉面板后慢响应回来会往已关闭的面板里写数据
    this._pickerSeq = (this._pickerSeq || 0) + 1;
    this.setData({ showCatPicker: false });
  },

  /**
   * 拉取一页猫咪（搜索 / 浏览共用 filterCats：关键词可空、支持分页、无频率限制）。
   * @param {boolean} reset - true 从第 1 页重来，false 续下一页
   * @returns {Promise<void>}
   */
  _loadPicker: function(reset) {
    const that = this;
    const seq = (this._pickerSeq || 0) + 1;
    this._pickerSeq = seq;
    const nextPage = reset ? 1 : this.data.pickerPage + 1;
    this.setData(reset
      ? { pickerLoading: true, pickerOptions: [], pickerPage: 0, pickerHasMore: false, pickerTotal: 0 }
      : { pickerLoading: true });

    const keyword = (this.data.pickerKeyword || '').trim();
    const filters = { page: nextPage, pageSize: PICKER_PAGE_SIZE };
    if (keyword) filters.keyword = keyword;

    return wx.cloud.callFunction({ name: 'filterCats', data: { filters: filters } })
      .then(function(res) {
        if (seq !== that._pickerSeq) return null;
        const result = res && res.result;
        if (!result || !result.success) {
          throw new Error(result && result.error || '加载猫咪失败');
        }
        const data = result.data || result;
        return that._resolveAvatarFields(data.cats || [], ['avatar']).then(function(cats) {
          if (seq !== that._pickerSeq) return null;
          const baseId = that.data.addForm.catId;
          const existing = that._existingOfBase || {};
          const selected = that.data.pickerSelected || [];
          const map = that._pickerCatMap || (that._pickerCatMap = {});
          const options = cats
            .filter(function(c) { return c._id !== baseId; })
            .map(function(c) {
              const id = c._id;
              map[id] = c;
              return {
                _id: id,
                name: c.name || '未知',
                color: c.color || '',
                avatar: c.avatar || '',
                initialName: (c.name || '未知').charAt(0),
                disabled: !!existing[id],
                selected: selected.indexOf(id) >= 0
              };
            });
          const merged = reset ? options : (that.data.pickerOptions || []).concat(options);
          that.safeSetData({
            pickerOptions: merged,
            pickerLoading: false,
            pickerPage: nextPage,
            pickerHasMore: data.hasMore === true,
            pickerTotal: typeof data.total === 'number' ? data.total : merged.length
          });
          return null;
        });
      })
      .catch(function(err) {
        if (seq !== that._pickerSeq) return;
        Logger.warn('relation-manage', '加载猫咪列表失败', { error: err.message });
        that.safeSetData({ pickerLoading: false });
        wx.showToast({ title: '猫咪列表加载失败', icon: 'none' });
      });
  },

  onPickerSearchInput: function(e) {
    this.setData({ pickerKeyword: e.detail.value });
    if (this._pickerTimer) clearTimeout(this._pickerTimer);
    const that = this;
    // 防抖：每击键一次就查一次云函数，成绩是候选列表反复闪烁
    this._pickerTimer = setTimeout(function() {
      that._pickerTimer = null;
      that._loadPicker(true);
    }, PICKER_SEARCH_DEBOUNCE);
  },

  onPickerClearSearch: function() {
    if (this._pickerTimer) { clearTimeout(this._pickerTimer); this._pickerTimer = null; }
    this.setData({ pickerKeyword: '' });
    this._loadPicker(true);
  },

  onPickerLoadMore: function() {
    if (this.data.pickerLoading || !this.data.pickerHasMore) return;
    this._loadPicker(false);
  },

  /** 点一行 = 切换勾选；已有关系的行置灰且拦下（服务端同口径） */
  onPickerToggle: function(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const selected = (this.data.pickerSelected || []).slice();
    const at = selected.indexOf(id);
    if (at >= 0) {
      selected.splice(at, 1);
    } else {
      if ((this._existingOfBase || {})[id]) {
        wx.showToast({ title: '这两只猫已有关系', icon: 'none' });
        return;
      }
      selected.push(id);
    }
    const options = (this.data.pickerOptions || []).map(function(o) {
      return o._id === id ? Object.assign({}, o, { selected: at < 0 }) : o;
    });
    this.setData({ pickerSelected: selected, pickerOptions: options });
  },

  /** 确定：把这一批对方猫带进添加面板（面板仍然开着，提交后可以接着加下一种类型） */
  onConfirmCatPicker: function() {
    const ids = (this.data.pickerSelected || []).slice();
    if (!ids.length) {
      wx.showToast({ title: '请选择至少一只猫咪', icon: 'none' });
      return;
    }
    const map = this._pickerCatMap || {};
    const picked = ids.map(function(id) { return map[id]; }).filter(Boolean);
    // 关面板后还要作废两件事：在途候选请求 + 还没到点的搜索防抖
    if (this._pickerTimer) { clearTimeout(this._pickerTimer); this._pickerTimer = null; }
    this._pickerSeq = (this._pickerSeq || 0) + 1;
    this.setData({
      showCatPicker: false,
      'addForm.relatedCatIds': ids,
      pickedCats: picked,
      addSuccessText: ''
    });
    this._syncAddPanelMeta();
  },

  /** 已选列表里去掉一只 */
  onRemovePickedCat: function(e) {
    const id = e.currentTarget.dataset.id;
    const ids = (this.data.addForm.relatedCatIds || []).filter(function(x) { return x !== id; });
    const picked = (this.data.pickedCats || []).filter(function(c) { return c._id !== id; });
    this.setData({ 'addForm.relatedCatIds': ids, pickedCats: picked });
    this._syncAddPanelMeta();
  },

  /**
   * 提交这一批关系。
   *
   * 逐条串行提交（不并发）：同一批里任一失败都能对应到具体猫名，云函数也不会被
   * N 个并发写打满；条数就是个位数，串行的总耗时仍在一次 loading 的感知范围内。
   *
   * 成功后**不关面板**：一窝猫通常还要补另一种关系（如先加「同窝」再加「朋友」），
   * 关掉再打开等于把刚做的选择重做一遍。这里只清空对方猫、保留基准猫与类型。
   */
  onSubmit: function() {
    if (this.data.submitting) return;
    const form = this.data.addForm;
    const ids = (form.relatedCatIds || []).slice();
    if (!form.catId) {
      wx.showToast({ title: '请先选择基准猫咪', icon: 'none' });
      return;
    }
    if (!ids.length) {
      wx.showToast({ title: '请选择至少一只猫咪', icon: 'none' });
      return;
    }

    const that = this;
    // 快照：提交期间用户仍可能在面板里改动（类型 / 备注 / 换基准猫），
    // 这一批必须按点击「添加」那一刻的输入落库
    const catId = form.catId;
    const type = form.type;
    const note = (form.note || '').trim();
    const results = [];
    this.setData({ submitting: true, canSubmit: false, addSuccessText: '' });

    let chain = Promise.resolve();
    ids.forEach(function(id) {
      chain = chain.then(function() {
        return catRelationService.addRelation({
          catId: catId,
          relatedCatId: id,
          type: type,
          note: note
        }).then(function(res) {
          results.push({ id: id, success: !!(res && res.success), error: res && res.error });
        }).catch(function() {
          results.push({ id: id, success: false, error: '网络错误' });
        });
      });
    });

    chain.then(function() {
      const okCount = results.filter(function(r) { return r.success; }).length;
      const failed = results.filter(function(r) { return !r.success; });
      if (okCount > 0) {
        that._pickerCatMap = {};
        that.safeSetData({
          'addForm.relatedCatIds': [],
          pickedCats: [],
          catBSummary: '',
          // 备注只属于刚提交的这一批，不能带到下一种关系上
          'addForm.note': '',
          addSuccessText: '已添加 ' + okCount + ' 条关系' + (failed.length ? '，' + failed.length + ' 条失败' : '')
        });
        that.reloadAll();
        wx.showToast({ title: '已添加 ' + okCount + ' 条', icon: 'success' });
      }
      if (failed.length) {
        const reason = failed[0].error || '添加失败';
        wx.showModal({
          title: failed.length + ' 条未添加',
          content: reason + (failed.length > 1 ? '（其余失败原因相同）' : ''),
          showCancel: false
        });
      }
    }).finally(function() {
      that.safeSetData({ submitting: false });
      that._syncAddPanelMeta();
    });
  },

  // ===== 编辑一条关系 =====

  /**
   * 点卡片里的关系 chip → 编辑这条关系。
   *
   * 主语按**当前卡片**取：同一条关系在双方卡片各出现一次，从哪张卡点进来，
   * 那句话的主语就该是哪只猫。反向卡片要先把类型反推一次（妈妈 ↔ 子女），
   * 否则一进面板就看到一个和刚才读到的句子对不上的类型。
   */
  onEditChip: function(e) {
    const id = e.currentTarget.dataset.id;
    const ownerId = e.currentTarget.dataset.owner || '';
    const rel = (this._relations || []).find(function(r) { return r._id === id; });
    if (!rel) return;

    let subjectId = rel.catId;
    let subjectName = rel.catName;
    let objectId = rel.relatedCatId;
    let objectName = rel.relatedCatName;
    let type = rel.type;
    let dirNote = '';

    if (ownerId && ownerId === rel.relatedCatId) {
      const inverted = inverseType(rel.type, rel.catGender);
      if (inverted) {
        subjectId = rel.relatedCatId;
        subjectName = rel.relatedCatName;
        objectId = rel.catId;
        objectName = rel.catName;
        type = inverted;
      } else {
        // 性别未知 → 反推不出「妈妈 / 爸爸」。不猜：按记录方向显示，并说清原因
        dirNote = '这只猫的性别未知，无法反推「妈妈 / 爸爸」，这里按记录方向编辑。';
      }
    }

    const meta = RELATION_TYPES[type] || RELATION_TYPES.other || { label: '其他', color: '' };
    this.setData({
      showEditPanel: true,
      editRel: {
        relId: rel._id,
        subjectId: subjectId,
        subjectName: subjectName || '未知',
        objectId: objectId,
        objectName: objectName || '未知'
      },
      editForm: { type: type, note: rel.note || '' },
      editTypeLabel: meta.label,
      editTypeColor: meta.color,
      editDirNote: dirNote,
      editSaving: false
    });
  },

  _syncEditMeta: function() {
    const form = this.data.editForm;
    const meta = RELATION_TYPES[form.type] || RELATION_TYPES.other || { label: '其他', color: '' };
    this.setData({ editTypeLabel: meta.label, editTypeColor: meta.color });
  },

  onEditSelectType: function(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ 'editForm.type': type });
    this._syncEditMeta();
  },

  onEditNoteInput: function(e) {
    this.setData({ 'editForm.note': e.detail.value });
  },

  onCloseEditPanel: function() {
    if (this.data.editSaving) return;
    this.setData({ showEditPanel: false });
  },

  onSaveEdit: function() {
    const rel = this.data.editRel;
    const form = this.data.editForm;
    if (!rel || this.data.editSaving) return;
    if (!form.type) {
      wx.showToast({ title: '请选择关系类型', icon: 'none' });
      return;
    }
    const that = this;
    this.setData({ editSaving: true });
    catRelationService.updateRelation({
      id: rel.relId,
      catId: rel.subjectId,
      relatedCatId: rel.objectId,
      type: form.type,
      note: (form.note || '').trim()
    }).then(function(res) {
      if (res.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        that.setData({ showEditPanel: false });
        that.reloadAll();
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' });
      }
    }).catch(function() {
      wx.showToast({ title: '网络错误', icon: 'none' });
    }).finally(function() {
      that.safeSetData({ editSaving: false });
    });
  },

  /** 编辑面板里删除 = 关掉面板 + 走既有的删除 + 撤销条 */
  onDeleteFromEdit: function() {
    const rel = this.data.editRel;
    if (!rel) return;
    this.setData({ showEditPanel: false });
    this.onDeleteChip({ currentTarget: { dataset: { id: rel.relId } } });
  },

  onBack: function() {
    wx.navigateBack();
  }
});

/** 关系数是否触到全量拉取上限（截断提示用） */
function allOverLimit(rels) {
  return MAX_PAGES > 0 && rels && rels.length >= MAX_PAGES * 100;
}
