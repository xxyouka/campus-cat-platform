/**
 * cloudfunctions/utils/response.js - 云函数统一响应格式
 *
 * 所有云函数应使用此工具返回标准化响应，
 * 确保客户端可以统一处理成功和错误情况。
 *
 * 标准格式:
 *   { success: boolean, data?: any, message?: string, error?: string, code?: string }
 *
 * 使用方法:
 *   const { ok, fail } = require('./utils/response')
 *
 *   // 成功响应
 *   return ok(data, '操作成功')
 *   return ok({ cats, total: 10 }, '查询完成')
 *
 *   // 失败响应
 *   return fail('参数错误', 'INVALID_PARAM')
 *   return fail('权限不足', 'FORBIDDEN')
 */

function ok(data, message) {
  return {
    success: true,
    data: data !== undefined ? data : null,
    message: message || ''
  };
}

function fail(error, code) {
  return {
    success: false,
    data: null,
    message: '',
    error: error || '未知错误',
    code: code || 'ERROR'
  };
}

module.exports = { ok, fail };
