// behaviors/guideTourBehavior.js - 全功能分步导览（页面级）
//
// 每个用户页面在 onShow 里调用 initGuideTour(pageKey)：
//   - 本轮 campaign 还没讲完这一页 → 延迟一会儿，按 config.guidance.tours 的 steps 逐步高亮；
//   - 讲完 / 跳过 → 写入 guidance，之后不再打扰；
//   - 中途离开 → 不记账，下次进入从当前这一步继续。
//
// 视觉仍复用 components/coach-mark：它负责量目标、画光环和气泡。
// 本 behavior 只负责「讲第几步、下一步是谁、什么时候算讲完」。
//
// 页面需要做的三件事：
//   1. behaviors: [guideTourBehavior, ...]
//   2. onShow: this.initGuideTour('pages/xxx/xxx', { canStart: () => ... })
//   3. WXML: <coach-mark show="{{guideTour.show}}" ... bind:done="onGuideTourNext" />
//
// 注意：Page 的 behaviors 不会触发 lifetimes，所以定时器必须由页面在
// onHide / onUnload 显式调用 pauseGuideTour / destroyGuideTour 清理。
const guidance = require('../utils/guidance');
const obsHelper = require('../utils/obsHelper');
const { Logger } = require('../utils/logger');

const TAG = 'guideTour';
const DEFAULT_DELAY = 900;
const RETRY_DELAY = 1200;
const MAX_RETRY = 5;
// 轻量导览是“提示”，不是必须走完的弹窗：15 秒没操作就自动收起并记账，
// 避免气泡一直挂在页面上、下次进入又重复出现。
const AUTO_HIDE_MS = 15000;

const EMPTY_TOUR = {
  show: false,
  id: '',
  page: '',
  selector: '',
  title: '',
  desc: '',
  placement: 'auto',
  presentation: 'coach',
  stepText: '',
  doneText: '知道了',
  skipText: '跳过本页',
  index: 0,
  total: 0
};

module.exports = Behavior({
  data: {
    guideTour: { ...EMPTY_TOUR }
  },

  methods: {
    /**
     * options:
     *   delay      首次出现前的等待（默认 900ms，避开首屏渲染）
     *   canStart   返回 false 时先不抢屏（如更新卡/欢迎屏还开着）
     *   disabled   本页功能关闭（如救助被服务端隐藏）
     *   features   覆盖功能开关，默认读 config
     */
    initGuideTour(pageKey, options = {}) {
      this._guidePage = pageKey;
      this._guideOptions = options || {};
      this._guideRetry = 0;
      this._clearGuideTimer();

      if (!pageKey || options.disabled) return;

      // 重播请求优先：帮助页「看一遍」跳过来时，即使本页已讲完也要再讲。
      if (guidance.consumeTourReplay(pageKey)) {
        guidance.resetTourPage(pageKey);
        this._guideReplay = true;
        this._scheduleGuideTick(300, false);
        return;
      }

      // 中途离开过的会话：恢复当前这一步，不从头开始。
      const session = this._guideSession;
      if (session && !session.done && session.tour && session.tour.page === pageKey) {
        this._scheduleGuideTick(400, true);
        return;
      }

      const tour = guidance.getTourForPage(pageKey, this._guideFeatures());
      if (!tour) return;

      this._pendingGuideTour = tour;
      this._scheduleGuideTick(options.delay === undefined ? DEFAULT_DELAY : options.delay, false);
    },

    /** 更新卡/欢迎屏关掉后，页面主动叫一次，不用等下次 onShow。 */
    scheduleGuideTour(delay) {
      if (!this._guidePage) return;
      const session = this._guideSession;
      const resume = !!(session && !session.done);
      if (!resume && !this._pendingGuideTour) {
        const tour = guidance.getTourForPage(this._guidePage, this._guideFeatures());
        if (!tour) return;
        this._pendingGuideTour = tour;
      }
      this._scheduleGuideTick(delay === undefined ? 400 : delay, resume);
    },

    pauseGuideTour() {
      this._clearGuideTimer();
      this._clearAutoHideTimer();
      if (this.data && this.data.guideTour && this.data.guideTour.show) {
        this._hideGuideTour();
      }
    },

    destroyGuideTour() {
      this._clearGuideTimer();
      this._clearAutoHideTimer();
      this._guideSession = null;
      this._pendingGuideTour = null;
      this._guideReplay = false;
      this._guideRetry = 0;
    },

    onGuideTourReady() {
      const session = this._guideSession;
      if (!session || session.done) return;

      const step = session.tour.steps[session.index];
      if (!step) return;

      if (!session.readySteps) session.readySteps = {};
      if (session.readySteps[session.index]) return;
      session.readySteps[session.index] = true;
      session.shown += 1;

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_STEP, {
        id: session.tour.id,
        page: session.tour.page,
        step: step.id,
        index: session.index + 1,
        total: session.tour.steps.length
      });
    },

    onGuideTourNext() {
      const session = this._guideSession;
      if (!session || session.done) return;

      if (session.index + 1 >= session.tour.steps.length) {
        this._finishGuideTour('completed');
        return;
      }
      this._showGuideStep(session.index + 1);
    },

    onGuideTourSkip(e) {
      const session = this._guideSession;
      if (!session || session.done) return;

      const all = !!(e && e.detail && e.detail.all);
      if (all) {
        guidance.markAllToursDone({ skipped: true });
      }

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_SKIP, {
        id: session.tour.id,
        page: session.tour.page,
        index: session.index + 1,
        total: session.tour.steps.length,
        all
      });
      this._finishGuideTour('skipped');
    },

    /**
     * 目标没量到（元素未渲染 / 条件区块不存在）。
     * - optional 步骤：自动跳下一步；
     * - 非 optional 步骤：视为页面结构异常，整条中止且**不记账**，下次进入重试；
     * - 全部步骤都没量到时也不记账，避免把「没看到」记成「已看过」。
     */
    onGuideTourMissing(detail) {
      const session = this._guideSession;
      if (!session || session.done) return;

      const step = session.tour.steps[session.index];
      Logger.debug(TAG, '导览目标未找到', {
        page: session.tour.page,
        step: session.index,
        optional: !!(step && step.optional),
        detail
      });
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_MISSING, {
        id: session.tour.id,
        page: session.tour.page,
        index: session.index + 1
      });

      if (!step || !step.optional) {
        Logger.warn(TAG, '必需目标未找到，本轮导览中止（不记已看过）', {
          page: session.tour.page,
          selector: step && step.selector
        });
        this._finishGuideTour('blocked');
        return;
      }

      if (session.index + 1 >= session.tour.steps.length) {
        this._finishGuideTour('completed');
        return;
      }

      this._clearGuideTimer();
      this._guideTimer = setTimeout(() => {
        this._guideTimer = null;
        if (!session.done) this._showGuideStep(session.index + 1);
      }, 80);
    },

    _guideFeatures() {
      const flags = guidance.getFeatureFlags();
      const override = this._guideOptions && this._guideOptions.features;
      if (override && typeof override === 'object') Object.assign(flags, override);
      return flags;
    },

    _scheduleGuideTick(delay, resume) {
      this._clearGuideTimer();
      this._guideTimer = setTimeout(() => {
        this._guideTimer = null;
        this._tryStartGuideTour(resume);
      }, delay);
    },

    _tryStartGuideTour(resume) {
      if (this._isUnmounted) return;

      if (!this._canStartGuide()) {
        this._guideRetry += 1;
        if (this._guideRetry <= MAX_RETRY) {
          this._scheduleGuideTick(RETRY_DELAY, resume);
        }
        return;
      }

      this._guideRetry = 0;

      if (resume && this._guideSession && !this._guideSession.done) {
        this._showGuideStep(this._guideSession.index);
        return;
      }

      const tour = this._pendingGuideTour
        || guidance.getTourForPage(this._guidePage, this._guideFeatures());
      if (!tour) return;

      this._pendingGuideTour = null;
      this._startGuideTour(tour);
    },

    _canStartGuide() {
      const canStart = this._guideOptions && this._guideOptions.canStart;
      if (typeof canStart !== 'function') return true;
      try {
        return canStart.call(this) !== false;
      } catch (e) {
        Logger.warn(TAG, 'canStart 判断失败，本次不展示', e);
        return false;
      }
    },

    _startGuideTour(tour) {
      this._guideSession = {
        tour,
        index: 0,
        done: false,
        shown: 0,
        readySteps: {},
        replay: !!this._guideReplay
      };
      this._guideReplay = false;

      obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_VIEW, {
        id: tour.id,
        page: tour.page,
        total: tour.steps.length,
        replay: !!this._guideSession.replay
      });
      if (this._guideSession.replay) {
        obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_REPLAY, {
          id: tour.id,
          page: tour.page
        });
      }

      this._showGuideStep(0);
    },

    _showGuideStep(index) {
      const session = this._guideSession;
      if (!session || session.done) return;

      if (index >= session.tour.steps.length) {
        this._finishGuideTour('completed');
        return;
      }

      session.index = index;
      const step = session.tour.steps[index];
      const total = session.tour.steps.length;
      const presentation = step.presentation || session.tour.presentation || 'coach';

      this.setData({
        guideTour: {
          show: true,
          id: session.tour.id,
          page: session.tour.page,
          selector: step.selector,
          title: step.title,
          desc: step.desc,
          placement: step.placement || 'auto',
          presentation,
          stepText: total > 1 ? `${index + 1}/${total}` : '',
          doneText: index + 1 >= total ? '知道了' : '下一步',
          skipText: '跳过本页',
          index,
          total
        }
      });

      // 卡片式没有“量目标”这一步：显示即视为已让用户看到。
      if (presentation === 'card') this.onGuideTourReady();

      // 轻量提示 15 秒无操作自动收起，避免一直挂在页面上
      this._scheduleAutoHide();
    },

    _finishGuideTour(reason) {
      const session = this._guideSession;
      if (!session || session.done) return;

      session.done = true;
      this._pendingGuideTour = null;
      this._clearAutoHideTimer();

      // 只有真的量到过至少一步才记账；全部 missing / 必需目标缺失时不记账。
      // 用户主动点「跳过」或 15 秒无操作自动收起：不再打扰。
      if (reason !== 'blocked' && (session.shown > 0 || reason === 'skipped' || reason === 'timeout')) {
        guidance.markTourPageDone(session.tour.page, {
          skipped: reason === 'skipped' || reason === 'timeout',
          steps: session.shown
        });
      }

      if (reason === 'completed') {
        obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_COMPLETE, {
          id: session.tour.id,
          page: session.tour.page,
          steps: session.shown
        });
      } else if (reason === 'timeout') {
        obsHelper.reportEvent(obsHelper.EVENT_NAMES.GUIDE_TOUR_SKIP, {
          id: session.tour.id,
          page: session.tour.page,
          index: session.index + 1,
          total: session.tour.steps.length,
          auto: true
        });
      }

      this._hideGuideTour();
    },

    _hideGuideTour() {
      if (this.setData) this.setData({ guideTour: { ...EMPTY_TOUR } });
    },

    _scheduleAutoHide() {
      this._clearAutoHideTimer();
      this._guideAutoHideTimer = setTimeout(() => {
        this._guideAutoHideTimer = null;
        const session = this._guideSession;
        if (!session || session.done || !this.data.guideTour.show) return;
        this._finishGuideTour('timeout');
      }, AUTO_HIDE_MS);
    },

    _clearAutoHideTimer() {
      if (this._guideAutoHideTimer) {
        clearTimeout(this._guideAutoHideTimer);
        this._guideAutoHideTimer = null;
      }
    },

    _clearGuideTimer() {
      if (this._guideTimer) {
        clearTimeout(this._guideTimer);
        this._guideTimer = null;
      }
    }
  }
});
