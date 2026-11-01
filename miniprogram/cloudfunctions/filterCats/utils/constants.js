/**
 * cloudfunctions/utils/constants.js - 云函数共享常量
 */

const CAT_ALLOWED_FIELDS = [
  'name', 'gender', 'age', 'sterilized', 'color', 'description',
  'appearance', 'location', 'campus', 'status', 'avatar', 'images', 'tags',
  'notes', 'healthStatus', 'healthNote',
  'deceasedTime', 'deceasedReason', 'lostTime', 'lostLocation',
  'adoptLevel'
];

const CAT_FIELD_LENGTH_LIMITS = {
  name: 50,
  gender: 10,
  age: 20,
  color: 30,
  description: 500,
  appearance: 200,
  location: 100,
  campus: 20,
  notes: 1000,
  healthStatus: 50,
  healthNote: 500,
  deceasedReason: 200,
  lostLocation: 100
};

// 字段名 → 中文标签（与管理端表单文案一致）。
// 长度超限/长度类内容错误必须用中文标签提示：直接拼英文字段名会让用户看到
// 「deceasedReason内容过长，请缩短后重试」这种无法自查的报错（历史问题）。
//
// 另有两处消费方：
//   1. common/changeSummary.js 的操作日志摘要层（diffCatFields）——
//      缺失标签会让日志里直接出现英文的 sterilized / avatar / images。
//   2. addCat 的超长报错（第 40 行，仅遍历 CAT_FIELD_LENGTH_LIMITS 的键）。
//      下面新增的 sterilized/avatar/images/tags/deceasedTime/lostTime 都不在
//      CAT_FIELD_LENGTH_LIMITS 里，故补标签不会改变任何既有报错文案。
const CAT_FIELD_LABELS = {
  name: '名字',
  gender: '性别',
  age: '年龄',
  sterilized: '绝育状态',
  color: '毛色',
  description: '性格描述',
  appearance: '外貌描述',
  location: '出没地点',
  campus: '校区',
  status: '状态',
  avatar: '头像',
  images: '图片',
  tags: '标签',
  notes: '备注',
  healthStatus: '健康状态',
  healthNote: '健康备注',
  deceasedTime: '离世时间',
  deceasedReason: '离世原因',
  lostTime: '走失时间',
  lostLocation: '走失地点',
  adoptLevel: '好猫星级'
};

// 猫咪状态的唯一合法取值集合。**必须集中在此定义**：
// status 落在所有列表的可见性过滤里（filterCats / catRelation 均按
// where.status = _.in([...]) 取数），一旦被写成枚举外的值（'Normal'、'在校园'），
// 这只猫会从**所有**前台列表里永久消失，而 addCat / updateCat 仍返回成功 ——
// 静默的数据丢失比报错更难排查。
const CAT_VALID_STATUS = ['normal', 'lost', 'deceased', 'adopted'];

// 允许存入非字符串标量的字段（其余白名单字段必须是字符串或字符串数组）。
// 背景：CAT_ALLOWED_FIELDS 只做「字段名」准入，不约束「值类型」，
// 对象值（如 status: {"$ne":"lost"}）会被原样落库并污染查询语义。
const CAT_NUMERIC_FIELDS = ['sterilized', 'adoptLevel'];

/**
 * 好猫星级（适合家养的推荐等级）。
 *
 * 0 或字段缺失 = 未评级（前台完全不渲染，筛选也不命中）；3 / 4 / 5 = 星级，5 星最推荐。
 * 产品口径（2026-10-19，来自大小姐反馈）：**不是每只猫都要评**，只给「明显不太具备
 * 野外生存能力、但很适合家养」的猫单独标星级，让想领养的人一眼挑出来。
 * 因此录入端只开放 3/4/5 三档（外加「不评」），这是可选字段，不能给它默认值。
 *
 * 取值必须是 0 或 3/4/5 的整数：写库前由 addCat / updateCat 显式校验，
 * 防止字符串 "4"、4.5、枚举外数字落库后，前台渲染与「>= 3」筛选出现静默漏检。
 */
const CAT_ADOPT_LEVEL_UNRATED = 0;
const CAT_ADOPT_LEVEL_VALUES = [3, 4, 5];

/**
 * 校验好猫星级取值是否合法（0 = 未评级，或 3/4/5）
 * @param {*} value
 * @returns {boolean}
 */
function isValidAdoptLevel(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (value === CAT_ADOPT_LEVEL_UNRATED || CAT_ADOPT_LEVEL_VALUES.includes(value));
}


// healthStatus 同理是前端展示依赖的枚举
/**
 * 猫咪健康状态合法值。
 *
 * 必须与前端录入页的选项**完全一致**（见 pages/admin/add-cat 与 edit-cat 的
 * `data-value="healthStatus"`）：前端提供 healthy / stomatitis / skin / other 四个，
 * 详情页与互动提示也只识别 stomatitis / skin。
 * 原先这里定义的是 ['healthy','unhealthy','recovering','unknown'] ——
 * 与前端毫无交集，导致管理员在录入页选「口炎/皮肤病/其他」时
 * addCat / updateCat 直接返回「健康状态取值不合法」，**该功能完全不可用**。
 * 保留一套前端从未使用过的枚举，等于把功能锁死在后端。
 */
const CAT_VALID_HEALTH_STATUS = ['healthy', 'stomatitis', 'skin', 'other'];

/**
 * 云数据库集合名称常量
 * 所有云函数应通过此常量引用集合名，避免硬编码
 */
const COLLECTIONS = {
  CATS: 'cats',
  PHOTOS: 'photos',
  ADMINS: 'admins',
  OPERATION_LOGS: 'operation_logs',
  USER_FAVORITES: 'userFavorites',
  RECORD_MEET: 'recordMeet',
  CAT_RELATIONS: 'cat_relations',
  HEALTH_RECORDS: 'health_records',
  ALBUMS: 'albums',
  NOTIFICATIONS: 'notifications',
  NOTICES: 'notices',
  LOGIN_ATTEMPTS: 'login_attempts',
  USER_SUBSCRIPTIONS: 'userSubscriptions',
  SUBSCRIBE_QUOTA: 'subscribeQuota',
  PHOTO_LIKES: 'photoLikes',
  MEDIA_CHECKS: 'mediaChecks',
  REPAIR_LOGS: 'repair_logs',
  USER_REPORTS: 'user_reports',
  // 运营数据面板：只存匿名用户键与页面入口名，不存原始 openid / 内容。
  // 这些集合只允许云函数读写（控制台权限设为「所有用户不可读写」），客户端不直连。
  OPS_USERS: 'ops_users',
  OPS_DAYS: 'ops_days',
  OPS_ENTRY_USAGE: 'ops_entry_usage'
};

/**
 * 花色同义词归一化映射：原始值 → 标准展示名
 * 维护原则：
 *   - 键为数据库里可能出现的所有变体（去首尾空格后精确匹配）
 *   - 值为前端筛选面板展示的标准名
 *   - 只有出现在真实数据里的变体才需加入；没见过的别预设
 *   - 新增映射后需重新部署相关云函数并清缓存（或等 TTL 过期）
 *
 * 当前分类策略（按运营口径，4 大主流品类 + 兜底）：
 *   1. 狸花族：狸花、狸花猫、狸白、白狸、灰狸花、彩狸、Tabby 等 → "狸花"
 *   2. 橘猫族：橘白、橘猫、橘、橘色、Orange、Ginger → "橘猫"
 *   3. 奶牛族：奶牛猫、奶牛、黑白、黑白相间、Tuxedo 等 → "奶牛"
 *   4. 三花族：三花、长毛三花、玳瑁、Calico、Tortoiseshell 等 → "三花"
 *   5. 其余所有 → "其他花色"（兜底）
 */
const COLOR_NORMALIZE_MAP = {
  // 狸花族
  '狸花': '狸花',
  '狸花猫': '狸花',
  '狸白': '狸花',
  '白狸': '狸花',
  '灰狸花': '狸花',
  '棕色狸花': '狸花',
  '褐色狸花': '狸花',
  '彩狸': '狸花',
  'Tabby': '狸花',
  'Brown Tabby': '狸花',
  // 橘猫族
  '橘白': '橘猫',
  '橘猫': '橘猫',
  '橘': '橘猫',
  '橘色': '橘猫',
  'Orange': '橘猫',
  'Ginger': '橘猫',
  // 奶牛族
  '奶牛猫': '奶牛',
  '奶牛': '奶牛',
  '黑白': '奶牛',
  '黑白相间': '奶牛',
  'Black and White': '奶牛',
  'Tuxedo': '奶牛',
  // 三花族
  '三花': '三花',
  '长毛三花': '三花',
  '玳瑁': '三花',
  'Calico': '三花',
  'Tortoiseshell': '三花',
  '三花猫': '三花',
};

/** 标准分类顺序（面板展示顺序，固定不随计数变化） */
const COLOR_DISPLAY_ORDER = ['狸花', '橘猫', '三花', '奶牛', '其他花色'];

/** 标准名 → 所有原始变体（反向索引，用于 filterCats 查询展开） */
const COLOR_REVERSE_MAP = (() => {
  const map = {};
  for (const [raw, std] of Object.entries(COLOR_NORMALIZE_MAP)) {
    (map[std] || (map[std] = [])).push(raw);
  }
  // "其他花色" 的反向索引留空，查诼时用 NOT IN 逻辑处理
  map['其他花色'] = [];
  return map;
})();

/** 归一化单个色值：原始值 → 标准分类名 */
function normalizeColor(raw) {
  const trimmed = (raw || '').trim();
  return COLOR_NORMALIZE_MAP[trimmed] || '其他花色';
}

/** 反向展开：标准分类名 → 原始变体数组（含自身） */
function expandColor(std) {
  return COLOR_REVERSE_MAP[std] || [std];
}

/** 获取"其他花色"的排除列表（已知三大类的所有原始变体） */
function getOtherExcludeList() {
  const exclude = new Set();
  ['白梨', '橘猫', '奶牛猫'].forEach(std => {
    COLOR_REVERSE_MAP[std].forEach(v => exclude.add(v));
  });
  return [...exclude];
}

module.exports = {
  CAT_ALLOWED_FIELDS,
  CAT_FIELD_LENGTH_LIMITS,
  CAT_FIELD_LABELS,
  CAT_VALID_STATUS,
  ALLOWED_STATUS: CAT_VALID_STATUS,
  CAT_NUMERIC_FIELDS,
  CAT_VALID_HEALTH_STATUS,
  CAT_ADOPT_LEVEL_UNRATED,
  CAT_ADOPT_LEVEL_VALUES,
  isValidAdoptLevel,
  COLLECTIONS,
  COLOR_NORMALIZE_MAP,
  COLOR_REVERSE_MAP,
  COLOR_DISPLAY_ORDER,
  normalizeColor,
  expandColor,
  getOtherExcludeList
};
