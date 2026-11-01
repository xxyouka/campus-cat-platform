// subpackages/feedback/report/report.js - 用户反馈（信息有误 / 受伤 / 其他 / 小程序意见）
//
// 两种进入方式：
// - 带猫进入（详情页「信息有误？点此反馈」）：mode=cat，反馈关联猫档案
// - 不带猫进入（帮助页/关于弹窗直达）：mode=app，对小程序本身的意见，
//   type 固定 other，云端按「小程序意见反馈」落库，复用同一处理流
//
// 描述草稿按「模式 + catId」落本地存储：误退页面不丢输入；提交成功后清除。
const opsTrack = require('../../../utils/opsTrack');
const guideTourBehavior = require('../../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

const TYPES = [
  { key: 'info_error', label: '信息有误', desc: '名字、花色、位置等档案信息不对' },
  { key: 'injured', label: '受伤 / 生病', desc: '发现猫咪受伤、精神差或需要帮助' },
  { key: 'other', label: '其他', desc: '其他想告诉管理员的情况' }
];

const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 200;
const DRAFT_KEY_PREFIX = 'report_draft_';

function decode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (err) {
    return String(value || '');
  }
}

Page({
  behaviors: [guideTourBehavior, safeSetDataBehavior],

  data: {
    mode: 'cat',
    catId: '',
    catName: '',
    catAvatar: '',
    types: TYPES,
    type: 'info_error',
    description: '',
    descLength: 0,
    descriptionMin: DESCRIPTION_MIN,
    descriptionMax: DESCRIPTION_MAX,
    submitting: false,
    submitted: false,
    entryError: ''
  },

  onLoad(options = {}) {
    opsTrack.entry('report');
    const catId = String(options.catId || '').trim();
    if (!catId) {
      // 通用反馈模式：对小程序本身的意见（无猫档案上下文）
      const description = this._readDraft('');
      this.safeSetData({
        mode: 'app',
        type: 'other',
        description,
        descLength: description.length
      });
      this.initGuideTour('subpackages/feedback/report/report', { delay: 800 });
      return;
    }
    const description = this._readDraft(catId);
    this.safeSetData({
      catId,
      catName: decode(options.catName),
      catAvatar: decode(options.catAvatar),
      description,
      descLength: description.length
    });
    this.initGuideTour('subpackages/feedback/report/report', { delay: 800 });
  },

  onHide() {
    this.pauseGuideTour();
  },

  onUnload() {
    this._markUnmounted();
    this.destroyGuideTour();
    if (this._draftTimer) clearTimeout(this._draftTimer);
  },

  /** 草稿存储键：app 模式固定后缀，cat 模式按猫区分（同一只猫的草稿互不覆盖） */
  _draftKey() {
    return DRAFT_KEY_PREFIX + (this.data.mode === 'app' ? 'app' : this.data.catId);
  },

  _readDraft(catId) {
    try {
      const raw = wx.getStorageSync(DRAFT_KEY_PREFIX + (catId ? catId : 'app'));
      return typeof raw === 'string' ? raw.slice(0, DESCRIPTION_MAX) : '';
    } catch (err) {
      return '';
    }
  },

  _saveDraft() {
    try {
      wx.setStorageSync(this._draftKey(), this.data.description || '');
    } catch (err) {
      // 存储不可用（隐私模式/满额）：草稿失效但不阻断输入
    }
  },

  _clearDraft() {
    try {
      wx.removeStorageSync(this._draftKey());
    } catch (err) {
      // 同上，静默
    }
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.type;
    if (!type || this.data.submitting) return;
    this.safeSetData({ type });
  },

  onInput(e) {
    const description = e.detail.value || '';
    this.safeSetData({
      description,
      descLength: description.length
    });
    if (this._draftTimer) clearTimeout(this._draftTimer);
    // 防抖写盘：逐字 setStorage 在低端机上有可感知卡顿
    this._draftTimer = setTimeout(() => this._saveDraft(), 400);
  },

  validate() {
    const description = String(this.data.description || '').trim();
    if (this.data.mode === 'cat' && !this.data.catId) return '请从猫咪详情页进入反馈';
    if (!this.data.type) return '请选择反馈类型';
    if (description.length < DESCRIPTION_MIN) return `请至少写 ${DESCRIPTION_MIN} 个字`;
    if (description.length > DESCRIPTION_MAX) return `最多写 ${DESCRIPTION_MAX} 个字`;
    return '';
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const error = this.validate();
    if (error) {
      wx.showToast({ title: error, icon: 'none' });
      return;
    }

    this.safeSetData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'submitReport',
        timeout: 20000,
        data: {
          catId: this.data.catId,
          type: this.data.type,
          description: String(this.data.description || '').trim()
        }
      });
      const result = res && res.result;
      if (!result || !result.success) {
        throw new Error(result && (result.error || result.message) || '提交失败，请稍后重试');
      }
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      this._clearDraft();
      if (this._draftTimer) clearTimeout(this._draftTimer);
      this.safeSetData({ submitting: false, submitted: true });
    } catch (err) {
      this.safeSetData({ submitting: false });
      wx.showToast({ title: err && err.message || '提交失败，请稍后重试', icon: 'none' });
    }
  },

  onBackToCat() {
    const catId = this.data.catId;
    if (!catId) return this.onBackHome();
    wx.navigateBack({
      delta: 1,
      fail: () => wx.navigateTo({ url: `/pages/detail/detail?id=${catId}` })
    });
  },

  onBackHome() {
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  }
});
