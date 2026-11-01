/**
 * utils/guidance.js - 引导状态（欢迎屏 / 版本更新卡 / 全功能就地导览）
 *
 * 背景：3.8.2 把引导收进 guidance.v1，但只覆盖了首页两个入口。
 * 3.9.0 要求「所有功能都有引导，并且下个版本推给全部用户」：
 * 每个用户页面首次进入时按步骤就地演示一遍，老用户也不漏。
 *
 * 状态升级到 guidance.v2：
 *
 *   onboarding  欢迎屏是否完成、是否跳过
 *   releases    版本更新卡：已看到哪个版本、看过哪些条目
 *   tours       本轮全量引导：campaignId + 每个页面是否讲完
 *
 * campaign.id 变化 = 新一轮全量引导：pages 清空，所有用户重新各看一遍。
 * 旧 key guidance.v1 只读一次做迁移；旧 coach.seen 不再使用 ——
 * 否则看过首页两个高亮的老用户会漏掉这一轮全部功能导览。
 *
 * 所有读写都吞异常：存储不可用（隐私模式/配额满）时引导失效，
 * 但绝不能因此阻断页面业务。
 */
const config = require('../config');

const STORAGE_KEY = 'guidance.v2';
const LEGACY_STORAGE_KEY = 'guidance.v1';
const LEGACY_ONBOARDED_KEY = 'hasOnboarded';
const REPLAY_KEY = 'guidance.replay';
const REPLAY_TTL = 5 * 60 * 1000;

function now() {
  return Date.now();
}

function activeCampaign() {
  const guidanceConfig = config.guidance;
  if (!guidanceConfig || guidanceConfig.enabled === false) return null;
  const campaign = guidanceConfig.campaign;
  if (!campaign || !campaign.id) return null;
  return campaign;
}

function createDefaultState() {
  return {
    version: 2,
    onboarding: { completedAt: 0, skipped: false },
    releases: { lastSeenVersion: '', seenIds: [] },
    tours: { campaignId: '', startedAt: 0, pages: {} }
  };
}

function normalizePages(raw) {
  const pages = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return pages;

  Object.keys(raw).forEach(page => {
    const entry = raw[page];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const completedAt = Number(entry.completedAt) || 0;
    if (!completedAt) return;
    pages[page] = {
      completedAt,
      skipped: !!entry.skipped,
      steps: Number(entry.steps) || 0
    };
  });
  return pages;
}

function normalizeState(raw) {
  const state = createDefaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;

  const onboarding = raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {};
  const releases = raw.releases && typeof raw.releases === 'object' ? raw.releases : {};
  const tours = raw.tours && typeof raw.tours === 'object' ? raw.tours : {};

  state.onboarding.completedAt = Number(onboarding.completedAt) || 0;
  state.onboarding.skipped = !!onboarding.skipped;

  state.releases.lastSeenVersion = typeof releases.lastSeenVersion === 'string'
    ? releases.lastSeenVersion
    : '';
  state.releases.seenIds = Array.isArray(releases.seenIds)
    ? releases.seenIds.filter(id => typeof id === 'string' && id)
    : [];

  state.tours.campaignId = typeof tours.campaignId === 'string' ? tours.campaignId : '';
  state.tours.startedAt = Number(tours.startedAt) || 0;
  state.tours.pages = normalizePages(tours.pages);

  return state;
}

/**
 * 读状态：优先 v2；没有就退回 v1 做一次迁移（保留欢迎完成与更新卡进度）。
 * v1 里的 coach.seen 刻意丢弃，让这一轮全功能导览对所有人生效。
 */
function readState() {
  try {
    const current = wx.getStorageSync(STORAGE_KEY);
    if (current && typeof current === 'object') return normalizeState(current);
  } catch (e) {
    return createDefaultState();
  }

  try {
    const legacy = wx.getStorageSync(LEGACY_STORAGE_KEY);
    if (legacy && typeof legacy === 'object') return normalizeState(legacy);
  } catch (e) {
    // 存储不可用：按全新用户处理，但后面的写失败也不会阻断页面
  }

  return createDefaultState();
}

function writeState(state) {
  try {
    wx.setStorageSync(STORAGE_KEY, state);
  } catch (e) {
    // 存储不可用：本次会话照常走完，只是下次会重新引导一次
  }
  return state;
}

function migrateLegacyOnboarded(state) {
  if (state.onboarding.completedAt > 0) return { state, changed: false };

  let onboarded = false;
  try {
    onboarded = !!wx.getStorageSync(LEGACY_ONBOARDED_KEY);
  } catch (e) {
    onboarded = false;
  }

  if (!onboarded) return { state, changed: false };

  state.onboarding.completedAt = now();
  return { state, changed: true };
}

/**
 * campaign 变了就把 pages 清空：旧用户不会被上一轮的「已看过」挡住。
 * 只清页面进度，不动欢迎屏和更新卡。
 */
function ensureCampaign(state) {
  const campaign = activeCampaign();
  if (!campaign) return { state, changed: false };
  if (state.tours.campaignId === campaign.id) return { state, changed: false };

  state.tours.campaignId = campaign.id;
  state.tours.startedAt = now();
  state.tours.pages = {};
  return { state, changed: true };
}

function loadState() {
  let state = readState();
  let changed = false;

  const migrated = migrateLegacyOnboarded(state);
  state = migrated.state;
  changed = changed || migrated.changed;

  const campaign = ensureCampaign(state);
  state = campaign.state;
  changed = changed || campaign.changed;

  if (changed) writeState(state);
  return state;
}

/**
 * 语义化版本比较（只比较数字段，够用且不引依赖）。
 * compareVersion('3.8.1', '3.8.0') === 1
 */
function compareVersion(a, b) {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function hasCompletedOnboarding() {
  return loadState().onboarding.completedAt > 0;
}

/**
 * 标记欢迎屏结束。
 * - 新用户：把 lastSeenVersion 钉在当前版本，避免刚看完欢迎又弹历史更新卡
 * - 老用户（迁移来的 completedAt 已存在）：不动 lastSeenVersion，让他们补看一次
 */
function markOnboardingComplete(options = {}) {
  const state = loadState();
  if (!state.onboarding.completedAt) {
    state.onboarding.completedAt = now();
    if (!state.releases.lastSeenVersion) {
      state.releases.lastSeenVersion = config.version || '0.0.0';
    }
  }
  state.onboarding.skipped = !!options.skipped;
  return writeState(state);
}

function releaseId(release) {
  if (!release) return '';
  return release.id || (release.version ? `release-${release.version}` : '');
}

/**
 * 从配置里挑一条「用户还没看过的最新版本」。
 * 只看版本号高于 lastSeenVersion 且没在 seenIds 里的条目；
 * 调用方负责一次会话最多展示一条。
 */
function getPendingRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;

  const state = loadState();
  const lastSeen = state.releases.lastSeenVersion || '';
  const seenIds = state.releases.seenIds || [];

  const candidates = releases
    .filter(release => release
      && typeof release.version === 'string'
      && Array.isArray(release.items)
      && release.items.length > 0)
    .filter(release => !seenIds.includes(releaseId(release)))
    .filter(release => compareVersion(release.version, lastSeen) > 0)
    .sort((a, b) => compareVersion(b.version, a.version));

  return candidates[0] || null;
}

function markReleaseSeen(release) {
  const state = loadState();
  const id = releaseId(release);
  if (!id) return state;

  if (!state.releases.seenIds.includes(id)) {
    state.releases.seenIds.push(id);
  }
  if (compareVersion(release.version, state.releases.lastSeenVersion) > 0) {
    state.releases.lastSeenVersion = release.version;
  }
  return writeState(state);
}

function featureEnabled(features, key) {
  if (!key) return true;
  if (!features || !(key in features)) return true;
  return features[key] !== false;
}

/** 功能开关快照：公开核心版没有需要按功能隐藏的导览，保留空对象以兼容调用方。 */
function getFeatureFlags() {
  return {};
}

function isTourPageDone(page) {
  if (!page) return true;
  const state = loadState();
  const entry = state.tours.pages[page];
  return !!(entry && entry.completedAt > 0);
}

/**
 * 取某页还没讲完的导览。
 * - campaign 未配置或已讲完 → null
 * - tour.feature / step.feature 为 false 时整条或该步不参与
 * - steps 里没有 selector/title/desc 的条目直接剔除，避免运行时空白气泡
 */
function getTourForPage(page, features = {}) {
  if (!page || !activeCampaign()) return null;

  const cfg = config.guidance || {};
  const tour = (cfg.tours || []).find(item => item
    && item.page === page
    && Array.isArray(item.steps)
    && item.steps.length > 0);

  if (!tour) return null;
  if (!featureEnabled(features, tour.feature)) return null;
  if (isTourPageDone(page)) return null;

  const steps = tour.steps.filter(step => step
    && step.id
    && step.selector
    && step.title
    && step.desc
    && featureEnabled(features, step.feature));

  if (!steps.length) return null;
  return { ...tour, steps };
}

function markTourPageDone(page, options = {}) {
  if (!page) return loadState();
  const state = loadState();
  state.tours.pages[page] = {
    completedAt: now(),
    skipped: !!options.skipped,
    steps: Number(options.steps) || 0
  };
  return writeState(state);
}

/**
 * 用户点「全部跳过」：把本轮所有页面一次性记为已看过。
 * 之后仍可在「使用帮助 → 功能导览」逐页重播（重播会 resetTourPage）。
 */
function markAllToursDone(options = {}) {
  const cfg = config.guidance || {};
  const state = loadState();
  const stamp = now();
  (cfg.tours || []).forEach(tour => {
    if (!tour || !tour.page) return;
    state.tours.pages[tour.page] = {
      completedAt: stamp,
      skipped: !!options.skipped,
      steps: 0
    };
  });
  return writeState(state);
}

/** 导览中心「看一遍」：只清这一页的完成记录。 */
function resetTourPage(page) {
  if (!page) return false;
  const state = loadState();
  if (!state.tours.pages[page]) return false;
  delete state.tours.pages[page];
  writeState(state);
  return true;
}

/**
 * 跨页重播请求：帮助页写入，目标页 onShow 时消费一次。
 * 单独用 key，避免把一次性动作写进主状态导致并发覆盖。
 */
function requestTourReplay(page) {
  if (!page) return false;
  try {
    wx.setStorageSync(REPLAY_KEY, { page, at: now() });
    return true;
  } catch (e) {
    return false;
  }
}

function consumeTourReplay(page) {
  if (!page) return false;
  try {
    const raw = wx.getStorageSync(REPLAY_KEY);
    if (!raw || typeof raw !== 'object' || raw.page !== page) return false;

    try {
      wx.removeStorageSync(REPLAY_KEY);
    } catch (e) {
      // 清不掉也不影响本次消费
    }

    const at = Number(raw.at) || 0;
    return at > 0 && now() - at <= REPLAY_TTL;
  } catch (e) {
    return false;
  }
}

/** 导览中心列表：保持 config 里的顺序，按功能开关过滤。 */
function getTourList(features = {}) {
  const cfg = config.guidance || {};
  if (cfg.enabled === false) return [];
  return (cfg.tours || [])
    .filter(tour => tour && tour.page && tour.label)
    .filter(tour => featureEnabled(features, tour.feature))
    .map(tour => ({
      id: tour.id,
      page: tour.page,
      label: tour.label,
      desc: tour.desc || '',
      group: tour.group || '其他',
      replayable: tour.replayable !== false
    }));
}

/**
 * 「使用帮助 → 功能入口」数据：即使页面内导览关闭也照常可用。
 * 只取入口信息，不带 selector / steps，避免把内部配置暴露给页面。
 */
function getEntryList(features = {}) {
  const cfg = config.guidance || {};
  return (cfg.tours || [])
    .filter(tour => tour && tour.page && tour.label)
    .filter(tour => featureEnabled(features, tour.feature))
    .map(tour => ({
      id: tour.id,
      page: tour.page,
      label: tour.label,
      desc: tour.desc || '',
      group: tour.group || '其他'
    }));
}

/** 帮助页展示进度：本轮已讲完的页面数 / 配置里的页面数。 */
function getTourProgress(features = {}) {
  const state = loadState();
  const list = getTourList(features);
  const done = list.filter(tour => {
    const entry = state.tours.pages[tour.page];
    return !!(entry && entry.completedAt > 0);
  }).length;
  return { done, total: list.length };
}

module.exports = {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  LEGACY_ONBOARDED_KEY,
  REPLAY_KEY,
  compareVersion,
  loadState,
  hasCompletedOnboarding,
  markOnboardingComplete,
  getPendingRelease,
  markReleaseSeen,
  isTourPageDone,
  getTourForPage,
  markTourPageDone,
  markAllToursDone,
  resetTourPage,
  requestTourReplay,
  consumeTourReplay,
  getFeatureFlags,
  getTourList,
  getEntryList,
  getTourProgress
};
