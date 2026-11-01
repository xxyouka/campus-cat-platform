// cloudfunctions/getCatDetail/index.js - 获取猫咪详情（替代客户端直连数据库）
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, _context) => {
  // keepWarm 预热早退：定时任务每 5 分钟 callFunction 一次，目的是把实例从冷启动拉起来。
  // **必须在参数校验之前** —— 否则预热请求会因缺少业务参数被判失败而立刻返回，
  // 实例只跑了「启动 + 校验」就退出，业务模块根本没被加载（真机实测冷热差 4 倍）。
  if (event && event._keepWarm) return ok({ _keepWarm: true });

  const { catId } = event;

  if (!catId) {
    return fail('缺少猫咪ID');
  }
  if (typeof catId !== 'string' || !/^[a-fA-F0-9]{20,40}$/.test(catId)) {
    return fail('无效的猫咪ID格式');
  }

  try {
    // doc().get() 文档不存在时直接 reject（throwOnNotFound 默认 true），
    // 不会返回空 data —— 原先 `!res.data` 分支永远不可达。这里把「不存在」
    // 映射为 NOT_FOUND，其他错误（网络等）继续抛出走通用失败分支。
    let res;
    try {
      res = await db.collection(COLLECTIONS.CATS).doc(catId).get();
    } catch (docErr) {
      const msg = String(docErr && docErr.message || docErr || '');
      if (msg.indexOf('does not exist') >= 0 || msg.indexOf('not exist') >= 0) {
        return fail('猫咪不存在', 'NOT_FOUND');
      }
      throw docErr;
    }
    if (!res.data || res.data._deleting === true) {
      // 删除中的猫咪视为不存在（deleteData 标记后多步删除）
      return fail('猫咪不存在', 'NOT_FOUND');
    }
    const cat = res.data;
    // 剔除内部字段：本接口无鉴权，任何微信用户一次调用就能拿到整份文档。
    // _openid 是管理员建档时写进 cats 的（addCat 曾显式写入），
    // 且全端零引用、无任何按 cats._openid 的查询 —— 留着只有泄露、没有用途。
    // 其余字段一律保留（这是详情页的数据源，不做白名单过滤）。
    delete cat._deleting;
    delete cat._deleteStartTime;
    delete cat._openid;
    return ok({ cat });
  } catch (err) {
    console.error('[getCatDetail] 查询失败:', err);
    return fail('查询失败，请稍后重试');
  }
};
