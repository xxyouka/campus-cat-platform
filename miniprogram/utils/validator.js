/**
 * utils/validator.js - 输入参数校验工具
 *
 * 提供统一的参数校验功能，防止非法输入导致的安全问题
 */

const ErrorHandler = require('./errorHandler');
const { Logger } = require('./logger');

// ========== 规则求值辅助（抽到模块级，避免 _evaluateRule 复杂度过高）==========

/**
 * 空值判断：undefined / null / 空字符串 视为空
 */
function isEmptyValue(value) {
  return value === undefined || value === null || value === '';
}

/**
 * 类型校验
 * @returns {string|null} 失败原因（未带自定义文案），通过返回 null
 */
function checkRuleType(value, rule) {
  // 未声明类型，或值本身为空（空值交给 required 处理）时跳过类型检查
  if (!rule.type || value === undefined || value === null) return null;

  if (rule.type === 'array') {
    return Array.isArray(value) ? null : '类型应为数组';
  }
  return typeof value === rule.type ? null : `类型应为${rule.type}`;
}

/**
 * 长度 / 数值范围校验
 * @returns {string|null} 失败原因（未带自定义文案），通过返回 null
 */
function checkRuleRange(value, rule) {
  const isString = typeof value === 'string';
  const isNumber = typeof value === 'number';

  if (rule.maxLength && isString && value.length > rule.maxLength) {
    return `长度不能超过${rule.maxLength}`;
  }
  if (rule.min !== undefined && isNumber && value < rule.min) {
    return `不能小于${rule.min}`;
  }
  if (rule.max !== undefined && isNumber && value > rule.max) {
    return `不能大于${rule.max}`;
  }
  return null;
}

/**
 * 延迟返回上一页（校验失败兜底）。
 *
 * 原实现是裸 `setTimeout(() => wx.navigateBack(), 1500)`，有两个问题：
 *   1. 用户在校验失败后 1.5s 内自己手动返回/跳转，定时器到点仍会再退一层（连退两页）；
 *   2. 调用页若自建了返回定时器（如 detail 的 _navBackTimer），两者叠加同样连退两页。
 * 现改为：同一时刻全局只保留一个待执行定时器；到点时确认当前页仍是发起校验的页面，
 * 用户已离开则不再补刀。环境拿不到页面栈时保持原行为（直接返回）。
 */
let pendingBackTimer = null;

function scheduleSafeBack(delay = 1500) {
  let route = '';
  try {
    if (typeof getCurrentPages === 'function') {
      const pages = getCurrentPages();
      route = pages && pages.length ? pages[pages.length - 1].route : '';
    }
  } catch (e) { /* ignore */ }

  if (pendingBackTimer) clearTimeout(pendingBackTimer);
  pendingBackTimer = setTimeout(() => {
    pendingBackTimer = null;

    let currentRoute = '';
    let known = false;
    try {
      if (typeof getCurrentPages === 'function') {
        const pages = getCurrentPages();
        if (pages && pages.length) {
          currentRoute = pages[pages.length - 1].route;
          known = true;
        }
      }
    } catch (e) { /* ignore */ }

    if (known && route && currentRoute !== route) return;
    wx.navigateBack();
  }, delay);
}

const Validator = {
  /**
   * 校验猫咪ID格式
   * @param {string} id - 猫咪ID
   * @param {Object} options - 选项
   * @param {boolean} options.autoBack - 校验失败是否自动返回（默认 true）
   * @returns {boolean} 是否通过校验
   */
  validateCatId(id, options = {}) {
    const { autoBack = true } = options;

    if (!id) {
      Logger.warn('Validator', 'catId 为空');
      if (autoBack) {
        ErrorHandler.toast('参数错误');
        scheduleSafeBack();
      }
      return false;
    }

    // 云开发文档ID通常是 24-32 位十六进制字符串
    if (typeof id !== 'string' || !/^[a-fA-F0-9]{20,40}$/.test(id)) {
      Logger.warn('Validator', 'catId 格式不合法', { id });
      if (autoBack) {
        ErrorHandler.toast('参数格式错误');
        scheduleSafeBack();
      }
      return false;
    }

    return true;
  },

  /**
   * 校验搜索关键词（防XSS）
   * @param {string} keyword - 搜索词
   * @returns {string} 清洗后的安全字符串
   */
  sanitizeKeyword(keyword) {
    if (!keyword || typeof keyword !== 'string') return '';

    // 移除HTML标签和脚本注入
    let sanitized = keyword
      .replace(/<[^>]*>/g, '')              // 移除所有HTML标签
      .replace(/javascript\s*:/gi, '')       // 移除javascript:协议
      .replace(/on\w+\s*=/gi, '')            // 移除事件处理器(onerror/onload等)
      .replace(/expression\s*\(/gi, '')      // 移除CSS expression
      .replace(/[<>"'&\\]/g, '');           // 移除特殊字符

    // 截断过长输入（防止DoS）
    if (sanitized.length > 50) {
      sanitized = sanitized.substring(0, 50);
    }

    // 去除首尾空格
    return sanitized.trim();
  },

  /**
   * 校验分页参数
   * @param {number} page - 页码
   * @param {number} pageSize - 每页大小
   * @returns {Object} 校验后的分页参数
   */
  validatePagination(page, pageSize) {
    const MAX_PAGE_SIZE = 100;
    const MIN_PAGE_SIZE = 1;

    return {
      page: Math.max(0, parseInt(page) || 0),
      pageSize: Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, parseInt(pageSize) || 20))
    };
  },

  /**
   * 校验文件类型（图片上传）
   * @param {string} filename - 文件名
   * @returns {boolean} 是否是允许的图片类型
   */
  isAllowedImageType(filename) {
    const allowedTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const ext = filename?.split('.').pop()?.toLowerCase();
    return allowedTypes.includes(ext);
  },

  /**
   * 校验文本长度
   * @param {string} text - 文本内容
   * @param {number} maxLength - 最大长度
   * @param {string} fieldName - 字段名称（用于错误提示）
   * @returns {boolean}
   */
  validateTextLength(text, maxLength, fieldName = '内容') {
    if (!text) return true;

    if (text.length > maxLength) {
      ErrorHandler.toast(`${fieldName}不能超过${maxLength}个字`);
      return false;
    }

    return true;
  },

  /**
   * 求值单条校验规则
   * @param {*} value - 待校验值
   * @param {Object} rule - 单条规则
   * @returns {string|null} 失败时返回错误文案，通过时返回 null
   */
  _evaluateRule(value, rule) {
    // 自定义 message 优先于兜底文案
    const withFallback = fallback => rule.message || fallback;

    // 必填检查
    if (rule.required && isEmptyValue(value)) {
      return withFallback('此项为必填项');
    }

    // 类型检查（数组类型特殊处理，使用 Array.isArray()）
    const typeError = checkRuleType(value, rule);
    if (typeError) return withFallback(typeError);

    // 长度/范围检查
    const rangeError = checkRuleRange(value, rule);
    if (rangeError) return withFallback(rangeError);

    // 正则检查
    if (rule.pattern && !rule.pattern.test(String(value))) {
      return withFallback('格式不正确');
    }

    return null;
  },

  /**
   * 通用参数校验（组合多个规则）
   * @param {*} value - 待校验值
   * @param {Array<Object>} rules - 校验规则数组
   * @returns {{valid: boolean, message: string}}
   */
  validate(value, rules) {
    for (const rule of rules) {
      const message = this._evaluateRule(value, rule);
      if (message !== null) {
        return { valid: false, message };
      }
    }

    return { valid: true, message: '' };
  }
};

module.exports = Validator;
