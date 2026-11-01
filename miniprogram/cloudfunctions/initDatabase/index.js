// cloudfunctions/initDatabase/index.js
// 数据库集合初始化脚本
//
// 使用方法：
// 1. 在微信开发者工具中右键此文件夹 → "上传并部署"
// 2. 在前端调用 wx.cloud.callFunction({ name: 'initDatabase' })
//
// 此函数仅用于开发/首次部署，生产环境请手动在控制台创建集合

const cloud = require('wx-server-sdk');
const { checkAdmin } = require('./utils/auth');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 需要创建的数据库集合列表
const COLLECTIONS_TO_CREATE = [
  {
    name: COLLECTIONS.CATS,
    description: '猫咪信息表',
    indexes: [
      { name: 'updateTime_index', key: { updateTime: -1 } },
      { name: 'campus_index', key: { campus: 1 } },
      // filterCats 固定按 status 过滤 + updateTime 倒序，复合索引避免全表扫描后内存排序
      { name: 'status_updateTime_composite', key: { status: 1, updateTime: -1 } },
      // 校区筛选与首页列表同用时走该复合索引
      { name: 'campus_updateTime_composite', key: { campus: 1, updateTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.PHOTOS,
    description: '猫咪照片表',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: 'createTime_index', key: { createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.PHOTO_LIKES,
    description: '照片点赞关系表',
    indexes: [
      // togglePhotoLike 的事务外查重无法防止并发重复；唯一索引是最终一致性边界。
      { name: 'photoId_openid_unique', key: { photoId: 1, _openid: 1 }, unique: true }
    ]
  },
  {
    name: COLLECTIONS.ALBUMS,
    description: '相册表'
  },
  {
    name: COLLECTIONS.ADMINS,
    description: '管理员表',
    indexes: [
      // 唯一索引必须建在 openid 上：服务端鉴权（utils/auth.js checkAdmin）与
      // adminLogin 绑定写的都是 openid，建在历史字段 _openid 上等于
      // 「真正参与身份判定的字段没有任何唯一约束」—— 两条文档可以绑同一个 openid，
      // checkAdmin 的 .where({openid}).limit(1) 命中不确定的一条 → 角色判定漂移。
      // _openid 降级为非唯一兼容索引，保留给仍写旧字段的存量代码。
      { name: 'openid_index', key: { openid: 1 }, unique: true },
      { name: '_openid_index', key: { _openid: 1 }, unique: false }
    ]
  },
  {
    name: COLLECTIONS.NOTICES,
    description: '公告通知表',
    indexes: [
      // getNotices 按 status 过滤 + createTime 倒序，数据量增长后需复合索引
      { name: 'status_createTime_composite', key: { status: 1, createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.RECORD_MEET,
    description: '相遇打卡记录表',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: '_openid_index', key: { _openid: 1 } },
      { name: 'createTime_index', key: { createTime: -1 } },
      { name: 'meetTime_index', key: { meetTime: -1 } },
      { name: 'catId_createTime_composite', key: { catId: 1, createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.LOGIN_ATTEMPTS,
    description: '登录尝试记录表',
    indexes: [
      { name: '_openid_index', key: { _openid: 1 } },
      { name: 'createTime_index', key: { createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.HEALTH_RECORDS,
    description: '健康记录表',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: 'createTime_index', key: { createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.USER_FAVORITES,
    description: '用户关注/收藏关系表（统一集合，替代旧 favorites）',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: '_openid_index', key: { _openid: 1 } }
    ]
  },
  {
    name: COLLECTIONS.NOTIFICATIONS,
    description: '系统通知消息表',
    indexes: [
      { name: '_openid_index', key: { _openid: 1 } },
      { name: 'isRead_index', key: { isRead: 1 } },
      { name: 'createTime_index', key: { createTime: -1 } },
      // TTL 索引：请在云开发控制台手动为 expireAt 字段创建 TTL 索引（30天过期）
      // 否则 notifications 集合会持续增长。创建方法：
      // 云开发 → 数据库 → notifications → 索引 → 添加 → 字段 expireAt, TTL 类型, 过期时间 2592000秒
    ]
  },
  {
    name: COLLECTIONS.CAT_RELATIONS,
    description: '猫咪关系表',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: 'relatedCatId_index', key: { relatedCatId: 1 } }
    ]
  },
  {
    name: COLLECTIONS.USER_SUBSCRIPTIONS,
    description: '用户订阅表（微信模板消息推送）',
    indexes: [
      { name: 'catId_index', key: { catId: 1 } },
      { name: '_openid_index', key: { _openid: 1 } }
    ]
  },
  {
    name: COLLECTIONS.SUBSCRIBE_QUOTA,
    description: '订阅消息推送次数账本（授权 +1 / 发送 -1，上限 200）',
    indexes: [
      { name: '_openid_index', key: { _openid: 1 } },
      { name: 'templateId_index', key: { templateId: 1 } }
    ]
  },
  {
    name: COLLECTIONS.MEDIA_CHECKS,
    description: '多媒体内容安全异步检测待检记录（提交方写入 trace_id，回调按它反查处置对象）',
    indexes: [
      { name: 'traceId_index', key: { traceId: 1 } },
      { name: '_openid_index', key: { _openid: 1 } },
      // 管理端「内容复核」队列：status in [review, risky] + orderBy updateTime desc
      { name: 'status_updateTime_index', key: { status: 1, updateTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.USER_REPORTS,
    description: '用户反馈（信息有误 / 受伤 / 疑似走失 / 其他）',
    indexes: [
      { name: '_openid_createTime_index', key: { _openid: 1, createTime: -1 } },
      { name: 'status_createTime_index', key: { status: 1, createTime: -1 } },
      { name: 'catId_createTime_index', key: { catId: 1, createTime: -1 } }
    ]
  },
  // ── 运营数据面板 ────────────────────────────────────────────────────
  // 几个集合只存匿名用户键（sha256(openid)）与入口 slug，不存原始 openid / 内容。
  // 创建后请在云开发控制台把权限设为「所有用户不可读写」：
  // 客户端从不直连这些集合，只有云函数（管理端鉴权后）能读。
  {
    name: COLLECTIONS.OPS_USERS,
    description: '运营面板：用户首见 / 最近活跃 / 活跃天数（匿名键）',
    indexes: [
      { name: 'firstSeenAt_index', key: { firstSeenAt: -1 } },
      { name: 'lastSeenAt_index', key: { lastSeenAt: -1 } }
    ]
  },
  {
    name: COLLECTIONS.OPS_DAYS,
    description: '运营面板：用户日活明细（_id = d_YYYY-MM-DD_userKey）',
    indexes: [
      { name: 'day_index', key: { day: 1 } }
    ]
  },
  {
    name: COLLECTIONS.OPS_ENTRY_USAGE,
    description: '运营面板：入口使用（_id = e_日期_匿名键，entries 数组存当天入口）',
    indexes: [
      { name: 'day_index', key: { day: 1 } }
    ]
  },
  {
    name: COLLECTIONS.OPERATION_LOGS,
    description: '操作日志表',
    indexes: [
      { name: 'createTime_index', key: { createTime: -1 } }
    ]
  },
  {
    name: COLLECTIONS.REPAIR_LOGS,
    description: '修复/对账日志表（内部使用）',
    indexes: [
      { name: 'timestamp_index', key: { timestamp: -1 } }
    ]
  },
  {
    // 定时任务节流状态（backupData / reconcileMeetCount 的 timer 节流记录）。
    // 缺失时两处定时器为 fail-open（照常执行、不写节流），创建后节流生效。
    name: 'system_state',
    description: '系统状态/定时任务节流表'
  }
];

function logIndexRecommendations(collection) {
  if (!collection.indexes || collection.indexes.length === 0) return;

  for (const index of collection.indexes) {
    const keys = Object.entries(index.key)
      .map(([field, direction]) => `${field}:${direction}`)
      .join(', ');
    const uniqueLabel = index.unique ? '唯一' : '普通';
    console.log(`[initDatabase] → 索引配置核对: ${collection.name} 建议项 ${index.name} (${keys}; ${uniqueLabel})，请先确认控制台现状再创建`);
  }
}

exports.main = async (event, _context) => {
  const { OPENID } = cloud.getWXContext();
  const db = cloud.database();
  const adminAccount = event._adminAccount || '';

  const authResult = await checkAdmin(db, OPENID, { operation: '数据库初始化', adminAccount, useCache: false });
  if (!authResult.isAdmin) {
    console.warn('[initDatabase] 非管理员尝试初始化:', OPENID.substring(0, 6) + '****');
    return fail('无权限执行数据库初始化');
  }

  const results = [];

  console.log('[initDatabase] 开始初始化数据库集合...');

  for (const collection of COLLECTIONS_TO_CREATE) {
    try {
      // 尝试查询集合（检查是否存在）
      await db.collection(collection.name).count();

      // 如果能查询到说明已存在
      results.push({
        name: collection.name,
        status: 'exists',
        message: `集合 ${collection.name} 已存在`
      });
      console.log(`[initDatabase] ✓ ${collection.name} 已存在`);
      logIndexRecommendations(collection);
    } catch (err) {
      if (err.errCode === -502005) {
        // 集合不存在：必须用 db.createCollection 创建。
        // 旧实现依赖「向不存在的集合 add 会自动建集合」——实测该行为在本环境不成立
        // （写入被拒、集合不出现），本函数因此长期报「部分集合创建失败」，
        // operation_logs / repair_logs 等集合从未建成：操作日志静默丢失、
        // 备份因读取缺失集合而整体失败（2026-10-07 定位修复）。
        try {
          await db.createCollection(collection.name);

          // 创建后补一条占位文档：控制台以「有文档」为可见前提；
          // 占位失败不影响集合已创建的事实，仅记录日志。
          try {
            await db.collection(collection.name).add({
              data: {
                _init: true,
                created_at: new Date(),
                note: '初始化占位文档，可删除'
              }
            });
          } catch (seedErr) {
            console.warn(`[initDatabase] ${collection.name} 占位文档写入失败（集合已创建，不影响使用）:`, seedErr.message);
          }

          // 云开发 SDK 不创建索引；在新建集合后提醒管理员手动配置。
          logIndexRecommendations(collection);

          results.push({
            name: collection.name,
            status: 'created',
            message: `集合 ${collection.name} 已创建`
          });
          console.log(`[initDatabase] ${collection.name} 已创建`);
        } catch (createErr) {
          results.push({
            name: collection.name,
            status: 'error',
            message: `创建失败: ${createErr.message}`
          });
          console.error(`[initDatabase] ${collection.name} 创建失败:`, createErr);
        }
      } else {
        results.push({
          name: collection.name,
          status: 'error',
          message: `检查失败: ${err.message}`
        });
        console.error(`[initDatabase] ${collection.name} 检查失败:`, err);
      }
    }
  }

  // 统计结果
  const successCount = results.filter(r => r.status === 'created').length;
  const existsCount = results.filter(r => r.status === 'exists').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  console.log(`[initDatabase] 初始化完成！成功:${successCount}, 已存在:${existsCount}, 失败:${errorCount}`);

  if (errorCount > 0) {
    // 失败时把出错的集合名与原因带进错误文案：旧实现只回一句「部分集合创建失败」，
    // 排障必须翻云函数日志（2026-10-07 排查缺失集合时被卡）。
    const errorDetail = results
      .filter(r => r.status === 'error')
      .map(r => `${r.name}(${r.message})`)
      .join('; ');
    return fail(`部分集合创建失败：${errorDetail}`);
  }

  return ok({
    summary: {
      total: COLLECTIONS_TO_CREATE.length,
      created: successCount,
      exists: existsCount,
      errors: errorCount
    },
    details: results
  }, `所有${COLLECTIONS_TO_CREATE.length}个集合初始化完成！`);
};
