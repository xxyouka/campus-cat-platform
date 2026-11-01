/**
 * pages/admin/admin.js - 管理后台首页
 */
const _app = getApp();
const { requireAdminAuth, clearAdminAuth, checkAdminAuth, getAdminPermissions, isSuperAdminLevel, isFounder } = require('../../utils/adminAuth');
const { ALL_PERMISSIONS } = require('../../utils/adminPermissions');
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const {
  formatStatsTime,
  readStatsCache,
  saveStatsCache,
  clearStatsCache
} = require('./utils/adminStatsCache');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');
const adminBehavior = require('./behaviors/adminBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const obsHelper = require('../../utils/obsHelper');

// onShow 重拉统计的最小间隔。本页是「首页 → 子页 → 返回」的折返入口，
// 每次回到本页都重拉会让一次管理操作叠加多次云调用（下拉刷新不受此限，见 onPullDownRefresh）。
const STATS_REFRESH_MIN_INTERVAL = 30 * 1000;

Page({
  behaviors: [backToTopBehavior, adminBehavior, safeSetDataBehavior],
  data: {
    loading: true,
    statusBarHeight: 20,
    stats: { totalCats: 0, totalPhotos: 0, totalMeets: 0, totalFavorites: 0 },
    updateTime: '',
    isSuperAdmin: false,
    // 创始人徽章（三档顶级：超级管理员之上，唯一能升降级管理员角色）
    isFounder: false,
    // 14 个入口的开关态（由本地权限缓存计算，云函数仍是最终门禁）
    can: {},
    showExportPanel: false,
    exportType: '',
    exportTypeName: '',
    exportFormat: 'csv',
    exportStartDate: '',
    exportEndDate: '',
    exporting: false,
    exportHistory: []
  },

  _exportTypeNames: { cats: '猫咪', cat_complete: '猫咪档案', photos: '照片', meets: '打卡' },

  async onLoad() {
    this._backToTopThreshold = 400;

    try {
      const windowInfo = wx.getWindowInfo();
      this.setData({ statusBarHeight: windowInfo.statusBarHeight || 20 });
    } catch (e) {
      this.setData({ statusBarHeight: 20 });
    }

    // 先用本地权限缓存把菜单渲染出来，避免命中统计快照时先闪一屏空菜单；
    // 随后 requireAdminAuth() 会用服务端最新 permissions 覆盖。
    this._applyAdminPermissions();

    // 先用本地快照把真实内容渲染出来（stale-while-revalidate）。
    // 2026-10-14 性能复盘：本页「页面切换耗时」均值 3758ms（站内第二名的 19 倍），
    // 根因是首屏 LCP 要等「云端鉴权 → 统计」两个**串行**云函数，且两者都带冷启动。
    // 这里只负责「先出内容」——随后仍走 requireAdminAuth() 的严格云端校验，
    // 失败即清快照并退出。
    this._restoreStatsCache();

    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      clearStatsCache();
      // 句柄挂到页面实例，onUnload 中清理，避免用户手动返回后回调再 pop 一页
      // 统一走 adminBehavior.goBack()：页面栈深为 1（短链/URL Scheme 直达）时
      // 裸 navigateBack 会静默失败，用户被留在无权限的后台页里退不出去
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }

    this._applyAdminPermissions();

    obsHelper.reportEvent(obsHelper.EVENT_NAMES.ADMIN_LOGIN, {});

    this._loadExportHistory();

    // 命中快照时不再回落到骨架屏：内容已在屏上，这里只做后台静默刷新
    if (!this._statsFromCache) this.safeSetData({ loading: true });
    await this.loadStats();
    this._initialLoadDone = true;
  },

  async onShow() {
    // 子页返回时按最新本地缓存重算菜单：刚被超管调整权限的管理员，
    // 下一次进入任意管理页都会经 checkAdminStatus 刷新本地权限缓存。
    this._applyAdminPermissions();
    if (!this.data.loading && this._initialLoadDone) {
      // 30s 时间窗：在两个页面之间来回折返时不重复拉统计（下拉刷新不受此限）
      const elapsed = Date.now() - (this._lastStatsLoadedAt || 0);
      if (elapsed >= STATS_REFRESH_MIN_INTERVAL) {
        this.loadStats();
      }
    }
  },

  /**
   * 计算 14 个入口的开关态。
   * 超管及以上（超管/创始人）恒全开；普通管理员按本地权限缓存（缺省 = 默认 3 项）。
   * 仅用于菜单渲染与跳转前的提示，真实拦截在每个云函数。
   * @private
   */
  _applyAdminPermissions() {
    const isSuperAdmin = isSuperAdminLevel();
    const granted = getAdminPermissions();
    const can = {};
    for (const item of ALL_PERMISSIONS) {
      can[item.key] = isSuperAdmin || granted.includes(item.key);
    }
    this.safeSetData({ isSuperAdmin, isFounder: isFounder(), can });
  },

  /**
   * 用本地统计快照先把内容渲染出来（stale-while-revalidate）。
   *
   * 先过本地 checkAdminAuth()（含签名格式校验，篡改即清登录态），与「我的」页的
   * 管理员入口同一口径 —— 快照只含 4 个聚合数字，真正的门禁是紧随其后的
   * requireAdminAuth() 云端校验与每个云函数内的 checkAdmin。
   * 缓存读写与跨天「更新于」文案见 utils/adminStatsCache.js。
   * @private
   */
  _restoreStatsCache() {
    if (!checkAdminAuth()) return;

    const cache = readStatsCache();
    if (!cache) return;

    this._statsFromCache = true;
    this.safeSetData({
      stats: cache.stats,
      updateTime: cache.updateTime || formatStatsTime(cache.savedAt || Date.now()),
      loading: false
    });
  },

  onUnload() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },

  /**
   * 加载统计数据
   * @returns {Promise<boolean>} 是否成功拿到服务端数据（下拉刷新据此决定提示文案）
   */
  async loadStats() {
    let statsOk = false;
    let stats = this.data.stats;
    // 服务端算出这份数字的时刻（命中服务端 60s 缓存时早于本次请求）。
    // 「更新于」必须跟着它走，否则会把 60s 前的快照显示成「刚更新」。
    let computedAt = 0;

    try {
      const statsRes = await ErrorHandler.callCloudFunction('getAdminStats', {}, 10000);
      if (statsRes.result?.success) {
        const sdata = statsRes.result?.data ?? statsRes.result ?? {};
        stats = sdata.stats || stats;
        computedAt = sdata.computedAt || 0;
        statsOk = true;
      } else {
        Logger.warn('admin', '统计数据接口返回失败', { error: statsRes.result?.error });
      }
    } catch (err) {
      Logger.warn('admin', '加载统计数据失败', { error: err.message });
    }

    // 失败时保留上一份数据与「更新于」时间：
    // 原实现无条件把默认值（全 0）写回并刷新时间，管理员会以为看到的是最新统计，
    // 下拉刷新也永远提示「刷新成功」。
    const patch = { loading: false };
    if (statsOk) {
      patch.stats = stats;
      patch.updateTime = formatStatsTime(computedAt || Date.now());
    }
    this.safeSetData(patch);
    // 节流基准：成败都记（失败后立刻重试一遍没有意义，下拉刷新仍可手动重试）
    this._lastStatsLoadedAt = Date.now();
    // 写快照：下次进后台首屏直接用（见 onLoad 的 _restoreStatsCache）
    if (statsOk) saveStatsCache(stats, patch.updateTime);
    if (!statsOk && !this.data.updateTime) {
      // 首载失败：默认全 0 会被当作真实统计展示，必须给出失败提示（下拉可重试）
      wx.showToast({ title: '统计加载失败，可下拉重试', icon: 'none' });
    }
    return statsOk;
  },

  /**
   * 首页跳转前的权限提示（菜单已按权限隐藏，这里兜住缓存过期/误触）。
   * 不在首页调用 goBack：首页本身就是管理后台，跳走反而更困惑。
   * @private
   */
  _ensureCan(key, label) {
    if (this.data.can[key]) return true;
    wx.showToast({ title: `未开通${label}权限`, icon: 'none' });
    return false;
  },

  onGoToAddCat() {
    if (!this._ensureCan('addCat', '添加新猫')) return;
    wx.navigateTo({ url: '/pages/admin/add-cat/add-cat' });
  },

  onGoToCatManage() {
    if (!this._ensureCan('cat', '猫咪管理')) return;
    wx.navigateTo({ url: '/pages/admin/cat-manage/cat-manage' });
  },

  onGoToPhotoManage() {
    if (!this._ensureCan('photo', '照片管理')) return;
    wx.navigateTo({ url: '/pages/admin/photo-manage/photo-manage' });
  },

  onGoToNoticeManage() {
    if (!this._ensureCan('notice', '公告管理')) return;
    wx.navigateTo({ url: '/pages/admin/notice-manage/notice-manage' });
  },

  onGoToRelationManage() {
    if (!this._ensureCan('relation', '关系管理')) return;
    wx.navigateTo({ url: '/pages/admin/relation-manage/relation-manage' });
  },

  onGoToMeetRank() {
    wx.navigateTo({ url: '/pages/admin/meet-rank/meet-rank' });
  },

  onGoToFavRank() {
    wx.navigateTo({ url: '/pages/admin/fav-rank/fav-rank' });
  },

  
  onGoToManageAdmins() {
    // 「管理员管理」永远仅超管可用，不参与入口权限授权
    if (!this.data.isSuperAdmin) {
      wx.showToast({ title: '仅超级管理员可访问', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/admin/manage-admins/manage-admins' });
  },

  onGoToOperationLogs() {
    if (!this._ensureCan('logs', '操作日志')) return;
    wx.navigateTo({ url: '/pages/admin/operation-logs/operation-logs' });
  },

  onGoToCatActivity() {
    if (!this._ensureCan('catActivity', '猫咪行动分析')) return;
    wx.navigateTo({ url: '/pages/admin/cat-activity/cat-activity' });
  },

  onGoToOpsDashboard() {
    if (!this._ensureCan('ops', '运营看板')) return;
    wx.navigateTo({ url: '/pages/admin/ops/ops' });
  },

  
  onGoToMediaReview() {
    if (!this._ensureCan('mediaReview', '内容复核')) return;
    wx.navigateTo({ url: '/pages/admin/media-review/media-review' });
  },

  onGoToReportManage() {
    if (!this._ensureCan('report', '反馈处理')) return;
    wx.navigateTo({ url: '/pages/admin/report-manage/report-manage' });
  },

  
  // 退出登录
  onLogout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          clearAdminAuth();
          // 清掉统计快照：同一台设备可能换人登录，不能让下个身份先看到上个人的数字
          clearStatsCache();
          this._statsFromCache = false;
          // 统一走 adminBehavior.goBack()：页面栈深为 1 时（短链 / URL Scheme
          // / 扫码直达后台）裸 navigateBack 会静默失败，退出登录后**停在无权限的后台页**，
          // 既退不出去也看不到任何提示。同 :46-48 的鉴权失败退出一路。
          this.goBack();
        }
      }
    });
  },

  onOpenExportPanel(e) {
    const type = e.currentTarget.dataset.type;
    let defaultFormat = 'csv';
    if (type === 'cats' || type === 'cat_complete') {
      defaultFormat = 'txt';
    } else if (type === 'photos') {
      defaultFormat = 'zip';
    }
    this.setData({
      showExportPanel: true,
      exportType: type,
      exportTypeName: this._exportTypeNames[type] || type,
      exportFormat: defaultFormat,
      exportStartDate: '',
      exportEndDate: ''
    });
  },

  onCloseExportPanel() {
    this.setData({ showExportPanel: false });
  },

  onExportFormatChange(e) {
    const format = e.currentTarget.dataset.value;
    if (format) {
      this.setData({ exportFormat: format });
    }
  },

  onStartDateChange(e) {
    this.setData({ exportStartDate: e.detail.value });
  },

  onEndDateChange(e) {
    this.setData({ exportEndDate: e.detail.value });
  },

  async onConfirmExport() {
    const { exportType, exportFormat, exportStartDate, exportEndDate } = this.data;

    if (!exportType) return;

    const dateDesc = exportStartDate || exportEndDate
      ? `（${exportStartDate || '最早'} ~ ${exportEndDate || '最新'}）`
      : '';

    wx.showModal({
      title: '确认导出',
      content: `将导出${this._exportTypeNames[exportType]}数据${dateDesc}，格式: ${exportFormat.toUpperCase()}`,
      success: async (res) => {
        if (!res.confirm) return;

        this.setData({ exporting: true });
        wx.showLoading({ title: '导出中…', mask: true });

        try {
          const params = {
            type: exportType,
            format: exportFormat
          };
          if (exportStartDate) params.startDate = exportStartDate;
          if (exportEndDate) params.endDate = exportEndDate;

          const result = await this.callAdminFunction('exportData', params);

          wx.hideLoading();
          this.safeSetData({ exporting: false });

          if (result.result?.success) {
            const edata = result.result?.data ?? result.result ?? {};
            const { count, skipped, downloadUrl, format } = edata;
            // 服务端因内存预算 / 张数上限截断时（exportPhotosAsZip）会回传 skipped。
            // 不消费它就会把「部分导出」谎报成「已导出 N 条」，管理员拿到的文件缺数据而不自知。
            const skippedCount = Number(skipped) || 0;

            this._saveExportHistory({
              type: exportType,
              typeName: this._exportTypeNames[exportType],
              count,
              skipped: skippedCount,
              format,
              // 持久化下载地址：导出历史条目支持「重新下载」（临时链接 24h 内有效），
              // 不存的话 onRedownload 取不到 URL，功能形同虚设
              downloadUrl: downloadUrl || '',
              // wxml 不支持 JS 方法调用，导出历史列表渲染的是 {{item.format.toUpperCase()}}
              // → 恒为空白。写入前先算好大写形式供 wxml 直接绑定。
              formatUpper: String(format || '').toUpperCase(),
              dateDesc,
              time: new Date().toLocaleString('zh-CN')
            });

            this.safeSetData({ showExportPanel: false });

            const title = skippedCount > 0 ? '部分导出' : '导出成功';
            const skippedDesc = skippedCount > 0 ? `，另有 ${skippedCount} 条因数据量上限未导出` : '';
            wx.showModal({
              title,
              content: `已导出${count}条${this._exportTypeNames[exportType]}数据${skippedDesc}，点击确定下载${String(format || '').toUpperCase()}文件`,
              success: (modalRes) => {
                if (modalRes.confirm && downloadUrl) {
                  this._downloadExportFile(downloadUrl, format);
                }
              }
            });
          } else {
            ErrorHandler.handle(new Error(result.result?.error || '导出失败'));
          }
        } catch (err) {
          wx.hideLoading();
          this.safeSetData({ exporting: false });
          ErrorHandler.handle(err, { title: '导出失败' });
        }
      }
    });
  },

  _downloadExportFile(downloadUrl, format) {
    // 白名单校验 format：防止恶意/异常值传入 wx.openDocument
    const ALLOWED_FORMATS = ['csv', 'zip', 'txt', 'xlsx'];
    const safeFormat = ALLOWED_FORMATS.includes(format) ? format : 'csv';
    wx.downloadFile({
      url: downloadUrl,
      success: (downloadRes) => {
        wx.openDocument({
          filePath: downloadRes.tempFilePath,
          fileType: safeFormat,
          fail: () => {
            wx.setClipboardData({ data: downloadUrl });
            wx.showToast({ title: '链接已复制', icon: 'none' });
          }
        });
      },
      fail: () => {
        wx.setClipboardData({ data: downloadUrl });
        wx.showToast({ title: '链接已复制', icon: 'none' });
      }
    });
  },

  _saveExportHistory(record) {
    try {
      const raw = wx.getStorageSync('exportHistory') || [];
      const history = Array.isArray(raw) ? raw : [];
      history.unshift(record);
      if (history.length > 10) history.length = 10;
      wx.setStorageSync('exportHistory', history);
      this.setData({ exportHistory: history });
    } catch (e) {
      Logger.debug('admin', '保存导出历史失败', e.message);
    }
  },

  _loadExportHistory() {
    try {
      const raw = wx.getStorageSync('exportHistory') || [];
      const history = Array.isArray(raw) ? raw : [];
      this.setData({ exportHistory: history });
    } catch (e) {
      Logger.debug('admin', '加载导出历史失败', e.message);
    }
  },

  onClearExportHistory() {
    wx.showModal({
      title: '清除记录',
      content: '确定要清除所有导出记录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('exportHistory');
          this.setData({ exportHistory: [] });
          wx.showToast({ title: '已清除', icon: 'success' });
        }
      }
    });
  },

  onRedownload(e) {
    const { url, format } = e.currentTarget.dataset;
    if (url) {
      this._downloadExportFile(url, format || 'csv');
    }
  },

  // onPageScroll 和 onBackToTop 由 backToTopBehavior 提供（含节流）


  async onPullDownRefresh() {
    wx.showNavigationBarLoading();
    try {
      const statsOk = await this.loadStats();
      // 失败时如实提示：loadStats 会保留上一份数据，不能谎报「刷新成功」
      if (statsOk) {
        ErrorHandler.showSuccess('刷新成功');
      } else {
        wx.showToast({ title: '刷新失败，展示的是上次数据', icon: 'none' });
      }
    } finally {
      wx.hideNavigationBarLoading();
      wx.stopPullDownRefresh();
    }
  }
});
