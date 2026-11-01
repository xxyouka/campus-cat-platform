/**
 * components/icon/icon.js - 统一图标组件
 *
 * 图标字体（assets/icons/manifest.js 生成，随 currentColor 染色、深浅色通吃）。
 * 名称未收录时不渲染，不做图片兜底：包内 PNG 套图已在 3.10.3 清理
 * （代码质量「主包内不应存在主包未使用的 JS/资源」+ 主包体积）。
 */

// ========== 字体图标（自动生成）==========
// 清单：assets/icons/manifest.js；生成：npm run build:icons
const ICON_FONT_MAP = require('./iconfont-map');

Component({
  options: { styleIsolation: 'shared' },

  properties: {
    name: { type: String, value: '' },
    size: { type: Number, value: 40 },
    customClass: { type: String, value: '' },
    customStyle: { type: String, value: '' }
  },

  data: {
    showFont: false,
    fontChar: '',
    fontFill: false
  },

  lifetimes: {
    attached() {
      this._init();
    }
  },

  observers: {
    'name'() { this._init(); }
  },

  methods: {
    _init() {
      const name = this.data.name;
      if (!name) return;

      // 兼容历史写法：-dark 后缀取同一个字形（颜色由 currentColor 决定）
      const baseName = name.replace(/-dark$/, '');
      const fontEntry = ICON_FONT_MAP[baseName];
      if (!fontEntry) {
        this.setData({ showFont: false });
        return;
      }

      this.setData({
        showFont: true,
        fontChar: String.fromCharCode(fontEntry[0]),
        fontFill: !!fontEntry[1]
      });
    }
  }
});
