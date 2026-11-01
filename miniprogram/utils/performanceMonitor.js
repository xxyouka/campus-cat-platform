/**
 * utils/performanceMonitor.js - 性能监控工具
 *
 * 提供页面性能监控、网络请求耗时统计、内存使用监控等功能
 * 帮助团队持续优化小程序性能
 *
 * @module performanceMonitor
 */

const { Logger } = require('./logger');

/**
 * 性能监控配置
 */
const CONFIG = {
  // 性能阈值（毫秒）
  thresholds: {
    api: 1000,      // API 请求阈值
    render: 100,    // 渲染耗时阈值
    load: 1500      // 页面加载阈值
  },
  // 是否启用监控
  enabled: true,
  // 采样率（0-1）
  sampleRate: 1.0
};

/**
 * 性能数据存储
 */
const performanceData = {
  apiCalls: [],
  pageLoads: [],
  renderTimes: [],
  errors: []
};

// 每类数据最大保留条数，防止长时间运行内存持续增长
const MAX_DATA_LENGTH = 200;

/**
 * 限制数组长度，超出时删除最早的数据
 * @private
 */
function trimData (arr) {
  if (arr.length > MAX_DATA_LENGTH) {
    // 使用 slice 替代 splice 避免触发 V8 deopt
    const keep = arr.slice(arr.length - MAX_DATA_LENGTH);
    arr.length = 0;
    keep.forEach(item => arr.push(item));
  }
}

/**
 * 监控 API 请求性能
 *
 * @param {string} name - 请求名称
 * @param {Function} fn - 异步函数
 * @returns {Promise<any>} 函数执行结果
 * @example
 * const result = await monitorApi('getCatList', async () => {
 *   return await wx.cloud.callFunction({ name: 'getCats' })
 * })
 */
async function monitorApi (name, fn) {
  if (!CONFIG.enabled || Math.random() > CONFIG.sampleRate) {
    return fn();
  }

  const startTime = Date.now();

  try {
    const result = await fn();
    const duration = Date.now() - startTime;

    // 记录性能数据
    performanceData.apiCalls.push({
      name,
      duration,
      timestamp: Date.now(),
      success: true
    });
    trimData(performanceData.apiCalls);

    // 超过阈值时警告
    if (duration > CONFIG.thresholds.api) {
      Logger.warn('performance', `API ${name} 耗时过长`, { duration, threshold: CONFIG.thresholds.api });
    } else {
      Logger.log('performance', `API ${name} 完成`, { duration });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    performanceData.apiCalls.push({
      name,
      duration,
      timestamp: Date.now(),
      success: false,
      error: error.message
    });
    trimData(performanceData.apiCalls);

    Logger.error('performance', `API ${name} 失败`, error);
    throw error;
  }
}

/**
 * 监控页面加载性能
 *
 * @param {string} pageName - 页面名称
 * @param {Function} fn - 页面加载函数
 * @returns {Promise<any>} 函数执行结果
 * @example
 * // 在页面 onLoad 中使用
 * async onLoad() {
 *   await monitorPageLoad('index', async () => {
 *     await this.loadData()
 *   })
 * }
 */
async function monitorPageLoad (pageName, fn) {
  if (!CONFIG.enabled) {
    return fn();
  }

  const startTime = Date.now();

  try {
    const result = await fn();
    const duration = Date.now() - startTime;

    performanceData.pageLoads.push({
      page: pageName,
      duration,
      timestamp: Date.now(),
      success: true
    });
    trimData(performanceData.pageLoads);

    if (duration > CONFIG.thresholds.load) {
      Logger.warn('performance', `页面 ${pageName} 加载耗时过长`, { duration, threshold: CONFIG.thresholds.load });
    } else {
      Logger.log('performance', `页面 ${pageName} 加载完成`, { duration });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    performanceData.pageLoads.push({
      page: pageName,
      duration,
      timestamp: Date.now(),
      success: false,
      error: error.message
    });
    trimData(performanceData.pageLoads);

    Logger.error('performance', `页面 ${pageName} 加载失败`, error);
    throw error;
  }
}

/**
 * 监控函数执行时间
 *
 * @param {string} name - 操作名称
 * @param {Function} fn - 要监控的函数
 * @returns {any} 函数执行结果
 * @example
 * const result = monitorFunction('复杂计算', () => {
 *   return heavyComputation()
 * })
 */
function monitorFunction (name, fn) {
  if (!CONFIG.enabled) {
    return fn();
  }

  const startTime = Date.now();

  try {
    const result = fn();
    const duration = Date.now() - startTime;

    if (duration > CONFIG.thresholds.render) {
      Logger.warn('performance', `操作 ${name} 耗时过长`, { duration, threshold: CONFIG.thresholds.render });
    }

    return result;
  } catch (error) {
    Logger.error('performance', `操作 ${name} 失败`, error);
    throw error;
  }
}

/**
 * 获取性能报告
 *
 * @param {Object} options - 选项
 * @param {number} options.duration - 时间范围（毫秒），默认 5 分钟
 * @returns {Object} 性能报告
 */
function getPerformanceReport (options = {}) {
  const { duration = 5 * 60 * 1000 } = options;
  const now = Date.now();
  const cutoff = now - duration;

  // 过滤最近的数据
  const recentApiCalls = performanceData.apiCalls.filter(d => d.timestamp > cutoff);
  const recentPageLoads = performanceData.pageLoads.filter(d => d.timestamp > cutoff);

  // 计算统计数据
  const apiStats = calculateStats(recentApiCalls, 'duration');
  const pageStats = calculateStats(recentPageLoads, 'duration');

  // 找出慢请求
  const slowApis = recentApiCalls
    .filter(d => d.duration > CONFIG.thresholds.api)
    .slice(-10);

  // 找出慢页面
  const slowPages = recentPageLoads
    .filter(d => d.duration > CONFIG.thresholds.load)
    .slice(-10);

  return {
    summary: {
      apiCalls: recentApiCalls.length,
      pageLoads: recentPageLoads.length,
      apiSuccessRate: calculateSuccessRate(recentApiCalls),
      pageSuccessRate: calculateSuccessRate(recentPageLoads)
    },
    apiStats,
    pageStats,
    slowApis,
    slowPages,
    recommendations: generateRecommendations(apiStats, pageStats, slowApis, slowPages)
  };
}

/**
 * 获取性能面板用的聚合快照（按时间窗口过滤）
 *
 * 背景：管理端性能面板此前读的是一份独立的「影子监控模块」（全项目零写入，
 * 永远为空并回落成随机示例数据），而真实埋点全部写在本模块。这里提供面板所需的
 * 聚合视图（概览 / 按名称分组的页面与接口统计 / 失败明细）。
 *
 * @param {Object} options
 * @param {number} [options.duration] - 时间窗口（毫秒）；缺省统计全部保留数据
 * @returns {{overview: object, pageStats: Array, apiStats: Array, errors: Array}}
 */
function getPerformanceSnapshot (options = {}) {
  const cutoff = options.duration ? Date.now() - options.duration : 0;
  const within = (list) => list.filter(d => d.timestamp > cutoff);

  const apiCalls = within(performanceData.apiCalls);
  const pageLoads = within(performanceData.pageLoads);

  const aggregate = (list, nameField) => {
    const map = new Map();
    list.forEach(d => {
      const key = d[nameField] || '未知';
      const item = map.get(key) || { name: key, count: 0, totalDuration: 0, maxTime: 0, successCount: 0 };
      item.count++;
      item.totalDuration += d.duration || 0;
      item.maxTime = Math.max(item.maxTime, d.duration || 0);
      if (d.success) item.successCount++;
      map.set(key, item);
    });
    return [...map.values()].map(item => ({
      name: item.name,
      count: item.count,
      avgTime: Math.round(item.totalDuration / item.count),
      maxTime: item.maxTime,
      successRate: Number((item.successCount / item.count * 100).toFixed(1))
    }));
  };

  const errorMap = new Map();
  const collectErrors = (list, locationField) => {
    list.filter(d => d.success === false).forEach(d => {
      const message = d.error || '未知错误';
      const key = message + '|' + (d[locationField] || '');
      const item = errorMap.get(key) || { message, location: d[locationField] || '', count: 0 };
      item.count++;
      errorMap.set(key, item);
    });
  };
  collectErrors(apiCalls, 'name');
  collectErrors(pageLoads, 'page');

  const totalCalls = apiCalls.length + pageLoads.length;
  const failedCalls = apiCalls.filter(d => !d.success).length + pageLoads.filter(d => !d.success).length;
  const avgLoadTime = pageLoads.length
    ? Math.round(pageLoads.reduce((sum, d) => sum + (d.duration || 0), 0) / pageLoads.length)
    : 0;

  return {
    overview: {
      totalPageViews: pageLoads.length,
      totalApiCalls: apiCalls.length,
      avgLoadTime,
      errorRate: totalCalls > 0 ? Number((failedCalls / totalCalls * 100).toFixed(1)) : 0
    },
    pageStats: aggregate(pageLoads, 'page'),
    apiStats: aggregate(apiCalls, 'name'),
    errors: [...errorMap.values()]
  };
}

/**
 * 计算统计数据
 * @private
 */
function calculateStats (data, field) {
  if (data.length === 0) {
    return { count: 0, avg: 0, min: 0, max: 0, p95: 0 };
  }

  const values = data.map(d => d[field]).sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const min = values[0];
  const max = values[values.length - 1];
  const p95 = values[Math.floor(values.length * 0.95)];

  return { count: values.length, avg, min, max, p95 };
}

/**
 * 计算成功率
 * @private
 */
function calculateSuccessRate (data) {
  if (data.length === 0) return 0;
  const successCount = data.filter(d => d.success).length;
  return (successCount / data.length * 100).toFixed(2);
}

/**
 * 生成优化建议
 * @private
 */
function generateRecommendations (apiStats, pageStats, slowApis, slowPages) {
  const recommendations = [];

  if (apiStats.avg > CONFIG.thresholds.api) {
    recommendations.push('API 平均响应时间较长，建议优化后端接口或添加缓存');
  }

  if (pageStats.avg > CONFIG.thresholds.load) {
    recommendations.push('页面平均加载时间较长，建议优化首屏渲染或延迟加载非关键资源');
  }

  if (slowApis.length > 5) {
    recommendations.push(`发现 ${slowApis.length} 个慢请求，建议检查这些接口的性能`);
  }

  if (slowPages.length > 3) {
    recommendations.push(`发现 ${slowPages.length} 个慢加载页面，建议优化页面初始化逻辑`);
  }

  return recommendations;
}

/**
 * 清空性能数据
 */
function clearPerformanceData () {
  performanceData.apiCalls = [];
  performanceData.pageLoads = [];
  performanceData.renderTimes = [];
  performanceData.errors = [];
}

/**
 * 配置性能监控
 *
 * @param {Object} options - 配置选项
 * @param {boolean} options.enabled - 是否启用
 * @param {number} options.sampleRate - 采样率
 * @param {Object} options.thresholds - 阈值配置
 */
function configure (options) {
  Object.assign(CONFIG, options);
}

/**
 * 在控制台打印性能报告
 */
function printPerformanceReport () {
  const report = getPerformanceReport();
  Logger.info('performance', '性能报告', report);
}

module.exports = {
  monitorApi,
  monitorPageLoad,
  monitorFunction,
  getPerformanceReport,
  getPerformanceSnapshot,
  clearPerformanceData,
  configure,
  printPerformanceReport
};
