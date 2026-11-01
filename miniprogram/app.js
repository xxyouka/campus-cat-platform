/**
 * app.js - 小程序入口文件
 *
 * 简化版：只负责初始化
 * 职责：
 * 1. 初始化云开发环境
 * 2. 同步管理员登录状态
 * 3. 监听网络状态
 * 4. 管理全局预取缓存（使用LRU算法，自动淘汰过期数据）
 */
const config = require('./config');
const { LRUCache } = require('./utils/cacheCore');
const obsHelper = require('./utils/obsHelper');
const opsTrack = require('./utils/opsTrack');
const compat = require('./utils/compat');
const ErrorHandler = require('./utils/errorHandler');
const { checkAdminAuth } = require('./utils/adminAuth');
const startupTrace = require('./utils/startupTrace');
const TabBadge = require('./utils/tabBadge');
const shareHelper = require('./utils/shareHelper');

// 仅在开发环境输出日志
// eslint-disable-next-line no-console
const devLog = config.env === 'development' ? console.log : () => {};

if (!wx.getWindowInfo) {
  wx.getWindowInfo = compat.getWindowInfo;
}
if (!wx.getDeviceInfo) {
  wx.getDeviceInfo = compat.getDeviceInfo;
}

App({
  globalData: {
    version: config.version,
    isAdmin: false,
    isOnline: true,
    _prefetchCache: new LRUCache({
      maxSize: 30,
      maxAge: 120000,
      cleanupInterval: 60000
    })
  },

  async onLaunch() {
    // 不注册自定义隐私弹窗（wx.onNeedPrivacyAuthorization）。
    //
    // 官方要求：自定义弹窗里「同意」必须经由 <button open-type="agreePrivacyAuthorization">
    // 触发，且 resolve({ event: 'agree' }) 必须携带该按钮的 buttonId（文档注明「仅 event=agree
    // 时必填」），基础库会校验该按钮是否被真实点击过；不满足则隐私接口直接失败
    // （errMsg: privacy permission is not authorized）。
    //
    // 旧实现用 wx.showModal + resolve({ event: 'agree' })（无 buttonId、无同意按钮），
    // 在新版基础库上校验不通过 → 选图接口必失败；chooseMedia 失败后回退 chooseImage
    // （同为隐私接口）会再弹一次，表现为「弹两次授权弹窗 → 您没有权限执行此操作」。
    //
    // 不注册监听时，微信会自动弹出官方隐私弹窗（含《隐私保护指引》链接与同意/拒绝按钮），
    // 由平台自行完成点击校验，行为在所有基础库版本上一致。
    // 若将来要做自定义样式的隐私弹窗：必须在页面 wxml 放
    //   <button id="agree-btn" open-type="agreePrivacyAuthorization"
    //           bindagreeprivacyauthorization="...">同意</button>
    // 并在该回调里 resolve({ buttonId: 'agree-btn', event: 'agree' })。
    //
    // 启动埋点基准点。必须**最先**执行：早于它的时间不算「启动耗时」，
    // 所以放在所有 await 和其它初始化之前，且它自身不做任何 IO。
    startupTrace.init();

    // 更新管理器必须**先于任何 await** 注册：它是同步挂监听，
    // 一旦排在 initCloud 后面，冷启动网络慢时就已经错过 onUpdateReady 了。
    this.initUpdateManager();

    // 品牌分享卡预热成本地路径：分享回调必须同步返回，不能现场等 IO
    shareHelper.warmBrandImages();

    await this.initCloud();
    startupTrace.mark('cloud-ready');
    this.globalData.isAdmin = checkAdminAuth();

    // 不 await（缓存命中时零成本）；openid 由 initObs 读取用作观测平台自定义 ID
    // （见 initOpenId 的说明），云端识别用户靠各自的 getWXContext().OPENID、不依赖前端传递。
    this.initOpenId();

    // 初始化全局异常捕获
    ErrorHandler.initGlobalErrorCatch(this);

    this.initObs();

    // 运营面板：冷启动上报「今天来过」并补发上次残留的入口队列。
    // 不 await：埋点永远不能拖慢启动；失败只影响运营数据，不影响功能。
    this.initOpsTracking();

    this.initNetworkStatus();

    // 初始化深色模式适配
    this.initTheme();

    try {
      require('./utils/imageLoader');
    } catch (e) {
      console.warn('[App] imageLoader初始化失败（非致命）', e.message || e);
    }

    devLog('[App] LRU预取缓存已初始化', {
      maxSize: 30,
      maxAge: '2分钟',
      autoCleanup: '每分钟'
    });

    // 刷新浏览量队列（重试失败记录）
    this.flushViewRecordQueue();
  },

  /**
   * 拉取并缓存 openid 到本地 Storage。
   *
   * 消费方：`initObs()` 读取该 Storage 键作为观测平台自定义 ID
   * （`obsHelper.setCustomId(openid)`，把埋点数据关联到用户）。
   * 云端识别用户一律用各自的 `getWXContext().OPENID`，不依赖前端传递。
   *
   * 链路保留（2026-10-07 复核）：此前注释误记「无任何读取方」——
   * 实际 `initObs` 一直在消费该 Storage 键，删除会导致观测平台用户标识静默丢失。
   * 已从 onLaunch 主链移除 await，避免首次启动为它阻塞。
   */
  async initOpenId() {
    try {
      const cachedOpenid = wx.getStorageSync('openid');
      if (cachedOpenid) return;

      const res = await wx.cloud.callFunction({ name: 'getOpenId' });
      // ok() 包装：业务字段在 result.data 下（兼容旧版平铺结构）
      const openid = res.result?.data?.openid || res.result?.openid;
      if (res.result?.success && openid) {
        wx.setStorageSync('openid', openid);
        devLog('[App] openid获取成功');
      }
    } catch (e) {
      console.warn('[App] openid获取失败（非致命）', e.message || e);
    }
  },

  async initObs() {
    if (!obsHelper.isAvailable()) {
      devLog('[App] 体验分析SDK不可用（需基础库>=2.29.1），跳过');
      return;
    }

    try {
      const ready = await obsHelper.trySetup();

      if (ready) {
        const openid = wx.getStorageSync('openid');
        if (openid) {
          obsHelper.setCustomId(openid);
        }

        obsHelper.setCustomProperties({
          user_type: this.globalData.isAdmin ? 'admin' : 'visitor',
          app_version: this.globalData.version || 'unknown'
        });

        devLog('[App] 体验分析SDK已初始化', {
          status: obsHelper.getStatus(),
          hasCustomId: !!openid
        });
      } else {
        devLog('[App] 体验分析SDK未就绪（开发环境或未开通），跳过自定义属性设置');
      }
    } catch (e) {
      console.warn('[App] 体验分析SDK初始化失败（非致命）', e.message || e);
    }
  },

  /**
   * 运营面板埋点：只报「今天来过」与本机会话的入口队列。
   * 与 obsHelper（微信体验分析）相互独立：那份数据在小程序后台，
   * 这份数据在自家云数据库，管理端才能按四个固定指标做周复盘。
   */
  initOpsTracking() {
    opsTrack.bootstrap().catch(() => {});
  },

  /**
   * 初始化云开发环境（确保完成后页面才加载）
   */
  initCloud() {
    if (!wx.cloud) {
      console.error('[App] 请使用 2.2.3 或以上的基础库以使用云能力');
      return Promise.resolve();
    }

    const cloudEnv = config.cloudEnv;

    const p = wx.cloud.init({
      env: cloudEnv || undefined,
      traceUser: false
    });
    // 不能假定 init() 一定返回 thenable：老基础库 / 部分桩返回 undefined。
    // 用 Promise.resolve 包一层既保证调用方拿到 Promise，也顺带兜住这种形状。
    return Promise.resolve(p).then(r => {
      // 与 cloud-ready 分开打点：SDK 初始化和「真正连上云」是两回事，
      // 慢网下后者往往才是大头，合在一起看不出问题在哪。
      startupTrace.mark('cloud-sdk-init');
      return r;
    });
  },

  /**
   * 初始化深色模式适配（全局主题标记 + 运行时切换）
   */
  initTheme() {
    try {
      const appBaseInfo = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      this.globalData.theme = appBaseInfo.theme || 'light';
      // 冷启动**不再**手动刷 tabBar：theme.json 已声明浅/深两套 tabBar 配色与全部图标
      // （app.json 的 darkmode + themeLocation），框架会随系统主题自动应用。
      // 原实现每次冷启动都多打 1 次 setTabBarStyle + 3 次 setTabBarItem —— 纯冗余
      //（2026-10-15 启动微优化；运行时切换仍由下面的 onThemeChange 兜底）。
      devLog('[App] 深色模式已初始化', { theme: this.globalData.theme });
    } catch (e) {
      this.globalData.theme = 'light';
    }

    // 监听系统主题变化
    if (wx.onThemeChange) {
      wx.onThemeChange(({ theme }) => {
        this.globalData.theme = theme;
        this._applyTabBarTheme(theme);
        devLog('[App] 主题切换', { theme });
      });
    }
  },

  /**
   * 根据主题动态切换 TabBar 样式
   */
  _applyTabBarTheme(theme) {
    const isDark = theme === 'dark';

    wx.setTabBarStyle({
      color: isDark ? '#958F88' : '#9B9B9B',
      selectedColor: isDark ? '#F5A593' : '#E8927C',
      backgroundColor: isDark ? '#211D1A' : '#FFFFFF',
      borderStyle: isDark ? 'black' : 'white'
    });

    // 深色模式切换图标
    const tabs = [
      { i: 0, l: 'images/home.png', d: 'images/home-dark.png', ls: 'images/home-active.png', ds: 'images/home-active-dark.png' },
      { i: 1, l: 'images/gallery.png', d: 'images/gallery-dark.png', ls: 'images/gallery-active.png', ds: 'images/gallery-active-dark.png' },
      { i: 2, l: 'images/user.png', d: 'images/user-dark.png', ls: 'images/user-active.png', ds: 'images/user-active-dark.png' }
    ];
    tabs.forEach(t => wx.setTabBarItem({
      index: t.i, iconPath: isDark ? t.d : t.l, selectedIconPath: isDark ? t.ds : t.ls
    }));
  },

  /**
   * 初始化网络状态监听
   */
  initNetworkStatus() {
    // 获取初始网络状态
    wx.getNetworkType({
      success: (res) => {
        this.globalData.isOnline = res.networkType !== 'none';
      }
    });

    // 监听网络状态变化（仅更新状态，不弹 Toast，由各页面自行处理提示）
    wx.onNetworkStatusChange((res) => {
      this.globalData.isOnline = res.isConnected;
    });
  },

  /**
   * 小程序进入后台时，暂停 imageLoader 定时器节省资源
   */
  onHide() {
    try {
      const imageLoader = require('./utils/imageLoader');
      if (imageLoader && imageLoader.pauseCleanup) {
        imageLoader.pauseCleanup();
      }
    } catch (e) {
      console.warn('[App] 暂停imageLoader失败', e.message || e);
    }

    // 入口队列在退到后台时批量上报；失败会保留，下次 onShow/冷启动继续。
    opsTrack.flush().catch(() => {});
  },

  /**
   * 新版本更新引导（FE-23）
   *
   * 此前全仓 0 命中：微信把新包静默下发并切到「下次冷启动生效」，
   * 用户不主动重启就一直跑旧代码 —— 表现是「改了但没生效」「界面还是老的」，
   * 而他没有任何办法知道。仓库历史上已经吃过一次同版本号重复上传、
   * 客户端不拉新包的亏。
   *
   * 只在 onUpdateReady（有新包且已下载完）时提示，且给「稍后再说」而不是强制重启：
   * 强制重启会打断正在填的表单、打到一半的木鱼次数。
   */
  initUpdateManager() {
    // 极老基础库没有这个 API，静默跳过而不是抛错
    if (!wx.getUpdateManager) return;
    try {
      const updateManager = wx.getUpdateManager();

      updateManager.onUpdateReady(() => {
        wx.showModal({
          title: '新版本已就绪',
          content: '重启后即可使用新版本',
          confirmText: '立即重启',
          cancelText: '稍后再说',
          success: (res) => {
            if (res.confirm) updateManager.applyUpdate();
          }
        });
      });

      updateManager.onUpdateFailed(() => {
        devLog('[App] 新版本下载失败，将继续使用当前版本');
      });
    } catch (e) {
      // 非致命：拿不到更新管理器只是没有升级引导，不该影响启动
      console.warn('[App] 更新管理器初始化失败（非致命）', e.message || e);
    }
  },

  /**
   * 小程序回到前台时，恢复 imageLoader 定时器
   */
  onShow() {
    try {
      const imageLoader = require('./utils/imageLoader');
      if (imageLoader && imageLoader.resumeCleanup) {
        imageLoader.resumeCleanup();
      }
    } catch (e) {
      console.warn('[App] 恢复imageLoader失败', e.message || e);
    }

    // 未读红点：只读本地缓存恢复，不发网络请求（真实计数由「我的」/消息页拉取后回写）。
    // 放在 onShow 而不是 onLaunch：冷启动时 tabBar 可能还没就绪，onShow 时机更稳。
    TabBadge.refreshFromCache();

    // 重试失败的浏览量记录
    this.flushViewRecordQueue();

    // 补发上次残留的入口队列（onHide 时上报失败的兜底）
    opsTrack.flush().catch(() => {});
  },

  /**
   * 刷新浏览量记录队列（重试失败的上报）
   * 分批并发限制：每批最多 5 个并发，避免大批量请求触发云函数限流
   *
   * 重入守卫（_flushingViewQueue）：onLaunch 与 onShow 都会调用本方法。
   * 冷启动时序：onShow 先触发并开始上报，约 200ms 后 onLaunch 的 initCloud
   * 完成后再次调用 —— 两者会读到同一份队列快照并各发一轮 recordView。
   * 云函数的 5 分钟去重是实例级内存，跨实例不共享，重复调用会真实地把
   * 浏览量多记一次。同一时刻只允许一轮 flush，后到者直接返回（下次 onShow
   * 或写入新失败记录时自然会再处理）。
   */
  async flushViewRecordQueue() {
    if (this._flushingViewQueue) return;
    this._flushingViewQueue = true;
    try {
      const queue = wx.getStorageSync('_viewRecordQueue');
      if (!queue || !queue.length) return;

      devLog('[App] 发现待重试的浏览量记录:', queue.length, '条');

      // 快照本次待处理项：flush 期间 detail 页可能新入队记录，
      // 结束时仅移除快照内已成功的项，避免误删新入队的浏览量
      const snapshot = queue.map(item => ({ ...item }));

      // 分批处理，每批 5 个并发，避免一次性触发过多云函数调用
      const BATCH_SIZE = 5;
      const results = [];

      for (let i = 0; i < snapshot.length; i += BATCH_SIZE) {
        const batch = snapshot.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(item =>
            wx.cloud.callFunction({ name: 'recordView', data: { catId: item.catId } })
              .then(res => ({ success: !!(res && res.result && res.result.success) }))
              .catch(err => ({ success: false, error: err }))
          )
        );
        results.push(...batchResults);
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      // 重新读取当前队列（可能已包含 flush 期间新入队的记录）
      const currentRaw = wx.getStorageSync('_viewRecordQueue');
      const current = Array.isArray(currentRaw) ? currentRaw : [];

      // 按快照索引统计已成功项；同键多条时按数量扣除，避免误删重复入队项
      const successKeys = {};
      snapshot.forEach((item, i) => {
        if (results[i] && results[i].success) {
          const key = `${item.catId}|${item.timestamp || ''}`;
          successKeys[key] = (successKeys[key] || 0) + 1;
        }
      });

      const remaining = [];
      const consumed = {};
      current.forEach(item => {
        const key = `${item.catId}|${item.timestamp || ''}`;
        const used = consumed[key] || 0;
        if (used < (successKeys[key] || 0)) {
          consumed[key] = used + 1; // 已被本次成功上报消化，移除
        } else {
          remaining.push(item);
        }
      });

      if (remaining.length === 0) {
        wx.removeStorageSync('_viewRecordQueue');
      } else {
        wx.setStorageSync('_viewRecordQueue', remaining);
      }

      if (failCount === 0) {
        devLog('[App] 浏览量队列全部重试成功', { count: successCount, kept: remaining.length });
      } else {
        devLog('[App] 浏览量队列部分重试失败', { successCount, failCount, kept: remaining.length });
      }
    } catch (e) {
      console.warn('[App] 浏览量队列刷新失败', e.message || e);
    } finally {
      // 无论成功、失败还是中途提前返回，都要复位守卫，
      // 否则后续 onShow / 新失败记录的重试会永远被拦下
      this._flushingViewQueue = false;
    }
  },

  /**
   * 获取预取缓存数据（便捷方法）
   * @param {string} catId - 猫咪ID
   * @returns {object|undefined} 缓存数据
   */
  getPrefetchCache(catId) {
    return this.globalData._prefetchCache.get(catId);
  },

  /**
   * 设置预取缓存数据（便捷方法）
   * @param {string} catId - 猫咪ID
   * @param {object} data - 缓存数据（包含cat, photos等）
   */
  setPrefetchCache(catId, data) {
    this.globalData._prefetchCache.set(catId, {
      ...data,
      timestamp: Date.now()
    });
  },

  /**
   * 获取预取缓存统计信息（调试用）
   */
  getPrefetchCacheStats() {
    return this.globalData._prefetchCache.getStats();
  },

  /**
   * 销毁预取缓存（小程序退出时调用）
   */
  destroyPrefetchCacheCleanup() {
    if (this.globalData._prefetchCache) {
      const stats = this.globalData._prefetchCache.getStats();
      devLog('[App] 预取缓存销毁统计:', stats);

      this.globalData._prefetchCache.destroy();
      devLog('[App] 预取缓存已完全销毁');
    }
  },

  /**
   * 页面找不到时重定向到首页
   * 处理用户点击旧分享链接或无效路径的场景
   */
  onPageNotFound(res) {
    console.warn('[App] 页面不存在，尝试智能重定向', { path: res.path, query: res.query });

    // 尝试从路径中提取猫咪ID进行智能重定向
    const catIdMatch = res.path.match(/detail[?/]id=([a-fA-F0-9]{20,40})/);
    if (catIdMatch) {
      wx.reLaunch({
        url: `/pages/detail/detail?id=${catIdMatch[1]}`
      });
      return;
    }

    // 兜底重定向到首页
    wx.reLaunch({
      url: '/pages/index/index'
    });
  },

  onError(error) {
    try {
      ErrorHandler.handleGlobalError(error);
      // 上报到观测平台，便于线上问题排查
      const errMsg = typeof error === 'string' ? error : error?.message || String(error);
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GLOBAL_ERROR, {
        message: errMsg.substring(0, 255)
      });
    } catch (e) {
      console.error('[App] onError处理失败:', e);
    }
  },

  onUnhandledRejection(res) {
    ErrorHandler.handleUnhandledRejection(res);
    // 上报到观测平台
    const reason = res?.reason;
    const errMsg = reason instanceof Error ? reason.message
      : typeof reason === 'string' ? reason : String(reason || '');
    obsHelper.reportEvent(obsHelper.EVENT_NAMES.UNHANDLED_REJECTION, {
      message: errMsg.substring(0, 255)
    });
  }
});
