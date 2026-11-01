/**
 * __tests__/cloudfunctions/mediaCheckCallback.test.js
 *
 * 覆盖多媒体内容安全异步回调（wxa_media_check）：
 *   - 鉴权不变量：只认「命中 pending 待检记录」的 trace_id（挡伪造与重复投递）
 *   - 事件解析容错：字段大小写、result 为字符串 JSON、事件体在 event.body
 *   - 处置策略：pass 不打扰；review/risky 打标记 + 写操作日志；未知取值按 review
 *   - 打标记只作用于白名单集合，且 refId 必须像合法 _id
 */
jest.mock('wx-server-sdk');

const STATUS_TMPL = 'tmpl-status';

describe('mediaCheckCallback 云函数', () => {
  let cloud;
  let db;
  let collections;
  let updates;
  let logOperation;
  let main;

  /**
   * @param {object} opts
   * @param {Array} opts.pending 待检记录（命中则处置，否则视为伪造/重复投递）
   * @param {string} opts.markFail 打标记时报错的集合名
   */
  function setup({ pending = [], markFail = '', currentAvatar = null } = {}) {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    updates = {};
    collections = {};

    const makeChain = (name) => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ data: name === 'mediaChecks' ? pending : [] }))
        }))
      })),
      doc: jest.fn((id) => ({
        get: jest.fn(() => Promise.resolve({
          data: pending[0] ? {
            avatar: currentAvatar === null ? pending[0].fileID : currentAvatar
          } : {}
        })),
        update: jest.fn((payload) => {
          if (name === markFail) return Promise.reject(new Error('目标已删除'));
          updates[name] = updates[name] || [];
          updates[name].push({ id, ...payload.data });
          return Promise.resolve({ stats: { updated: 1 } });
        })
      })),
      add: jest.fn(() => Promise.resolve({ _id: 'new-id' }))
    });

    db = {
      collection: jest.fn((name) => {
        collections[name] = makeChain(name);
        return collections[name];
      }),
      serverDate: jest.fn(() => 'SERVER_DATE'),
      command: {
        in: jest.fn(v => v), gt: jest.fn(v => v), neq: jest.fn(v => v),
        inc: jest.fn(v => v), exists: jest.fn(v => v), gte: jest.fn(v => v)
      }
    };
    cloud.database.mockReturnValue(db);
    cloud.getWXContext.mockReturnValue({ OPENID: '' });

    logOperation = jest.fn(() => Promise.resolve('log-id'));
    jest.doMock('../../cloudfunctions/mediaCheckCallback/common/operationLogger', () => ({ logOperation }));
    jest.doMock('../../cloudfunctions/mediaCheckCallback/utils/response', () => ({
      ok: (data, message) => ({ success: true, data: data || null, message: message || '' }),
      fail: (error) => ({ success: false, data: null, message: '', error: error || '未知错误' })
    }));

    main = require('../../cloudfunctions/mediaCheckCallback/index').main;
    return { collections, updates };
  }

  afterEach(() => {
    jest.dontMock('../../cloudfunctions/mediaCheckCallback/common/operationLogger');
    jest.dontMock('../../cloudfunctions/mediaCheckCallback/utils/response');
  });

  const pendingOf = (over = {}) => ({
    _id: 'mc-1',
    traceId: 'trace-1',
    status: 'pending',
    target: 'photo',
    refId: 'a'.repeat(24),
    fileID: 'cloud://env/photos/1.jpg',
    openid: 'user-1',
    ...over
  });

  test('事件缺少 trace_id → 拒绝且不查库', async () => {
    setup();
    const res = await main({ Event: 'wxa_media_check', result: { suggest: 'risky' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('trace_id');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('无待检记录（伪造或重复投递）→ 忽略，不做任何处置', async () => {
    setup({ pending: [] });
    const res = await main({ trace_id: 'trace-x', result: { suggest: 'risky', label: 20001 } }, {});
    expect(res.success).toBe(true);
    expect(res.data.skipped).toBe(true);
    expect(collections.photos).toBeUndefined();
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('pass → 只落状态，不打扰管理员', async () => {
    setup({ pending: [pendingOf()] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'pass', label: 100 } }, {});
    expect(res.success).toBe(true);
    expect(res.data.decision).toBe('pass');
    expect(updates.mediaChecks[0].status).toBe('pass');
    expect(updates.photos).toBeUndefined();
    expect(logOperation).not.toHaveBeenCalled();
  });

  test('risky → 给照片打 _mediaBlocked 标记 + 写操作日志', async () => {
    setup({ pending: [pendingOf()] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'risky', label: 20001 } }, {});
    expect(res.data.decision).toBe('risky');
    expect(res.data.marked).toBe(true);
    expect(updates.photos[0].id).toBe('a'.repeat(24));
    expect(updates.photos[0]._mediaBlocked).toBe(true);
    expect(updates.photos[0].mediaCheckTraceId).toBe('trace-1');
    expect(logOperation).toHaveBeenCalledWith(
      expect.anything(), '',
      expect.objectContaining({ module: 'mediaCheck', action: 'risky', result: 'fail' })
    );
  });

  test('review → 打 _mediaReview 标记（不阻断）+ 留痕', async () => {
    setup({ pending: [pendingOf({ target: 'avatar' })] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'review', label: 20002 } }, {});
    expect(res.data.decision).toBe('review');
    expect(updates.cats[0]._mediaReview).toBe(true);
    expect(updates.cats[0]._mediaBlocked).toBeUndefined();
    expect(logOperation).toHaveBeenCalled();
  });

  test('risky 头像：立即清空当前头像，避免继续公开展示', async () => {
    setup({
      pending: [pendingOf({ target: 'avatar', fileID: 'cloud://env/cats/a.jpg' })]
    });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'risky', label: 20001 } }, {});

    expect(res.data.decision).toBe('risky');
    expect(updates.cats[0]._mediaBlocked).toBe(true);
    expect(updates.cats[0].avatar).toBe('');
  });

  test('risky 头像已被管理员换新：只打标记，不能误清新头像', async () => {
    setup({
      pending: [pendingOf({ target: 'avatar', fileID: 'cloud://env/cats/old.jpg' })],
      currentAvatar: 'cloud://env/cats/new.jpg'
    });
    await main({ trace_id: 'trace-1', result: { suggest: 'risky', label: 20001 } }, {});

    expect(updates.cats[0]._mediaBlocked).toBe(true);
    expect(updates.cats[0].avatar).toBeUndefined();
  });

  test('未知 suggest 取值按 review 处理（保守）', async () => {
    setup({ pending: [pendingOf()] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'weird_value' } }, {});
    expect(res.data.decision).toBe('review');
    expect(updates.mediaChecks[0].status).toBe('review');
  });

  test('target 不在白名单 → 不碰任何业务集合，只留痕', async () => {
    setup({ pending: [pendingOf({ target: 'exports' })] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'risky' } }, {});
    expect(res.data.marked).toBe(false);
    expect(collections.exports).toBeUndefined();
    expect(logOperation).toHaveBeenCalled();
  });

  test('refId 非法（疑似注入 / 非合法 _id）→ 不写业务对象', async () => {
    setup({ pending: [pendingOf({ refId: '../../admins' })] });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'risky' } }, {});
    expect(res.data.marked).toBe(false);
    expect(collections.photos).toBeUndefined();
  });

  test('事件体在 event.body（HTTP 触发器）且 result 为字符串 JSON 也能解析', async () => {
    setup({ pending: [pendingOf()] });
    const body = {
      TraceId: 'trace-1',
      result: JSON.stringify({ suggest: 'risky', label: 20001 })
    };
    const res = await main({ body: JSON.stringify(body) }, {});
    expect(res.data.decision).toBe('risky');
    expect(updates.photos[0]._mediaBlocked).toBe(true);
  });

  test('event.body 不是 JSON 时不抛错（按无 trace_id 处理）', async () => {
    setup();
    const res = await main({ body: 'not-json' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('trace_id');
  });

  test('处置对象已不存在（打标记失败）→ 判定仍落库，不整体失败', async () => {
    setup({ pending: [pendingOf()], markFail: 'photos' });
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'risky' } }, {});
    expect(res.success).toBe(true);
    expect(res.data.decision).toBe('risky');
    expect(res.data.marked).toBe(false);
    expect(updates.mediaChecks[0].status).toBe('risky');
    expect(logOperation).toHaveBeenCalled();
  });

  test('查库异常 → 返回失败但不影响微信重投', async () => {
    setup();
    db.collection.mockImplementation(() => ({ where: jest.fn(() => { throw new Error('db down'); }) }));
    const res = await main({ trace_id: 'trace-1', result: { suggest: 'pass' } }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('回调处理失败');
  });

  test('订阅模板 ID 不应出现在回调里（避免把模板常量当处置依据）', async () => {
    setup({ pending: [pendingOf()] });
    await main({ trace_id: 'trace-1', result: { suggest: 'risky' } }, {});
    const logged = logOperation.mock.calls[0][2];
    expect(JSON.stringify(logged)).not.toContain(STATUS_TMPL);
  });
});