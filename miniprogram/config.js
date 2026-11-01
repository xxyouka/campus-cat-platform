// config.js
// 小程序配置文件

// 云开发环境ID配置说明：
// 优先级（从高到低）：
// 1. 全局变量 global.__CLOUD_ENV__ （测试/调试使用）
// 2. project.config.json 中的 setting.envList 配置（推荐）
// 3. 回退 undefined —— 交给 wx.cloud.init() 使用当前工具的默认环境
//
// 安全提示：
// - 生产环境请使用 envList 配置，不要硬编码
// - 云函数中应通过 cloud.DYNAMIC_CURRENT_ENV 动态获取
const CLOUD_ENV = (function() {
  if (typeof global !== 'undefined' && global.__CLOUD_ENV__) {
    return global.__CLOUD_ENV__;
  }

  try {
    const projectConfig = require('./project.config.json');
    const envList = projectConfig?.setting?.envList;
    if (envList && Array.isArray(envList) && envList.length > 0) {
      return envList[0].env;
    }
  } catch (e) { /* ignore */ }

  // 原实现在此读取 wx.getAccountInfoSync().miniProgram.envVersion，但无论取值如何
  // 都 `return undefined` —— 该分支恒等于「返回 undefined」，是一段从不生效的死代码。
  // 已删除：环境解析保持在上面两条，未命中即回退 undefined（即 wx.cloud.init 的默认环境）。
  return undefined;
})();

module.exports = {
  // 运行环境: 'development' | 'production'
  // 自动检测：体验版/正式版 → production，开发工具 → development
  env: (function() {
    try {
      const info = wx.getAccountInfoSync();
      const envVersion = info.miniProgram?.envVersion;
      // develop=开发版, trial=体验版, release=正式版
      if (envVersion === 'release' || envVersion === 'trial') return 'production';
    } catch (e) { /* ignore */ }
    return 'development';
  })(),

  // 云开发环境ID（已优化：支持动态配置）
  cloudEnv: CLOUD_ENV,
  
  // 版本号
  version: '3.11.3',

  // 订阅消息模板 ID（微信公众平台 → 订阅消息 → 我的模板）
  // 留空 = 关闭微信订阅推送，站内消息不受影响。
  // 需要推送时填入自己的模板 ID，并在云函数环境变量中配置同名值。
  subscribeTemplateId: '',
  subscribeMeetTemplateId: '',
  subscribeNewCatTemplateId: '',

  // ========== 引导（欢迎屏 / 版本更新卡 / 全功能就地导览）==========
  // 内容在 config/guidance.js：更新卡按版本登记；tours 覆盖每个用户页面。
  // selector 必须真实存在于对应页面 WXML 的 id 上，由 scripts/check-guidance.js
  // 校验，避免“配置写了但页面没这个元素”。
  guidance: require('./config/guidance'),

  // 联系信息（已迁移至云函数环境变量，防止隐私泄露）
  // 通过 getConfig 云函数动态获取，不要在此硬编码
  contact: {
    wechat: '',
    email: ''
  },
  
  // 学校信息（示例值，部署前改成自己的学校/组织）
  school: {
    name: '示例大学',
    department: '示例学院'
  },
  
  // 数据库集合名称
  collections: {
    cats: 'cats',
    photos: 'photos',
    albums: 'albums',
    admins: 'admins',
    notices: 'notices',
    recordMeet: 'recordMeet',
    login_attempts: 'login_attempts',
    health_records: 'health_records',
    userFavorites: 'userFavorites',
    notifications: 'notifications',
    userSubscriptions: 'userSubscriptions',
    subscribeQuota: 'subscribeQuota',
    catRelations: 'cat_relations',
    operationLogs: 'operation_logs',
    mediaChecks: 'mediaChecks',
    repairLogs: 'repair_logs',
    userReports: 'user_reports'
  },
  
  // 性别映射（统一维护，消除 magic strings）
  genderMap: { male: '公', female: '母' },

  // ========== 全局常量（消除魔法数字）==========

  // 安全相关
  security: {
    // 登录安全
    loginAttemptLimit: 5,           // 最大登录尝试次数
    loginLockTime: 15 * 60 * 1000, // 锁定时间：15分钟
    // 密码盐值已迁移至云函数环境变量 PASSWORD_SALT
    // 请在云开发控制台设置，不要在此硬编码

    // 管理员认证签名
    authSignatureExpiry: 1 * 60 * 60 * 1000, // 签名有效期：1小时（缩短提升安全性）

    // 输入验证
    maxNameLength: 50,             // 名字最大长度
    maxDescriptionLength: 500,      // 描述最大长度
    maxKeywordLength: 50,           // 搜索关键词最大长度
    objectIdPattern: /^[a-fA-F0-9]{24}$/, // MongoDB ID格式
    objectIdPattern20to40: /^[a-fA-F0-9]{20,40}$/ // 云开发ID格式（20-40位）
  },

  // 性能优化
  performance: {
    // 图片加载
    imageRetryBaseDelay: 800,       // 图片重试基础延迟(ms)
    imageRetryMaxAttempts: 2,      // 图片最大重试次数
    imageConcurrentRetries: 3,     // 图片并发重试数

    // 分批处理
    setDataBatchSize: 8,           // setData每批处理数量
    prefetchAllBatchSize: 100,     // 预取数据每批大小

    // 查询超时保护（ms）
    queryTimeout: 5000,             // 数据库查询超时时间

    // 缓存策略（v2.0 新增）
    cacheDuration: {
      short: 5 * 60 * 1000,        // 短期缓存：5分钟（详情页预取）
      medium: 10 * 60 * 1000,      // 中期缓存：10分钟（列表页）
      long: 30 * 60 * 1000         // 长期缓存：30分钟（配置/公告）
    },

    // UI交互
    searchDebounceDelay: 300,     // 搜索防抖延迟(ms)
    filterDebounceDelay: 200,     // 筛选项点击防抖延迟(ms) - 选项是离散点击，比搜索短；防连续点多个选项打多次云函数
    meetCheckDelay: 100,          // 打卡状态检查延迟(ms)
    touchPreloadDelay: 80,        // 触摸后预取延迟(ms) - 避免误触
    networkRecoveryToastDuration: 1500,  // 网络恢复提示时长(ms)

    // 数据加载
    // 默认分页大小（使用 pagination 下的配置作为单一来源）
    // pageSize: 20, 已废弃 — 请使用 config.pagination.*
    maxCatsLoadLimit: 500,         // 全量加载最大猫咪数
    avatarCacheExpiry: 3600000,   // 头像缓存过期时间(1小时)

    // 动画时长
    animation: {
      fadeIn: 200,                // 淡入动画(ms)
      slideUp: 300,               // 上滑动画(ms)
      pulse: 1500,                // 呼吸动画周期(ms)
      staggerDelay: 40             // 词云逐个入场间隔(ms)
    },
    prefetchAllMaxBatches: 10,     // 预取最大批次数（上限1000条）

    // 缓存
    imageCacheExpireTime: 10 * 60 * 1000,   // 图片缓存过期：10分钟
    imageCacheMaxSize: 300,                 // 图片缓存最大数量
    preloadQueueMaxSize: 100,               // 预加载队列上限
    prefetchCacheExpiry: 5000,               // 预取缓存有效期：5秒
    prefetchCacheCleanupInterval: 30000,     // 预取缓存清理间隔：30秒

    // 性能阈值
    slowOperationThreshold: 1000,  // 慢操作阈值：1秒
  }
};
