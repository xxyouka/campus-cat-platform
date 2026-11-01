/**
 * __tests__/cloudfunctions/manageReport.test.js
 * 管理端反馈队列：鉴权、列表脱敏、处理结果 + 站内通知。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/manageReport/utils/auth', () => ({ checkAdmin: jest.fn() }));
jest.mock('../../cloudfunctions/manageReport/common/operationLogger', () => ({
  logOperation: jest.fn(() => Promise.resolve('log-id'))
}));

const CAT_ID = 'a'.repeat(24);
const CAT2_ID = 'c'.repeat(24);
const CAT3_ID = 'd'.repeat(24);
const REPORT_ID = 'b'.repeat(24);

function matchWhere(row, where) {
  if (!where) return true;
  return Object.keys(where).every((key) => {
    const cond = where[key];
    if (cond && typeof cond === 'object' && Array.isArray(cond.__in)) {
      return cond.__in.includes(row[key]);
    }
    if (cond && typeof cond === 'object' && cond.__gte !== undefined) {
      return new Date(row[key]).getTime() >= new Date(cond.__gte).getTime();
    }
    return row[key] === cond;
  });
}

function setup(opts = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  const reports = opts.reports || [];
  const update = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
  const notifAdd = jest.fn(() => Promise.resolve({ _id: 'notif-1' }));

  function collection(name) {
    if (name === 'user_reports') {
      const where = jest.fn((cond) => {
        const query = {
          orderBy: jest.fn(function() { return this; }),
          skip: jest.fn(function() { return this; }),
          limit: jest.fn(function() { return this; }),
          get: jest.fn(() => Promise.resolve({
            data: reports.filter(row => matchWhere(row, cond))
          })),
          count: jest.fn(() => Promise.resolve({
            total: reports.filter(row => matchWhere(row, cond)).length
          }))
        };
        return query;
      });

      return {
        where,
        count: jest.fn(() => Promise.resolve({ total: reports.length })),
        doc: jest.fn(id => ({
          get: jest.fn(() => {
            const row = reports.find(report => report._id === id);
            return row
              ? Promise.resolve({ data: row })
              : Promise.reject(new Error('document does not exist'));
          }),
          update
        })),
        aggregate: () => {
          let match = {};
          let limit = 20;
          const api = {
            match(cond) { match = cond; return api; },
            group() { return api; },
            sort() { return api; },
            limit(n) { limit = n; return api; },
            end() {
              const groups = new Map();
              reports.filter(row => matchWhere(row, match)).forEach((row) => {
                const catId = row.catId || '';
                const catName = row.catName || '';
                const key = `${catId}\u0000${catName}`;
                const item = groups.get(key) || {
                  _id: { catId, catName },
                  count: 0,
                  lastAt: null
                };
                item.count += 1;
                if (!item.lastAt || new Date(row.createTime).getTime() > new Date(item.lastAt).getTime()) {
                  item.lastAt = row.createTime;
                }
                groups.set(key, item);
              });
              const list = Array.from(groups.values())
                .sort((a, b) => b.count - a.count)
                .slice(0, limit);
              return Promise.resolve({ list });
            }
          };
          return api;
        }
      };
    }
    if (name === 'notifications') {
      return { add: notifAdd };
    }
    return {};
  }

  cloud.database.mockReturnValue({
    collection: jest.fn(collection),
    command: {
      in: jest.fn(v => ({ __in: v })),
      gte: jest.fn(v => ({ __gte: v })),
      aggregate: {
        sum: jest.fn(() => '$sum'),
        max: jest.fn(() => '$max')
      }
    },
    serverDate: jest.fn(() => 'SERVER_DATE')
  });
  cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });

  const auth = require('../../cloudfunctions/manageReport/utils/auth');
  auth.checkAdmin.mockResolvedValue(opts.auth || { isAdmin: true, adminInfo: { account: 'admin' } });

  const { logOperation } = require('../../cloudfunctions/manageReport/common/operationLogger');
  const main = require('../../cloudfunctions/manageReport/index').main;
  return { main, auth, update, notifAdd, logOperation };
}

describe('manageReport 云函数', () => {
  beforeEach(() => jest.clearAllMocks());

  test('非管理员直接拒绝', async () => {
    const { main, auth } = setup({ auth: { isAdmin: false, error: '无权限' } });
    const res = await main({ action: 'list' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('FORBIDDEN');
    expect(auth.checkAdmin).toHaveBeenCalled();
  });

  test('list 不把反馈人 openid 下发给管理端', async () => {
    const { main } = setup({
      reports: [{
        _id: REPORT_ID,
        _openid: 'reporter-openid',
        catId: CAT_ID,
        catName: '斑斑',
        type: 'info_error',
        description: '名字写错了',
        status: 'pending'
      }]
    });
    const res = await main({ action: 'list' });
    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).not.toHaveProperty('_openid');
    expect(res.data.items[0].catName).toBe('斑斑');
  });

  test('非法处理状态 / 不存在的反馈不写库', async () => {
    const { main, update } = setup({ reports: [] });
    expect((await main({ action: 'resolve', id: REPORT_ID, status: 'bad' })).code).toBe('INVALID_STATUS');
    const notFound = await main({ action: 'resolve', id: REPORT_ID, status: 'resolved' });
    expect(notFound.code).toBe('NOT_FOUND');
    expect(update).not.toHaveBeenCalled();
  });

  test('已处理的反馈返回回执，不重复通知', async () => {
    const { main, notifAdd } = setup({
      reports: [{
        _id: REPORT_ID,
        _openid: 'reporter-openid',
        catId: CAT_ID,
        catName: '斑斑',
        status: 'resolved',
        handleNote: '已修正'
      }]
    });
    const res = await main({ action: 'resolve', id: REPORT_ID, status: 'rejected' });
    expect(res.data.alreadyResolved).toBe(true);
    expect(notifAdd).not.toHaveBeenCalled();
  });

  test('处理成功：更新状态 + 给反馈人写站内通知 + 操作日志', async () => {
    const { main, update, notifAdd, logOperation } = setup({
      reports: [{
        _id: REPORT_ID,
        _openid: 'reporter-openid',
        catId: CAT_ID,
        catName: '斑斑',
        catAvatar: 'cloud://avatar',
        status: 'pending'
      }]
    });
    const res = await main({
      action: 'resolve',
      id: REPORT_ID,
      status: 'resolved',
      note: '已修正名字'
    });

    expect(res.success).toBe(true);
    expect(update).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'resolved', handleNote: '已修正名字' })
    });
    expect(notifAdd).toHaveBeenCalledWith({
      data: expect.objectContaining({
        _openid: 'reporter-openid',
        type: 'report_result',
        catId: CAT_ID,
        catName: '斑斑'
      })
    });
    expect(logOperation).toHaveBeenCalled();
  });

  test('list 支持按类型与猫咪筛选', async () => {
    const { main } = setup({
      reports: [
        {
          _id: REPORT_ID,
          catId: CAT_ID,
          catName: '斑斑',
          type: 'info_error',
          status: 'pending',
          createTime: Date.now()
        },
        {
          _id: 'e'.repeat(24),
          catId: CAT2_ID,
          catName: '困困',
          type: 'injured',
          status: 'pending',
          createTime: Date.now()
        }
      ]
    });

    const byType = await main({ action: 'list', type: 'injured' });
    expect(byType.data.items).toHaveLength(1);
    expect(byType.data.items[0].catName).toBe('困困');

    const byCat = await main({ action: 'list', catId: CAT_ID });
    expect(byCat.data.items).toHaveLength(1);
    expect(byCat.data.items[0].catName).toBe('斑斑');
  });

  test('stats 汇总状态、近 7/30 天、类型分布与高频猫咪', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const { main } = setup({
      reports: [
        { _id: '1'.repeat(24), catId: CAT_ID, catName: '斑斑', type: 'info_error', status: 'pending', createTime: now - day },
        { _id: '2'.repeat(24), catId: CAT_ID, catName: '斑斑', type: 'info_error', status: 'resolved', createTime: now - 2 * day },
        { _id: '3'.repeat(24), catId: CAT2_ID, catName: '困困', type: 'injured', status: 'pending', createTime: now - 10 * day },
        { _id: '4'.repeat(24), catId: CAT3_ID, catName: '小橘', type: 'other', status: 'pending', createTime: now - 40 * day }
      ]
    });

    const res = await main({ action: 'stats' });

    expect(res.success).toBe(true);
    expect(res.data.total).toBe(4);
    expect(res.data.status).toEqual({ pending: 3, resolved: 1, rejected: 0 });
    expect(res.data.recent.days7).toBe(2);
    expect(res.data.recent.days30).toBe(3);
    expect(res.data.byType).toEqual([
      { type: 'info_error', count: 2 },
      { type: 'injured', count: 1 },
      { type: 'other', count: 0 }
    ]);
    // 只有同一只猫在窗口内被反馈 ≥ 2 次才算「高频」
    expect(res.data.topCats).toEqual([
      expect.objectContaining({ catId: CAT_ID, catName: '斑斑', count: 2 })
    ]);
  });
});
