/**
 * 公告管理页面
 */
const { requireAdminAuth } = require('../../../utils/adminAuth');

const ErrorHandler = require('../../../utils/errorHandler');

const { Logger } = require('../../../utils/logger');

const { formatDateShort } = require('../../../utils/dateFormat');

const backToTopBehavior = require('../../../behaviors/backToTopBehavior');
const adminBehavior = require('../behaviors/adminBehavior');

// 公告字段上限，与服务端 manageNotice/index.js:13-14 的 FIELD_LIMITS 逐字对齐。
//
// 注意：**不能**用 config.security.maxNameLength / maxDescriptionLength ——
// 那两个是「猫咪档案」字段的上限（50/500），与公告无关：正文注进去会把公告
// 从 2000 字压到 500 字，属功能回退；标题也会被误绑到猫名口径。
const NOTICE_TITLE_MAX_LENGTH = 100;
const NOTICE_CONTENT_MAX_LENGTH = 5000;
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');


Page({

  onUnload() {
    // 卸载后拦截异步 setData（safeSetDataBehavior 的 Page 显式标记，见该文件头说明）
    this._isUnmounted = true;
    // 清理延迟返回定时器（门禁失败自动返回用）
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },
  behaviors: [backToTopBehavior, adminBehavior, safeSetDataBehavior],
  data: {
    statusBarHeight: 0,
    notices: [],
    loading: true,
    // 加载失败必须是独立状态：否则 catch 后列表保持空数组，
    // wxml 会把「加载失败」渲染成「暂无公告」，管理员误以为没有公告
    loadFailed: false,
    // 供 wxml maxlength 绑定，与 onSubmit 的校验、服务端 FIELD_LIMITS 三处同源
    titleMaxLength: NOTICE_TITLE_MAX_LENGTH,
    contentMaxLength: NOTICE_CONTENT_MAX_LENGTH,
    modalShow: false,
    isEdit: false,
    // 提交锁放 data（非实例字段）：wxml:94 的按钮要绑禁用态与「提交中…」文案
    submitting: false,
    form: {
      _id: '',
      title: '',
      content: ''
    },
    formErrors: { title: '', content: '' },
    skeletonItems: [1, 2, 3]
  },

  async onLoad() {
    this._backToTopThreshold = 400;
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!this.guardPermission('notice', '公告管理')) {
      this.safeSetData({ loading: false });
      return;
    }
    // 入口已由 guardPermission('notice') 把关：能进本页即具备「公告管理」权限，
    // 页内删除不再按角色隐藏（普通管理员被开通入口后同样可以删）。
    this.safeSetData({
      statusBarHeight: wx.getWindowInfo().statusBarHeight || 0
    });
    this.loadNotices();
  },


  onShow() {
    // onLoad 已触发首载，首次 onShow 直接跳过，避免双请求
    if (!this._firstShowSkipped) {
      this._firstShowSkipped = true;
      return;
    }
    if (this._cachedNotices && Date.now() - this._cacheTime < 20000) {
      this.setData({ notices: this._cachedNotices, loading: false });
      return;
    }
    this.loadNotices();
  },

  onPullDownRefresh() {
    this._cachedNotices = null;
    this.loadNotices().finally(() => wx.stopPullDownRefresh());
  },

  async loadNotices() {
    this.setData({ loading: true });
    try {
      const res = await this.callAdminFunction('manageNotice', { action: 'list' });

      if (!res.result?.success) {
        // 业务失败不能静默：空数组会被缓存并渲染成「暂无公告」，管理员误以为没有公告
        throw new Error(res.result?.error || '加载失败');
      }

      const notices = (res.result?.data?.notices || []).map(n => ({
        ...n,
        createTimeStr: formatDateShort(n.createTime)
      }));
      this.safeSetData({ notices, loadFailed: false });
      this._cachedNotices = notices;
      this._cacheTime = Date.now();
    } catch (err) {
      Logger.warn('notice-manage', '加载公告列表失败', { error: err.message });
      // 置失败态：区分「加载失败」与「真的没有公告」
      this.safeSetData({ loadFailed: true });
      ErrorHandler.handle(err, { title: '加载失败' });
    }
    this.safeSetData({ loading: false });
  },

  /** 加载失败后的重试入口 */
  onRetryLoad() {
    this._cachedNotices = null;
    this.loadNotices();
  },

  onAdd() {
    this.setData({
      modalShow: true,
      isEdit: false,
      form: { _id: '', title: '', content: '' },
      formErrors: { title: '', content: '' }
    });
  },

  onEdit(e) {
    const notice = e.currentTarget.dataset.notice;
    this.setData({
      modalShow: true,
      isEdit: true,
      form: { _id: notice._id, title: notice.title, content: notice.content },
      formErrors: { title: '', content: '' }
    });
  },

  onDelete(e) {
    if (this._deleting) return;
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条公告吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._deleting) return;
        this._deleting = true;

        const isAdmin = await this.verifyAdmin();
        if (!isAdmin) {
          this._deleting = false;
          wx.showToast({ title: '权限不足', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '删除中…' });
        try {
          const callRes = await this.callAdminFunction('manageNotice', { action: 'delete', noticeId: id });
          wx.hideLoading();
          if (callRes.result?.success) {
            ErrorHandler.showSuccess('已删除');
            const notices = this.data.notices.filter(n => n._id !== id);
            this.safeSetData({ notices });
            this._cachedNotices = notices;
          } else {
            ErrorHandler.handle(new Error(callRes.result?.error || '删除失败'), { title: '删除失败' });
          }
        } catch (err) {
          wx.hideLoading();
          Logger.warn('notice-manage', '删除公告失败', { error: err.message });
          ErrorHandler.handle(err, { title: '删除失败' });
        } finally {
          this._deleting = false;
        }
      }
    });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value, 'formErrors.title': '' });
  },

  onContentInput(e) {
    this.setData({ 'form.content': e.detail.value, 'formErrors.content': '' });
  },

  async onSubmit() {
    // 同步守卫：置位必须早于 verifyAdmin 的 await（200~800ms 真实云往返），
    // 否则双击必然穿透
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    // 锁的释放统一由 finally 收口。原实现三条早退路径各写一遍
    // `submitting = false`、末尾 finally 再写一次 —— 同一状态多点手工复位，
    // 任何人新增一条早退 return 而漏写就永久锁死提交按钮。
    // 放在 data 而非实例字段：wxml:94 的按钮要绑 disabled 类与「提交中…」文案，
    // 实例字段在视图层取不到（同 relation-manage.wxml:118-119 口径）。
    try {
      const isAdmin = await this.verifyAdmin();
      if (!isAdmin) {
        wx.showToast({ title: '权限不足', icon: 'none' });
        return;
      }

      const { title, content, _id } = this.data.form;
      // 判空与入库都用 trim 后的值：原实现只对判空 trim，实际提交的是原始
      // 输入（`"  重要通知  "` 会连空格入库），且长度校验也按原始字符算
      const cleanTitle = (title || '').trim();
      const cleanContent = (content || '').trim();

      const errors = { title: '', content: '' };
      if (!cleanTitle) {
        errors.title = '标题不能为空';
      } else if (cleanTitle.length > NOTICE_TITLE_MAX_LENGTH) {
        errors.title = `标题不能超过${NOTICE_TITLE_MAX_LENGTH}个字`;
      }
      if (!cleanContent) {
        errors.content = '内容不能为空';
      } else if (cleanContent.length > NOTICE_CONTENT_MAX_LENGTH) {
        errors.content = `内容不能超过${NOTICE_CONTENT_MAX_LENGTH}个字`;
      }
      if (errors.title || errors.content) {
        this.safeSetData({ formErrors: errors });
        wx.showToast({ title: errors.title || errors.content, icon: 'none' });
        return;
      }

      wx.showLoading({ title: '提交中…' });
      const action = this.data.isEdit ? 'update' : 'add';
      const data = { action, title: cleanTitle, content: cleanContent };
      if (this.data.isEdit) data.noticeId = _id;

      const res = await this.callAdminFunction('manageNotice', data);

      wx.hideLoading();

      if (res.result?.success) {
        ErrorHandler.showSuccess(this.data.isEdit ? '已更新' : '已添加');
        this.safeSetData({ modalShow: false });
        this._cachedNotices = null;
        this.loadNotices();
      } else {
        ErrorHandler.handle(new Error(res.result?.error || '操作失败'), { title: '操作失败' });
      }
    } catch (err) {
      wx.hideLoading();
      Logger.warn('notice-manage', '提交公告失败', { error: err.message });
      ErrorHandler.handle(err, { title: '提交失败' });
    } finally {
      this.safeSetData({ submitting: false });
    }
  },

  onModalClose() {
    this.setData({ modalShow: false });
  },

  stopPropagation() {},

});
