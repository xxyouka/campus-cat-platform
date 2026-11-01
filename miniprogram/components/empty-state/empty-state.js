// components/empty-state/empty-state.js
Component({
  properties: {
    // 图标名（见 assets/icons/manifest.js）
    icon: {
      type: String,
      value: 'cat'
    },
    // 装饰图标名（默认 paw）
    decoration: {
      type: String,
      value: 'paw'
    },
    // 主文案
    title: {
      type: String,
      value: '暂无内容'
    },
    // 副文案（可选）
    subtitle: {
      type: String,
      value: ''
    },
    // 是否显示操作按钮
    showAction: {
      type: Boolean,
      value: false
    },
    // 操作按钮文案
    actionText: {
      type: String,
      value: '去看看'
    }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
