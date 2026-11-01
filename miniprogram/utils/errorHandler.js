/**
 * utils/errorHandler.js - 统一错误处理工具（增强版）
 *
 * 提供统一的错误处理、日志记录、用户提示功能
 * 支持网络错误、云函数错误、业务错误的处理
 * 
 * 新增功能：
 * 1. 全局异常捕获（App.onError）
 * 2. 错误分级（FATAL/ERROR/WARN/INFO）
 * 3. 智能错误消息（根据场景生成友好提示）
 * 4. 错误上报接口（可扩展到监控系统）
 */

const { Logger } = require('./logger');

const ERROR_LEVELS = {
  FATAL: 'fatal',
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info'
};

let _isHandlingError = false;

// 错误类型映射表（用于生成用户友好提示）
const USER_FRIENDLY_MESSAGES = {
  // 网络相关
  network: {
    timeout: '网络有点慢，请稍后重试',
    offline: '网络连接已断开，请检查网络设置',
    serverError: '服务器繁忙，请稍后重试',
    unknown: '网络出现问题，请检查网络后重试'
  },
  
  // 数据相关
  data: {
    notFound: '数据未找到',
    loadFailed: '数据加载失败，请重试',
    saveFailed: '保存失败，请重试',
    invalidData: '数据格式有误'
  },
  
  // 权限相关
  permission: {
    denied: '您没有权限执行此操作',
    loginRequired: '请先登录后再操作',
    adminRequired: '需要管理员权限'
  },
  
  // 业务逻辑
  business: {
    duplicate: '操作重复，请勿频繁提交',
    limitExceeded: '超出操作限制',
    invalidParam: '参数不正确'
  }
};

// 关键词 → 友好文案 的匹配规则表（数组顺序即优先级，先命中先返回）
// 抽成模块级常量：避免每次调用重新构造，也让 getFriendlyMessage 本身保持低复杂度
const FRIENDLY_MESSAGE_RULES = [
  { keywords: ['timeout', '超时'], message: USER_FRIENDLY_MESSAGES.network.timeout },
  { keywords: ['network', 'net::', '连接'], message: USER_FRIENDLY_MESSAGES.network.offline },
  { keywords: ['500', '502', '503'], message: USER_FRIENDLY_MESSAGES.network.serverError },
  // 隐私授权被拒（privacy permission is not authorized）必须排在通用 permission 规则之前：
  // 否则会被映射成「您没有权限执行此操作」，用户不知道是自己没点同意，也不知道怎么恢复。
  // 同理「api scope is not declared in the privacy agreement」是平台侧隐私协议未声明
  // （chooseMedia 等隐私接口会直接失败），也不能落入通用 permission 分支。
  { keywords: ['privacy permission', 'privacy agreement', 'scope is not declared'], message: '需要先完成隐私授权：请在弹窗中点击允许（若仍失败请联系管理员）' },
  { keywords: ['permission', '权限'], message: USER_FRIENDLY_MESSAGES.permission.denied },
  { keywords: ['unauthorized', '未授权'], message: USER_FRIENDLY_MESSAGES.permission.loginRequired },
  { keywords: ['not found', '不存在'], message: USER_FRIENDLY_MESSAGES.data.notFound },
  { keywords: ['cloud function', '云函数'], message: '服务暂时不可用，请稍后重试' }
];

/**
 * 错误处理类
 */
class ErrorHandler {
  /**
   * 处理并显示错误
   * @param {Error|string} error - 错误对象或错误消息
   * @param {Object} options - 选项
   * @param {string} options.title - Toast 标题（默认从错误消息提取）
   * @param {number} options.duration - 持续时间（默认 2000ms）
   * @param {boolean} options.log - 是否打印日志（默认 true）
   * @param {boolean} options.show - 是否显示 Toast（默认 true）
   * @returns {string} 错误消息
   */
  static handle(error, options = {}) {
    const {
      title = null,
      duration = 2000,
      log = true,
      show = true
    } = options;

    // 构造错误消息（优先使用友好消息，再回退到原始错误）
    const rawMsg = error?.message || error || title || '操作失败';
    const message = options.friendly !== false ? this.getFriendlyMessage(error, options.context || '') : rawMsg;

    // 打印日志
    if (log) {
      if (error instanceof Error) {
        Logger.error('ErrorHandler', error && error.message || 'unknown', error);
        if (error.stack) {
          Logger.debug('[ErrorHandler] Stack:', error.stack);
        }
      } else {
        Logger.error('ErrorHandler', error && error.message || 'unknown', error);
      }
    }

    // 显示 Toast
    if (show) {
      wx.showToast({
        title: message,
        icon: 'none',
        duration
      });
    }

    return message;
  }

  /**
   * 异步错误处理包装器
   * @param {Function} fn - 异步函数
   * @param {Object} options - 错误处理选项
   * @returns {Promise<any>} 函数执行结果或错误
   *
   * 使用注意（避免类型混淆）：
   * - 成功时返回 fn() 的真实结果；
   * - 失败时【不抛出】，返回 handle() 的友好错误【字符串】。
   * 因此返回类型不稳定：调用方若直接把返回值当数据使用，出错时会把字符串当数据、
   * 且错误被静默吞掉。调用前请确认返回值做类型判别，或改用 try/catch + handle 自行处理。
   */
  static async try(fn, options = {}) {
    try {
      return await fn();
    } catch (error) {
      return this.handle(error, options);
    }
  }

  /**
   * 网络请求错误处理
   * @param {Error} error - 错误对象
   * @param {Object} options - 选项
   * @param {boolean} options.show - 是否显示提示（默认 true）
   * @returns {string} 用户友好的错误消息
   */
  static handleNetworkError(error, options = {}) {
    const { show = true } = options;

    const messageMap = {
      'request:fail': '网络连接失败，请检查网络',
      'request:fail timeout': '请求超时，请重试',
      'request:fail abort': '请求已取消',
      'request:fail -2:net::ERR_NAME_NOT_RESOLVED': '网络连接失败，请检查网络',
      'request:fail -2:net::ERR_CONNECTION_TIMED_OUT': '网络连接超时，请稍后重试',
      'request:fail -2:net::ERR_INTERNET_DISCONNECTED': '网络未连接',
      'cloud function request fail': '云函数调用失败'
    };

    const errMsg = error?.errMsg || '';
    const message = Object.entries(messageMap).find(([key]) =>
      errMsg.includes(key)
    )?.[1] || '操作失败，请重试';

    if (show) {
      wx.showToast({ title: message, icon: 'none', duration: 2000 });
    }

    Logger.error('ErrorHandler', '网络错误', error);
    return message;
  }

  /**
   * 云函数错误处理
   * @param {Object} result - 云函数返回结果
   * @param {Object} options - 选项
   * @param {boolean} options.show - 是否显示提示（默认 true）
   * @returns {boolean} 是否成功
   */
  static handleCloudFunctionResult(result, options = {}) {
    const { show = true } = options;

    // 检查返回值
    if (!result || !result.result) {
      const message = '云函数返回数据格式错误';
      if (show) {
        wx.showToast({ title: message, icon: 'none', duration: 2000 });
      }
      Logger.error('ErrorHandler', '云函数返回错误', result);
      return false;
    }

    // 检查成功标志
    if (!result.result.success) {
      // 后端 fail() 将文案放在 error 字段，message 恒为空串；此处两者兼容
      const message = result.result.error || result.result.message || '操作失败';
      if (show) {
        wx.showToast({ title: message, icon: 'none', duration: 2000 });
      }
      Logger.error('[ErrorHandler] 云函数业务错误:', result.result);
      return false;
    }

    return true;
  }

  /**
   * 解包云函数统一响应
   * 后端 ok(data) 统一包装为 { success, data, message }，但历史调用点存在
   * 直接读顶层字段（result.meets 等）的用法，导致静默取到 undefined。
   * 本方法将 data 中的字段提升到顶层（success/data/message/error/code
   * 等保留字段以原值为准，不被覆盖），使 result.xxx 与 result.data.xxx
   * 两种读法都能得到正确结果。
   * @param {Object} result - 云函数返回的 res.result
   * @returns {Object} 解包后的结果对象
   */
  static unwrapResult(result) {
    if (!result || typeof result !== 'object') return result;
    const data = result.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
    return Object.assign({}, data, result);
  }

  /**
   * 数据验证错误处理
   * @param {string} field - 字段名
   * @param {string} message - 错误消息
   * @param {Object} options - 选项
   * @returns {string} 错误消息
   */
  static handleValidationError(field, message, options = {}) {
    const fullMessage = `${field}${message}`;
    return this.handle(fullMessage, options);
  }

  /**
   * 数据库错误处理
   * @param {Error} error - 错误对象
   * @param {Object} options - 选项
   * @returns {string} 错误消息
   */
  static handleDatabaseError(error, options = {}) {
    const messageMap = {
      'permission denied': '无权操作',
      'collection not found': '数据集合不存在',
      'document not found': '数据不存在',
      'network error': '网络错误，请重试'
    };

    const errMsg = error?.message || '';
    const message = Object.entries(messageMap).find(([key]) =>
      errMsg.includes(key)
    )?.[1] || '数据操作失败，请重试';

    Logger.error('[ErrorHandler] 数据库错误:', error);
    return this.handle(message, options);
  }

  /**
   * 云存储错误处理
   * @param {Error} error - 错误对象
   * @param {Object} options - 选项
   * @returns {string} 错误消息
   */
  static handleStorageError(error, options = {}) {
    const messageMap = {
      'no such file': '文件不存在',
      'file size exceed': '文件大小超限',
      'upload failed': '上传失败，请重试',
      'delete failed': '删除失败，请重试'
    };

    const errMsg = error?.message || '';
    const message = Object.entries(messageMap).find(([key]) =>
      errMsg.includes(key)
    )?.[1] || '文件操作失败，请重试';

    Logger.error('[ErrorHandler] 云存储错误:', error);
    return this.handle(message, options);
  }

  /**
   * 显示 loading
   * @param {string} title - 提示文本
   */
  static showLoading(title = '加载中…') {
    wx.showLoading({
      title,
      mask: true
    });
  }

  /**
   * 隐藏 loading
   */
  static hideLoading() {
    wx.hideLoading();
  }

  /**
   * 显示普通提示（统一入口）
   * @param {string} message - 提示消息
   * @param {Object} options - 选项
   * @param {number} options.duration - 持续时间（默认 2000ms）
   * @param {boolean} options.log - 是否打印日志（默认 false）
   */
  static toast(message, options = {}) {
    const { duration = 2000, log = false } = options;

    if (log) {
      Logger.info('[Toast]', message);
    }

    wx.showToast({
      title: message,
      icon: 'none',
      duration
    });
  }

  /**
   * 显示成功提示
   * @param {string} message - 提示消息
   * @param {number} duration - 持续时间
   */
  static showSuccess(message, duration = 2000) {
    wx.showToast({
      title: message,
      icon: 'success',
      duration
    });
  }

  /**
   * 显示确认对话框
   * @param {string} title - 标题
   * @param {string} content - 内容
   * @returns {Promise<boolean>} 用户是否确认
   */
  static showConfirm(title, content) {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        success: (res) => {
          resolve(res.confirm);
        },
        fail: () => resolve(false)
      });
    });
  }

  /**
   * 性能监控 - 记录函数执行时间
   * @param {string} name - 函数名称
   * @param {Function} fn - 要监控的函数
   * @returns {Promise<any>} 函数执行结果
   */
  static async monitorPerformance(name, fn) {
    const startTime = Date.now();
    try {
      const result = await fn();
      const endTime = Date.now();
      const duration = endTime - startTime;

      Logger.info(`[Performance] ${name} 耗时: ${duration}ms`);

      // 性能告警
      if (duration > 1000) {
        Logger.warn(`[Performance] ${name} 执行时间过长: ${duration}ms`);
      }

      return result;
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;
      Logger.error(`[Performance] ${name} 失败，耗时: ${duration}ms`, error);
      throw error;
    }
  }

  // ==================== 新增增强功能 ====================

  /**
   * 初始化全局异常捕获（在App.js的onLaunch中调用）
   * @param {Object} appInstance - App实例
   */
  static initGlobalErrorCatch(_appInstance) {
    Logger.info('[ErrorHandler] 全局异常捕获将通过 App 生命周期方法生效');
  }

  static handleGlobalError(error) {
    if (_isHandlingError) {
      console.error('[GlobalError] 递归错误（已抑制）:', String(error).substring(0, 200));
      return;
    }

    _isHandlingError = true;
    try {
      const errorStr = typeof error === 'string' ? error : error?.message || String(error);

      if (errorStr.includes('__global') || errorStr.includes('__subPageFrame')) {
        return;
      }

      Logger.error('[GlobalError] 未捕获异常:', error);

      let userMessage = '程序出现异常';

      if (typeof error === 'string') {
        if (error.includes('timeout')) {
          userMessage = USER_FRIENDLY_MESSAGES.network.timeout;
        } else if (error.includes('network') || error.includes('request:fail')) {
          userMessage = USER_FRIENDLY_MESSAGES.network.unknown;
        }
      }

      wx.showToast({ title: userMessage, icon: 'none', duration: 3000 });
    } catch (e) {
      console.error('[GlobalError] 错误处理自身失败:', e);
    } finally {
      _isHandlingError = false;
    }
  }

  static handleUnhandledRejection(res) {
    Logger.error('[UnhandledRejection] Promise未处理:', res.reason);
  }

  /**
   * 获取用户友好的错误消息（智能匹配）
   * @param {Error|string|Object} error - 原始错误
   * @param {string} context - 错误场景（可选）
   * @returns {string} 用户友好的错误消息
   */
  static getFriendlyMessage(error, _context = '') {
    const errMsg = (error?.message || error || '').toLowerCase();

    // 按规则表顺序匹配，先命中先返回
    const hit = FRIENDLY_MESSAGE_RULES.find(rule =>
      rule.keywords.some(keyword => errMsg.includes(keyword))
    );
    if (hit) {
      return hit.message;
    }

    // 默认返回原始错误或通用提示
    return error?.message || error || '操作失败，请重试';
  }

  /**
   * 带场景的错误处理（推荐使用）
   * @param {Error|string} error - 错误对象
   * @param {string} scene - 场景标识（如'loadData', 'submitForm'等）
   * @param {Object} options - 额外选项
   * @returns {string} 用户友好的错误消息
   */
  static handleWithScene(error, scene, options = {}) {
    const friendlyMsg = this.getFriendlyMessage(error);
    
    // 场景前缀
    const scenePrefixes = {
      loadData: '加载失败',
      submitForm: '提交失败',
      uploadFile: '上传失败',
      deleteItem: '删除失败',
      login: '登录失败',
      payment: '支付失败',
      share: '分享失败'
    };

    const prefix = scenePrefixes[scene] || '';
    const finalMessage = prefix ? `${prefix}: ${friendlyMsg}` : friendlyMsg;

    // 日志记录
    Logger.error(`[ErrorHandler][${scene}]`, error);

    // 显示用户友好提示
    if (options.show !== false) {
      wx.showToast({
        title: finalMessage,
        icon: 'none',
        duration: options.duration || 2500
      });
    }

    return finalMessage;
  }

  /**
   * 重试机制包装器（带指数退避）
   * @param {Function} operation - 要执行的异步操作
   * @param {number} maxRetries - 最大重试次数（默认3次）
   * @param {Function} shouldRetry - 判断是否应该重试的回调
   * @returns {Promise<any>} 操作结果
   */
  static async withRetry(operation, maxRetries = 3, shouldRetry = null) {
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          Logger.info(`[Retry] 第${attempt}次重试，等待${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const result = await operation();
        
        if (attempt > 0) {
          Logger.info(`[Retry] 第${attempt}次重试成功`);
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        Logger.error(`[Retry] 第${attempt + 1}次尝试失败:`, error.message);

        if (shouldRetry && !shouldRetry(error, attempt)) {
          break;
        }

        const nonRetryableErrors = ['permission denied', 'invalid param', '参数错误'];
        const isNonRetryable = nonRetryableErrors.some(err => 
          error.message?.toLowerCase().includes(err)
        );
        
        if (isNonRetryable) {
          Logger.info('[Retry] 该错误不可重试:', error.message);
          throw error;
        }
      }
    }

    Logger.error(`[Retry] 已重试${maxRetries}次均失败`);
    throw lastError;
  }

  /**
   * 带超时的云函数调用包装器
   * 统一的超时保护，避免用户在弱网环境下无限制等待
   * @param {string} name - 云函数名称
   * @param {Object} data - 调用参数
   * @param {number} timeout - 超时时间（毫秒，默认 10000ms）
   * @returns {Promise<Object>} 云函数返回结果
   */
  static async callCloudFunction(name, data = {}, timeout = 10000) {
    // 浅拷贝，避免就地修改调用方持有的 data 对象（防止状态串扰）
    const payload = { ...data || {} };
    const adminAccount = wx.getStorageSync('_adminAccount') || '';
    if (adminAccount && !payload._adminAccount) {
      payload._adminAccount = adminAccount;
    }
    const res = await wx.cloud.callFunction({ name, data: payload, timeout });
    // 统一解包：兼容 result.xxx 与 result.data.xxx 两种读取方式
    if (res && res.result) {
      res.result = ErrorHandler.unwrapResult(res.result);
    }
    return res;
  }
}

// 导出常量供外部使用
ErrorHandler.ERROR_LEVELS = ERROR_LEVELS;
ErrorHandler.USER_FRIENDLY_MESSAGES = USER_FRIENDLY_MESSAGES;

module.exports = ErrorHandler;
