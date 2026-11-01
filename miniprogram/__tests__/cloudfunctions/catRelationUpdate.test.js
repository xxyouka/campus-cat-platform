/**
 * __tests__/cloudfunctions/catRelationUpdate.test.js
 *
 * 回归（2026-10-25）：关系「可编辑」的第一版。
 *
 * 改一条关系和新建一条关系不是一回事，最容易做错的三处：
 *   1. **方向**：关系记录 (catId=A, relatedCatId=B, type=T) 读作「B 是 A 的 T」。
 *      管理端从反向卡片编辑时，主语是卡片里的猫，保存必须把 catId/relatedCatId 一起翻过来，
 *      否则「妈妈」会被存成「子女」（两端语义相反，而且没有任何报错）。
 *   2. **查重**：同一对猫只允许一条关系（与 addRelation 同口径），编辑时要排除自己。
 *   3. **存在性**：内容与原值完全相同时 updated=0，不能把「没改动」误报成「记录不存在」。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/catRelation/utils/contentSecurity', () => ({
  checkText: jest.fn(() => Promise.resolve({ ok: true }))
}));

const CAT_A = 'a'.repeat(24);
const CAT_B = 'b'.repeat(24);

function createFakeDb(opts) {
  const state = {
    relations: (opts.relations || []).map(r => ({ ...r })),
    updates: []
  };

  const makeQuery = (cond) => {
    let limitN = Infinity;
    const q = {
      limit: jest.fn(n => { limitN = n; return q; }),
      get: jest.fn(() => {
        let rows = state.relations;
        if (cond && cond.__or) {
          rows = rows.filter(r => cond.__or.some(pair => r.catId === pair[0] && r.relatedCatId === pair[1]));
        }
        return Promise.resolve({ data: rows.slice(0, limitN) });
      })
    };
    return q;
  };

  return {
    state,
    collection: jest.fn(() => ({
      where: jest.fn(cond => makeQuery(cond)),
      doc: jest.fn(id => ({
        get: jest.fn(() => {
          const found = state.relations.find(r => r._id === id);
          if (!found) return Promise.reject(new Error('document does not exist'));
          return Promise.resolve({ data: { ...found } });
        }),
        update: jest.fn(({ data }) => {
          state.updates.push({ id, data });
          const found = state.relations.find(r => r._id === id);
          if (found) Object.assign(found, data);
          return Promise.resolve({ stats: { updated: 1 } });
        })
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'new-id' }))
    })),
    RegExp: jest.fn(arg => arg),
    command: {
      or: jest.fn(list => ({ __or: list })),
      and: jest.fn(list => list.map(item => {
        const keys = Object.keys(item);
        return keys.length === 1 ? item[keys[0]] : item;
      }))
    }
  };
}

function loadMain(db) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  cloud.database.mockReturnValue(db);
  cloud.getWXContext.mockReturnValue({ OPENID: 'openid-1' });
  const auth = require('../../cloudfunctions/catRelation/utils/auth');
  auth.checkAdmin = jest.fn(() => Promise.resolve({ isAdmin: true }));
  return require('../../cloudfunctions/catRelation/index').main;
}

const EXISTING = {
  _id: 'rel-1',
  catId: CAT_A,
  relatedCatId: CAT_B,
  type: 'child',
  note: ''
};

function baseEvent(overrides) {
  return {
    action: 'update',
    _adminAccount: 'admin',
    data: Object.assign({
      id: 'rel-1',
      catId: CAT_B,
      relatedCatId: CAT_A,
      type: 'mother',
      note: ''
    }, overrides)
  };
}

describe('catRelation update', () => {
  test('反向卡片编辑：catId / relatedCatId 一起翻，一次 doc.update 完成', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);

    const res = await main(baseEvent());

    expect(res.success).toBe(true);
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].data).toEqual(expect.objectContaining({
      catId: CAT_B,
      relatedCatId: CAT_A,
      type: 'mother'
    }));
    // 写入后仍是同一条文档（没有删旧建新）
    expect(db.state.relations).toHaveLength(1);
    expect(db.state.relations[0]._id).toBe('rel-1');
  });

  test('同一对猫已有另一条记录时拒绝（排除自身）', async () => {
    const db = createFakeDb({
      relations: [EXISTING, { _id: 'rel-2', catId: CAT_B, relatedCatId: CAT_A, type: 'friend', note: '' }]
    });
    const main = loadMain(db);

    const res = await main(baseEvent());

    expect(res.success).toBe(false);
    expect(res.error).toContain('已存在');
    expect(db.state.updates).toHaveLength(0);
  });

  test('记录不存在时明确报错，而不是静默成功', async () => {
    const db = createFakeDb({ relations: [] });
    const main = loadMain(db);

    const res = await main(baseEvent());

    expect(res.success).toBe(false);
    expect(res.error).toContain('不存在');
  });

  test('类型不在白名单时拒绝', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);

    const res = await main(baseEvent({ type: 'bestie' }));

    expect(res.success).toBe(false);
    expect(res.error).toContain('关系类型');
    expect(db.state.updates).toHaveLength(0);
  });

  test('自己和自己建关系时拒绝', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);

    const res = await main(baseEvent({ catId: CAT_A, relatedCatId: CAT_A }));

    expect(res.success).toBe(false);
    expect(db.state.updates).toHaveLength(0);
  });

  test('猫咪 ID 非法时拒绝（ID 会进 where 条件）', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);

    const res = await main(baseEvent({ catId: { $ne: null } }));

    expect(res.success).toBe(false);
    expect(db.state.updates).toHaveLength(0);
  });

  test('缺关系 ID 时拒绝', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);

    const res = await main(baseEvent({ id: '' }));

    expect(res.success).toBe(false);
    expect(res.error).toContain('关系ID');
  });

  test('备注内容安全不通过时拒绝，且不落库', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);
    const security = require('../../cloudfunctions/catRelation/utils/contentSecurity');
    security.checkText.mockResolvedValueOnce({ ok: false });

    const res = await main(baseEvent({ note: '不当内容' }));

    expect(res.success).toBe(false);
    expect(res.error).toContain('不当');
    expect(db.state.updates).toHaveLength(0);
  });

  test('无关系管理权限时拒绝（鉴权在写库之前）', async () => {
    const db = createFakeDb({ relations: [EXISTING] });
    const main = loadMain(db);
    const auth = require('../../cloudfunctions/catRelation/utils/auth');
    auth.checkAdmin.mockResolvedValueOnce({ isAdmin: false, error: '无权限' });

    const res = await main(baseEvent());

    expect(res.success).toBe(false);
    expect(db.state.updates).toHaveLength(0);
  });
});
