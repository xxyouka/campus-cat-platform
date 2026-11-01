// cloudfunctions/keepWarm/index.js - 定时保活预热各云函数（定时触发器调用）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const WARM_FUNCTIONS = [
  'getCatPhotoCounts',
  'getCatAvatars',
  'getNotices',
  'getNotifications',
  'filterCats',
  'getRecentMeets',
  // 管理端入口（2026-10-14 性能复盘）：We分析「各页面切换耗时」里 pages/admin/admin
  // 均值 3758ms，是第二名的 19 倍。该页 onLoad 是「云端鉴权 → 统计」两个**串行** await，
  // 而管理端是低频入口（只有管理员偶尔进），这两个函数此前不在预热名单里 →
  // 每次进后台都要各付一次冷启动。
  // 预热调用的 OPENID 为空：checkAdminStatus / getAdminStats 都会在 checkAdmin 处
  // **立即**返回（无 DB 查询、不触发 getAdminStats 的全表扫描），代价只有容器与模块加载
  // —— 正是要预热的东西。两者均只读，无写入与数据出口。
  'checkAdminStatus',
  'getAdminStats',
  // 第二批（2026-10-15）：低频但用户/管理员**看得见等待**的页面入口。
  // 判据：① 进入该页面就调它；② 平时没人调（冷启动概率高）；③ 预热调用安全且便宜 ——
  // 逐个核过：getOperationLogs / manageAdmin 无 OPENID 时在鉴权处早退，
  // 其余是公开只读（无写入、无副作用；`getFilterOptions`/`getPhotosByCat` 那类
  // 「写库」正则命中经人工核对是 Set.add 与读 photoLikes 的误报）。
  'getMeetCalendar',   // 「我的」页相遇日历
  'getMyMeets',        // 相遇打卡列表页
  'getCatRank',        // 猫咪榜单
  'getMeetRank',       // 相遇榜（管理端）
  'getFavRank',        // 收藏榜（管理端）
  'getOperationLogs',  // 操作日志页（管理端）
  'manageAdmin',       // 管理员管理页（管理端）

  // 第三批（2026-10-18 云函数慢日志复盘）：前两批补的全是**低频入口**，
  // 结果把「用户每次打开都要等」的三个主路径函数漏在名单外 —— 名单维护的优先级反了。
  // 线上证据：getCatDetail 2475ms（函数内只有一次 doc().get()，热态 20~80ms，只能是冷启动）、
  // getPhotosByCat 1107ms；而 detail 页 onLoad 在同一个 tick 里并发 5 个云调用
  //（detail.js:119-147），冷启动时等于同时拉起 5 个冷容器。
  // 三个都只读，且缺参时在参数校验处早退、不产生查询：
  //   getCatDetail      — 无 catId 直接 fail（index.js:11-13）
  //   getPhotosByCat    — catId 格式不通过直接 fail（index.js:27-29）
  //   getAlbumsWithInfo — 无参时 page=0/pageSize=50，只读聚合，成本 ≈ 一次真实请求
  // 明确**不**加：
  //   recordView      — 有写库副作用，无 OPENID 的预热会写入空 openid 的浏览记录；
  //   getMyMeetCount  — where 里的 _openid 为 undefined 会被剥成空条件，退化成对
  //                     recordMeet 的全表 count，且它不在首屏关键路径上；
  //   getCatsByIds    — 无 ids 时早退（index.js:14-16），同样不在首屏关键路径上。
  'getCatDetail',
  'getPhotosByCat',
  'getAlbumsWithInfo',

  // 2026-10-18 猫咪行动分析（超管专属，管理端低频入口）：
  // 判据同第二批 —— ① 打开分析页就调它（且一次全扫），冷启动叠加扫描延迟最明显；
  // ② 只有超管偶尔进；③ 预热调用无 OPENID，会在 checkAdmin 处立即返回
  //（无 DB 查询、不触发扫描），代价只有容器与模块加载。只读、无写入与数据出口。
  'getCatActivity',

  // 2026-10-22 运营数据面板：管理端低频入口，打开时要扫多张表，
  // 冷启动叠加扫描最明显。预热无 OPENID，会在 checkAdmin 处立即返回，
  // 不触发扫描、不写库。
  'getOpsDashboard'
];


// 预热并发度：名单变长后仍要守住 keepWarm 自己的 30s 超时（尤其是环境闲置一夜后的
// 第一轮全冷启动）。分批并发只影响「谁先被预热」，不影响每项的独立成败上报。
const WARM_CONCURRENCY = 3;

exports.main = async (_event, _context) => {
  // 仅允许定时触发器调用本函数。
  // 判据与 backupData / reconcileMeetCount 的 isTrustedTimerEvent 第 1 层一致：
  // 客户端（含小程序用户）经 wx.cloud.callFunction 调用时一定携带 OPENID，
  // 而定时触发事件没有任何用户上下文 —— 命中 OPENID 即拒绝。
  // 这里不校验 Type/TriggerName：keepWarm 无 HTTP 路由，且这两个字段可被客户端伪造，
  // 校验它们只会让「触发器改名」变成静默拒真；OPENID 判据才是不可伪造的那一条。
  const { OPENID } = cloud.getWXContext();
  if (OPENID) {
    console.warn('[keepWarm] 拒绝客户端调用（保活属定时任务，不对用户开放）', { openidPrefix: OPENID.slice(0, 6) });
    return fail('无权调用');
  }

  console.log('[keepWarm] 开始预热云函数');

  const results = [];

  // 分批并发：名单变长后，串行会在「环境闲置一夜后的第一轮全冷启动」逼近本函数的
  // 30s 超时（超时会被整体中断，排在后面的函数就白等一轮）。分批只影响谁先被预热，
  // 每项的独立成败仍逐条上报。
  for (let i = 0; i < WARM_FUNCTIONS.length; i += WARM_CONCURRENCY) {
    const chunk = WARM_FUNCTIONS.slice(i, i + WARM_CONCURRENCY);
    const settled = await Promise.all(chunk.map(async (funcName) => {
      try {
        const startTime = Date.now();
        await cloud.callFunction({
          name: funcName,
          data: { _keepWarm: true }
        });
        return { name: funcName, status: 'ok', elapsed: Date.now() - startTime };
      } catch (err) {
        return { name: funcName, status: 'fail', error: err.message };
      }
    }));
    results.push(...settled);
  }

  console.log('[keepWarm] 预热完成:', JSON.stringify(results));

  return ok({
    warmedAt: new Date().toISOString(),
    results
  });
};
