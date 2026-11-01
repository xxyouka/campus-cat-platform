const config = require('../../config');
const guidance = require('../../utils/guidance');

describe('utils/guidance', () => {
  let store;

  beforeEach(() => {
    store = {};
    wx.getStorageSync.mockImplementation(key => {
      return store[key] === undefined ? '' : store[key];
    });
    wx.setStorageSync.mockImplementation((key, value) => { store[key] = value; });
    wx.removeStorageSync.mockImplementation(key => { delete store[key]; });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('loadState', () => {
    test('returns defaults with the active campaign when nothing is stored', () => {
      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBe(0);
      expect(state.releases.lastSeenVersion).toBe('');
      expect(state.releases.seenIds).toEqual([]);
      // 页面内导览关闭时 campaign 不初始化；功能入口仍由 getEntryList 提供
      expect(state.tours.campaignId).toBe('');
      expect(state.tours.pages).toEqual({});
    });

    test('ignores malformed stored values', () => {
      store[guidance.STORAGE_KEY] = 'not-an-object';
      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBe(0);
    });

    test('normalizes partial stored state', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 'abc' },
        releases: { seenIds: ['ok', 123, ''] },
        tours: {
          campaignId: config.guidance.campaign.id,
          pages: {
            'pages/index/index': { completedAt: 'x' },
            'pages/rank/rank': { completedAt: 123, skipped: true, steps: '2' }
          }
        }
      };
      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBe(0);
      expect(state.releases.seenIds).toEqual(['ok']);
      expect(state.tours.pages['pages/index/index']).toBeUndefined();
      expect(state.tours.pages['pages/rank/rank']).toEqual({
        completedAt: 123,
        skipped: true,
        steps: 2
      });
    });
  });

  describe('migration', () => {
    test('migrates guidance.v1 onboarding and release state without carrying coach.seen', () => {
      store[guidance.LEGACY_STORAGE_KEY] = {
        onboarding: { completedAt: 123, skipped: true },
        releases: { lastSeenVersion: '3.8.4', seenIds: ['release-3.8.4'] },
        coach: { seen: { 'index-face': 1 } }
      };

      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBe(123);
      expect(state.onboarding.skipped).toBe(true);
      expect(state.releases.lastSeenVersion).toBe('3.8.4');
      expect(state.tours.campaignId).toBe('');
      expect(state.tours.pages).toEqual({});
    });

    test('migrates hasOnboarded=true without losing completion', () => {
      store[guidance.LEGACY_ONBOARDED_KEY] = true;
      expect(guidance.hasCompletedOnboarding()).toBe(true);
      expect(store[guidance.STORAGE_KEY].onboarding.completedAt).toBeGreaterThan(0);
    });

    test('keeps lastSeenVersion empty for migrated users so they see one release card', () => {
      store[guidance.LEGACY_ONBOARDED_KEY] = true;
      const state = guidance.loadState();
      expect(state.releases.lastSeenVersion).toBe('');
    });

    test('does not override an existing guidance state', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 123, skipped: true },
        releases: { lastSeenVersion: '3.8.0', seenIds: [] },
        tours: { campaignId: config.guidance.campaign.id, startedAt: 1, pages: {} }
      };
      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBe(123);
      expect(state.releases.lastSeenVersion).toBe('3.8.0');
    });
  });

  describe('campaign', () => {
    beforeEach(() => {
      config.guidance.enabled = true;
    });

    afterEach(() => {
      config.guidance.enabled = false;
    });

    test('a new campaign clears page progress for every user', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.9.0', seenIds: [] },
        tours: {
          campaignId: 'guide-old',
          startedAt: 1,
          pages: { 'pages/index/index': { completedAt: 2, skipped: false, steps: 5 } }
        }
      };

      const state = guidance.loadState();
      expect(state.tours.campaignId).toBe(config.guidance.campaign.id);
      expect(state.tours.pages).toEqual({});
      expect(state.tours.startedAt).toBeGreaterThan(0);
    });

    test('same campaign keeps page progress', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.9.0', seenIds: [] },
        tours: {
          campaignId: config.guidance.campaign.id,
          startedAt: 1,
          pages: { 'pages/index/index': { completedAt: 2, skipped: false, steps: 5 } }
        }
      };

      const state = guidance.loadState();
      expect(state.tours.pages['pages/index/index'].completedAt).toBe(2);
    });
  });

  describe('markOnboardingComplete', () => {
    test('new user starts from the current version (no historical release card)', () => {
      guidance.markOnboardingComplete({ skipped: false });
      const state = guidance.loadState();
      expect(state.onboarding.completedAt).toBeGreaterThan(0);
      expect(state.onboarding.skipped).toBe(false);
      expect(state.releases.lastSeenVersion).toBe(config.version);
    });

    test('migrated user keeps empty lastSeenVersion so the release card is not skipped', () => {
      store[guidance.LEGACY_ONBOARDED_KEY] = true;
      guidance.markOnboardingComplete({ skipped: true });
      const state = guidance.loadState();
      expect(state.releases.lastSeenVersion).toBe('');
      expect(state.onboarding.skipped).toBe(true);
    });

    test('does not move completedAt on repeated calls', () => {
      guidance.markOnboardingComplete();
      const first = guidance.loadState().onboarding.completedAt;
      guidance.markOnboardingComplete({ skipped: true });
      const second = guidance.loadState().onboarding.completedAt;
      expect(second).toBe(first);
      expect(guidance.loadState().onboarding.skipped).toBe(true);
    });
  });

  describe('compareVersion', () => {
    test.each([
      ['3.8.1', '3.8.0', 1],
      ['3.8.0', '3.8.1', -1],
      ['3.8', '3.8.0', 0],
      ['3.9.0', '3.10.0', -1],
      ['', '0.0.1', -1]
    ])('compareVersion(%s, %s) === %i', (a, b, expected) => {
      expect(guidance.compareVersion(a, b)).toBe(expected);
    });
  });

  describe('getPendingRelease', () => {
    const releases = [
      { version: '3.7.8', title: '地图', items: [{ text: '校园地图' }] },
      { version: '3.8.0', title: '功能更新', items: [{ text: '新功能' }] },
      { version: '3.8.1', title: '分享', items: [{ text: '统一分享' }] }
    ];

    test('returns null without releases', () => {
      expect(guidance.getPendingRelease(null)).toBeNull();
      expect(guidance.getPendingRelease([])).toBeNull();
    });

    test('returns the newest release above lastSeenVersion', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.7.9', seenIds: [] },
        tours: { campaignId: config.guidance.campaign.id, startedAt: 1, pages: {} }
      };
      const pending = guidance.getPendingRelease(releases);
      expect(pending.version).toBe('3.8.1');
    });

    test('skips releases already recorded in seenIds', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.7.9', seenIds: ['release-3.8.1'] },
        tours: { campaignId: config.guidance.campaign.id, startedAt: 1, pages: {} }
      };
      expect(guidance.getPendingRelease(releases).version).toBe('3.8.0');
    });

    test('ignores malformed releases and those without items', () => {
      const pending = guidance.getPendingRelease([
        { version: '3.9.0', items: [] },
        { title: 'no version', items: [{ text: 'x' }] },
        { version: '3.8.0', items: [{ text: 'ok' }] }
      ]);
      expect(pending.version).toBe('3.8.0');
    });

    test('returns null when everything is already seen', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.8.1', seenIds: [] },
        tours: { campaignId: config.guidance.campaign.id, startedAt: 1, pages: {} }
      };
      expect(guidance.getPendingRelease(releases)).toBeNull();
    });
  });

  describe('markReleaseSeen', () => {
    test('records the id and moves lastSeenVersion forward', () => {
      guidance.markReleaseSeen({ version: '3.8.0', items: [{ text: 'x' }] });
      const state = guidance.loadState();
      expect(state.releases.seenIds).toContain('release-3.8.0');
      expect(state.releases.lastSeenVersion).toBe('3.8.0');
    });

    test('does not move lastSeenVersion backwards', () => {
      store[guidance.STORAGE_KEY] = {
        onboarding: { completedAt: 1 },
        releases: { lastSeenVersion: '3.9.0', seenIds: [] },
        tours: { campaignId: config.guidance.campaign.id, startedAt: 1, pages: {} }
      };
      guidance.markReleaseSeen({ version: '3.8.0', items: [{ text: 'x' }] });
      expect(guidance.loadState().releases.lastSeenVersion).toBe('3.9.0');
    });

    test('ignores an empty release', () => {
      expect(guidance.markReleaseSeen(null)).toBeTruthy();
    });
  });

  describe('tours', () => {
    beforeEach(() => {
      config.guidance.enabled = true;
    });

    afterEach(() => {
      config.guidance.enabled = false;
    });

    test('returns the page tour with all enabled steps', () => {
      const tour = guidance.getTourForPage('pages/index/index');
      expect(tour.page).toBe('pages/index/index');
      expect(tour.steps.length).toBe(2);
      expect(tour.steps[0]).toEqual(expect.objectContaining({
        selector: '#coach-index-search',
        title: '找猫，先搜一下'
      }));
    });

    test('removed feature pages have no tour', () => {
      expect(guidance.getTourForPage('subpackages/support/shop/shop')).toBeNull();
      expect(guidance.getTourForPage('subpackages/feedback/identify/identify')).toBeNull();
    });

    test('returns null for unknown or exempt pages', () => {
      expect(guidance.getTourForPage('pages/nowhere/nowhere')).toBeNull();
      expect(guidance.getTourForPage('pages/privacy/privacy')).toBeNull();
      expect(guidance.getTourForPage('')).toBeNull();
    });

    test('markTourPageDone records steps/skipped and blocks the next visit', () => {
      guidance.markTourPageDone('pages/index/index', { skipped: true, steps: 3 });
      const state = guidance.loadState();
      expect(state.tours.pages['pages/index/index'].skipped).toBe(true);
      expect(state.tours.pages['pages/index/index'].steps).toBe(3);
      expect(guidance.isTourPageDone('pages/index/index')).toBe(true);
      expect(guidance.getTourForPage('pages/index/index')).toBeNull();
    });

    test('resetTourPage makes an already-seen page available again', () => {
      guidance.markTourPageDone('pages/rank/rank', { steps: 2 });
      expect(guidance.resetTourPage('pages/rank/rank')).toBe(true);
      expect(guidance.isTourPageDone('pages/rank/rank')).toBe(false);
      expect(guidance.getTourForPage('pages/rank/rank')).toBeTruthy();
    });

    test('getTourList excludes removed pages and keeps config order', () => {
      const list = guidance.getTourList();
      expect(list.some(tour => tour.page === 'subpackages/support/shop/shop')).toBe(false);
      expect(list.some(tour => tour.page === 'subpackages/support/rescue/rescue')).toBe(false);
      expect(list.some(tour => tour.page === 'subpackages/feedback/identify/identify')).toBe(false);
      expect(list[0].page).toBe('pages/index/index');
      expect(list.every(tour => typeof tour.replayable === 'boolean')).toBe(true);
    });

    test('getTourProgress counts completed pages', () => {
      guidance.markTourPageDone('pages/rank/rank', { steps: 2 });
      const progress = guidance.getTourProgress();
      expect(progress.done).toBe(1);
      expect(progress.total).toBeGreaterThan(1);
    });

    test('markAllToursDone marks every configured page and keeps replay possible', () => {
      guidance.markAllToursDone({ skipped: true });
      const list = guidance.getTourList();
      expect(list.length).toBeGreaterThan(0);
      list.forEach(tour => {
        expect(guidance.isTourPageDone(tour.page)).toBe(true);
        expect(guidance.getTourForPage(tour.page)).toBeNull();
      });
      expect(guidance.resetTourPage(list[0].page)).toBe(true);
      expect(guidance.getTourForPage(list[0].page)).toBeTruthy();
    });

    test('enabled=false disables page tours but keeps onboarding/releases working', () => {
      const original = config.guidance.enabled;
      config.guidance.enabled = false;
      try {
        expect(guidance.getTourForPage('pages/index/index')).toBeNull();
        expect(guidance.getTourList()).toEqual([]);
        expect(guidance.getTourProgress()).toEqual({ done: 0, total: 0 });
        expect(guidance.hasCompletedOnboarding()).toBe(false);
      } finally {
        config.guidance.enabled = original;
      }
    });
  });

  describe('replay requests', () => {
    test('a request is consumed exactly once', () => {
      expect(guidance.requestTourReplay('pages/rank/rank')).toBe(true);
      expect(guidance.consumeTourReplay('pages/rank/rank')).toBe(true);
      expect(guidance.consumeTourReplay('pages/rank/rank')).toBe(false);
    });

    test('a request for another page is left untouched', () => {
      guidance.requestTourReplay('pages/rank/rank');
      expect(guidance.consumeTourReplay('pages/index/index')).toBe(false);
      expect(guidance.consumeTourReplay('pages/rank/rank')).toBe(true);
    });

    test('expired requests are rejected', () => {
      store[guidance.REPLAY_KEY] = {
        page: 'pages/rank/rank',
        at: Date.now() - 6 * 60 * 1000
      };
      expect(guidance.consumeTourReplay('pages/rank/rank')).toBe(false);
      expect(store[guidance.REPLAY_KEY]).toBeUndefined();
    });

    test('empty page keys are ignored', () => {
      expect(guidance.requestTourReplay('')).toBe(false);
      expect(guidance.consumeTourReplay('')).toBe(false);
    });
  });

  describe('entries', () => {
    test('功能入口不依赖页面内导览开关，且不包含已删除页面', () => {
      config.guidance.enabled = false;
      const list = guidance.getEntryList();
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toEqual(expect.objectContaining({
        page: 'pages/index/index',
        label: '首页图鉴',
        group: '开始'
      }));
      expect(list.some(entry => entry.page === 'subpackages/support/shop/shop')).toBe(false);
      expect(list.some(entry => entry.page === 'subpackages/support/rescue/rescue')).toBe(false);
      expect(list.some(entry => entry.page === 'subpackages/feedback/identify/identify')).toBe(false);
    });
  });

  describe('storage failures', () => {
    test('read failure falls back to defaults', () => {
      wx.getStorageSync.mockImplementation(() => { throw new Error('denied'); });
      expect(guidance.hasCompletedOnboarding()).toBe(false);
      expect(guidance.getEntryList().length).toBeGreaterThan(0);
    });

    test('write failure does not throw', () => {
      wx.setStorageSync.mockImplementation(() => { throw new Error('quota'); });
      expect(() => guidance.markOnboardingComplete()).not.toThrow();
      expect(() => guidance.markTourPageDone('pages/index/index', { steps: 1 })).not.toThrow();
      expect(() => guidance.markReleaseSeen({ version: '3.8.0' })).not.toThrow();
      expect(() => guidance.requestTourReplay('pages/index/index')).not.toThrow();
    });
  });
});
