/**
 * 回归：reconcileMeetCount 的「actual <= stored」分支必须关闭日志。
 *
 * 旧实现直接 return（保持 reconciled !== true）：
 *   - 每轮对账都会把这些陈旧日志重新扫出来；
 *   - 扫描是 .limit(500) 且无 orderBy，取哪 500 条不确定；
 *   - 陈旧日志堆积超过 500 条后，新产生的 mismatch 可能永远排不进窗口，
 *     对账静默失效。
 *
 * 现在的契约：不倒退覆写计数（P2-8），但把日志按「已按规则处理」关闭，
 * 并写入 reconciledNote 说明原因；计数后续若再次偏低，recordMeet 会写新日志。
 */
jest.mock('wx-server-sdk');

function makeFakeDb() {
  const updates = { cat: [], log: [] };

  const repairLogs = {
    where: jest.fn(() => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: [{ _id: 'log1', catId: 'cat1', type: 'meetCount_mismatch' }]
        }))
      }))
    })),
    doc: jest.fn(id => ({
      update: jest.fn(payload => {
        updates.log.push({ id, payload });
        return Promise.resolve({ stats: { updated: 1 } });
      })
    }))
  };

  const recordMeet = {
    where: jest.fn(() => ({
      count: jest.fn(() => Promise.resolve({ total: 3 }))
    }))
  };

  const cats = {
    doc: jest.fn(id => ({
      get: jest.fn(() => Promise.resolve({ data: { _id: id, meetCount: 5 } })),
      update: jest.fn(payload => {
        updates.cat.push({ id, payload });
        return Promise.resolve({ stats: { updated: 1 } });
      })
    }))
  };

  const systemState = {
    where: jest.fn(() => ({
      limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
    })),
    add: jest.fn(() => Promise.resolve({ _id: 'state-id' })),
    doc: jest.fn(() => ({ update: jest.fn(() => Promise.resolve({ stats: { updated: 1 } })) }))
  };

  return {
    updates,
    db: {
      collection: jest.fn(name => {
        if (name === 'repair_logs') return repairLogs;
        if (name === 'recordMeet') return recordMeet;
        if (name === 'cats') return cats;
        return systemState;
      }),
      command: { neq: jest.fn(v => v) },
      serverDate: jest.fn(() => 'SERVER_DATE')
    }
  };
}

describe('reconcileMeetCount：计数已自愈的日志必须关闭', () => {
  test('actual <= stored 时不覆写计数，但日志按「无需修复」关闭并留原因', async () => {
    jest.resetModules();
    const cloud = require('wx-server-sdk');
    cloud.getWXContext.mockReturnValue({ OPENID: '', SOURCE: 'wx_trigger', ENV: 'env' });
    const fake = makeFakeDb();
    cloud.database.mockReturnValue(fake.db);

    const { main } = require('../../cloudfunctions/reconcileMeetCount/index');
    const res = await main({ Type: 'Timer', TriggerName: 'reconcileTimer' }, {});

    expect(res.success).toBe(true);
    expect(res.data.results.skipped).toBe(1);
    // 关键 1：绝不把计数改小
    expect(fake.updates.cat).toHaveLength(0);
    // 关键 2：日志被关闭（否则陈旧日志会永久占用 500 条扫描窗口）
    expect(fake.updates.log).toHaveLength(1);
    expect(fake.updates.log[0].id).toBe('log1');
    expect(fake.updates.log[0].payload.data.reconciled).toBe(true);
    expect(fake.updates.log[0].payload.data.reconciledNote).toContain('actual<=stored');
  });
});
