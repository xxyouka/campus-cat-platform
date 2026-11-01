/**
 * utils/statusTag.js - 相遇状态标签的「文本 ↔ 图标」口径
 *
 * 落库口径（2026-10 图标统一后）：statusTag 只存纯文本（'相遇了' / 自定义短语）。
 * 历史数据兼容：老记录带 emoji 前缀（'😺 相遇了'、'✏️ 在开会'），
 * 显示前统一剥离前缀并映射为图标名，保证迁移期新旧数据渲染一致。
 */
const TAG_ICONS = {
  '相遇了': 'cat-happy',
  '在睡觉': 'moon',
  '在吃饭': 'utensils',
  '在玩耍': 'gamepad',
  '在散步': 'paw',
  '求摸摸': 'heart-handshake'
};

// 旧版默认措辞（不是六选一，但语义等同「相遇了」）
const LEGACY_TEXT_ICONS = {
  '遇见了': 'cat-happy'
};

// 历史数据 emoji 前缀 → 图标（✏️ 为旧自定义前缀）
const LEGACY_PREFIX_ICONS = {
  '😺': 'cat-happy',
  '😴': 'moon',
  '🍽️': 'utensils',
  '🍽': 'utensils',
  '🎮': 'gamepad',
  '🐾': 'paw',
  '🤗': 'heart-handshake',
  '✏️': 'edit',
  '✏': 'edit'
};

const EMOJI_PREFIX_RE = /^(😺|😴|🍽️?|🎮|🐾|🤗|✏️?)\s*/u;

/**
 * 解析 statusTag → { icon, text }
 * - '😺 相遇了' → { icon: 'cat-happy', text: '相遇了' }（历史数据）
 * - '相遇了'    → { icon: 'cat-happy', text: '相遇了' }
 * - '✏️ 在开会' → { icon: 'edit', text: '在开会' }
 * - '在开会'    → { icon: 'edit', text: '在开会' }（非六选一视为自定义）
 * - 空值        → { icon: '', text: '' }
 */
function parseStatusTag(tag) {
  const raw = tag === undefined || tag === null ? '' : String(tag).trim();
  if (!raw) return { icon: '', text: '' };

  let icon = '';
  let text = raw;
  const m = raw.match(EMOJI_PREFIX_RE);
  if (m) {
    icon = LEGACY_PREFIX_ICONS[m[1]] || '';
    text = raw.slice(m[0].length).trim();
  }
  if (!text) return { icon: icon || 'edit', text: '' };
  if (!icon) icon = TAG_ICONS[text] || LEGACY_TEXT_ICONS[text] || 'edit';
  return { icon, text };
}

/**
 * 归一化写入值：剥离历史 emoji 前缀，只留纯文本（新写入一律走这里）
 */
function normalizeStatusTag(tag) {
  return parseStatusTag(tag).text;
}

/**
 * 给相遇记录对象补显示字段：statusIcon / statusText（列表渲染用）
 */
function decorateMeet(meet) {
  const { icon, text } = parseStatusTag(meet && meet.statusTag);
  return { statusIcon: icon, statusText: text };
}

module.exports = { parseStatusTag, normalizeStatusTag, decorateMeet, TAG_ICONS };
