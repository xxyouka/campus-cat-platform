/**
 * utils/shareHelper.js - 分享卡片的统一口径
 *
 * 为什么集中在这里：全站十来个页面都带分享，过去各写各的，反复踩同一批坑：
 *   - 把 100×100 / 400×400 的展示缩略档直接当分享图，微信卡片放大后糊成一片
 *     （2026-10-12 详情页「超级糊」回归）；
 *   - `cloud://` 原样塞进 imageUrl —— 微信不认 fileID，卡片图直接空白；
 *   - 标题直接拼接口字段，数据没回来时出现「undefined 位用户」；
 *   - 分享路径不带当前上下文，接收方永远落在默认 Tab，与卡片文案对不上。
 *
 * 这里只做四件与业务无关的事：抽标题、规整分享图、拼查询串、截断长标题。
 * 文案本身仍留在页面 —— 每个页面的承诺不同，不能共用一套。
 */
const ImageOptimizer = require('./imageOptimizer');

/**
 * 品牌分享卡（代码包内，5:4，微信卡片可正常放大）。
 *
 * 卡面是「校园猫猫 / 校园猫咪档案」的通用品牌底，
 * 两张一套、每次随机抽一张：聚合页（首页/榜单/关注）本来就没有某一张
 * 具体的猫图，用统一品牌卡比「随便拿第一只猫的头像」更不容易张冠李戴，
 * 也不会被微信按 5:4 裁成一颗大头照。
 *
 * 注意：这些是**卡片**，不是单独的插画；替换时保持 5:4 比例即可。
 */
const BRAND_SHARE_IMAGES = [
  '/images/share/card-1.png',
  '/images/share/card-2.png'
];

/** 卡片包路径 → 本地临时文件路径（进程内缓存） */
const BRAND_LOCAL_PATHS = {};

/**
 * 随机取一张品牌卡：同一个页面反复分享不该永远同一张图。
 * @returns {string}
 */
function randomBrandImage() {
  return ensureBrandLocalPath(
    BRAND_SHARE_IMAGES[Math.floor(Math.random() * BRAND_SHARE_IMAGES.length)]
  );
}

/** 临时文件名带上版本号：换版本时不会把上一版的旧卡当成新卡发出去 */
function _brandCacheVersion() {
  try {
    const app = getApp();
    return app && app.globalData && app.globalData.version || 'v1';
  } catch (e) {
    return 'v1';
  }
}

/** 只认带协议的本地/远程路径；模拟器对包内图片会返回 images/... 这种相对路径 */
function _isShareablePath(p) {
  return typeof p === 'string' && /^[a-z]+:\/\//i.test(p);
}

/**
 * 启动预热：用 wx.getImageInfo 把包内卡片转成本地临时路径。
 *
 * 为什么需要：真实设备上 `readFileSync` 不一定能读代码包文件，而
 * `getImageInfo` 是官方解析包内图片的入口；预热完成后分享回调直接命中缓存。
 * 模拟器会返回 `images/...` 相对路径（不是可分享的本地文件），这种值丢掉，
 * 让 randomBrandImage 走同步复制兜底。
 */
function warmBrandImages() {
  if (typeof wx === 'undefined' || typeof wx.getImageInfo !== 'function') return;
  BRAND_SHARE_IMAGES.forEach((src) => {
    if (BRAND_LOCAL_PATHS[src]) return;
    try {
      wx.getImageInfo({
        src,
        success: (res) => {
          if (res && _isShareablePath(res.path)) BRAND_LOCAL_PATHS[src] = res.path;
        },
        fail: () => { /* 分享时还有同步复制兜底 */ }
      });
    } catch (e) { /* ignore */ }
  });
}

/**
 * 把代码包里的品牌卡复制成本地临时文件再交给分享面板。
 *
 * 为什么不在 imageUrl 里直接用代码包路径：部分客户端对**带子目录的包路径**
 * 解析不稳定（2026-10-22 首页转发反馈 `SystemError / RangeError: Maximum call
 * stack size exceeded`，同一次会话里地图页刚修完 clearRect）。分享面板对
 * `wxfile://` 本地文件的兼容性最好，而且地图快照本来就走这条路，已验证。
 *
 * 分享回调必须同步返回，所以这里用同步读写：单张 20~30KB，耗时可以忽略；
 * 任何一步失败都退回包路径，不影响分享可用性。
 *
 * @param {string} src 代码包路径
 * @returns {string} 本地文件路径或原包路径
 */
function ensureBrandLocalPath(src) {
  if (BRAND_LOCAL_PATHS[src]) return BRAND_LOCAL_PATHS[src];
  try {
    if (typeof wx === 'undefined' || !wx.getFileSystemManager ||
        !wx.env || !wx.env.USER_DATA_PATH) {
      return src;
    }
    const fs = wx.getFileSystemManager();
    const name = String(src).split('/').pop();
    const dest = `${wx.env.USER_DATA_PATH}/share-${_brandCacheVersion()}-${name}`;
    fs.writeFileSync(dest, fs.readFileSync(src));
    BRAND_LOCAL_PATHS[src] = dest;
    return dest;
  } catch (e) {
    // 同步读包失败：让 getImageInfo 异步转一次，下一次分享直接命中
    try {
      if (typeof wx !== 'undefined' && typeof wx.getImageInfo === 'function') {
        wx.getImageInfo({
          src,
          success: (res) => {
            if (res && _isShareablePath(res.path)) BRAND_LOCAL_PATHS[src] = res.path;
          },
          fail: () => {}
        });
      }
    } catch (e2) { /* ignore */ }
    return src;
  }
}

/** 仅测试用：清掉临时文件缓存 */
function _resetBrandImageCache() {
  Object.keys(BRAND_LOCAL_PATHS).forEach((key) => { delete BRAND_LOCAL_PATHS[key]; });
}

/**
 * 从候选文案里随机抽一条：同一个页面反复分享不该永远同一句话。
 * @param {string[]} titles
 * @returns {string}
 */
function pickTitle(titles) {
  const list = (Array.isArray(titles) ? titles : [])
    .filter(t => typeof t === 'string' && t.trim());
  if (!list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 规整分享图：
 *   - 空值 / 未转链的 cloud:// → fallback（默认随机品牌卡；传 '' 表示宁可不带图）
 *   - 腾讯云 TCB 链接 → 换成 800×640 分享档（替换旧 imageMogr2 段）
 *   - 第三方直链 → 原样返回
 *
 * @param {string} url - 已解析的图片链接（云存储需先转临时 URL）
 * @param {string} [fallback] - 不可用时的兜底；传 '' 返回空串
 * @returns {string}
 */
function shareImage(url, fallback = randomBrandImage()) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw || raw.startsWith('cloud://')) return fallback;
  return ImageOptimizer.getShareUrl(raw);
}

/**
 * 没有天然兜底图的页面用这个：取不到就返回空串，调用方据此省略 imageUrl。
 * @param {string} url
 * @returns {string}
 */
function optionalShareImage(url) {
  return shareImage(url, '');
}

/**
 * 从一组候选里取第一张可用的分享图。
 *
 * 列表页常见「封面还是 cloud://、头像已转链」的混合状态：只传一个字段会在
 * 该字段恰好不可用时整张卡片没图。按顺序试，拿到第一张能用的就停。
 *
 * @param {string[]} urls
 * @param {string} [fallback='']
 * @returns {string}
 */
function firstShareImage(urls, fallback = '') {
  const list = Array.isArray(urls) ? urls : [];
  for (const url of list) {
    const image = optionalShareImage(url);
    if (image) return image;
  }
  return fallback;
}

/**
 * 拼查询串（不含前导 ?）：跳过 null / undefined / 空串，统一百分号编码。
 * @param {Object} params
 * @returns {string}
 */
function buildQuery(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * 拼完整分享路径：query 为空时保留原路径（不留下孤零零的 ?）。
 * @param {string} base
 * @param {Object} [params]
 * @returns {string}
 */
function buildPath(base, params) {
  const query = buildQuery(params);
  return query ? `${base}?${query}` : base;
}

/**
 * 截断长标题（公告标题可能很长，分享卡片只显示前一行）。
 * @param {string} text
 * @param {number} [max=24]
 * @returns {string}
 */
function truncate(text, max = 24) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

module.exports = {
  BRAND_SHARE_IMAGES,
  randomBrandImage,
  warmBrandImages,
  _resetBrandImageCache,
  pickTitle,
  shareImage,
  optionalShareImage,
  firstShareImage,
  buildQuery,
  buildPath,
  truncate
};
