/**
 * assets/icons/manifest.js - 图标清单（语义名 → Phosphor 图标映射）
 *
 * 唯一图标来源。改图标 / 加图标只改这个文件，然后跑：
 *   npm run build:icons
 * 会重新生成：
 *   styles/iconfont.wxss            （子集字体 base64 内联 + 类）
 *   components/icon/iconfont-map.js （语义名 → 码位 + 字重，供 icon 组件引用）
 *
 * 字段说明：
 *   ph     Phosphor 图标名（@phosphor-icons/web，MIT 许可，见同目录 LICENSE-phosphor.txt）
 *   fill   可选，true 表示用 Fill 字重（实心），默认 regular（线性）
 *
 * 命名规范：kebab-case 语义名；色值 / 尺寸 / 主题（深浅色）不在此处维护，
 * 字体图标随 currentColor 染色，深浅色同一套。
 */
module.exports = {
  // ===== 导航 / 通用 =====
  'arrow-left': { ph: 'arrow-left' },
  'arrow-right': { ph: 'arrow-right' },
  'arrow-up': { ph: 'arrow-up' },
  'arrow-down': { ph: 'arrow-down' },
  'home': { ph: 'house' },
  'search': { ph: 'magnifying-glass' },
  'close': { ph: 'x' },
  'plus': { ph: 'plus' },
  'check': { ph: 'check' },
  'check-circle': { ph: 'check-circle' },
  'refresh': { ph: 'arrows-clockwise' },
  'point-up': { ph: 'cursor' },
  'share': { ph: 'share-network' },

  // ===== 品牌 / 猫咪 =====
  // 猫系图标先用开源近似字形顶着（Phosphor cat），后续有品牌自绘 SVG 只需替换映射
  'cat': { ph: 'cat' },
  'cat-outline': { ph: 'cat' },
  'cat-happy': { ph: 'cat' },
  'cat-sad': { ph: 'cat' },
  'paw': { ph: 'paw-print' },
  'dove': { ph: 'bird' },
  'heart': { ph: 'heart', fill: true },
  'heart-outline': { ph: 'heart' },
  'heart-double': { ph: 'heart', fill: true },
  'heart-gift': { ph: 'gift' },
  'heart-handshake': { ph: 'hand-heart' },
  'sparkle': { ph: 'sparkle' },
  'star': { ph: 'star' },
  'star-fill': { ph: 'star', fill: true },

  // ===== 内容 / 功能 =====
  'announce': { ph: 'megaphone' },
  'bell': { ph: 'bell' },
  'bell-off': { ph: 'bell-slash' },
  'book': { ph: 'book' },
  'calendar': { ph: 'calendar' },
  'camera': { ph: 'camera' },
  'camera-outline': { ph: 'image' },
  'chart': { ph: 'chart-bar' },
  'chart-up': { ph: 'trend-up' },
  'chat': { ph: 'chat-circle' },
  'clipboard': { ph: 'clipboard' },
  'clock': { ph: 'clock' },
  'edit': { ph: 'pencil' },
  'email': { ph: 'envelope' },
  'eye': { ph: 'eye' },
  'eye-off': { ph: 'eye-slash' },
  'eyes': { ph: 'eyes' },
  'female': { ph: 'gender-female' },
  'male': { ph: 'gender-male' },
  'file': { ph: 'file' },
  'fire': { ph: 'fire' },
  'fish': { ph: 'fish' },                // 木鱼版：敲木鱼攒次数
  'folder': { ph: 'folder' },
  'health': { ph: 'first-aid' },
  'hourglass': { ph: 'hourglass' },
  'import': { ph: 'download-simple' },
  'info': { ph: 'info' },
  'lightbulb': { ph: 'lightbulb' },
  'lightning': { ph: 'lightning' },
  'link': { ph: 'link' },
  'lock': { ph: 'lock' },
  'unlock': { ph: 'lock-open' },
  'note': { ph: 'note' },
  'package': { ph: 'package' },
  'palette': { ph: 'palette' },
  'pin': { ph: 'map-pin' },
  'save': { ph: 'floppy-disk' },
  'scissors': { ph: 'scissors' },
  'settings': { ph: 'gear-six' },
  'swap': { ph: 'swap' },                // 木鱼版 ⇄ 经典版 切换
  'tag': { ph: 'tag' },
  'target': { ph: 'target' },
  'thought': { ph: 'brain' },
  'tools': { ph: 'wrench' },
  'trash': { ph: 'trash' },
  'trophy': { ph: 'trophy' },
  'user': { ph: 'user' },
  'users': { ph: 'users' },
  'warning': { ph: 'warning' },
  'celebrate': { ph: 'confetti' },

  // ===== 榜单 / 勋章（三色通过 CSS 上色，共用同一字形）=====
  'medal-gold': { ph: 'medal' },
  'medal-silver': { ph: 'medal' },
  'medal-bronze': { ph: 'medal' },

  // ===== 场景 / 状态（emoji 清零批次引入）=====
  'waves': { ph: 'waves' },            // 校区：南区
  'wave': { ph: 'hand-waving' },       // 欢迎 / 打招呼
  'school': { ph: 'buildings' },       // 校区：本部
  'tree': { ph: 'tree' },              // 校区：东区
  'leaf': { ph: 'leaf' },              // 校区：西区
  'stopwatch': { ph: 'timer' },        // 时长角标
  'moon': { ph: 'moon' },              // 相遇状态：在睡觉
  'utensils': { ph: 'fork-knife' },    // 相遇状态：在吃饭
  'gamepad': { ph: 'game-controller' },// 相遇状态：在玩耍
  'stethoscope': { ph: 'stethoscope' },// 健康提醒
  'siren': { ph: 'siren' },            // 走失提醒
};
