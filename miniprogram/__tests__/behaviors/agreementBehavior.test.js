jest.mock('../../utils/guidance', () => ({
  hasCompletedOnboarding: jest.fn(() => false),
  markOnboardingComplete: jest.fn()
}));

jest.mock('../../utils/obsHelper', () => ({
  EVENT_NAMES: {
    ONBOARDING_VIEW: 'onboarding_view',
    ONBOARDING_COMPLETE: 'onboarding_complete',
    ONBOARDING_SKIP: 'onboarding_skip'
  },
  reportEvent: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

const guidance = require('../../utils/guidance');
const obsHelper = require('../../utils/obsHelper');
const { Logger } = require('../../utils/logger');
const agreementBehavior = require('../../behaviors/agreementBehavior');

function createMockContext() {
  const ctx = {
    data: JSON.parse(JSON.stringify(agreementBehavior.data)),
    setData: jest.fn(function(updates) {
      Object.keys(updates).forEach(key => {
        const parts = key.split('.');
        if (parts.length === 2) {
          this.data[parts[0]][parts[1]] = updates[key];
        } else {
          this.data[key] = updates[key];
        }
      });
    })
  };
  Object.assign(ctx, agreementBehavior.methods);
  return ctx;
}

describe('agreementBehavior', () => {
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    guidance.hasCompletedOnboarding.mockReturnValue(false);
    ctx = createMockContext();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('data', () => {
    test('should have agreementModal with show false', () => {
      expect(agreementBehavior.data.agreementModal.show).toBe(false);
    });

    test('should have agreementModal with showDetail false', () => {
      expect(agreementBehavior.data.agreementModal.showDetail).toBe(false);
    });

    test('should have agreementModal with briefContent string', () => {
      expect(typeof agreementBehavior.data.agreementModal.briefContent).toBe('string');
      expect(agreementBehavior.data.agreementModal.briefContent.length).toBeGreaterThan(0);
    });

    test('should have agreementModal with detailContent string', () => {
      expect(typeof agreementBehavior.data.agreementModal.detailContent).toBe('string');
      expect(agreementBehavior.data.agreementModal.detailContent.length).toBeGreaterThan(0);
    });

    test('should have welcomeModal.show initialized as false', () => {
      expect(agreementBehavior.data.welcomeModal.show).toBe(false);
    });

    test('should not keep the old 4-step onboarding data', () => {
      expect(agreementBehavior.data.onboardingSteps).toBeUndefined();
      expect(agreementBehavior.data.showOnboarding).toBeUndefined();
    });
  });

  describe('checkAgreement', () => {
    test('should show agreement modal when user has not agreed', () => {
      wx.getStorageSync.mockReturnValue('');
      const showSpy = jest.spyOn(ctx, 'showAgreementModal');
      ctx.checkAgreement();
      expect(showSpy).toHaveBeenCalled();
      showSpy.mockRestore();
    });

    test('should not show agreement modal when user has already agreed', () => {
      wx.getStorageSync.mockReturnValue(true);
      const showSpy = jest.spyOn(ctx, 'showAgreementModal');
      ctx.checkAgreement();
      expect(showSpy).not.toHaveBeenCalled();
      showSpy.mockRestore();
    });

    test('should check wx.getStorageSync with agreementAgreed key', () => {
      wx.getStorageSync.mockReturnValue('');
      ctx.checkAgreement();
      expect(wx.getStorageSync).toHaveBeenCalledWith('agreementAgreed');
    });
  });

  describe('showAgreementModal', () => {
    test('should set agreementModal.show to true', () => {
      ctx.showAgreementModal();
      expect(ctx.setData).toHaveBeenCalledWith({
        'agreementModal.show': true,
        'agreementModal.showDetail': false
      });
    });

    test('should reset showDetail to false when showing modal', () => {
      ctx.data.agreementModal.showDetail = true;
      ctx.showAgreementModal();
      expect(ctx.setData).toHaveBeenCalledWith({
        'agreementModal.show': true,
        'agreementModal.showDetail': false
      });
    });
  });

  describe('onAgreementConfirm', () => {
    test('should save agreement to storage', () => {
      ctx.onAgreementConfirm();
      expect(wx.setStorageSync).toHaveBeenCalledWith('agreementAgreed', true);
    });

    test('should hide the agreement modal', () => {
      ctx.onAgreementConfirm();
      expect(ctx.setData).toHaveBeenCalledWith({
        'agreementModal.show': false,
        'agreementModal.showDetail': false
      });
    });

    test('should start welcome when onboarding is not completed', () => {
      const startSpy = jest.spyOn(ctx, '_startWelcomeIfNeeded');
      ctx.onAgreementConfirm();
      expect(startSpy).toHaveBeenCalled();
      startSpy.mockRestore();
    });
  });

  describe('onAgreementCancelDispatch', () => {
    test('should open detail when currently showing brief', () => {
      ctx.onAgreementCancelDispatch();
      expect(ctx.setData).toHaveBeenCalledWith({ 'agreementModal.showDetail': true });
    });

    test('should go back to brief when currently showing detail', () => {
      ctx.data.agreementModal.showDetail = true;
      ctx.onAgreementCancelDispatch();
      expect(ctx.setData).toHaveBeenCalledWith({ 'agreementModal.showDetail': false });
    });
  });

  describe('onAgreementCancel', () => {
    test('should close the agreement modal', () => {
      ctx.onAgreementCancel();
      expect(ctx.setData).toHaveBeenCalledWith({
        'agreementModal.show': false,
        'agreementModal.showDetail': false
      });
    });
  });

  describe('_startWelcomeIfNeeded', () => {
    test('should show the one-screen welcome after the delay', () => {
      ctx._startWelcomeIfNeeded();
      expect(ctx.setData).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);

      expect(ctx.setData).toHaveBeenCalledWith({ 'welcomeModal.show': true });
      expect(obsHelper.reportEvent).toHaveBeenCalledWith('onboarding_view', {});
    });

    test('should not show welcome when onboarding already completed', () => {
      guidance.hasCompletedOnboarding.mockReturnValue(true);
      ctx._startWelcomeIfNeeded();
      jest.advanceTimersByTime(300);
      expect(ctx.setData).not.toHaveBeenCalled();
      expect(obsHelper.reportEvent).not.toHaveBeenCalled();
    });
  });

  describe('onWelcomeConfirm', () => {
    test('should hide welcome and persist completion', () => {
      ctx.onWelcomeConfirm();
      expect(ctx.setData).toHaveBeenCalledWith({ 'welcomeModal.show': false });
      expect(guidance.markOnboardingComplete).toHaveBeenCalledWith({ skipped: false });
      expect(obsHelper.reportEvent).toHaveBeenCalledWith('onboarding_complete', { skipped: false });
    });

    test('should show welcome toast and log completion', () => {
      ctx.onWelcomeConfirm();
      expect(wx.showToast).toHaveBeenCalledWith({
        title: '欢迎使用！开始探索吧~',
        icon: 'none',
        duration: 2000
      });
      expect(Logger.info).toHaveBeenCalledWith('index', '新用户欢迎引导完成');
    });
  });

  describe('onWelcomeSkip', () => {
    test('should hide welcome and persist skip flag', () => {
      ctx.onWelcomeSkip();
      expect(ctx.setData).toHaveBeenCalledWith({ 'welcomeModal.show': false });
      expect(guidance.markOnboardingComplete).toHaveBeenCalledWith({ skipped: true });
      expect(obsHelper.reportEvent).toHaveBeenCalledWith('onboarding_skip', { skipped: true });
    });

    test('should not show the welcome toast when skipped', () => {
      ctx.onWelcomeSkip();
      expect(wx.showToast).not.toHaveBeenCalled();
    });
  });
});
