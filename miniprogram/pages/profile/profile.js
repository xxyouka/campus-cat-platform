/**
 * 我的页面
 */
const app = getApp();
const config = require('../../config');
const { Logger } = require('../../utils/logger');
const { setAdminAuth, checkAdminAuth } = require('../../utils/adminAuth');
const ShareHelper = require('../../utils/shareHelper');
const TabBadge = require('../../utils/tabBadge');
const obsHelper = require('../../utils/obsHelper');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');

const CONTACT_CACHE_KEY = 'contactInfoCache';
const CONTACT_CACHE_TTL = 3600000;

// profile 是 tabBar 页，onShow 每次切回都触发。三个云调用
// （getMyMeetCount / manageSubscribeQuota / getMeetCalendar）如果没有任何窗口，
// 用户在「首页/我的」两个 tab 之间来回横跳几次就重拉几次。30s 足够覆盖
// 「去相遇页记一笔再切回」这类真实变更场景，又能挡住纯横跳。
const PROFILE_REFRESH_WINDOW = 30000;
const EMPTY_CONTACT_TEXT = '暂未配置';

// 首屏门禁的放行上限（ms）。所有首屏加载器都返回 promise 后用 Promise.allSettled
// 汇合，但**不能无限等**：任何一个云调用卡住都会让整页永远停在骨架屏，而骨架屏
// 对用户来说和「页面坏了」没有区别。超时后照常放行，页面退化成「先出内容、
// 慢数据到位后再更新」，各区块本身已有错误态（meetCountError / quotaError）与
// 重试入口，不会把失败伪装成 0。
const FIRST_SCREEN_TIMEOUT = 2500;

// 「实时推送」卡片偏好：开关 + 版本（木鱼版 fish / 经典版 classic）。
// 存本地而非云端：版本是随手玩法的偏好，需要离线即时生效；开关只影响"是否继续攒次数"，
// 剩余次数（云端账本）不随版本/开关变化。
const PUSH_PREF_KEY = 'pushCardPref';
const DEFAULT_PUSH_PREF = { enabled: true, mode: 'fish' };
const PUSH_MODE_LABELS = { fish: '木鱼版', classic: '经典版' };
// 木鱼上起手滑动超过这个距离（px）判定为翻页手势，撤销刚才的敲击反馈
const FISH_SWIPE_THRESHOLD = 12;

// 订阅消息三个模板的额度是**各自独立消耗**的（相遇通知频繁 → 打卡模板先耗尽，
// 状态模板可能还剩很多）。只显示一个模板会误导用户（数字看着够、某类其实已收不到），
// 故按模板分项展示。templateId 与 config / 云函数发送侧保持一致；key 仅用于 wx:key。
const QUOTA_TEMPLATES = [
  { key: 'status', label: '状态变更', templateId: config.subscribeTemplateId },
  { key: 'meet', label: '相遇打卡', templateId: config.subscribeMeetTemplateId },
  { key: 'newCat', label: '新猫登场', templateId: config.subscribeNewCatTemplateId }
];

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

/** 错误文案截断：toast 只有一个短条，长错误串（如 collection not exists）会溢出 */
function _trimError(msg, max = 14) {
  const text = String(msg || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || '请重试';
}

Page({

  onHide() {
    this.pauseGuideTour();
  },

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    this.destroyGuideTour();
    this._clearFirstScreenTimer();
  },
  behaviors: [guideTourBehavior, safeSetDataBehavior],
  data: {
    // 沉浸式顶部：状态栏高度
    statusBarHeight: 0,

    // 首屏是否已成型。false 时四个数据区块渲染骨架、true 时一次性换成真内容。
    // 过去每个加载器各自 setData，关注数、相遇数、推送额度、日历统计**分四波**
    // 各自弹进来（而且先显示的是 `|| 0` 的假值），整屏在用户眼里是「不同步」的。
    // 只管首屏：之后 tab 切回走的是刷新路径，数字原地更新，不该再退回骨架。
    firstScreenReady: false,
    // 骨架占位用的三格占位项（顶部统计与日历统计都是三列）
    skeletonStats: [0, 1, 2],

    version: config.version,
    copyrightYear: new Date().getFullYear(),
    contact: normalizeContact(config.contact),
    school: config.school,
    modal: {
      about: { show: false },
      adminLogin: { show: false }
    },
    // 「推送次数怎么攒」说明弹窗
    pushHelpModal: { show: false },
    account: '',
    password: '',
    showPwd: false,
    errors: {},
    logging: false,

    // 我的关注（仅计数，详情在独立页面）
    favoriteCount: 0,
    unreadUpdateCount: 0,
    meetCount: 0,

    // 推送次数（订阅消息额度账本：一次授权 +1，一次推送 -1；200 为产品自设封顶）。
    // 三个模板额度独立消耗，故分项展示（items 顺序同 QUOTA_TEMPLATES）。
    subscribeQuota: {
      limit: 200,
      reached: false,
      total: 0,
      items: QUOTA_TEMPLATES.map(t => ({ key: t.key, label: t.label, count: 0 }))
    },
    // 次数读取/上报失败时显示在这里（非空 = 云端不可用，点击可重试）。
    // 之前失败是静默的：卡片一直显示 0，看起来就像"不加次数"
    quotaError: '',
    // 相遇次数读取失败提示（口径同 quotaError）：失败时保留原值，不伪装成 0
    meetCountError: '',

    // 实时推送卡片偏好：是否开启通知（关闭=暂停攒次数）、展示版本
    pushEnabled: true,
    pushMode: 'fish',
    // 敲击反馈用 a/b 双相位类名（'' = 无动画）：每次触发在 a/b 间切换，
    // 动画名随之改变 → 必然重播；不再用「摘类 → 32ms 后挂类」（见 _playTapHit）
    tapHitPhase: '',
    quotaHitPhase: '',

    // 打卡日历
    weekLabels: ['日', '一', '二', '三', '四', '五', '六'],
    calendar: {
      title: '',
      cells: [],
      stats: { monthDays: 0, streakDays: 0, totalDays: 0 },
      loading: false,
      // 加载失败态：区分「加载失败」与「真的没打卡」（否则标题空白、统计恒 0，两者同形）
      loadFailed: false
    }
  },

  onLoad () {
    const { statusBarHeight } = wx.getWindowInfo();
    this.setData({ statusBarHeight: statusBarHeight || 0 });

    // 推送偏好是纯本地读取，同步完成且不进骨架（开关一开始就该是对的状态）
    this.loadPushPref();

    // 联系信息只喂「关于我们」弹窗，跟首屏可见内容无关，不进门禁
    this.loadContactInfo();

    // 四个首屏数据区块统一走门禁，见 _syncFirstScreen
    this._syncFirstScreen();
  },

  /**
   * 首屏数据一次性成型：等关注数 / 相遇数 / 推送额度 / 打卡日历都落地后，
   * 再统一把 firstScreenReady 置 true 换掉骨架。
   *
   * 只 gate 这四项真正会往界面上渲染数字的加载器。loadPushPref 读本地、
   * loadContactInfo 只服务弹窗，都故意排除在外 —— 否则一个与首屏无关的慢调用
   * 会把整页锁在骨架里，而用户根本没看到那个数据。
   *
   * 用 allSettled 而不是 all：单个加载器失败时它自己已经把错误态画出来了
   * （meetCountError / quotaError / calendar.loadFailed），门禁不该为此一直等下去。
   */
  async _syncFirstScreen () {
    const tasks = [
      this.refreshFavoriteCount(),
      this.refreshMeetCount(),
      this.refreshSubscribeQuota(),
      this.loadMeetCalendar()
    ].filter(task => task && typeof task.then === 'function');

    this._firstScreenTimer = setTimeout(() => {
      this._firstScreenTimer = null;
      this._markFirstScreenReady();
    }, FIRST_SCREEN_TIMEOUT);

    await Promise.allSettled(tasks);
    this._markFirstScreenReady();
  },

  /** 放行首屏：只生效一次（onShow 刷新路径不会把已渲染的页面打回骨架） */
  _markFirstScreenReady () {
    this._clearFirstScreenTimer();
    if (this._isUnmounted || this.data.firstScreenReady) return;
    this.safeSetData({ firstScreenReady: true });
  },

  _clearFirstScreenTimer () {
    if (!this._firstScreenTimer) return;
    clearTimeout(this._firstScreenTimer);
    this._firstScreenTimer = null;
  },

  async loadContactInfo() {
    try {
      const cached = wx.getStorageSync(CONTACT_CACHE_KEY);
      if (
        cached &&
        cached.data &&
        hasContactValue(cached.data) &&
        Date.now() - cached.timestamp < CONTACT_CACHE_TTL
      ) {
        this.setData({ contact: normalizeContact(cached.data) });
        return;
      }

      const res = await wx.cloud.callFunction({
        name: 'getConfig',
        data: { keys: ['contact'] }
      });

      const gdata = res.result?.data ?? res.result ?? {};
      if (res.result?.success && gdata.contact) {
        const rawContact = gdata.contact;
        const contact = normalizeContact(rawContact);
        this.safeSetData({ contact });
        if (hasContactValue(rawContact)) {
          try {
            wx.setStorageSync(CONTACT_CACHE_KEY, { data: rawContact, timestamp: Date.now() });
          } catch (e) { /* ignore */ }
          Logger.info('profile', '联系信息加载成功');
        } else {
          try {
            wx.removeStorageSync(CONTACT_CACHE_KEY);
          } catch (e) { /* ignore */ }
          Logger.warn('profile', '联系信息未配置，显示默认提示');
        }
      } else {
        Logger.warn('profile', '联系信息加载失败，使用默认值');
      }
    } catch (err) {
      Logger.error('profile', '获取联系信息失败', err);
    }
  },

  /**
   * 页面显示（Tab 切换回来时触发）
   * 同步管理员状态 + 刷新关注/相遇计数
   */
  onShow() {
    this.initGuideTour('pages/profile/profile', { delay: 1000 });

    const isAdmin = checkAdminAuth();
    if (isAdmin !== app.globalData.isAdmin) {
      app.globalData.isAdmin = isAdmin;
    }
    // 已登录管理员：预下载 admin 分包（0.30MB）。
    // 管理后台此前是「点进去那一刻才开始下载 + JS 注入」，首屏要多等一次分包加载
    //（2026-10-14 性能复盘：pages/admin/admin 页面切换均值 3758ms，站内第二名的 19 倍）。
    // 只对管理员触发 —— 普通用户零流量；也不用 app.json 的 preloadRule，
    // 那会给**所有**用户下发这个分包。
    if (isAdmin) this._preloadAdminSubpackage();
    // refreshFavoriteCount 必须每次 onShow 都跑：它包含「本地无关注记录时从云端
    // 恢复」的重试路径，也负责刷新未读红点数（用户从通知页回来要看到红点清零）。
    this.refreshFavoriteCount();

    // 首屏跳过守卫：onLoad 刚把下面四个区块的数据全拉过一遍，紧接着的首次 onShow
    // 会原样再拉一遍 —— 纯浪费 4 次云调用（并按 profile 是 tabBar 页、横跳频繁的
    // 特点放大）。口径同 pages/admin/cat-manage/cat-manage.js:69-72。
    // 守卫放在这里（而不是函数开头）正是为了让上面的关注恢复不被吞掉。
    if (!this._firstShowSkipped) {
      this._firstShowSkipped = true;
      return;
    }

    // profile 是 tabBar 页，onLoad 不会重跑：用户去「相遇」记一笔再切回来时，
    // meetCount 会停留在首次进入时的快照。日历同理（loadMeetCalendar 只在 onLoad 调）。
    // 这三个云调用都带 30s 时间窗口：在两个 tab 之间来回横跳时不会每次都重拉。
    this.refreshMeetCount();
    // 用户在详情页关注猫咪时也会累积推送次数，切回本页需刷新数字
    this.refreshSubscribeQuota();
    this.loadMeetCalendar();
  },

  // ========== 推送说明 ==========

  onShowPushHelp() {
    this.setData({ 'pushHelpModal.show': true });
    obsHelper.reportEvent(obsHelper.EVENT_NAMES.FEATURE_FIRST_USE, { feature: 'push_help' });
  },

  onClosePushHelp() {
    this.setData({ 'pushHelpModal.show': false });
  },

  /**
   * 预下载 admin 分包（一次会话只发起一次）
   *
   * 管理后台的唯一入口在本页（onGoToAdmin），而 app.json 里没有 preloadRule
   * —— 那会给所有用户都下发 0.30MB 的分包。这里手动触发，只有已登录管理员真正下载。
   * 低版本基础库（< 2.3.0）没有该 API 时静默跳过：不预下载只是慢一点，不是错误。
   * @private
   */
  _preloadAdminSubpackage() {
    if (this._adminSubpackagePreloaded) return;
    this._adminSubpackagePreloaded = true;

    if (typeof wx.loadSubpackage !== 'function') return;
    wx.loadSubpackage({
      name: 'admin',
      // 失败静默：真进去时微信会重新走正常分包加载，不影响任何功能
      fail: (err) => Logger.debug('profile', 'admin 分包预下载失败', err && err.errMsg)
    });
  },

  // ========== 我的关注（轻量：仅计数） ==========

  refreshFavoriteCount() {
    const raw = wx.getStorageSync('favoriteCats');
    this._updateFavoriteCount(raw);

    // 本地从未写入过关注（新设备 / 清缓存后 getStorageSync 返回空串）时，
    // 从云端恢复一次（syncFavorites action:'list'）。与收藏页口径一致：只做
    // 「云端 → 本地」合并、不做删除；用户主动取关全部后本地是 []（已写入），
    // 与「从未写入」可区分，不会把已取关的猫复活。
    const isAbsent = raw === '' || raw === null || raw === undefined;
    const restore = isAbsent && !this._favoriteRestoreInflight && !this._favoriteRestoreChecked
      ? this._restoreFavoritesFromCloud()
      : null;

    const unread = this.refreshUnreadCount();

    // 两条路径都要跑（缺一不可），返回汇合后的 promise 给首屏门禁用
    return restore ? Promise.all([restore, unread]) : unread;
  },

  /** 按本地存储重算关注数（catId 去重，口径与 pages/favorites 的 _normalizeFavorites 一致） */
  _updateFavoriteCount(raw) {
    const safeRaw = Array.isArray(raw) ? raw : [];
    // 本地数组可能含同一只猫的重复项（云端恢复前插 + 详情页关注 push 两条写入路径），
    // 直接取 length 会让「我的」页的关注数虚高、与收藏页的实际条数不一致。
    const uniqueIds = new Set(
      safeRaw
        .map(f => typeof f === 'string' ? f : f && f.id)
        .filter(Boolean)
    );
    this.setData({ favoriteCount: uniqueIds.size });
  },

  /**
   * 云端恢复关注（修复：新设备 / 清缓存后关注数显示 0）。
   * 失败不置 _favoriteRestoreChecked，下次 onShow 会再试一次。
   */
  async _restoreFavoritesFromCloud() {
    this._favoriteRestoreInflight = true;
    try {
      const res = await wx.cloud.callFunction({
        name: 'syncFavorites',
        data: { action: 'list' }
      });
      const result = res.result || {};
      if (!result.success) {
        Logger.warn('profile', '云端关注拉取失败', { error: result.error });
        return;
      }
      this._favoriteRestoreChecked = true;
      const cloudIds = result.data && result.data.catIds || [];
      if (cloudIds.length > 0) {
        wx.setStorageSync('favoriteCats', cloudIds.map(id => ({ id, time: Date.now() })));
        Logger.info('profile', '云端关注已恢复', { restored: cloudIds.length });
        this._updateFavoriteCount(wx.getStorageSync('favoriteCats'));
      }
    } catch (err) {
      Logger.warn('profile', '云端关注恢复失败（非致命）', err);
    } finally {
      this._favoriteRestoreInflight = false;
    }
  },

  /**
   * 拉取云端真实未读数（「新动态」卡块的数字与红点）
   *
   * 原实现读本地 Storage 的 `pendingUpdates` / `readUpdates` 两个键，
   * 但全项目**只有这里读、没有任何地方写**（grep 核对 pages/services/utils）——
   * 即恒为空对象，unreadUpdateCount 永远为 0，「新动态」卡块从来不显示数字。
   * 改为读云端 getNotifications，与消息中心页同源同口径。
   */
  refreshUnreadCount() {
    return wx.cloud.callFunction({
      name: 'getNotifications',
      data: { page: 1, pageSize: 1, unreadOnly: true }
    }).then(res => {
      if (!res.result?.success) return;
      const data = res.result?.data ?? res.result ?? {};
      const count = data.unreadCount || 0;
      if (count !== this.data.unreadUpdateCount) {
        this.safeSetData({ unreadUpdateCount: count });
      }
      // 同步 tabBar 红点：用户不进「我的」也能看到未读（只写本地缓存 + 原生 API）
      TabBadge.sync(count);
    }).catch(e => Logger.swallow('profile', '拉取未读数失败', e));
  },

  onGoFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  onGoNotifications() {
    wx.navigateTo({ url: '/pages/notifications/notifications' });
  },

  // ========== 实时推送卡片偏好（开关 / 版本） ==========

  /** 读取本地偏好；损坏或缺失时回落默认（开启 + 木鱼版） */
  loadPushPref() {
    let pref = null;
    try {
      pref = wx.getStorageSync(PUSH_PREF_KEY);
    } catch (err) {
      Logger.warn('profile', '读取推送偏好失败，使用默认值', err);
    }
    const enabled = pref && typeof pref.enabled === 'boolean' ? pref.enabled : DEFAULT_PUSH_PREF.enabled;
    const mode = pref && PUSH_MODE_LABELS[pref.mode] ? pref.mode : DEFAULT_PUSH_PREF.mode;
    this.safeSetData({ pushEnabled: enabled, pushMode: mode });
  },

  _savePushPref() {
    try {
      wx.setStorageSync(PUSH_PREF_KEY, {
        enabled: this.data.pushEnabled,
        mode: this.data.pushMode
      });
    } catch (err) {
      Logger.warn('profile', '保存推送偏好失败', err);
    }
  },

  /**
   * 敲击手感：点击瞬间就动，不等授权结果。
   *
   * 与「结果层」（_playHit）刻意分开的两个时刻：
   * - 手感 = 手指刚下去就该有的反馈（下压回弹 + 音效 + 震动），必须跟手；
   *   授权弹窗有 200~400ms 乃至更久（用户要点按钮）的间隔，等结果再反馈会"发木"。
   * - 结果 = 云端确认加了 1 次之后才出现的涟漪/火花/「+1」/数字跳动。
   *
   * 重播策略（2026-10-13 修 iOS 连点吞动画）：旧实现「摘类 → 32ms 后挂同一个类」
   * 依赖两次 setData 各自渲染落地；iOS 连点时音频/震动的原生调用拖住 JS→渲染管道，
   * 两次更新会被合并，类名没变 → 动画不重播（看起来就是"吞动画"）。
   * 现在改成 a/b 双相位：一次 setData 把类名换成另一套（动画名不同 → 必然重播），
   * 无定时器、不依赖两帧渲染。只用 transform，不触发重排。
   */
  _playTapHit() {
    this.safeSetData({ tapHitPhase: this.data.tapHitPhase === 'a' ? 'b' : 'a' });
  },

  /**
   * 命中反馈（木鱼版 / 经典版共用一个开关）——只在云端确认 +1 后触发：
   * 木鱼版 = 涟漪 + 火花 + 「+1」浮字；
   * 经典版 = 只有大数字跳动（木鱼相关层不在该模式下渲染）。
   *
   * 音效/震动/受击形变不在这里：那些是"手感"，已在点击瞬间触发（见 onTapIncreaseQuota），
   * 这里只表达"这次真的加了 1 次"。
   *
   * 重播策略同 _playTapHit（2026-10-13 修 iOS 连点吞动画）：a/b 双相位切换替代
   * 「摘类 → 再挂类」——结果层常驻在 wxml 里（基态 opacity:0 不可见），
   * 相位类一变，动画名随之改变，连点/连续成功时每层都必然重播。
   * 全部只用 transform/opacity，不触发重排。
   */
  _playHit() {
    this.safeSetData({ quotaHitPhase: this.data.quotaHitPhase === 'a' ? 'b' : 'a' });
  },

  /**
   * 通知开关（原生 switch 的 change 事件）
   *
   * 语义边界：关闭后不再调起授权弹窗、不再增加次数；**已攒次数与历史推送照旧**
   * （事件到达时仍按账本发送）。若要让关闭同时"存量也停发"，需在发送侧按用户开关过滤，
   * 当前未做（详见 CHANGELOG 说明）。开启时也不自动弹授权，避免用户被动弹窗。
   */
  onPushEnabledChange(e) {
    const enabled = !!(e && e.detail && e.detail.value);
    this.safeSetData({ pushEnabled: enabled });
    this._savePushPref();
    wx.vibrateShort({ type: 'light' });
    wx.showToast({
      title: enabled ? '已开启实时推送' : '已关闭，暂停增加次数',
      icon: 'none'
    });
  },

  /** 切换木鱼版 ⇄ 经典版（仅前端展示差异，不影响云端账本） */
  onTogglePushMode() {
    const mode = this.data.pushMode === 'fish' ? 'classic' : 'fish';
    this.safeSetData({ pushMode: mode });
    this._savePushPref();
    wx.vibrateShort({ type: 'light' });
  },

  // ========== 推送次数（订阅消息额度） ==========

  /**
   * 拉取剩余推送次数（云端账本 manageSubscribeQuota）
   *
   * 微信不提供「查询剩余可下发次数」的接口，剩余次数由云函数记账：
   * 授权 accept 时 +1（上限 200），发送成功时 -1（见各发送侧云函数）。
   * 主数字口径 = 「活动状态变更通知」模板的剩余次数（最核心的猫咪动态提醒）。
   */
  refreshSubscribeQuota() {
    // 未配置模板 ID = 关闭微信订阅推送，不请求云端额度
    if (!config.subscribeTemplateId && !config.subscribeMeetTemplateId && !config.subscribeNewCatTemplateId) return Promise.resolve();
    // 30s 时间窗口：profile 是 tabBar 页，在「首页/我的」两个 tab 之间来回横跳时
    // 不该每次都重拉一次。真正的变更（详情页关注累积次数）由刷新动作触发，
    // 30s 足够覆盖，且用户停留超 30s 再切回也会拿到新值。
    if (this._quotaRefreshedAt && Date.now() - this._quotaRefreshedAt < PROFILE_REFRESH_WINDOW) return;
    this._quotaRefreshedAt = Date.now();

    return wx.cloud.callFunction({
      name: 'manageSubscribeQuota',
      data: { action: 'get' }
    }).then(res => {
      const result = res.result || {};
      if (!result.success) {
        // 不再静默显示 0：否则「云函数没部署/集合没建」看起来就像「不加次数」。
        // 云端错误本身已带「操作失败：」前缀，这里直接透传，不再套一层
        Logger.warn('profile', '推送次数读取失败', { error: result.error });
        this._setQuotaError(result.error || '次数读取失败，点此重试');
        return;
      }
      this._setQuotaError('');
      this._applyQuotaData(result.data || {});
    }).catch(err => {
      Logger.warn('profile', '推送次数加载失败（非致命）', err);
      this._setQuotaError('次数读取失败，点此重试');
    });
  },

  _setQuotaError(msg) {
    const next = String(msg || '').slice(0, 36);
    if (this.data.quotaError === next) return;
    this.safeSetData({ quotaError: next });
  },

  /** 次数读取失败后的手动重试（绕过 30s 刷新窗口，否则点了没反应） */
  onRetryQuota() {
    this._quotaRefreshedAt = 0;
    this._setQuotaError('');
    this.refreshSubscribeQuota();
  },

  /**
   * 用云端账本数据刷新页面展示，返回分项数组。
   *
   * 云端 readCounts 返回**三个模板各自**的剩余次数（counts），本页按模板分项展示：
   * 只显示一个模板时，某类通知已耗尽而数字看着够，会误导用户去收不到的那类动态。
   *
   * partial=true 是 add（授权 +1）路径：counts 只保证包含**这次真的 accept 的模板**，
   * 缺 key 表示「这次没涉及」，不是「数字变成 0」—— 必须保留原值。否则用户只勾了一个
   * 模板的那次授权，会把另外两类在界面上抹成 0（账本没变，只是显示清零），
   * 直到下一次 get 全量回来才恢复，看起来就是「明明有次数却显示 0」。
   * get 路径（partial=false）是全量快照，缺 key 就是真的没这条记录 → 补 0。
   *
   * reached = 三个模板**全部**到上限。「增加推送次数」一次补三个模板，
   * 只要还有任一模板没满，点击就仍有意义。
   */
  _applyQuotaData(data, { partial = false } = {}) {
    const counts = data.counts || {};
    const limit = Number(data.limit) || this.data.subscribeQuota.limit || 200;
    const prevByKey = new Map(
      (this.data.subscribeQuota.items || []).map(item => [item.key, Number(item.count) || 0])
    );
    const items = QUOTA_TEMPLATES.map(t => {
      const raw = Number(counts[t.templateId]);
      if (Number.isFinite(raw)) return { key: t.key, label: t.label, count: raw };
      // partial：本次没提到的分类保留原值；|| 0 兜住「首屏尚未赋值」与 null 计数
      const kept = partial ? prevByKey.get(t.key) : 0;
      return { key: t.key, label: t.label, count: kept || 0 };
    });
    const total = items.reduce((sum, i) => sum + i.count, 0);
    this.safeSetData({
      'subscribeQuota.items': items,
      'subscribeQuota.limit': limit,
      'subscribeQuota.total': total,
      'subscribeQuota.reached': items.every(i => i.count >= limit)
    });
    return items;
  },

  /**
   * 手指按下的瞬间就出手感。
   *
   * 为什么不挂在 bindtap 上：tap 是**抬手**才触发的，敲木鱼这一下几乎always
   * 抬起即结束（80~150ms），等 tap 响等于整段按下时间都"发木"。
   * touchstart 在同一时刻必须完成：音效 + 轻震动 + 木鱼受击形变。
   *
   * 注意：这里**不能**调 wx.requestSubscribeMessage —— 它要求留在用户点击
   * （tap）手势里，touchstart 手势在真机上部分版本不认，所以授权请求仍走 bindtap。
   */
  onFishTouchStart(e) {
    const touch = e?.touches?.[0];
    this._fishTouchStart = { x: touch?.pageX || 0, y: touch?.pageY || 0 };
    this._fishSwiped = false;
    // 关闭通知 / 已攒满：熄火状态，触摸也不给手感（否则"敲了但没反应")
    const { pushEnabled, subscribeQuota } = this.data;
    if (!pushEnabled || subscribeQuota.reached) return;
    this._playTapHit();
    wx.vibrateShort({ type: 'light' });
  },

  /**
   * 手指滑动时撤销刚才的手感（本页可滚动，用户可能只是在木鱼上起手翻页）。
   * bindtouchmove 不阻止滚动；超过阈值就当作滚动而非敲击。
   */
  onFishTouchMove(e) {
    if (this._fishSwiped) return;
    const touch = e?.touches?.[0];
    if (!touch || !this._fishTouchStart) return;
    const dx = Math.abs(touch.pageX - this._fishTouchStart.x);
    const dy = Math.abs(touch.pageY - this._fishTouchStart.y);
    if (dx <= FISH_SWIPE_THRESHOLD && dy <= FISH_SWIPE_THRESHOLD) return;
    this._fishSwiped = true;
    // 撤销：形变复位（相位类清空）+ 声音截断（木鱼声短，晚一点也无妨，但别让它一直响完）
    this.safeSetData({ tapHitPhase: '' });
  },

  /**
   * 点击「增加推送次数」：一次点击弹一次授权（用户勾选「总是保持以上选择」后
   * 不再弹窗、直接静默 +1，可连点快速累积）。
   *
   * 手感（音效/震动/受击形变）已在 touchstart 给过，绑定在 tap 上会重复触发。
   *
   * 注意：wx.requestSubscribeMessage 必须在点击手势内**同步**调起，
   * 不能先 await 云函数/接口再调（会报「需要用户手势点击操作」）。
   */
  onTapIncreaseQuota() {
    // 起手后变成滚动：手势已被 onFishTouchMove 撤销，不再计入敲击
    if (this._fishSwiped) {
      this._fishSwiped = false;
      return;
    }
    if (this._quotaTapLock) return;
    // 通知已关闭：引导开开关，而不是静默失败
    if (!this.data.pushEnabled) {
      wx.showToast({ title: '请先开启右上角通知开关', icon: 'none' });
      return;
    }
    const quota = this.data.subscribeQuota;
    if (quota.reached) {
      wx.showToast({ title: `已达上限（${quota.limit} 次）`, icon: 'none' });
      return;
    }

    const tmplIds = [
      config.subscribeTemplateId,
      config.subscribeMeetTemplateId,
      config.subscribeNewCatTemplateId
    ].filter(Boolean);
    if (!tmplIds.length || typeof wx.requestSubscribeMessage !== 'function') {
      wx.showToast({ title: '暂不支持订阅消息', icon: 'none' });
      return;
    }

    this._quotaTapLock = true;
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => {
        const acceptedIds = tmplIds.filter(id => res && res[id] === 'accept');
        if (acceptedIds.length > 0) {
          this._reportQuotaIncrease(acceptedIds);
        } else if (tmplIds.every(id => res && res[id] === 'reject')) {
          // 最常见的新账号场景：弹窗里三个开关没打开就直接点了确定
          wx.showToast({ title: '未勾选订阅开关，次数未增加', icon: 'none' });
        } else {
          // 用户取消/拒绝，或已勾选「总是保持以上选择 → 拒绝」（后者需去设置里修改）
          wx.showToast({ title: '未增加，可在右上角设置中开启', icon: 'none' });
        }
      },
      fail: () => {
        wx.showToast({ title: '订阅未成功，请重试', icon: 'none' });
      },
      complete: () => {
        this._quotaTapLock = false;
      }
    });
  },

  /**
   * 上报本次授权的模板（云端账本 +1），并用返回值刷新数字。
   *
   * 刷新走 partial:true —— 云端的 add 现在回全量快照，但线上可能还跑着只回
   * 「本次涉及的模板」的旧版本；无论哪种响应，没提到的分类都该保留原值，
   * 而不是在界面上被抹成 0（详见 _applyQuotaData）。
   */
  _reportQuotaIncrease(acceptedIds) {
    wx.cloud.callFunction({
      name: 'manageSubscribeQuota',
      data: { action: 'add', templateIds: acceptedIds }
    }).then(res => {
      const result = res.result || {};
      if (!result.success) {
        // 带上云端真实原因：集合未创建/模板不在白名单/权限问题都能直接读出来
        Logger.warn('profile', '推送次数上报失败', { error: result.error });
        this._setQuotaError(`增加失败：${result.error || '请重试'}`);
        wx.showToast({ title: `增加失败：${_trimError(result.error)}`, icon: 'none' });
        return;
      }
      this._setQuotaError('');
      this._applyQuotaData(result.data || {}, { partial: true });
      // 成功不再弹 toast：数字就在卡片上，弹窗属于重复信息。
      // 音效/震动已在 touchstart 给过（跟手），这里只补「次数真的加了」的结果反馈：
      // 木鱼版涟漪/火花/「+1」/经典版数字跳动。
      this._playHit();
    }).catch(err => {
      Logger.warn('profile', '推送次数上报失败（非致命）', err);
      this._setQuotaError('增加失败，点此重试');
      wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
    });
  },

  onGoRank() {
    wx.navigateTo({ url: '/pages/rank/rank' });
  },

  // ========== 我的相遇（轻量：仅计数） ==========

  refreshMeetCount() {
    // 时间窗口口径同 refreshSubscribeQuota：tab 横跳不重拉
    if (this._meetRefreshedAt && Date.now() - this._meetRefreshedAt < PROFILE_REFRESH_WINDOW) return;
    this._meetRefreshedAt = Date.now();

    return wx.cloud.callFunction({
      name: 'getMyMeetCount'
    }).then(res => {
      if (res.result?.success) {
        const data = res.result?.data ?? res.result ?? {};
        this.safeSetData({ meetCount: data.count || 0 });
        this._setMeetCountError('');
      } else {
        // 失败**不能**把 meetCount 置 0：那会让「云函数挂了」与「真的没打过卡」
        // 在 UI 上完全同形（wxml 里三格快捷条的 .quick-num 直接渲染 meetCount）。
        // 口径同 quotaError：保留原值 + 标错误 + 清时间窗以便重试。
        this._meetRefreshedAt = 0;
        this._setMeetCountError('相遇次数读取失败，点此重试');
      }
    }).catch((err) => {
      Logger.warn('profile', '获取相遇计数失败', err);
      this._meetRefreshedAt = 0;
      this._setMeetCountError('相遇次数读取失败，点此重试');
    });
  },

  _setMeetCountError(msg) {
    const next = msg || '';
    if (this.data.meetCountError === next) return;
    this.safeSetData({ meetCountError: next });
  },

  /** 相遇次数读取失败后的重试入口 */
  onRetryMeetCount() {
    this._meetRefreshedAt = 0;
    this.refreshMeetCount();
  },

  onGoMeets() {
    wx.navigateTo({ url: '/pages/meets/meets' });
  },

  // ========== 打卡日历 ==========

  /**
   * 加载指定月份的打卡日历（默认当月，云函数 getMeetCalendar）
   */
  async loadMeetCalendar() {
    // 双条件窗口：同一年月 + 30s 内不重拉。翻月不受影响（_calYear/_calMonth 变了）。
    // 口径同 refreshMeetCount / refreshSubscribeQuota。
    const now = new Date();
    const year = this._calYear !== undefined ? this._calYear : now.getFullYear();
    const month = this._calMonth !== undefined ? this._calMonth : now.getMonth();
    const monthKey = `${year}-${month}`;
    if (this._calLoadedKey === monthKey && this._calLoadedAt &&
        Date.now() - this._calLoadedAt < PROFILE_REFRESH_WINDOW) {
      return;
    }
    this._calLoadedKey = monthKey;
    this._calLoadedAt = Date.now();

    // 标题先行：加载失败时也能看到当前月份，不再是一片空白
    this.safeSetData({
      'calendar.loading': true,
      'calendar.loadFailed': false,
      'calendar.title': `${year}年${month + 1}月`
    });

    // 请求序号守卫（口径同 meets.js）：连续翻月时先发出的慢响应可能后到，
    // 若不丢弃过期响应，标题与格子会显示成上一个月，且 loading 状态被旧请求提前清掉
    this._calendarSeq = (this._calendarSeq || 0) + 1;
    const seq = this._calendarSeq;
    const isStale = () => seq !== this._calendarSeq;

    try {
      const res = await wx.cloud.callFunction({
        name: 'getMeetCalendar',
        data: { year, month }
      });
      if (isStale()) return;
      const data = res.result?.data ?? res.result ?? {};
      const meetDays = Array.isArray(data.meetDays) ? data.meetDays : [];
      this.safeSetData({
        'calendar.title': `${year}年${month + 1}月`,
        'calendar.cells': this._buildCalendarCells(year, month, meetDays),
        'calendar.stats': {
          monthDays: data.monthDays || meetDays.length,
          streakDays: data.streakDays || 0,
          totalDays: data.totalDays || 0
        },
        'calendar.loading': false,
        'calendar.loadFailed': false
      });
    } catch (err) {
      Logger.warn('profile', '加载打卡日历失败', err);
      // 过期请求不清 loading：新请求仍在途，清掉会让日历在加载中途就显示旧数据
      if (isStale()) return;
      // 必须同时清 _calLoadedAt：它在请求发出**前**就置了时间戳（:665），
      // 不清则 onRetryCalendar 会被 30s 窗口（:660-663）直接挡掉 → 重试按钮变死按钮。
      // 口径同 onRetryQuota 的 this._quotaRefreshedAt = 0（:457）
      this._calLoadedAt = 0;
      // 置失败态：日历区显示「加载失败，点击重试」，统计数字不再与「真的没打卡」同形
      this.safeSetData({ 'calendar.loading': false, 'calendar.loadFailed': true });
    }
  },

  /** 日历加载失败后的重试入口 */
  onRetryCalendar() {
    // 显式清零，确保即使 catch 分支已清过、也一定能穿透 30s 窗口
    this._calLoadedAt = 0;
    this.loadMeetCalendar();
  },

  /**
   * 生成月历网格：当月 1 号星期偏移填充空白 + 打卡日标记 + 今天标记
   */
  _buildCalendarCells(year, month, meetDays) {
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // 「今天」只属于当前月：翻到别的月份不能把同号的日子标成今天。
    // 字段名 isToday 与 meets 页 _buildCalendarCells 同口径（wxml 里映射成 .today 类）
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
    const todayDate = now.getDate();
    const cells = [];
    // key 供 wxml 的 wx:key 使用：补白格原先都是 day: ''，同一 key 会重复 3~6 次；
    // day 字段本身保持 '' / 数字不变，wxml 仍以 {{item.day || ''}} 渲染
    for (let i = 0; i < firstWeekday; i++) cells.push({ key: `pad-${i}`, day: '', meeted: false, isToday: false });
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({
        key: `day-${day}`,
        day,
        meeted: meetDays.includes(day),
        isToday: isCurrentMonth && day === todayDate
      });
    }
    return cells;
  },

  onPrevMonth() {
    const now = new Date();
    let year = this._calYear !== undefined ? this._calYear : now.getFullYear();
    let month = this._calMonth !== undefined ? this._calMonth : now.getMonth();
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    this._calYear = year;
    this._calMonth = month;
    this.loadMeetCalendar();
  },

  onNextMonth() {
    const now = new Date();
    let year = this._calYear !== undefined ? this._calYear : now.getFullYear();
    let month = this._calMonth !== undefined ? this._calMonth : now.getMonth();
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    this._calYear = year;
    this._calMonth = month;
    this.loadMeetCalendar();
  },

  // 账号输入 - 过滤中文
  onAccountInput(e) {
    const value = e.detail.value.replace(/[\u4e00-\u9fa5]/g, '');
    this.setData({ account: value, 'errors.account': '' });
  },

  // 隐私政策
  onPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  // 使用帮助
  onGoHelp() {
    wx.navigateTo({ url: '/pages/help/help' });
  },

  // 关于我们
  onAbout() {
    this.setData({ 'modal.about.show': true });
  },

  // 关闭弹窗
  onModalClose() {
    this.setData({
      'modal.about.show': false
    });
  },

  // 关于弹窗 → 意见反馈（无猫直达模式）
  onOpenFeedback() {
    this.setData({ 'modal.about.show': false });
    wx.navigateTo({ url: '/subpackages/feedback/report/report' });
  },

  // 点击版本号 - 管理员入口
  onVersionTap() {
    // 检查是否已登录
    if (app.globalData.isAdmin) {
      wx.navigateTo({ url: '/pages/admin/admin' });
    } else {
      this.setData({
        'modal.adminLogin.show': true,
        account: '',
        password: '',
        errors: {}
      });
    }
  },

  // 密码输入 - 过滤中文
  onPasswordInput(e) {
    const value = e.detail.value.replace(/[\u4e00-\u9fa5]/g, '');
    this.setData({ password: value });
  },

  // 阻止事件冒泡
  stopPropagation() {},

  // 取消登录
  onCancelLogin() {
    this.setData({
      'modal.adminLogin.show': false,
      account: '',
      password: '',
      showPwd: false,
      errors: {}
    });
  },

  // 切换密码显示
  onTogglePwd() {
    this.setData({ showPwd: !this.data.showPwd });
  },

  // 下拉刷新
  onPullDownRefresh() {
    // 个人中心页面无数据刷新需求，直接停止
    wx.stopPullDownRefresh();
  },

  // 确认登录
  async onConfirmLogin() {
    if (this.data.logging) return;
    
    const { account, password } = this.data;
    
    // 验证
    if (!account) {
      this.setData({ 'errors.account': '请输入账号' });
      return;
    }
    if (!password) {
      this.setData({ 'errors.password': '请输入密码' });
      return;
    }
    
    // 清除错误
    this.setData({ 'errors.account': '', 'errors.password': '', logging: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'adminLogin',
        timeout: 10000,
        data: { account, password }
      });

      if (res.result.success) {
        const data = res.result?.data ?? res.result ?? {};
        await setAdminAuth(true, data.role, account, data.permissions);
        this.safeSetData({
          'modal.adminLogin.show': false,
          logging: false
        });
        wx.navigateTo({ url: '/pages/admin/admin' });
      } else {
        this.safeSetData({
          'errors.password': res.result.error || '密码错误',
          logging: false
        });
      }
    } catch (err) {
      this.safeSetData({
        'errors.password': '登录失败，请重试',
        logging: false
      });
      Logger.error('profile', '管理员登录失败', err);
    }
  },

  /**
   * 分享给朋友
   *
   * 页面本身是「我的」数据，接收方打开看到的会是自己的主页，
   * 所以路径落在首页；文案可以带上我的关注/相遇数字，让卡片有具体信息。
   */
  onShareAppMessage() {
    const titles = [];
    const parts = [];
    const favoriteCount = Number(this.data.favoriteCount) || 0;
    const meetCount = Number(this.data.meetCount) || 0;
    if (favoriteCount > 0) parts.push(`关注了 ${favoriteCount} 只猫`);
    if (meetCount > 0) parts.push(`记录了 ${meetCount} 次相遇`);
    if (parts.length) titles.push(`我在校园猫猫${parts.join('，')}`);
    titles.push(
      '校园猫猫小程序 | 校园猫咪信息展示平台',
      '发现一个超有爱的校园猫咪小程序！快来吸猫',
      '示例大学的毛孩子都在这里'
    );
    return {
      title: ShareHelper.pickTitle(titles),
      path: '/pages/index/index'
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const titles = [
      '校园猫猫 | 校园猫咪图鉴',
      '每一只都值得被记录 - 校园猫猫小程序',
      '示例大学校园猫咪展示平台'
    ];
    return {
      title: ShareHelper.pickTitle(titles),
      query: ''
    };
  }
});
