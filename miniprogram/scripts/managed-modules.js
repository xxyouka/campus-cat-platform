/**
 * scripts/managed-modules.js - 云函数公共模块的单一事实源清单
 *
 * scripts/build-cloud.js（复制 / 清理 / 校验）与 scripts/sync-utils.js（同步 / 只读校验）
 * 共同 require 本文件，保证两个脚本管理并校验的是**同一批模块**，
 * 不再出现「只被其中一个脚本校验」的模块（历史上 contentSecurity.js、
 * beijingTime.js、common/operationLogger.js 正是这种盲区）。
 *
 * 清单条目：
 *   source  相对 cloudfunctions/ 的规范源文件路径，同时也是各云函数下的相对目标路径
 *   targets 需要该模块的云函数目录名；null 表示全量分发（所有云函数）
 *
 * 新增公共模块时只需在此登记一次；verify() 还会反查各云函数 index.js 的
 * require('./utils/xxx')，用于发现「漏登记的模块」（见 build-cloud.js）。
 */
const fs = require('fs');
const path = require('path');

const CLOUD_FUNCTIONS_DIR = path.resolve(__dirname, '..', 'cloudfunctions');

// 不含 index.js 的目录（公共模块的规范源目录）不参与分发
const NON_FUNCTION_DIRS = ['utils', 'common'];

/**
 * 列出所有云函数目录名（含 index.js，按名称排序）。
 * 不要求 utils/ 已存在——`build-cloud clean` 会删掉空目录，
 * 此时仍应把它们算作云函数，否则校验会被「清理后就永远是绿的」骗过。
 */
function getCloudFunctionDirs() {
  return getCandidateFunctionDirs().filter((name) =>
    fs.existsSync(path.join(CLOUD_FUNCTIONS_DIR, name, 'index.js'))
  );
}

/**
 * 顶层候选云函数目录（**不要求**有 index.js），供门禁发现「目录还在、入口没了」。
 * 只用 getCloudFunctionDirs() 会留一个盲区：缺 index.js 的目录既不会进入
 * MANAGED_MODULES.targets，也不被 build-cloud.js / sync-utils.js 的遍历覆盖，
 * 于是目录里 divergent 的副本、甚至未登记的 ghost 模块都能让两个门禁返回 EXIT=0。
 */
function getCandidateFunctionDirs() {
  return fs
    .readdirSync(CLOUD_FUNCTIONS_DIR)
    .filter((name) => {
      if (NON_FUNCTION_DIRS.includes(name) || name.startsWith('.')) return false;
      return fs.statSync(path.join(CLOUD_FUNCTIONS_DIR, name)).isDirectory();
    })
    .sort();
}

/**
 * 候选目录中缺少 index.js 的那些（部署单元残缺）。
 * 合并冲突、入口改名/误删、或先建 utils/ 后补入口时都会出现，必须被门禁报出来。
 */
function findDirsMissingIndex() {
  return getCandidateFunctionDirs().filter(
    (name) => !fs.existsSync(path.join(CLOUD_FUNCTIONS_DIR, name, 'index.js'))
  );
}

// 原始清单：targets 为 null 表示全量分发
const RAW_MODULES = [
  // —— 全量分发：每个云函数都需要（与 sync-utils 的整目录分发口径一致）——
  { source: 'utils/audit.js', targets: null },
  { source: 'utils/auth.js', targets: null },
  { source: 'utils/cache.js', targets: null },
  { source: 'utils/cloud.js', targets: null },
  { source: 'utils/constants.js', targets: null },
  { source: 'utils/logger.js', targets: null },
  { source: 'utils/response.js', targets: null },
  { source: 'utils/sanitizer.js', targets: null },
  // —— 按需分发：只有真正 require 它们的云函数才需要 ——
  { source: 'utils/beijingTime.js', targets: ['getAdminStats', 'getCatActivity', 'getMeetCalendar', 'getOperationLogs', 'recordMeet', 'sweepLostCats', 'trackOps', 'getOpsDashboard'] },
  // 运营看板匿名身份（sha256(openid) / 日期前缀文档 ID）：trackOps 写、getOpsDashboard 读，
  // 两处算法必须一致。
  { source: 'utils/opsIdentity.js', targets: ['trackOps', 'getOpsDashboard'] },
  // catRelation 的 addRelation 会写入 note 并由无鉴权的 getByCatId 公开下发，
  // 因此也必须走 msgSecCheck（见 cloudfunctions/catRelation/index.js）。
  // 漏登记会导致部署后 MODULE_NOT_FOUND —— build-cloud.js verify 会拦下。
  { source: 'utils/contentSecurity.js', targets: ['addCat', 'addPhoto', 'catRelation', 'recordMeet', 'updateCat', 'submitReport'] },
  // addPhoto / addCat / updateCat 在「内容检测失败就删文件」之前用
  // isAllowedStorageFileUnder 把可删范围收窄到本业务目录（photos/、cats/），
  // 防止把任意已知 fileID 变成「可被服务端删除」的目标。
  { source: 'utils/filePathGuard.js', targets: ['addCat', 'addPhoto', 'compressImages', 'getCatAvatars', 'updateCat'] },
  // 推送次数账本（订阅消息额度）的发送侧消费：发送成功 -1、43101 清零校正。
  // 模板 ID 留空时各发送侧会跳过推送，账本仍保持可用。
  { source: 'utils/subscribeQuota.js', targets: ['updateCat', 'recordMeet', 'addCat', 'sweepLostCats'] },
  // 相遇打卡的猫咪/用户粒度 CAS 租约：覆盖事务外冷却查询和事务/降级写入，
  // 防止两个云函数实例同时通过一小时冷却检查。
  { source: 'utils/meetLock.js', targets: ['recordMeet'] },
  // 状态变更通知（站内 + 订阅推送）：updateCat（管理员改状态）、recordMeet（走失猫被
  // 再次遇到 → 自动找回）、sweepLostCats（久未相遇 → 自动走失）共用同一份实现与文案表。
  { source: 'utils/statusNotify.js', targets: ['recordMeet', 'sweepLostCats', 'updateCat'] },
  // 列表排序值（首页/搜索顺序：在校+走失 → 离世 → 领养垫底）：所有改写
  // cats.updateTime / cats.status 的写库路径都必须同步重算 listSort，
  // 漏登记/漏调用会导致排序漂移（详见模块头部的维护纪律）。
  { source: 'utils/listSort.js', targets: ['addCat', 'recordMeet', 'sweepLostCats', 'updateCat', 'migrateCatListSort'] },
  // 照片计数（按 catId 分组）：三处「有照片却显示 0 张」的共同根因是聚合的
  // 隐式 20 条上限 —— 显式 limit + 完整性校验 + 逐只 count 兜底必须共用同一份实现，
  // 否则任一处漏改就又回到静默给错数（详见模块头部说明）。
  { source: 'utils/photoCounts.js', targets: ['getAlbumsWithInfo', 'getCatPhotoCounts', 'exportData'] },
  // 校园地图归一化坐标：写侧（recordMeet 校验/规整客户端传来的点 + 条件式刷新
  // cats.lastMeetPoint）与读侧（getCampusMapCats 过滤脏坐标、getCatActivity 分析点位）
  // 共用同一份定义，否则「写时放行、读时崩溃」或反之。坐标合法性只有一处真值。
  { source: 'utils/mapPoint.js', targets: ['recordMeet', 'getCampusMapCats', 'getCatActivity'] },
  { source: 'common/operationLogger.js', targets: ['addCat', 'addPhoto', 'fixRecordOpenid', 'manageAdmin', 'manageNotice', 'mediaCheckCallback', 'mediaReview', 'migrateCatListSort', 'migrateMeetStatusTag', 'sweepLostCats', 'updateCat', 'manageReport'] },
  // 操作日志的人话摘要层：common/operationLogger.js 依赖它做 changes 清洗，
  // 因此分发范围必须与 operationLogger **完全一致**——
  // 少登记任何一个，部署后该函数的 logOperation 冷启动即 MODULE_NOT_FOUND，
  // 于是「记日志失败」被 catch 吞掉 → 那个函数从此再没有操作日志，且不报错。
  // 业务侧目前只有 updateCat / addPhoto 生成摘要，其余调用方沿用旧口径。
  { source: 'common/changeSummary.js', targets: ['addCat', 'addPhoto', 'fixRecordOpenid', 'manageAdmin', 'manageNotice', 'mediaCheckCallback', 'mediaReview', 'migrateCatListSort', 'migrateMeetStatusTag', 'sweepLostCats', 'updateCat', 'manageReport'] }
];

// 展开 targets：null → 当前所有云函数
const MANAGED_MODULES = RAW_MODULES.map((mod) => ({
  source: mod.source,
  targets: mod.targets === null ? getCloudFunctionDirs() : mod.targets
}));

module.exports = {
  CLOUD_FUNCTIONS_DIR,
  MANAGED_MODULES,
  getCloudFunctionDirs,
  getCandidateFunctionDirs,
  findDirsMissingIndex
};
