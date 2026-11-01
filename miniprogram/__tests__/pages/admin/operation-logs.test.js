/**
 * __tests__/pages/admin/operation-logs.test.js
 *
 * 回归（2026-10-06）：
 *   1. 请求序号守卫 —— 旧筛选的「加载更多」响应晚到时必须整体丢弃，
 *      不得 append 进新筛选结果、不得回写旧的 page/total/hasMore；
 *   2. 「加载更多」失败时回滚页码（否则重试跳过整页）；
 *   3. 页面门禁：普通管理员被拦下并延迟返回（不能停留在骨架屏）。
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn()
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin')
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

const mockCallAdminFunction = jest.fn();

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/operation-logs/operation-logs');
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let target = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = updates[key];
    } else {
      data[key] = updates[key];
    }
  }
}

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    safeSetData: function(updates) { applySetData(this.data, updates); },
    _isUnmounted: false,
    callAdminFunction: (...args) => mockCallAdminFunction(...args),
    // 同 adminBehavior.js:53-60（createInstance 不应用 behavior，这里按其语义补直通实现）
    goBack: () => {
      if (global.getCurrentPages().length > 1) wx.navigateBack();
      else wx.redirectTo({ url: '/pages/admin/admin' });
    }
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

function makeLogsResponse(ids, { total = ids.length, page = 1, hasMore = false } = {}) {
  return {
    result: {
      success: true,
      data: { logs: ids.map(id => ({ _id: id, action: 'edit', module: 'cat' })), total, page, hasMore, stats: {} }
    }
  };
}

describe('operation-logs page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
    mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
    mockCallAdminFunction.mockReset();
  });

  // 3.8.0 新增日志模块（识猫建档 / 内容复核）必须可筛选；
  // 服务端白名单与前端下拉是两份清单，任何一份漏了都会退化成「显示英文原文」。
  test('模块筛选覆盖内容复核', () => {
    const values = pageDef.data.modules.map(m => m.value);
    expect(values).toEqual(expect.arrayContaining(['mediaCheck']));
    expect(pageDef.data.modulesLabels).toEqual(expect.arrayContaining(['内容复核']));
  });

  // FE-30：失败过去没有独立状态，catch 后只把 loading 置 false，
  // 于是「取不到日志」和「确实没有日志」共用同一个空态 ——
  // 管理员会看到「暂无操作日志」，据此误判系统没问题。
  describe('加载失败态（loadFailed）', () => {
    test('请求抛错时置 loadFailed，而不是伪装成空列表', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockRejectedValue(new Error('boom'));

      await inst.loadLogs(true);

      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.loading).toBe(false);
      expect(inst.data.collectionNotExists).toBe(false);
    });

    test('success=false 时同样置 loadFailed', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockResolvedValue({ result: { success: false, error: '查询失败' } });

      await inst.loadLogs(true);

      expect(inst.data.loadFailed).toBe(true);
    });

    test('成功加载后 loadFailed 归零（失败态不能粘住）', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockRejectedValue(new Error('boom'));
      await inst.loadLogs(true);
      expect(inst.data.loadFailed).toBe(true);

      mockCallAdminFunction.mockResolvedValue(makeLogsResponse(['a1']));
      await inst.loadLogs(true);
      expect(inst.data.loadFailed).toBe(false);
    });

    test('onRetryLoad 重新拉取并清掉失败态', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockRejectedValue(new Error('boom'));
      await inst.loadLogs(true);

      mockCallAdminFunction.mockResolvedValue(makeLogsResponse(['a1']));
      inst.onRetryLoad();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(inst.data.loadFailed).toBe(false);
    });
  });

  // 模板层：两个空态必须互斥，且失败态带重试
  describe('空态互斥（wxml 契约）', () => {
    const fs = require('fs');
    const path = require('path');
    const wxml = fs.readFileSync(
      path.resolve(__dirname, '../../../pages/admin/operation-logs/operation-logs.wxml'),
      'utf8'
    );

    test('失败态要求 loadFailed 且带重试入口', () => {
      expect(wxml).toMatch(/!loading && loadFailed && logs\.length === 0/);
      expect(wxml).toContain('bindaction="onRetryLoad"');
    });

    test('「暂无操作日志」态必须排除 loadFailed', () => {
      // 少了 !loadFailed，失败时两态同屏，用户会同时看到「加载失败」和「暂无日志」
      expect(wxml).toMatch(/!loading && !loadFailed && logs\.length === 0/);
    });

    test('失败态没有落回 collectionNotExists 分支（那是另一个故障）', () => {
      expect(wxml).not.toMatch(/loadFailed && logs\.length === 0 && collectionNotExists/);
    });
  });

  // ── 摘要层渲染 ────────────────────────────────────────────────────────
  // 列表标题读 displaySummary（服务端算好的人话），不再直接读 description。
  describe('摘要层渲染（summary / changes）', () => {
    function respondWith(logs) {
      mockCallAdminFunction.mockResolvedValue({
        result: { success: true, data: { logs, total: logs.length, page: 1, hasMore: false, stats: {} } }
      });
    }

    test('有 summary 时标题用摘要（回答「改了啥」）', async () => {
      const inst = createInstance();
      respondWith([{
        _id: 'l1', module: 'cat', action: 'edit',
        description: '编辑猫咪: 小花',
        summary: '编辑猫咪「小花」：状态 在校 → 走失',
        changes: [{ label: '状态', from: '在校', to: '走失' }]
      }]);

      await inst.loadLogs(true);

      expect(inst.data.logs[0].displaySummary).toBe('编辑猫咪「小花」：状态 在校 → 走失');
      expect(inst.data.logs[0].changes).toEqual([{ label: '状态', from: '在校', to: '走失' }]);
    });

    test('老日志没有 summary 时回退 description（90 天内的历史记录不能显示空白）', async () => {
      const inst = createInstance();
      respondWith([{ _id: 'old', module: 'photo', action: 'create', description: '上传照片: 小花' }]);

      await inst.loadLogs(true);

      expect(inst.data.logs[0].displaySummary).toBe('上传照片: 小花');
      // changes 降级为空数组，wxml 可以无脑 .length / wx:for
      expect(inst.data.logs[0].changes).toEqual([]);
    });

    test('summary 与 description 都缺失时降级为空串，不产生 undefined', async () => {
      const inst = createInstance();
      respondWith([{ _id: 'bare', module: 'system', action: 'login' }]);

      await inst.loadLogs(true);

      expect(inst.data.logs[0].displaySummary).toBe('');
      expect(inst.data.logs[0].changes).toEqual([]);
    });

    test('changes 非数组（脏数据）降级为空数组，不让 wxml 渲染炸掉', async () => {
      const inst = createInstance();
      respondWith([{ _id: 'bad', module: 'cat', action: 'edit', changes: { label: 'x' } }]);

      await inst.loadLogs(true);

      expect(Array.isArray(inst.data.logs[0].changes)).toBe(true);
      expect(inst.data.logs[0].changes).toEqual([]);
    });

    test('不再生成 beforeDataStr / afterDataStr（原始 JSON 已从界面移除）', async () => {
      const inst = createInstance();
      respondWith([{
        _id: 'l1', module: 'cat', action: 'edit',
        beforeData: { name: '小花' }, afterData: { name: '小花生' }
      }]);

      await inst.loadLogs(true);

      expect(inst.data.logs[0].beforeDataStr).toBeUndefined();
      expect(inst.data.logs[0].afterDataStr).toBeUndefined();
    });

    test('wxml：标题读 displaySummary，变更明细读 changes', () => {
      const fs = require('fs');
      const path = require('path');
      const wxml = fs.readFileSync(
        path.resolve(__dirname, '../../../pages/admin/operation-logs/operation-logs.wxml'),
        'utf8'
      );

      expect(wxml).toContain('{{item.displaySummary}}');
      expect(wxml).toContain('wx:for="{{item.changes}}"');
    });

    test('wxml：原始 JSON 的「数据对比」已彻底移除', () => {
      const fs = require('fs');
      const path = require('path');
      const wxml = fs.readFileSync(
        path.resolve(__dirname, '../../../pages/admin/operation-logs/operation-logs.wxml'),
        'utf8'
      );
      // 先剥注释：改动说明里会提到「数据对比」这几个字，
      // 直接全文匹配会把注释当成界面元素，让这条断言永远无法通过。
      const markup = wxml.replace(/<!--[\s\S]*?-->/g, '');

      // 审计数据仍写云端，只是不再上界面；以下任一复活即说明改动被回退
      expect(markup).not.toContain('数据对比');
      expect(markup).not.toContain('data-compare');
      expect(markup).not.toContain('beforeDataStr');
      expect(markup).not.toContain('afterDataStr');
      expect(markup).not.toContain('变更前');
      expect(markup).not.toContain('变更后');
    });
  });

  test('旧筛选的「加载更多」响应晚到：整体丢弃，不混入新筛选结果', async () => {
    const inst = createInstance({ hasMore: true, page: 1 });

    let resolveOld;
    mockCallAdminFunction.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const pendingOld = inst.loadLogs(false); // 旧筛选的第 2 页在途

    // 新筛选（reset）先落地
    mockCallAdminFunction.mockResolvedValueOnce(makeLogsResponse(['new1']));
    await inst.loadLogs(true);
    expect(inst.data.logs.map(l => l._id)).toEqual(['new1']);

    // 旧响应此刻才返回：必须被序号守卫丢弃
    resolveOld(makeLogsResponse(['old1'], { total: 99, page: 2, hasMore: true }));
    await pendingOld;

    expect(inst.data.logs.map(l => l._id)).toEqual(['new1']);
    expect(inst.data.page).toBe(1);
    expect(inst.data.total).toBe(1);
    expect(inst.data.hasMore).toBe(false);
  });

  test('加载更多失败时回滚页码（重试不再跳过整页）', async () => {
    const inst = createInstance({ hasMore: true, page: 1, loading: false });
    inst.loadLogs = jest.fn(() => Promise.resolve(false));

    inst.loadMore();
    await Promise.resolve();
    await Promise.resolve();

    expect(inst.data.page).toBe(1);
  });

  test('加载更多成功时页码推进', async () => {
    const inst = createInstance({ hasMore: true, page: 1, loading: false });
    inst.loadLogs = jest.fn(() => Promise.resolve(true));

    inst.loadMore();
    await Promise.resolve();
    await Promise.resolve();

    expect(inst.data.page).toBe(2);
  });

  test('筛选重置期间失败：不回滚（新请求已接管分页状态）', async () => {
    const inst = createInstance({ hasMore: true, page: 2, loading: false });
    // 模拟：loadMore 在途时被 reset 抢占，reset 已把 page 归 1
    inst.loadLogs = jest.fn(() => {
      inst.data.page = 1;
      return Promise.resolve(false);
    });

    inst.loadMore();
    await Promise.resolve();
    await Promise.resolve();

    expect(inst.data.page).toBe(1);
  });

  test('未开通 logs 权限：页面门禁拦下并延迟返回', async () => {
    const inst = createInstance();
    inst.guardPermission = jest.fn(() => false);

    await inst.onLoad();

    expect(inst.guardPermission).toHaveBeenCalledWith('logs', '操作日志');
    expect(mockCallAdminFunction).not.toHaveBeenCalled();
  });
});
