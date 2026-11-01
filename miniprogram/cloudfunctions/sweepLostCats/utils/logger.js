/**
 * 云函数日志工具
 * 提供统一的日志格式和级别
 */
class CloudLogger {
  
  /**
   * 信息日志
   * @param {string} functionName - 云函数名称
   * @param {string} message - 日志消息
   * @param {Object} data - 附加数据
   */
  static log(functionName, message, data = {}) {
    console.log(`[${functionName}] ${message}`, data);
  }

  /**
   * 警告日志
   * @param {string} functionName - 云函数名称
   * @param {string} message - 日志消息
   * @param {Object} data - 附加数据
   */
  static warn(functionName, message, data = {}) {
    console.warn(`[${functionName}] ${message}`, data);
  }

  /**
   * 错误日志
   * @param {string} functionName - 云函数名称
   * @param {string} message - 日志消息
   * @param {Error} error - 错误对象
   */
  static error(functionName, message, error) {
    const errInfo = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'Error', message: String(error ?? 'unknown') };
    console.error(`[${functionName}] ${message}`, errInfo);
  }

  /**
   * 性能日志
   * @param {string} functionName - 云函数名称
   * @param {string} operation - 操作名称
   * @param {number} duration - 耗时（毫秒）
   */
  static performance(functionName, operation, duration) {
    const level = duration > 1000 ? 'warn' : 'log';
    console[level](`[${functionName}] ${operation} 耗时: ${duration}ms`);
  }
}

/**
 * 云函数错误处理工具
 */
class CloudErrorHandler {
  
  /**
   * 标准化错误响应
   * @param {Error} error - 错误对象
   * @param {string} defaultMessage - 默认错误消息
   * @returns {Object} 标准化错误响应
   */
  static formatError(error, defaultMessage = '操作失败') {
    // 安全：内部错误细节（集合名/fileID 等）只进服务端日志，不回传客户端
    console.error('[formatError] 内部错误:', error.message || error);
    return {
      success: false,
      data: null,
      message: '',
      error: defaultMessage,
      code: error.code || 'UNKNOWN_ERROR'
    };
  }

  /**
   * 处理云函数执行错误
   * @param {string} functionName - 云函数名称
   * @param {Error} error - 错误对象
   * @returns {Object} 错误响应
   */
  static handle(functionName, error) {
    CloudLogger.error(functionName, '执行失败', error);
    return this.formatError(error, '服务器错误，请稍后重试');
  }
}

module.exports = {
  CloudLogger,
  CloudErrorHandler
};
