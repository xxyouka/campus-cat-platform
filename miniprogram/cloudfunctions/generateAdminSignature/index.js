// cloudfunctions/generateAdminSignature/index.js
// 服务端管理员签名生成器
//
// 安全增强说明：
// 1. 签名在服务端生成，使用crypto模块的真HMAC-SHA256
// 2. 密钥仅存在于云函数环境变量中，客户端无法获取
// 3. 每次登录时动态生成新签名，包含随机盐值
// 4. 签名有效期1小时，过期需重新获取
//
// 使用场景：
// - adminLogin 登录成功后调用此函数获取签名
// - checkAdminStatus 验证通过时可选择刷新签名

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 从环境变量读取签名密钥
// 必须在云开发控制台配置 ADMIN_SIGNATURE_KEY 环境变量
// 建议使用64位随机十六进制字符串
const SIGNATURE_KEY = (process.env.ADMIN_SIGNATURE_KEY || '').trim();

if (!SIGNATURE_KEY) {
  console.error(
    '[generateAdminSignature] 未配置 ADMIN_SIGNATURE_KEY 环境变量！\n' +
    '请在云开发控制台 → 云函数 → generateAdminSignature → 函数配置 → 环境变量 中设置\n' +
    '建议格式：64位随机十六进制字符串'
  );
}

// 签名有效期：1小时（毫秒）
const SIGNATURE_EXPIRY_MS = 1 * 60 * 60 * 1000;

/**
 * 生成HMAC-SHA256签名
 * @param {string} data - 待签名的数据
 * @returns {string} 十六进制签名字符串
 */
function generateHMAC(data) {
  return crypto
    .createHmac('sha256', SIGNATURE_KEY)
    .update(data)
    .digest('hex');
}

exports.main = async function(event, _context) {
  if (!SIGNATURE_KEY) {
    console.error('[generateAdminSignature] 缺少必需的环境变量 ADMIN_SIGNATURE_KEY');
    return fail('服务器配置错误（缺少签名密钥）');
  }

  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const adminAccount = event._adminAccount || '';

  try {
    const db = cloud.database();
    // 鉴权基于服务端真实 OPENID，adminAccount 仅用于签名数据/日志，不作为身份凭据
    const authResult = await checkAdmin(db, '');
    if (!authResult.isAdmin) {
      console.warn('[generateAdminSignature] 非管理员尝试获取签名');
      return fail('无管理员权限');
    }

    // 真实账号必须优先。原实现写作
    //    `adminAccount || authResult.adminInfo.account`
    // 让**客户端可控**的 event._adminAccount 压过服务端鉴权结果 ——
    // 与本行注释、与 logOperation/index.js 的 trustedAccount 口径（`trustedAccount || adminAccount`）
    // 三处不一致。任何未来新增的签名比对都会因此可被任意伪造管理员账号。
    // 管理员账号身份只能来自服务端鉴权结果，客户端值仅在其缺失时兜底。
    const trustedAccount = authResult.adminInfo && authResult.adminInfo.account;
    const accountForSign = trustedAccount || adminAccount || '';

    const timestamp = Date.now();
    const salt = crypto.randomBytes(16).toString('hex');

    const signData = [
      'admin_auth',
      accountForSign,
      timestamp.toString(),
      salt,
      'v2026_secure'
    ].join(':');

    const signature = generateHMAC(signData);

    console.log(
      '[generateAdminSignature] 签名已生成',
      // 同样打真实账号，不打客户端传入值（审计日志不可被冒用）
      'account:',
      accountForSign,
      'timestamp:',
      new Date(timestamp).toISOString()
    );

    return ok({
      signature: signature,        // HMAC-SHA256签名
      timestamp: timestamp,       // 签名时间戳
      salt: salt,                 // 随机盐值（用于验证）
      expiresIn: SIGNATURE_EXPIRY_MS, // 有效期（毫秒）
      algorithm: 'HMAC-SHA256',   // 算法标识
      version: '2.0'              // 版本号
    });
  } catch (err) {
    console.error('[generateAdminSignature] 生成签名失败:', err);
    return fail('签名生成失败，请稍后重试');
  }
};
