// behaviors/backToTopBehavior.js
// 回到顶部功能（含 onPageScroll 节流）

module.exports = Behavior({
  data: {
    showBackToTop: false
  },

  methods: {
    /**
     * 带节流的 onPageScroll
     * 使用 requestAnimationFrame 确保每帧最多执行一次 setData
     */
    onPageScroll(e) {
      if (this._scrollRaf) return; // 当前帧已有待执行回调
      this._scrollRaf = true;
      wx.nextTick(() => {
        this._scrollRaf = false;
        this._handleScroll(e.scrollTop);
        // 可选扩展钩子：页面实现 _onPageScrollExtra 时一并调用。
        // 页面若自行定义 onPageScroll 会**遮蔽**本方法（本 behavior 用 Behavior()
        // 包装，方法挂在页面实例上、无法从模块顶层转发），扩展一律走该钩子。
        if (typeof this._onPageScrollExtra === 'function') {
          this._onPageScrollExtra(e);
        }
      });
    },

    /**
     * 处理滚动逻辑（子类可覆盖 threshold）
     * @param {number} scrollTop - 当前滚动距离
     */
    _handleScroll(scrollTop) {
      const threshold = this._backToTopThreshold || 600;
      const shouldShow = scrollTop > threshold;
      if (shouldShow !== this.data.showBackToTop) {
        this.setData({ showBackToTop: shouldShow });
      }
    },

    /**
     * 回到顶部
     */
    onBackToTop() {
      wx.pageScrollTo({ scrollTop: 0, duration: 300 });
      this.setData({ showBackToTop: false });
    }
  }
});
