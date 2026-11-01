/**
* recordView - 记录猫咪浏览量
* 
* 入参：{ catId }
* 逻辑：cats.viewCount _.inc(1)，基于 openid + 5分钟去重防刷
* 返回：{ success: true, duplicated: boolean }
*
* 已知限制（counter drift）：
* viewCount 是纯累加计数器，且**不存在**可回溯的浏览明细集合作为权威源，
* 因此无法像 meetCount 那样通过对账任务纠偏（见 reconcileMeetCount）。
* 一旦出现漂移（实例级去重失效导致的重复计数、文档被并发覆盖等），
* 只能由管理员在控制台手工修正。若未来需要可对账，必须先落库浏览明细，
* 再按明细重算 viewCount——在此之前不要为本字段添加对账逻辑，那只会得到错误基准。
*/
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 防刷缓存：{ [catId_openid]: timestamp }
// 已知限制：实例级内存，多个云函数实例间不共享，多实例下 5 分钟去重会部分失效。
// 这是有意为之的取舍——客户端已有 5 分钟本地去重（detail 页 _recordViewWithFallback），
// 服务端缓存主要用于拦截同实例的恶意刷量；为浏览计数引入 DB 级去重（每次浏览多 2 次
// 数据库操作）不值得。若未来需要严格防刷，可改用带 TTL 索引的独立集合。
const _viewCache = {};
// 同一云函数实例内合并并发请求，避免两个近乎同时的有效浏览都递增。
const _pendingViews = new Map();

// 去重窗口：5分钟内同一用户对同一猫咪只计一次
const DEDUP_INTERVAL = 5 * 60 * 1000;

exports.main = async (event, _context) => {
  const { catId } = event;
  const { OPENID } = cloud.getWXContext();

  // 校验 catId（与其他写路径一致，防止对象/操作符注入）
  if (!catId || typeof catId !== 'string' || !/^[a-fA-F0-9]{20,40}$/.test(catId)) {
    return fail('缺少或无效的 catId 参数');
  }

  try {
    const cacheKey = `${catId}_${OPENID}`;
    const now = Date.now();

    // 清理过期缓存（放在去重判断之前：即使本实例只收到重复浏览，也能回收内存）
    const expireThreshold = now - DEDUP_INTERVAL * 2;
    for (const key in _viewCache) {
      if (_viewCache[key] < expireThreshold) {
        delete _viewCache[key];
      }
    }

    // 防刷检查：openid + catId 去重
    const lastView = _viewCache[cacheKey];

    if (lastView && now - lastView < DEDUP_INTERVAL) {
      // 5分钟内重复浏览，不计数
      return ok({ duplicated: true });
    }

    // 合并同一实例内的并发请求。只在写库成功后记去重时间，
    // 数据库暂时失败时允许客户端队列稍后重试。
    const pending = _pendingViews.get(cacheKey);
    if (pending) {
      await pending;
      return ok({ duplicated: true });
    }

    const write = db.collection(COLLECTIONS.CATS).doc(catId).update({
      data: {
        viewCount: _.inc(1)
      }
    });
    _pendingViews.set(cacheKey, write);
    try {
      await write;
      _viewCache[cacheKey] = now;
    } finally {
      if (_pendingViews.get(cacheKey) === write) _pendingViews.delete(cacheKey);
    }

    return ok({ duplicated: false });
  } catch (err) {
    console.error('recordView 失败:', err);
    return fail('记录浏览量失败');
  }
};
