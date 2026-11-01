// cloudfunctions/addCat/index.js - 添加猫咪云函数（服务端权限校验）
const cloud = require('wx-server-sdk');
const sanitizer = require('./utils/sanitizer');
const { checkAdmin } = require('./utils/auth');
const { checkText, checkImage, bindMediaCheckRef } = require('./utils/contentSecurity');
const { isAllowedStorageFileUnder } = require('./utils/filePathGuard');
const { logOperation } = require('./common/operationLogger');
const { COLLECTIONS, CAT_ALLOWED_FIELDS, CAT_FIELD_LENGTH_LIMITS, CAT_FIELD_LABELS, CAT_NUMERIC_FIELDS, CAT_VALID_STATUS, CAT_VALID_HEALTH_STATUS, isValidAdoptLevel } = require('./utils/constants');
const { ok, fail } = require('./utils/response');
const subscribeQuota = require('./utils/subscribeQuota');
// 列表排序值（首页/搜索顺序）：建档时必须写入，规则与维护纪律见 utils/listSort.js
const { computeListSort } = require('./utils/listSort');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 订阅消息 time 类型字段要求标准格式（toLocaleString 的斜杠格式会被微信拒收）
//
// 云函数容器时区为 UTC：直接用 getHours()/getDate() 等本地方法取到的是 UTC 墙上时间，
// 会比北京时间早 8 小时，导致服务通知里显示的时间不对（P 级故障）。
// 这里按固定 +8 偏移换算成北京时间，再用 getUTC* 读取「北京墙上时间」
// （与 cloudfunctions/utils/beijingTime.js 的 toBeijingDate 口径一致；中国无夏令时，固定偏移安全）。
function formatSubscribeTime(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const bj = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}

/**
 * 校验并清洗猫咪字段（长度限制 + 白名单 + XSS 消毒 + 数组过滤）
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function buildSanitizedCatData(catData) {
  // 验证字段长度（防止超长数据）
  for (const [field, maxLength] of Object.entries(CAT_FIELD_LENGTH_LIMITS)) {
    if (catData[field] && typeof catData[field] === 'string') {
      if (catData[field].length > maxLength) {
        console.warn(`[addCat] 字段 ${field} 超长: ${catData[field].length}/${maxLength}`);
        return { ok: false, error: `${CAT_FIELD_LABELS[field] || field}内容过长，请缩短后重试` };
      }
    }
  }

  const sanitizedData = {};
  for (const field of CAT_ALLOWED_FIELDS) {
    if (catData[field] !== undefined) {
      if (typeof catData[field] === 'string') {
        const maxLen = CAT_FIELD_LENGTH_LIMITS[field] || 500;
        const sanitized = sanitizer.sanitize(catData[field], { maxLength: maxLen, fieldName: field });
        if (!sanitized && catData[field].trim()) {
          return { ok: false, error: `${field}包含不安全内容，请调整后重试` };
        }
        sanitizedData[field] = sanitized;
      } else if (Array.isArray(catData[field])) {
        const sanitizedArr = catData[field].map(item =>
          typeof item === 'string' ? sanitizer.sanitize(item, { maxLength: 200, fieldName: field }) : item
        ).filter(item => item !== null && item !== '');
        if (sanitizedArr.length !== catData[field].length) {
          return { ok: false, error: `${field}包含不安全内容，请调整后重试` };
        }
        sanitizedData[field] = sanitizedArr;
      } else {
        // 白名单只管「字段名」，不管「值类型」。原先这里对非字符串非数组值直接放行，
        // 于是 status: {"$ne":"lost"} 这类对象值会原样落库；而所有列表都按
        // where.status = _.in([...]) 取数，结果是这只猫从所有前台永久消失且接口返回成功。
        if (!CAT_NUMERIC_FIELDS.includes(field)) {
          return { ok: false, error: `${field}类型不正确` };
        }
        sanitizedData[field] = catData[field];
      }
    }
  }

  if (sanitizedData.avatar) {
    const urlValidation = sanitizer.validateUrl(sanitizedData.avatar);
    if (!urlValidation.isValid) {
      return { ok: false, error: '头像URL格式不正确' };
    }
    // 头像必须是 cats/ 下的云存储文件：本函数在内容检测/文本检测失败时会
    // cloud.deleteFile(avatar)，路径不收窄就变成「传任意已知 fileID（备份、他人照片）
    // → 检测必然失败 → 服务端删除任意文件」的原语；同时拒绝 https 外链
    // （checkImage 对非云存储来源直接放行，等于跳过审核）。
    if (!isAllowedStorageFileUnder(urlValidation.url, ['cats/'])) {
      return { ok: false, error: '头像文件路径不正确' };
    }
    sanitizedData.avatar = urlValidation.url;
  }

  return { ok: true, data: sanitizedData };
}

/**
 * 云存储头像经 imgSecCheck 检测（内联公共模块，失败关闭）
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkAvatarImage(avatarUrl, openid) {
  return checkImage(avatarUrl, { scene: 2, openid, target: 'avatar' });
}

/**
 * 对用户可编辑文本字段逐项做 msgSecCheck（单次限 500 字，失败关闭）
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkCatTextContent(sanitizedData, openid) {
  const contentCheckFields = ['name', 'description', 'appearance', 'notes'];
  for (const field of contentCheckFields) {
    const fieldValue = sanitizedData[field];
    if (fieldValue && typeof fieldValue === 'string' && fieldValue.trim()) {
      const result = await checkText(fieldValue, { scene: 2, openid });
      if (!result.ok) {
        console.warn(`[addCat] 字段 ${field} 内容安全检测未通过`);
        return { ok: false, error: `${field}${result.error.replace(/^内容/, '')}` };
      }
    }
  }
  return { ok: true };
}

/**
 * 「新猫登场提醒」订阅消息推送。
 *
 * 目标 = 「推送次数账本（new_cat 模板 remaining>0）」∪ 历史订阅记录
 * （集合内标识 catId='new_cat'），配额优先、旧记录兜底消费，
 * 发送成功 -1、43101 清零校正（见 utils/subscribeQuota.js）。
 * 模板「新游上线提醒」勾选字段：游戏名称(thing1) / 温馨提示(thing2) / 上线日期(time3)。
 * 未配置模板 ID 时静默跳过；发送失败仅记录 warn（一次性订阅，发送失败不影响添加）。
 */
async function notifyNewCatSubscribers(catId, catName) {
  const NEW_CAT_TEMPLATE_ID = process.env.SUBSCRIBE_NEW_CAT_TEMPLATE_ID || '';
  const safeName = sanitizer.strict(catName || '猫咪', 50);

  try {
    // 历史记录兜底（兼容历史字面量 'new_cat' 与真实模板 ID 两种记录键）
    const legacyByOpenid = await subscribeQuota.fetchLegacyByOpenid(db, {
      catId: 'new_cat',
      templateId: _.in(['new_cat', NEW_CAT_TEMPLATE_ID]),
      status: 'accept'
    });

    // 新模型：所有持有 new_cat 配额的订阅者（全量游标分页）
    const quotaMap = await subscribeQuota.fetchQuotaMap(db, NEW_CAT_TEMPLATE_ID);

    const sentCount = await subscribeQuota.dispatchWithQuota({
      db,
      templateId: NEW_CAT_TEMPLATE_ID,
      quotaMap,
      legacyByOpenid,
      logTag: '[addCat] ',
      sendFn: (openid) => cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: NEW_CAT_TEMPLATE_ID,
        page: `pages/detail/detail?id=${catId}`,
        // 模板「新游上线提醒」键名=类型前缀+公共模板原始定义位置序号
        // （原始定义：游戏名称1/温馨提示2/上线日期3/开服时间4/游戏类型5/状态6）
        data: {
          thing1: { value: safeName },
          thing2: { value: '快来认识新朋友' },
          time3: { value: formatSubscribeTime() }
        },
        miniprogramState: 'formal'
      })
    });

    if (sentCount > 0) {
      console.log(`[addCat] 新猫推送已发送给${sentCount}位订阅者`);
    }
  } catch (err) {
    console.warn('[addCat] 新猫推送查询失败（非致命）:', err.message);
  }
}

exports.main = async (event, _context) => {
  // HTTP触发器适配：解析body中的JSON数据
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID || '';
  const adminAccount = event._adminAccount || '';

  try {
    const { catData } = event;

    if (!catData) {
      return fail('缺少猫咪数据');
    }

    if (!catData.name || !catData.name.trim()) {
      return fail('猫咪名字不能为空');
    }

    if (!catData.avatar) {
      return fail('猫咪大头照不能为空');
    }

    // 枚举字段必须在合法取值集合内：status 一旦写成枚举外的值
    // （'Normal'、'在校园'），所有列表的 where.status = _.in([...]) 都取不到这只猫，
    // 但添加接口仍返回成功 —— 静默的数据丢失比报错更难排查。
    if (catData.status !== undefined && !CAT_VALID_STATUS.includes(catData.status)) {
      return fail('猫咪状态取值不合法');
    }
    if (catData.healthStatus !== undefined && !CAT_VALID_HEALTH_STATUS.includes(catData.healthStatus)) {
      return fail('健康状态取值不合法');
    }
    // 好猫星级是可选字段（缺省 / 0 = 未评级），但一旦下发就必须是 0 或 3/4/5 的整数：
    // 字符串 "4"、小数、枚举外的值都会让前台星级渲染与「>= 3」筛选出现静默漏检。
    if (catData.adoptLevel !== undefined && !isValidAdoptLevel(catData.adoptLevel)) {
      return fail('好猫星级取值不合法');
    }

    const authResult = await checkAdmin(db, OPENID, { useCache: false, operation: '添加猫咪', adminAccount, permission: 'addCat' });
    if (!authResult.isAdmin) {
      return fail(authResult.error);
    }

    const built = await buildSanitizedCatData(catData);
    if (!built.ok) {
      return fail(built.error);
    }
    const sanitizedData = built.data;

    // 图片安全检测（合规要求）。target/refId 供异步检测回调定位处置对象；
    // 落库拿到 res._id 后再补绑（检测发生在落库之前，那时还没有 _id）。
    const imgCheck = await checkAvatarImage(sanitizedData.avatar, OPENID);
    if (!imgCheck.ok) {
      // 头像已由客户端上传到云存储；检测不过就没有入库记录，留着只会成为无主垃圾
      // （除控制台外没有入口能清掉它）。此处顺手回收，删除失败不影响返回结果。
      try {
        await cloud.deleteFile({ fileList: [sanitizedData.avatar] });
      } catch (cleanupErr) {
        console.warn('[addCat] 未入库头像回收失败:', cleanupErr.message || cleanupErr);
      }
      return fail(imgCheck.error);
    }

    // 文本内容安全检测（合规要求）
    const textCheck = await checkCatTextContent(sanitizedData, OPENID);
    if (!textCheck.ok) {
      // 文本不通过时头像同样未能入库，一并回收
      try {
        await cloud.deleteFile({ fileList: [sanitizedData.avatar] });
      } catch (cleanupErr) {
        console.warn('[addCat] 未入库头像回收失败:', cleanupErr.message || cleanupErr);
      }
      return fail(textCheck.error);
    }

    // 写入数据库
    // 不写 _openid：addCat 仅管理员可调，这里的 OPENID 是**管理员**的 openid，
    // 而 cats 是所有人可读的公开集合，客户端侧又是整文档直连读取（客户端 .field() 投影用量为 0）——
    // 写进去等于把管理员 openid 下发给每个用户。且该字段无人使用：全端零引用、
    // 无任何按 cats._openid 的查询、initDatabase 也未为 cats 建 _openid 索引。
    const res = await db.collection(COLLECTIONS.CATS).add({
      data: {
        ...sanitizedData,
        // 列表排序值：与 updateTime 同一时刻（Date.now() 是云函数运行时钟，
        // 与 serverDate 的偏差在毫秒级，排序只关心先后，无影响）。
        // 不能用 db.serverDate()：它是写库占位符，读不回真实时间，无法参与数值运算。
        listSort: computeListSort(sanitizedData.status, Date.now()),
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    });

    // 异步内容检测（mediaCheckAsync）：补绑 catId，回调据此给违规头像打标记
    await bindMediaCheckRef(imgCheck.traceId, res._id);

    await logOperation(db, OPENID, {
      module: 'cat', action: 'create',
      description: `添加猫咪: ${sanitizedData.name}`,
      result: 'success',
      afterData: { name: sanitizedData.name, campus: sanitizedData.campus, status: sanitizedData.status }
    });

    // 「新猫登场提醒」订阅推送（非致命：失败不影响添加结果）
    await notifyNewCatSubscribers(res._id, sanitizedData.name);

    return ok({ id: res._id }, '添加成功');
  } catch (err) {
    console.error('[addCat] 添加失败:', err);
    return fail('添加失败，请重试');
  }
};
