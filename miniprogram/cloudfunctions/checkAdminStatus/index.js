// cloudfunctions/checkAdminStatus/index.js - 检查当前用户管理员状态
const cloud = require('wx-server-sdk');
const { checkAdmin, getEffectivePermissions, isSuperLevelRole } = require('./utils/auth');
const { ok, fail } = require('./utils/response');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, _context) => {
  event = event && typeof event === 'object' ? event : {};
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      event = { ...event, ...parsed };
    } catch (e) {
      // body不是JSON，忽略
    }
  }
  const adminAccount = event._adminAccount || '';

  try {
    // 鉴权基于服务端真实 OPENID，adminAccount 仅用于日志，不作为身份凭据
    const authResult = await checkAdmin(db, '');
    const isAdmin = authResult.isAdmin;
    // 超管及以上（超级管理员/创始人）：客户端据此显示全量菜单。
    // role 原样透传，前端按三档渲染徽章与「管理员管理」入口。
    const isSuperAdmin = isSuperLevelRole(authResult.adminInfo?.role);
    const role = authResult.adminInfo?.role || '';
    // 14 个入口的生效名单：超管/创始人全部、普通管理员按 permissions（缺省=默认 3 项）。
    // 客户端仅用它渲染菜单与页面门禁，真实拦截在每个云函数的 checkAdmin 里。
    const permissions = authResult.adminInfo
      ? getEffectivePermissions(authResult.adminInfo)
      : [];

    console.log('[checkAdminStatus] account:', adminAccount, 'isAdmin:', isAdmin, 'role:', role);

    return ok({ isAdmin, isSuperAdmin, role, permissions });
  } catch (err) {
    console.error('[checkAdminStatus] 查询失败:', err);
    return fail('权限验证失败');
  }
};
