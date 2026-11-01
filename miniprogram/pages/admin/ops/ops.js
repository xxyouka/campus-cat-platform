/**
 * pages/admin/ops/ops.js - 运营数据面板（管理端只读）
 *
 * 固定三个指标，不随新功能改口径：
 *   新用户激活 / 首个打卡完成率 / 关注后回访率。
 * 另附「入口使用」清单：最近 28 天 0 人使用的入口标为淘汰候选，
 * 每周复盘时据此下线入口，而不是继续加页面。
 *
 * 数据全部来自云函数 getOpsDashboard（服务端匿名聚合），本页不直连数据库。
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const { formatStatsTime } = require('../utils/adminStatsCache');
const { getRegistry } = require('../../../utils/opsTrack');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

const RANGE_OPTIONS = [4, 8, 12];
const DEFAULT_RANGE = 8;

const STATUS_TEXT = {
  unused: '淘汰候选',
  watch: '观察',
  keep: '保留',
  observing: '观测中'
};
const STATUS_ORDER = { unused: 0, watch: 1, observing: 2, keep: 3 };

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = value * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function countText(value) {
  if (value === null || value === undefined) return '—';
  return String(value);
}

function barWidth(value) {
  if (!value) return 0;
  return Math.max(2, Math.min(100, Math.round(value * 100)));
}

function dayText(ts) {
  if (!ts) return '';
  // 服务端按北京时间记日；这里也用固定 +8 偏移，避免设备时区不同显示成前一天。
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function buildCards(current) {
  if (!current) return [];
  const activation = {
    key: 'activation',
    icon: 'sparkle',
    label: '新用户激活',
    value: percent(current.activationRate),
    barWidth: barWidth(current.activationRate),
    sub: `${current.activatedUsers}/${current.maturedNewUsers} 人完成核心动作`,
    hint: '首见后 7 天内打卡或关注'
  };
  const firstMeet = {
    key: 'firstMeet',
    icon: 'paw',
    label: '首个打卡完成',
    value: percent(current.firstMeetRate),
    barWidth: barWidth(current.firstMeetRate),
    sub: `${current.firstMeetUsers}/${current.maturedNewUsers} 人在 7 天内打卡`,
    hint: '新用户第一次记录相遇'
  };
  const followReturn = {
    key: 'followReturn',
    icon: 'heart',
    label: '关注后回访',
    value: percent(current.followReturnRate),
    barWidth: barWidth(current.followReturnRate),
    sub: `${current.returnedFollowers}/${current.maturedFollowers} 人 7 天内再来`,
    hint: '首次关注后另一天打开小程序'
  };

  return [activation, firstMeet, followReturn];
}

function buildWeeks(weeks) {
  return (weeks || []).map((week) => ({
    key: week.key,
    label: week.label,
    isCurrent: week.isCurrent,
    noData: !week.hasData,
    partial: week.isPartial,
    newUsers: week.hasData ? countText(week.newUsers) : '—',
    activation: percent(week.activationRate),
    firstMeet: percent(week.firstMeetRate),
    followReturn: percent(week.followReturnRate)
  }));
}

function buildEntries(entryBlock) {
  const items = entryBlock && entryBlock.items ? entryBlock.items : [];
  const pruneReady = !!(entryBlock && entryBlock.pruneReady);
  const byName = new Map(items.map(item => [item.name, item]));
  const registry = getRegistry();
  const known = new Set(registry.map(item => item.name));

  const rows = registry.map((meta) => {
    const item = byName.get(meta.name);
    const users28 = item ? item.users28 : 0;
    const status = item ? item.status : pruneReady ? 'unused' : 'observing';
    return {
      name: meta.name,
      label: meta.label,
      hint: meta.hint,
      group: meta.group,
      users28,
      share: item ? item.share : 0,
      barWidth: barWidth(item ? item.share : 0),
      lastDay: item ? item.lastDay : '',
      status,
      statusText: STATUS_TEXT[status] || status
    };
  });

  // 旧版本客户端可能上报了已从注册表删除的入口：不丢弃，标成「未登记」，
  // 让复盘时能看到它还有没有人在用，再决定是否彻底删掉。
  for (const item of items) {
    if (known.has(item.name)) continue;
    rows.push({
      name: item.name,
      label: item.name,
      hint: '未登记入口（可能来自旧版本）',
      group: '未登记',
      users28: item.users28,
      share: item.share,
      barWidth: barWidth(item.share),
      lastDay: item.lastDay,
      status: item.status,
      statusText: STATUS_TEXT[item.status] || item.status
    });
  }

  rows.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] === undefined ? 9 : STATUS_ORDER[a.status];
    const sb = STATUS_ORDER[b.status] === undefined ? 9 : STATUS_ORDER[b.status];
    if (sa !== sb) return sa - sb;
    return b.users28 - a.users28 || (a.label < b.label ? -1 : 1);
  });
  return rows;
}

function buildCoverage(coverage, entryBlock) {
  const c = coverage || {};
  const trackingText = c.trackingStartAt
    ? `活跃数据自 ${dayText(c.trackingStartAt)} 起记录，已累计 ${c.trackingDays} 天`
    : '还没有用户活跃记录：请先在管理端执行 initDatabase，并部署 trackOps';
  const pruneReady = !!(entryBlock && entryBlock.pruneReady);
  const pruneText = pruneReady
    ? '入口淘汰判定已启用：最近 28 天 0 人使用 = 淘汰候选'
    : `入口淘汰判定还要等 ${Math.max(0, 28 - (c.trackingDays || 0))} 天（满 28 天才判 0 使用）`;
  return {
    ...c,
    trackingText,
    pruneText,
    activeUsers28: entryBlock ? entryBlock.activeUsers28 : 0,
    windowDays: entryBlock ? entryBlock.windowDays : 28
  };
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],

  data: {
    loading: true,
    loadFailed: false,
    rangeWeeks: DEFAULT_RANGE,
    ranges: RANGE_OPTIONS,
    skeletonItems: [1, 2, 3, 4],
    cards: [],
    weeks: [],
    entries: [],
    entriesAvailable: true,
    entryPruneReady: false,
    entrySummary: { unused: 0, watch: 0, observing: 0, keep: 0 },
    coverage: {},
    warnings: [],
    updateTime: '',
    hasData: false
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能停在骨架屏：loading 初值为 true，页面会永远转圈
      this.safeSetData({ loading: false, loadFailed: true });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      return;
    }
    if (!this.guardPermission('ops', '运营看板')) {
      this.safeSetData({ loading: false });
      return;
    }
    await this.loadDashboard();
  },

  onUnload() {
    this._isUnmounted = true;
    if (this._navBackTimer) {
      clearTimeout(this._navBackTimer);
      this._navBackTimer = null;
    }
  },

  onPullDownRefresh() {
    return this.loadDashboard().finally(() => wx.stopPullDownRefresh());
  },

  onRetry() {
    return this.loadDashboard();
  },

  onRangeChange(e) {
    const weeks = Number(e.currentTarget.dataset.weeks);
    if (!RANGE_OPTIONS.includes(weeks) || weeks === this.data.rangeWeeks) return;
    this.safeSetData({ rangeWeeks: weeks });
    return this.loadDashboard();
  },

  async loadDashboard() {
    if (this._loadingDashboard) {
      // 加载中切周期 / 点重试：记一次待办，当前请求结束后按最新 rangeWeeks 再拉，
      // 否则页面会停在旧周期的数据上，和顶部选中的周期对不上。
      this._reloadRequested = true;
      return;
    }
    this._loadingDashboard = true;
    this._seq = (this._seq || 0) + 1;
    const seq = this._seq;
    // 有旧数据时静默刷新，不把整页打成骨架屏
    this.safeSetData({ loading: this.data.weeks.length === 0, loadFailed: false });

    try {
      const res = await this.callAdminFunction('getOpsDashboard', { weeks: this.data.rangeWeeks });
      if (seq !== this._seq) return;
      if (!res.result || !res.result.success) {
        throw new Error(res.result && res.result.error ? res.result.error : '加载失败');
      }
      const payload = res.result.data || res.result || {};
      if (seq !== this._seq) return;

      const weeks = buildWeeks(payload.weeks);
      const current = (payload.weeks || [])[(payload.weeks || []).length - 1] || null;
      const entries = buildEntries(payload.entries);
      const coverage = buildCoverage(payload.coverage, payload.entries);
      const entrySummary = { unused: 0, watch: 0, observing: 0, keep: 0 };
      entries.forEach((item) => {
        if (entrySummary[item.status] !== undefined) entrySummary[item.status]++;
      });

      this.safeSetData({
        loading: false,
        loadFailed: false,
        weeks,
        cards: buildCards(current),
        entries,
        entriesAvailable: !(payload.entries && payload.entries.dataAvailable === false),
        entryPruneReady: !!(payload.entries && payload.entries.pruneReady),
        entrySummary,
        coverage,
        warnings: Array.isArray(payload.dataWarnings) ? payload.dataWarnings : [],
        updateTime: formatStatsTime(payload.computedAt || Date.now()),
        hasData: !!(current && current.hasData)
      });
    } catch (err) {
      if (seq !== this._seq) return;
      Logger.warn('ops', '加载运营数据失败', { error: err && err.message });
      ErrorHandler.handle(err, { title: '运营数据加载失败' });
      // 有旧数据时保留旧数据，只提示失败；没有数据才展示独立失败态。
      this.safeSetData({
        loading: false,
        loadFailed: this.data.weeks.length === 0
      });
    } finally {
      this._loadingDashboard = false;
      if (this._reloadRequested) {
        this._reloadRequested = false;
        this.loadDashboard();
      }
    }
  }
});
