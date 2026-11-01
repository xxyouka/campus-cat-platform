// pages/meets/meets.js - 相遇打卡动态页
const { timeAgo } = require('../../utils/dateFormat');
const ErrorHandler = require('../../utils/errorHandler');
const { Logger } = require('../../utils/logger');
const statusTagUtil = require('../../utils/statusTag');
const opsTrack = require('../../utils/opsTrack');
const guideTourBehavior = require('../../behaviors/guideTourBehavior');
const safeSetDataBehavior = require('../../behaviors/safeSetDataBehavior');
const backToTopBehavior = require('../../behaviors/backToTopBehavior');

const PAGE_SIZE = 20;

// 本页会从「相遇 → 详情 → 返回」这类路径反复进入。15s 内重复进入不发请求，
// 只在数据可能已变（新打卡、下拉刷新）之后才重拉。
const MEETS_CACHE_WINDOW = 15000;

Page({
  behaviors: [safeSetDataBehavior, backToTopBehavior, guideTourBehavior],
  data: {
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    calendarYear: new Date().getFullYear(),
    calendarMonth: new Date().getMonth(),
    calendarCells: [],
    meetDays: [],
    dayDetails: {},
    selectedDay: 0,
    selectedDayDetails: [],
    stats: { totalDays: 0, streakDays: 0, monthDays: 0 },
    statsDisplay: { totalDays: 0, streakDays: 0, monthDays: 0 },
    meets: [],
    meetsWithAnim: [],
    loading: true,
    // 首屏加载失败（记录为空时展示错误态 + 重试）
    loadError: false,
    loadingMore: false,
    hasMore: true,
    showBackToTop: false,
    page: 1,
    skeletonItems: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  },

  _loadingMore: false,

  async onShow() {
    opsTrack.entry('meets');
    this.initGuideTour('pages/meets/meets', { delay: 900 });
    // 原先这里有 `if (this._skipOnce) { this._skipOnce = false; return; }`，
    // 但全项目没有任何一处把 _skipOnce 置 true —— 分支永不进入，
    // 却让维护者以为存在「跳过首屏加载」机制。已删除。
    this.setData({ loading: true });
    await this.loadAllData();
  },

  onHide() {
    this.pauseGuideTour();
  },

  onPullDownRefresh() {
    return this.loadAllData().finally(() => wx.stopPullDownRefresh());
  },

  /**
   * 安全调用云函数：失败时记录告警并返回 null，不中断页面加载
   */
  async _safeCloudCall(name, data, warnText) {
    try {
      return await wx.cloud.callFunction({ name, data });
    } catch (err) {
      Logger.warn('meets', warnText, { error: err.message });
      return null;
    }
  },

  /**
   * 拉取相遇记录与月度日历（任一失败降级为 null，由调用方决定回退策略）
   */
  async _fetchMeetsAndCalendar(year, month) {
    // 两个独立云函数并行请求（各自内部已 catch 降级，任一失败不影响另一个）
    const [meetsRes, calendarRes] = await Promise.all([
      this._safeCloudCall('getMyMeets', { page: 1, pageSize: PAGE_SIZE }, '加载相遇记录失败'),
      this._safeCloudCall('getMeetCalendar', { year, month }, '加载日历失败')
    ]);
    return { meetsRes, calendarRes };
  },

  async loadAllData() {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();

      // onShow 缓存窗口：meets 不是 tabBar 页，但会从详情页/其他页面反复进入。
      // 15s 内重复进入不发请求，避免「返回上一页再点进来又转一圈」。
      if (this._meetsLoadedAt && Date.now() - this._meetsLoadedAt < MEETS_CACHE_WINDOW) {
        this.setData({ loading: false });
        return;
      }

      const { meetsRes, calendarRes } = await this._fetchMeetsAndCalendar(year, month);

      if (!meetsRes || !meetsRes.result?.success) {
        throw new Error(meetsRes?.result?.error || '加载失败');
      }

      const mData = meetsRes.result?.data ?? meetsRes.result ?? {};
      // 头像保持 cloud:// 原样下发：wxml 里的 lazy-image 的 src 原生支持 cloud://
      // （内部按 type 转链，本页两处头像区只有 64/88rpx，走 avatar 档比原先统一
      // 转成 thumbnail 200px 更合适也更小）。
      // 旧实现先 await 一次 getTempUrls 再 setData，首屏多付一个完整往返。
      const allMeets = mData.meets || [];
      this._meetsLoadedAt = Date.now();
      // 注：这里的 allMeets 是**第一页**（PAGE_SIZE 条），不是全量相遇记录。
      // 原先的 this._allMeets 字段只写不读（全项目无读取点），却让维护者
      // 以为存在「全量相遇数据缓存」。已删除。
      // getMeetCalendar 失败时会用这份截断数据算累计天数/连续天数（≤PAGE_SIZE），
      //    数字看起来合法但偏小 —— 属已知的降级口径，非静默错误。
      const recentMeets = allMeets.slice(0, PAGE_SIZE).map((m, index) => ({
        ...m,
        ...statusTagUtil.decorateMeet(m),
        _timeAgo: timeAgo(m.meetTime),
        _animIndex: index
      }));

      const hasMore = mData.hasMore || false;

      if (calendarRes && calendarRes.result?.success) {
        const calData = calendarRes.result?.data ?? calendarRes.result ?? {};
        const meetDays = Array.isArray(calData.meetDays) ? calData.meetDays : [];
        const dayDetails = calData.dayDetails || {};
        const totalDays = calData.totalDays || 0;
        const streakDays = calData.streakDays || 0;
        const monthDays = calData.monthDays || meetDays.length;

        // 统计一律采用云端全量口径：meetDays 为空只代表「当月无打卡」，
        // 不代表没有累计数据。原实现用 `meetDays.length > 0` 判定「云端统计可信」，
        // 空月（月初/断更期）时退回用第一页（≤20 条）本地推算，累计/连续天数被截断
        //（真实 15 天可能显示 7 天），且与「我的」页（全量扫描）数字互相矛盾。
        const calendarCells = this._buildCalendarCells(year, month, meetDays);
        this.safeSetData({
          calendarYear: year,
          calendarMonth: month,
          meetDays,
          dayDetails,
          calendarCells,
          stats: { totalDays, streakDays, monthDays },
          meets: recentMeets,
          meetsWithAnim: recentMeets,
          hasMore,
          page: 2,
          loading: false
        });
        // 刷新后重建已选日的详情面板：onTapCell 存的是 dayDetails 的**引用**，
        // 只覆盖 dayDetails 不重建 selectedDayDetails 会显示刷新前的旧条目
        if (this.data.selectedDay) {
          this.safeSetData({ selectedDayDetails: dayDetails[this.data.selectedDay] || [] });
        }
        this._animateStatsNumbers(totalDays, streakDays, monthDays);
      } else {
        this._computeCalendar(year, month, allMeets);
        this.setData({
          meets: recentMeets,
          meetsWithAnim: recentMeets,
          hasMore,
          page: 2,
          loading: false
        });
      }

    } catch (err) {
      Logger.warn('meets', '加载数据失败', { error: err.message });
      // 记录为空时展示错误态（保留重试入口）；已有数据时仅 toast
      this.safeSetData({
        loading: false,
        loadError: this.data.meets.length === 0
      });
      ErrorHandler.handle(err, { title: '加载失败' });
    }
  },

  /**
   * 错误态重试
   */
  onRetryLoad() {
    this.setData({ loadError: false, loading: true });
    this.loadAllData();
  },

  _computeCalendar(year, month, allMeets) {
    const monthStart = new Date(year, month, 1).getTime();
    const monthEnd = new Date(year, month + 1, 1).getTime();

    const monthMeets = allMeets.filter(m => m.meetTime >= monthStart && m.meetTime < monthEnd);

    const meetDays = [...new Set(
      monthMeets.map(m => new Date(m.meetTime).getDate())
    )].sort((a, b) => a - b);

    const dayDetails = {};
    monthMeets.forEach(m => {
      const day = new Date(m.meetTime).getDate();
      if (!dayDetails[day]) dayDetails[day] = [];
      dayDetails[day].push({
        catId: m.catId,
        catName: m.catName || '',
        catAvatar: m.catAvatar || '',
        location: m.location || m.campus || '',
        statusTag: m.statusTag || '',
        ...statusTagUtil.decorateMeet(m)
      });
    });

    const allDaysSet = new Set();
    allMeets.forEach(m => {
      const d = new Date(m.meetTime);
      allDaysSet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    });
    const totalDays = allDaysSet.size;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(today.getTime() - i * 86400000);
      const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
      if (allDaysSet.has(key)) {
        streakDays++;
      } else {
        if (i === 0) continue;
        break;
      }
    }

    const calendarCells = this._buildCalendarCells(year, month, meetDays);

    this.setData({
      calendarYear: year,
      calendarMonth: month,
      meetDays,
      dayDetails,
      calendarCells,
      stats: { totalDays, streakDays, monthDays: meetDays.length }
    });

    this._animateStatsNumbers(totalDays, streakDays, meetDays.length);
  },

  _animateStatsNumbers(targetTotal, targetStreak, targetMonth) {
    if (this._animateTimer) {
      clearInterval(this._animateTimer);
      this._animateTimer = null;
    }

    // 降帧优化：从 40 步降到 8 步，setData 次数减少 80%
    const duration = 800;
    const steps = 8;
    const interval = duration / steps;

    let step = 0;

    this._animateTimer = setInterval(() => {
      step++;
      const progress = step / steps;
      const easeOut = 1 - Math.pow(1 - progress, 3);

      this.safeSetData({
        statsDisplay: {
          totalDays: Math.floor(targetTotal * easeOut),
          streakDays: Math.floor(targetStreak * easeOut),
          monthDays: Math.floor(targetMonth * easeOut)
        }
      });

      if (step >= steps) {
        this.safeSetData({
          statsDisplay: {
            totalDays: targetTotal,
            streakDays: targetStreak,
            monthDays: targetMonth
          }
        });
        clearInterval(this._animateTimer);
        this._animateTimer = null;
      }
    }, interval);
  },

  async _tryLoadCalendarFromCloud(year, month) {
    // 请求序号 + 年月校验：翻月时标题（calendarYear/calendarMonth）是同步切换的，
    // 连点「‹」两次会有两个请求并行；若旧响应后到，会出现标题是 X 月、
    // 格子与统计却是 X+1 月数据的错位，点格子的当天详情同样错位。
    // 因此响应落盘前必须确认「自己仍是最新请求」且「年月仍是当前显示的年月」。
    this._calendarSeq = (this._calendarSeq || 0) + 1;
    const seq = this._calendarSeq;
    const isStale = () =>
      seq !== this._calendarSeq ||
      this.data.calendarYear !== year ||
      this.data.calendarMonth !== month;

    // 失败时也按当前（已切换的）年月重建空网格，保证标题与格子一致
    const resetToEmptyMonth = () => {
      if (isStale()) return;
      // stats / statsDisplay 必须一并重置：否则网格已空、统计卡仍显示上一个月数字，
      // 用户无法区分「翻月请求失败」与「那个月真的没打卡」
      this.safeSetData({
        meetDays: [],
        dayDetails: {},
        calendarCells: this._buildCalendarCells(year, month, []),
        stats: { totalDays: 0, streakDays: 0, monthDays: 0 },
        statsDisplay: { totalDays: 0, streakDays: 0, monthDays: 0 }
      });
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'getMeetCalendar',
        data: { year, month }
      });

      if (isStale()) return;

      if (!res.result?.success) {
        resetToEmptyMonth();
        return;
      }

      const data = res.result?.data ?? res.result ?? {};
      const { meetDays, dayDetails, totalDays, streakDays, monthDays } = data;
      const calendarCells = this._buildCalendarCells(year, month, meetDays || []);

      this.safeSetData({
        meetDays: meetDays || [],
        dayDetails: dayDetails || {},
        calendarCells,
        stats: { totalDays, streakDays, monthDays }
      });

      // statsDisplay 才是 wxml:46/51/56 渲染的字段，它只由 _animateStatsNumbers 写入。
      // 翻月入口（onPrevMonth:380 / onNextMonth:396）直接调本函数、不经首屏，
      // 漏掉这一行会让三个统计大数字永远停在首月数值（网格与「共 X 天」却已切换）。
      this._animateStatsNumbers(totalDays || 0, streakDays || 0, monthDays || 0);
    } catch (err) {
      Logger.warn('meets', '日历加载失败', { error: err.message });
      resetToEmptyMonth();
    }
  },

  _buildCalendarCells(year, month, meetDays) {
    const now = new Date();
    const todayYear = now.getFullYear();
    const todayMonth = now.getMonth();
    const todayDate = now.getDate();

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    const selectedDay = this.data.selectedDay;
    let cellIndex = 0;

    for (let i = 0; i < firstDay; i++) {
      cells.push({ _id: `empty-${cellIndex++}`, day: 0, checked: false, isToday: false, future: false, selected: false });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = year === todayYear && month === todayMonth && day === todayDate;
      const checked = meetDays.includes(day);
      const isFuture = new Date(year, month, day) > now && !isToday;
      const selected = day === selectedDay && checked;

      cells.push({ _id: `day-${day}`, day, checked, isToday, future: isFuture, selected });
    }

    const remaining = cells.length % 7;
    if (remaining > 0) {
      for (let i = 0; i < 7 - remaining; i++) {
        cells.push({ _id: `pad-${cellIndex++}`, day: 0, checked: false, isToday: false, future: false, selected: false });
      }
    }

    return cells;
  },

  onPrevMonth() {
    let { calendarYear, calendarMonth } = this.data;
    const now = new Date();
    const minDate = new Date(now.getFullYear(), now.getMonth() - 12, 1);

    calendarMonth--;
    if (calendarMonth < 0) {
      calendarMonth = 11;
      calendarYear--;
    }

    if (new Date(calendarYear, calendarMonth, 1) < minDate) return;

    this.setData({ calendarYear, calendarMonth, selectedDay: 0, selectedDayDetails: [] });
    this._tryLoadCalendarFromCloud(calendarYear, calendarMonth);
  },

  onNextMonth() {
    let { calendarYear, calendarMonth } = this.data;
    const now = new Date();

    calendarMonth++;
    if (calendarMonth > 11) {
      calendarMonth = 0;
      calendarYear++;
    }

    if (new Date(calendarYear, calendarMonth, 1) > new Date(now.getFullYear(), now.getMonth() + 1, 1)) return;

    this.setData({ calendarYear, calendarMonth, selectedDay: 0, selectedDayDetails: [] });
    this._tryLoadCalendarFromCloud(calendarYear, calendarMonth);
  },

  onTapCell(e) {
    const { day, checked, future } = e.currentTarget.dataset;
    if (!day || !checked || future) return;

    if (this.data.selectedDay === day) {
      this.setData({ selectedDay: 0, selectedDayDetails: [] });
    } else {
      const details = this.data.dayDetails[day] || [];
      this.setData({ selectedDay: day, selectedDayDetails: details });
    }

    const calendarCells = this._buildCalendarCells(this.data.calendarYear, this.data.calendarMonth, this.data.meetDays);
    this.setData({ calendarCells });
  },

  onCloseDayDetail() {
    this.setData({ selectedDay: 0, selectedDayDetails: [] });
    const calendarCells = this._buildCalendarCells(this.data.calendarYear, this.data.calendarMonth, this.data.meetDays);
    this.setData({ calendarCells });
  },

  async loadMoreMeets() {
    if (!this.data.hasMore || this._loadingMore) return;
    this._loadingMore = true;
    this.safeSetData({ loadingMore: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'getMyMeets',
        data: { page: this.data.page, pageSize: PAGE_SIZE }
      });

      // 业务失败不能静默 return：否则用户点了「加载更多」毫无反应，
      // 分不清是没网还是没数据（同 favorites.js:177-180 的 ErrorHandler 口径）
      if (!res.result?.success) {
        throw new Error(res.result?.error || '加载失败');
      }

      const data = res.result?.data ?? res.result ?? {};
      // 头像同 loadAllData 的口径：保持 cloud:// 由 lazy-image 自行转链
      // 追加页的动画序号从 0 重新起算：用累计序号（20、21、…）配 `animation-delay: idx*60ms`
      // 会让第 21~40 张在 1.2~2.3 秒后才逐张淡入，用户以为「加载更多没反应」而重复点击
      const newMeets = (data.meets || []).map((m, index) => ({
        ...m,
        ...statusTagUtil.decorateMeet(m),
        _timeAgo: timeAgo(m.meetTime),
        _animIndex: Math.min(index, 10)
      }));

      const updatedList = [...this.data.meetsWithAnim, ...newMeets];
      this.safeSetData({
        meets: updatedList,
        meetsWithAnim: updatedList,
        hasMore: data.hasMore || false,
        page: this.data.page + 1
      });
    } catch (err) {
      Logger.warn('meets', '加载更多失败', { error: err.message });
      // 补用户可见反馈：原先只写日志，「加载更多」点了没反应
      ErrorHandler.handle(err, { title: '加载失败' });
    } finally {
      this._loadingMore = false;
      this.safeSetData({ loadingMore: false });
    }
  },

  onGoToDetail(e) {
    const catId = e.currentTarget.dataset.catId;
    if (catId) wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(catId)}` });
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onUnload() {
    this._isUnmounted = true;
    this.destroyGuideTour();
    if (this._animateTimer) {
      clearInterval(this._animateTimer);
      this._animateTimer = null;
    }
  },

  /**
   * 解析相遇记录里的猫咪头像
   *
   * 这些头像只用于列表/卡片（day-detail 64rpx、meet 卡片 88rpx）与日历详情，
   * 没有任何全屏预览用途，故统一走 imageLoader 的 thumbnail 档（200×200 webp）：
   * 既拿到尺寸优化（原先直连 getTempFileURL 拿的是原图整张），
   * 也吃到「fileID@档位」缓存，并保证全站只有 imageLoader 一套换链实现。
   */
});
