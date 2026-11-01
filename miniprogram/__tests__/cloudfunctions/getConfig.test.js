// __tests__/cloudfunctions/getConfig.test.js
//
// 为什么需要这个文件：
// getConfig 此前**没有任何入口测试**，却因为 entryCoverageGuard 的 hasEntryTest()
// 当年是 `src.includes('cloudfunctions/getConfig/index')` —— 只要有测试在文本里
// 提到这个路径就算「已测」—— 而 docsConsistencyGuard.test.js:35 恰好有一句
// `read('cloudfunctions/getConfig/index.js')`（fs.readFileSync 读文本，从不执行）。
// 于是这个专门防「入口漏测」的守卫被一句文本读取骗过：
//   - 真实未测数是 21，债务台账却只登记 20 → 棘轮基准偏移一格；
//   - getConfig 从未进入 coverage map，'./cloudfunctions/*/index.js' 逐文件阈值对它恒放行。
//
// 本文件补上真入口测试：真 require（不是 jest.mock），并锁住两条对外契约 ——
//   1. 联系方式只能来自服务端环境变量，客户端拿不到明文（与 SECURITY.md 一致）；
//   2. APP_VERSION 兜底值必须与 package.json 的 version 相同。
//      这条被 docsConsistencyGuard 的「getConfig 兜底版本与 package.json 一致」间接依赖，
//      但那一条是读文本比对；这里是**真正执行**入口得到的返回值。
const path = require('path');

const ENV_KEYS = ['CONTACT_WECHAT', 'CONTACT_EMAIL', 'APP_VERSION'];
let saved;

beforeEach(() => {
  saved = {};
  ENV_KEYS.forEach(k => {
    saved[k] = process.env[k];
    delete process.env[k];
  });
});

afterEach(() => {
  ENV_KEYS.forEach(k => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  jest.resetModules();
});

const loadMain = () => require('../../cloudfunctions/getConfig/index').main;

describe('getConfig 云函数入口', () => {
  test('不带 keys 时同时返回 contact 与 version', async () => {
    process.env.CONTACT_WECHAT = 'wxid_example';
    process.env.CONTACT_EMAIL = 'cat@example.com';
    process.env.APP_VERSION = '3.5.2';

    const res = await loadMain()({});

    expect(res.success).toBe(true);
    expect(res.data.contact).toEqual({ wechat: 'wxid_example', email: 'cat@example.com' });
    expect(res.data.version).toBe('3.5.2');
  });

  test("keys=['contact'] 只返回 contact，不泄露 version", async () => {
    process.env.CONTACT_WECHAT = 'wxid_example';
    process.env.APP_VERSION = '9.9.9';

    const res = await loadMain()({ keys: ['contact'] });

    expect(res.success).toBe(true);
    expect(res.data.contact).toBeDefined();
    expect(res.data.version).toBeUndefined();
  });

  test("keys=['version'] 只返回 version，不泄露联系方式", async () => {
    process.env.CONTACT_WECHAT = 'wxid_example';
    process.env.APP_VERSION = '3.5.2';

    const res = await loadMain()({ keys: ['version'] });

    expect(res.success).toBe(true);
    expect(res.data.version).toBe('3.5.2');
    expect(res.data.contact).toBeUndefined();
  });

  test('环境变量缺失时返回空串，而不是 undefined（避免前端拿到 undefined 渲染出 "undefined"）', async () => {
    const res = await loadMain()({ keys: ['contact'] });

    expect(res.success).toBe(true);
    expect(res.data.contact).toEqual({ wechat: '', email: '' });
  });

  test('APP_VERSION 兜底值必须与 package.json 的 version 一致', async () => {
    const pkg = JSON.parse(
      require('fs').readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
    );
    delete process.env.APP_VERSION;

    const res = await loadMain()({ keys: ['version'] });

    expect(res.data.version).toBe(pkg.version);
    // 与 docsConsistencyGuard 读文本的那条判定保持同一口径
    expect(require('fs')
      .readFileSync(path.join(__dirname, '../../cloudfunctions/getConfig/index.js'), 'utf8'))
      .toContain(`'${pkg.version}'`);
  });

  test('keys 类型非法导致抛错时必须 fail-closed，返回统一失败结构', async () => {
    // 123.includes 不是函数 → 落进 catch；入口不允许在异常时抛出未捕获错误
    const res = await loadMain()({ keys: 123 });

    expect(res.success).toBe(false);
    expect(res.error).toBe('获取配置失败');
    expect(res.code).toBe('ERROR');
  });

  test('返回值只含 contact / version 两个字段，不夹带环境变量全集', async () => {
    process.env.SECRET_TOKEN = 'must-not-leak';
    process.env.CONTACT_WECHAT = 'wxid_example';

    const res = await loadMain()({});

    expect(Object.keys(res.data).sort()).toEqual(['contact', 'version']);
    expect(JSON.stringify(res)).not.toContain('must-not-leak');
  });
});
