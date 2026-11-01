/**
 * cloudfunctions/utils/statusNotify.js - 猫咪状态变更通知（canonical 源）
 *
 * 状态变更后的「关注者通知」两件套：站内 notifications + 微信一次性订阅推送。
 * 三个调用方共用同一份实现与同一张文案表：
 *   - updateCat       管理员改状态（走失/离世/领养/找回）
 *   - recordMeet      走失猫被再次遇到 → 自动找回
 *   - sweepLostCats   久未相遇（默认 60 天）→ 自动走失
 *
 * 本文件是 canonical 源，经 scripts/sync-utils.js 分发到上述云函数的 utils/ 副本
 * （云函数之间无共享运行时，不能跨函数 require）。改这里 = 改全部调用方。
 *
 * 为什么把 db / cloud 作为参数传进来：各云函数在自己的入口里 cloud.init() 并
 * 持有自己的 database 实例，共享模块不能各自再 init 一份（会与调用方的 mock 脱钩）。
 */
const { COLLECTIONS } = require('./constants');
const sanitizer = require('./sanitizer');
const subscribeQuota = require('./subscribeQuota');

/**
 * 状态变更通知配置表（canonical）。
 * template 里的 {name} 由本模块替换；title / tip 直接进订阅消息的模板字段，
 * thing 类型限 20 字符，改文案时注意长度。
 */
const STATUS_NOTIFICATIONS = {
  lost: { type: 'cat_lost', title: '走失提醒', tip: '请帮忙留意校园角落', template: '你关注的「{name}」走失了，请帮忙留意！' },
  deceased: { type: 'cat_deceased', title: '离世通知', tip: '愿它在喵星安好', template: '很遗憾，你关注的「{name}」已经离开了我们。' },
  normal: { type: 'cat_found', title: '找回通知', tip: '感谢大家的关注', template: '好消息！你关注的「{name}」已经找回了！' },
  adopted: { type: 'cat_adopted', title: '被领养通知', tip: '为它找到家而开心', template: '好消息！你关注的「{name}」找到新家啦！' }
};

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
 * 分页拉取猫咪关注者（排除指定 openid）。
 *
 * 不能用 limit(50) 一页了事：第 51 位之后的关注者会被静默漏推送。
 * 也不能用 skip 翻页的同时按 _id 游标——关注记录会被取消收藏删除，
 * skip 会让「已翻过的页」整体前移、漏掉记录；这里沿用 updateCat 原有的
 * limit(1000) + skip 口径（校园规模下单个猫咪的关注者远达不到该量级）。
 * @returns {Promise<Array<{_openid: string}>>}
 */
async function fetchFollowers(db, catId, excludeOpenid) {
  const _ = db.command;
  const buildWhere = () => {
    const where = { catId };
    if (excludeOpenid) where._openid = _.neq(excludeOpenid);
    return where;
  };

  const first = await db.collection(COLLECTIONS.USER_FAVORITES)
    .where(buildWhere())
    .field({ _openid: true })
    .limit(1000)
    .get();

  const allFollowers = first.data || [];
  if (allFollowers.length < 1000) return allFollowers;

  let skip = 1000;
  while (true) { // eslint-disable-line no-constant-condition
    const more = await db.collection(COLLECTIONS.USER_FAVORITES)
      .where(buildWhere())
      .field({ _openid: true })
      .skip(skip)
      .limit(1000)
      .get();
    if (!more.data || more.data.length === 0) break;
    allFollowers.push(...more.data);
    skip += more.data.length;
    if (more.data.length < 1000) break;
  }
  return allFollowers;
}

/**
 * 向猫咪关注者发送状态变更通知（站内通知 + 一次性订阅推送）。
 *
 * 失败一律不抛给调用方：状态已经写库、通知只是附带动作，绝不能因为推送失败
 * 把已成功的写操作回报成失败。调用方如需计数用于日志，读返回值即可。
 *
 * @param {Object} params
 * @param {Object} params.db - 调用方的云数据库实例
 * @param {Object} params.cloud - 调用方的 wx-server-sdk（用于 openapi 推送）
 * @param {string} params.catId
 * @param {string} params.catName
 * @param {string} params.catAvatar
 * @param {Object} params.event - { type, title, tip, template }，template 内的 {name} 会被替换
 * @param {boolean} [params.skipPush] - status 与 health 同时变更时，次要事件只写站内不推送
 *   （微信一次性订阅一条授权只能收一条消息，推最重要的那条）
 * @param {string} [params.excludeOpenid] - 不通知的操作者本人（如打卡触发自动找回时的打卡人）
 * @param {string} [params.logTag] - 日志前缀，便于区分调用方
 * @returns {Promise<{notified: number, pushed: number}>}
 */
async function notifyCatStatusChange({
  db, cloud, catId, catName, catAvatar, event, skipPush = false, excludeOpenid = '', logTag = '[statusNotify] '
}) {
  const config = event;
  if (!config) return { notified: 0, pushed: 0 };

  const safeName = sanitizer.strict(catName || '猫咪', 50);
  const content = config.template.replace('{name}', safeName);

  let allFollowers = [];
  try {
    allFollowers = await fetchFollowers(db, catId, excludeOpenid);
  } catch (err) {
    console.warn(`${logTag}关注者查询失败（非致命，本次不通知）:`, err && err.message);
    return { notified: 0, pushed: 0 };
  }

  // 注意：即使一条关注者都没有，也**不能**提前 return —— 历史 userSubscriptions 里
  // 可能存在「授权过推送、但已取消收藏」的用户，订阅推送那一段的受众是两个集合的并集
  // （与 updateCat 原有口径一致）。
  let notified = 0;
  if (allFollowers.length > 0) {
    const notifications = allFollowers.map(follower => ({
      _openid: follower._openid,
      type: config.type,
      catId,
      catName: safeName,
      catAvatar: catAvatar || '',
      content,
      isRead: false,
      createTime: db.serverDate(),
      // expireAt 必须与 recordMeet 同口径（30 天）：notifications.expireAt 上有
      // initDatabase 建的 30 天 TTL 索引，缺这个字段的通知**永不过期**，
      // 而猫的状态变更（走失/离世/领养）恰是最高频那类，集合会无限增长。
      expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }));

    try {
      const BATCH_SIZE = 50;
      for (let i = 0; i < notifications.length; i += BATCH_SIZE) {
        const batch = notifications.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(notif =>
          db.collection(COLLECTIONS.NOTIFICATIONS).add({ data: notif }).catch(err => {
            console.warn(`${logTag}通知写入失败:`, err && err.message);
            return null;
          })
        ));
      }
      notified = notifications.length;
      console.log(`${logTag}已发送${config.type}通知给${notified}位关注者`);
    } catch (err) {
      console.warn(`${logTag}发送状态变更通知失败（非致命）:`, err && err.message);
    }
  }

  if (skipPush) return { notified, pushed: 0 };

  // 订阅消息推送（微信一次性订阅）：目标 = 「关注者 ∩ 推送次数账本」，
  // 过渡期兼容历史 accept 记录（配额优先、旧记录兜底消费，见 utils/subscribeQuota.js）。
  // 发送成功 -1；43101（授权已耗尽/拒收）清零校正，不再盲发无额度请求。
  // 模板 ID：默认用下方真实 ID（与前端 config.js 一致，模板 ID 不敏感）；
  // 如需更换模板，可配云函数环境变量 SUBSCRIBE_STATUS_TEMPLATE_ID 覆盖。
  // （状态变更与健康变更共用「活动状态变更通知」模板）
  const STATUS_SEND_TEMPLATE_ID = process.env.SUBSCRIBE_STATUS_TEMPLATE_ID || '';

  let pushed = 0;
  try {
    const _ = db.command;
    // 历史记录兜底（旧口径查询键：集合内标识 'status_notify' / 真实模板 ID）
    const legacyByOpenid = await subscribeQuota.fetchLegacyByOpenid(db, {
      catId,
      templateId: _.in(['status_notify', STATUS_SEND_TEMPLATE_ID]),
      status: 'accept'
    });

    const audience = [...new Set([
      ...allFollowers.map(f => f._openid),
      ...legacyByOpenid.keys()
    ])].filter(Boolean);

    if (audience.length > 0) {
      const quotaMap = await subscribeQuota.fetchQuotaMap(db, STATUS_SEND_TEMPLATE_ID, audience);

      pushed = await subscribeQuota.dispatchWithQuota({
        db,
        templateId: STATUS_SEND_TEMPLATE_ID,
        quotaMap,
        legacyByOpenid,
        logTag,
        sendFn: (openid) => cloud.openapi.subscribeMessage.send({
          touser: openid,
          templateId: STATUS_SEND_TEMPLATE_ID,
          page: `pages/detail/detail?id=${catId}`,
          // 模板「活动状态变更通知」键名=类型前缀+公共模板原始定义位置序号
          // （原始定义：活动名称1/温馨提示2/变更原因3/变更时间4）
          data: {
            thing1: { value: safeName },
            thing2: { value: config.tip },
            thing3: { value: config.title },
            time4: { value: formatSubscribeTime() }
          },
          miniprogramState: 'formal'
        })
      });

      if (pushed > 0) {
        console.log(`${logTag}已向${pushed}位订阅者推送状态变更`);
      }
    }
  } catch (subErr) {
    console.warn(`${logTag}订阅消息推送失败（非致命）:`, subErr && subErr.message);
  }

  return { notified, pushed };
}

module.exports = {
  STATUS_NOTIFICATIONS,
  formatSubscribeTime,
  notifyCatStatusChange
};
