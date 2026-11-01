// cloudfunctions/catRelation/index.js - 猫咪关系管理（管理员权限校验，新增/修改/删除/查询猫咪关系）
const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const sanitizer = require('./utils/sanitizer');
const { checkText } = require('./utils/contentSecurity');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RELATION_TYPES = {
  mother: { label: '妈妈', color: '#E8927C', colorDark: '#F5A593' },
  father: { label: '爸爸', color: '#E8927C', colorDark: '#F5A593' },
  child: { label: '子女', color: '#7EB5E8', colorDark: '#80C8FF' },
  sibling: { label: '同胞', color: '#7EB5E8', colorDark: '#80C8FF' },
  litter: { label: '同窝', color: '#DDA0DD', colorDark: '#E8A8E8' },
  friend: { label: '朋友', color: '#E8C87E', colorDark: '#F2D79B' },
  hostile: { label: '敌对', color: '#DE7C8D', colorDark: '#EE9AA8' },
  other: { label: '其他', color: '#98D8AA', colorDark: '#80E0A0' }
};

const NOTE_MAX_LENGTH = 200;
const CAT_ID_PATTERN = /^[a-fA-F0-9]{20,40}$/;

/**
 * 两只猫的 ID 是否都合法。
 * ID 会进入 where 条件做等值 / 逻辑匹配，格式不合法时可能被对象型查询改写语义。
 */
function hasValidCatIds(catId, relatedCatId) {
  return CAT_ID_PATTERN.test(String(catId)) && CAT_ID_PATTERN.test(String(relatedCatId));
}

function handleError(fn, err) {
  console.error('[' + fn + '] error:', err);
  return fail('操作失败，请稍后重试');
}

async function getByCatId(catId) {
  try {
    // 文档ID格式校验：防止对象/操作符注入改写查询语义
    if (typeof catId !== 'string' || !/^[a-fA-F0-9]{20,40}$/.test(catId)) {
      return fail('无效的猫咪ID');
    }
    console.log('[catRelation] getByCatId', catId);
    const res = await db.collection(COLLECTIONS.CAT_RELATIONS).where(
      _.or([
        { catId: catId },
        { relatedCatId: catId }
      ])
    ).get();

    const relations = res.data || [];
    const catIdSet = {};
    for (let i = 0; i < relations.length; i++) {
      catIdSet[relations[i].catId] = true;
      catIdSet[relations[i].relatedCatId] = true;
    }
    const allCatIds = Object.keys(catIdSet);

    const catsMap = {};
    if (allCatIds.length > 0) {
      const catsRes = await db.collection(COLLECTIONS.CATS)
        .where({ _id: _.in(allCatIds) })
        .field({ _id: true, name: true, avatar: true, color: true, gender: true })
        .get();
      const catsList = catsRes.data || [];
      for (let j = 0; j < catsList.length; j++) {
        catsMap[catsList[j]._id] = catsList[j];
      }
    }

    const enriched = [];
    for (let k = 0; k < relations.length; k++) {
      const rel = relations[k];
      const cat1 = catsMap[rel.catId] || { _id: rel.catId, name: '未知猫咪' };
      const cat2 = catsMap[rel.relatedCatId] || { _id: rel.relatedCatId, name: '未知猫咪' };
      const info = RELATION_TYPES[rel.type] || { label: '其他', color: '#999', colorDark: '#999' };
      enriched.push({
        _id: rel._id,
        catId: rel.catId,
        relatedCatId: rel.relatedCatId,
        type: rel.type,
        note: rel.note || '',
        createTime: rel.createTime,
        cat: cat1,
        relatedCat: cat2,
        relationInfo: info
      });
    }

    // ok() 自身会包一层 data，直接返回数组，避免 { data: { data: [...] } } 双层嵌套
    return ok(enriched);
  } catch (err) {
    return handleError('getByCatId', err);
  }
}

/**
 * 关系备注的写库前清洗（add / update 共用）。
 *
 * note 会经 getByCatId（无鉴权，详情页等前台直接读）原样下发给所有用户，
 * 属于 UGC 写库路径：必须与 addCat / recordMeet 同口径走 sanitizer + msgSecCheck，
 * 否则 XSS 类载荷会随关系数据公开传播。两个写入口各写一份迟早会漂移，故提取到这里。
 *
 * @param {*} rawNote
 * @param {string} openid
 * @returns {Promise<{ok: boolean, note?: string, error?: string}>}
 */
async function sanitizeRelationNote(rawNote, openid) {
  const raw = typeof rawNote === 'string' ? rawNote : '';
  const clean = sanitizer.sanitize(raw, {
    maxLength: NOTE_MAX_LENGTH,
    fieldName: 'note'
  });
  if (raw && !clean) return { ok: false, error: '备注包含不合法内容' };
  if (!clean) return { ok: true, note: '' };

  const check = await checkText(clean, { scene: 2, openid: openid || '' });
  if (!check.ok) {
    console.warn('[catRelation] note 内容安全检测未通过');
    return { ok: false, error: '备注可能包含不当词语，请修改后再试' };
  }
  return { ok: true, note: clean };
}

async function addRelation(data, openid, adminAccount) {
  try {
    const authResult = await checkAdmin(db, openid, { operation: '添加猫咪关系', adminAccount, useCache: false, permission: 'relation' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    if (!data.catId || !data.relatedCatId) {
      return fail('请选择两只猫咪');
    }
    if (data.catId === data.relatedCatId) {
      return fail('不能选择同一只猫咪');
    }
    if (!data.type || !RELATION_TYPES[data.type]) {
      return fail('关系类型无效');
    }

    // 猫ID 会进入 where 条件做等值/逻辑匹配，格式不合法时可能被对象型查询改写语义
    if (!hasValidCatIds(data.catId, data.relatedCatId)) {
      return fail('无效的猫咪ID');
    }

    // note 会经 getByCatId（无鉴权，详情页等前台直接读）原样下发给所有用户，
    // 属于 UGC 写库路径：必须与 addCat / recordMeet 同口径走
    // sanitizer + msgSecCheck，否则 XSS 类载荷会随关系数据公开传播。
    const noteResult = await sanitizeRelationNote(data.note, openid);
    if (!noteResult.ok) return fail(noteResult.error);
    const cleanNote = noteResult.note;

    const existRes = await db.collection(COLLECTIONS.CAT_RELATIONS).where(
      _.or([
        _.and([{ catId: data.catId }, { relatedCatId: data.relatedCatId }]),
        _.and([{ catId: data.relatedCatId }, { relatedCatId: data.catId }])
      ])
    ).count();

    if (existRes.total > 0) {
      return fail('该关系已存在');
    }

    const newRel = {
      catId: data.catId,
      relatedCatId: data.relatedCatId,
      type: data.type,
      note: cleanNote,
      createdBy: openid || '',
      createTime: new Date().toISOString()
    };

    const addRes = await db.collection(COLLECTIONS.CAT_RELATIONS).add({ data: newRel });
    return ok({ _id: addRes._id }, '关系添加成功');
  } catch (err) {
    return handleError('add', err);
  }
}

/**
 * 修改一条关系的类型 / 备注 / 方向。
 *
 * 为什么连方向（catId / relatedCatId）一起收：管理端是「按猫聚合」的卡片视图，
 * 同一条关系会在双方卡片各出现一次，从哪张卡片点进去，那句话的主语就不同。
 * 若只允许改 type 而不允许换主语，从反向卡片把「妈妈」改成「子女」就会把语义
 * 写反（A 的子女 ≠ B 的妈妈，是两个不同的事实）。调用方按卡片视角给出主语，
 * 服务端只守「同一对猫只留一条」这条既有约束。
 *
 * 方向翻转不需要删旧建新：catId / relatedCatId 只是文档上的两个普通字段，
 * 一次 doc.update 就能改完，不存在中间态（addRelation 的双向查重也不会被绕过，
 * 因为这里先查重、再更新同一条文档）。
 *
 * @param {object} data - { id, catId, relatedCatId, type, note }
 */
async function updateRelation(data, openid, adminAccount) {
  try {
    const authResult = await checkAdmin(db, openid, { operation: '修改猫咪关系', adminAccount, useCache: false, permission: 'relation' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    const payload = data || {};
    const id = payload.id ? String(payload.id) : '';
    if (!id) return fail('关系ID不能为空');
    if (!payload.catId || !payload.relatedCatId) return fail('请选择两只猫咪');
    if (payload.catId === payload.relatedCatId) return fail('不能选择同一只猫咪');
    if (!payload.type || !RELATION_TYPES[payload.type]) return fail('关系类型无效');
    if (!hasValidCatIds(payload.catId, payload.relatedCatId)) {
      return fail('无效的猫咪ID');
    }

    // note 与其他写库路径同口径：sanitizer + msgSecCheck（getByCatId 无鉴权，会原样公开）
    const noteResult = await sanitizeRelationNote(payload.note, openid);
    if (!noteResult.ok) return fail(noteResult.error);
    const cleanNote = noteResult.note;

    // 先确认记录存在：更新值与原值完全相同时 updated 也是 0，
    // 直接拿 stats.updated 判断会把「没改动」误报成「记录不存在」。
    let current = null;
    try {
      const got = await db.collection(COLLECTIONS.CAT_RELATIONS).doc(id).get();
      current = got && got.data ? got.data : null;
    } catch (e) {
      current = null;
    }
    if (!current) return fail('关系记录不存在');

    // 同一对猫只允许一条关系（与 addRelation 的双向查重同口径），排除自身
    const dupRes = await db.collection(COLLECTIONS.CAT_RELATIONS).where(
      _.or([
        _.and([{ catId: payload.catId }, { relatedCatId: payload.relatedCatId }]),
        _.and([{ catId: payload.relatedCatId }, { relatedCatId: payload.catId }])
      ])
    ).limit(5).get();
    const conflict = (dupRes.data || []).some(function(row) { return row._id !== id; });
    if (conflict) return fail('该关系已存在');

    await db.collection(COLLECTIONS.CAT_RELATIONS).doc(id).update({
      data: {
        catId: payload.catId,
        relatedCatId: payload.relatedCatId,
        type: payload.type,
        note: cleanNote,
        updatedBy: openid || '',
        updateTime: new Date().toISOString()
      }
    });
    return ok({ _id: id }, '关系已更新');
  } catch (err) {
    return handleError('update', err);
  }
}

async function removeRelation(id, openid, adminAccount) {
  try {
    if (!id) return fail('关系ID不能为空');

    const authResult = await checkAdmin(db, openid, { operation: '删除猫咪关系', adminAccount, useCache: false, permission: 'relation' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    await db.collection(COLLECTIONS.CAT_RELATIONS).doc(id).remove();
    return ok(null, '关系已删除');
  } catch (err) {
    return handleError('remove', err);
  }
}

exports.main = async function(event, _context) {
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = Object.assign({}, event, parsed);
    } catch (e) {
      console.warn('[catRelation] event.body 解析失败，使用原始 event');
    }
  }
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';
  const action = event.action || 'getByCatId';
  let result;

  if (action === 'getByCatId') {
    result = await getByCatId(event.catId);
  } else if (action === 'add') {
    result = await addRelation(event.data, openid, adminAccount);
  } else if (action === 'update') {
    result = await updateRelation(event.data, openid, adminAccount);
  } else if (action === 'remove') {
    result = await removeRelation(event.id, openid, adminAccount);
  } else if (action === 'getRelationTypes') {
    result = ok(RELATION_TYPES);
  } else if (action === 'listAll') {
    // 管理后台专用接口，补鉴权
    result = await listAllRelations(openid, adminAccount, event.page, event.pageSize, event.keyword, event.type);
  } else if (action === 'searchCats') {
    result = await searchCatsByName(event.keyword, openid);
  } else {
    result = fail('未知操作');
  }

  return result;
};

/**
 * 列出所有关系（管理后台用）
 *
 * 2026-10-19：keyword / type 改为**服务端**过滤。此前关键词与类型筛选都在客户端
 * 对「已加载的那一页」做，命中第 2 页及以后的记录就永远搜不到（FE-36 只能靠一个
 * 「继续加载」按钮兜底）。现在把条件推到云端，分页从「匹配结果的第 0 页」开始，
 * 结果天然可达，客户端不必再兜底。
 *
 * 关键词要按**猫名**过滤，但 cat_relations 里只存 catId / relatedCatId（不含名字），
 * 故先在 cats 里解析出匹配的猫 id，再用 `_.in` 反查关系 —— 与既有的显示用
 * 名字 join 是两件事，不能省掉其中任何一步。
 *
 * @param {string} openid
 * @param {string} adminAccount
 * @param {number} page - 从 0 起
 * @param {number} pageSize - 上限 100
 * @param {string} [keyword] - 猫名关键词（大小写不敏感）
 * @param {string} [type] - 关系类型；非法值按「不过滤」处理并记警告
 */
async function listAllRelations(openid, adminAccount, page, pageSize, keyword, type) {
  try {
    const authResult = await checkAdmin(db, openid, { operation: '列出猫咪关系', adminAccount, useCache: false, permission: 'relation' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }
    // 分页参数钳制（口径同 getAlbumsWithInfo）：防深分页资源消耗
    const pageNum = Math.min(Math.max(0, parseInt(page, 10) || 0), 1000);
    const size = Math.min(Math.max(1, parseInt(pageSize, 10) || 100), 100);
    const skip = pageNum * size;

    // ---- 条件 1：类型（白名单校验，非法值不静默生效也不静默吞掉）----
    const where = {};
    const rawType = type ? String(type).trim() : '';
    if (rawType) {
      if (RELATION_TYPES[rawType]) {
        where.type = rawType;
      } else {
        console.warn('[catRelation] listAll 收到非法 type:', rawType);
      }
    }

    // ---- 条件 2：关键词（先解析猫 id，再反查关系）----
    const kw = keyword ? String(keyword).trim().slice(0, 50) : '';
    let keywordTruncated = false;
    if (kw) {
      const matched = await findCatIdsByKeyword(kw);
      keywordTruncated = matched.truncated;
      if (matched.ids.length === 0) {
        // 没有匹配的猫 → 没有任何关系可能命中，直接返回空页：
        // 关键在于**不要退化成不加条件**，否则会漏掉「该关键词下没有数据」的事实
        return ok({ relations: [], hasMore: false, keywordTruncated: false });
      }
      where.$or = [
        { catId: _.in(matched.ids) },
        { relatedCatId: _.in(matched.ids) }
      ];
    }

    // 多取一条判断 hasMore，避免额外 count 查询
    const res = await db.collection(COLLECTIONS.CAT_RELATIONS)
      .where(where)
      .orderBy('createTime', 'desc')
      .skip(skip)
      .limit(size + 1)
      .get();

    const hasMore = (res.data || []).length > size;
    const relations = hasMore ? res.data.slice(0, size) : res.data || [];
    const catIdSet = {};
    for (let i = 0; i < relations.length; i++) {
      catIdSet[relations[i].catId] = true;
      catIdSet[relations[i].relatedCatId] = true;
    }
    const allCatIds = Object.keys(catIdSet);

    const catsMap = {};
    if (allCatIds.length > 0) {
      const catsRes = await db.collection(COLLECTIONS.CATS)
        .where({ _id: _.in(allCatIds) })
        // color/gender 供管理端「按猫聚合」卡片用：花色参与客户端搜索，
        // gender 决定 child 反向标签显示「妈妈 / 爸爸」（与 getRelationLabel 口径一致）
        .field({ _id: true, name: true, avatar: true, color: true, gender: true })
        .limit(200)
        .get();
      const catsList = catsRes.data || [];
      for (let j = 0; j < catsList.length; j++) {
        catsMap[catsList[j]._id] = catsList[j];
      }
    }

    const enriched = [];
    for (let k = 0; k < relations.length; k++) {
      const rel = relations[k];
      const cat = catsMap[rel.catId] || { _id: rel.catId, name: '未知' };
      const relatedCat = catsMap[rel.relatedCatId] || { _id: rel.relatedCatId, name: '未知' };
      const info = RELATION_TYPES[rel.type] || { label: '其他', color: '#999', colorDark: '#999' };
      enriched.push({
        _id: rel._id,
        catId: rel.catId,
        relatedCatId: rel.relatedCatId,
        type: rel.type,
        note: rel.note || '',
        createTime: rel.createTime,
        catName: cat.name,
        catAvatar: cat.avatar || '',
        catColor: cat.color || '',
        catGender: cat.gender || '',
        relatedCatName: relatedCat.name,
        relatedCatAvatar: relatedCat.avatar || '',
        relatedCatColor: relatedCat.color || '',
        relatedCatGender: relatedCat.gender || '',
        typeLabel: info.label,
        typeColor: info.color
      });
    }

    return ok({ relations: enriched, hasMore, keywordTruncated });
  } catch (err) {
    return handleError('listAll', err);
  }
}

/**
 * 关键词 → 匹配猫 id（listAll 的服务端搜索用）
 *
 * 关键词要按猫名过滤关系，但 cat_relations 只存 id，所以必须先在 cats 里解析。
 * 上限 KEYWORD_ID_LIMIT：超过后**不静默截断** —— 返回 truncated 标记，由前端
 * 明示「匹配过多，请补关键词」。微信云数据库 _.in 的元素数有上限，静默截断会
 * 变成「搜不到」的死胡同（同 searchCats 的 limit(10) 只是因为搜索框本就窄）。
 *
 * @param {string} keyword - 已 trim、已截长
 * @returns {Promise<{ids: string[], truncated: boolean}>}
 */
const KEYWORD_ID_LIMIT = 100;

async function findCatIdsByKeyword(keyword) {
  const escaped = escapeRegex(keyword);
  const res = await db.collection(COLLECTIONS.CATS)
    .where({
      name: db.RegExp({ regexp: escaped, options: 'i' })
    })
    .field({ _id: true })
    .limit(KEYWORD_ID_LIMIT + 1)
    .get();
  const list = res.data || [];
  const truncated = list.length > KEYWORD_ID_LIMIT;
  return {
    ids: list.slice(0, KEYWORD_ID_LIMIT).map(function(c) { return c._id; }),
    truncated: truncated
  };
}

/**
 * 安全转义正则特殊字符，防止用户输入的 keyword 注入正则元字符 / 触发灾难性回溯
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== 频率限制（实例级内存，防滥用刷查询） ==========
const SEARCH_RATE_WINDOW = 60 * 1000;
const SEARCH_RATE_MAX = 30; // 每分钟每 openid 最多 30 次搜索
const _searchLog = new Map();

function checkSearchRateLimit(openid) {
  const key = openid || 'anonymous';
  const now = Date.now();
  const records = (_searchLog.get(key) || []).filter(t => now - t < SEARCH_RATE_WINDOW);
  if (records.length >= SEARCH_RATE_MAX) {
    _searchLog.set(key, records);
    return false;
  }
  records.push(now);
  _searchLog.set(key, records);
  return true;
}

/**
 * 按名称/颜色搜索猫咪（关系管理后台选猫使用，仅合法状态）
 */
async function searchCatsByName(keyword, openid) {
  try {
    if (!keyword || keyword.length < 1) {
      return ok({ cats: [] });
    }
    if (!checkSearchRateLimit(openid)) {
      return fail('搜索过于频繁，请稍后再试', 'RATE_LIMITED');
    }
    const escaped = escapeRegex(keyword.trim().slice(0, 50));
    const res = await db.collection(COLLECTIONS.CATS)
      .where(
        _.and([
          { status: _.in(['normal', 'lost', 'deceased', 'adopted']) },
          _.or([
            { name: db.RegExp({ regexp: escaped, options: 'i' }) },
            { color: db.RegExp({ regexp: escaped, options: 'i' }) }
          ])
        ])
      )
      .field({ _id: true, name: true, avatar: true, color: true })
      .limit(10)
      .get();
    return ok({ cats: res.data || [] });
  } catch (err) {
    return handleError('searchCats', err);
  }
}
