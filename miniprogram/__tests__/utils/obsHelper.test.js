const {
  _EVENT_NAMES,
  _isAvailable,
  _isReady,
  _trySetup,
  _reportEvent,
  _setCustomId,
  _setCustomProperties,
  _getSessionId,
  _getStatus
} = require('../../utils/obsHelper');

function loadFresh() {
  jest.resetModules();
  return require('../../utils/obsHelper');
}

function mockObs(overrides = {}) {
  wx.obs = {
    event: jest.fn(() => true),
    getStatus: jest.fn(() => 'Collecting'),
    getSessionId: jest.fn(() => 'session-123'),
    setCustomId: jest.fn(),
    setCustomProperties: jest.fn(),
    ...overrides
  };
}

function clearObs() {
  delete wx.obs;
}

describe('obsHelper', () => {
  let obs;

  beforeEach(() => {
    clearObs();
    obs = loadFresh();
  });

  describe('EVENT_NAMES', () => {
    test('should contain all expected event name keys', () => {
      expect(obs.EVENT_NAMES).toHaveProperty('VIEW_CAT', 'view_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('SEARCH_CAT', 'search_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('FILTER_CAMPUS', 'filter_campus');
      expect(obs.EVENT_NAMES).toHaveProperty('MEET_CAT', 'meet_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('FAVORITE_CAT', 'favorite_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('SHARE_CAT', 'share_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('VIEW_GALLERY', 'view_gallery');      expect(obs.EVENT_NAMES).toHaveProperty('ADMIN_LOGIN', 'admin_login');
      expect(obs.EVENT_NAMES).toHaveProperty('ADMIN_ADD_CAT', 'admin_add_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('ADMIN_EDIT_CAT', 'admin_edit_cat');
      expect(obs.EVENT_NAMES).toHaveProperty('ADMIN_ADD_PHOTO', 'admin_add_photo');
      expect(obs.EVENT_NAMES).toHaveProperty('ONBOARDING_VIEW', 'onboarding_view');
      expect(obs.EVENT_NAMES).toHaveProperty('ONBOARDING_COMPLETE', 'onboarding_complete');
      expect(obs.EVENT_NAMES).toHaveProperty('ONBOARDING_SKIP', 'onboarding_skip');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDANCE_RELEASE_VIEW', 'guidance_release_view');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDANCE_RELEASE_CLICK', 'guidance_release_click');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_VIEW', 'guide_tour_view');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_STEP', 'guide_tour_step');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_SKIP', 'guide_tour_skip');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_COMPLETE', 'guide_tour_complete');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_MISSING', 'guide_tour_missing');
      expect(obs.EVENT_NAMES).toHaveProperty('GUIDE_TOUR_REPLAY', 'guide_tour_replay');
      expect(obs.EVENT_NAMES).toHaveProperty('COACH_VIEW', 'coach_view');
      expect(obs.EVENT_NAMES).toHaveProperty('COACH_SKIP', 'coach_skip');
      expect(obs.EVENT_NAMES).toHaveProperty('COACH_TARGET_TAP', 'coach_target_tap');
      expect(obs.EVENT_NAMES).toHaveProperty('HELP_VIEW', 'help_view');
      expect(obs.EVENT_NAMES).toHaveProperty('HELP_FAQ_EXPAND', 'help_faq_expand');
      expect(obs.EVENT_NAMES).toHaveProperty('FEATURE_FIRST_USE', 'feature_first_use');
      expect(obs.EVENT_NAMES).toHaveProperty('AGREEMENT_ACCEPT', 'agreement_accept');
    });

    test('should have 31 event names', () => {
      expect(Object.keys(obs.EVENT_NAMES)).toHaveLength(31);
    });
  });

  describe('isAvailable', () => {
    test('should return false when wx.obs is undefined', () => {
      expect(obs.isAvailable()).toBe(false);
    });

    test('should return false when wx.obs is null', () => {
      wx.obs = null;
      expect(obs.isAvailable()).toBe(false);
    });

    test('should return false when wx.obs.event is not a function', () => {
      wx.obs = { event: 'not-a-function' };
      expect(obs.isAvailable()).toBe(false);
    });

    test('should return false when wx.obs exists but event is missing', () => {
      wx.obs = {};
      expect(obs.isAvailable()).toBe(false);
    });

    test('should return true when wx.obs.event is a function', () => {
      mockObs();
      expect(obs.isAvailable()).toBe(true);
    });
  });

  describe('getStatus', () => {
    test('should return NotAvailable when wx.obs is undefined', () => {
      expect(obs.getStatus()).toBe('NotAvailable');
    });

    test('should return NotAvailable when wx.obs.getStatus is not a function', () => {
      wx.obs = { event: jest.fn() };
      expect(obs.getStatus()).toBe('NotAvailable');
    });

    test('should return status from wx.obs.getStatus', () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      expect(obs.getStatus()).toBe('Collecting');
    });

    test('should return WaitingForFirstReport status', () => {
      mockObs({ getStatus: jest.fn(() => 'WaitingForFirstReport') });
      expect(obs.getStatus()).toBe('WaitingForFirstReport');
    });

    test('should return NotSetup status', () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      expect(obs.getStatus()).toBe('NotSetup');
    });

    test('should return Error when wx.obs.getStatus throws', () => {
      mockObs({ getStatus: jest.fn(() => { throw new Error('fail'); }) });
      expect(obs.getStatus()).toBe('Error');
    });
  });

  describe('isReady', () => {
    test('should return false when obs is not available', () => {
      expect(obs.isReady()).toBe(false);
    });

    test('should return true when _initialized is true', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      expect(obs.isReady()).toBe(true);
    });

    test('should return true when status is Collecting and not yet initialized', () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      expect(obs.isReady()).toBe(true);
    });

    test('should return true when status is WaitingForFirstReport and not yet initialized', () => {
      mockObs({ getStatus: jest.fn(() => 'WaitingForFirstReport') });
      expect(obs.isReady()).toBe(true);
    });

    test('should return false when status is NotSetup', () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      expect(obs.isReady()).toBe(false);
    });

    test('should return false when status is NotAvailable', () => {
      mockObs({ getStatus: jest.fn(() => 'NotAvailable') });
      expect(obs.isReady()).toBe(false);
    });
  });

  describe('trySetup', () => {
    test('should return false when obs is not available', async () => {
      const result = await obs.trySetup();
      expect(result).toBe(false);
    });

    test('should return true and set _initialized when status is Collecting', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      const result = await obs.trySetup();
      expect(result).toBe(true);
      expect(obs.isReady()).toBe(true);
    });

    test('should return true and set _initialized when status is WaitingForFirstReport', async () => {
      mockObs({ getStatus: jest.fn(() => 'WaitingForFirstReport') });
      const result = await obs.trySetup();
      expect(result).toBe(true);
      expect(obs.isReady()).toBe(true);
    });

    test('should return false when status is NotSetup', async () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      const result = await obs.trySetup();
      expect(result).toBe(false);
    });

    test('should return false when getStatus throws', async () => {
      mockObs({ getStatus: jest.fn(() => { throw new Error('fail'); }) });
      const result = await obs.trySetup();
      expect(result).toBe(false);
    });

    test('should not attempt init again after first attempt', async () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      await obs.trySetup();
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      const result = await obs.trySetup();
      expect(result).toBe(true);
    });

    test('should return isReady() on second call if already attempted', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      const result = await obs.trySetup();
      expect(result).toBe(true);
    });

    test('should return false on second call when first attempt failed and obs still unavailable', async () => {
      clearObs();
      await obs.trySetup();
      const result = await obs.trySetup();
      expect(result).toBe(false);
    });
  });

  describe('reportEvent', () => {
    beforeEach(async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
    });

    test('should return false when obs is not available', () => {
      clearObs();
      expect(obs.reportEvent('test')).toBe(false);
    });

    test('should return false when not initialized', () => {
      const fresh = loadFresh();
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      expect(fresh.reportEvent('test')).toBe(false);
    });

    test('状态稍后就绪时也要上报（trySetup 首查未就绪不得整会话丢弃埋点）', async () => {
      // 先 trySetup：首查 NotSetup（_initialized 保持 false）
      const fresh = loadFresh();
      const getStatus = jest.fn(() => 'NotSetup');
      mockObs({ getStatus });
      await fresh.trySetup();

      // SDK 稍后就绪：reportEvent 必须动态放行
      //（GLOBAL_ERROR 等错误上报尤其不能整会话丢失）
      getStatus.mockReturnValue('Collecting');
      expect(fresh.reportEvent('view_cat', { name: 'kitty' })).toBe(true);
      expect(wx.obs.event).toHaveBeenCalledWith('view_cat', { name: 'kitty' });
    });

    test('should call wx.obs.event with event name and filtered properties', () => {
      obs.reportEvent('view_cat', { name: 'kitty' });
      expect(wx.obs.event).toHaveBeenCalledWith('view_cat', { name: 'kitty' });
    });

    test('should return true when wx.obs.event returns truthy', () => {
      wx.obs.event = jest.fn(() => true);
      expect(obs.reportEvent('view_cat')).toBe(true);
    });

    test('should return true when wx.obs.event returns undefined', () => {
      wx.obs.event = jest.fn(() => undefined);
      expect(obs.reportEvent('view_cat')).toBe(true);
    });

    test('should return false when wx.obs.event returns false', () => {
      wx.obs.event = jest.fn(() => false);
      expect(obs.reportEvent('view_cat')).toBe(false);
    });

    test('should return false when wx.obs.event throws', () => {
      wx.obs.event = jest.fn(() => { throw new Error('fail'); });
      expect(obs.reportEvent('view_cat')).toBe(false);
    });

    test('should filter string values longer than 255 characters', () => {
      const longVal = 'a'.repeat(256);
      obs.reportEvent('test', { short: 'ok', long: longVal });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { short: 'ok' });
    });

    test('should allow string values exactly 255 characters', () => {
      const val = 'a'.repeat(255);
      obs.reportEvent('test', { key: val });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { key: val });
    });

    test('should filter keys longer than 50 characters', () => {
      const longKey = 'k'.repeat(51);
      obs.reportEvent('test', { [longKey]: 'val', shortKey: 'val' });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { shortKey: 'val' });
    });

    test('should allow keys exactly 50 characters', () => {
      const key = 'k'.repeat(50);
      obs.reportEvent('test', { [key]: 'val' });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { [key]: 'val' });
    });

    test('should limit properties to 10', () => {
      const props = {};
      for (let i = 0; i < 15; i++) {
        props[`key${i}`] = `val${i}`;
      }
      obs.reportEvent('test', props);
      const calledProps = wx.obs.event.mock.calls[0][1];
      expect(Object.keys(calledProps)).toHaveLength(10);
    });

    test('should pass integer numbers as-is', () => {
      obs.reportEvent('test', { count: 42 });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { count: 42 });
    });

    test('should round floats by multiplying by 100', () => {
      obs.reportEvent('test', { ratio: 0.5 });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { ratio: 50 });
    });

    test('should round negative floats by multiplying by 100', () => {
      obs.reportEvent('test', { ratio: -0.25 });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { ratio: -25 });
    });

    test('should convert boolean true to string true', () => {
      obs.reportEvent('test', { active: true });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { active: 'true' });
    });

    test('should convert boolean false to string false', () => {
      obs.reportEvent('test', { active: false });
      expect(wx.obs.event).toHaveBeenCalledWith('test', { active: 'false' });
    });

    test('should skip unsupported value types', () => {
      obs.reportEvent('test', { obj: { a: 1 }, arr: [1, 2], nil: null, undef: undefined, fn: () => {} });
      expect(wx.obs.event).toHaveBeenCalledWith('test', {});
    });

    test('should use default empty object for properties', () => {
      obs.reportEvent('test');
      expect(wx.obs.event).toHaveBeenCalledWith('test', {});
    });

    test('should handle mixed valid and invalid properties', () => {
      obs.reportEvent('test', {
        name: 'kitty',
        count: 5,
        ratio: 0.3,
        active: true,
        bad: { nested: true }
      });
      expect(wx.obs.event).toHaveBeenCalledWith('test', {
        name: 'kitty',
        count: 5,
        ratio: 30,
        active: 'true'
      });
    });

    test('should count only included properties toward 10 limit', () => {
      const props = {};
      for (let i = 0; i < 8; i++) {
        props[`valid${i}`] = `val${i}`;
      }
      props.skipObj = { a: 1 };
      props.skipArr = [1];
      props.validExtra1 = 'extra1';
      props.validExtra2 = 'extra2';
      props.validExtra3 = 'extra3';
      obs.reportEvent('test', props);
      const calledProps = wx.obs.event.mock.calls[0][1];
      expect(Object.keys(calledProps)).toHaveLength(10);
    });
  });

  describe('setCustomId', () => {
    beforeEach(async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
    });

    test('should return false when not ready', () => {
      clearObs();
      const fresh = loadFresh();
      expect(fresh.setCustomId('user1')).toBe(false);
    });

    test('should return false when userId is not a string', () => {
      expect(obs.setCustomId(123)).toBe(false);
      expect(obs.setCustomId(null)).toBe(false);
      expect(obs.setCustomId(undefined)).toBe(false);
      expect(obs.setCustomId(true)).toBe(false);
      expect(obs.setCustomId({})).toBe(false);
    });

    test('should return false when userId is empty string', () => {
      expect(obs.setCustomId('')).toBe(false);
    });

    test('should return false when userId exceeds 80 characters', () => {
      expect(obs.setCustomId('a'.repeat(81))).toBe(false);
    });

    test('should accept userId exactly 80 characters', () => {
      expect(obs.setCustomId('a'.repeat(80))).toBe(true);
      expect(wx.obs.setCustomId).toHaveBeenCalledWith('a'.repeat(80));
    });

    test('should call wx.obs.setCustomId and return true for valid userId', () => {
      expect(obs.setCustomId('user123')).toBe(true);
      expect(wx.obs.setCustomId).toHaveBeenCalledWith('user123');
    });

    test('should return false when wx.obs.setCustomId throws', () => {
      wx.obs.setCustomId = jest.fn(() => { throw new Error('fail'); });
      expect(obs.setCustomId('user123')).toBe(false);
    });
  });

  describe('setCustomProperties', () => {
    beforeEach(async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
    });

    test('should return false when not ready', () => {
      clearObs();
      const fresh = loadFresh();
      expect(fresh.setCustomProperties({ a: 'b' })).toBe(false);
    });

    test('should call wx.obs.setCustomProperties with filtered props and return true', () => {
      obs.setCustomProperties({ name: 'test', count: 5 });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ name: 'test', count: 5 });
    });

    test('should filter string values longer than 255 characters', () => {
      const longVal = 'a'.repeat(256);
      obs.setCustomProperties({ short: 'ok', long: longVal });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ short: 'ok' });
    });

    test('should allow string values exactly 255 characters', () => {
      const val = 'a'.repeat(255);
      obs.setCustomProperties({ key: val });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ key: val });
    });

    test('should filter keys longer than 50 characters', () => {
      const longKey = 'k'.repeat(51);
      obs.setCustomProperties({ [longKey]: 'val', shortKey: 'val' });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ shortKey: 'val' });
    });

    test('should allow keys exactly 50 characters', () => {
      const key = 'k'.repeat(50);
      obs.setCustomProperties({ [key]: 'val' });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ [key]: 'val' });
    });

    test('should only allow integer numbers, skip floats', () => {
      obs.setCustomProperties({ count: 5, ratio: 0.5 });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ count: 5 });
    });

    test('should skip non-string non-integer values', () => {
      obs.setCustomProperties({
        name: 'test',
        active: true,
        data: { a: 1 },
        items: [1],
        nil: null
      });
      expect(wx.obs.setCustomProperties).toHaveBeenCalledWith({ name: 'test' });
    });

    test('should limit to 10 properties', () => {
      const props = {};
      for (let i = 0; i < 15; i++) {
        props[`key${i}`] = `val${i}`;
      }
      obs.setCustomProperties(props);
      const calledProps = wx.obs.setCustomProperties.mock.calls[0][0];
      expect(Object.keys(calledProps)).toHaveLength(10);
    });

    test('should return true on success', () => {
      expect(obs.setCustomProperties({ a: 'b' })).toBe(true);
    });

    test('should return false when wx.obs.setCustomProperties throws', () => {
      wx.obs.setCustomProperties = jest.fn(() => { throw new Error('fail'); });
      expect(obs.setCustomProperties({ a: 'b' })).toBe(false);
    });
  });

  describe('getSessionId', () => {
    test('should return null when obs is not available', () => {
      expect(obs.getSessionId()).toBeNull();
    });

    test('should return session id from wx.obs.getSessionId', () => {
      mockObs({ getSessionId: jest.fn(() => 'session-abc') });
      expect(obs.getSessionId()).toBe('session-abc');
    });

    test('should return null when wx.obs.getSessionId throws', () => {
      mockObs({ getSessionId: jest.fn(() => { throw new Error('fail'); }) });
      expect(obs.getSessionId()).toBeNull();
    });

    test('should return null when wx.obs.getSessionId returns null', () => {
      mockObs({ getSessionId: jest.fn(() => null) });
      expect(obs.getSessionId()).toBeNull();
    });
  });

  describe('state isolation between tests', () => {
    test('should reset _initialized between requires', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      expect(obs.isReady()).toBe(true);

      clearObs();
      const fresh = loadFresh();
      expect(fresh.isReady()).toBe(false);
    });

    test('should reset _initAttempted between requires', async () => {
      clearObs();
      await obs.trySetup();

      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      const fresh = loadFresh();
      const result = await fresh.trySetup();
      expect(result).toBe(true);
    });
  });

  describe('trySetup + reportEvent integration', () => {
    test('should allow reporting events after successful setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      expect(obs.reportEvent(obs.EVENT_NAMES.VIEW_CAT, { cat_id: '123' })).toBe(true);
      expect(wx.obs.event).toHaveBeenCalledWith('view_cat', { cat_id: '123' });
    });

    test('should not allow reporting events after failed setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      await obs.trySetup();
      expect(obs.reportEvent(obs.EVENT_NAMES.VIEW_CAT)).toBe(false);
    });

    test('should not allow reporting events without setup attempt', () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      expect(obs.reportEvent(obs.EVENT_NAMES.VIEW_CAT)).toBe(false);
    });
  });

  describe('trySetup + setCustomId integration', () => {
    test('should allow setting custom id after successful setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      expect(obs.setCustomId('user1')).toBe(true);
    });

    test('should not allow setting custom id after failed setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      await obs.trySetup();
      expect(obs.setCustomId('user1')).toBe(false);
    });
  });

  describe('trySetup + setCustomProperties integration', () => {
    test('should allow setting custom properties after successful setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'Collecting') });
      await obs.trySetup();
      expect(obs.setCustomProperties({ level: 'vip' })).toBe(true);
    });

    test('should not allow setting custom properties after failed setup', async () => {
      mockObs({ getStatus: jest.fn(() => 'NotSetup') });
      await obs.trySetup();
      expect(obs.setCustomProperties({ level: 'vip' })).toBe(false);
    });
  });
});
