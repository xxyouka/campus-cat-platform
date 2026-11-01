// utils/dateFormat.js - 日期格式化工具（统一版本）

const { Logger } = require('./logger');

/**
 * 时间常量定义（提升可读性和可维护性）
 */
const TIME_CONSTANTS = {
  MINUTE: 60 * 1000,           // 1分钟（毫秒）
  HOUR: 60 * 60 * 1000,        // 1小时
  DAY: 24 * 60 * 60 * 1000,    // 1天
  WEEK: 7 * 24 * 60 * 60 * 1000 // 1周
};

/**
 * 格式化时间戳为相对时间描述（如"3分钟前"、"2小时前"）
 * 统一解决各模块重复实现问题
 *
 * @param {string|number|Date} timestamp - 时间戳、ISO字符串或Date对象
 * @returns {string} 友好的时间描述
 *
 * @example
 * timeAgo(Date.now() - 5000)       // => "刚刚"
 * timeAgo(Date.now() - 180000)     // => "3分钟前"
 * timeAgo(Date.now() - 7200000)    // => "2小时前"
 * timeAgo('2024-01-15T10:30:00')   // => 根据当前时间计算
 */
function timeAgo(timestamp) {
  if (!timestamp) return '';

  try {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    
    // 检查日期有效性
    if (isNaN(date.getTime())) return '';

    const diff = Date.now() - date.getTime();

    // 防止未来时间（时钟偏差等情况）
    if (diff < 0) return '刚刚';

    // 刚刚（<1分钟）
    if (diff < TIME_CONSTANTS.MINUTE) {
      return '刚刚';
    }

    // X分钟前（<1小时）
    if (diff < TIME_CONSTANTS.HOUR) {
      const minutes = Math.floor(diff / TIME_CONSTANTS.MINUTE);
      return `${minutes}分钟前`;
    }

    // X小时前（<24小时）
    if (diff < TIME_CONSTANTS.DAY) {
      const hours = Math.floor(diff / TIME_CONSTANTS.HOUR);
      return `${hours}小时前`;
    }

    // X天前（<7天）
    if (diff < TIME_CONSTANTS.WEEK) {
      const days = Math.floor(diff / TIME_CONSTANTS.DAY);
      return `${days}天前`;
    }

    // 超过7天，显示具体日期
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}月${day}日`;

  } catch (err) {
    Logger.warn('timeAgo', '格式化失败', { error: err.message });
    return '';
  }
}

/**
 * formatTimeAgo 的别名（兼容旧代码）
 * @deprecated 建议使用 timeAgo 替代
 */
function formatTimeAgo(timestamp) {
  return timeAgo(timestamp);
}

/**
 * 格式化日期为友好显示
 * @param {Date|string|number} date - 日期对象、ISO字符串或时间戳
 * @returns {string} 格式化后的日期字符串
 */
function formatDate(date) {
  if (!date) return '';
  
  // 统一转换为Date对象
  const d = date instanceof Date ? date : new Date(date);
  
  // 检查是否有效日期
  if (isNaN(d.getTime())) return '';
  
  const now = new Date();
  const diff = now - d;
  
  // 小于1分钟
  if (diff < 60000) {
    return '刚刚';
  }
  
  // 小于1小时
  if (diff < 3600000) {
    return Math.floor(diff / 60000) + '分钟前';
  }
  
  // 小于24小时
  if (diff < 86400000) {
    return Math.floor(diff / 3600000) + '小时前';
  }
  
  // 小于7天
  if (diff < 604800000) {
    return Math.floor(diff / 86400000) + '天前';
  }
  
  // 大于7天，显示具体日期
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  
  // 如果是今年，不显示年份
  if (year === now.getFullYear()) {
    return `${month}-${day}`;
  }
  
  return `${year}-${month}-${day}`;
}

/**
 * 格式化日期时间为完整格式
 * @param {Date|string|number} date 
 * @returns {string} "YYYY-MM-DD HH:mm"
 */
function formatDateTime(date) {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hour = d.getHours().toString().padStart(2, '0');
  const minute = d.getMinutes().toString().padStart(2, '0');
  
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * 统一存储用的日期格式（ISO字符串）
 * @param {Date} date 
 * @returns {string}
 */
function toStorageFormat(date = new Date()) {
  return date.toISOString();
}

/**
 * 格式化日期为简短格式（只显示年月日）
 * @param {Date|string|number} date 
 * @returns {string} "YYYY-MM-DD" 或 "MM-DD"
 */
function formatDateShort(date) {
  if (!date) return '';
  
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  
  const now = new Date();
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  
  // 如果是今年，不显示年份
  if (year === now.getFullYear()) {
    return `${month}-${day}`;
  }
  
  return `${year}-${month}-${day}`;
}

module.exports = {
  formatDate,
  formatDateTime,
  toStorageFormat,
  formatDateShort,
  timeAgo,
  formatTimeAgo,  // 兼容别名
  TIME_CONSTANTS   // 导出常量供其他模块使用
};
