/**
 * utils/colorNormalize.js - 花色归一化（客户端共享模块）
 *
 * 与 cloudfunctions/utils/constants.js 的 COLOR_NORMALIZE_MAP **保持同步**（两端维护）。
 * 云函数负责服务端筛选与计数；客户端负责展示与本地兜底 —— 任何把「数据库原始色值」
 * 写进 colorOptions / colorFilter 的路径，都必须先经过 normalizeColor()，否则面板会
 * 把「狸白/橘白/梨花」等细项与「狸花/橘猫」等标准分类并排显示，看起来又乱又不清晰
 *（这是实际发生过的 bug：本地 mergeColorOptions 直写原始值 + _loadAllColorOptions
 * 只归一化云端返回，两头一合就混排了）。
 *
 * 当前分类策略（4 大主流品类 + 兜底）：
 *   狸花族：狸花、狸花猫、狸白、白狸、灰狸花、彩狸…  → 狸花
 *   橘猫族：橘白、橘猫、橘、Orange…                  → 橘猫
 *   奶牛族：奶牛猫、奶牛、黑白、Tuxedo…              → 奶牛
 *   三花族：三花、长毛三花、玳瑁、Calico…            → 三花
 *   其余所有 → 其他花色
 */

const COLOR_NORMALIZE_MAP = {
  // 狸花族
  '狸花': '狸花', '狸花猫': '狸花', '狸白': '狸花', '白狸': '狸花',
  '灰狸花': '狸花', '棕色狸花': '狸花', '褐色狸花': '狸花', '彩狸': '狸花',
  'Tabby': '狸花', 'Brown Tabby': '狸花',
  // 橘猫族
  '橘白': '橘猫', '橘猫': '橘猫', '橘': '橘猫', '橘色': '橘猫',
  'Orange': '橘猫', 'Ginger': '橘猫',
  // 奶牛族
  '奶牛猫': '奶牛', '奶牛': '奶牛', '黑白': '奶牛', '黑白相间': '奶牛',
  'Black and White': '奶牛', 'Tuxedo': '奶牛',
  // 三花族
  '三花': '三花', '长毛三花': '三花', '玳瑁': '三花', '三花猫': '三花',
  'Calico': '三花', 'Tortoiseshell': '三花',
};

/** 面板展示顺序：固定不随计数变化（位置稳定，用户有肌肉记忆） */
const COLOR_DISPLAY_ORDER = ['狸花', '橘猫', '三花', '奶牛', '其他花色'];

/** 标准名 → 所有原始变体（筛选查询展开用） */
const COLOR_REVERSE_MAP = (() => {
  const map = {};
  for (const [raw, std] of Object.entries(COLOR_NORMALIZE_MAP)) {
    (map[std] || (map[std] = [])).push(raw);
  }
  map['其他花色'] = [];
  return map;
})();

const KNOWN_COLOR_VARIANTS = new Set(
  ['狸花', '橘猫', '奶牛', '三花'].flatMap(std => COLOR_REVERSE_MAP[std])
);

/** 原始色值 → 标准分类名（空值返回空串，非空未知值归「其他花色」） */
function normalizeColor(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return COLOR_NORMALIZE_MAP[trimmed] || '其他花色';
}

/** 标准分类名 → 原始变体数组（用于客户端兜底筛选匹配） */
function expandColor(std) {
  return COLOR_REVERSE_MAP[std] || [std];
}

/** 原始色值是否属于「其他花色」（不匹配任何已知变体） */
function isOtherColor(raw) {
  const trimmed = (raw || '').trim();
  return !!trimmed && !KNOWN_COLOR_VARIANTS.has(trimmed);
}

/** 把一组标准分类名按固定展示顺序排序；未知项排在「其他花色」之后 */
function sortByDisplayOrder(names) {
  const rank = name => {
    const idx = COLOR_DISPLAY_ORDER.indexOf(name);
    return idx === -1 ? COLOR_DISPLAY_ORDER.length : idx;
  };
  return [...names].sort((a, b) => rank(a) - rank(b));
}

module.exports = {
  COLOR_NORMALIZE_MAP,
  COLOR_DISPLAY_ORDER,
  normalizeColor,
  expandColor,
  isOtherColor,
  sortByDisplayOrder
};
