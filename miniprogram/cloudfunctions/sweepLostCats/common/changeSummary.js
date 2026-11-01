// cloudfunctions/common/changeSummary.js - 操作日志的「人话摘要层」
//
// 背景：operationLogger 记的 beforeData / afterData 是**机器格式**，管理端
// 只能把它们原样 JSON.stringify 出来，两坨并排的代码块，管理员看不出「到底改了啥」。
// 本模块在**写入时**把变更算成中文摘要（summary + changes），
// 让日志列表直接可读，而审计层（beforeData/afterData）保持原样不动。
//
// 为什么必须在写入时算、不能在读取时算：
// updateCat 历史上只把 name/status/healthStatus 三个字段写进 beforeData/afterData，
// 校区、年龄、毛色、备注、头像、图片等改动**在源头就已经丢了** ——
// 读时无论怎么 diff 都还原不出来。摘要只能和业务写入在同一次调用里产生。

const { CAT_FIELD_LABELS, CAT_ALLOWED_FIELDS } = require('../utils/constants');

// 枚举字段取值 → 中文。**必须与管理端录入页的按钮文案逐字一致**
// （见 pages/admin/edit-cat/edit-cat.wxml 的 data-value 配对文案），
// 否则日志里的「状态」会和界面上管理员刚点的那个「状态」对不上。
const ENUM_LABELS = {
  status: { normal: '在校', adopted: '已领养', lost: '走失', deceased: '已离世' },
  healthStatus: { healthy: '健康', stomatitis: '口炎', skin: '皮肤病', other: '其他' }
};

// 图片类字段：只记张数与归属，不记 fileID。
// fileID 是 cloud:// 长串且前端不能直接渲染（须 getTempFileURL 换临时链，
// 而临时链约 2 小时过期）—— 记进日志既读不懂又会随时间失效，
// 真正要看图应该去相册管理。故按「新增 N 张 / 移除 N 张」记录。
const IMAGE_FIELD_LABELS = { images: '图片' };

// 单个值在变更明细里的最大字数。猫咪 notes 允许 1000 字、description 允许 500 字，
// 整段灌进列表会把卡片撑爆，且列表里没人会读完整段备注。
const MAX_VALUE_LENGTH = 60;

// 单条日志最多记录多少个字段变更。CAT_ALLOWED_FIELDS 有 20 个字段，
// 全量换算会让一行日志变成一段话；超出部分在摘要里以「等 N 项」收口。
const MAX_CHANGES = 12;

// summary 整行的最大字数（changes 展开后的兜底上限）
const MAX_SUMMARY_LENGTH = 200;

/**
 * 截断超长文本，超出时补省略号。
 *
 * 截断预算必须**连省略号一起算**：早先写作 `slice(0, max) + '…'`，
 * 结果是 200 字上限实际产出 201 字 —— 封顶形同虚设，
 * 而 summary 的长度正是靠这个上限兜住日志列表的排版。
 *
 * @param {*} value - 任意值
 * @param {number} [max] - 最大长度（含末尾省略号）
 * @returns {string}
 */
function truncate(value, max = MAX_VALUE_LENGTH) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 把字段值转成可读文本。
 *
 * 空值统一显示为「空」而不是空字符串：否则变更明细里会出现
 * 「年龄：（空）」这种看不出发生了什么的行。
 *
 * @param {string} field - 字段名
 * @param {*} value - 字段值
 * @returns {string}
 */
function formatFieldValue(field, value) {
  if (field === 'avatar') {
    return value ? '已设置' : '未设置';
  }
  if (field === 'images') {
    const arr = Array.isArray(value) ? value : [];
    return `${arr.length} 张`;
  }
  if (field === 'tags') {
    const arr = Array.isArray(value) ? value : [];
    return arr.length ? truncate(arr.join('、')) : '无';
  }
  if (value === undefined || value === null || value === '') return '空';
  if (field === 'sterilized') return value ? '已绝育' : '未绝育';
  // 好猫星级：0 是「未评级」而不是「0 星」，日志里要能看出管理员是取消了评级
  if (field === 'adoptLevel') {
    const level = Number(value);
    return level > 0 ? `${level} 星` : '未评级';
  }
  const enumMap = ENUM_LABELS[field];
  if (enumMap && enumMap[value] !== undefined) return enumMap[value];
  return truncate(value);
}

/** 取值归一为字符串数组（tags/images 之外的值也兼容单值写法） */
function toArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

/**
 * 判断两个值是否等价（用于过滤「没有真正变化」的字段）。
 *
 * 必须按元素比较而不是整体 JSON.stringify：tags/images 的数组顺序在
 * 管理端编辑表单里可能被重排（如把「亲人」从第 2 位拖到第 1 位），
 * 顺序变了但内容没变，逐元素比较能让这类操作不进变更明细。
 */
function isSameValue(field, beforeValue, afterValue) {
  if (field === 'tags' || field === 'images') {
    const a = toArray(beforeValue).slice().sort();
    const b = toArray(afterValue).slice().sort();
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  // 好猫星级：字段缺失 / 0 / '' 都表示「未评级」，按语义等价比较 ——
  // 否则给从未评级的猫保存一次昵称，也会记一条「好猫星级 空 → 未评级」的假变更。
  if (field === 'adoptLevel') {
    const before = Number(beforeValue) || 0;
    const after = Number(afterValue) || 0;
    return before === after;
  }
  return String(beforeValue === undefined || beforeValue === null ? '' : beforeValue)
    === String(afterValue === undefined || afterValue === null ? '' : afterValue);
}

/**
 * 图片数组 diff：只报「新增几张 / 移除几张」，不比对具体 fileID。
 *
 * 用集合差集而不是长度差：换了一张图（删 1 加 1）长度不变，
 * 但对管理员来说「换图了」正是最该被记下来的操作。
 *
 * @returns {{label: string, text: string}|null} 无变化返回 null
 */
function diffImageArray(field, beforeValue, afterValue) {
  const beforeSet = new Set(toArray(beforeValue));
  const afterSet = new Set(toArray(afterValue));

  const added = toArray(afterValue).filter(v => !beforeSet.has(v)).length;
  const removed = toArray(beforeValue).filter(v => !afterSet.has(v)).length;

  const parts = [];
  if (added > 0) parts.push(`新增 ${added} 张`);
  if (removed > 0) parts.push(`移除 ${removed} 张`);

  if (!parts.length) return null;
  return { label: IMAGE_FIELD_LABELS[field] || '图片', text: parts.join('，') };
}

/**
 * 计算一次更新实际改动了哪些字段，产出中文变更明细。
 *
 * **只遍历 after 中存在的字段**：updateCat 的入参只下发管理员本次真正修改的字段
 * （buildSanitizedData 对 undefined 直接 continue），若把 undefined 的字段也拿来比，
 * 一次「只改名字」的操作会凭空多出十几行「校区 空 → 空」的噪音。
 *
 * @param {Object} before - 更新前的完整猫咪文档
 * @param {Object} after - 本次提交并已消毒的数据（只含被改动的字段）
 * @returns {Array<{label: string, from?: string, to?: string, text?: string}>}
 */
function diffCatFields(before, after) {
  const changes = [];
  if (!after || typeof after !== 'object') return changes;

  // 按 CAT_ALLOWED_FIELDS 的固定顺序遍历，保证同一份操作每次生成的明细顺序一致
  for (const field of CAT_ALLOWED_FIELDS) {
    if (changes.length >= MAX_CHANGES) break;

    const afterValue = after[field];
    // 字段未被本次提交触及：不比较（见上方说明）
    if (afterValue === undefined) continue;

    const beforeValue = before ? before[field] : undefined;
    if (isSameValue(field, beforeValue, afterValue)) continue;

    const label = CAT_FIELD_LABELS[field] || field;

    if (field === 'images') {
      const diff = diffImageArray(field, beforeValue, afterValue);
      if (diff) changes.push(diff);
      continue;
    }

    if (field === 'avatar') {
      // fileID 无可读性，也不该出现在给人看的日志里：只记「有没有换」
      changes.push({
        label,
        from: beforeValue ? '已设置' : '未设置',
        to: afterValue ? '已设置' : '未设置'
      });
      continue;
    }

    changes.push({
      label,
      from: formatFieldValue(field, beforeValue),
      to: formatFieldValue(field, afterValue)
    });
  }

  return changes;
}

/**
 * 把变更明细拼成一行人话摘要。
 *
 * @param {string} headline - 事件标题，如 `编辑猫咪「小花」`
 * @param {Array} changes - diffCatFields 的产物
 * @returns {string}
 */
function buildSummary(headline, changes) {
  const base = headline || '';
  if (!Array.isArray(changes) || !changes.length) return truncate(base, MAX_SUMMARY_LENGTH);

  const omitted = changes.length > MAX_CHANGES ? changes.length - MAX_CHANGES : 0;
  const shown = changes.slice(0, MAX_CHANGES);

  const detail = shown
    .map(c => c.text ? `${c.label} ${c.text}` : `${c.label} ${c.from} → ${c.to}`)
    .join('；');

  const tail = omitted > 0 ? `；等共 ${changes.length} 项` : '';
  return truncate(`${base}：${detail}${tail}`, MAX_SUMMARY_LENGTH);
}

/**
 * 清洗写入日志的 changes：只保留白名单键、字符串长度封顶、条数封顶。
 *
 * logOperation 的入参来自各云函数调用点，不应假定它们都守规矩；
 * 一条日志文档超限会连带写库失败，而写库失败又会被 operationLogger 吞掉
 * —— 结果是**这条操作彻底没有日志**，比字段脏更难查。
 *
 * @param {*} changes - 未经清洗的变更明细
 * @returns {Array<object>} 清洗后的明细（空数组表示不写该字段）
 */
function sanitizeChanges(changes) {
  if (!Array.isArray(changes)) return [];

  return changes.slice(0, MAX_CHANGES)
    .filter(c => c && typeof c === 'object')
    .map(c => {
      const out = { label: truncate(c.label, 20) };
      if (c.text !== undefined) {
        out.text = truncate(c.text, MAX_VALUE_LENGTH);
      } else {
        out.from = truncate(c.from, MAX_VALUE_LENGTH);
        out.to = truncate(c.to, MAX_VALUE_LENGTH);
      }
      return out;
    })
    .filter(c => c.label);
}

module.exports = {
  diffCatFields,
  buildSummary,
  sanitizeChanges,
  formatFieldValue,
  // 仅供测试断言内部口径，不作为云函数调用面
  ENUM_LABELS,
  MAX_CHANGES,
  MAX_SUMMARY_LENGTH
};