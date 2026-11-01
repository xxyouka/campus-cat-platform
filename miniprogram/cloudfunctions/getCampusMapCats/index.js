// cloudfunctions/getCampusMapCats/index.js - 获取校园地图上的猫标记
//
// 只返回「有过地图坐标」的猫：cats.lastMeetPoint.campusZone 与入参校区相等。
// MongoDB 对非 null 等值不匹配字段缺失，所以这一条件天然过滤掉
// 从没被用户选过点的猫，不需要额外 where lastMeetPoint != null。
//
// 一次查询拿全部猫 + 各自锚点 —— 不做 per-cat 查询（50 栋楼就是 50 次往返）。
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./utils/response');
const { COLLECTIONS } = require('./utils/constants');
const CloudCache = require('./utils/cache');
const { CloudLogger } = require('./utils/logger');
// 坐标合法性只有这一处定义（与 recordMeet 写侧同源），见 utils/mapPoint.js
const { isValidPoint, CAMPUS_ZONE_MAX_LEN } = require('./utils/mapPoint');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 与 cats.campus 同口径（20 字上限，见 mapPoint.CAMPUS_ZONE_MAX_LEN）
const CACHE_TTL = 60;          // 位置数据变化很慢，60 秒足够
const MAX_CATS = 500;          // 与 config.performance.maxCatsLoadLimit 同口径

/** 只投影地图需要的字段，顺带排除 _openid 等私有字段 */
const MAP_FIELDS = {
  name: true,
  avatar: true,
  status: true,
  campus: true,
  meetCount: true,
  lastMeetTime: true,
  lastMeetPoint: true
};

/**
 * 落库时 recordMeet 已校验过，这里再用 isValidPoint 防御性过滤一次：
 * 脏数据（历史迁移、手工改库）不该让地图整体崩掉，只跳过这一只。
 */

exports.main = async (event, _context) => {
  const raw = event && event.campusZone;
  const campusZone = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, CAMPUS_ZONE_MAX_LEN) : '本部';

  try {
    const payload = await CloudCache.getOrSet(
      `campus_map_cats_${campusZone}`,
      async () => {
        const res = await db.collection(COLLECTIONS.CATS)
          .where({
            _deleting: _.neq(true),
            'lastMeetPoint.campusZone': campusZone
          })
          .field(MAP_FIELDS)
          .limit(MAX_CATS)
          .get();

        const cats = [];
        let skipped = 0;
        (res.data || []).forEach(c => {
          const p = c.lastMeetPoint;
          if (!isValidPoint(p)) { skipped++; return; }
          cats.push({
            id: c._id,
            name: c.name || '',
            avatar: c.avatar || '',
            status: c.status || '',
            campus: c.campus || '',
            u: p.u,
            v: p.v,
            at: typeof p.at === 'number' ? p.at : c.lastMeetTime || 0,
            meetCount: typeof c.meetCount === 'number' ? c.meetCount : 0
          });
        });

        if (skipped > 0) {
          CloudLogger.warn('getCampusMapCats', '跳过坐标非法的猫', { skipped, campusZone });
        }
        return { cats, total: cats.length };
      },
      CACHE_TTL
    );

    return ok({ ...payload, campusZone });
  } catch (err) {
    CloudLogger.error('getCampusMapCats', '查询失败', err);
    return fail('获取地图数据失败，请稍后重试');
  }
};