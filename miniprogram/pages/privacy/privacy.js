// pages/privacy/privacy.js
const contactHelper = require('../../utils/contactHelper');

Page({
  data: {
    navBarTotalHeight: 0,
    // 沉浸式顶部：状态栏高度
    statusBarHeight: 0,
    // 联系方式（云端配置动态加载，未配置时显示占位文案）
    contact: contactHelper.normalizeContact({}),
    // 折叠面板状态
    sections: [
      { id: 1, title: '信息收集', expanded: false },
      { id: 2, title: '照片与相册', expanded: false },
      { id: 3, title: '第三方服务', expanded: false },
      { id: 4, title: '联系我们', expanded: false }
    ]
  },

  onLoad() {
    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });
    this.loadContact();
  },

  // 动态加载联系方式（缓存 → getConfig），失败静默降级为占位文案
  async loadContact() {
    const contact = await contactHelper.loadContact();
    this.setData({ contact });
  },

  // 切换章节折叠状态
  toggleSection(e) {
    const index = e.currentTarget.dataset.id - 1;
    const sections = this.data.sections.map((item, i) => {
      if (i === index) {
        return { ...item, expanded: !item.expanded };
      }
      return item;
    });
    this.setData({ sections });
  },

  // 返回上一页
  onBack() {
    wx.navigateBack();
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    return {
      title: '校园猫猫隐私政策 | 数据怎么收集、怎么用',
      path: '/pages/privacy/privacy'
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    return {
      title: '校园猫猫隐私政策 - 你的数据如何被保护',
      query: ''
    };
  },
  onNavbarHeightChange(e) {
    const { totalHeight } = e.detail;
    if (totalHeight && totalHeight !== this.data.navBarTotalHeight) {
      this.setData({ navBarTotalHeight: totalHeight });
    }
  },

});
