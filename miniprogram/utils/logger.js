/**
 * utils/logger.js - 统一日志工具
 * 提供格式化的日志记录，支持不同日志级别
 *
 * 安全特性（v2.0升级）：
 * - 生产环境自动脱敏敏感信息（openid、token、cloud路径等）
 * - 错误消息多层正则过滤，防止PII泄露
 * - 支持自定义脱敏规则扩展
 *
 * 日志级别说明：
 * - debug: 仅开发环境输出，用于详细调试信息
 * - log/info: 仅开发环境输出，用于一般信息
 * - warn: 所有环境输出，生产环境可上报至云端监控
 * - error: 所有环境输出，生产环境必须上报至错误追踪系统
 */

const { env: NODE_ENV = 'development' } = require('../config');

// 是否为生产环境
const IS_PRODUCTION = NODE_ENV === 'production';

/**
 * 敏感信息脱敏规则配置
 * 每个规则包含：pattern（正则表达式）、replacement（替换文本）、description（描述）
 */
const SENSITIVITY_RULES = [
  // 微信用户OpenID（o开头+27位字母数字，共28位；前缀因 AppID 而异，不固定为 oZ）
  {
    pattern: /o[A-Za-z0-9_-]{27}/g,
    replacement: '[OPEN_ID_REDACTED]',
    description: '微信OpenID'
  },

  // 云开发文件路径（cloud://xxx）
  {
    pattern: /cloud:\/\/[^\s]*/gi,
    replacement: '[CLOUD_PATH]',
    description: '云存储路径'
  },

  // 密码和认证token（常见字段名模式）
  {
    pattern: /(password|passwd|pwd|token|secret|authorization|apikey|api_key)\s*[:=]\s*[^\s]*/gi,
    replacement: '$1: [REDACTED]',
    description: '密码/Token'
  },

  // 手机号（中国大陆11位）
  {
    pattern: /\b1[3-9]\d{9}\b/g,
    replacement: '[PHONE_REDACTED]',
    description: '手机号码'
  },

  // 邮箱地址
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
    description: '电子邮箱'
  },

  // 身份证号（18位，含X）
  {
    pattern: /\d{17}[\dXx]/g,
    replacement: '[ID_CARD_REDACTED]',
    description: '身份证号'
  },

  // IP地址（IPv4）
  {
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    replacement: '[IP_ADDRESS]',
    description: 'IP地址'
  },

  // URL中的查询参数值（保留键名，隐藏值）
  {
    pattern: /(\?|&)([^=]+)=([^&\s]+)/g,
    replacement: '$1$2=[PARAM_VALUE]',
    description: 'URL查询参数'
  }
];

class Logger {
  constructor() {
    // 新增：运行时环境检测（兼容微信小程序）
    this._isDebug = this._detectEnvironment();
    this._logSamplingRate = 1.0;  // 日志采样率（1.0=100%）
  }

  /**
   * 检测当前运行环境
   * @private
   * @returns {boolean} 是否为开发/体验版
   */
  _detectEnvironment() {
    try {
      // 方式1：通过config文件
      if (typeof NODE_ENV !== 'undefined' && NODE_ENV === 'development') {
        return true;
      }
      
      // 方式2：通过小程序系统信息（推荐）
      if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
        const accountInfo = wx.getAccountInfoSync();
        // develop=开发版, trial=体验版, release=正式版
        return ['develop', 'trial'].includes(accountInfo?.miniProgram?.envVersion);
      }
      
      // 默认：认为是生产环境（安全优先）
      return false;
    } catch (e) {
      console.warn('[Logger] 环境检测失败，默认使用生产模式');
      return false;
    }
  }

  /**
   * 获取当前是否为调试模式
   */
  get isDebug() {
    return this._isDebug;
  }

  /**
   * 设置日志采样率（0.0-1.0）
   * 用于生产环境降低日志量
   * @param {number} rate - 采样率
   */
  setSamplingRate(rate) {
    this._logSamplingRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * 脱敏处理 - 过滤字符串中的敏感信息
   * @param {string} str - 待处理的字符串
   * @returns {string} 脱敏后的安全字符串
   * @private
   */
  static _sanitizeString(str) {
    if (!str || typeof str !== 'string') return str;

    let sanitized = str;

    // 应用所有脱敏规则
    SENSITIVITY_RULES.forEach(rule => {
      try {
        const beforeLength = sanitized.length;
        sanitized = sanitized.replace(rule.pattern, rule.replacement);

        // 记录脱敏操作（仅开发环境）
        if (!IS_PRODUCTION && sanitized.length !== beforeLength) {
          console.log(
            `[Logger] 脱敏: ${rule.description}`,
            `移除 ${beforeLength - sanitized.length} 字符`
          );
        }
      } catch (e) {
        console.error(`[Logger] 脱敏规则执行失败 (${rule.description}):`, e);
      }
    });

    return sanitized;
  }

  /**
   * 脱敏处理 - 递归处理对象中的所有字符串值
   * @param {*} data - 待处理的数据（对象、数组、字符串等）
   * @returns {*} 脱敏后的数据副本
   * @private
   */
  static _sanitizeData(data) {
    if (data === null || data === undefined) return data;

    // 字符串类型：直接脱敏
    if (typeof data === 'string') {
      return this._sanitizeString(data);
    }

    // 数组类型：递归处理每个元素
    if (Array.isArray(data)) {
      return data.map(item => this._sanitizeData(item));
    }

    // 对象类型：递归处理每个属性值
    if (typeof data === 'object') {
      const sanitized = {};
      Object.keys(data).forEach(key => {
        // 跳过函数类型的值
        if (typeof data[key] === 'function') return;

        // 特殊处理：error对象的stack属性（包含路径信息）
        if (key === 'stack' && typeof data[key] === 'string') {
          sanitized[key] = this._sanitizeString(data[key]);
        } else {
          sanitized[key] = this._sanitizeData(data[key]);
        }
      });
      return sanitized;
    }

    // 其他类型（数字、布尔等）：原样返回
    return data;
  }

  /**
   * 信息日志（仅开发环境）
   * @param {string} module - 模块名称
   * @param {string} message - 日志消息
   * @param {Object} data - 附加数据
   */
  static log(module, message, data = {}) {
    const instance = Logger._instance || (Logger._instance = new Logger());
    if (!instance._isDebug) return;
    // 修复（v4.2）：移除死代码条件，采样率在开发环境下也可用
    if (Math.random() > instance._logSamplingRate) return;
    console.log(`[${module}] ${message}`, Logger._formatData(data));
  }

  /**
   * 信息日志（log 的别名）
   * @param {string} module - 模块名称
   * @param {string} message - 日志消息
   * @param {Object} data - 附加数据
   */
  static info(module, message, data = {}) {
    return this.log(module, message, data);
  }

  /**
   * 警告日志（所有环境输出）
   * 生产环境：输出到控制台 + 可选上报至云端
   * @param {string} module - 模块名称
   * @param {string} message - 日志消息
   * @param {Object} data - 附加数据
   */
  static warn(module, message, data = {}) {
    const formattedData = this._formatData(data);

    if (IS_PRODUCTION) {
      // 生产环境：简化日志输出，避免泄露内部实现细节
      console.warn(`[${module}] ${message}`);
      // 可选：上报至微信实时日志（需在mp.weixin.qq.com开启）
      this._reportToCloud('warn', module, message, formattedData);
    } else {
      console.warn(`[${module}] ${message}`, formattedData);
    }
  }

  /**
   * 错误日志（所有环境必须输出）
   * 生产环境：脱敏处理后输出 + 上报至错误追踪系统
   * @param {string} module - 模块名称
   * @param {string} message - 日志消息
   * @param {Error} error - 错误对象
   */
  static error(module, message, error) {
    // 防御非 Error 参数（string / plain object / null / undefined）
    const errInfo = error instanceof Error
      ? { name: error.name, message: error.message }
      : error !== null && error !== undefined && typeof error === 'object'
        ? { name: 'Error', message: error.message || JSON.stringify(error) }
        : { name: 'Error', message: String(error) };

    if (IS_PRODUCTION) {
      // 生产环境：脱敏处理后再输出和上报
      const sanitizedMessage = this._sanitizeString(message);
      const sanitizedErrInfo = this._sanitizeData(errInfo);

      console.error(`[${module}] ${sanitizedMessage}`, sanitizedErrInfo.message);

      // 上报脱敏后的数据至错误追踪系统
      this._reportToCloud('error', module, sanitizedMessage, sanitizedErrInfo);
    } else {
      // 开发环境：完整输出包括堆栈信息（便于调试）
      const fullErrInfo = error instanceof Error
        ? { ...errInfo, stack: error.stack }
        : errInfo;
      console.error(`[${module}] ${message}`, fullErrInfo);
    }
  }

  /**
   * 性能日志
   * 开发环境：始终输出
   * 生产环境：仅当耗时超过阈值时输出警告
   * @param {string} module - 模块名称
   * @param {string} operation - 操作名称
   * @param {number} duration - 耗时（毫秒）
   */
  static performance(module, operation, duration) {
    const SLOW_THRESHOLD = 1000; // 性能阈值：1秒

    if (duration > SLOW_THRESHOLD) {
      // 慢操作：所有环境都记录
      const message = `${operation} 耗时: ${duration}ms (执行时间过长)`;
      console.warn(`[${module}] ${message}`);

      if (IS_PRODUCTION) {
        this._reportToCloud('performance', module, message, { duration });
      }
    } else if (!IS_PRODUCTION) {
      // 正常耗时：仅开发环境输出
      console.log(`[${module}] ${operation} 耗时: ${duration}ms`);
    }
  }

  /**
   * 调试日志（仅在开发环境）
   * @param {string} module - 模块名称
   * @param {string} message - 日志消息
   * @param {*} data - 附加数据
   */
  static debug(module, message, data) {
    if (IS_PRODUCTION) return;
    console.log(`[${module}][DEBUG] ${message}`, data);
  }

  /**
   * 静默错误处理 - 用于"故意忽略错误"的场景
   * 开发环境记录 debug 日志便于排查，生产环境不输出
   * 用于替换 `.catch(() => {})` 这类完全静默的吞异常模式
   * @param {string} module - 模块名称
   * @param {string} action - 操作名称（说明在做什么时失败）
   * @param {*} error - 错误对象
   */
  static swallow(module, action, error) {
    if (IS_PRODUCTION) return;
    const msg = error instanceof Error ? error.message
      : error !== null && error !== undefined && typeof error === 'object'
        ? error.message || JSON.stringify(error)
        : String(error);
    console.log(`[${module}][SWALLOW] ${action} 静默失败:`, msg);
  }

  /**
   * 格式化数据对象
   * 生产环境下自动脱敏敏感信息
   * @private
   */
  static _formatData(data) {
    if (!data || Object.keys(data).length === 0) return '';

    // 生产环境：返回脱敏后的数据
    if (IS_PRODUCTION) {
      return this._sanitizeData(data);
    }

    // 开发环境：原样返回
    return data;
  }

  /**
   * 上报日志至微信实时日志系统
   * @private
   * @param {string} level - 日志级别
   * @param {string} module - 模块名
   * @param {string} message - 消息
   * @param {Object} data - 附加数据
   */
  static _reportToCloud(level, module, message, data) {
    try {
      if (typeof wx === 'undefined' || !wx.getRealtimeLogManager) return;
      const logger = wx.getRealtimeLogManager();
      const logStr = `[${level}][${module}] ${message}${data ? ' ' + JSON.stringify(data).substring(0, 500) : ''}`;
      const fn = logger[level] || logger.warn;
      if (typeof fn === 'function') {
        try {
          fn.call(logger, logStr);
        } catch (innerErr) {
          // ignored
        }
      }
    } catch (e) {
      // ignored
    }
  }
}

/**
 * 日志装饰器 - 自动记录函数执行时间
 * @param {string} moduleName - 模块名称
 * @param {string} operation - 操作名称
 */
function logPerformance(moduleName, operation) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args) {
      const startTime = Date.now();
      
      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        Logger.performance(moduleName, operation, duration);
        return result;
      } catch (error) {
        const _duration = Date.now() - startTime;
        Logger.error(moduleName, `${operation} 失败`, error);
        throw error;
      }
    };

    return descriptor;
  };
}

module.exports = {
  Logger,
  logPerformance,
  // 导出脱敏工具（供其他模块使用）
  sanitize: (str) => Logger._sanitizeString(str),
  sanitizeData: (data) => Logger._sanitizeData(data)
};
