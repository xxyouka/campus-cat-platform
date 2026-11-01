// cloudfunctions/utils/cloud.js
// 云函数公共工具模块

const cloud = require('wx-server-sdk');

// 初始化云开发（只初始化一次）
if (!cloud.isInit) {
  cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV
  });
  cloud.isInit = true;
}

const db = cloud.database();

/**
 * 通用错误处理
 * @param {Error} err - 错误对象
 * @param {string} operation - 操作名称
 */
function handleError(err, operation = '操作') {
  console.error(`${operation}失败:`, err);
  return {
    success: false,
    message: `${operation}失败: ${err.message || '请重试'}`
  };
}

/**
 * 通用成功响应
 * @param {string} message - 成功消息
 * @param {Object} data - 返回数据
 */
function successResponse(message = '操作成功', data = {}) {
  return {
    success: true,
    message,
    ...data
  };
}

module.exports = {
  cloud,
  db,
  handleError,
  successResponse
};

// 2026-10-11 移除 checkAdminPermission(openid)（BE-10）：
//   零调用方（全仓 54 份副本中只有定义与导出），且它只判 `admins` 文档存在性、
//   **不判 role** —— 比 utils/auth.js 的 checkAdmin 弱得多。留着等于给后来人一个
//   「现成的鉴权入口」样板，一旦被接上，管理端就退化成「admins 里存在即可操作」。
//   权限判定只有一条路径：utils/auth.js 的 checkAdmin（基于服务端 OPENID）。
//   如需按 openid 查管理员档案，用 auth.js 的 checkAdmin 返回的 adminInfo。
