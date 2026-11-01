// cloudfunctions/utils/sanitizer.js - 统一输入清洗与XSS防护
/**
 * 提供标准化的输入验证和XSS防护
 * 所有云函数应优先使用此模块处理用户输入
 *
 * 安全等级：
 * - Level 1: 基础HTML实体转义（适用于大多数场景）
 * - Level 2: 增强版过滤（移除危险字符和协议）
 * - Level 3: 严格模式（仅保留字母数字和基本标点）
 */

class Sanitizer {
  constructor() {
    this.config = {
      maxLength: {
        default: 500,
        short: 50,    // 昵称、名称等
        medium: 200,  // 描述、位置等
        long: 1000    // 备注、笔记等
      },
      allowedTags: [], // 默认不允许任何HTML标签
      allowedAttributes: {} // 默认不允许任何属性
    };
  }

  /**
   * 基础清洗 - HTML实体转义（推荐用于大多数场景）
   * @param {string} str - 待清洗字符串
   * @param {object} options - 配置选项
   * @returns {string} 安全字符串
   */
  escape(str, options = {}) {
    if (typeof str !== 'string') return str;

    const {
      maxLength = this.config.maxLength.default,
      trimSpaces = true
    } = options;

    let result = str;

    // 长度限制（防止DoS）
    if (result.length > maxLength) {
      console.warn(`[Sanitizer] 字符串超长，已截断: ${result.length} → ${maxLength}`);
      result = result.substring(0, maxLength);
    }

    // 去除首尾空格
    if (trimSpaces) {
      result = result.trim();
    }

    // HTML实体转义（核心防护）
    return result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  /**
   * 增强版清洗 - 移除潜在危险内容
   * @param {string} str - 待清洗字符串
   * @param {object} options - 配置选项
   * @returns {string} 安全字符串
   */
  sanitize(str, options = {}) {
    if (typeof str !== 'string') return str;

    const {
      maxLength = this.config.maxLength.default,
      fieldName = 'unknown',
      allowNewlines = true
    } = options;

    let result = str;

    // 长度检查
    if (result.length > maxLength) {
      console.warn(`[Sanitizer] [${fieldName}] 超长截断: ${result.length} → ${maxLength}`);
      result = result.substring(0, maxLength);
    }

    // 第一层：移除所有HTML标签
    result = result.replace(/<[^>]*>/gi, '');

    // 第二层：移除HTML实体编码（防止嵌套绕过）
    result = result
      .replace(/&[a-zA-Z]+;/g, '')
      .replace(/&#\d+;/g, '')
      .replace(/&#x[0-9a-fA-F]+;/g, '');

    // 第三层：移除JavaScript事件处理器
    result = result.replace(/\bon\w+\s*=\s*["']?[^"']*["'?]?/gi, '');

    // 第四层：移除javascript:协议
    result = result.replace(/javascript\s*:/gi, '');

    // 第五层：移除data: URI
    result = result.replace(/data\s*:\s*text\/html/gi, '');

    // 第六层：移除控制字符
    if (!allowNewlines) {
      // eslint-disable-next-line no-control-regex
      result = result.replace(/[\x00-\x1F\x7F]/g, '');
    } else {
      // eslint-disable-next-line no-control-regex
      result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    // 第七层：移除零宽字符（防隐藏攻击）
    result = result.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');

    result = result.replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );

    result = result.replace(/[\uFE30-\uFE4F]/g, (ch) => {
      const map = { '\u3001': '、', '\u3002': '。', '\uFF08': '(', '\uFF09': ')' };
      return map[ch] || '';
    });

    result = result.replace(/expression\s*\(/gi, '');
    result = result.replace(/url\s*\(\s*['"]?\s*javascript:/gi, '');
    result = result.replace(/@import/gi, '');
    result = result.replace(/behavior\s*:\s*url/gi, '');

    const filterRatio = result.length / str.length;
    if (filterRatio < 0.5) {
      console.warn(`[Sanitizer] [${fieldName}] 内容被大量过滤: 原始${str.length}字符 → 清洗后${result.length}字符`);
      if (filterRatio < 0.3) {
        console.error(`[Sanitizer] [${fieldName}] 过滤率过高，拒绝保存`);
        return '';
      }
    }

    const trimmed = result.trim();
    return trimmed;
  }

  /**
   * 严格模式 - 仅保留最基本的安全字符
   * 适用于ID、用户名等关键标识符
   * @param {string} str - 待清洗字符串
   * @param {number} maxLength - 最大长度
   * @returns {string} 安全字符串
   */
  strict(str, maxLength = 50) {
    if (typeof str !== 'string') return '';

    const result = str
      .substring(0, maxLength)
      .trim()
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[^a-zA-Z0-9_\- \u4e00-\u9fa5\u3040-\u309F\u30A0-\u30FF\u00C0-\u024F\u0400-\u04FF·.()（）\]【】!！?？,，、:：;；…~\-—\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{270F}\u{2705}\u{2764}\u{1F43E}]/gu, '');

    return result;
  }

  /**
   * 清洗对象中的所有字符串字段
   * @param {object} obj - 待清洗对象
   * @param {object} fieldRules - 字段规则映射
   * @returns {object} 清洗后的对象
   */
  sanitizeObject(obj, fieldRules = {}) {
    if (!obj || typeof obj !== 'object') return obj;

    const sanitized = {};

    for (const [key, value] of Object.entries(obj)) {
      const rules = fieldRules[key] || {};

      if (typeof value === 'string') {
        sanitized[key] = this.sanitize(value, {
          ...rules,
          fieldName: key
        });
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(item =>
          typeof item === 'string' ? this.sanitize(item, { ...rules, fieldName: key }) : item
        );
      } else if (value && typeof value === 'object') {
        sanitized[key] = this.sanitizeObject(value, rules.nested || {});
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 验证并清洗URL
   * @param {string} url - URL字符串
   * @returns {object} { isValid: boolean, url: string, error?: string }
   */
  validateUrl(url) {
    if (!url || typeof url !== 'string') {
      return { isValid: false, url: '', error: 'URL不能为空' };
    }

    const trimmedUrl = url.trim();

    // 允许的协议白名单
    const allowedProtocols = ['https:', 'cloud:'];
    let protocol;

    try {
      const urlObj = new URL(trimmedUrl);
      protocol = urlObj.protocol.toLowerCase();
    } catch (e) {
      // 可能是相对路径或cloud://协议
      if (trimmedUrl.startsWith('cloud://')) {
        protocol = 'cloud:';
      } else {
        return { isValid: false, url: '', error: '无效的URL格式' };
      }
    }

    if (!allowedProtocols.includes(protocol)) {
      return { isValid: false, url: '', error: '不允许的URL协议' };
    }

    // 检查是否包含危险关键字
    const dangerousPatterns = [
      /javascript\s*:/i,
      /data\s*:\s*text\/html/i,
      /vbscript\s*:/i
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedUrl)) {
        return { isValid: false, url: '', error: '检测到危险的URL内容' };
      }
    }

    return { isValid: true, url: trimmedUrl };
  }

  /**
   * Emoji安全清洗 - 保留Emoji的同时清理危险内容
   * 适用于备注、打卡状态等允许Emoji的文本字段
   * @param {string} str - 待清洗字符串
   * @param {number} maxLen - 最大长度
   * @returns {string} 安全字符串
   */
  sanitizeWithEmoji(str, maxLen = 200) {
    if (typeof str !== 'string') return '';
    let result = str.substring(0, maxLen || 200).trim();
    // 移除HTML标签
    result = result.replace(/<[^>]*>/gi, '');
    // 移除javascript:协议和事件处理器
    result = result.replace(/javascript\s*:/gi, '');
    result = result.replace(/on\w+\s*=/gi, '');
    // 移除危险控制字符（保留换行）
    // eslint-disable-next-line no-control-regex
    result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // 移除零宽字符
    result = result.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    return result.trim();
  }

  /**
   * 验证ObjectId格式（云开发文档ID）
   * @param {string} id - ID字符串
   * @returns {boolean}
   */
  isValidObjectId(id) {
    return typeof id === 'string' && /^[a-fA-F0-9]{20,40}$/.test(id);
  }
}

module.exports = new Sanitizer();
