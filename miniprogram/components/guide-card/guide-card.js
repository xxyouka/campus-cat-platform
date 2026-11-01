// components/guide-card/guide-card.js - 底部卡片式导览
//
// 为什么需要它：地图页的主体是 canvas，页面级 fixed 蒙层盖不住 canvas，
// 把气泡放在地图上会被画布吃掉。这里改用不依赖高亮的底部卡片：
// 文案讲清楚「先选校区 / 底部列表 / 猫针」，不遮地图，也不量元素。
Component({
  options: {
    styleIsolation: 'isolated'
  },

  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    stepText: { type: String, value: '' },
    doneText: { type: String, value: '知道了' },
    skipText: { type: String, value: '跳过' },
    // 卡片的底部偏移（rpx）：地图页用它把卡片抬到底部猫列表上方，别挡住要讲的功能
    offsetBottom: { type: Number, value: 0 }
  },

  methods: {
    preventDefault() {},
    onDone() {
      this.triggerEvent('done');
    },
    onSkip() {
      this.triggerEvent('skip');
    }
  }
});
