// behaviors/agreementBehavior.js - 互动守则弹窗 + 1 屏欢迎引导
const { Logger } = require('../utils/logger');
const guidance = require('../utils/guidance');
const obsHelper = require('../utils/obsHelper');

// 守则弹窗关闭动画结束后再挂欢迎弹窗，避免两个蒙层同帧切换
const WELCOME_DELAY = 300;

module.exports = Behavior({
  data: {
    agreementModal: {
      show: false,
      showDetail: false,
      briefContent: '只喂猫粮 · 不用闪光灯 · 不追不闹\n\n温柔相处，做猫咪的守护者\n发现伤病猫咪请告知管理员',
      detailContent: '投喂须知\n  只喂猫粮，在指定投喂点投喂\n  人类食物可能伤害它们（尤其巧克力、葱类）\n  投喂后请随手清理，保持环境整洁\n\n相处须知\n  慢慢蹲下，让猫咪主动靠近你\n  轻声说话，不要大声喧哗\n  不抓尾巴、不抱肚子、不强抱\n  不追逐惊吓，给它们安全感\n\n隐私保护\n  不公开猫咪的具体栖息位置\n  尊重它们的生活规律和独处空间\n\n拍照礼仪\n  关闭闪光灯，保护猫咪眼睛\n  保持距离，不打扰休息中的猫咪\n  动作轻柔，记录自然状态最美\n\n紧急情况\n  发现受伤或生病猫咪，请告知管理员\n  遇到有攻击性的猫咪，保持距离慢慢离开\n\n每一份温柔，都让校园更美好'
    },
    welcomeModal: {
      show: false
    }
  },

  methods: {
    checkAgreement() {
      const agreed = wx.getStorageSync('agreementAgreed');
      if (!agreed) this.showAgreementModal();
    },

    showAgreementModal() {
      this.setData({ 'agreementModal.show': true, 'agreementModal.showDetail': false });
    },

    onAgreementConfirm() {
      wx.setStorageSync('agreementAgreed', true);
      this.setData({ 'agreementModal.show': false, 'agreementModal.showDetail': false });
      this._startWelcomeIfNeeded();
    },

    onAgreementCancelDispatch() {
      if (this.data.agreementModal.showDetail) {
        this.setData({ 'agreementModal.showDetail': false });
      } else {
        this.setData({ 'agreementModal.showDetail': true });
      }
    },

    onAgreementCancel() {
      this.setData({ 'agreementModal.show': false, 'agreementModal.showDetail': false });
    },

    /**
     * 守则同意后显示 1 屏欢迎。
     * 只在「从未完成过欢迎」时出现；已完成/已迁移的老用户直接跳过。
     * 具体功能位置不再写进欢迎文案，交给各页面的分步导览。
     */
    _startWelcomeIfNeeded() {
      if (guidance.hasCompletedOnboarding()) return;

      if (this._welcomeTimer) clearTimeout(this._welcomeTimer);
      this._welcomeTimer = setTimeout(() => {
        this._welcomeTimer = null;
        this.setData({ 'welcomeModal.show': true });
        obsHelper.reportEvent(obsHelper.EVENT_NAMES.ONBOARDING_VIEW, {});
      }, WELCOME_DELAY);
    },

    onWelcomeConfirm() {
      this._finishWelcome(false);
    },

    onWelcomeSkip() {
      this._finishWelcome(true);
    },

    _finishWelcome(skipped) {
      this.setData({ 'welcomeModal.show': false });
      guidance.markOnboardingComplete({ skipped });
      obsHelper.reportEvent(
        skipped
          ? obsHelper.EVENT_NAMES.ONBOARDING_SKIP
          : obsHelper.EVENT_NAMES.ONBOARDING_COMPLETE,
        { skipped }
      );
      Logger.info('index', skipped ? '新用户跳过欢迎引导' : '新用户欢迎引导完成');

      // 欢迎屏让位后再接首页全功能导览
      if (typeof this.scheduleGuideTour === 'function') {
        this.scheduleGuideTour(500);
      }

      if (!skipped) {
        wx.showToast({ title: '欢迎使用！开始探索吧~', icon: 'none', duration: 2000 });
      }
    }
  }
});
