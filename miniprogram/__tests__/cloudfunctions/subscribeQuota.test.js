/**
 * __tests__/cloudfunctions/subscribeQuota.test.js
 * 覆盖推送次数账本发送侧消费：配额查询（含分页）、历史记录查询、
 * 发送对账（-1 / 消费历史记录 / 43101 清零 / 非 43101 不动账本）。
 */
const subscribeQuota = require('../../cloudfunctions/utils/subscribeQuota');

const TEMPLATE = 'tmpl-status';

function makeCommand() {
  return {
    gt: jest.fn(v => ({ $gt: v })),
    in: jest.fn(v => ({ $in: v })),
    inc: jest.fn(v => ({ $inc: v }))
  };
}

describe('subscribeQuota（发送侧消费）', () => {
  describe('isNoQuotaError', () => {
    test('43101（errCode / errcode 两种字段）判定为无可用授权', () => {
      expect(subscribeQuota.isNoQuotaError({ errCode: 43101 })).toBe(true);
      expect(subscribeQuota.isNoQuotaError({ errcode: 43101 })).toBe(true);
      expect(subscribeQuota.isNoQuotaError(new Error('网络抖动'))).toBe(false);
      expect(subscribeQuota.isNoQuotaError(null)).toBe(false);
    });
  });

  describe('fetchQuotaMap', () => {
    test('按 openid 批量查询：去重、条件含 remaining>0', async () => {
      const command = makeCommand();
      const get = jest.fn(() => Promise.resolve({ data: [{ _id: 'q1', _openid: 'u1', remaining: 3 }] }));
      const limit = jest.fn(() => ({ get }));
      const where = jest.fn(() => ({ limit }));
      const db = { command, collection: jest.fn(() => ({ where })) };

      const map = await subscribeQuota.fetchQuotaMap(db, TEMPLATE, ['u1', 'u2', 'u1']);
      expect(map.get('u1')).toEqual({ rowId: 'q1', remaining: 3 });
      expect(where).toHaveBeenCalledTimes(1);
      const cond = where.mock.calls[0][0];
      expect(cond.templateId).toBe(TEMPLATE);
      expect(cond.remaining).toEqual({ $gt: 0 });
      expect(cond._openid).toEqual({ $in: ['u1', 'u2'] });
    });

    test('openid 为空数组：直接返回空 Map，不查询', async () => {
      const db = { command: makeCommand(), collection: jest.fn() };
      const map = await subscribeQuota.fetchQuotaMap(db, TEMPLATE, []);
      expect(map.size).toBe(0);
      expect(db.collection).not.toHaveBeenCalled();
    });

    test('全量模式：游标分页拉取多页并带上游标条件', async () => {
      const command = makeCommand();
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        _id: `q${String(i).padStart(3, '0')}`,
        _openid: `u${i}`,
        remaining: 1
      }));
      const page2 = [{ _id: 'q100', _openid: 'u100', remaining: 2 }];
      const get = jest.fn()
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });
      const limit = jest.fn(() => ({ get }));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const db = { command, collection: jest.fn(() => ({ where })) };

      const map = await subscribeQuota.fetchQuotaMap(db, TEMPLATE);
      expect(map.size).toBe(101);
      expect(map.get('u100')).toEqual({ rowId: 'q100', remaining: 2 });
      expect(where).toHaveBeenCalledTimes(2);
      // 第二页带游标：只取大于上一页最后一条 _id 的记录
      expect(where.mock.calls[1][0]._id).toEqual({ $gt: 'q099' });
    });
  });

  describe('fetchLegacyByOpenid', () => {
    test('返回 openid -> 记录（含 _id，供消费删除）', async () => {
      const command = makeCommand();
      const get = jest.fn(() => Promise.resolve({ data: [{ _id: 'l1', _openid: 'u1' }] }));
      const limit = jest.fn(() => ({ get }));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const db = { command, collection: jest.fn(() => ({ where })) };

      const map = await subscribeQuota.fetchLegacyByOpenid(db, { status: 'accept' });
      expect(map.get('u1')).toEqual({ _id: 'l1', _openid: 'u1' });
    });
  });

  describe('dispatchWithQuota', () => {
    function makeDb() {
      const docUpdate = jest.fn(() => Promise.resolve({}));
      const docRemove = jest.fn(() => Promise.resolve({}));
      const whereUpdate = jest.fn(() => Promise.resolve({}));
      return {
        db: {
          command: makeCommand(),
          serverDate: jest.fn(() => 'SERVER_DATE'),
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ update: docUpdate, remove: docRemove })),
            where: jest.fn(() => ({ update: whereUpdate }))
          }))
        },
        docUpdate,
        docRemove,
        whereUpdate
      };
    }

    test('无任何候选：不调用 sendFn', async () => {
      const { db } = makeDb();
      const sendFn = jest.fn();
      const n = await subscribeQuota.dispatchWithQuota({
        db, templateId: TEMPLATE, quotaMap: new Map(), legacyByOpenid: new Map(), sendFn
      });
      expect(n).toBe(0);
      expect(sendFn).not.toHaveBeenCalled();
    });

    test('有配额：发送成功后原子 -1', async () => {
      const { db, docUpdate, docRemove } = makeDb();
      const sendFn = jest.fn(() => Promise.resolve());
      const n = await subscribeQuota.dispatchWithQuota({
        db,
        templateId: TEMPLATE,
        quotaMap: new Map([['u1', { rowId: 'q1', remaining: 3 }]]),
        legacyByOpenid: new Map(),
        sendFn
      });
      expect(n).toBe(1);
      expect(sendFn).toHaveBeenCalledWith('u1');
      expect(docUpdate).toHaveBeenCalledTimes(1);
      expect(docUpdate.mock.calls[0][0].data.remaining).toEqual({ $inc: -1 });
      expect(docRemove).not.toHaveBeenCalled();
    });

    test('无配额有历史记录：发送成功后消费（删除）该记录', async () => {
      const { db, docUpdate, docRemove } = makeDb();
      const sendFn = jest.fn(() => Promise.resolve());
      await subscribeQuota.dispatchWithQuota({
        db,
        templateId: TEMPLATE,
        quotaMap: new Map(),
        legacyByOpenid: new Map([['u2', { _id: 'l2', _openid: 'u2' }]]),
        sendFn
      });
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(docRemove).toHaveBeenCalledTimes(1);
      expect(docUpdate).not.toHaveBeenCalled();
    });

    test('配额优先于历史记录：同时存在时扣配额、不删历史', async () => {
      const { db, docUpdate, docRemove } = makeDb();
      const sendFn = jest.fn(() => Promise.resolve());
      await subscribeQuota.dispatchWithQuota({
        db,
        templateId: TEMPLATE,
        quotaMap: new Map([['u1', { rowId: 'q1', remaining: 1 }]]),
        legacyByOpenid: new Map([['u1', { _id: 'l1', _openid: 'u1' }]]),
        sendFn
      });
      expect(docUpdate).toHaveBeenCalledTimes(1);
      expect(docRemove).not.toHaveBeenCalled();
    });

    test('发送失败 43101：清零配额并回收历史记录，不扣减', async () => {
      const { db, docUpdate, docRemove, whereUpdate } = makeDb();
      const sendFn = jest.fn(() => Promise.reject({ errCode: 43101, message: 'no quota' }));
      await subscribeQuota.dispatchWithQuota({
        db,
        templateId: TEMPLATE,
        quotaMap: new Map([['u1', { rowId: 'q1', remaining: 2 }]]),
        legacyByOpenid: new Map([['u1', { _id: 'l1', _openid: 'u1' }]]),
        sendFn
      });
      expect(docUpdate).not.toHaveBeenCalled();
      expect(whereUpdate).toHaveBeenCalledTimes(1);
      expect(whereUpdate.mock.calls[0][0].data.remaining).toBe(0);
      expect(docRemove).toHaveBeenCalledTimes(1);
    });

    test('发送失败（非 43101）：只告警，不动账本', async () => {
      const { db, docUpdate, docRemove, whereUpdate } = makeDb();
      const sendFn = jest.fn(() => Promise.reject(new Error('network')));
      await subscribeQuota.dispatchWithQuota({
        db,
        templateId: TEMPLATE,
        quotaMap: new Map([['u1', { rowId: 'q1', remaining: 2 }]]),
        legacyByOpenid: new Map(),
        sendFn
      });
      expect(docUpdate).not.toHaveBeenCalled();
      expect(whereUpdate).not.toHaveBeenCalled();
      expect(docRemove).not.toHaveBeenCalled();
    });
  });
});
