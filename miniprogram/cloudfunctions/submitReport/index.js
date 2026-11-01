// cloudfunctions/submitReport/index.js - 用户反馈（信息有误 / 受伤 / 其他 / 小程序意见）
//
// 用户端只提交「猫 + 类型 + 描述」，不传昵称/openid；身份只认服务端 OPENID。
// 描述走 msgSecCheck（失败关闭），猫信息由服务端回读，避免客户端伪造猫名/头像。
// 不带 catId 视为「小程序意见反馈」（type 一律按 other 落库），复用同一处理流。
// 频控：同一 openid 24 小时内最多 5 条，防止刷屏；结果进 user_reports，管理端处理。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const sanitizer = require('./utils/sanitizer');
const { checkText } = require('./utils/contentSecurity');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const REPORT_TYPES = new Set(['info_error', 'injured', 'other']);
const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 200;
const MAX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const APP_FEEDBACK_CAT_NAME = '小程序意见反馈';

function normalizeType(value) {
  const type = String(value || '').trim();
  return REPORT_TYPES.has(type) ? type : '';
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('请先登录后再反馈', 'UNAUTHORIZED');

  const catId = String(event.catId || '').trim();
  if (catId && !sanitizer.isValidObjectId(catId)) return fail('无效的猫咪', 'INVALID_CAT');

  const isAppFeedback = !catId;
  let type = normalizeType(event.type);
  if (!type) return fail('请选择反馈类型', 'INVALID_TYPE');
  // 小程序意见没有猫档案可关联，类型只可能是 other，避免脏数据进筛选
  if (isAppFeedback) type = 'other';

  const rawDescription = typeof event.description === 'string' ? event.description : '';
  const description = sanitizer.sanitizeWithEmoji(rawDescription.trim(), DESCRIPTION_MAX);
  if (description.length < DESCRIPTION_MIN) {
    return fail(`请至少写 ${DESCRIPTION_MIN} 个字，方便管理员判断`, 'DESCRIPTION_TOO_SHORT');
  }

  // 频控：先查再写，校园规模下足够；并发极端情况最多多出一条，不影响审核。
  try {
    const recent = await db.collection(COLLECTIONS.USER_REPORTS)
      .where({
        _openid: OPENID,
        createTime: _.gte(new Date(Date.now() - DAY_MS))
      })
      .count();
    if ((recent.total || 0) >= MAX_PER_DAY) {
      return fail('今天反馈得有点多，明天再来吧', 'RATE_LIMITED');
    }
  } catch (err) {
    // 集合未建 / 查询异常：放行，不能因为频控查询失败挡住真实反馈。
    console.warn('[submitReport] 频控查询失败，按放行处理:', err.message || err);
  }

  let cat = null;
  if (!isAppFeedback) {
    try {
      const res = await db.collection(COLLECTIONS.CATS)
        .where({ _id: catId, _deleting: _.neq(true) })
        .field({ name: true, avatar: true, status: true })
        .limit(1)
        .get();
      cat = (res.data || [])[0] || null;
    } catch (err) {
      console.error('[submitReport] 读取猫咪失败:', err.message || err);
      return fail('读取猫咪信息失败，请稍后重试', 'CAT_READ_FAILED');
    }
    if (!cat) return fail('这只猫的档案不存在或已删除', 'CAT_NOT_FOUND');
  }

  const textCheck = await checkText(description, { scene: 2, openid: OPENID });
  if (!textCheck.ok) {
    return fail(textCheck.error || '内容可能包含不当词语，请修改后再试', 'UNSAFE_CONTENT');
  }

  const catName = cat ? sanitizer.strict(cat.name || '猫咪', 50) : APP_FEEDBACK_CAT_NAME;
  try {
    const added = await db.collection(COLLECTIONS.USER_REPORTS).add({
      data: {
        _openid: OPENID,
        catId,
        catName,
        catAvatar: cat ? cat.avatar || '' : '',
        catStatus: cat ? cat.status || '' : '',
        type,
        description,
        status: 'pending',
        handleNote: '',
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    });

    return ok({ id: added._id || '' }, '已收到，管理员会尽快处理');
  } catch (err) {
    console.error('[submitReport] 写入反馈失败:', err.message || err);
    return fail('提交失败，请稍后重试', 'WRITE_FAILED');
  }
};
