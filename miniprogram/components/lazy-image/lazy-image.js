/**
 * components/lazy-image/lazy-image.js - 懒加载图片组件
 *
 * 功能：
 * 1. 懒加载 - 进入可视区域才加载
 * 2. 渐进式加载 - 先显示低质量占位图，再显示高清图
 * 3. 加载状态 - 显示骨架屏/加载动画
 * 4. 错误处理 - 加载失败显示占位图
 * 5. 缓存优化 - 自动使用内存缓存
 */

const imageLoader = require('../../utils/imageLoader');
const { Logger } = require('../../utils/logger');

Component({
  externalClasses: ['custom-class'],

  /**
   * 组件属性
   */
  properties: {
    // 无障碍：读屏文案（由调用方传入，转发到组件根节点）
    ariaLabel: {
      type: String,
      value: ''
    },
    // 图片云存储ID (cloud:// 开头) 或已解析的 http URL
    src: {
      type: String,
      value: ''
    },
    // 图片类型：avatar|thumbnail|gallery|detail
    type: {
      type: String,
      value: 'thumbnail'
    },
    // 是否懒加载
    lazy: {
      type: Boolean,
      value: true
    },
    // 是否渐进式加载
    progressive: {
      type: Boolean,
      value: false  // 渐进式会触发两次 getTempFileURL，按 type 动态决定
    },
    // 在需要与应用侧批量转链共享同一个 gallery 请求时，关闭 gallery 默认的渐进双转链。
    disableProgressive: {
      type: Boolean,
      value: false
    },
    // 图片模式
    mode: {
      type: String,
      value: 'aspectFill'
    },
    // 圆角
    radius: {
      type: String,
      value: '0'
    },
    // 是否显示加载动画
    showLoading: {
      type: Boolean,
      value: true
    }
  },

  /**
   * 组件数据
   */
  data: {
    currentUrl: '',
    status: 'loading',
    usePlaceholder: true,
    uniqueId: '',
    radiusStr: '0rpx'
  },

  /**
   * 组件生命周期
   */
  lifetimes: {
    attached () {
      this._attached = true;
      this._uniqueId = `lazy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.setData({ uniqueId: this._uniqueId });
      wx.nextTick(() => {
        this.initLoad();
      });
    },

    detached () {
      // 组件已销毁：后续所有轮询/异步回调都必须短路
      this._destroyed = true;
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      // uniqueId 轮询定时器：句柄原先没保存，组件销毁后仍会回调，
      // 在已销毁组件上 createIntersectionObserver / setData
      if (this._uidTimer) {
        clearTimeout(this._uidTimer);
        this._uidTimer = null;
      }
    }
  },

  /**
   * 属性监听器
   */
  observers: {
    'src': function (newSrc) {
      if (!this._attached) return;
      const normalizedSrc = newSrc === null ? '' : newSrc;
      if (normalizedSrc && normalizedSrc !== this._lastSrc) {
        this._lastSrc = normalizedSrc;
        this.initLoad();
      }
    },
    'radius': function (val) {
      if (!val) { this.setData({ radiusStr: '0rpx' }); return; }
      if (val.includes('%')) { this.setData({ radiusStr: val }); return; }
      this.setData({ radiusStr: val + 'rpx' });
    }
  },

  /**
   * 组件方法
   */
  methods: {
    /**
     * 初始化加载
     */
    initLoad () {
      const { src, lazy } = this.properties;

      if (!src) {
        this.setData({
          currentUrl: '',
          status: 'error',
          usePlaceholder: true
        });
        return;
      }

      // 重置重试计数：src 变更后之前失败的重试次数不应继承
      this._retryCount = 0;

      // 重置状态
      this.setData({
        status: 'loading',
        usePlaceholder: true
      });

      // 判断是否需要懒加载
      if (lazy && !this._loaded) {
        this.setupLazyLoad();
      } else {
        this.loadImage();
      }
    },

    /**
     * 设置懒加载
     */
    setupLazyLoad (attempt = 0) {
      // 组件已销毁：不再重试，也不碰 observer / setData
      if (this._destroyed) return;

      // 安全保护：最多重试 20 次（约 1 秒），防止无限递归
      if (attempt > 20) {
        Logger.warn('lazy-image', 'uniqueId 获取超时，直接加载', this.properties.src);
        this.loadImage();
        return;
      }

      // 确保 uniqueId 已就绪，否则等待 setData 完成
      const uid = this._uniqueId || this.data.uniqueId;
      if (!uid) {
        // uniqueId 尚未设置，延迟到下一个 tick 重试（句柄需保存供 detached 清理）
        this._uidTimer = setTimeout(() => this.setupLazyLoad(attempt + 1), 50);
        return;
      }

      // 使用 IntersectionObserver 监听元素进入可视区域
      // 添加 nativeMode 提升性能（小程序 2.14.0+ 支持）
      const observerOptions = {
        thresholds: [0],
        initialRatio: 0,
        nativeMode: true
      };

      this._observer = this.createIntersectionObserver(observerOptions);

      this._observer
        .relativeToViewport({ bottom: 200 }) // 提前200px开始加载
        .observe(`.lazy-image-wrapper-${uid}`, (res) => {
          if (res.intersectionRatio > 0) {
            this._loaded = true;
            this.loadImage();
            // 停止观察（添加空值检查）
            if (this._observer) {
              this._observer.disconnect();
              this._observer = null;
            }
          }
        });
    },

    /**
     * 加载图片
     * 优化：仅 gallery 类型默认启用渐进式（先低质量再高清），其他类型直接加载
     * 优化：avatar/thumbnail/detail 类型禁用渐进式，减少 getTempFileURL 调用次数
     * 优化：如果 src 已经是 http(s):// URL（由外部预处理），直接使用，跳过 getTempUrl
     */
    async loadImage () {
      const { src, type, progressive, disableProgressive } = this.properties;

      // 快速路径：src 已经是 http URL，无需云存储转换
      if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
        this.setData({
          currentUrl: src,
          status: 'loaded',
          usePlaceholder: false
        });
        return;
      }

      // 仅 gallery 类型默认渐进式加载，用户可手动覆盖
      const useProgressive = !disableProgressive && (progressive || type === 'gallery');

      try {
        if (useProgressive) {
          // 渐进式加载
          await this.loadProgressive(src, type);
        } else {
          // 普通加载
          await this.loadNormal(src, type);
        }
      } catch (error) {
        this.onLoadError();
      }
    },

    /**
     * 普通加载
     */
    async loadNormal (src, type) {
      // 重试必须带 force：读穿缓存会拿回与失败前完全相同的 URL，
      // <image src> 值不变不会重新发请求，3 次重试全是空转
      // （见 imageLoader.getTempUrls 的 force 说明：重试链路必须用 force）。
      const url = await imageLoader.getTempUrl(src, {
        optimize: true,
        optimizeType: type,
        force: (this._retryCount || 0) > 0
      });

      if (url && !url.startsWith('cloud://')) {
        this.setData({
          currentUrl: url,
          status: 'loaded',
          usePlaceholder: false
        });
      } else {
        this.onLoadError();
      }
    },

    /**
     * 渐进式加载
     */
    async loadProgressive (src, type) {
      // 同 loadNormal：重试轮次必须强制重新转链，否则读穿缓存拿回同一 URL 是空转
      const force = (this._retryCount || 0) > 0;
      const placeholderUrl = await imageLoader.getTempUrl(src, {
        optimize: true,
        optimizeType: 'thumbnail',
        force
      });

      if (placeholderUrl && !placeholderUrl.startsWith('cloud://')) {
        this.setData({
          currentUrl: placeholderUrl,
          status: 'loading',
          usePlaceholder: false
        });
      }

      const fullUrl = await imageLoader.getTempUrl(src, {
        optimize: true,
        optimizeType: type,
        force
      });

      if (fullUrl && !fullUrl.startsWith('cloud://')) {
        this.setData({
          currentUrl: fullUrl,
          status: 'loaded',
          usePlaceholder: false
        });
      } else if (!placeholderUrl || placeholderUrl.startsWith('cloud://')) {
        this.onLoadError();
      }
    },

    /**
     * 图片加载完成
     */
    onImageLoad () {
      this.setData({
        status: 'loaded',
        usePlaceholder: false
      });

      // 触发事件
      this.triggerEvent('load', {
        src: this.properties.src,
        url: this.data.currentUrl
      });
    },

    /**
     * 图片加载失败
     */
    onImageError () {
      this.onLoadError();
    },

    /**
     * 处理加载错误 - 自动重试，不显示错误状态
     * 优化：添加抖动避免雪崩，最大延迟限制
     */
    onLoadError () {
      const retryCount = this._retryCount || 0;
      const maxRetries = 3;

      if (retryCount < maxRetries) {
        // 自动重试，指数退避 + 抖动
        this._retryCount = retryCount + 1;
        // 基础延迟：1s, 2s, 4s，加上 0-500ms 随机抖动
        const baseDelay = Math.min(1000 * Math.pow(2, retryCount), 4000);
        const jitter = Math.random() * 500;
        const delay = baseDelay + jitter;

        this._retryTimer = setTimeout(() => {
          this.loadImage();
        }, delay);
      } else {
        // 超过重试次数，显示错误状态
        this.setData({
          status: 'error'
        });
        this.triggerEvent('error', {
          src: this.properties.src,
          retryCount: maxRetries
        });
      }
    },

    /**
     * 手动重试（自动重试 3 次耗尽、进入 error 态后，由错误态上的按钮触发）
     */
    onRetryTap () {
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      this._retryCount = 0;
      this.setData({ status: 'loading' });
      this.loadImage();
      this.triggerEvent('retry', { src: this.properties.src });
    },

    /**
     * 点击图片
     */
    onTap () {
      this.triggerEvent('tap', {
        src: this.properties.src,
        url: this.data.currentUrl
      });
    }
  }
});
