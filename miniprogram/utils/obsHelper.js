// utils/obsHelper.js - 数据埋点统计（wx.obs 事件上报封装）
const { Logger } = require('./logger');

const TAG = 'obs';

const EVENT_NAMES = {
  VIEW_CAT: 'view_cat',
  SEARCH_CAT: 'search_cat',
  FILTER_CAMPUS: 'filter_campus',
  MEET_CAT: 'meet_cat',
  FAVORITE_CAT: 'favorite_cat',
  SHARE_CAT: 'share_cat',
  VIEW_GALLERY: 'view_gallery',
  ADMIN_LOGIN: 'admin_login',
  ADMIN_ADD_CAT: 'admin_add_cat',
  ADMIN_EDIT_CAT: 'admin_edit_cat',
  ADMIN_ADD_PHOTO: 'admin_add_photo',
  ONBOARDING_VIEW: 'onboarding_view',
  ONBOARDING_COMPLETE: 'onboarding_complete',
  ONBOARDING_SKIP: 'onboarding_skip',
  GUIDANCE_RELEASE_VIEW: 'guidance_release_view',
  GUIDANCE_RELEASE_CLICK: 'guidance_release_click',
  GUIDE_TOUR_VIEW: 'guide_tour_view',
  GUIDE_TOUR_STEP: 'guide_tour_step',
  GUIDE_TOUR_SKIP: 'guide_tour_skip',
  GUIDE_TOUR_COMPLETE: 'guide_tour_complete',
  GUIDE_TOUR_MISSING: 'guide_tour_missing',
  GUIDE_TOUR_REPLAY: 'guide_tour_replay',
  COACH_VIEW: 'coach_view',
  COACH_SKIP: 'coach_skip',
  COACH_TARGET_TAP: 'coach_target_tap',
  HELP_VIEW: 'help_view',
  HELP_FAQ_EXPAND: 'help_faq_expand',
  FEATURE_FIRST_USE: 'feature_first_use',
  AGREEMENT_ACCEPT: 'agreement_accept',
  GLOBAL_ERROR: 'global_error',
  UNHANDLED_REJECTION: 'unhandled_rejection'
};

let _initialized = false;
let _initAttempted = false;

function isAvailable() {
  return !!(wx.obs && typeof wx.obs.event === 'function');
}

function isReady() {
  if (!isAvailable()) return false;
  if (_initialized) return true;
  const status = getStatus();
  return status === 'Collecting' || status === 'WaitingForFirstReport';
}

async function trySetup() {
  if (_initAttempted) return isReady();
  _initAttempted = true;

  if (!isAvailable()) return false;

  try {
    const status = getStatus();
    if (status === 'Collecting' || status === 'WaitingForFirstReport') {
      _initialized = true;
      return true;
    }

    if (status === 'NotSetup') {
      return false;
    }
  } catch (err) {
    Logger.debug(TAG, 'SDK状态检查失败', { error: err.message });
  }

  return false;
}

function reportEvent(eventName, properties = {}) {
  if (!isAvailable()) return false;
  // 必须至少走过一次 trySetup（`should not allow reporting events without setup attempt`
  // 锁定的契约）；但**不能**用一次性的 _initialized 判定可用性 ——
  // SDK 状态是动态的：首查 NotSetup 后状态稍后就绪时，
  // 一次性标记会让本会话的 view_cat / admin_* / GLOBAL_ERROR 上报全部被静默丢弃。
  // isReady() 会动态重查状态（setCustomId / setCustomProperties 已在用），口径统一。
  if (!_initAttempted) return false;
  if (!isReady()) return false;

  try {
    const filteredProps = {};
    let propCount = 0;
    for (const [key, value] of Object.entries(properties)) {
      if (propCount >= 10) break;
      if (key.length > 50) continue;
      if (typeof value === 'string') {
        if (value.length > 255) continue;
        filteredProps[key] = value;
        propCount++;
      } else if (typeof value === 'number' && Number.isInteger(value)) {
        filteredProps[key] = value;
        propCount++;
      } else if (typeof value === 'number') {
        filteredProps[key] = Math.round(value * 100);
        propCount++;
      } else if (typeof value === 'boolean') {
        filteredProps[key] = value ? 'true' : 'false';
        propCount++;
      }
    }

    const result = wx.obs.event(eventName, filteredProps);
    return result !== false;
  } catch (err) {
    return false;
  }
}

function setCustomId(userId) {
  if (!isReady()) return false;
  if (!userId || typeof userId !== 'string' || userId.length > 80) return false;

  try {
    wx.obs.setCustomId(userId);
    return true;
  } catch (err) {
    return false;
  }
}

function setCustomProperties(properties) {
  if (!isReady()) return false;

  try {
    const filteredProps = {};
    let propCount = 0;
    for (const [key, value] of Object.entries(properties)) {
      if (propCount >= 10) break;
      if (key.length > 50) continue;
      if (typeof value === 'string') {
        if (value.length > 255) continue;
        filteredProps[key] = value;
        propCount++;
      } else if (typeof value === 'number' && Number.isInteger(value)) {
        filteredProps[key] = value;
        propCount++;
      }
    }

    wx.obs.setCustomProperties(filteredProps);
    return true;
  } catch (err) {
    return false;
  }
}

function getSessionId() {
  if (!isAvailable()) return null;
  try {
    return wx.obs.getSessionId();
  } catch (err) {
    return null;
  }
}

function getStatus() {
  if (!isAvailable() || typeof wx.obs.getStatus !== 'function') return 'NotAvailable';
  try {
    return wx.obs.getStatus();
  } catch (err) {
    return 'Error';
  }
}

module.exports = {
  EVENT_NAMES,
  isAvailable,
  isReady,
  trySetup,
  reportEvent,
  setCustomId,
  setCustomProperties,
  getSessionId,
  getStatus
};
