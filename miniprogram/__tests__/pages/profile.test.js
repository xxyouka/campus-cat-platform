const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockAdminAuth = { setAdminAuth: jest.fn(() => Promise.resolve()), checkAdminAuth: jest.fn(() => false) };
jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../utils/adminAuth', () => mockAdminAuth);

const _config = require('../../config');

let pageDef;
let capturedApp;
const createdInstances = [];

beforeAll(() => {
  const origGetApp = global.getApp;
  global.getApp = jest.fn(() => {
    capturedApp = origGetApp();
    return capturedApp;
  });
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/profile/profile');
});

beforeEach(() => {
  jest.clearAllMocks();
  wx.getStorageSync.mockReturnValue('');  wx.setStorageSync.mockReset();
  wx.removeStorageSync.mockReset();
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  capturedApp.globalData.isAdmin = false;
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
  };
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  // 定时器统一清理入口，避免用例遗留句柄。
  // 敲击/结果反馈已改为 a/b 相位类切换（无定时器），这里只剩首屏门禁的。
  inst._clearAllTimers = () => {
    inst._clearFirstScreenTimer();
  };
  createdInstances.push(inst);
  return inst;
}

/** 手动控制的 promise：用来验证首屏门禁「等所有人到齐才放行」 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 冲刷微任务队列若干轮（Promise.allSettled 需要多轮） */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('profile page', () => {
  afterEach(() => {
    createdInstances.forEach(inst => inst._clearAllTimers());
    createdInstances.length = 0;
  });

  // ========== 首屏一致性门禁 ==========
  // 背景：关注数/相遇数/推送额度/日历统计过去各自 setData，回来时间不同，
  // 且先渲染 `|| 0` 的假值 —— 界面分四波跳变，用户看到的是「内容不同步」。
  // 现在四个加载器汇合成一个 firstScreenReady 门禁，统一换成真内容。
  describe('首屏门禁 firstScreenReady', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    /** 把四个首屏加载器换成受控 promise，其余页面行为保持真实 */
    function withControlledLoaders(inst, controls) {
      inst.refreshFavoriteCount = jest.fn(() => controls.favorite.promise);
      inst.refreshMeetCount = jest.fn(() => controls.meet.promise);
      inst.refreshSubscribeQuota = jest.fn(() => controls.quota.promise);
      inst.loadMeetCalendar = jest.fn(() => controls.calendar.promise);
      return inst;
    }

    test('初始为 false（未就绪时渲染骨架，不是先渲染 0）', () => {
      expect(pageDef.data.firstScreenReady).toBe(false);
      const inst = createInstance();
      expect(inst.data.firstScreenReady).toBe(false);
    });

    test('四个加载器全部落地前不放行', async () => {
      const controls = {
        favorite: deferred(),
        meet: deferred(),
        quota: deferred(),
        calendar: deferred()
      };
      const inst = withControlledLoaders(createInstance(), controls);

      const gate = inst._syncFirstScreen();
      await flush();

      // 一个都没回来：必须还锁在骨架上
      expect(inst.data.firstScreenReady).toBe(false);

      // 逐个回来也不放行 —— 直到最后一个
      controls.favorite.resolve();
      controls.quota.resolve();
      await flush();
      expect(inst.data.firstScreenReady).toBe(false);

      controls.meet.resolve();
      await flush();
      expect(inst.data.firstScreenReady).toBe(false);

      controls.calendar.resolve();
      await gate;
      expect(inst.data.firstScreenReady).toBe(true);
    });

    test('单个加载器失败不阻塞放行（allSettled，且失败方自己画错误态）', async () => {
      const controls = {
        favorite: deferred(),
        meet: deferred(),
        quota: deferred(),
        calendar: deferred()
      };
      const inst = withControlledLoaders(createInstance(), controls);

      const gate = inst._syncFirstScreen();
      await flush();

      controls.favorite.reject(new Error('network'));
      controls.meet.resolve();
      controls.quota.resolve();
      controls.calendar.resolve();
      await gate;

      // 相遇数读失败时页面已有 meetCountError + 重试入口，门禁不该一直等
      expect(inst.data.firstScreenReady).toBe(true);
    });

    test('有加载器永不返回时靠超时放行（骨架不能永远挂着）', async () => {
      jest.useFakeTimers();
      const controls = {
        favorite: deferred(),      // 永远不 resolve —— 模拟云调用卡死
        meet: deferred(),
        quota: deferred(),
        calendar: deferred()
      };
      const inst = withControlledLoaders(createInstance(), controls);

      inst._syncFirstScreen();
      await Promise.resolve();
      expect(inst.data.firstScreenReady).toBe(false);

      jest.advanceTimersByTime(2499);
      expect(inst.data.firstScreenReady).toBe(false);

      jest.advanceTimersByTime(1);
      expect(inst.data.firstScreenReady).toBe(true);

      controls.favorite.resolve();
      controls.meet.resolve();
      controls.quota.resolve();
      controls.calendar.resolve();
      await flush();
      inst._clearFirstScreenTimer();
    });

    test('超时放行后不会重复 setData（只生效一次）', async () => {
      jest.useFakeTimers();
      const controls = {
        favorite: deferred(), meet: deferred(), quota: deferred(), calendar: deferred()
      };
      const inst = withControlledLoaders(createInstance(), controls);

      inst._syncFirstScreen();
      jest.advanceTimersByTime(2500);
      expect(inst.data.firstScreenReady).toBe(true);

      const readyCalls = inst.setData.mock.calls.filter(
        ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, 'firstScreenReady')
      ).length;
      expect(readyCalls).toBe(1);

      controls.favorite.resolve();
      controls.meet.resolve();
      controls.quota.resolve();
      controls.calendar.resolve();
      await flush();
      inst._clearFirstScreenTimer();

      const afterCalls = inst.setData.mock.calls.filter(
        ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, 'firstScreenReady')
      ).length;
      expect(afterCalls).toBe(1);
    });

    test('卸载后不再放行（定时器清理，避免对已销毁页面 setData）', async () => {
      jest.useFakeTimers();
      const controls = {
        favorite: deferred(), meet: deferred(), quota: deferred(), calendar: deferred()
      };
      const inst = withControlledLoaders(createInstance(), controls);

      inst._syncFirstScreen();
      inst._isUnmounted = true;
      jest.advanceTimersByTime(2500);

      expect(inst.data.firstScreenReady).toBe(false);
      inst._clearFirstScreenTimer();
    });

    // 回归：refactor 时给 refreshFavoriteCount 加 return 很容易漏掉另一条路径。
    // 缺任一条都会静默丢数据：漏 restore → 新设备关注数永远是 0；
    // 漏 unread → 未读红点永远不亮。
    test('refreshFavoriteCount 两条路径都跑（云端恢复 + 未读数）', async () => {
      wx.getStorageSync.mockReturnValue('');   // 「从未写入过关注」→ 走云端恢复
      const inst = createInstance();
      inst._restoreFavoritesFromCloud = jest.fn(() => Promise.resolve());
      inst.refreshUnreadCount = jest.fn(() => Promise.resolve());

      await inst.refreshFavoriteCount();

      expect(inst._restoreFavoritesFromCloud).toHaveBeenCalledTimes(1);
      expect(inst.refreshUnreadCount).toHaveBeenCalledTimes(1);
    });

    test('refreshFavoriteCount 已有本地记录时仍要拉未读数', async () => {
      wx.getStorageSync.mockReturnValue([{ id: 'cat-1' }]);
      const inst = createInstance();
      inst._restoreFavoritesFromCloud = jest.fn(() => Promise.resolve());
      inst.refreshUnreadCount = jest.fn(() => Promise.resolve());

      await inst.refreshFavoriteCount();

      expect(inst._restoreFavoritesFromCloud).not.toHaveBeenCalled();
      expect(inst.refreshUnreadCount).toHaveBeenCalledTimes(1);
    });

    // 显式契约：门禁必须点名这四个加载器。
    // 少一个，那个区块就会退回「先渲染 0、再跳真值」的老样子，而这一条比任何
    // 间接断言都直接（此前少一个只能被一条无关的既有用例偶然抓到）。
    test('门禁点名全部四个首屏加载器', async () => {
      const inst = createInstance();
      const favorite = jest.fn(() => Promise.resolve());
      const meet = jest.fn(() => Promise.resolve());
      const quota = jest.fn(() => Promise.resolve());
      const calendar = jest.fn(() => Promise.resolve());
      inst.refreshFavoriteCount = favorite;
      inst.refreshMeetCount = meet;
      inst.refreshSubscribeQuota = quota;
      inst.loadMeetCalendar = calendar;

      await inst._syncFirstScreen();

      expect(favorite).toHaveBeenCalledTimes(1);
      expect(meet).toHaveBeenCalledTimes(1);
      expect(quota).toHaveBeenCalledTimes(1);
      expect(calendar).toHaveBeenCalledTimes(1);
      expect(inst.data.firstScreenReady).toBe(true);
    });

    // 门禁靠 promise 汇合：加载器一旦又不返回值，allSettled 会「秒过」，
    // 门禁形同虚设（又回到分四波跳变）。
    test.each([
      ['refreshUnreadCount'],
      ['refreshMeetCount'],
      ['refreshSubscribeQuota'],
      ['loadMeetCalendar']
    ])('%s 返回 promise（门禁才能等它）', async (method) => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: {} } });
      const inst = createInstance();
      const ret = inst[method]();
      expect(ret && typeof ret.then).toBe('function');
      await ret;
    });
  });

  describe('onLoad', () => {
    test('sets statusBarHeight', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ statusBarHeight: expect.any(Number) }));
    });

    test('calls loadContactInfo, refreshFavoriteCount, refreshMeetCount', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(wx.cloud.callFunction).toHaveBeenCalled();
      expect(wx.getStorageSync).toHaveBeenCalled();
    });

    // 首屏只 gate 真正渲染数字的四个加载器。联系信息只喂「关于我们」弹窗，
    // 把它算进来会让一个不可见的慢调用把整页锁在骨架里。
    test('联系信息与推送偏好不进首屏门禁', () => {
      const inst = createInstance();
      const spy = jest.fn(() => new Promise(() => {}));
      inst._syncFirstScreen = spy;
      inst.onLoad();
      expect(spy).toHaveBeenCalledTimes(1);
      inst._clearFirstScreenTimer();
    });
  });

  describe('onShow', () => {
    // 首屏跳过守卫回归：onLoad 刚把四个统计区块全拉过一遍，首次 onShow 若不放行
    // 会原样再发一遍。守卫放在 refreshFavoriteCount 之后 —— 关注恢复与未读红点
    // 必须保留（用户从通知页回来要看到红点清零）。
    test('首次 onShow 保留关注/未读刷新，但跳过四个统计云调用', () => {
      mockAdminAuth.checkAdminAuth.mockReturnValue(true);
      const inst = createInstance();
      inst.onShow();
      // refreshFavoriteCount 仍跑了（它写 favoriteCount）
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ favoriteCount: expect.any(Number) }));
    });

    test('第二次 onShow 同步管理员状态并刷新四个统计区块', () => {
      mockAdminAuth.checkAdminAuth.mockReturnValue(true);
      const inst = createInstance();
      inst.onShow();   // 第一次：跳过统计区块
      inst.onShow();   // 第二次：正常
      expect(mockAdminAuth.checkAdminAuth).toHaveBeenCalled();
      expect(capturedApp.globalData.isAdmin).toBe(true);
      // 统计区块的三个云调用都该发出（首个 onShow 已跳过）
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({ name: 'getMyMeetCount' }));
    });

    // 性能修复（2026-10-14）：管理后台入口在本页，而 app.json 没有 preloadRule
    //（那会给**所有**用户下发 0.30MB 的 admin 分包）。改为确认管理员身份后手动预下载。
    test('管理员预下载 admin 分包，普通用户不下载，且一次会话只下载一次', () => {
      mockAdminAuth.checkAdminAuth.mockReturnValue(true);
      const adminInst = createInstance();
      adminInst.onShow();
      expect(wx.loadSubpackage).toHaveBeenCalledWith(expect.objectContaining({ name: 'admin' }));

      // 同一次会话内重复 onShow 不重复发起
      wx.loadSubpackage.mockClear();
      adminInst.onShow();
      expect(wx.loadSubpackage).not.toHaveBeenCalled();

      // 非管理员：零流量
      mockAdminAuth.checkAdminAuth.mockReturnValue(false);
      const userInst = createInstance();
      userInst.onShow();
      expect(wx.loadSubpackage).not.toHaveBeenCalled();
    });
  });

  describe('loadContactInfo', () => {
    test('uses cached contact when fresh', async () => {
      const cachedContact = { wechat: 'wx123', email: 'a@b.com' };
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'contactInfoCache') return { data: cachedContact, timestamp: Date.now() };
        return '';
      });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(inst.setData).toHaveBeenCalledWith({ contact: cachedContact });
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('ignores fresh cache when contact values are empty', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'contactInfoCache') return { data: { wechat: '', email: '' }, timestamp: Date.now() };
        return '';
      });
      const contact = { wechat: 'new', email: 'new@b.com' };
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { contact } }
      });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({ name: 'getConfig' }));
      expect(inst.setData).toHaveBeenCalledWith({ contact });
    });

    test('fetches from cloud when cache expired', async () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'contactInfoCache') return { data: { wechat: 'old' }, timestamp: Date.now() - 4000000 };
        return '';
      });
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { contact: { wechat: 'new', email: 'new@b.com' } } }
      });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({ name: 'getConfig' }));
    });

    test('caches fetched contact info', async () => {
      wx.getStorageSync.mockReturnValue(null);
      const contact = { wechat: 'wx123', email: 'a@b.com' };
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { contact } }
      });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(wx.setStorageSync).toHaveBeenCalledWith('contactInfoCache', expect.objectContaining({ data: contact }));
    });

    test('does not cache empty fetched contact info', async () => {
      wx.getStorageSync.mockReturnValue(null);
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { contact: { wechat: '', email: '' } } }
      });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(inst.setData).toHaveBeenCalledWith({ contact: { wechat: '暂未配置', email: '暂未配置' } });
      expect(wx.setStorageSync).not.toHaveBeenCalled();
      expect(wx.removeStorageSync).toHaveBeenCalledWith('contactInfoCache');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('handles cloud function failure gracefully', async () => {
      wx.getStorageSync.mockReturnValue(null);
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('handles unsuccessful result gracefully', async () => {
      wx.getStorageSync.mockReturnValue(null);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false } });
      const inst = createInstance();
      await inst.loadContactInfo();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('refreshFavoriteCount', () => {
    test('sets favoriteCount from storage', () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'favoriteCats') return [{ id: '1' }, { id: '2' }];
        if (key === 'pendingUpdates') return {};
        if (key === 'readUpdates') return {};
        return '';
      });
      const inst = createInstance();
      inst.refreshFavoriteCount();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ favoriteCount: 2 }));
    });

    test('handles non-array favoriteCats', () => {
      wx.getStorageSync.mockImplementation(key => {
        if (key === 'favoriteCats') return null;
        if (key === 'pendingUpdates') return {};
        if (key === 'readUpdates') return {};
        return '';
      });
      const inst = createInstance();
      inst.refreshFavoriteCount();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ favoriteCount: 0 }));
    });

    // 原先三个用例测的是本地 Storage 的 pendingUpdates/readUpdates，
    // 但全项目**只有 profile 读、没有任何地方写**这两个键 → unreadUpdateCount 恒为 0，
    // 「新动态」卡块从来不显示数字。已改为读云端 getNotifications（未读数真实来源），
    // 旧用例随该实现一并移除。
    test('refreshUnreadCount 从云端拉取真实未读数', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { unreadCount: 7 } }
      });
      const inst = createInstance();
      inst.refreshUnreadCount();
      await Promise.resolve();
      await Promise.resolve();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
        name: 'getNotifications'
      }));
      // 未读数同时回写 tabBar 红点（用户不进「我的」也能看到）
      expect(wx.setTabBarBadge).toHaveBeenCalledWith(expect.objectContaining({
        index: 2,
        text: '7'
      }));
    });

    test('云端业务失败时保持原值不动', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '无权限' } });
      const inst = createInstance();
      inst.refreshUnreadCount();
      await Promise.resolve();
      await Promise.resolve();
      expect(inst.setData).not.toHaveBeenCalledWith(
        expect.objectContaining({ unreadUpdateCount: 0 })
      );
    });
  });

  describe('refreshMeetCount', () => {
    test('sets meetCount from cloud result', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { count: 7 } } });
      const inst = createInstance();
      inst.refreshMeetCount();
      await Promise.resolve();
      expect(inst.setData).toHaveBeenCalledWith({ meetCount: 7 });
    });

    // 失败时**不能**把 meetCount 置 0：那会让「云函数挂了」与「真的没打过卡」
    // 在 UI 上完全同形（wxml 三格快捷条的 .quick-num 直接渲染 meetCount）。正确口径同 quotaError：
    // 保留原值 + 置错误标记 + 清时间窗以便点重试。
    test('keeps previous meetCount and flags error on unsuccessful result', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false } });
      const inst = createInstance({ meetCount: 7 });
      inst.refreshMeetCount();
      await Promise.resolve();
      expect(inst.setData).not.toHaveBeenCalledWith({ meetCount: 0 });
      expect(inst.setData).toHaveBeenCalledWith(
        expect.objectContaining({ meetCountError: expect.stringContaining('读取失败') })
      );
      // 时间窗必须清零，否则 30s 内点重试会被挡掉（与日历 FE-2 同款缺陷）
      expect(inst._meetRefreshedAt).toBe(0);
    });

    test('keeps previous meetCount and flags error on cloud error', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ meetCount: 7 });
      inst.refreshMeetCount();
      await Promise.resolve();
      await Promise.resolve();
      expect(inst.setData).not.toHaveBeenCalledWith({ meetCount: 0 });
      expect(inst.setData).toHaveBeenCalledWith(
        expect.objectContaining({ meetCountError: expect.stringContaining('读取失败') })
      );
      expect(inst._meetRefreshedAt).toBe(0);
    });

    // 回归保护：重试入口必须能穿透 30s 窗口
    test('onRetryMeetCount clears the window and refetches', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { count: 3 } } });
      const inst = createInstance({ meetCount: 0 });
      inst._meetRefreshedAt = Date.now();
      const spy = jest.spyOn(inst, 'refreshMeetCount');
      inst.onRetryMeetCount();
      await Promise.resolve();
      expect(spy).toHaveBeenCalled();
      expect(inst._meetRefreshedAt).toBeGreaterThan(0);
    });
  });

  describe('_buildCalendarCells', () => {
    // 「今天」标记：字段名 isToday 与 meets 页同口径，wxml 里映射成 .today 类（内描边圆环）
    test('marks today in the current month', () => {
      const inst = createInstance();
      const now = new Date();
      const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), []);
      const todayCells = cells.filter(c => c.isToday);
      expect(todayCells).toHaveLength(1);
      expect(todayCells[0].day).toBe(now.getDate());
    });

    // 翻到别的月份不能把同号的日子标成今天，否则月历上会凭空出现第二个「今天」
    test('does not mark the same day number in other months', () => {
      const inst = createInstance();
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevCells = inst._buildCalendarCells(prev.getFullYear(), prev.getMonth(), []);
      expect(prevCells.every(c => c.isToday === false)).toBe(true);

      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextCells = inst._buildCalendarCells(next.getFullYear(), next.getMonth(), []);
      expect(nextCells.every(c => c.isToday === false)).toBe(true);
    });

    test('pad cells and meet flags stay untouched', () => {
      const inst = createInstance();
      const now = new Date();
      const cells = inst._buildCalendarCells(now.getFullYear(), now.getMonth(), [3, 9]);
      expect(cells.filter(c => c.day === '').every(c => c.isToday === false)).toBe(true);
      expect(cells.filter(c => c.meeted).map(c => c.day)).toEqual([3, 9]);
    });
  });

  describe('onGoFavorites', () => {
    test('navigates to favorites page', () => {
      const inst = createInstance();
      inst.onGoFavorites();
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/favorites/favorites' });
    });
  });

  describe('onGoRank', () => {
    test('navigates to rank page', () => {
      const inst = createInstance();
      inst.onGoRank();
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/rank/rank' });
    });
  });

  describe('onGoMeets', () => {
    test('navigates to meets page', () => {
      const inst = createInstance();
      inst.onGoMeets();
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/meets/meets' });
    });
  });

  describe('onAccountInput', () => {
    test('filters Chinese characters and clears account error', () => {
      const inst = createInstance();
      inst.onAccountInput({ detail: { value: 'admin中文123' } });
      expect(inst.setData).toHaveBeenCalledWith({ account: 'admin123', 'errors.account': '' });
    });
  });

  describe('onPasswordInput', () => {
    test('filters Chinese characters', () => {
      const inst = createInstance();
      inst.onPasswordInput({ detail: { value: 'pass中文word' } });
      expect(inst.setData).toHaveBeenCalledWith({ password: 'password' });
    });
  });

  describe('onPrivacy', () => {
    test('navigates to privacy page', () => {
      const inst = createInstance();
      inst.onPrivacy();
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/privacy/privacy' });
    });
  });

  describe('onAbout', () => {
    test('shows about modal', () => {
      const inst = createInstance();
      inst.onAbout();
      expect(inst.setData).toHaveBeenCalledWith({ 'modal.about.show': true });
    });
  });

  describe('onModalClose', () => {
    test('hides about modal', () => {
      const inst = createInstance();
      inst.onModalClose();
      expect(inst.setData).toHaveBeenCalledWith({ 'modal.about.show': false });
    });
  });

  describe('onVersionTap', () => {
    test('navigates to admin when already admin', () => {
      capturedApp.globalData.isAdmin = true;
      const inst = createInstance();
      inst.onVersionTap();
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/admin/admin' });
    });

    test('shows admin login modal when not admin', () => {
      capturedApp.globalData.isAdmin = false;
      const inst = createInstance();
      inst.onVersionTap();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ 'modal.adminLogin.show': true }));
    });
  });

  describe('onCancelLogin', () => {
    test('resets login form and hides modal', () => {
      const inst = createInstance({ account: 'test', password: '123', showPwd: true, errors: { account: 'err' } });
      inst.onCancelLogin();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        'modal.adminLogin.show': false, account: '', password: '', showPwd: false, errors: {}
      }));
    });
  });

  describe('onTogglePwd', () => {
    test('toggles password visibility', () => {
      const inst = createInstance({ showPwd: false });
      inst.onTogglePwd();
      expect(inst.setData).toHaveBeenCalledWith({ showPwd: true });
    });
  });

  describe('onConfirmLogin', () => {
    test('shows error when account is empty', async () => {
      const inst = createInstance({ account: '', password: '123', logging: false });
      await inst.onConfirmLogin();
      expect(inst.setData).toHaveBeenCalledWith({ 'errors.account': '请输入账号' });
    });

    test('shows error when password is empty', async () => {
      const inst = createInstance({ account: 'admin', password: '', logging: false });
      await inst.onConfirmLogin();
      expect(inst.setData).toHaveBeenCalledWith({ 'errors.password': '请输入密码' });
    });

    test('prevents concurrent login attempts', async () => {
      const inst = createInstance({ account: 'admin', password: '123', logging: true });
      await inst.onConfirmLogin();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('logs in successfully', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: { role: 'admin', permissions: ['addCat', 'cat', 'photo'] } }
      });
      mockAdminAuth.setAdminAuth.mockResolvedValue();
      const inst = createInstance({ account: 'admin', password: '123', logging: false });
      await inst.onConfirmLogin();
      expect(mockAdminAuth.setAdminAuth).toHaveBeenCalledWith(
        true, 'admin', 'admin', ['addCat', 'cat', 'photo']
      );
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ 'modal.adminLogin.show': false, logging: false }));
      expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/admin/admin' });
    });

    test('shows error on wrong credentials', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, message: '密码错误' } });
      const inst = createInstance({ account: 'admin', password: 'wrong', logging: false });
      await inst.onConfirmLogin();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ 'errors.password': '密码错误', logging: false }));
    });

    test('handles cloud function error', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('net'));
      const inst = createInstance({ account: 'admin', password: '123', logging: false });
      await inst.onConfirmLogin();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ 'errors.password': '登录失败，请重试', logging: false }));
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('clears errors before attempting login', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { role: 'admin' } } });
      const inst = createInstance({ account: 'admin', password: '123', logging: false });
      await inst.onConfirmLogin();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ 'errors.account': '', 'errors.password': '' }));
    });
  });

  describe('onPullDownRefresh', () => {
    test('stops pull down refresh immediately', () => {
      const inst = createInstance();
      inst.onPullDownRefresh();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object with title and path', () => {
      const inst = createInstance();
      const result = inst.onShareAppMessage();
      expect(result).toHaveProperty('title');
      expect(result.path).toBe('/pages/index/index');
    });

    test('有数据时文案带上关注与相遇数量', () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const inst = createInstance({ favoriteCount: 4, meetCount: 9 });
        const result = inst.onShareAppMessage();
        expect(result.title).toContain('4 只猫');
        expect(result.title).toContain('9 次相遇');
      } finally {
        random.mockRestore();
      }
    });
  });

  describe('onShareTimeline', () => {
    test('returns share object with title and query', () => {
      const inst = createInstance();
      const result = inst.onShareTimeline();
      expect(result).toHaveProperty('title');
      expect(result.query).toBe('');
    });
  });

  describe('stopPropagation', () => {
    test('is a no-op function', () => {
      const inst = createInstance();
      expect(() => inst.stopPropagation()).not.toThrow();
    });
  });

  });
