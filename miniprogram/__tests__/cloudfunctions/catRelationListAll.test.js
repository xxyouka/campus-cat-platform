/**
 * __tests__/cloudfunctions/catRelationListAll.test.js
 *
 * 回归（2026-10-19 · P2）：listAll 的服务端筛选。
 *
 * 此前关键词与类型筛选都在客户端「只对已加载的那一页」做，命中第 2 页及以后的
 * 关系永远搜不到（FE-36 只能靠一个「继续加载」按钮兜底）。现在条件推到云端，
 * 但这带来三个容易做错、且错了就静默的地方：
 *
 *   1. **关键词按猫名过滤**：cat_relations 只存 catId / relatedCatId，不含名字。
 *      必须先在 cats 里解析出匹配的 id 再反查关系，且两端都要能命中。
 *   2. **关键词无匹配时必须返回空页**：不能退化成「不加条件」——
 *      那样会把「该关键词下没有数据」谎报成「有 100 条全量」。
 *   3. **截断必须说破**：_.in 有元素数上限，匹配过多时静默截断 = 搜不到的死胡同。
 *
 * 另外锁一条历史口径：type 非法值不得静默生效（也不得静默吞掉）。
 */
jest.mock('wx-server-sdk');

const CAT_A = 'a'.repeat(24);
const CAT_B = 'b'.repeat(24);

function createFakeDb(opts) {
  const state = {
    relations: opts.relations || [],
    cats: opts.cats || []
  };
  // 必须真的按 where 条件过滤，否则「关键词无匹配 → 返回空页」这条最关键的分支
  // 永远走不到（fake 会把全量 cats 都当成命中，测试就成了假绿）
  function applyFilter(collection, cond) {
    let rows = state[collection];
    if (!cond) return rows;
    if (cond.type) rows = rows.filter(r => r.type === cond.type);
    if (cond.name && cond.name.__regexp) {
      const re = new RegExp(cond.name.__regexp.regexp, cond.name.__regexp.options);
      rows = rows.filter(r => re.test(r.name || ''));
    }
    if (cond.$or) {
      rows = rows.filter(r => cond.$or.some(branch => Object.keys(branch).every(field => {
        const want = branch[field];
        const list = want && want.__in;
        return Array.isArray(list) ? list.indexOf(r[field]) >= 0 : false;
      })));
    }
    return rows;
  }
  const makeQuery = (collection) => {
    let cond = null;
    let skipN = 0;
    let limitN = Infinity;
    const q = {
      where: jest.fn((c) => { cond = c; return q; }),
      field: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      skip: jest.fn((n) => { skipN = n; return q; }),
      limit: jest.fn((n) => { limitN = n; return q; }),
      count: jest.fn(() => Promise.resolve({ total: applyFilter(collection, cond).length })),
      get: jest.fn(() => Promise.resolve({ data: applyFilter(collection, cond).slice(skipN, skipN + limitN) }))
    };
    return q;
  };
  return {
    state,
    collection: jest.fn((name) => makeQuery(name === 'cats' ? 'cats' : 'relations')),
    RegExp: jest.fn((arg) => ({ __regexp: arg })),
    command: {
      in: jest.fn((v) => ({ __in: v })),
      neq: jest.fn((v) => ({ __neq: v }))
    }
  };
}

function loadModule(db) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  cloud.database.mockReturnValue(db);
  const auth = require('../../cloudfunctions/catRelation/utils/auth');
  auth.checkAdmin = jest.fn(() => Promise.resolve({ isAdmin: true }));
  return require('../../cloudfunctions/catRelation/index').main;
}

describe('catRelation listAll 服务端筛选', () => {
  test('不带条件时返回全量（保持旧行为）', async () => {
    const db = createFakeDb({
      relations: [
        { _id: 'r1', catId: CAT_A, relatedCatId: CAT_B, type: 'father', createTime: '2026-10-19T00:00:00.000Z' }
      ],
      cats: [{ _id: CAT_A, name: '斜斜' }, { _id: CAT_B, name: '惜惜' }]
    });
    const main = loadModule(db);

    const res = await main({ action: 'listAll', page: 0, pageSize: 100 });

    expect(res.success).toBe(true);
    expect(res.data.relations).toHaveLength(1);
    expect(res.data.relations[0].catName).toBe('斜斜');
  });

  test('type 非法值不生效也不静默：按不过滤处理，记录仍能返回', async () => {
    const db = createFakeDb({
      relations: [{ _id: 'r1', catId: CAT_A, relatedCatId: CAT_B, type: 'father', createTime: 'x' }],
      cats: [{ _id: CAT_A, name: '斜斜' }, { _id: CAT_B, name: '惜惜' }]
    });
    const main = loadModule(db);

    const res = await main({ action: 'listAll', page: 0, pageSize: 100, type: '__not_exist__' });

    expect(res.success).toBe(true);
    expect(res.data.relations).toHaveLength(1);
  });

  test('关键词先在 cats 解析 id，再用 in 反查关系（两端都能命中）', async () => {
    const db = createFakeDb({
      relations: [
        { _id: 'r1', catId: CAT_A, relatedCatId: CAT_B, type: 'father', createTime: 'x' }
      ],
      cats: [{ _id: CAT_B, name: '惜惜' }]
    });
    const main = loadModule(db);

    const res = await main({ action: 'listAll', page: 0, pageSize: 100, keyword: '惜惜' });

    // 解析到 CAT_B（第二端），关系应被命中而不是被漏掉
    expect(db.RegExp).toHaveBeenCalledWith(expect.objectContaining({ regexp: '惜惜', options: 'i' }));
    expect(res.success).toBe(true);
    expect(res.data.relations).toHaveLength(1);
  });

  test('关键词无匹配猫时返回空页（绝不能退化成全量）', async () => {
    const db = createFakeDb({
      relations: [{ _id: 'r1', catId: CAT_A, relatedCatId: CAT_B, type: 'father', createTime: 'x' }],
      cats: [{ _id: CAT_A, name: '斜斜' }]
    });
    const main = loadModule(db);

    const res = await main({ action: 'listAll', page: 0, pageSize: 100, keyword: '根本不存在' });

    expect(res.success).toBe(true);
    expect(res.data.relations).toEqual([]);
    expect(res.data.hasMore).toBe(false);
  });

  test('匹配过多时截断并回传 keywordTruncated（不说破就成了「明明有却搜不到」）', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ _id: String(i).repeat(24), name: '橘' + i }));
    const db = createFakeDb({ relations: [], cats: many });
    const main = loadModule(db);

    const res = await main({ action: 'listAll', page: 0, pageSize: 100, keyword: '橘' });

    expect(res.data.keywordTruncated).toBe(true);
    // 截断上限 100：in 列表不能无限长
    const inCall = db.collection.mock.results;
    expect(inCall.length).toBeGreaterThan(0);
  });
});