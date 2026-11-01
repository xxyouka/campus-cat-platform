const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn(),
  handleValidationError: jest.fn(),
  handleNetworkError: jest.fn(),
  callCloudFunction: jest.fn((name, data, timeout) => wx.cloud.callFunction({ name, data, timeout }))
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  clearAdminAuth: jest.fn(),
  getAdminRole: jest.fn(() => 'superadmin'),
  isSuperAdminLevel: jest.fn(() => true),
  isFounder: jest.fn(() => false),
  getAdminPermissions: jest.fn(() => [
    'ops', 'addCat', 'photo', 'cat', 'notice', 'relation',
    'logs', 'catActivity', 'mediaReview', 'report'
  ]),
  hasAdminPermission: jest.fn(() => true),
  checkAdminAuth: jest.fn(() => true),
  checkAdminAuthAsync: jest.fn(() => Promise.resolve({ verified: true })),
  setAdminAuth: jest.fn(),
  refreshSignature: jest.fn()
};
const mockObsHelper = {
  reportEvent: jest.fn(),
  EVENT_NAMES: { ADMIN_LOGIN: 'admin_login', ADMIN_ADD_CAT: 'admin_add_cat' },
  isAvailable: jest.fn(),
  trySetup: jest.fn()
};

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../utils/obsHelper', () => mockObsHelper);
jest.mock('../../../behaviors/backToTopBehavior', () => ({}));
const mockCallAdminFunction = jest.fn();
const mockVerifyAdmin = jest.fn(() => Promise.resolve(true));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: (...args) => mockVerifyAdmin(...args),
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/admin');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
  mockAdminAuth.isSuperAdminLevel.mockReturnValue(true);
  mockAdminAuth.isFounder.mockReturnValue(false);
  mockCallAdminFunction.mockImplementation((name, data) => wx.cloud.callFunction({ name, data }));
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.getStorageSync.mockReturnValue('');
  wx.showNavigationBarLoading = jest.fn();
  wx.hideNavigationBarLoading = jest.fn();
  wx.downloadFile = jest.fn();
  wx.openDocument = jest.fn();
  wx.setClipboardData = jest.fn();
  wx.showModal.mockReset();
  wx.showModal.mockImplementation((opts) => {
    if (opts.success) opts.success({ confirm: false, cancel: true });
    return Promise.resolve({ confirm: false, cancel: true });
  });
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
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      applySetData(this.data, updates);
    }),
    _backToTopThreshold: 400,
    _initialLoadDone: false,
    _exportTypeNames: pageDef._exportTypeNames,
    callAdminFunction: (name, data) => wx.cloud.callFunction({ name, data }),
    verifyAdmin: () => Promise.resolve(true),
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
  if (typeof inst._applyAdminPermissions === 'function') inst._applyAdminPermissions();
  return inst;
}

describe('admin page', () => {
  describe('onLoad', () => {
    it('should load stats when auth passes', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'getAdminStats') {
          return Promise.resolve({ result: { success: true, data: { stats: { totalCats: 10, totalPhotos: 20, totalMeets: 5, totalFavorites: 3 } } } });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.onLoad();

      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.data.isSuperAdmin).toBe(true);
      expect(mockObsHelper.reportEvent).toHaveBeenCalledWith('admin_login', {});
      expect(inst.data.loading).toBe(false);
      expect(inst.data.stats.totalCats).toBe(10);
      expect(inst._initialLoadDone).toBe(true);
      // 爱心支持统计没有任何展示方：不得再为此多发一次昂贵的 getDonations 聚合
      expect(wx.cloud.callFunction).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'getDonations' })
      );
    });

    it('should expose only granted entries for a normal admin', () => {
      mockAdminAuth.getAdminRole.mockReturnValue('admin');
      mockAdminAuth.isSuperAdminLevel.mockReturnValue(false);
      mockAdminAuth.getAdminPermissions.mockReturnValue(['addCat', 'cat', 'photo']);

      const inst = createInstance();

      expect(inst.data.isSuperAdmin).toBe(false);
      expect(inst.data.can.addCat).toBe(true);
      expect(inst.data.can.cat).toBe(true);
      expect(inst.data.can.photo).toBe(true);
      expect(inst.data.can.mediaReview).toBe(false);
      // 管理员管理不参与入口权限：普通管理员永远没有这个 key
      expect(inst.data.can.admins).toBeUndefined();

      // 恢复给后续用例（clearAllMocks 不会重置 mockReturnValue）
      mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
      mockAdminAuth.getAdminPermissions.mockReturnValue([
        'ops', 'addCat', 'photo', 'cat', 'notice', 'relation',
        'logs', 'catActivity', 'mediaReview', 'report'
      ]);
    });

    it('founder 与超管同级：全部入口开放且带创始人徽章', () => {
      mockAdminAuth.getAdminRole.mockReturnValue('founder');
      mockAdminAuth.isSuperAdminLevel.mockReturnValue(true);
      mockAdminAuth.isFounder.mockReturnValue(true);

      const inst = createInstance();

      expect(inst.data.isSuperAdmin).toBe(true);
      expect(inst.data.isFounder).toBe(true);
      expect(inst.data.can.mediaReview).toBe(true);
      expect(inst.data.can.report).toBe(true);

      // 恢复给后续用例（clearAllMocks 不会重置 mockReturnValue）
      mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
    });

    it('should navigate back when auth fails', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      // goBack 走 navigateBack 分支需要栈深 > 1
      global.getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/admin/admin' }]);
      jest.useFakeTimers();
      await inst.onLoad();
      jest.advanceTimersByTime(1500);
      expect(wx.navigateBack).toHaveBeenCalled();
      jest.useRealTimers();
    });

    // 性能修复（2026-10-14）：本页切换耗时均值 3758ms，首屏 LCP 被「云端鉴权 → 统计」
    // 两个串行云函数拖住。命中本地快照时必须**直接渲染真实内容**，不再回落骨架屏。
    it('命中本地快照时首屏直接渲染，且仍走云端鉴权', async () => {
      const cachedStats = { totalCats: 92, totalPhotos: 955, totalMeets: 1200, totalFavorites: 340 };
      wx.getStorageSync.mockImplementation((key) => {
        if (key === 'adminStatsCache') return { stats: cachedStats, updateTime: '21:11', savedAt: Date.now() };
        return '';
      });
      // 让后台刷新失败：断言到的才是快照本身
      //（刷新成功时「更新于」会被换成当前时间，那是另一条用例的口径）
      wx.cloud.callFunction.mockRejectedValue(new Error('timeout'));

      const inst = createInstance();
      await inst.onLoad();

      expect(inst.data.loading).toBe(false);                 // 不回落到骨架屏
      expect(inst.data.stats.totalCats).toBe(92);             // 首屏就是真实数字，不是 0
      expect(inst.data.updateTime).toBe('21:11');             // 保留快照时间，不谎报刷新
      expect(mockAdminAuth.requireAdminAuth).toHaveBeenCalled(); // 快照不跳过硬门禁
    });

    it('鉴权失败时清掉本地快照（不让无权限者看到聚合数字）', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      global.getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/admin/admin' }]);
      jest.useFakeTimers();
      await inst.onLoad();
      jest.useRealTimers();

      expect(wx.removeStorageSync).toHaveBeenCalledWith('adminStatsCache');
    });

    // 回归保护：管理页作为页面栈首页（短链 / URL Scheme 直达）时，
    // 裸 wx.navigateBack 静默失败 → 用户被留在无权限的后台页退不出去。
    it('should redirect to admin home when page stack has only itself', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      global.getCurrentPages.mockReturnValue([{ route: 'pages/admin/admin' }]);
      jest.useFakeTimers();
      await inst.onLoad();
      jest.advanceTimersByTime(1500);
      expect(wx.navigateBack).not.toHaveBeenCalled();
      expect(wx.redirectTo).toHaveBeenCalledWith({ url: '/pages/admin/admin' });
      jest.useRealTimers();
    });

    it('should set isSuperAdmin false for non-superadmin', async () => {
      mockAdminAuth.getAdminRole.mockReturnValue('admin');
      mockAdminAuth.isSuperAdminLevel.mockReturnValue(false);
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: {} } } });
      await inst.onLoad();
      expect(inst.data.isSuperAdmin).toBe(false);
    });

    it('should handle getWindowInfo error gracefully', async () => {
      wx.getWindowInfo.mockImplementation(() => { throw new Error('fail'); });
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: {} } } });
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(20);
    });
  });

  describe('onShow', () => {
    it('should reload stats when not loading and initial load done', async () => {
      const inst = createInstance({ loading: false, isSuperAdmin: true });
      inst._initialLoadDone = true;
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: { totalCats: 1 } } } });
      await inst.onShow();
      expect(wx.cloud.callFunction).toHaveBeenCalled();
    });

    it('should not reload stats when loading', async () => {
      const inst = createInstance({ loading: true });
      inst._initialLoadDone = true;
      await inst.onShow();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('should not reload stats when initial load not done', async () => {
      const inst = createInstance({ loading: false });
      inst._initialLoadDone = false;
      await inst.onShow();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    // 性能修复（2026-10-14）：本页是「首页 → 子页 → 返回」的折返入口，
    // 每次 onShow 都重拉会让一次管理操作叠加多次云调用。30s 时间窗内不重复拉。
    it('30s 内折返不重复拉统计', async () => {
      const inst = createInstance({ loading: false, isSuperAdmin: true });
      inst._initialLoadDone = true;
      inst._lastStatsLoadedAt = Date.now();
      await inst.onShow();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('超过 30s 的折返才重拉统计', async () => {
      const inst = createInstance({ loading: false, isSuperAdmin: true });
      inst._initialLoadDone = true;
      inst._lastStatsLoadedAt = Date.now() - 31 * 1000;
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: { totalCats: 1 } } } });
      await inst.onShow();
      expect(wx.cloud.callFunction).toHaveBeenCalled();
    });
  });

  describe('统计快照（SWR）', () => {
    it('跨天快照的「更新于」带日期前缀，不假装是刚更新', () => {
      wx.getStorageSync.mockImplementation((key) => {
        if (key === 'adminStatsCache') {
          return { stats: { totalCats: 92 }, updateTime: '', savedAt: Date.now() - 26 * 60 * 60 * 1000 };
        }
        return '';
      });
      const inst = createInstance();
      inst._restoreStatsCache();
      expect(inst.data.updateTime).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(inst.data.stats.totalCats).toBe(92);
    });

    it('本地非管理员时不渲染快照', () => {
      mockAdminAuth.checkAdminAuth.mockReturnValue(false);
      wx.getStorageSync.mockImplementation((key) => {
        if (key === 'adminStatsCache') return { stats: { totalCats: 92 }, updateTime: '21:11', savedAt: Date.now() };
        return '';
      });
      const inst = createInstance();
      inst._restoreStatsCache();
      expect(inst.data.stats.totalCats).toBe(0);
      expect(inst.data.updateTime).toBe('');
    });

    it('快照结构异常时按无缓存处理（不抛错、不渲染）', () => {
      wx.getStorageSync.mockImplementation((key) => {
        if (key === 'adminStatsCache') return 'garbage';
        return '';
      });
      const inst = createInstance();
      expect(() => inst._restoreStatsCache()).not.toThrow();
      expect(inst.data.stats.totalCats).toBe(0);
    });
  });

  describe('loadStats', () => {
    it('should handle stats request failure gracefully', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'getAdminStats') return Promise.reject(new Error('timeout'));
        return Promise.resolve({ result: { success: true, data: { totalAmount: 0, totalCount: 0, averageAmount: 0 } } });
      });
      await inst.loadStats();
      expect(inst.data.loading).toBe(false);
      expect(inst.data.stats.totalCats).toBe(0);
    });

    it('统计请求失败时保留上一份数据与「更新于」，不谎报刷新', async () => {
      const inst = createInstance({
        stats: { totalCats: 7, totalPhotos: 1, totalMeets: 1, totalFavorites: 1 },
        updateTime: '09:00'
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('timeout'));

      const ok = await inst.loadStats();

      expect(ok).toBe(false);
      expect(inst.data.stats.totalCats).toBe(7);    // 旧值保留，不被 0 覆盖
      expect(inst.data.updateTime).toBe('09:00');   // 不刷新时间，避免「假新鲜」
    });

    it('should set updateTime', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: {} } } });
      await inst.loadStats();
      expect(inst.data.updateTime).toMatch(/^\d{2}:\d{2}$/);
    });

    it('统计成功时写本地快照（供下次进后台首屏直出）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: { totalCats: 92 } } } });
      await inst.loadStats();
      expect(wx.setStorageSync).toHaveBeenCalledWith('adminStatsCache', expect.objectContaining({
        stats: { totalCats: 92 },
        updateTime: expect.stringMatching(/^\d{2}:\d{2}$/)
      }));
    });

    it('统计失败时不写快照（不把失败态固化成首屏内容）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('timeout'));
      await inst.loadStats();
      expect(wx.setStorageSync).not.toHaveBeenCalledWith('adminStatsCache', expect.anything());
    });

    // 「更新于」必须跟服务端的**计算时刻**走：服务端有 60s 容器内缓存，
    // 命中时这份数字是 60s 前算的，用本地 Date.now() 会显示成「刚更新」（假新鲜）。
    it('优先用服务端 computedAt 渲染「更新于」', async () => {
      const computedAt = Date.now() - 60 * 1000;
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { stats: { totalCats: 92 }, computedAt } }
      });

      await inst.loadStats();

      const expected = new Date(computedAt);
      const hh = String(expected.getHours()).padStart(2, '0');
      const mm = String(expected.getMinutes()).padStart(2, '0');
      // 跨午夜跑测试时 computedAt 会落到昨天：formatStatsTime 会带 MM-DD，
      // 不能把「昨天 23:59」硬断言成「今天 23:59」。
      const sameDay = expected.toDateString() === new Date().toDateString();
      const prefix = sameDay ? '' : `${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')} `;
      expect(inst.data.updateTime).toBe(`${prefix}${hh}:${mm}`);
    });

    it('无论成败都记录节流基准（失败后不反复重拉）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('timeout'));
      await inst.loadStats();
      expect(typeof inst._lastStatsLoadedAt).toBe('number');
    });
  });

  describe('navigation methods', () => {
    const navTests = [
      ['onGoToAddCat', '/pages/admin/add-cat/add-cat'],
      ['onGoToCatManage', '/pages/admin/cat-manage/cat-manage'],
      ['onGoToPhotoManage', '/pages/admin/photo-manage/photo-manage'],
      ['onGoToNoticeManage', '/pages/admin/notice-manage/notice-manage'],
            ['onGoToManageAdmins', '/pages/admin/manage-admins/manage-admins'],
      ['onGoToOperationLogs', '/pages/admin/operation-logs/operation-logs'],
    ];

    navTests.forEach(([method, url]) => {
      it(`${method} should navigate to ${url}`, () => {
        const inst = createInstance();
        inst[method]();
        expect(wx.navigateTo).toHaveBeenCalledWith({ url });
      });
    });
  });

  describe('onLogout', () => {
    it('should clear auth and navigate back on confirm', () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      // 显式声明栈深 > 1：退出登录改走 adminBehavior.goBack() 后，
      // 走哪条分支取决于页面栈。global.getCurrentPages 是跨用例共享的 mock，
      // 不显式设定就会继承上一个用例留下的栈深（表现为与本用例无关的随机失败）。
      global.getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/admin/admin' }]);
      const inst = createInstance();
      inst.onLogout();
      expect(mockAdminAuth.clearAdminAuth).toHaveBeenCalled();
      // goBack() 在栈深 > 1 时内部就是 navigateBack
      expect(wx.navigateBack).toHaveBeenCalled();
    });

    // 回归（FE-18）：退出登录曾用裸 wx.navigateBack()。页面栈深为 1 时
    // （短链 / URL Scheme / 扫码直达后台）它静默失败，退出后**停在无权限的后台页**，
    // 既退不出去也没有任何提示。goBack() 带 redirectTo 兜底。
    it('栈深为 1 时也能退出（走 goBack 的 redirectTo 兜底，而不是静默失败）', () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      // 用 try/finally 还原：global.getCurrentPages 是跨用例共享的 mock，
      // 直接换掉实现会漏给后面的用例（表现为与本用例无关的随机失败）
      const original = global.getCurrentPages;
      global.getCurrentPages.mockReturnValue([{ route: 'pages/admin/admin' }]);
      try {
        const inst = createInstance();
        inst.onLogout();
        expect(mockAdminAuth.clearAdminAuth).toHaveBeenCalled();
        expect(wx.redirectTo).toHaveBeenCalledWith({ url: '/pages/admin/admin' });
        expect(wx.navigateBack).not.toHaveBeenCalled();
      } finally {
        global.getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/admin/admin' }]);
        global.getCurrentPages.mockImplementation(original);
      }
    });

    it('should not clear auth on cancel', () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: false });
      });
      const inst = createInstance();
      inst.onLogout();
      expect(mockAdminAuth.clearAdminAuth).not.toHaveBeenCalled();
    });

    it('退出登录时清掉统计快照（换人登录不能先看到上个人的数字）', () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      global.getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }, { route: 'pages/admin/admin' }]);
      const inst = createInstance();
      inst.onLogout();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('adminStatsCache');
    });
  });

  describe('export panel', () => {
    it('onOpenExportPanel should set default format for cats', () => {
      const inst = createInstance();
      inst.onOpenExportPanel({ currentTarget: { dataset: { type: 'cats' } } });
      expect(inst.data.showExportPanel).toBe(true);
      expect(inst.data.exportType).toBe('cats');
      expect(inst.data.exportFormat).toBe('txt');
    });

    it('onOpenExportPanel should set default format for photos', () => {
      const inst = createInstance();
      inst.onOpenExportPanel({ currentTarget: { dataset: { type: 'photos' } } });
      expect(inst.data.exportFormat).toBe('zip');
    });

    it('onOpenExportPanel should set csv default for other types', () => {
      const inst = createInstance();
      inst.onOpenExportPanel({ currentTarget: { dataset: { type: 'meets' } } });
      expect(inst.data.exportFormat).toBe('csv');
    });

    it('onCloseExportPanel should hide panel', () => {
      const inst = createInstance({ showExportPanel: true });
      inst.onCloseExportPanel();
      expect(inst.data.showExportPanel).toBe(false);
    });

    it('onExportFormatChange should update format', () => {
      const inst = createInstance();
      inst.onExportFormatChange({ currentTarget: { dataset: { value: 'xlsx' } } });
      expect(inst.data.exportFormat).toBe('xlsx');
    });

    it('onExportFormatChange should ignore empty value', () => {
      const inst = createInstance({ exportFormat: 'csv' });
      inst.onExportFormatChange({ currentTarget: { dataset: { value: '' } } });
      expect(inst.data.exportFormat).toBe('csv');
    });

    it('onStartDateChange should update start date', () => {
      const inst = createInstance();
      inst.onStartDateChange({ detail: { value: '2025-01-01' } });
      expect(inst.data.exportStartDate).toBe('2025-01-01');
    });

    it('onEndDateChange should update end date', () => {
      const inst = createInstance();
      inst.onEndDateChange({ detail: { value: '2025-12-31' } });
      expect(inst.data.exportEndDate).toBe('2025-12-31');
    });
  });

  describe('onConfirmExport', () => {
    it('should return early if no exportType', async () => {
      const inst = createInstance({ exportType: '' });
      await inst.onConfirmExport();
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    it('should handle successful export', async () => {
      const inst = createInstance({ exportType: 'cats', exportFormat: 'txt' });
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { count: 10, downloadUrl: 'https://example.com/file', format: 'txt' } }
      });

      await inst.onConfirmExport();
      expect(inst.data.exporting).toBe(false);
    });

    it('should handle export failure', async () => {
      const inst = createInstance({ exportType: 'cats', exportFormat: 'txt' });
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, message: 'Export failed' }
      });

      await inst.onConfirmExport();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });

    it('should handle export exception', async () => {
      const inst = createInstance({ exportType: 'cats', exportFormat: 'txt' });
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('network error'));

      await inst.onConfirmExport();
      expect(inst.data.exporting).toBe(false);
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });
  });

  describe('_downloadExportFile', () => {
    it('should download and open file on success', () => {
      wx.downloadFile.mockImplementation((opts) => {
        opts.success({ tempFilePath: '/tmp/file.txt' });
      });
      wx.openDocument.mockImplementation((_opts) => {});

      const inst = createInstance();
      inst._downloadExportFile('https://example.com/file', 'txt');
      expect(wx.downloadFile).toHaveBeenCalled();
    });

    it('should copy url on download fail', () => {
      wx.downloadFile.mockImplementation((opts) => {
        opts.fail(new Error('fail'));
      });

      const inst = createInstance();
      inst._downloadExportFile('https://example.com/file', 'txt');
      expect(wx.setClipboardData).toHaveBeenCalledWith({ data: 'https://example.com/file' });
    });

    it('should copy url on openDocument fail', () => {
      wx.downloadFile.mockImplementation((opts) => {
        opts.success({ tempFilePath: '/tmp/file.txt' });
      });
      wx.openDocument.mockImplementation((opts) => {
        opts.fail(new Error('fail'));
      });

      const inst = createInstance();
      inst._downloadExportFile('https://example.com/file', 'txt');
      expect(wx.setClipboardData).toHaveBeenCalled();
    });

    it('should use csv for unknown format', () => {
      wx.downloadFile.mockImplementation((opts) => {
        opts.success({ tempFilePath: '/tmp/file' });
      });

      const inst = createInstance();
      inst._downloadExportFile('https://example.com/file', 'unknown');
      expect(wx.openDocument).toHaveBeenCalledWith(expect.objectContaining({ fileType: 'csv' }));
    });
  });

  describe('export history', () => {
    it('_saveExportHistory should save to storage', () => {
      wx.getStorageSync.mockReturnValue([]);
      const inst = createInstance();
      inst._saveExportHistory({ type: 'cats', count: 5 });
      expect(wx.setStorageSync).toHaveBeenCalledWith('exportHistory', expect.arrayContaining([expect.objectContaining({ type: 'cats' })]));
    });

    it('_saveExportHistory should limit to 10 records', () => {
      const existing = Array.from({ length: 12 }, (_, i) => ({ type: `type${i}` }));
      wx.getStorageSync.mockReturnValue(existing);
      const inst = createInstance();
      inst._saveExportHistory({ type: 'new' });
      const saved = wx.setStorageSync.mock.calls[0][1];
      expect(saved.length).toBe(10);
      expect(saved[0].type).toBe('new');
    });

    it('_saveExportHistory should handle non-array storage', () => {
      wx.getStorageSync.mockReturnValue('not-array');
      const inst = createInstance();
      inst._saveExportHistory({ type: 'cats' });
      expect(wx.setStorageSync).toHaveBeenCalled();
    });

    it('_loadExportHistory should load from storage', () => {
      wx.getStorageSync.mockReturnValue([{ type: 'cats' }]);
      const inst = createInstance();
      inst._loadExportHistory();
      expect(inst.data.exportHistory).toEqual([{ type: 'cats' }]);
    });

    it('_loadExportHistory should handle non-array storage', () => {
      wx.getStorageSync.mockReturnValue(null);
      const inst = createInstance();
      inst._loadExportHistory();
      expect(inst.data.exportHistory).toEqual([]);
    });

    it('onClearExportHistory should clear on confirm', () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      const inst = createInstance();
      inst.onClearExportHistory();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('exportHistory');
      expect(inst.data.exportHistory).toEqual([]);
    });

    it('onRedownload should call _downloadExportFile', () => {
      const inst = createInstance();
      inst._downloadExportFile = jest.fn();
      inst.onRedownload({ currentTarget: { dataset: { url: 'https://example.com', format: 'csv' } } });
      expect(inst._downloadExportFile).toHaveBeenCalledWith('https://example.com', 'csv');
    });

    it('onRedownload should default format to csv', () => {
      const inst = createInstance();
      inst._downloadExportFile = jest.fn();
      inst.onRedownload({ currentTarget: { dataset: { url: 'https://example.com' } } });
      expect(inst._downloadExportFile).toHaveBeenCalledWith('https://example.com', 'csv');
    });

    it('onRedownload should do nothing without url', () => {
      const inst = createInstance();
      inst._downloadExportFile = jest.fn();
      inst.onRedownload({ currentTarget: { dataset: {} } });
      expect(inst._downloadExportFile).not.toHaveBeenCalled();
    });
  });

  describe('onPullDownRefresh', () => {
    it('should reload stats and show success', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { stats: {} } } });
      await inst.onPullDownRefresh();
      expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('刷新成功');
      expect(wx.hideNavigationBarLoading).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });

    it('should handle refresh with failed stats gracefully', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      await inst.onPullDownRefresh();
      expect(wx.hideNavigationBarLoading).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
      // 失败不得提示「刷新成功」（mockErrorHandler.showSuccess 未被调用）
      expect(mockErrorHandler.showSuccess).not.toHaveBeenCalledWith('刷新成功');
      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('刷新失败') }));
    });
  });
});
