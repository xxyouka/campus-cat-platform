// components/coach-mark/coach-mark.js - 轻量就地高亮（光环 + 小气泡）
//
// 用法：页面里放一个 <coach-mark show="{{guideTour.show}}" selector="{{guideTour.selector}}" ... />，
// 组件自己在页面节点里量目标位置，在目标外圈画一圈光环，再把气泡放在目标上方/下方。
//
// 3.9.0 轻量模式（2026-10-23 按反馈重做）：
// - **不再铺全屏黑蒙层**：整页保持可见、可滚动、可点击，只给目标画光环；
// - 只有气泡本身接收点击（root / ring 都是 pointer-events:none），
//   因此用户可以边看边操作真实入口，不会出现“点不到”；
// - 默认不自动滚动：目标不在当前视口就重试几次后跳过，避免页面突然上下跳；
// - native tabBar 无法被页面级 fixed 元素覆盖，selector 绝不能指向 tabBar；
// - 量不到目标时只触发 missing，不写「已看过」。
Component({
  options: {
    styleIsolation: 'isolated'
  },

  properties: {
    show: { type: Boolean, value: false },
    selector: { type: String, value: '' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    // 'auto' | 'above' | 'below'
    placement: { type: String, value: 'auto' },
    // 光环向外扩的像素数
    padding: { type: Number, value: 8 },
    // 目标在视口外时，是否允许滚动页面去找它。
    // 默认关闭：轻量导览不该把用户正在看的页面滚走。
    autoScroll: { type: Boolean, value: false },
    // 分步导览：右上角「2/4」；单步导览传空字符串即不显示
    stepText: { type: String, value: '' },
    doneText: { type: String, value: '知道了' },
    skipText: { type: String, value: '跳过本页' }
  },

  data: {
    _visible: false,
    bubbleAbove: false,
    showArrow: true,
    ringStyle: '',
    bubbleStyle: '',
    arrowStyle: ''
  },

  observers: {
    'show, selector': function onTargetChange(show) {
      if (show) {
        this._cancelMeasure();
        this._cancelWatch();
        this._readyFired = false;
        this._lastLayoutKey = '';
        this._measure(0);
      } else {
        this._cancelMeasure();
        this._cancelWatch();
        this.setData({ _visible: false });
      }
    }
  },

  lifetimes: {
    detached() {
      this._cancelMeasure();
      this._cancelWatch();
    }
  },

  methods: {
    onDone() {
      this.triggerEvent('done');
    },

    onSkip() {
      this.triggerEvent('skip', { all: false });
    },

    onSkipAll() {
      this.triggerEvent('skip', { all: true });
    },

    _cancelMeasure() {
      if (this._measureTimer) {
        clearTimeout(this._measureTimer);
        this._measureTimer = null;
      }
    },

    _cancelWatch() {
      if (this._watchTimer) {
        clearTimeout(this._watchTimer);
        this._watchTimer = null;
      }
    },

    /**
     * 页面数据是异步回来的，600ms 量到的位置可能被后续渲染顶走
     *（实测「我的」页：推送卡在日历数据落地后下移了 160px，洞留在统计条上）。
     * 显示后再静默重量 3 次，位置变了就跟着更新，不重复记账。
     */
    _watchLayout(remaining) {
      if (remaining <= 0 || !this.properties.show) return;
      this._cancelWatch();
      this._watchTimer = setTimeout(() => {
        this._watchTimer = null;
        if (!this.properties.show) return;
        this._measure(0, true);
        this._watchLayout(remaining - 1);
      }, 500);
    },

    _windowInfo() {
      try {
        if (wx.getWindowInfo) return wx.getWindowInfo();
        return wx.getSystemInfoSync();
      } catch (e) {
        return { windowWidth: 375, windowHeight: 667 };
      }
    },

    /**
     * 量目标位置。微信的 selector query 在 onReady 前可能拿不到布局，
     * 所以失败重试；重试仍失败只报 missing，不写任何「已看过」状态。
     */
    _measure(attempt, silent) {
      const selector = this.properties.selector;
      if (!selector) {
        if (!silent) this.triggerEvent('missing', { selector, reason: 'no-selector' });
        return;
      }

      let query;
      try {
        query = wx.createSelectorQuery();
      } catch (e) {
        if (!silent) this.triggerEvent('missing', { selector, reason: 'no-query' });
        return;
      }

      query
        .select(selector)
        .boundingClientRect()
        .exec(res => {
          const rect = res && res[0];
          if (!rect || !rect.width || !rect.height) {
            if (!silent) {
              if (attempt >= 2) {
                this.triggerEvent('missing', { selector, reason: 'not-found' });
              } else {
                this._retryMeasure(selector, attempt);
              }
            }
            return;
          }

          const win = this._windowInfo();
          const vh = win && win.windowHeight ? win.windowHeight : 667;
          const visible = rect.top + rect.height > 0 && rect.top < vh;

          if (!visible) {
            if (silent) return;
            // 先等布局稳定（气泡/面板展开时元素常会移动），再决定要不要滚页面。
            // fixed 浮层里的目标不能滚页面（autoScroll=false），只重试测量。
            if (attempt < 2 || !this.properties.autoScroll) {
              if (attempt < 4) {
                this._retryMeasure(selector, attempt, 250);
              } else {
                this.triggerEvent('missing', { selector, reason: 'out-of-viewport' });
              }
            } else if (attempt === 2) {
              this._scrollToTarget(selector, attempt);
            } else {
              this.triggerEvent('missing', { selector, reason: 'out-of-viewport' });
            }
            return;
          }

          const layout = this._computeLayout(rect, win);
          const layoutKey = JSON.stringify(layout);
          if (layoutKey !== this._lastLayoutKey) {
            this._lastLayoutKey = layoutKey;
            this.setData(layout);
          }
          if (!this._readyFired) {
            this._readyFired = true;
            this.triggerEvent('ready', { selector });
            // 页面数据可能比首屏门禁更晚落地（实测我的页会再顶 200px），
            // 用较长窗口静默跟随，避免光环留在旧位置；覆盖 15 秒自动收起窗口。
            this._watchLayout(30);
          }
        });
    },

    _scrollToTarget(selector, attempt) {
      try {
        // offsetTop 留出沉浸式导航栏的高度，否则目标会被 navbar 压住
        wx.pageScrollTo({ selector, offsetTop: -110, duration: 300 });
      } catch (e) {
        this.triggerEvent('missing', { selector, reason: 'scroll-failed' });
        return;
      }
      this._cancelMeasure();
      this._measureTimer = setTimeout(() => {
        this._measureTimer = null;
        this._measure(attempt + 1);
      }, 380);
    },

    _retryMeasure(selector, attempt, delay) {
      this._cancelMeasure();
      this._measureTimer = setTimeout(() => {
        this._measureTimer = null;
        this._measure(attempt + 1);
      }, delay || 120);
    },

    /**
     * 纯计算：把目标矩形换算成光环、气泡的几何。
     * 抽成方法是为了单测能直接验证边界（贴顶、贴底、屏幕左右越界）。
     */
    _computeLayout(rect, win) {
      const vw = win && win.windowWidth ? win.windowWidth : 375;
      const vh = win && win.windowHeight ? win.windowHeight : 667;
      const pad = this.properties.padding || 0;

      const holeTop = Math.max(0, rect.top - pad);
      const holeLeft = Math.max(0, rect.left - pad);
      const holeWidth = Math.min(vw - holeLeft, rect.width + pad * 2);
      const holeHeight = Math.min(vh - holeTop, rect.height + pad * 2);
      const holeBottom = Math.min(vh, holeTop + holeHeight);

      const bubbleWidth = Math.min(vw - 64, 264);
      const placement = this.properties.placement;
      const centerX = rect.left + rect.width / 2;
      const spaceBelow = vh - holeBottom;
      const spaceAbove = holeTop;
      // 气泡大约需要的高度：高卡片不能把气泡塞进卡片里挡住开关/木鱼，
      // 只要上方或下方有空间就放到洞外，整张卡片保持可点。
      const bubbleNeeds = 150;
      const canAbove = spaceAbove >= bubbleNeeds;
      const canBelow = spaceBelow >= bubbleNeeds;
      const tall = holeHeight > vh * 0.35;

      let bubbleAbove = false;
      let bubbleInside = false;
      if (placement === 'above') {
        bubbleAbove = canAbove;
        bubbleInside = !canAbove && !canBelow && tall;
      } else if (placement === 'below') {
        bubbleAbove = false;
        bubbleInside = !canBelow && tall;
      } else if (tall) {
        // 高卡片优先放上方/下方，实在没空间才放进洞里
        if (canAbove) bubbleAbove = true;
        else if (!canBelow) bubbleInside = true;
      } else if (canAbove && (!canBelow || holeTop > vh * 0.42)) {
        bubbleAbove = true;
      }

      const left = Math.min(Math.max(centerX - bubbleWidth / 2, 20), vw - bubbleWidth - 20);
      const gap = 12;
      let vertical;
      if (bubbleInside) {
        vertical = `top:${Math.min(holeTop + 20, vh - 190)}px;`;
      } else if (bubbleAbove) {
        vertical = `bottom:${Math.max(8, vh - holeTop + gap)}px;`;
      } else {
        vertical = `top:${Math.min(vh - 16, holeBottom + gap)}px;`;
      }

      const arrowLeft = Math.min(Math.max(centerX - left - 9, 18), bubbleWidth - 36);

      return {
        _visible: true,
        bubbleAbove,
        showArrow: !bubbleInside,
        ringStyle: `top:${holeTop}px;left:${holeLeft}px;width:${holeWidth}px;height:${holeHeight}px;`,
        bubbleStyle: `left:${left}px;width:${bubbleWidth}px;${vertical}`,
        arrowStyle: `left:${arrowLeft}px;`
      };
    }
  }
});
