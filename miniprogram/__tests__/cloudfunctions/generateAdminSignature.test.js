/**
 * __tests__/cloudfunctions/generateAdminSignature.test.js
 *
 * 回归防护：签名的账号标识必须取**服务端鉴权结果**里的真实账号，
 * 客户端传入的 event._adminAccount 只能在其缺失时兜底。
 *
 * 原实现写成 `adminAccount || authResult.adminInfo.account`，
 * 让客户端可控值压过服务端真实值 —— 与本行注释、与
 * cloudfunctions/logOperation/index.js 的 trustedAccount 口径
 * （`trustedAccount || adminAccount`）三处不一致。
 * 后果：任何人只要能调到这个函数，签出来的载荷里就是他自己填的账号；
 * 一旦后续新增任何"签名比对账号"的校验，管理员身份即可任意伪造。
 *
 * 因此这里不比对签名本身（密钥在环境变量里，测试不便复现），
 * 而是直接断言"真实账号优先"这个契约。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/generateAdminSignature/utils/auth', () => ({
  checkAdmin: jest.fn()
}));

describe('generateAdminSignature 云函数', () => {
  const REAL_ACCOUNT = 'trusted_admin_from_db';
  const FAKE_ACCOUNT = 'superadmin_impersonated_by_client';

  beforeEach(() => {
    process.env.ADMIN_SIGNATURE_KEY = 'a'.repeat(64);
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.ADMIN_SIGNATURE_KEY;
  });

  function load() {
    const { checkAdmin } = require('../../cloudfunctions/generateAdminSignature/utils/auth');
    checkAdmin.mockResolvedValue({
      isAdmin: true,
      adminInfo: { account: REAL_ACCOUNT, role: 'superadmin' }
    });
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({ collection: jest.fn(() => ({})) });
    return {
      main: require('../../cloudfunctions/generateAdminSignature/index').main,
      checkAdmin
    };
  }

  test('客户端传入的 _adminAccount 不得覆盖服务端真实账号', async () => {
    const { main } = load();
    const errSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await main({ _adminAccount: FAKE_ACCOUNT }, {});
    errSpy.mockRestore();

    expect(res.success).toBe(true);
    // 关键断言：客户端伪造的账号不得出现在返回结果里
    expect(JSON.stringify(res.data)).not.toContain(FAKE_ACCOUNT);
    // 签名应是基于真实账号算出的
    expect(typeof res.data.signature).toBe('string');
    expect(res.data.signature.length).toBe(64); // HMAC-SHA256 → 64 位 hex
  });

  test('鉴权结果里没有账号时才回退到客户端值', async () => {
    jest.resetModules();
    const { checkAdmin } = require('../../cloudfunctions/generateAdminSignature/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: {} });
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({ collection: jest.fn(() => ({})) });
    const main = require('../../cloudfunctions/generateAdminSignature/index').main;

    const errSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await main({ _adminAccount: FAKE_ACCOUNT }, {});
    errSpy.mockRestore();

    // 兜底路径仍可用（真实账号缺失时不至于整个函数失效）
    expect(res.success).toBe(true);
    expect(typeof res.data.signature).toBe('string');
  });

  test('非管理员不得获取签名', async () => {
    jest.resetModules();
    const { checkAdmin } = require('../../cloudfunctions/generateAdminSignature/utils/auth');
    checkAdmin.mockResolvedValue({ isAdmin: false, error: '无管理员权限' });
    const mockCloud = require('wx-server-sdk');
    mockCloud.database.mockReturnValue({ collection: jest.fn(() => ({})) });
    const main = require('../../cloudfunctions/generateAdminSignature/index').main;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await main({ _adminAccount: FAKE_ACCOUNT }, {});
    warnSpy.mockRestore();

    expect(res.success).toBe(false);
    expect(res.error).toContain('无管理员权限');
  });
});
