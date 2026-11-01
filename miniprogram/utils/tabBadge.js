/**
 * utils/tabBadge.js - 「我的」tab 的未读红点
 *
 * 为什么单独抽一层：
 *   未读数的真实来源是 `getNotifications`，只有「我的」页和消息中心页会拉。
 *   用户如果不进「我的」，tabBar 上就没有任何提示，消息容易被一直忽略。
 *   这里把「最近一次拉到的未读数」落盘，冷启动 / 回前台时只读本地缓存刷新红点，
 *   **不发任何网络请求** —— 真实计数仍由那两个页面负责拉取并回写。
 *
 * 口径：
 *   - 只有 count > 0 才显示数字；0 时主动 removeTabBarBadge（不能留着上一次的 3）。
 *   - 超过 99 显示 99+（微信 tabBar 文本最多 4 个字符）。
 *   - 所有 wx API 都可能因基础库 / 页面栈未就绪而失败：红点只是提示，绝不能影响业务。
 */

const STORAGE_KEY = 'unread_notification_count_v1';
// tabBar 第 3 项 =「我的」；顺序见 app.json 的 tabBar.list
const TAB_INDEX = 2;
const MAX_BADGE_TEXT = '99+';

function normalizeCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function readCachedCount() {
  try {
    return normalizeCount(wx.getStorageSync(STORAGE_KEY));
  } catch (e) {
    return 0;
  }
}

function writeCachedCount(count) {
  try {
    wx.setStorageSync(STORAGE_KEY, normalizeCount(count));
  } catch (e) {
    // 存储不可用（超限 / 被清）只影响下次冷启动的红点，不影响当前提示
  }
}

function applyBadge(count) {
  const n = normalizeCount(count);
  try {
    if (n > 0) {
      wx.setTabBarBadge({
        index: TAB_INDEX,
        text: n > 99 ? MAX_BADGE_TEXT : String(n),
        fail: () => {}
      });
    } else {
      // 传 0 不会自动清除，必须显式 remove；否则会留着上一次的数字
      wx.removeTabBarBadge({ index: TAB_INDEX, fail: () => {} });
    }
  } catch (e) {
    // 基础库不支持 / tabBar 尚未就绪：忽略，页面内的红点仍然有效
  }
}

/**
 * 写入缓存并立即刷新 tabBar 红点。
 * @param {number} count 最新未读数
 * @returns {number} 归一化后的未读数
 */
function sync(count) {
  const n = normalizeCount(count);
  writeCachedCount(n);
  applyBadge(n);
  return n;
}

/** 冷启动 / 回前台：只按本地缓存恢复红点，不触发网络 */
function refreshFromCache() {
  applyBadge(readCachedCount());
}

/** 清空红点与缓存（例如用户退出登录 / 数据被清空） */
function clear() {
  sync(0);
}

module.exports = {
  STORAGE_KEY,
  TAB_INDEX,
  normalizeCount,
  readCachedCount,
  writeCachedCount,
  applyBadge,
  sync,
  refreshFromCache,
  clear
};
