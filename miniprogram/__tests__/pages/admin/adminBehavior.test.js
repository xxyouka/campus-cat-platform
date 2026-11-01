/**
 * __tests__/pages/admin/adminBehavior.test.js
 *
 * guardPermission 是 2026-10 新增的入口权限门禁（UI 层）：
 * - 有权限直接放行，不弹提示
 * - 无权限：提示入口名 + 延迟 1.5s 返回，避免用户停在半初始化页面
 *
 * 真实拦截在云函数 checkAdmin({ permission })，这里只锁前端体验。
 */
const mockHasAdminPermission = jest.fn();

jest.mock('../../../utils/adminAuth', () => ({
  hasAdminPermission: (...args) => mockHasAdminPermission(...args)
}));

const behavior = require('../../../pages/admin/behaviors/adminBehavior');
const guardPermission = behavior.methods.guardPermission;

function makeCtx() {
  return {
    _navBackTimer: null,
    goBack: jest.fn()
  };
}

describe('adminBehavior.guardPermission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHasAdminPermission.mockReset();
    wx.showToast.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('有权限：放行，不弹提示也不安排返回', () => {
    mockHasAdminPermission.mockReturnValue(true);
    const ctx = makeCtx();

    expect(guardPermission.call(ctx, 'photo', '照片管理')).toBe(true);
    expect(wx.showToast).not.toHaveBeenCalled();
    expect(ctx._navBackTimer).toBeNull();
    expect(ctx.goBack).not.toHaveBeenCalled();
  });

  test('无权限：提示入口名并在 1.5s 后返回', () => {
    mockHasAdminPermission.mockReturnValue(false);
    const ctx = makeCtx();

    expect(guardPermission.call(ctx, 'photo', '照片管理')).toBe(false);
    expect(wx.showToast).toHaveBeenCalledWith({ title: '未开通照片管理权限', icon: 'none' });
    expect(ctx._navBackTimer).not.toBeNull();

    jest.advanceTimersByTime(1600);
    expect(ctx.goBack).toHaveBeenCalled();
  });

  test('未传 label 时使用通用文案', () => {
    mockHasAdminPermission.mockReturnValue(false);
    const ctx = makeCtx();

    guardPermission.call(ctx, 'photo');
    expect(wx.showToast).toHaveBeenCalledWith({ title: '未开通该功能权限', icon: 'none' });
  });
});
