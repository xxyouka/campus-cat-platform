// 数据库查询指令桩必须是**模块级单例**，不能定义在 database() 的返回对象里：
// database() 是 jest.fn(() => ({...}))，每次调用都构造全新对象，
// 若 command 写在里面，测试里 `wx.cloud.database().command.neq` 拿到的
// 永远是另一个从未被调用过的 mock —— 断言 toHaveBeenCalledWith 必然失败，
// 而实现其实完全正常（曾导致 dbFields 套件集体变红）。
const mockCommand = {
  eq: jest.fn(v => v),
  neq: jest.fn(v => v),
  gt: jest.fn(v => v),
  gte: jest.fn(v => v),
  lt: jest.fn(v => v),
  lte: jest.fn(v => v),
  in: jest.fn(v => v),
  and: jest.fn(v => v),
  or: jest.fn(v => v)
};

global.mockCommand = mockCommand;

// 音频桩：innerAudioContext 的最小可用形态。
// knockSound 现在维护 N 个实例的「音效池」并轮转使用（修 iOS 连点吞音 / 静音键无声），
// 因此这里必须**每次调用返回全新对象** —— 固定返回同一个对象会让池里 N 个槽位
// 指向同一个 mock，轮转/复用断言全部失真。
// paused 跟随 play/stop 变化：knockSound 靠它判断「要不要先 stop 再从头播」。
function createMockAudioContext() {
  return {
    src: '',
    volume: 1,
    obeyMuteSwitch: false,
    paused: true,
    play: jest.fn(function() { this.paused = false; }),
    stop: jest.fn(function() { this.paused = true; }),
    pause: jest.fn(function() { this.paused = true; }),
    destroy: jest.fn(),
    onError: jest.fn()
  };
}

global.wx = {
  getSystemInfoSync: jest.fn(() => ({
    windowHeight: 800,
    windowWidth: 375,
    statusBarHeight: 20,
    pixelRatio: 2,
    brand: 'devtools',
    model: 'devtools',
    system: 'devtools',
    platform: 'devtools'
  })),
  getWindowInfo: jest.fn(() => ({
    windowHeight: 800,
    windowWidth: 375,
    statusBarHeight: 20,
    pixelRatio: 2,
    screenHeight: 800,
    screenWidth: 375
  })),
  getDeviceInfo: jest.fn(() => ({
    brand: 'devtools',
    model: 'devtools',
    system: 'devtools',
    platform: 'devtools'
  })),
  getAppBaseInfo: jest.fn(() => ({
    SDKVersion: '3.16.1',
    version: '8.0.78',
    language: 'zh_CN'
  })),
  getAccountInfoSync: jest.fn(() => ({
    miniProgram: {
      envVersion: 'develop'
    }
  })),
  cloud: {
    callFunction: jest.fn(() => Promise.resolve({ result: { success: true } })),
    database: jest.fn(() => ({
      collection: jest.fn(() => ({
        where: jest.fn(() => ({
          field: jest.fn(function() { return this; }),
          get: jest.fn(() => Promise.resolve({ data: [] })),
          count: jest.fn(() => Promise.resolve({ total: 0 })),
          limit: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: [] })),
            skip: jest.fn()
          })),
          orderBy: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ data: [] })),
            limit: jest.fn()
          })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        })),
        doc: jest.fn(() => ({
          // 客户端直连读经 .field(投影) 链（utils/dbFields.js），mock 需支持链式调用
          field: jest.fn(function() { return this; }),
          get: jest.fn(() => Promise.resolve({ data: {} })),
          update: jest.fn(() => Promise.resolve({ stats: { updated: 0 } })),
          remove: jest.fn(() => Promise.resolve({ stats: { removed: 0 } }))
        })),
        add: jest.fn(() => Promise.resolve({ _id: 'mock-id' })),
        count: jest.fn(() => Promise.resolve({ total: 0 })),
        field: jest.fn(function() { return this; }),
        limit: jest.fn(function() { return this; }),
        orderBy: jest.fn(function() { return this; }),
        skip: jest.fn(function() { return this; }),
        get: jest.fn(() => Promise.resolve({ data: [] }))
      })),
      // 引用共享单例而非就地定义，理由见文件顶部 mockCommand 的注释
      command: mockCommand
    })),
    init: jest.fn(),
    uploadFile: jest.fn(),
    // 未入库文件回收（add-cat / edit-cat 在失败路径上调用）会 await 它，必须返回 Promise
    deleteFile: jest.fn(() => Promise.resolve({ fileList: [] })),
    getTempFileURL: jest.fn(() => Promise.resolve({ fileList: [] }))
  },
  getStorageSync: jest.fn(() => ''),
  setStorageSync: jest.fn(),
  removeStorageSync: jest.fn(),
  getStorageInfoSync: jest.fn(() => ({ keys: [], currentSize: 0, limitSize: 10240 })),
  getStorage: jest.fn(() => Promise.resolve({ data: '' })),
  setStorage: jest.fn(() => Promise.resolve()),
  showToast: jest.fn(),
  hideToast: jest.fn(),
  showLoading: jest.fn(),
  hideLoading: jest.fn(),
  showModal: jest.fn(() => Promise.resolve({ confirm: false, cancel: true })),
  navigateTo: jest.fn(),
  navigateBack: jest.fn(),
  // tabBar 未读红点（utils/tabBadge.js）：默认桩成功，用例按需断言参数
  setTabBarBadge: jest.fn(),
  removeTabBarBadge: jest.fn(),
  // 分包预下载：pages/profile/profile.js 在确认管理员身份后预下载 admin 分包
  loadSubpackage: jest.fn(() => Promise.resolve()),
  // 生产代码在用但此前未 mock：pages/admin/behaviors/adminBehavior.js:58 的
  // goBack() 栈深 1 兜底、detail.js:663 的 tabBar 分支都调它
  redirectTo: jest.fn(),
  switchTab: jest.fn(),
  reLaunch: jest.fn(),
  createSelectorQuery: jest.fn(() => ({
    select: jest.fn(() => ({
      boundingClientRect: jest.fn(() => ({
        exec: jest.fn(callback => callback([{ top: 0 }]))
      }))
    })),
    exec: jest.fn()
  })),
  createIntersectionObserver: jest.fn(() => ({
    relativeToViewport: jest.fn(() => ({
      observe: jest.fn()
    })),
    disconnect: jest.fn()
  })),
  createAnimation: jest.fn(() => ({
    scale: jest.fn(function() { return this; }),
    step: jest.fn(function() { return this; }),
    export: jest.fn(() => ({}))
  })),
  vibrateShort: jest.fn(() => Promise.resolve()),
  vibrateLong: jest.fn(),
  // 订阅消息授权弹窗：默认无回调（等同用户没操作）；用例按需 mockImplementation 触发 success/fail
  requestSubscribeMessage: jest.fn(),
  login: jest.fn(),
  stopPullDownRefresh: jest.fn(),
  pageScrollTo: jest.fn(),
  previewImage: jest.fn(),
  // 选图 API：真实实现里 chooseMedia 在 PC 端静默无响应，故 utils/mediaChoose 会回退 chooseImage。
  // 默认桩不自动回调（等同「用户没选就关掉了」），用例按需 mockImplementation 触发 success/fail。
  chooseMedia: jest.fn(),
  chooseImage: jest.fn(),
  downloadFile: jest.fn(() => Promise.resolve({ statusCode: 200, tempFilePath: 'wxfile://tmp/downloaded.jpg' })),
  saveImageToPhotosAlbum: jest.fn(() => Promise.resolve()),
  getNetworkType: jest.fn(({ success }) => {
    if (success) success({ networkType: 'wifi' });
  }),
  onNetworkStatusChange: jest.fn(),
  canIUse: jest.fn(() => true),
  // 音频（敲木鱼音效 utils/knockSound.js）：默认桩成功，可按用例改行为
  createInnerAudioContext: jest.fn(() => createMockAudioContext()),
  setInnerAudioOption: jest.fn(),
  nextTick: jest.fn(fn => fn()),
  getRealtimeLogManager: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
};

global.getCurrentPages = jest.fn(() => []);

global.getApp = jest.fn(() => ({
  globalData: {
    isAdmin: false,
    isOnline: true,
    openid: 'test-openid',
    version: '3.1.2',
    _prefetchCache: {
      get: jest.fn(),
      set: jest.fn(),
      has: jest.fn(() => false),
      delete: jest.fn(),
      getStats: jest.fn(() => ({ size: 0 })),
      destroy: jest.fn()
    }
  },
  getPrefetchCache: jest.fn(),
  setPrefetchCache: jest.fn(),
  getPrefetchCacheStats: jest.fn()
}));

global.Behavior = jest.fn(obj => obj);
global.Component = jest.fn(obj => obj);

/**
 * 重置 wx 全局桩，但不破坏桩的默认实现。
 *
 * 为什么需要它：`jest.clearAllMocks()` 只清「调用记录」，不清「实现」。听起来无害，
 * 但本文件里的桩是用 `jest.fn(impl)` 形式定义的 —— clearAllMocks 之后 impl **仍然保留**，
 * 这一点没问题；真正的问题是反过来的情形：某个用例为了临时改行为调用了
 * `mockReturnValue` / `mockImplementationOnce`，那会**覆盖**默认 impl；
 * 而 `jest.resetAllMocks()` 会连默认 impl 一起清空，桩变成返回 undefined 的空壳。
 * 于是 setup.js 里 `canIUse: () => true`、`getDeviceInfo: () => ({platform})` 这类
 * 基础默认值静默失效，表现为「同一个实现，换个测试文件跑结果就不一样」，
 * 且失败信息毫无指向性（曾导致 mediaChoose / catService / dbFields 三个套件集体变红）。
 *
 * 正确做法：需要「彻底重置」时用本函数 —— 先 resetAllMocks，再把默认实现装回去。
 * 默认实现集中登记在 DEFAULT_STUB_IMPLS，用例按需覆盖单个键即可。
 */
const DEFAULT_STUB_IMPLS = {
  canIUse: () => true,
  getDeviceInfo: () => ({ brand: 'devtools', model: 'devtools', system: 'devtools', platform: 'devtools' }),
  getSystemInfoSync: () => ({
    windowHeight: 800, windowWidth: 375, statusBarHeight: 20, pixelRatio: 2,
    brand: 'devtools', model: 'devtools', system: 'devtools', platform: 'devtools'
  }),
  getWindowInfo: () => ({
    windowHeight: 800, windowWidth: 375, statusBarHeight: 20, pixelRatio: 2,
    screenHeight: 800, screenWidth: 375
  }),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  nextTick: (fn) => fn()
};

global.resetWxStubs = function resetWxStubs(overrides = {}) {
  const impls = { ...DEFAULT_STUB_IMPLS, ...overrides };
  Object.keys(impls).forEach((key) => {
    if (typeof wx[key] === 'function') {
      wx[key].mockReset();
      wx[key].mockImplementation(impls[key]);
    }
  });
  // 选图 API 等「用例自行mockImplementation、默认无回调」的桩同样要复位。
  // 不复位会跨用例泄漏：上一个用例设的 platform/chooseMedia 实现会留在下一个用例里，
  // 表现为「单跑通过、整文件跑失败」——这类顺序依赖最难查。
  //
  // 用例为了模拟旧基础库会把 wx.chooseMedia 置为 undefined，因此这里必须**重建**
  // 桩函数（mockReset 对 undefined 无效），否则后续所有用例都会拿到一个不存在的 API。
  ['chooseMedia', 'chooseImage', 'login'].forEach((key) => {
    wx[key] = jest.fn();
  });
  return wx;
};

// Helper to merge behavior methods into page object (for test environment)
//
// 两种 behavior 形态都要认：
//   1. 真实的 Behavior({ methods: {...} }) —— 运行时形态，方法在 .methods 下；
//   2. jest.mock 替换出来的**平铺对象**（admin 测试普遍这么写：
//      jest.mock('.../adminBehavior', () => ({ goBack, verifyAdmin, callAdminFunction }))）。
//      过去只认第 1 种，第 2 种被整段跳过 —— 于是页面实例上根本没有 goBack，
//      鉴权失败分支里 `setTimeout(() => this.goBack(), 1500)` 在用例结束后触发
//      TypeError: this.goBack is not a function。jest 会把这个异步未捕获异常
//      **记在当时正在跑的任意套件头上**（实测先后嫁祸给 imageRetryManager、
//      notice-manage、manage-admins），表现为「同一份代码门禁时红时绿」，
//      而真正的错在另一个文件 —— 比任何一条业务缺陷都难查。
function _mergeBehaviors(obj) {
  if (obj && obj.behaviors && Array.isArray(obj.behaviors)) {
    obj.behaviors.forEach(function(behavior) {
      if (!behavior || typeof behavior !== 'object') return;
      if (behavior.methods && typeof behavior.methods === 'object') {
        Object.assign(obj, behavior.methods);
      } else {
        // 平铺形态：把顶层函数属性按「页面实例上的方法」并进来（不覆盖页面自有实现）
        Object.keys(behavior).forEach(function(key) {
          if (typeof behavior[key] === 'function' && !(key in obj)) obj[key] = behavior[key];
        });
      }
    });
  }
  // 入口权限门禁是 2026-10 新增的 behavior 方法；历史页面测试普遍用平铺对象
  // mock adminBehavior（只含 goBack/verifyAdmin/callAdminFunction），缺这个方法
  // 会让 onLoad 直接 TypeError。测试环境默认放行，门禁本身由 adminBehavior /
  // admin 首页 / manage-admins 的专门用例覆盖。
  if (typeof obj.guardPermission !== 'function') {
    obj.guardPermission = function() { return true; };
  }
  return obj;
}

const _defaultPageMock = jest.fn(function(obj) { return _mergeBehaviors(obj); });
let _currentPageMock = _defaultPageMock;

Object.defineProperty(global, 'Page', {
  get: function() { return _currentPageMock; },
  set: function(fn) {
    if (typeof fn === 'function') {
      _currentPageMock = jest.fn(function(obj) {
        _mergeBehaviors(obj);
        return fn(obj);
      });
    } else {
      _currentPageMock = fn;
    }
  },
  configurable: true
});

global.App = jest.fn(fn => {
  if (typeof fn === 'function') return fn();
  if (typeof fn === 'object') return fn;
});
