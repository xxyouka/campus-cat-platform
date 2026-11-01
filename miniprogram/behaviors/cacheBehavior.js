// behaviors/cacheBehavior.js - 页面缓存 Behavior（本地缓存读写封装）
module.exports = Behavior({
  data: {},

  created() {
    this._cacheLastLoadTime = 0;
    this._cacheValidTime = 30000;
  },

  methods: {
    isCacheValid(validTime = 30000) {
      // 下面的 created() 仅在 behavior 被自定义组件使用时触发；
      // 本项目该 behavior 挂在 Page 上，created 不会执行，
      // 因此在这里做一次惰性初始化，避免 _cacheLastLoadTime 恒为 undefined。
      if (typeof this._cacheLastLoadTime !== 'number') {
        this._cacheLastLoadTime = 0;
        this._cacheValidTime = 30000;
      }
      const now = Date.now();
      return now - this._cacheLastLoadTime < validTime;
    },

    updateCacheTime() {
      this._cacheLastLoadTime = Date.now();
    },

    clearCache() {
      this._cacheLastLoadTime = 0;
    },

    invalidateCache() {
      this._cacheLastLoadTime = 0;
    },

    isCacheStale(validTime = 30000) {
      return !this.isCacheValid(validTime);
    },

    async loadWithCache(loadFn, options = {}) {
      const { validTime = 30000, force = false } = options;

      if (!force && this.isCacheValid(validTime)) {
        return;
      }

      const result = await loadFn();

      this.updateCacheTime();

      return result;
    }
  }
});
