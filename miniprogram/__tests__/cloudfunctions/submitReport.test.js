/**
 * __tests__/cloudfunctions/submitReport.test.js
 * 用户反馈入口：鉴权、参数校验、频控、内容安全、成功写入。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/submitReport/utils/contentSecurity', () => ({
  checkText: jest.fn(() => Promise.resolve({ ok: true }))
}));

const CAT_ID = 'a'.repeat(24);

function setup(opts = {}) {
  jest.resetModules();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  const add = jest.fn(() => Promise.resolve({ _id: opts.addId || 'report-1' }));
  const count = jest.fn(() => Promise.resolve({ total: opts.recentTotal || 0 }));
  const get = jest.fn(() => Promise.resolve({ data: opts.cat === null ? [] : [opts.cat || {
    _id: CAT_ID,
    name: '斑斑',
    avatar: 'cloud://avatar',
    status: 'normal'
  }] }));

  const collection = jest.fn((name) => {
    if (name === 'user_reports') {
      return {
        where: jest.fn(() => ({ count })),
        add
      };
    }
    if (name === 'cats') {
      return {
        where: jest.fn(() => ({
          field: jest.fn(() => ({
            limit: jest.fn(() => ({ get }))
          }))
        }))
      };
    }
    return {};
  });

  cloud.database.mockReturnValue({
    collection,
    command: { gte: jest.fn(v => v), neq: jest.fn(v => v) },
    serverDate: jest.fn(() => 'SERVER_DATE')
  });
  cloud.getWXContext.mockReturnValue({ OPENID: opts.openid === undefined ? 'user-1' : opts.openid });

  const { checkText } = require('../../cloudfunctions/submitReport/utils/contentSecurity');
  if (opts.textResult) checkText.mockResolvedValue(opts.textResult);

  const main = require('../../cloudfunctions/submitReport/index').main;
  return { main, add, count, get, checkText };
}

const base = { catId: CAT_ID, type: 'info_error', description: '名字写错了，应该叫斑斑' };

describe('submitReport 云函数', () => {
  beforeEach(() => jest.clearAllMocks());

  test('未登录直接拒绝', async () => {
    const { main } = setup({ openid: '' });
    const res = await main(base);
    expect(res.success).toBe(false);
    expect(res.code).toBe('UNAUTHORIZED');
  });

  test('猫 ID / 类型 / 描述长度校验', async () => {
    const { main } = setup();
    expect((await main({ ...base, catId: 'x' })).code).toBe('INVALID_CAT');
    expect((await main({ ...base, type: 'bad' })).code).toBe('INVALID_TYPE');
    // 「疑似走失」已从用户端移除，旧客户端传 lost 也必须拒绝
    expect((await main({ ...base, type: 'lost' })).code).toBe('INVALID_TYPE');
    expect((await main({ ...base, description: '太短' })).code).toBe('DESCRIPTION_TOO_SHORT');
  });

  test('空 catId 走小程序意见反馈：跳过猫校验，type 固定 other', async () => {
    const { main, add, get } = setup();
    const res = await main({ catId: '', type: 'info_error', description: '相册页偶尔加载不出来' });

    expect(res.success).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catId: '',
        catName: '小程序意见反馈',
        catAvatar: '',
        catStatus: '',
        type: 'other',
        status: 'pending'
      })
    });
  });

  test('猫不存在时不写库', async () => {
    const { main, add } = setup({ cat: null });
    const res = await main(base);
    expect(res.code).toBe('CAT_NOT_FOUND');
    expect(add).not.toHaveBeenCalled();
  });

  test('24h 内超过 5 条触发频控', async () => {
    const { main, add } = setup({ recentTotal: 5 });
    const res = await main(base);
    expect(res.code).toBe('RATE_LIMITED');
    expect(add).not.toHaveBeenCalled();
  });

  test('文本安全不通过时拒绝写入', async () => {
    const { main, add } = setup({ textResult: { ok: false, error: '内容不当' } });
    const res = await main(base);
    expect(res.code).toBe('UNSAFE_CONTENT');
    expect(add).not.toHaveBeenCalled();
  });

  test('成功写入 pending 反馈，猫信息以服务端为准', async () => {
    const { main, add, checkText } = setup();
    const res = await main(base);

    expect(res.success).toBe(true);
    expect(res.data.id).toBe('report-1');
    expect(checkText).toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith({
      data: expect.objectContaining({
        _openid: 'user-1',
        catId: CAT_ID,
        catName: '斑斑',
        catAvatar: 'cloud://avatar',
        catStatus: 'normal',
        type: 'info_error',
        status: 'pending',
        handleNote: ''
      })
    });
  });
});
