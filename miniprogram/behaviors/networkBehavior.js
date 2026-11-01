// behaviors/networkBehavior.js - 网络状态监听 + 自动重试
const { Logger } = require('../utils/logger');
const { getNetworkManager, checkNetwork } = require('../utils/network');

module.exports = Behavior({
  data: {
    networkError: false,
    autoRetryCountdown: 0
  },

  // 下面的 lifetimes / pageLifetimes 仅在 behavior 被 **自定义组件** 使用时才触发。
  // 本项目该 behavior 挂在 Page（pages/index）上，这两个钩子不会执行，
  // 因此**不能**依赖它们做资源清理。网络监听与重试定时器的释放由页面自己负责：
  // 见 pages/index/index.js 的 onUnload → _cleanupAllResources()。
  lifetimes: {
    attached() {
      this._initNetworkListener();
    },
    detached() {
      this._cleanupTimers();
    }
  },

  pageLifetimes: {
    hide() {
      this._cleanupTimers();
    }
  },

  methods: {
    _initNetworkListener() {
      // 幂等：避免 behavior 与页面 onLoad 双重调用导致重复订阅
      if (this._networkUnsubscribe) return;
      const networkManager = getNetworkManager();
      this._networkUnsubscribe = networkManager.onStatusChange((status) => {
        Logger.info('network', '网络状态变化', status);
        if (status.isConnected && !status.wasConnected) {
          // 恢复提示由 NetworkManager._onNetworkRestore 全局统一弹出，此处不再重复 toast
          this.setData({ networkError: false });
        }
      });
    },

    _cleanupTimers() {
      if (this._autoRetryTimer) {
        clearInterval(this._autoRetryTimer);
        this._autoRetryTimer = null;
      }
      if (this._networkUnsubscribe) {
        this._networkUnsubscribe();
        this._networkUnsubscribe = null;
      }
    },

    onRetryLoad() {
      // 只清倒计时定时器：_cleanupTimers 会连网络监听一起退订，而本 behavior 挂在 Page 上
      //（lifetimes 钩子不生效），重新订阅的唯一入口在 index.onLoad —— 退订后网络恢复事件
      // 不再把 networkError 置 false，横幅常驻，用户以为一直没网。
      if (this._autoRetryTimer) {
        clearInterval(this._autoRetryTimer);
        this._autoRetryTimer = null;
      }
      this.setData({ autoRetryCountdown: 0 });

      if (!checkNetwork()) {
        // 离线点按钮不能静默：此前无任何反馈，像坏按钮
        wx.showToast({ title: '当前无网络，请检查后重试', icon: 'none' });
        return;
      }
      this.setData({ networkError: false, loading: true, showSkeleton: true });

      if (typeof this._retryLoadCallback === 'function') {
        this._retryLoadCallback();
      } else if (typeof this.loadCats === 'function') {
        this.loadCats();
      }
    },

    showNetworkErrorEnhanced() {
      this.setData({ networkError: true, autoRetryCountdown: 5, showSkeleton: false });
      if (this._autoRetryTimer) {
        clearInterval(this._autoRetryTimer);
      }
      this._autoRetryCountdown = 5;
      this._autoRetryTimer = setInterval(() => {
        this._autoRetryCountdown--;
        if (this._autoRetryCountdown <= 0) {
          clearInterval(this._autoRetryTimer);
          this._autoRetryTimer = null;
          this.setData({ autoRetryCountdown: 0 });
          Logger.info('network', '自动重试加载');
          this.onRetryLoad();
        } else {
          this.setData({ autoRetryCountdown: this._autoRetryCountdown });
        }
      }, 1000);
    },

    onNetworkChange(eventName) {
      Logger.info('network', '网络全局事件', { eventName });
    }
  }
});
