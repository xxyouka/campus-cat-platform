// cloudfunctions/getCatsByIds/index.js - 按 ID 批量查询猫咪（我的关注列表用）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_IDS = 100;
// 单次请求最多接受 500 个 ID（至多 5 次数据库查询），限制公开云函数的资源消耗。
const MAX_REQUEST_IDS = 500;

exports.main = async (event, _context) => {
  const { ids } = event;

  if (!Array.isArray(ids) || ids.length === 0) {
    return fail('缺少猫咪ID列表');
  }
  if (ids.length > MAX_REQUEST_IDS) {
    return fail(`单次最多查询 ${MAX_REQUEST_IDS} 只猫咪`);
  }

  const validIds = [...new Set(ids.filter(id => typeof id === 'string' && /^[a-fA-F0-9]{20,40}$/.test(id)))];
  if (validIds.length === 0) {
    return ok({ cats: [] });
  }

  try {
    const cats = [];
    for (let i = 0; i < validIds.length; i += MAX_IDS) {
      const batch = validIds.slice(i, i + MAX_IDS);
      const res = await db.collection(COLLECTIONS.CATS)
        .where({ _id: db.command.in(batch), _deleting: db.command.neq(true) })
        .get();
      if (res.data) {
        // 整文档下发会把内部字段泄露给任意调用方：_openid 是管理员建档时写入的
        // （存量仍在），_deleting/_deleteStartTime 是删除流程的内部哨兵。
        // 三个字段全端零引用，逐条剔除；where 已滤 _deleting≠true，
        // 删除动作仍显式执行 —— 与 getCatDetail / getShareData 同口径，不依赖调用方自觉。
        for (const cat of res.data) {
          delete cat._openid;
          delete cat._deleting;
          delete cat._deleteStartTime;
          cats.push(cat);
        }
      }
    }

    return ok({ cats });
  } catch (err) {
    console.error('[getCatsByIds] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};
