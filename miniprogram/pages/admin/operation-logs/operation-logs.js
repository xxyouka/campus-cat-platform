// pages/admin/operation-logs/operation-logs.js - 管理端：操作日志查看页
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const { requireAdminAuth } = require('../../../utils/adminAuth');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');

const MODULES = [
  { value: '', label: '全部模块' },
  { value: 'cat', label: '猫咪管理' },
  { value: 'photo', label: '照片管理' },
  { value: 'mediaCheck', label: '内容复核' },
  { value: 'notice', label: '公告管理' },
  { value: 'health', label: '健康档案' },
  { value: 'admin', label: '管理员管理' },
  { value: 'export', label: '数据导出' },
  { value: 'system', label: '系统' }
];

// 必须与 cloudfunctions/getOperationLogs/index.js:17 的服务端白名单逐字一致。
// 该文件注释记录：fixRecordOpenid 写 'fix_record_openid'、exportData 写 'export_data'，
// 两者原先不在白名单里，传入时服务端会「静默取消过滤并返回全量日志」——
// 服务端已补，前端枚举曾长期未同步，导致这两类日志无法按操作类型筛选。
const ACTIONS = [
  { value: '', label: '全部操作' },
  { value: 'create', label: '创建' },
  { value: 'edit', label: '编辑' },
  { value: 'delete', label: '删除' },
  { value: 'import', label: '导入' },
  { value: 'export', label: '导出' },
  { value: 'login', label: '登录' },
  { value: 'logout', label: '登出' },
  { value: 'fix_record_openid', label: '修复 openid' },
  { value: 'export_data', label: '数据导出' }
];

// 列表展示用中文标签：与筛选枚举同源，避免两处各写一份字符串
const MODULE_LABELS = Object.fromEntries(MODULES.map(m => [m.value, m.label]));
const ACTION_LABELS = Object.fromEntries(ACTIONS.map(a => [a.value, a.label]));

const RESULTS = [
  { value: '', label: '全部结果' },
  { value: 'success', label: '成功' },
  { value: 'fail', label: '失败' }
];

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],
  data: {
    loading: true,
    collectionNotExists: false,
    // 取不到日志与「确实没有日志」必须分开显示（wxml 两个空态）
    loadFailed: false,
    skeletonItems: [1, 2, 3, 4],

    filters: {
      adminAccount: '',
      module: '',
      action: '',
      result: '',
      startTime: '',
      endTime: '',
      keyword: ''
    },
    hasActiveFilter: false,

    showFilterPanel: false,

    modules: MODULES,
    modulesLabels: MODULES.map(m => m.label),
    actions: ACTIONS,
    actionsLabels: ACTIONS.map(a => a.label),
    results: RESULTS,
    resultsLabels: RESULTS.map(r => r.label),

    moduleIndex: 0,
    actionIndex: 0,
    resultIndex: 0,

    logs: [],
    stats: {},
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!this.guardPermission('logs', '操作日志')) {
      this.safeSetData({ loading: false });
      return;
    }
    this.loadLogs();
  },

  onUnload() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },

  async loadLogs(reset = true) {
    if (reset) this.setData({ page: 1, loading: true });

    // 请求序号：筛选重置（onSearch / onClearFilters / 下拉刷新）会自增，
    // 在途的「加载更多」响应落地时若序号已变则整体丢弃 —— 否则会把旧筛选的日志
    // 追加进新筛选结果，并回写旧的 page/total/hasMore，后续翻页口径错乱。
    this._logsSeq = (this._logsSeq || 0) + 1;
    const seq = this._logsSeq;

    try {
      const { filters, page, pageSize } = this.data;
      const params = { page: reset ? 1 : page, pageSize };

      if (filters.adminAccount) params.adminAccount = filters.adminAccount;
      if (filters.module) params.module = filters.module;
      if (filters.action) params.action = filters.action;
      if (filters.result) params.result = filters.result;
      if (filters.startTime) params.startTime = filters.startTime;
      if (filters.endTime) params.endTime = filters.endTime;
      if (filters.keyword) params.keyword = filters.keyword;

      const res = await this.callAdminFunction('getOperationLogs', params);

      if (seq !== this._logsSeq) return false;

      if (res.result?.success) {
        const data = res.result?.data ?? res.result ?? {};
        // skip/limit 偏移窗口整体位移，边界日志会在相邻两页重复出现，
        // 而 wx:key="_id" 遇到重复 key 会渲染错位
        const base = reset ? [] : this.data.logs;
        const seen = new Set(base.map(l => l._id));
        const newLogs = [...base, ...(data.logs || []).filter(l => l && !seen.has(l._id))];
        const processedLogs = newLogs.map(l => ({
          ...l,
          moduleLabel: MODULE_LABELS[l.module] || l.module || '',
          actionLabel: ACTION_LABELS[l.action] || l.action || '',
          _expanded: false,
          // 标题优先用服务端算好的摘要（summary：「编辑猫咪「小花」：状态 在校 → 走失」）。
          // 老日志没有 summary —— 本次改造前的记录一律回退到 description，
          // 否则 90 天保留期内的历史日志会整片显示空白标题，
          // 且「取不到摘要」和「日志为空」在界上将无法区分。
          displaySummary: l.summary || l.description || '',
          // changes 同理：非数组（含老日志的 undefined）一律降级为空数组，
          // 让 wxml 可以无脑 .length / wx:for，不必到处写三元判断
          changes: Array.isArray(l.changes) ? l.changes : []
        }));
        this.safeSetData({
          logs: processedLogs,
          stats: data.stats || {},
          total: data.total || 0,
          hasMore: data.hasMore || false,
          page: data.page || 1,
          loading: false,
          loadFailed: false,
          collectionNotExists: !!data.collectionNotExists
        });
        return true;
      }
      throw new Error(res.result?.error || '查询失败');
    } catch (err) {
      if (seq !== this._logsSeq) return false;
      Logger.error('operation-logs', '加载失败', err);
      this.safeSetData({ loading: false, loadFailed: true });
      ErrorHandler.handle(err);
      return false;
    }
  },

  loadMore() {
    // 必须用实例锁：loadLogs(reset=false) 不会把 data.loading 置 true，
    // 原守卫 `if (this.data.loading) return` 形同虚设 —— 连点两次会并发请求同一page，
    // 两份结果各自 append 一次 → 列表出现重复日志行（wx:key="_id" 同时重复）。
    if (this._loadingMore || !this.data.hasMore || this.data.loading) return;
    this._loadingMore = true;
    const prevPage = this.data.page;
    this.setData({ page: prevPage + 1 });
    this.loadLogs(false).then(ok => {
      // 失败时回滚页码：否则下一次「加载更多」会跳过整页（page 已加一但本页没取到）。
      // 期间若发生筛选重置（page 已被置回 1，由新请求接管），则不再回滚。
      if (!ok && this.data.page === prevPage + 1) {
        this.setData({ page: prevPage });
      }
    }).finally(() => {
      this._loadingMore = false;
    });
  },

  onToggleFilter() {
    this.setData({ showFilterPanel: !this.data.showFilterPanel });
  },

  onAccountInput(e) {
    this.setData({ 'filters.adminAccount': e.detail.value });
  },

  onKeywordInput(e) {
    this.setData({ 'filters.keyword': e.detail.value });
  },

  onClearKeyword() {
    this.setData({ 'filters.keyword': '' });
  },

  onModuleChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({
      moduleIndex: idx,
      'filters.module': MODULES[idx] ? MODULES[idx].value : ''
    });
  },

  onActionChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({
      actionIndex: idx,
      'filters.action': ACTIONS[idx] ? ACTIONS[idx].value : ''
    });
  },

  onResultChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({
      resultIndex: idx,
      'filters.result': RESULTS[idx] ? RESULTS[idx].value : ''
    });
  },

  onDateChange(e) {
    // 日期来自 <picker mode="date" data-type="startTime|endTime">：
    // 目标字段由 data-type 决定（同一处理函数服务两个 picker）
    const type = e.currentTarget.dataset.type;
    const value = e.detail.value;
    if (!type || !value) return;
    this.setData({
      [`filters.${type}`]: value
    });
  },

  onSearch() {
    const { filters } = this.data;
    // 起止倒置必须在前端拦：服务端 index.js:72-73 会拼出
    // _.and(_.gte(晚), _.lte(早))，命中空集后仍返回 success + 空列表，
    // 管理员看到的只是「暂无操作日志」，完全看不出是日期区间写反了
    if (filters.startTime && filters.endTime && filters.startTime > filters.endTime) {
      wx.showToast({ title: '起始日期不能晚于结束日期', icon: 'none' });
      this.setData({ showFilterPanel: true });
      return;
    }
    const hasFilter = !!(filters.adminAccount || filters.module || filters.action ||
      filters.result || filters.startTime || filters.endTime || filters.keyword);
    this.setData({ showFilterPanel: false, hasActiveFilter: hasFilter });
    this.loadLogs(true);
  },

  onClearFilters() {
    this.setData({
      filters: {
        adminAccount: '', module: '', action: '', result: '',
        startTime: '', endTime: '', keyword: ''
      },
      moduleIndex: 0,
      actionIndex: 0,
      resultIndex: 0,
      hasActiveFilter: false
    });
    this.loadLogs(true);
  },

  onToggleDetail(e) {
    const id = e.currentTarget.dataset.id;
    const { logs } = this.data;
    const updated = logs.map(l => ({
      ...l,
      _expanded: l._id === id ? !l._expanded : false
    }));
    this.setData({ logs: updated });
  },

  onPullDownRefresh() {
    this.loadLogs(true).finally(() => wx.stopPullDownRefresh());
  },

  /** 加载失败空态里的重试入口 */
  onRetryLoad() {
    this._loadingMore = false;
    this.loadLogs(true);
  }
});
