// pages/admin/manage-admins/manage-admins.js - 管理端：管理员账号管理页
const { Logger } = require('../../../utils/logger');
const ErrorHandler = require('../../../utils/errorHandler');
const adminBehavior = require('../behaviors/adminBehavior');
const safeSetDataBehavior = require('../../../behaviors/safeSetDataBehavior');
const { requireAdminAuth, isSuperAdminLevel } = require('../../../utils/adminAuth');
const {
  PERMISSION_KEYS,
  DEFAULT_PERMISSION_KEYS,
  buildPermissionGroups,
  getPermissionLabel
} = require('../../../utils/adminPermissions');
const { formatDateTime } = require('../../../utils/dateFormat');

const ACCOUNT_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_MIN_LENGTH = 6;
const DISPLAY_NAME_MAX_LENGTH = 20;

function calcPasswordStrength(pwd) {
  if (!pwd || pwd.length < PASSWORD_MIN_LENGTH) return 'weak';
  if (pwd.length >= 10 && /[a-zA-Z]/.test(pwd) && /[0-9]/.test(pwd)) return 'strong';
  return 'medium';
}

Page({
  behaviors: [adminBehavior, safeSetDataBehavior],
  data: {
    loading: true,
    // 加载失败必须是独立状态：否则列表保持空数组，wxml 会把
    // 「加载失败」渲染成「暂无管理员」，管理员误以为列表为空
    loadFailed: false,
    isSuperAdmin: false,
    // 创始人（三档顶级：超管之上，唯一能提升/降级其他超管）；
    // 由云函数按 SUPER_ACCOUNT 判定后下发，客户端只用于 UI。
    isFounder: false,
    // 是否启用了创始人层级（SUPER_ACCOUNT 已配置）。未启用时退回超管对等，
    // 界面不显示“创始人”字样，避免所有超管都自称创始人。
    founderEnforced: false,
    // 超管及以上：可增删改普通管理员账号。
    // 注意与 isSuperAdmin 区分：调整权限只对超管及以上开放，改角色仅创始人。
    canManageAdmins: false,
    admins: [],
    skeletonItems: [1, 2, 3],

    // 权限弹窗：13 个入口开关（仅超管可打开；管理员管理不在其中）
    showPermModal: false,
    permTargetId: '',
    permTargetName: '',
    permDraft: {},
    permOriginal: {},
    permGroups: [],
    permAllOn: false,
    permSaving: false,
    // 13 个可授权入口；「管理员管理」不在其中
    permissionTotal: PERMISSION_KEYS.length,

    showAddModal: false,
    addForm: { account: '', displayName: '', password: '' },
    addErrors: { account: '', displayName: '', password: '' },
    addSubmitting: false,
    showAddPassword: false,
    passwordStrength: 'weak',

    showEditModal: false,
    editTargetId: '',
    editTargetAccount: '',
    // 目标账号的当前角色/是否本人/是否创始人：角色变更按钮与「保存后影响」提示都依赖它们。
    // 本人与创始人账号不允许改角色（服务端同样拦截），角色区对二者隐藏。
    editTargetRole: 'admin',
    editTargetIsSelf: false,
    editTargetIsFounder: false,
    // role 是编辑弹窗里的角色草稿：初始取列表下发的真实角色，超管可提升/降级；
    // 保存时才真正提交，取消编辑不会生效。
    editForm: { displayName: '', password: '', role: 'admin' },
    editErrors: { displayName: '', password: '' },
    editSubmitting: false,
    showEditPassword: false,

    showRemoveModal: false,
    removeTargetId: '',
    removeTargetName: '',
    removeSubmitting: false
  },

  async onLoad() {
    const hasAuth = await requireAdminAuth();
    if (!hasAuth) {
      // 门禁失败不能只 return：loading 初值为 true → 骨架屏常驻（同 admin.js 口径）
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    if (!isSuperAdminLevel()) {
      // 「管理员管理」永远仅超管及以上可用，不参与入口权限授权
      wx.showToast({ title: '仅超级管理员可访问', icon: 'none' });
      this._navBackTimer = setTimeout(() => this.goBack(), 1500);
      this.safeSetData({ loading: false });
      return;
    }
    this.loadAdmins();
  },

  onUnload() {
    this._isUnmounted = true;
    // 清理延迟返回定时器：用户提前手动返回时避免回调再 pop 一页
    if (this._navBackTimer) { clearTimeout(this._navBackTimer); this._navBackTimer = null; }
  },

  async loadAdmins() {
    this.setData({ loading: true });
    try {
      // 身份来自本地角色 + 入口权限缓存，不再依赖第二次云调用：
      // 云端一失败就降级会让已过门禁的合法管理员被误判。
      const isSuperAdmin = isSuperAdminLevel();
      const canManageAdmins = isSuperAdmin;

      const listRes = await this.callAdminFunction('manageAdmin', { action: 'list' })
        .catch(err => {
          Logger.warn('manage-admins', '加载管理员列表失败', { error: err.message });
          return null;
        });

      const listData = listRes?.result;

      if (!listData || !listData.success) {
        const errMsg = listData?.error || '加载管理员列表失败';
        wx.showToast({ title: errMsg, icon: 'none' });
        this.safeSetData({ loading: false, loadFailed: true });
        return;
      }
      const admins = (listData.data.admins || []).map(a => {
        // 云端已按「生效权限」下发：超管/创始人=全部 13 项，历史文档=默认 3 项。
        // 客户端再做一次兜底，避免旧版云函数没返回 permissions 时列表空白。
        const permissions = Array.isArray(a.permissions)
          ? a.permissions
          : a.role === 'superadmin' || a.role === 'founder' ? PERMISSION_KEYS : DEFAULT_PERMISSION_KEYS;
        return {
          ...a,
          permissions,
          permissionCount: permissions.length,
          // 普通管理员的入口权限用量条（超管/创始人显示「全部开放」徽章，不用条）
          permissionPercent: Math.round(permissions.length / PERMISSION_KEYS.length * 100),
          firstChar: (a.displayName || a.account || '?').charAt(0),
          // 兼容旧版云函数的 isOwner 字段（部署灰度期）
          isFounder: !!(a.isFounder || a.isOwner),
          // 格式化登录时间：原先直接渲染 ISO 串（2026-10-06T15:03:09.711Z），
          // 既非本地时间又长到折行断字
          lastLoginText: a.lastLoginTime ? formatDateTime(a.lastLoginTime) : ''
        };
      });
      // 旧版云函数不返回 callerIsFounder 时按 false 处理：宁可少给按钮，
      // 也不能让非创始者在界面上看到自己实际调不通的升降级入口。
      const isFounder = !!(listData.data.callerIsFounder || listData.data.callerIsOwner);
      const founderEnforced = !!(listData.data.founderEnforced || listData.data.ownerEnforced);

      this.safeSetData({
        admins, isSuperAdmin, isFounder, founderEnforced, canManageAdmins, loading: false, loadFailed: false
      });

      if (!canManageAdmins) {
        wx.showToast({ title: '仅超级管理员可管理', icon: 'none' });
      }
    } catch (err) {
      Logger.error('manage-admins', '加载失败', err);
      this.safeSetData({ loading: false, loadFailed: true });
      ErrorHandler.handle(err);
    }
  },

  /** 加载失败后的重试入口 */
  onRetryLoad() {
    this.loadAdmins();
  },

  onShowAddAdmin() {
    wx.vibrateShort({ type: 'light' });
    this.setData({
      showAddModal: true,
      addForm: { account: '', displayName: '', password: '' },
      addErrors: { account: '', displayName: '', password: '' },
      addSubmitting: false,
      showAddPassword: false,
      passwordStrength: 'weak'
    });
  },

  onAddFormInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({ [`addForm.${field}`]: value });
    if (field === 'password') {
      this.setData({ passwordStrength: calcPasswordStrength(value) });
    }
    this._validateAddField(field, value);
  },

  _validateAddField(field, value) {
    let error = '';
    switch (field) {
      case 'account':
        if (!value) {
          error = '请输入登录账号';
        } else if (value.length < 3) {
          error = '账号至少3个字符';
        } else if (value.length > 20) {
          error = '账号最多20个字符';
        } else if (!ACCOUNT_REGEX.test(value)) {
          error = '仅支持英文、数字和下划线';
        }
        break;
      case 'displayName':
        if (value && value.length > DISPLAY_NAME_MAX_LENGTH) {
          error = `最多${DISPLAY_NAME_MAX_LENGTH}个字符`;
        }
        break;
      case 'password':
        if (!value) {
          error = '请输入密码';
        } else if (value.length < PASSWORD_MIN_LENGTH) {
          error = `密码至少${PASSWORD_MIN_LENGTH}位`;
        } else if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
          // 这条是**硬拦截**（return !error 直接被 _validateAddForm 当门禁用），
          // 文案却写「建议」，会让管理员以为是可选项并反复重试。
          // 校验本身保留（与云端口令强度要求一致），只把文案改成与行为一致。
          error = '密码必须包含字母和数字';
        }
        break;
    }
    this.setData({ [`addErrors.${field}`]: error });
    return !error;
  },

  _validateAddForm() {
    const { account, password, displayName } = this.data.addForm;
    const v1 = this._validateAddField('account', account);
    const v2 = this._validateAddField('password', password);
    const v3 = this._validateAddField('displayName', displayName);
    return v1 && v2 && v3;
  },

  onToggleAddPassword() {
    this.setData({ showAddPassword: !this.data.showAddPassword });
  },

  async onAddAdminConfirm() {
    // 守卫与置位必须在**任何 await 之前**同步完成。
    // 原实现是「检查 addSubmitting → await verifyAdmin()（200~800ms 真实云往返）→ 才置位」，
    // 这个窗口里按钮仍可点，双击会让两个 add 请求都发出去。
    // donation-manage.js 已有同口径注释，这里按同一模式补齐。
    if (this._addLock) return;
    this._addLock = true;

    try {
      if (this.data.addSubmitting) return;

      const isAdmin = await this.verifyAdmin();
      if (!isAdmin) {
        wx.showToast({ title: '权限不足', icon: 'none' });
        return;
      }

      if (!this._validateAddForm()) {
        wx.vibrateShort({ type: 'medium' });
        return;
      }

      this.safeSetData({ addSubmitting: true });
      wx.showLoading({ title: '添加中…', mask: true });

      const { account, password, displayName } = this.data.addForm;
      const res = await this.callAdminFunction('manageAdmin', {
        action: 'add',
        account: account.trim(),
        displayName: (displayName || account).trim(),
        password
      });

      wx.hideLoading();

      if (res.result?.success) {
        wx.vibrateShort({ type: 'light' });
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.safeSetData({ showAddModal: false });
        this.loadAdmins();
      } else {
        wx.vibrateShort({ type: 'medium' });
        const errorMsg = res.result?.error || '添加失败';
        if (errorMsg.includes('已存在')) {
          this.safeSetData({ 'addErrors.account': errorMsg });
        } else {
          wx.showToast({ title: errorMsg, icon: 'none' });
        }
      }
    } catch (err) {
      wx.hideLoading();
      ErrorHandler.handle(err);
    } finally {
      this._addLock = false;
      this.safeSetData({ addSubmitting: false });
    }
  },

  onAddModalCancel() {
    if (this.data.addSubmitting) return;
    this.setData({ showAddModal: false });
  },

  onEditAdmin(e) {
    wx.vibrateShort({ type: 'light' });
    const { id, name, account, role } = e.currentTarget.dataset;
    const target = this.data.admins.find(a => a._id === id);
    const targetRole = role || target?.role || 'admin';
    this.setData({
      showEditModal: true,
      editTargetId: id,
      editTargetAccount: account || '',
      editTargetRole: targetRole,
      editTargetIsSelf: !!(target && target.isSelf),
      editTargetIsFounder: !!(target && (target.isFounder || target.isOwner)),
      editForm: { displayName: name || '', password: '', role: targetRole },
      editErrors: { displayName: '', password: '' },
      editSubmitting: false,
      showEditPassword: false
    });
  },

  /**
   * 草稿内标记角色变更：提升 / 降级都只改本地草稿，
   * 真正的云调用在保存时进行，用户中途取消编辑不会生效。
   */
  onPromoteToSuperAdmin() {
    if (!this.data.isFounder) return;
    if (this.data.editTargetIsSelf || this.data.editTargetIsFounder) return;
    if (this.data.editForm.role === 'superadmin') return;
    wx.vibrateShort({ type: 'medium' });
    this.setData({ 'editForm.role': 'superadmin' });
  },

  onDemoteToAdmin() {
    if (!this.data.isFounder) return;
    if (this.data.editTargetIsSelf || this.data.editTargetIsFounder) return;
    if (this.data.editForm.role === 'admin') return;
    wx.vibrateShort({ type: 'medium' });
    this.setData({ 'editForm.role': 'admin' });
  },

  /** 撤销尚未保存的角色变更 */
  onResetRoleDraft() {
    if (!this.data.isFounder) return;
    if (this.data.editTargetIsSelf || this.data.editTargetIsFounder) return;
    this.setData({ 'editForm.role': this.data.editTargetRole });
  },

  /**
   * 角色变更前的二次确认（危险操作）。
   * 提升后对方可管理所有管理员；降级会让对方立即失去超管全部权限。
   * @returns {Promise<boolean>}
   */
  _confirmRoleChange(targetAdmin, toRole) {
    const target = targetAdmin || {};
    const name = target.displayName || target.account || '该管理员';
    const isPromote = toRole === 'superadmin';
    const configure = isPromote
      ? {
        title: '提升为超级管理员',
        content: `「${name}」将获得全部权限，可添加/移除管理员、重置密码、调整入口权限。如需收回，可再降级为普通管理员。确定提升？`,
        confirmText: '确认提升'
      }
      : {
        title: '降级为普通管理员',
        content: `「${name}」将立即失去超级管理员全部权限，按普通管理员入口权限使用管理端。确定降级？`,
        confirmText: '确认降级'
      };
    return new Promise((resolve) => {
      wx.showModal({
        title: configure.title,
        content: configure.content,
        confirmText: configure.confirmText,
        confirmColor: isPromote ? '#C0392B' : '#E8927C',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
  },

  onEditFormInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({ [`editForm.${field}`]: value });
    this._validateEditField(field, value);
  },

  _validateEditField(field, value) {
    let error = '';
    switch (field) {
      case 'displayName':
        if (!value || !value.trim()) {
          error = '显示名称不能为空';
        } else if (value.trim().length > DISPLAY_NAME_MAX_LENGTH) {
          error = `最多${DISPLAY_NAME_MAX_LENGTH}个字符`;
        }
        break;
      case 'password':
        if (value && value.length < PASSWORD_MIN_LENGTH) {
          error = `密码至少${PASSWORD_MIN_LENGTH}位`;
        }
        break;
    }
    this.setData({ [`editErrors.${field}`]: error });
    return !error;
  },

  _validateEditForm() {
    const { displayName, password } = this.data.editForm;
    const v1 = this._validateEditField('displayName', displayName);
    const v2 = this._validateEditField('password', password);
    return v1 && v2;
  },

  /**
   * 计算本次编辑的实际变更。
   * 角色变更只有创始人可提交，且不能作用于本人或创始人账号（服务端同口径）。
   * @returns {{targetAdmin: object|undefined, roleChanged: boolean, hasChange: boolean}}
   */
  _resolveEditChange() {
    const { editTargetId, editForm } = this.data;
    const targetAdmin = this.data.admins.find(a => a._id === editTargetId);
    const targetRole = targetAdmin?.role || 'admin';
    const roleChanged = this.data.isFounder
      && !this.data.editTargetIsSelf
      && !this.data.editTargetIsFounder
      && editForm.role !== targetRole;
    const hasChange = !!editForm.password
      || editForm.displayName !== targetAdmin?.displayName
      || roleChanged;
    return { targetAdmin, roleChanged, hasChange };
  },

  onToggleEditPassword() {
    this.setData({ showEditPassword: !this.data.showEditPassword });
  },

  async onEditConfirm() {
    // 同 onAddAdminConfirm：锁必须在 await verifyAdmin() 之前同步置位
    if (this._editLock) return;
    this._editLock = true;

    try {
      if (this.data.editSubmitting) return;

      const isAdmin = await this.verifyAdmin();
      if (!isAdmin) {
        wx.showToast({ title: '权限不足', icon: 'none' });
        return;
      }

      if (!this._validateEditForm()) {
        wx.vibrateShort({ type: 'medium' });
        return;
      }

      const { editTargetId, editForm } = this.data;
      const { targetAdmin, roleChanged, hasChange } = this._resolveEditChange();
      if (!hasChange) {
        wx.showToast({ title: '没有修改内容', icon: 'none' });
        return;
      }

      // 角色变更确认必须发生在提交更新之前：取消时保持弹窗原样，不落库。
      if (roleChanged) {
        const confirmed = await this._confirmRoleChange(targetAdmin, editForm.role);
        if (!confirmed) return;
      }

      this.safeSetData({ editSubmitting: true });
      wx.showLoading({ title: '保存中…', mask: true });

      const data = { action: 'update', targetId: editTargetId, displayName: editForm.displayName.trim() };
      // 密码重置仅超管：被授权的普通管理员只能改显示名。
      // 前端不发送密码，服务端仍会二次拒绝，防止绕过 UI 直接调用。
      if (this.data.isSuperAdmin && editForm.password) data.password = editForm.password;
      if (roleChanged) data.role = editForm.role;

      const res = await this.callAdminFunction('manageAdmin', data);
      wx.hideLoading();

      if (res.result?.success) {
        wx.vibrateShort({ type: 'light' });
        wx.showToast({ title: '保存成功', icon: 'success' });
        this.safeSetData({ showEditModal: false });
        this.loadAdmins();
      } else {
        wx.vibrateShort({ type: 'medium' });
        wx.showToast({ title: res.result?.error || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      ErrorHandler.handle(err);
    } finally {
      this._editLock = false;
      this.safeSetData({ editSubmitting: false });
    }
  },

  onEditCancel() {
    if (this.data.editSubmitting) return;
    this.setData({ showEditModal: false });
  },

  // ========== 入口权限（仅超级管理员） ==========

  /**
   * 打开权限弹窗：初始值取列表下发的生效权限。
   * 历史管理员文档没有 permissions 字段时，云端已按默认 3 项返回。
   */
  onEditPermissions(e) {
    if (!this.data.isSuperAdmin) return;
    const { id, name } = e.currentTarget.dataset;
    const admin = this.data.admins.find(a => a._id === id);
    if (!admin) return;

    wx.vibrateShort({ type: 'light' });

    const draft = {};
    for (const key of PERMISSION_KEYS) {
      draft[key] = (admin.permissions || []).includes(key);
    }

    this.setData({
      showPermModal: true,
      permTargetId: id,
      permTargetName: name || admin.account || '',
      permDraft: draft,
      permOriginal: { ...draft },
      permSaving: false
    });
    this._refreshPermGroups(draft);
  },

  onPermSwitchChange(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    const draft = { ...this.data.permDraft, [key]: !!e.detail.value };
    this.setData({ permDraft: draft });
    this._refreshPermGroups(draft);
  },

  onToggleAllPermissions() {
    const allOn = PERMISSION_KEYS.every(key => !!this.data.permDraft[key]);
    const draft = {};
    for (const key of PERMISSION_KEYS) draft[key] = !allOn;
    this.setData({ permDraft: draft });
    this._refreshPermGroups(draft);
  },

  _refreshPermGroups(draft) {
    const source = draft || this.data.permDraft;
    this.safeSetData({
      permGroups: buildPermissionGroups(source),
      permAllOn: PERMISSION_KEYS.every(key => !!source[key])
    });
  },

  /**
   * 保存前确认：
   * - 一项都不开 → 该管理员登录后没有功能入口
   * - 新开 logs / catActivity → 属于高风险授权，必须二次确认
   */
  _buildPermConfirm(draft) {
    const selected = PERMISSION_KEYS.filter(key => !!draft[key]);
    if (selected.length === 0) {
      return {
        title: '关闭全部入口',
        content: '保存后该管理员登录将看不到任何功能入口，只能查看统计和退出登录。确定保存？'
      };
    }

    const sensitive = ['logs', 'catActivity']
      .filter(key => draft[key] && !this.data.permOriginal[key]);
    if (sensitive.length > 0) {
      return {
        title: '开启高风险权限',
        content: `将开启：${sensitive.map(getPermissionLabel).join('、')}。操作日志可查看全量审计数据，猫咪行动分析可查看全校猫咪活动轨迹。确定保存？`
      };
    }
    return null;
  },

  onSavePermissions() {
    if (this._permLock) return;
    // 锁必须在任何 await 之前同步置位：否则确认弹窗/云往返期间按钮仍可点，
    // 会重复提交同一份权限（同 add/edit/remove 的既有口径）。
    this._permLock = true;

    const confirm = this._buildPermConfirm(this.data.permDraft);
    if (!confirm) {
      this._submitPermissions().finally(() => { this._permLock = false; });
      return;
    }

    wx.showModal({
      title: confirm.title,
      content: confirm.content,
      confirmColor: '#E8927C',
      success: (res) => {
        if (!res.confirm) {
          this._permLock = false;
          return;
        }
        this._submitPermissions().finally(() => { this._permLock = false; });
      },
      fail: () => { this._permLock = false; }
    });
  },

  async _submitPermissions() {
    if (this.data.permSaving) return;

    const isAdmin = await this.verifyAdmin();
    if (!isAdmin) {
      wx.showToast({ title: '权限不足', icon: 'none' });
      return;
    }

    const permissions = PERMISSION_KEYS.filter(key => !!this.data.permDraft[key]);
    this.safeSetData({ permSaving: true });
    wx.showLoading({ title: '保存中…', mask: true });

    try {
      const res = await this.callAdminFunction('manageAdmin', {
        action: 'updatePermissions',
        targetId: this.data.permTargetId,
        permissions
      });
      wx.hideLoading();

      if (res.result?.success) {
        wx.vibrateShort({ type: 'light' });
        wx.showToast({ title: '权限已保存', icon: 'success' });
        this.safeSetData({ showPermModal: false });
        this.loadAdmins();
      } else {
        wx.vibrateShort({ type: 'medium' });
        wx.showToast({ title: res.result?.error || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      ErrorHandler.handle(err);
    } finally {
      this.safeSetData({ permSaving: false });
    }
  },

  onPermModalCancel() {
    if (this.data.permSaving) return;
    this.setData({ showPermModal: false });
  },

  onRemoveAdmin(e) {
    wx.vibrateShort({ type: 'medium' });
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      showRemoveModal: true,
      removeTargetId: id,
      removeTargetName: name,
      removeSubmitting: false
    });
  },

  /**
   * 解绑微信（仅超管，服务端二次校验）
   *
   * 服务端鉴权只认 admins.openid；绑定在首次登录时写入且永不自动换绑。
   * 对手换手机/换了微信后原绑定失效，没有解绑入口时账号永久不可用。
   * 解绑后该账号在目标微信登录一次即可重新绑定。
   */
  onUnbindAdmin(e) {
    if (this._unbindLock) return;
    wx.vibrateShort({ type: 'medium' });
    const { id, name } = e.currentTarget.dataset;

    wx.showModal({
      title: '解绑微信',
      content: `解绑「${name}」当前绑定的微信？解绑后需用新微信登录该账号一次，才能继续管理操作。`,
      confirmText: '解绑',
      confirmColor: '#E8927C',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._unbindLock) return;
        this._unbindLock = true;

        try {
          const isAdmin = await this.verifyAdmin();
          if (!isAdmin) {
            wx.showToast({ title: '权限不足', icon: 'none' });
            return;
          }

          wx.showLoading({ title: '解绑中…', mask: true });
          const resp = await this.callAdminFunction('manageAdmin', { action: 'unbind', targetId: id });
          wx.hideLoading();

          if (resp.result?.success) {
            wx.vibrateShort({ type: 'light' });
            wx.showToast({ title: '已解绑', icon: 'success' });
            this.loadAdmins();
          } else {
            wx.vibrateShort({ type: 'medium' });
            wx.showToast({ title: resp.result?.error || '解绑失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          Logger.warn('manage-admins', '解绑微信失败', { error: err.message });
          ErrorHandler.handle(err);
        } finally {
          this._unbindLock = false;
        }
      }
    });
  },

  async onRemoveConfirm() {
    // 同上：锁前置。移除是不可逆操作，连点两次会发两次 remove 请求。
    if (this._removeLock) return;
    this._removeLock = true;

    try {
      if (this.data.removeSubmitting) return;

      const isAdmin = await this.verifyAdmin();
      if (!isAdmin) {
        wx.showToast({ title: '权限不足', icon: 'none' });
        return;
      }

      this.safeSetData({ removeSubmitting: true });
      wx.showLoading({ title: '移除中…', mask: true });

      const res = await this.callAdminFunction('manageAdmin', { action: 'remove', targetId: this.data.removeTargetId });
      wx.hideLoading();

      if (res.result?.success) {
        wx.vibrateShort({ type: 'light' });
        wx.showToast({ title: '已移除', icon: 'success' });
        this.safeSetData({ showRemoveModal: false });
        this.loadAdmins();
      } else {
        wx.vibrateShort({ type: 'medium' });
        wx.showToast({ title: res.result?.error || '移除失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      ErrorHandler.handle(err);
    } finally {
      this._removeLock = false;
      this.safeSetData({ removeSubmitting: false });
    }
  },

  onRemoveCancel() {
    if (this.data.removeSubmitting) return;
    this.setData({ showRemoveModal: false });
  },

  onCopyAccount(e) {
    const account = e.currentTarget.dataset.account;
    if (!account) return;
    wx.setClipboardData({
      data: account,
      success: () => {
        wx.showToast({ title: '账号已复制', icon: 'success' });
      }
    });
  },

  onPullDownRefresh() {
    this.loadAdmins().finally(() => wx.stopPullDownRefresh());
  }
});
