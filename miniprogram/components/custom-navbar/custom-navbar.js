/**
 * components/custom-navbar/custom-navbar.js - 通用自定义导航栏组件
 *
 * 功能：
 * - 自动获取状态栏高度和导航栏高度
 * - 支持返回按钮（可选）
 * - 支持多种主题样式（default/transparent/gradient/warm/light）
 * - 支持右侧插槽（分享按钮等）
 * - warm 主题自动显示猫爪装饰底纹
 *
 * 使用示例：
 * <custom-navbar title="页面标题" theme="warm" showBack="{{true}}" />
 * <custom-navbar title="详情页" theme="transparent" showBack="{{true}}">
 *   <view slot="right" bindtap="onShare">分享</view>
 * </custom-navbar>
 */

const { Logger } = require('../../utils/logger');

Component({
  properties: {
    // 标题文字
    title: {
      type: String,
      value: ''
    },
    // 副标题（仅 warm/light 主题显示）
    subtitle: {
      type: String,
      value: ''
    },
    // 主题样式：default / transparent / gradient / warm / light
    theme: {
      type: String,
      value: 'default'
    },
    // 是否显示返回按钮
    showBack: {
      type: Boolean,
      value: false
    },
    // 是否在箭头旁额外显示「返回」二字。
    // 默认关闭：系统返回键就是一个箭头，加了文字后整个左区宽出一倍，
    // 在 32rpx 边距下显得又长又笨。个别页面若确实需要文字，单独传 true 打开。
    showBackText: {
      type: Boolean,
      value: false
    }
  },

  data: {
    statusBarHeight: 20,
    navBarHeight: 44
  },

  lifetimes: {
    attached() {
      this._initNavBar();
    }
  },

  observers: {
    // 监听高度变化，自动通知父组件
    // 用 nextTick 延迟触发，避免在父组件 setData 执行期间同步回调，导致递归更新警告
    'statusBarHeight, navBarHeight': function(statusBarHeight, navBarHeight) {
      if (statusBarHeight && navBarHeight) {
        const totalHeight = statusBarHeight + navBarHeight;
        wx.nextTick(() => {
          this.triggerEvent('heightchange', { totalHeight, statusBarHeight, navBarHeight });
        });
      }
    }
  },

  methods: {
    /**
     * 初始化导航栏高度信息
     */
    _initNavBar() {
      try {
        const deviceInfo = wx.getDeviceInfo();
        const windowInfo = wx.getWindowInfo();
        
        const statusBarHeight = windowInfo.statusBarHeight || 20;
        
        // 计算导航栏高度（不同平台略有差异）
        let navBarHeight = 44;
        if (deviceInfo.platform?.toLowerCase() === 'ios') {
          navBarHeight = 44;
        } else if (deviceInfo.platform?.toLowerCase() === 'android') {
          navBarHeight = 48;
        } else {
          navBarHeight = windowInfo.windowWidth > 600 ? 48 : 44;
        }

        this.setData({
          statusBarHeight,
          navBarHeight
        });
      } catch (e) {
        Logger.warn('custom-navbar', '获取系统信息失败，使用默认值', e);
        this.setData({ statusBarHeight: 20, navBarHeight: 44 });
      }
    },

    /**
     * 返回上一页
     * 重要：如果上一页是 tabBar 页面，必须用 switchTab 而不是 navigateBack，
     * 否则会报 "navigateBack with an invalid tabbar page" 错误。
     */
    onBack() {
      const pages = getCurrentPages();
      const tabBarPages = ['pages/index/index', 'pages/gallery/gallery', 'pages/profile/profile'];
      if (pages.length > 1) {
        const prevPage = pages[pages.length - 2];
        if (tabBarPages.includes(prevPage.route)) {
          wx.switchTab({ url: '/' + prevPage.route });
        } else {
          wx.navigateBack({ delta: 1 });
        }
      } else {
        wx.switchTab({ url: '/pages/index/index' });
      }

      // 触发事件，让父组件可以监听
      this.triggerEvent('back');
    }
  }
});
