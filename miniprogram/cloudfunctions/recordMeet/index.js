// cloudfunctions/recordMeet/index.js - 记录用户相遇打卡（内容清洗）
const cloud = require('wx-server-sdk');
const { acquireMeetLock, releaseMeetLock } = require('./utils/meetLock');
const sanitizer = require('./utils/sanitizer');
const { checkText } = require('./utils/contentSecurity');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const { beijingTodayStart } = require('./utils/beijingTime');
const subscribeQuota = require('./utils/subscribeQuota');
const { STATUS_NOTIFICATIONS, notifyCatStatusChange } = require('./utils/statusNotify');
// 列表排序值（首页/搜索顺序）：自动找回（lost → normal）与 updateTime 同步重算，见 utils/listSort.js
const { computeListSort } = require('./utils/listSort');
// 校园地图归一化坐标：校验客户端选的点 + 条件式刷新 cats.lastMeetPoint，见 utils/mapPoint.js
const { sanitizePoint, buildStatsUpdate } = require('./utils/mapPoint');
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

async function notifyCatFollowers(catId, catName, catAvatar, visitorOpenid, location, statusTag) {
  const safeCatName = sanitizer.strict(catName || '猫咪', 50);
  const safeLocation = sanitizer.strict(location || '', 100);
  const safeStatusTag = sanitizer.strict(statusTag || '', 50);

  // 分页拉全量关注者（原 limit(50) 会静默漏推第 51 位之后的同学）
  const followerRows = [];
  let lastFavId = '';
  for (let batch = 0; batch < 10; batch++) {
    const where = { catId: catId, _openid: _.neq(visitorOpenid) };
    if (lastFavId) where._id = _.gt(lastFavId);
    const res = await db.collection(COLLECTIONS.USER_FAVORITES)
      .where(where)
      .orderBy('_id', 'asc')
      .field({ _openid: true })
      .limit(100)
      .get();
    const rows = res.data || [];
    followerRows.push(...rows);
    if (rows.length < 100) break;
    lastFavId = rows[rows.length - 1]._id;
  }

  if (followerRows.length === 0) return;

  const seen = new Set();
  const uniqueFollowers = followerRows.filter(f => {
    if (seen.has(f._openid)) return false;
    seen.add(f._openid);
    return true;
  });

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  let recentlyNotified = new Set();
  try {
    const recentRes = await db.collection(COLLECTIONS.NOTIFICATIONS)
      .where({
        catId: catId,
        type: 'cat_meet',
        createTime: _.gte(tenMinAgo)
      })
      .field({ _openid: true })
      .limit(100)
      .get();
    recentlyNotified = new Set((recentRes.data || []).map(n => n._openid));
  } catch (e) {
    console.warn('[recordMeet] 查询近期通知失败，跳过去重:', e.message);
  }

  const toNotify = uniqueFollowers.filter(f => !recentlyNotified.has(f._openid));
  if (toNotify.length === 0) return;

  const notifications = toNotify.map(follower => ({
    _openid: follower._openid,
    type: 'cat_meet',
    catId: catId,
    catName: safeCatName,
    catAvatar: catAvatar || '',
    visitorOpenid: visitorOpenid,
    location: safeLocation,
    statusTag: safeStatusTag,
    content: `你关注的「${safeCatName}」在${safeLocation}相遇啦！${safeStatusTag}`,
    isRead: false,
    createTime: db.serverDate(),
    expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }));

  const BATCH_SIZE = 20;
  for (let i = 0; i < notifications.length; i += BATCH_SIZE) {
    const batch = notifications.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(notif =>
      db.collection(COLLECTIONS.NOTIFICATIONS).add({ data: notif }).catch(() => null)
    ));
  }

  // 订阅消息推送（微信一次性订阅）：目标 = 「关注者（排除打卡者自己）∩ 推送次数账本」，
  // 过渡期兼容历史记录（配额优先、旧记录兜底消费，见 utils/subscribeQuota.js）。
  // 发送成功 -1；43101（授权已耗尽/拒收）清零校正，不再盲发无额度请求。
  // 模板 ID：默认用下方真实 ID（与前端 config.js 一致，模板 ID 不敏感）；
  // 如需更换模板，可配云函数环境变量 SUBSCRIBE_MEET_TEMPLATE_ID 覆盖。
  // （查询键 'meet_notify' 是订阅记录的集合内历史标识，作兼容查询保留）
  const MEET_SEND_TEMPLATE_ID = process.env.SUBSCRIBE_MEET_TEMPLATE_ID || '';

  try {
    // 历史记录兜底（查询键兼容历史字面量 'meet_notify' 与真实模板 ID；排除打卡者）
    const legacyByOpenid = await subscribeQuota.fetchLegacyByOpenid(db, {
      catId,
      _openid: _.neq(visitorOpenid),
      templateId: _.in(['meet_notify', MEET_SEND_TEMPLATE_ID]),
      status: _.neq('reject')
    });

    const audience = [...new Set([
      ...uniqueFollowers.map(f => f._openid),
      ...legacyByOpenid.keys()
    ])].filter(Boolean);

    const quotaMap = await subscribeQuota.fetchQuotaMap(db, MEET_SEND_TEMPLATE_ID, audience);

    // 模板「打卡完成通知」勾选字段：备注(thing2)/打卡时间(time5)/打卡地点(thing6)
    // 备注合并「猫名·状态」，thing 类型限 20 字符，超长截断兜底
    const summary = `${safeCatName}·${safeStatusTag || '新相遇'}`.slice(0, 20);
    await subscribeQuota.dispatchWithQuota({
      db,
      templateId: MEET_SEND_TEMPLATE_ID,
      quotaMap,
      legacyByOpenid,
      logTag: '[recordMeet] ',
      sendFn: (openid) => cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: MEET_SEND_TEMPLATE_ID,
        page: `pages/detail/detail?id=${catId}`,
        data: {
          thing2: { value: summary },
          time5: { value: formatSubscribeTime() },
          thing6: { value: safeLocation || '校园内' }
        },
        miniprogramState: 'formal'
      })
    });
  } catch (subErr) {
    console.warn('[recordMeet] 订阅消息推送失败（非致命）:', subErr.message);
  }
}

/**
 * 拉取猫咪的简要信息（失败不致命，返回空值占位）
 * status 一并取出：打卡成功后据此判断是否需要「自动找回」（见 recoverLostCat）
 * @returns {Promise<{name: string, avatar: string, status: string}>}
 */
async function fetchCatBrief(catId) {
  try {
    const catRes = await db.collection(COLLECTIONS.CATS).doc(catId).get();
    return {
      name: catRes.data?.name || '',
      avatar: catRes.data?.avatar || '',
      status: catRes.data?.status || '',
      // campus 用于地图坐标的校区归属：必须服务端取，客户端传的一律不信
      campus: catRes.data?.campus || ''
    };
  } catch (catErr) {
    console.warn('[recordMeet] 查询猫咪信息失败，使用空值:', catErr.message);
    return { name: '', avatar: '', status: '', campus: '' };
  }
}



/** 开启事务；事务不可用时返回 null（降级为非事务模式） */
async function startTransactionOrNull() {
  try {
    return await db.startTransaction();
  } catch (txErr) {
    console.warn('[recordMeet] 事务不可用，降级为非事务模式:', txErr.message);
    return null;
  }
}

// 「事务可能已提交」的哨兵错误码：见 writeMeetInTransaction 注释（BE-1）。
// 调用方只对**不带**该码的错误降级重写 —— 这是重复打卡与计数正确性的分界线。
const TX_MAY_HAVE_COMMITTED = 'TX_MAY_HAVE_COMMITTED';

/**
 * 冷却窗口内是否已有同用户对同猫咪的打卡
 *
 * 【只能传 db，不能传事务对象】微信官方文档对 Transaction.collection 的注意事项
 * 明确写着「在事务中仅能进行单记录操作，不能使用 where、aggregate」。
 * 原实现把本函数以 transaction 调用，事务可用时 `.where().count()` 必抛，
 * 错误一路冒泡到 main 的 catch 被吞成通用「打卡失败，请稍后重试」——
 * 用户看到通用文案、日志无定位信息；且当时异常路径既不 commit 也不 rollback，
 * 事务会悬挂到超时。故查询已移到事务外（见 main 中的调用点）。
 * @param {Object} db - 云数据库实例
 * @returns {Promise<boolean>} true 表示 1 小时内已打卡
 */
async function hasRecentMeet(dbInstance, catId, openid, since) {
  const res = await dbInstance.collection(COLLECTIONS.RECORD_MEET)
    .where({ catId, _openid: openid, meetTime: _.gte(since) })
    .count();
  return res.total > 0;
}

/**
 * 递增 meetCount 并刷新 lastMeetTime，失败时退避重试；重试耗尽则写对账日志等待后续修复
 *
 * lastMeetTime（毫秒时间戳，与 recordMeet.meetTime 同源）是「久未相遇 → 自动走失」
 * 判定的基准：sweepLostCats 每天读它，猫档案里没有该字段时才退回建档时间。
 * 它与 meetCount 必须同时写：只写计数会让扫描把「刚被遇到过」的猫当成久未相遇。
 */
async function bumpMeetStats(catId, recordData, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await db.collection(COLLECTIONS.CATS).doc(catId).update({
        data: buildStatsUpdate(recordData, _.inc)
      });
      return;
    } catch (updateErr) {
      if (i === maxRetries - 1) {
        console.error(`[recordMeet] meetCount 更新失败（已重试${maxRetries}次）:`, updateErr.message);
        db.collection(COLLECTIONS.REPAIR_LOGS).add({
          data: {
            type: 'meetCount_mismatch',
            catId,
            timestamp: Date.now(),
            error: updateErr.message
          }
        }).catch(() => {});
        return;
      }
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

/**
 * 事务写入打卡记录、递增计数并刷新「最后一次相遇时间」。
 *
 * 事务内**只用单记录接口**（add / doc.update）：where 在事务内不可用，
 * 冷却去重已由调用方在事务外做完（见 hasRecentMeet 注释）。
 * 任一步失败都显式 rollback —— 否则事务悬挂到超时，期间相关记录锁不释放。
 *
 * 【2026-10-11 修正 BE-1】失败时区分两类，抛出的错误类型即「可否降级」的信号：
 *   1. rollback **成功** → 事务确定未提交，调用方可以安全降级为非事务写入；
 *   2. rollback **失败**（典型：`commit()` 实际已成功、只是响应丢失）→ 事务
 *      **可能已提交**，此时若降级重写会造成重复打卡 + meetCount 双计。
 *      这类错误统一带 TX_MAY_HAVE_COMMITTED 标记，由调用方识别并**直接外抛**。
 * 原实现两种情况抛的是同一个原始错误，调用方 catch 无法分辨，
 * 于是「可能已提交」也被降级重写 —— SECURITY.md §八 声明的收紧策略实际未落地。
 *
 * @throws {Error} 带 `code === TX_MAY_HAVE_COMMITTED` 时禁止降级重写
 * @returns {Promise<void>}
 */
async function writeMeetInTransaction(transaction, catId, recordData) {
  try {
    await transaction.collection(COLLECTIONS.RECORD_MEET).add({ data: recordData });
    await transaction.collection(COLLECTIONS.CATS).doc(catId).update({
      data: buildStatsUpdate(recordData, _.inc)
    });
    await transaction.commit();
  } catch (err) {
    // rollback 自身失败（例如 commit 已成功只是响应丢失）时不能再重试写入：
    // 那会造成重复打卡。这里换成一个带标记的错误，让调用方据此拒绝降级。
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('[recordMeet] 事务回滚失败（可能已提交，勿重试写入）:', rollbackErr && rollbackErr.message);
      const marked = new Error('事务回滚失败，事务可能已提交，禁止降级重写');
      marked.code = TX_MAY_HAVE_COMMITTED;
      marked.cause = err;
      throw marked;
    }
    throw err;
  }
}

/**
 * 非事务降级写入（startTransaction 失败时）。
 * 冷却去重同样已由调用方在事务外做完。
 */
async function writeMeetWithoutTransaction(catId, recordData) {
  await db.collection(COLLECTIONS.RECORD_MEET).add({ data: recordData });
  await bumpMeetStats(catId, recordData);
}

/**
 * 走失猫被再次遇到 → 自动去掉走失标签并发「找回通知」。
 *
 * 为什么用 `where({_id, status:'lost'}).update()` 而不是 doc().update()：
 * 复位必须**有条件的原子写**，否则两个并发打卡都会看到「走失」并各自发一轮
 * 找回通知；以 `stats.updated > 0` 作为「本轮由我复位」的凭据，只有一方会通知。
 *
 * 复位是单向的（lost → normal）：不碰 deceased / adopted / normal，
 * 也不改写管理员手动标记的走失（对「有人见到」这条硬证据一视同仁）。
 *
 * @param {string} catStatus - 打卡前读到的状态；非 'lost' 时直接跳过，省一次写库
 * @returns {Promise<{recovered: boolean}>}
 */
async function recoverLostCat(catId, catName, catAvatar, catStatus, visitorOpenid) {
  if (catStatus !== 'lost') return { recovered: false };

  const updateRes = await db.collection(COLLECTIONS.CATS)
    .where({ _id: catId, status: 'lost' })
    .update({
      data: {
        status: 'normal',
        // 与 updateTime 同步重算列表排序值（本写的前提是 lost → normal，档位取 normal）
        listSort: computeListSort('normal', Date.now()),
        updateTime: db.serverDate()
      }
    });

  const updated = updateRes && updateRes.stats && updateRes.stats.updated || 0;
  if (updated === 0) return { recovered: false };

  console.log(`[recordMeet] 《${catName || catId}》被再次遇到，已自动复位为正常并发送找回通知`);

  await notifyCatStatusChange({
    db, cloud, catId, catName, catAvatar,
    event: STATUS_NOTIFICATIONS.normal,
    // 打卡者本人已在「被相遇」通知里收到消息，不再重复收到找回通知
    excludeOpenid: visitorOpenid,
    logTag: '[recordMeet] '
  });

  return { recovered: true };
}

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext() || {};
  if (!OPENID) return fail('请先登录后再记录相遇', 'UNAUTHORIZED');
  const { catId, location, statusTag, note } = event;

  if (!catId) {
    return fail('缺少猫咪信息');
  }

  if (!sanitizer.isValidObjectId(catId)) {
    return fail('无效的猫咪ID格式');
  }

  // location/statusTag/note 可能不是字符串（客户端传数字、对象、数组）。
  // 原先直接 .trim() 且这三行在 try 块之外，传非字符串会抛 TypeError 并成为
  // 未处理的 Promise rejection —— 云端兜底返回的错误包会把原始异常与调用栈带给客户端。
  // 这里先统一钳成字符串，与 recordView / deleteData 的 typeof 硬校验同口径。
  const safeStr = (v, dflt) => typeof v === 'string' ? v : v === null || v === undefined ? dflt : String(v);

  const finalLocation = sanitizer.sanitizeWithEmoji(safeStr(location, '校园内').trim(), 100) || '校园内';
  const finalStatusTag = sanitizer.sanitizeWithEmoji(safeStr(statusTag, '相遇了').trim(), 50) || '相遇了';
  const finalNote = sanitizer.sanitizeWithEmoji(safeStr(note, '').trim(), 500);

  // location/statusTag 会广播给关注者并经订阅消息推送，属用户 UGC，与 note 同口径做 msgSecCheck（失败关闭）
  for (const [field, value] of [['location', finalLocation], ['statusTag', finalStatusTag], ['note', finalNote]]) {
    if (!value) continue;
    const textCheck = await checkText(value, { scene: 2, openid: OPENID });
    if (!textCheck.ok) {
      console.warn(`[recordMeet] 字段 ${field} 内容安全检测未通过`);
      return fail('填写内容可能包含不当词语，请修改后再试');
    }
  }

  try {
    const { name: catName, avatar: catAvatar, status: catStatus, campus: catCampus } = await fetchCatBrief(catId);
    const recordData = {
      _openid: OPENID,
      catId,
      catName,
      catAvatar,
      campus: finalLocation,
      location: finalLocation,
      statusTag: finalStatusTag,
      note: finalNote,
      meetTime: Date.now(),
      createTime: db.serverDate()
    };

    // 地图坐标：可选。没选点 / 坐标非法都不报错，只是这条记录不带 point，
    // 猫在地图上保留上一次的位置。校区取猫档案的 campus，不信客户端。
    const point = sanitizePoint(event.point, catCampus);
    if (point) recordData.point = point;

    // 查询必须在事务外，但 check-then-write 需要跨云函数实例串行化。
    // system_state 中以猫咪/用户哈希为 _id 的短租约覆盖冷却查询和记录写入，
    // 因此事务不可用时的兼容降级也不会绕过冷却检查。
    const meetLock = await acquireMeetLock(db, catId, OPENID);
    if (!meetLock.acquired) {
      return fail('打卡请求正在处理中，请稍后重试', 'IN_PROGRESS');
    }

    try {
      const oneHourAgo = Date.now() - 3600 * 1000;
      if (await hasRecentMeet(db, catId, OPENID, oneHourAgo)) {
        return fail('1小时内已打卡过这只猫~', 'COOLDOWN');
      }

      const transaction = await startTransactionOrNull();
      if (transaction) {
        try {
          await writeMeetInTransaction(transaction, catId, recordData);
        } catch (txErr) {
          // 「事务可能已提交」（rollback 失败）→ **绝不降级重写**。
          if (txErr && txErr.code === TX_MAY_HAVE_COMMITTED) {
            console.error('[recordMeet] 事务可能已提交，本次不降级重写:', txErr.cause && txErr.cause.message);
            return fail('打卡结果未确认，请稍后到「我的相遇」核对；若确未记录可重试');
          }
          // 回滚已确认事务未提交，才允许兼容性降级；租约仍覆盖整个降级写。
          console.warn('[recordMeet] 事务写入失败，降级为非事务模式:', txErr.message);
          await writeMeetWithoutTransaction(catId, recordData);
        }
      } else {
        await writeMeetWithoutTransaction(catId, recordData);
      }
    } finally {
      try {
        await releaseMeetLock(db, meetLock);
      } catch (releaseErr) {
        // 租约到期后可被接管；不把清锁失败误报为打卡写入失败。
        console.warn('[recordMeet] 冷却锁释放失败，将在租约到期后自动恢复:', releaseErr.message);
      }
    }

    // 通知与今日计数并行执行；返回前限时等待通知落库——
    // 云函数返回后实例可能被冻结，fire-and-forget 的后台任务不保证执行完
    const notifyPromise = notifyCatFollowers(catId, catName, catAvatar, OPENID, finalLocation, finalStatusTag)
      .catch(notifyErr => {
        console.warn('[recordMeet] 通知发送失败（非致命）:', notifyErr.message);
      });

    // 走失猫被再次遇到 → 自动去掉走失标签并发「找回通知」
    // （放在打卡成功之后：打卡记录是唯一事实依据，状态复位只是它的推论）
    const recoverPromise = recoverLostCat(catId, catName, catAvatar, catStatus, OPENID)
      .catch(recoverErr => {
        console.warn('[recordMeet] 自动找回失败（非致命）:', recoverErr.message);
      });

    // 今日计数按北京时间 0 点起算（容器是 UTC，本地午夜口径会漏掉当天 0-8 点的记录）
    const todayCountRes = await db.collection(COLLECTIONS.RECORD_MEET)
      .where({
        catId,
        meetTime: _.gte(beijingTodayStart())
      })
      .count();

    // 打卡结果已就绪；最多再等 3 秒让通知完成，避免极端情况拖慢打卡响应
    await Promise.race([
      Promise.all([notifyPromise, recoverPromise]),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    return ok({
      todayCount: todayCountRes.total
    }, `记录成功！在${finalLocation}遇到TA，你是今天第 ${todayCountRes.total} 个守护它的同学`);
  } catch (err) {
    console.error('recordMeet 失败:', err);
    return fail('打卡失败，请稍后重试');
  }
};
