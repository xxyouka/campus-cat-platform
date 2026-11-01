// cloudfunctions/getOpenId/index.js
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (_event, _context) => {
  try {
    const context = cloud.getWXContext() || {};
    if (typeof context.OPENID !== 'string' || !context.OPENID) {
      return fail('无法获取用户身份');
    }
    return ok({ openid: context.OPENID });
  } catch (err) {
    console.error('[getOpenId] 获取调用者身份失败:', err);
    return fail('获取用户身份失败，请稍后重试');
  }
};
