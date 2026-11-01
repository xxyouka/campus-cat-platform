// cloudfunctions/getConfig/index.js - 获取配置信息（敏感数据通过环境变量）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, _context) => {
  const { keys } = event;
  
  try {
    const result = {};
    
    // 从环境变量读取联系信息（在云开发控制台 → 云函数 → 函数配置中设置）
    if (!keys || keys.includes('contact')) {
      result.contact = {
        wechat: process.env.CONTACT_WECHAT || '',
        email: process.env.CONTACT_EMAIL || ''
      };
    }
    
    if (!keys || keys.includes('version')) {
      result.version = process.env.APP_VERSION || '3.11.3';
    }

    return ok(result, '获取成功');
  } catch (err) {
    console.error('[getConfig] 获取失败:', err);
    return fail('获取配置失败');
  }
};
