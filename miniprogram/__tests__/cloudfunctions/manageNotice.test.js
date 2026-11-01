/**
 * __tests__/cloudfunctions/manageNotice.test.js
 * 覆盖公告管理（add/update/delete/list）的鉴权与业务逻辑。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/manageNotice/utils/sanitizer', () => ({
  sanitize: jest.fn((str, opts) => {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').substring(0, opts && opts.maxLength || 500).trim();
  })
}));
jest.mock('../../cloudfunctions/manageNotice/utils/auth', () => ({
  checkAdmin: jest.fn()
}));
jest.mock('../../cloudfunctions/manageNotice/common/operationLogger', () => ({
  logOperation: jest.fn()
}));

describe('manageNotice 云函数', () => {
  let cloud;
  let auth;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    auth = require('../../cloudfunctions/manageNotice/utils/auth');
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'superadmin' } });
    main = require('../../cloudfunctions/manageNotice/index').main;
  });

  test('无效 action 返回失败', async () => {
    const res = await main({ action: 'nope' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('操作类型');
  });

  test('非管理员被拒绝', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: false, error: '无权限执行此操作，仅管理员可操作' });
    const res = await main({ action: 'add', title: '公告', content: '内容' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
  });

  test('add 缺少标题或内容返回失败', async () => {
    const res = await main({ action: 'add', title: '', content: 'x' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('不能为空');
  });

  test('add 成功写入公告', async () => {
    const res = await main({ action: 'add', title: '开学公告', content: '欢迎新同学' }, {});
    expect(res.success).toBe(true);
    expect(res.data.noticeId).toBe('mock-id');
  });

  test('update 缺少 noticeId 返回失败', async () => {
    const res = await main({ action: 'update', title: 'x', content: 'y' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少公告ID');
  });

  test('update 成功修改公告', async () => {
    const res = await main({ action: 'update', noticeId: 'n1', title: '新标题', content: '新内容' }, {});
    expect(res.success).toBe(true);
  });

  test('delete 缺少 noticeId 返回失败', async () => {
    const res = await main({ action: 'delete' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少公告ID');
  });

  test('delete 成功删除公告', async () => {
    const res = await main({ action: 'delete', noticeId: 'n1' }, {});
    expect(res.success).toBe(true);
  });

  test('普通管理员（已开通公告管理）可删除公告：删除跟随入口权限', async () => {
    auth.checkAdmin.mockResolvedValue({ isAdmin: true, adminInfo: { role: 'admin' } });
    const res = await main({ action: 'delete', noticeId: 'n1' }, {});
    expect(res.success).toBe(true);
  });

  test('未开通公告管理权限时拒绝，并透传云端提示', async () => {
    auth.checkAdmin.mockResolvedValue({
      isAdmin: false,
      error: '该账号未开通「公告管理」权限，请联系超级管理员开启'
    });
    const res = await main({ action: 'delete', noticeId: 'n1' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('未开通');
  });

  test('list 返回公告列表结构', async () => {
    const res = await main({ action: 'list' }, {});
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data.notices)).toBe(true);
  });
});
