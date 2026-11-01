// behaviors/safeSetDataBehavior.js - setData 卸载保护
// 在页面卸载或隐藏后，避免异步回调中执行 setData 导致报错或性能问题
//
// 重要约束（务必读）：
// 微信的 Behavior 仅在被 **自定义组件（Component）** 使用时才会触发
// `lifetimes` / `pageLifetimes`。本项目中该 behavior 主要挂在 **Page** 上，
// 此时这两个钩子【不会执行】，`_isUnmounted` 会一直保持 undefined，
// 也就是说「自动」卸载保护对 Page 是空转的。
//
// 因此对本项目而言，正确的用法是：
//   1. 页面在 onUnload / onHide 中显式调用 this._markUnmounted()；
//   2. 或者由页面自己在异步回调前判断 this._isUnmounted。
// 两种方式都能让下面的 safeSetData 真正生效。
//
// 为什么不用 getCurrentPages() 做兜底判断：单元测试中该全局默认返回空数组，
// 一旦按页面栈判断会把测试环境里的所有 setData 全部丢弃，造成大面积误伤；
// 且每次 setData 都遍历页面栈在热路径上不划算。故采用显式标记。
module.exports = Behavior({
  lifetimes: {
    attached() {
      this._isUnmounted = false;
    },
    detached() {
      this._isUnmounted = true;
    }
  },
  pageLifetimes: {
    // 仅对 Component 生效；Page 场景见文件头说明
    show() {
      this._isUnmounted = false;
    },
    hide() {
      this._isUnmounted = true;
    }
  },
  methods: {
    /**
     * 标记当前页面/组件已不可安全 setData。
     * Page 的 onUnload / onHide 中请显式调用本方法。
     */
    _markUnmounted() {
      this._isUnmounted = true;
    },

    /**
     * 标记当前页面/组件恢复可安全 setData（如 onShow 中）。
     */
    _markMounted() {
      this._isUnmounted = false;
    },

    safeSetData(data, callback) {
      if (this._isUnmounted) return;
      if (typeof callback === 'function') {
        this.setData(data, callback);
      } else {
        this.setData(data);
      }
    }
  }
});
