/**
 * mediaCheckCallback - 接收微信「多媒体内容安全」异步检测结果（wxa_media_check）
 *
 * 为什么有它：旧版同步接口 `imgSecCheck` 配额紧张（限流 45009）且官方文档已只保留
 * `msgSecCheck`（文本）与 `mediaCheckAsync`（多媒体·异步）。提交侧见
 * `utils/contentSecurity.js` 的 `checkImageAsync`：拿到 `trace_id` 后落一条
 * `mediaChecks` 待检记录，本函数按 `trace_id` 反查该记录并落地处置。
 *
 * 触发方式（两者都支持，字段解析统一走 parseEvent）：
 *   1) 公众平台「开发设置 → 消息推送」把 `wxa_media_check` 事件订阅到本云函数
 *      （云开发 pushMode=cloudfunction，微信直接投 JSON，无需自建 HTTP 端点）；
 *   2) HTTP 触发器（事件体在 event.body 的 JSON 里）。
 *
 * 鉴权与防伪造（本函数没有 OPENID 上下文，因此必须自证）：
 *   - **不信任事件里的任何业务字段**：处置对象的 fileID / target / refId 一律从
 *     `mediaChecks` 记录读 —— 只有 `checkImageAsync` 会写这张表。
 *   - `trace_id` 必须命中一条 `status === 'pending'` 的记录，否则直接忽略：
 *     既挡住客户端伪造调用（trace_id 不可猜），也让重复投递天然幂等
 *     （同一 trace_id 只有第一次能命中 pending）。
 *   - 标签只接受白名单值，未知取值按 `review`（保守）处理。
 *
 * 处置策略（标记 + 留痕，**不自动删数据**）：
 *   pass   → 标记 passed
 *   review → 标记 review + 给处置对象打 `_mediaReview` 标记 + 写操作日志
 *   risky  → 标记 risky + 给处置对象打 `_mediaBlocked` 标记 + 写操作日志
 *   真正的下架/删除由管理员在管理端人工执行：这个内容库需要留证，
 *   且微信的判定偶尔误伤，自动删档不可逆。管理员在「操作日志」页能看到这些条目。
 *
 * 幂等：同一 trace_id 重复投递时，第二次因已不是 pending 而直接忽略。
 */
const cloud = require('wx-server-sdk');
const { logOperation } = require('./common/operationLogger');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 只接受这三种结论；其余一律按 review 处理（宁可多叫人看一眼）
const SUGGESTIONS = ['pass', 'review', 'risky'];

/** 业务对象 → 集合映射（处置对象只在白名单内，杜绝任意集合写入） */
const TARGET_COLLECTIONS = {
  photo: COLLECTIONS.PHOTOS,
  avatar: COLLECTIONS.CATS
};

/** 读取猫当前头像；目标已删除 / 读取失败时返回空串（不阻断回调落库） */
async function readCurrentAvatar(collection, refId) {
  try {
    const res = await db.collection(collection).doc(refId).get();
    return res && res.data && res.data.avatar || '';
  } catch (err) {
    return '';
  }
}

/**
 * 给处置对象打标记；risky 头像额外清空当前头像。
 * 抽成独立函数是为了把 main 的复杂度留给事件解析与状态落库。
 * @returns {Promise<boolean>} 是否成功写到目标对象
 */
async function markTarget(record, decision, traceId) {
  const collection = TARGET_COLLECTIONS[record.target];
  if (!collection || !record.refId || !/^[A-Za-z0-9_-]{4,64}$/.test(record.refId)) {
    return false;
  }

  const flag = decision === 'risky' ? '_mediaBlocked' : '_mediaReview';
  try {
    const patch = {
      [flag]: true,
      mediaCheckTraceId: traceId,
      mediaCheckedAt: db.serverDate()
    };
    // risky 头像必须立即从公开页消失：只打标记的话，头像会继续在首页/详情页
    // 展示到管理员处理为止。只清「本次检测的那张」：管理员若已换新头像，不能误清。
    if (decision === 'risky' && record.target === 'avatar' && record.fileID) {
      const currentAvatar = await readCurrentAvatar(collection, record.refId);
      if (currentAvatar === record.fileID) patch.avatar = '';
    }
    await db.collection(collection).doc(record.refId).update({ data: patch });
    return true;
  } catch (err) {
    // 目标已删除等属正常情况，不影响判定落库
    console.warn('[mediaCheckCallback] 打标记失败:', err.message || err);
    return false;
  }
}

exports.main = async (event) => {
  const parsed = parseEvent(event);
  const { traceId, suggest, label } = parsed;

  if (!traceId) {
    console.warn('[mediaCheckCallback] 事件缺少 trace_id，忽略');
    return fail('缺少 trace_id');
  }

  try {
    // 只认 pending：既幂等，也挡住伪造/重复投递
    const found = await db.collection(COLLECTIONS.MEDIA_CHECKS)
      .where({ traceId, status: 'pending' })
      .limit(1)
      .get();
    const record = found.data && found.data[0];
    if (!record) {
      console.warn(`[mediaCheckCallback] trace_id 无待检记录（伪造或重复投递），忽略: ${traceId}`);
      return ok({ skipped: true, reason: '无待检记录' }, '已忽略');
    }

    const decision = SUGGESTIONS.includes(suggest) ? suggest : 'review';

    await db.collection(COLLECTIONS.MEDIA_CHECKS).doc(record._id).update({
      data: {
        status: decision,
        label,
        decidedAt: db.serverDate(),
        updateTime: db.serverDate()
      }
    });

    // 通过 / 不需人工介入：不惊动任何人
    if (decision === 'pass') {
      return ok({ traceId, decision }, '通过');
    }

    // 给处置对象打标记（仅白名单集合；refId 缺失则只留日志不写对象）
    const marked = await markTarget(record, decision, traceId);

    // 留痕：管理员在「操作日志」页可见（模块名 mediaCheck，便于检索）
    await logOperation(db, '', {
      module: 'mediaCheck',
      action: decision,
      description: `多媒体检测${decision === 'risky' ? '命中违规' : '需人工复核'}：${record.target || '未知对象'} ${record.refId || ''}`.trim(),
      result: decision === 'risky' ? 'fail' : 'success',
      afterData: {
        traceId,
        label,
        target: record.target || '',
        refId: record.refId || '',
        marked
      }
    });

    return ok({ traceId, decision, marked }, decision === 'risky' ? '命中违规' : '需复核');
  } catch (err) {
    console.error('[mediaCheckCallback] 处理失败:', err);
    return fail('回调处理失败');
  }
};

/**
 * 解析回调事件：兼容「消息推送投递的 JSON」与「HTTP 触发器的 event.body JSON」，
 * 并对 trace_id / suggest / label 的字段大小写与嵌套形态做容错。
 * @private
 */
function parseEvent(event) {
  let src = event || {};

  if (typeof src.body === 'string') {
    try {
      src = { ...src, ...JSON.parse(src.body) };
    } catch (e) {
      console.warn('[mediaCheckCallback] event.body 不是 JSON，按原样解析');
    }
  }

  const traceId = src.trace_id || src.traceId || src.TraceId || src.TraceID || '';

  // result 可能是对象，也可能是被序列化成字符串的 JSON
  let result = src.result || src.Result || {};
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch (e) {
      result = {};
    }
  }

  const suggest = String(
    result && (result.suggest || result.suggestion) || src.suggest || ''
  ).toLowerCase();

  const label = Number(result && result.label || src.label || 0) || 0;

  return { traceId: String(traceId), suggest, label };
}