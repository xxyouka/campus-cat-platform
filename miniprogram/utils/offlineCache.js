// utils/offlineCache.js - 离线数据缓存（本地存储 + TTL 过期）
const { Logger } = require('./logger');

const TAG = 'offlineCache';

const CACHE_KEYS = {
  CATS: '_offline_cats',
  CATS_TIME: '_offline_cats_time',
  CAT_DETAIL: '_offline_cat_detail_',
  NOTICES: '_offline_notices',
  STATS: '_offline_stats',
  ALBUMS: '_offline_albums',
  ALBUMS_TIME: '_offline_albums_time',
};

const CACHE_TTL = 30 * 60 * 1000;

// 相册缓存的条数上限，与 gallery 的 albumPageSize（10）对齐。
// 只缓存第一页：缓存的作用是「下次冷启动立刻出内容」，第二页起由静默刷新 + 触底加载补齐。
// 存全量会让 storage 随浏览深度无界增长，也让「缓存渲染」与 albumPage 的分页语义对不上。
const ALBUM_CACHE_MAX = 10;

// 猫咪详情缓存的最大条数。每条约 300~600 字节，看似很小，但它是**只写不清**的：
// 每打开一只猫的详情就多一个 `_offline_cat_detail_<24位ID>` key，只有 clearAll()
// 会清（而 clearAll 在生产代码里没有调用方）。微信 storage 上限 10MB ——
// 浏览 2 万只猫就能攒到约 10MB，届时 wx.setStorageSync 抛错（虽被 try/catch 吞掉），
// 但**其他缓存（列表、公告、统计）与登录态、关注态的写入会一起失败**，
// 表现为「关注不上 / 缓存全丢」这类难以归因的现象。
// 因此读路径发现过期就顺手删，写路径超量就淘汰最旧的。
const CAT_DETAIL_MAX = 30;

function saveCats(cats) {
  try {
    const simplified = cats.map(cat => ({
      _id: cat._id,
      name: cat.name,
      // 优先存 cloud:// 原始 fileID（临时链接会过期；image 组件原生支持 cloud://）
      avatar: cat._cloudFileID || cat.avatar,
      campus: cat.campus,
      status: cat.status,
      color: cat.color,
      gender: cat.gender,
      meetCount: cat.meetCount,
      photoCount: cat.photoCount
    }));
    wx.setStorageSync(CACHE_KEYS.CATS, simplified);
    wx.setStorageSync(CACHE_KEYS.CATS_TIME, Date.now());
    Logger.debug(TAG, `缓存${simplified.length}只猫咪数据`);
  } catch (e) {
    Logger.warn(TAG, '缓存猫咪数据失败', e.message);
  }
}

function getCats() {
  try {
    const cacheTime = wx.getStorageSync(CACHE_KEYS.CATS_TIME) || 0;
    if (Date.now() - cacheTime > CACHE_TTL) return null;

    const cats = wx.getStorageSync(CACHE_KEYS.CATS);
    if (!cats || !cats.length) return null;

    Logger.info(TAG, `使用离线缓存: ${cats.length}只猫咪`);
    return cats;
  } catch (e) {
    return null;
  }
}

/**
 * 淘汰最旧的猫咪详情缓存条目。
 * 这里按「写入时间」排序而不是 key 字典序：key 是随机 docId，
 * 字典序与先后打开顺序无关，按它删会删错条目。
 */
function pruneCatDetailCache() {
  const entries = [];
  wx.getStorageInfoSync().keys.forEach(key => {
    if (!key.startsWith(CACHE_KEYS.CAT_DETAIL)) return;
    const cached = wx.getStorageSync(key);
    entries.push({ key, time: cached && cached.time || 0 });
  });

  if (entries.length < CAT_DETAIL_MAX) return;

  // 此时新条目已经写进 store，所以要删的是「超出的部分」本身，
  // 不要再 +1（+1 会一次多删一条，把刚写进去的也淘汰掉）
  entries.sort((a, b) => a.time - b.time);
  const overflow = entries.length - CAT_DETAIL_MAX;
  entries.slice(0, Math.max(0, overflow)).forEach(entry => {
    try { wx.removeStorageSync(entry.key); } catch (_e) { /* 单个淘汰失败不影响其余 */ }
  });
}

function saveCatDetail(catId, cat) {
  try {
    const key = CACHE_KEYS.CAT_DETAIL + catId;
    const simplified = {
      _id: cat._id,
      name: cat.name,
      avatar: cat.avatar,
      campus: cat.campus,
      status: cat.status,
      color: cat.color,
      gender: cat.gender,
      age: cat.age,
      sterilized: cat.sterilized,
      description: cat.description,
      appearance: cat.appearance,
      location: cat.location,
      healthStatus: cat.healthStatus,
      healthNote: cat.healthNote,
      meetCount: cat.meetCount,
      photoCount: cat.photoCount,
      notes: cat.notes
    };
    wx.setStorageSync(key, { data: simplified, time: Date.now() });
    pruneCatDetailCache();
  } catch (e) {
    Logger.warn(TAG, '缓存猫咪详情失败', e.message);
  }
}

function getCatDetail(catId) {
  try {
    const key = CACHE_KEYS.CAT_DETAIL + catId;
    const cached = wx.getStorageSync(key);
    if (!cached || !cached.data) return null;
    if (Date.now() - cached.time > CACHE_TTL) {
      // 顺手删掉过期 key：只 return null 而不删的话，这个 key 会永远留在 storage 里
      // 累积到上限，进而拖垮其他缓存与登录态的写入（见 CAT_DETAIL_MAX 注释）
      wx.removeStorageSync(key);
      return null;
    }
    return cached.data;
  } catch (e) {
    return null;
  }
}

function saveNotices(notices) {
  try {
    wx.setStorageSync(CACHE_KEYS.NOTICES, { data: notices, time: Date.now() });
  } catch (e) {
    Logger.warn(TAG, '缓存公告失败', e.message);
  }
}

function getNotices() {
  try {
    const cached = wx.getStorageSync(CACHE_KEYS.NOTICES);
    if (!cached || !cached.data) return null;
    if (Date.now() - cached.time > CACHE_TTL) return null;
    return cached.data;
  } catch (e) {
    return null;
  }
}

/**
 * 缓存相册列表（gallery 首屏 SWR 用），只保留第一页与渲染必需的字段。
 *
 * 与 saveCats 同一口径：**存 cloud:// 原始 fileID 而不是转链后的临时链接**——
 * 临时链接会过期（imageMogr2 链接 24h），而 <image> 原生支持 cloud://，
 * 存原值才能在链接过期后仍然渲染得出来。
 * 因此调用方必须在 convertAlbumCovers 把 coverUrl 换成临时链接**之前**落盘。
 */
function saveAlbums(albums) {
  try {
    const simplified = (Array.isArray(albums) ? albums : []).slice(0, ALBUM_CACHE_MAX).map(album => ({
      catId: album.catId,
      catName: album.catName || album.name || '',
      coverUrl: album.coverUrl || '',
      catAvatar: album.catAvatar || '',
      photoCount: album.photoCount || 0
    }));
    wx.setStorageSync(CACHE_KEYS.ALBUMS, simplified);
    wx.setStorageSync(CACHE_KEYS.ALBUMS_TIME, Date.now());
    Logger.debug(TAG, `缓存${simplified.length}本相册数据`);
  } catch (e) {
    Logger.warn(TAG, '缓存相册数据失败', e.message);
  }
}

function getAlbums() {
  try {
    const cacheTime = wx.getStorageSync(CACHE_KEYS.ALBUMS_TIME) || 0;
    if (Date.now() - cacheTime > CACHE_TTL) return null;

    const albums = wx.getStorageSync(CACHE_KEYS.ALBUMS);
    if (!albums || !albums.length) return null;

    Logger.info(TAG, `使用离线缓存: ${albums.length}本相册`);
    return albums;
  } catch (e) {
    return null;
  }
}

/** 缓存首页统计（照片数/浏览量），供冷启动 SWR 先显示上次数字 */
function saveStats(totalPhotos, totalViews) {
  try {
    wx.setStorageSync(CACHE_KEYS.STATS, {
      totalPhotos: totalPhotos || 0,
      totalViews: totalViews || 0,
      time: Date.now()
    });
  } catch (e) {
    Logger.warn(TAG, '缓存统计失败', e.message);
  }
}

function getStats() {
  try {
    const cached = wx.getStorageSync(CACHE_KEYS.STATS);
    if (!cached || typeof cached.totalPhotos !== 'number') return null;
    if (Date.now() - cached.time > CACHE_TTL) return null;
    return { totalPhotos: cached.totalPhotos, totalViews: cached.totalViews || 0 };
  } catch (e) {
    return null;
  }
}

function clearAll() {
  try {
    wx.removeStorageSync(CACHE_KEYS.CATS);
    wx.removeStorageSync(CACHE_KEYS.CATS_TIME);
    wx.removeStorageSync(CACHE_KEYS.NOTICES);
    wx.removeStorageSync(CACHE_KEYS.STATS);
    wx.removeStorageSync(CACHE_KEYS.ALBUMS);
    wx.removeStorageSync(CACHE_KEYS.ALBUMS_TIME);
    wx.removeStorageSync(CACHE_KEYS.RESCUE);
    wx.removeStorageSync(CACHE_KEYS.RESCUE_TIME);
    const res = wx.getStorageInfoSync();
    res.keys.forEach(key => {
      if (key.startsWith(CACHE_KEYS.CAT_DETAIL)) {
        wx.removeStorageSync(key);
      }
    });
    Logger.info(TAG, '离线缓存已清理');
  } catch (e) {
    Logger.warn(TAG, '清理缓存失败', e.message);
  }
}

module.exports = {
  saveCats,
  getCats,
  saveCatDetail,
  getCatDetail,
  saveNotices,
  getNotices,
  saveStats,
  getStats,
  saveAlbums,
  getAlbums,
  clearAll
};
