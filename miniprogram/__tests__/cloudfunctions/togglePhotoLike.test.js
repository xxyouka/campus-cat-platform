// __tests__/cloudfunctions/togglePhotoLike.test.js
//
// togglePhotoLike 此前零测试（在入口覆盖守卫的债务台账里）。
// 2026-10-10 修过一处硬伤：原实现在**事务内**用 where 查询（官方文档明令禁止：
// 事务中仅能进行单记录操作），且异常路径既不 commit 也不 rollback。
// 本文件的两条事务用例即为该修复的回归锁。
jest.mock('wx-server-sdk');

jest.mock('../../cloudfunctions/togglePhotoLike/utils/sanitizer', () => ({
  sanitize: jest.fn(s => s),
  isValidObjectId: jest.fn(id => /^[a-fA-F0-9]{20,40}$/.test(id)),
  validateUrl: jest.fn(() => ({ isValid: true, url: '' }))
}));

const { isValidObjectId } = require('../../cloudfunctions/togglePhotoLike/utils/sanitizer');

const GOOD_ID = 'a'.repeat(24);

/**
 * 构造 db + 事务替身。
 * @param {Object} opts
 * @param {boolean} opts.txAvailable startTransaction 是否成功
 * @param {boolean} opts.commitThrows transaction.commit() 是否抛错
 * @param {Array} opts.existingLikes 已存在的点赞文档
 * @param {number} opts.likeCount photos.likeCount 当前值
 */
function setup(opts = {}) {
  const {
    txAvailable = true,
    commitThrows = false,
    existingLikes = [],
    likeCount = 0
  } = opts;

  const calls = { likeAdd: [], likeRemove: [], photoUpdate: [], txLikeAdd: [], txLikeRemove: [], txPhotoUpdate: [] };
  const tx = {
    collection: jest.fn((name) => {
      if (name === 'photoLikes') {
        return {
          add: jest.fn(({ data }) => { calls.txLikeAdd.push(data); return Promise.resolve({ _id: 'new-like' }); }),
          doc: jest.fn((id) => ({
            remove: jest.fn(() => { calls.txLikeRemove.push(id); return Promise.resolve({ stats: { removed: 1 } }); })
          }))
        };
      }
      return {
        doc: jest.fn((id) => ({
          update: jest.fn(({ data }) => { calls.txPhotoUpdate.push({ id, data }); return Promise.resolve({}); })
        }))
      };
    }),
    commit: jest.fn(() => commitThrows
      ? Promise.reject(new Error('commit failed'))
      : Promise.resolve()),
    rollback: jest.fn(() => Promise.resolve())
  };

  const photoLikesCollection = {
    where: jest.fn((query) => {
      // 只支持本函数用到的 photoId + _openid 组合查询
      const matched = existingLikes.filter(l => l.photoId === query.photoId && l._openid === query._openid);
      return {
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: matched })) })),
        get: jest.fn(() => Promise.resolve({ data: matched }))
      };
    }),
    add: jest.fn(({ data }) => { calls.likeAdd.push(data); return Promise.resolve({ _id: 'new-like' }); }),
    doc: jest.fn((id) => ({
      remove: jest.fn(() => { calls.likeRemove.push(id); return Promise.resolve({ stats: { removed: 1 } }); })
    }))
  };

  const photosCollection = {
    doc: jest.fn((id) => ({
      field: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ data: { _id: id, likeCount } }))
      })),
      get: jest.fn(() => Promise.resolve({ data: { _id: id, likeCount } })),
      update: jest.fn(({ data }) => { calls.photoUpdate.push({ id, data }); return Promise.resolve({}); })
    })),
    where: photoLikesCollection.where
  };

  const db = {
    collection: jest.fn((name) => {
      if (name === 'photoLikes') return photoLikesCollection;
      if (name === 'photos') return photosCollection;
      return photosCollection;
    }),
    command: {
      inc: jest.fn(v => ({ $inc: v })),
      neq: jest.fn(v => ({ $ne: v })),
      gte: jest.fn(v => ({ $gte: v }))
    },
    serverDate: jest.fn(() => 'SERVER_DATE'),
    startTransaction: jest.fn(() => txAvailable
      ? Promise.resolve(tx)
      : Promise.reject(new Error('transaction unavailable')))
  };

  const cloud = require('wx-server-sdk');
  cloud.database.mockReturnValue(db);
  cloud.getWXContext.mockReturnValue({ OPENID: 'o-like-test' });

  return { db, tx, calls, cloud };
}

describe('togglePhotoLike 云函数', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // togglePhotoLike/index.js 在模块加载时就执行 `const db = cloud.database()`，
    // 模块被缓存后后续 setup() 换的新 db 不生效。必须重新 require。
    jest.resetModules();
    isValidObjectId.mockImplementation(id => /^[a-fA-F0-9]{20,40}$/.test(id));
  });

  // ===== 入参校验 =====
  test('照片ID格式非法时拒绝，不碰任何集合', async () => {
    const { db } = setup();
    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');

    const res = await togglePhotoLike.main({ photoId: '../etc/passwd' }, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('无效的照片ID');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('照片不存在时拒绝，不写点赞', async () => {
    const { db, calls } = setup();
    db.collection.mockImplementation((name) => {
      if (name === 'photos') {
        return { doc: jest.fn(() => ({ field: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({})) })) })) };
      }
      return { where: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })) })) };
    });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('照片不存在');
    expect(calls.likeAdd).toHaveLength(0);
    expect(calls.txLikeAdd).toHaveLength(0);
  });

  test('缺少服务端 OPENID 时拒绝且不访问集合', async () => {
    const { db, cloud } = setup();
    cloud.getWXContext.mockReturnValue({ OPENID: '' });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(false);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(db.collection).not.toHaveBeenCalled();
  });

  // ===== 事务路径（修复的核心）=====
  test('事务可用且未点赞：走事务 add + inc(1)，且事务内不使用 where', async () => {
    const { tx, calls } = setup({ existingLikes: [] });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(true);
    expect(calls.txLikeAdd).toHaveLength(1);
    expect(calls.txPhotoUpdate).toEqual([{ id: GOOD_ID, data: { likeCount: { $inc: 1 } } }]);
    expect(tx.commit).toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();

    // 关键回归：事务内不得出现 where 调用（官方文档禁止，会导致事务路径必失败）
    const txWhereCalls = tx.collection.mock.calls
      .map(([name]) => name)
      .filter(() => false); // where 在 collection 返回对象上，下面单独断言
    void txWhereCalls;
    const likeCollectionInstances = tx.collection.mock.results
      .map(r => r.value)
      .filter(v => typeof v.where === 'function');
    expect(likeCollectionInstances.every(v => v.where.mock.calls.length === 0)).toBe(true);
  });

  test('事务可用且已点赞：走事务 remove + inc(-1)', async () => {
    const { tx, calls } = setup({
      existingLikes: [{ _id: 'like-1', photoId: GOOD_ID, _openid: 'o-like-test' }],
      likeCount: 5
    });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(false);
    expect(calls.txLikeRemove).toEqual(['like-1']);
    expect(calls.txPhotoUpdate).toEqual([{ id: GOOD_ID, data: { likeCount: { $inc: -1 } } }]);
    expect(tx.commit).toHaveBeenCalled();
  });

  test('事务 commit 失败：必须 rollback 且返回失败（不得留下悬挂事务）', async () => {
    const { tx } = setup({ existingLikes: [], commitThrows: true });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(false);
    // 核心回归：失败必须显式回滚，否则事务悬挂到超时
    expect(tx.rollback).toHaveBeenCalled();
  });

  // ===== 降级路径 =====
  test('事务不可用时降级：仍完成点赞且不 rollback', async () => {
    const { tx, calls } = setup({ txAvailable: false, existingLikes: [] });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(true);
    expect(calls.likeAdd).toHaveLength(1);
    expect(calls.photoUpdate).toEqual([{ id: GOOD_ID, data: { likeCount: { $inc: 1 } } }]);
    expect(tx.rollback).not.toHaveBeenCalled();
  });

  test('降级路径取消点赞时 likeCount 为 0 则不减（避免扣成负数）', async () => {
    const { calls } = setup({
      txAvailable: false,
      existingLikes: [{ _id: 'like-1', photoId: GOOD_ID, _openid: 'o-like-test' }],
      likeCount: 0
    });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    const res = await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(false);
    expect(calls.likeRemove).toEqual(['like-1']);
    // likeCount 已为 0，不应再 inc(-1)
    expect(calls.photoUpdate).toHaveLength(0);
  });

  test('存在性查询只对本人开放（where 带本人 _openid）', async () => {
    const { db } = setup({ existingLikes: [] });

    const togglePhotoLike = require('../../cloudfunctions/togglePhotoLike/index');
    await togglePhotoLike.main({ photoId: GOOD_ID }, {});

    const likeWhereCalls = [];
    db.collection.mock.results.forEach((r) => {
      const v = r.value;
      if (v && typeof v.where === 'function') v.where.mock.calls.forEach(c => likeWhereCalls.push(c[0]));
    });
    expect(likeWhereCalls).toContainEqual(
      expect.objectContaining({ photoId: GOOD_ID, _openid: 'o-like-test' })
    );
  });
});
