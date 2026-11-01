/**
 * 联系方式加载工具
 *
 * 联系方式唯一来源为云函数 getConfig（读取云函数环境变量 CONTACT_WECHAT / CONTACT_EMAIL），
 * 本地用 contactInfoCache 缓存 1 小时，避免每次进页面都发云调用。
 * 未配置 / 加载失败时降级为「暂未配置」占位，不抛错、不阻塞页面。
 */
const { Logger } = require('./logger');

const CONTACT_CACHE_KEY = 'contactInfoCache';
const CONTACT_CACHE_TTL = 3600000;
const EMPTY_CONTACT_TEXT = '暂未配置';

function hasContactValue(contact = {}) {
  const hasWechat = typeof contact.wechat === 'string' && contact.wechat.trim();
  const hasEmail = typeof contact.email === 'string' && contact.email.trim();
  return Boolean(hasWechat || hasEmail);
}

function normalizeContact(contact = {}) {
  return {
    wechat: typeof contact.wechat === 'string' && contact.wechat.trim() ? contact.wechat.trim() : EMPTY_CONTACT_TEXT,
    email: typeof contact.email === 'string' && contact.email.trim() ? contact.email.trim() : EMPTY_CONTACT_TEXT
  };
}

/**
 * 加载联系方式（缓存 → 云端 → 写缓存），返回归一化后的 { wechat, email }。
 * 永不抛错：失败 / 未配置时返回「暂未配置」占位。
 */
async function loadContact() {
  try {
    const cached = wx.getStorageSync(CONTACT_CACHE_KEY);
    if (
      cached &&
      cached.data &&
      hasContactValue(cached.data) &&
      Date.now() - cached.timestamp < CONTACT_CACHE_TTL
    ) {
      return normalizeContact(cached.data);
    }

    const res = await wx.cloud.callFunction({
      name: 'getConfig',
      data: { keys: ['contact'] }
    });

    const gdata = res.result && res.result.data || res.result || {};
    if (res.result && res.result.success && gdata.contact) {
      const rawContact = gdata.contact;
      if (hasContactValue(rawContact)) {
        try {
          wx.setStorageSync(CONTACT_CACHE_KEY, { data: rawContact, timestamp: Date.now() });
        } catch (e) { /* 缓存写入失败不影响本次展示 */ }
      }
      return normalizeContact(rawContact);
    }
  } catch (err) {
    // 静默降级：展示占位文案即可，联系方式不是关键路径（记一条日志便于排查）
    Logger.warn('contactHelper', '联系方式加载失败，降级为占位', { error: err && err.message });
  }
  return normalizeContact({});
}

module.exports = {
  CONTACT_CACHE_KEY,
  CONTACT_CACHE_TTL,
  EMPTY_CONTACT_TEXT,
  hasContactValue,
  normalizeContact,
  loadContact
};
