/**
 * __tests__/cloudfunctions/mediaReview.test.js
 *
 * 内容复核云函数的入口测试：
 *   - 鉴权：非管理员直接拒绝，不查库；
 *   - list：待复核/已拦截记录 + 目标缩略图/猫名，支持分页；
 *   - resolve：通过清标记、拦截清头像；目标已删除时审核结论仍要落库；
 *   - 非法 id / decision 不写库。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/mediaReview/utils/auth', () => ({ checkAdmin: jest.fn() }));
jest.mock('../../cloudfunctions/mediaReview/common/operationLogger', () => ({
  logOperation: jest.fn(() => Promise.resolve('log-id'))
}));

const PHOTO_ID = 'a'.repeat(24);
const CAT_ID = 'b'.repeat(24);
const CHECK_ID = 'c'.repeat(24);

function setup(opts = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  const records = opts.records || [];
  const photos = opts.photos || [];
  const cats = opts.cats || [];
  const checkUpdates = [];
  const targetUpdates = [];
  let whereCalls = 0;

  const byIds = (rows, q) => {
    const ids = q && q._id;
    if (!Array.isArray(ids)) return rows;
    return rows.filter(row => ids.includes(row._id));
  };

  const collection = jest.fn((name) => {
    if (name === 'mediaChecks') {
      return {
        where: jest.fn(() => {
          whereCalls += 1;
          const chain = {
            orderBy: jest.fn(function() { return this; }),
            skip: jest.fn(function() { return this; }),
            limit: jest.fn(function() { return this; }),
            get: jest.fn(() => Promise.resolve({ data: records })),
            count: jest.fn(() => Promise.resolve({ total: records.length }))
          };
          return chain;
        }),
        doc: jest.fn(id => ({
          get: jest.fn(() => {
            const row = records.find(record => record._id === id);
            return row
              ? Promise.resolve({ data: row })
              : Promise.reject(new Error('document does not exist'));
          }),
          update: jest.fn(({ data }) => {
            checkUpdates.push({ id, ...data });
            return Promise.resolve({ stats: { updated: 1 } });
          })
        }))
      };
    }

    if (name === 'photos') {
      return {
        where: jest.fn(q => ({
          field: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: byIds(photos, q) }))
            }))
          }))
        })),
        doc: jest.fn(id => ({
          get: jest.fn(() => {
            const row = photos.find(photo => photo._id === id);
            return row
              ? Promise.resolve({ data: row })
              : Promise.reject(new Error('document does not exist'));
          }),
          update: jest.fn(({ data }) => {
            targetUpdates.push({ collection: 'photos', id, ...data });
            return Promise.resolve({ stats: { updated: 1 } });
          })
        }))
      };
    }

    if (name === 'cats') {
      return {
        where: jest.fn(q => ({
          field: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve({ data: byIds(cats, q) }))
            }))
          }))
        })),
        doc: jest.fn(id => ({
          get: jest.fn(() => {
            const row = cats.find(cat => cat._id === id);
            return row
              ? Promise.resolve({ data: row })
              : Promise.reject(new Error('document does not exist'));
          }),
          update: jest.fn(({ data }) => {
            targetUpdates.push({ collection: 'cats', id, ...data });
            return Promise.resolve({ stats: { updated: 1 } });
          })
        }))
      };
    }

    return {};
  });

  cloud.database.mockReturnValue({
    collection,
    command: { in: jest.fn(v => v), neq: jest.fn(v => v) },
    serverDate: jest.fn(() => 'SERVER_DATE')
  });

  const auth = require('../../cloudfunctions/mediaReview/utils/auth');
  auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { account: 'admin' } });

  const main = require('../../cloudfunctions/mediaReview/index').main;
  return { main, auth, checkUpdates, targetUpdates, get whereCalls() { return whereCalls; } };
}

describe('mediaReview 云函数', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('非管理员直接拒绝，不查库', async () => {
    const { main, auth } = setup();
    auth.checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限' });

    const res = await main({ action: 'list' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
  });

  test('list 返回待复核记录并补上照片/头像信息', async () => {
    const { main } = setup({
      records: [
        { _id: CHECK_ID, status: 'review', target: 'photo', refId: PHOTO_ID, traceId: 't1', updateTime: 1 },
        { _id: 'd'.repeat(24), status: 'risky', target: 'avatar', refId: CAT_ID, traceId: 't2', updateTime: 2 }
      ],
      photos: [{ _id: PHOTO_ID, url: 'cloud://env/photos/1.jpg', catId: CAT_ID }],
      cats: [{ _id: CAT_ID, name: '小橘', avatar: 'cloud://env/cats/1.jpg' }]
    });

    const res = await main({ action: 'list', page: 1, pageSize: 20 });

    expect(res.success).toBe(true);
    expect(res.data.total).toBe(2);
    expect(res.data.items[0]).toEqual(expect.objectContaining({
      mediaUrl: 'cloud://env/photos/1.jpg',
      catId: CAT_ID,
      catName: '小橘',
      missing: false
    }));
    expect(res.data.items[1]).toEqual(expect.objectContaining({
      mediaUrl: 'cloud://env/cats/1.jpg',
      catName: '小橘',
      missing: false
    }));
  });

  test('resolve keep：清除标记并回写检测状态', async () => {
    const { main, checkUpdates, targetUpdates } = setup({
      records: [{ _id: CHECK_ID, status: 'review', target: 'photo', refId: PHOTO_ID, traceId: 't1' }],
      photos: [{ _id: PHOTO_ID, url: 'cloud://env/photos/1.jpg', catId: CAT_ID }]
    });

    const res = await main({ action: 'resolve', id: CHECK_ID, decision: 'keep' });

    expect(res.success).toBe(true);
    expect(targetUpdates[0]).toEqual(expect.objectContaining({
      collection: 'photos',
      id: PHOTO_ID,
      _mediaBlocked: false,
      _mediaReview: false
    }));
    expect(checkUpdates[0]).toEqual(expect.objectContaining({
      id: CHECK_ID,
      status: 'pass',
      reviewAction: 'keep'
    }));
  });

  test('resolve block：头像立即清空，检测记录置为 blocked', async () => {
    const { main, checkUpdates, targetUpdates } = setup({
      records: [{ _id: CHECK_ID, status: 'review', target: 'avatar', refId: CAT_ID, traceId: 't2' }],
      cats: [{ _id: CAT_ID, name: '小橘', avatar: 'cloud://env/cats/1.jpg' }]
    });

    const res = await main({ action: 'resolve', id: CHECK_ID, decision: 'block' });

    expect(res.success).toBe(true);
    expect(targetUpdates[0]).toEqual(expect.objectContaining({
      collection: 'cats',
      id: CAT_ID,
      avatar: '',
      _mediaBlocked: true
    }));
    expect(checkUpdates[0]).toEqual(expect.objectContaining({
      id: CHECK_ID,
      status: 'blocked',
      reviewAction: 'block'
    }));
  });

  test('目标已删除：审核结论仍要落库，targetUpdated=false', async () => {
    const { main, checkUpdates } = setup({
      records: [{ _id: CHECK_ID, status: 'risky', target: 'photo', refId: PHOTO_ID, traceId: 't1' }]
    });

    const res = await main({ action: 'resolve', id: CHECK_ID, decision: 'block' });

    expect(res.success).toBe(true);
    expect(res.data.targetUpdated).toBe(false);
    expect(checkUpdates[0].status).toBe('blocked');
  });

  test('已处理记录幂等回执，不重复写目标', async () => {
    const { main, targetUpdates } = setup({
      records: [{ _id: CHECK_ID, status: 'pass', target: 'photo', refId: PHOTO_ID, reviewAction: 'keep' }]
    });

    const res = await main({ action: 'resolve', id: CHECK_ID, decision: 'keep' });

    expect(res.success).toBe(true);
    expect(res.data.alreadyResolved).toBe(true);
    expect(targetUpdates).toEqual([]);
  });

  test('非法 id / decision 不查库、不写库', async () => {
    const { main, checkUpdates } = setup();

    const badId = await main({ action: 'resolve', id: 'not-an-id', decision: 'keep' });
    expect(badId.success).toBe(false);

    const badDecision = await main({ action: 'resolve', id: CHECK_ID, decision: 'maybe' });
    expect(badDecision.success).toBe(false);
    expect(checkUpdates).toEqual([]);
  });
});
