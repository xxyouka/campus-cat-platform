/**
 * behaviors/adminBehavior.js - 管理后台通用行为
 *
 * 提供所有 admin 页面共享的方法，消除重复代码
 */
const { hasAdminPermission } = require('../../../utils/adminAuth');

module.exports = Behavior({
  methods: {
    /**
     * 自动注入管理员账号标识，确保云函数能正确进行权限校验
     *
     * 必须返回新对象，不能原地写入入参：
     * callAdminFunction(name, data) 会把调用方持有的对象直接传进来。
     * 当前调用点多数传字面量所以没暴露问题，但一旦有人复用变量复用请求参数，
     * 管理员账号就会跨请求残留（后一次请求带上前一次的 _adminAccount）。
     */
    _injectAdminAccount(data = {}) {
      if (data._adminAccount) return data;
      const adminAccount = wx.getStorageSync('_adminAccount') || '';
      if (!adminAccount) return data;
      return { ...data, _adminAccount: adminAccount };
    },

    async verifyAdmin() {
      try {
        const data = this._injectAdminAccount({});
        const res = await wx.cloud.callFunction({ name: 'checkAdminStatus', data });
        return res.result && res.result.success && res.result.data && res.result.data.isAdmin;
      } catch (e) {
        return false;
      }
    },

    /**
     * 统一的云函数调用方法，自动附加管理员认证信息
     * @param {string} name - 云函数名称
     * @param {object} data - 请求参数
     * @param {object} options - 额外选项 (timeout 等)
     */
    async callAdminFunction(name, data = {}, options = {}) {
      try {
        const res = await wx.cloud.callFunction({
          name,
          data: this._injectAdminAccount(data),
          ...options
        });
        return res;
      } catch (err) {
        console.error(`[adminBehavior] ${name} 调用失败:`, err);
        throw err;
      }
    },

    goBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.redirectTo({ url: '/pages/admin/admin' });
      }
    },

    /**
     * 入口权限门禁（仅 UI 层；真实拦截在云函数 checkAdmin({ permission })）。
     *
     * 调用前必须先 await requireAdminAuth()：它会把最新的 permissions 写回本地，
     * 否则刚被开通的入口可能仍按旧缓存被误拒。
     *
     * @param {string} key - utils/adminPermissions 的权限 key
     * @param {string} [label] - 提示用的入口名称
     * @returns {boolean} 是否有权进入
     */
    guardPermission(key, label = '该功能') {
      if (hasAdminPermission(key)) return true;
      wx.showToast({ title: `未开通${label}权限`, icon: 'none' });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return false;
    },

    stopProp() {}
  }
});
