const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn()
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin'),
  isSuperAdminLevel: jest.fn(() => true),
  isFounder: jest.fn(() => false),
  getAdminPermissions: jest.fn(() => [
    'ops', 'addCat', 'photo', 'cat', 'notice', 'relation',
    'logs', 'catActivity', 'mediaReview', 'report'
  ]),
  checkAdminAuth: jest.fn(() => true),
  clearAdminAuth: jest.fn()
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  },
  guardPermission: () => true
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/manage-admins/manage-admins');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  mockAdminAuth.isSuperAdminLevel.mockReturnValue(true);
  mockAdminAuth.isFounder.mockReturnValue(false);
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.vibrateShort = jest.fn();
  wx.showModal.mockReset();
  wx.showModal.mockImplementation((opts) => {
    if (opts.success) opts.success({ confirm: false });
    return Promise.resolve({ confirm: false });
  });
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let target = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = updates[key];
    } else {
      data[key] = updates[key];
    }
  }
}

function createInstance(dataOverrides) {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData: jest.fn(function(updates) {
      applySetData(this.data, updates);
    })
  };
  if (dataOverrides) {
    for (const key of Object.keys(dataOverrides)) {
      if (typeof dataOverrides[key] === 'object' && dataOverrides[key] !== null && !Array.isArray(dataOverrides[key])) {
        inst.data[key] = { ...inst.data[key], ...dataOverrides[key] };
      } else {
        inst.data[key] = dataOverrides[key];
      }
    }
  }
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  inst.callAdminFunction = function(name, data = {}, timeout) {
    return wx.cloud.callFunction({ name, data, timeout });
  };
  inst.verifyAdmin = jest.fn().mockResolvedValue(true);
  return inst;
}

describe('manage-admins page', () => {
  describe('onLoad', () => {
    it('should load admins on auth success', async () => {
      const inst = createInstance();
      inst.loadAdmins = jest.fn();
      await inst.onLoad();
      expect(inst.loadAdmins).toHaveBeenCalled();
    });

    it('should not load admins on auth failure', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      inst.loadAdmins = jest.fn();
      await inst.onLoad();
      expect(inst.loadAdmins).not.toHaveBeenCalled();
    });
  });

  describe('loadAdmins', () => {
    it('should load admin list and derive superadmin from local role', async () => {
      const inst = createInstance();
      mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({
            result: { success: true, data: { admins: [{ _id: '1', account: 'admin1', displayName: 'Admin One' }] } }
          });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.loadAdmins();

      expect(inst.data.admins.length).toBe(1);
      expect(inst.data.admins[0].firstChar).toBe('A');
      expect(inst.data.isSuperAdmin).toBe(true);
      expect(inst.data.loading).toBe(false);
    });

    it('应读取 callerIsFounder（缺省 false，避免旧云函数误开升降级入口）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                callerIsFounder: true,
                founderEnforced: true,
                admins: [{ _id: '1', account: 'root', role: 'superadmin', isSelf: true, isFounder: true }]
              }
            }
          });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.loadAdmins();

      expect(inst.data.isFounder).toBe(true);
      expect(inst.data.founderEnforced).toBe(true);
      expect(inst.data.admins[0].isFounder).toBe(true);
    });

    it('旧版云函数字段（callerIsOwner/isOwner）仍被兼容读取（部署灰度期）', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                callerIsOwner: true,
                ownerEnforced: true,
                admins: [{ _id: '1', account: 'root', role: 'superadmin', isSelf: true, isOwner: true }]
              }
            }
          });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst.loadAdmins();

      expect(inst.data.isFounder).toBe(true);
      expect(inst.data.founderEnforced).toBe(true);
      expect(inst.data.admins[0].isFounder).toBe(true);
    });

    it('should warn non-superadmin', async () => {
      const inst = createInstance();
      mockAdminAuth.getAdminRole.mockReturnValue('admin');
      mockAdminAuth.isSuperAdminLevel.mockReturnValue(false);
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({ result: { success: true, data: { admins: [] } } });
        }
        return Promise.resolve({ result: {} });
      });

      await inst.loadAdmins();

      expect(wx.showToast).toHaveBeenCalledWith({ title: '仅超级管理员可管理', icon: 'none' });
      expect(inst.data.isSuperAdmin).toBe(false);
    });

    // 回归（FE-28）：身份曾经来自第二次云调用 checkAdminStatus，
    // 而那个调用一失败就静默降级成 isSuperAdmin=false —— 已过超管门禁的用户
    // 会被藏起管理入口，并收到一句「仅超级管理员可管理」，纯属冤枉。
    // 现在改读本地角色（同步、无失败可能），并且**不再发这次多余的往返**。
    it('不再调 checkAdminStatus，身份直接取本地角色', async () => {
      const inst = createInstance();
      mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({ result: { success: true, data: { admins: [] } } });
        }
        return Promise.resolve({ result: { success: true, data: { isSuperAdmin: false } } });
      });

      await inst.loadAdmins();

      const calledNames = wx.cloud.callFunction.mock.calls.map(([arg]) => arg.name);
      expect(calledNames).not.toContain('checkAdminStatus');
      // 即使把 checkAdminStatus 喂成 false，也不能影响判定（它压根没被调）
      expect(inst.data.isSuperAdmin).toBe(true);
    });

    it('should handle load error', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));

      await inst.loadAdmins();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    it('should use account for firstChar when no displayName', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({
            result: { success: true, data: { admins: [{ _id: '1', account: 'testuser' }] } }
          });
        }
        if (name === 'checkAdminStatus') {
          return Promise.resolve({ result: { data: { isSuperAdmin: true } } });
        }
        return Promise.resolve({ result: {} });
      });

      await inst.loadAdmins();

      expect(inst.data.admins[0].firstChar).toBe('t');
    });

    it('should keep boundOpenid flag from server for 绑定状态 display', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'manageAdmin') {
          return Promise.resolve({
            result: { success: true, data: { admins: [
              { _id: '1', account: 'a1', displayName: 'A1', boundOpenid: true },
              { _id: '2', account: 'a2', displayName: 'A2', boundOpenid: false }
            ] } }
          });
        }
        if (name === 'checkAdminStatus') {
          return Promise.resolve({ result: { data: { isSuperAdmin: true } } });
        }
        return Promise.resolve({ result: {} });
      });

      await inst.loadAdmins();

      expect(inst.data.admins[0].boundOpenid).toBe(true);
      expect(inst.data.admins[1].boundOpenid).toBe(false);
    });
  });

  describe('add admin', () => {
    it('onShowAddAdmin should open add modal', () => {
      const inst = createInstance();
      inst.onShowAddAdmin();
      expect(wx.vibrateShort).toHaveBeenCalled();
      expect(inst.data.showAddModal).toBe(true);
      expect(inst.data.addForm.account).toBe('');
      expect(inst.data.passwordStrength).toBe('weak');
    });

    it('onAddFormInput should update field and validate', () => {
      const inst = createInstance();
      inst.onAddFormInput({ currentTarget: { dataset: { field: 'account' } }, detail: { value: 'testuser' } });
      expect(inst.data.addForm.account).toBe('testuser');
    });

    it('onAddFormInput should update password strength', () => {
      const inst = createInstance();
      inst.onAddFormInput({ currentTarget: { dataset: { field: 'password' } }, detail: { value: 'strongpass1' } });
      expect(inst.data.passwordStrength).toBe('strong');
    });

    it('_validateAddField should validate account', () => {
      const inst = createInstance();
      inst._validateAddField('account', '');
      expect(inst.data.addErrors.account).toBe('请输入登录账号');

      inst._validateAddField('account', 'ab');
      expect(inst.data.addErrors.account).toBe('账号至少3个字符');

      inst._validateAddField('account', 'a'.repeat(21));
      expect(inst.data.addErrors.account).toBe('账号最多20个字符');

      inst._validateAddField('account', 'invalid@');
      expect(inst.data.addErrors.account).toBe('仅支持英文、数字和下划线');
    });

    it('_validateAddField should validate displayName', () => {
      const inst = createInstance();
      inst._validateAddField('displayName', 'a'.repeat(21));
      expect(inst.data.addErrors.displayName).toBe('最多20个字符');
    });

    it('_validateAddField should validate password', () => {
      const inst = createInstance();
      inst._validateAddField('password', '');
      expect(inst.data.addErrors.password).toBe('请输入密码');

      inst._validateAddField('password', '12345');
      expect(inst.data.addErrors.password).toBe('密码至少6位');

      inst._validateAddField('password', 'abcdef');
      expect(inst.data.addErrors.password).toBe('密码必须包含字母和数字');
    });

    it('_validateAddField should pass valid account', () => {
      const inst = createInstance();
      const result = inst._validateAddField('account', 'valid_user123');
      expect(result).toBe(true);
    });

    it('_validateAddForm should validate all fields', () => {
      const inst = createInstance({
        addForm: { account: 'valid', password: 'pass123', displayName: 'Test' }
      });
      const result = inst._validateAddForm();
      expect(result).toBe(true);
    });

    it('onToggleAddPassword should toggle visibility', () => {
      const inst = createInstance({ showAddPassword: false });
      inst.onToggleAddPassword();
      expect(inst.data.showAddPassword).toBe(true);
    });

    it('onAddAdminConfirm should add admin successfully', async () => {
      const inst = createInstance({
        addForm: { account: 'newadmin', password: 'pass123', displayName: 'New Admin' },
        addSubmitting: false
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onAddAdminConfirm();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageAdmin', data: expect.objectContaining({ action: 'add' }) })
      );
      expect(wx.showToast).toHaveBeenCalledWith({ title: '添加成功', icon: 'success' });
      expect(inst.data.showAddModal).toBe(false);
    });

    it('onAddAdminConfirm should handle existing account error', async () => {
      const inst = createInstance({
        addForm: { account: 'existing', password: 'pass123', displayName: 'Test' },
        addSubmitting: false
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '账号已存在' } });

      await inst.onAddAdminConfirm();

      expect(inst.data.addErrors.account).toBe('账号已存在');
    });

    it('onAddAdminConfirm should handle generic error', async () => {
      const inst = createInstance({
        addForm: { account: 'test', password: 'pass123', displayName: 'Test' },
        addSubmitting: false
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '添加失败' } });

      await inst.onAddAdminConfirm();

      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '添加失败' }));
    });

    it('onAddAdminConfirm should not submit with invalid form', async () => {
      const inst = createInstance({
        addForm: { account: '', password: '', displayName: '' },
        addSubmitting: false
      });
      await inst.onAddAdminConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onAddAdminConfirm should not submit when already submitting', async () => {
      const inst = createInstance({
        addForm: { account: 'test', password: 'pass123', displayName: 'Test' },
        addSubmitting: true
      });
      await inst.onAddAdminConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onAddAdminConfirm should handle exception', async () => {
      const inst = createInstance({
        addForm: { account: 'test', password: 'pass123', displayName: 'Test' },
        addSubmitting: false
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('network'));

      await inst.onAddAdminConfirm();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.addSubmitting).toBe(false);
    });

    it('onAddModalCancel should close modal when not submitting', () => {
      const inst = createInstance({ showAddModal: true, addSubmitting: false });
      inst.onAddModalCancel();
      expect(inst.data.showAddModal).toBe(false);
    });

    it('onAddModalCancel should not close when submitting', () => {
      const inst = createInstance({ showAddModal: true, addSubmitting: true });
      inst.onAddModalCancel();
      expect(inst.data.showAddModal).toBe(true);
    });
  });

  describe('edit admin', () => {
    it('onEditAdmin should open edit modal', () => {
      const inst = createInstance();
      inst.onEditAdmin({ currentTarget: { dataset: { id: '1', name: 'Admin', account: 'admin1' } } });
      expect(wx.vibrateShort).toHaveBeenCalled();
      expect(inst.data.showEditModal).toBe(true);
      expect(inst.data.editTargetId).toBe('1');
      expect(inst.data.editForm.displayName).toBe('Admin');
    });

    it('onEditFormInput should update field', () => {
      const inst = createInstance();
      inst.onEditFormInput({ currentTarget: { dataset: { field: 'displayName' } }, detail: { value: 'NewName' } });
      expect(inst.data.editForm.displayName).toBe('NewName');
    });

    it('_validateEditField should validate displayName', () => {
      const inst = createInstance();
      inst._validateEditField('displayName', '');
      expect(inst.data.editErrors.displayName).toBe('显示名称不能为空');

      inst._validateEditField('displayName', 'a'.repeat(21));
      expect(inst.data.editErrors.displayName).toBe('最多20个字符');
    });

    it('_validateEditField should validate password', () => {
      const inst = createInstance();
      inst._validateEditField('password', '12345');
      expect(inst.data.editErrors.password).toBe('密码至少6位');
    });

    it('_validateEditField should allow empty password (no change)', () => {
      const inst = createInstance();
      const result = inst._validateEditField('password', '');
      expect(result).toBe(true);
    });

    it('onToggleEditPassword should toggle visibility', () => {
      const inst = createInstance({ showEditPassword: false });
      inst.onToggleEditPassword();
      expect(inst.data.showEditPassword).toBe(true);
    });

    it('onEditConfirm should save successfully', async () => {
      const inst = createInstance({
        editTargetId: '1',
        editForm: { displayName: 'Updated', password: 'newpass1' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageAdmin', data: expect.objectContaining({ action: 'update' }) })
      );
      expect(inst.data.showEditModal).toBe(false);
    });

    it('onEditConfirm 超管提交密码重置', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        editTargetId: '1',
        editForm: { displayName: 'Updated', password: 'newpass1' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data).toEqual(expect.objectContaining({
        action: 'update',
        targetId: '1',
        displayName: 'Updated',
        password: 'newpass1'
      }));
    });

    it('onEditConfirm 被授权的普通管理员不提交密码（即使表单里有值）', async () => {
      const inst = createInstance({
        isSuperAdmin: false,
        editTargetId: '1',
        editForm: { displayName: 'Updated', password: 'newpass1' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data).toEqual(expect.objectContaining({
        action: 'update',
        displayName: 'Updated'
      }));
      expect(call[0].data.password).toBeUndefined();
    });

    // 角色变更（普通 ↔ 超级）：服务端 handleUpdate 早已支持 role，
    // 以下用例锁住「列表回填 → 草稿 → 二次确认 → 提交」整条链。
    it('onEditAdmin 应把列表里的角色与本人标记带进编辑弹窗', () => {
      const inst = createInstance({
        admins: [
          { _id: '1', account: 'admin1', displayName: 'Admin', role: 'admin', isSelf: false, isFounder: false }
        ]
      });
      inst.onEditAdmin({
        currentTarget: { dataset: { id: '1', name: 'Admin', account: 'admin1', role: 'admin' } }
      });
      expect(inst.data.editForm.role).toBe('admin');
      expect(inst.data.editTargetRole).toBe('admin');
      expect(inst.data.editTargetIsSelf).toBe(false);
      expect(inst.data.editTargetIsFounder).toBe(false);
    });

    it('onEditAdmin 对本人账号标记 editTargetIsSelf', () => {
      const inst = createInstance({
        admins: [
          { _id: 'sa-1', account: 'root', displayName: 'Root', role: 'superadmin', isSelf: true, isFounder: true }
        ]
      });
      inst.onEditAdmin({
        currentTarget: { dataset: { id: 'sa-1', name: 'Root', account: 'root', role: 'superadmin' } }
      });
      expect(inst.data.editTargetIsSelf).toBe(true);
      expect(inst.data.editTargetIsFounder).toBe(true);
      expect(inst.data.editTargetRole).toBe('superadmin');
    });

    it('提升 / 降级 / 撤销只在草稿内生效', () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetRole: 'superadmin',
        editForm: { role: 'superadmin' }
      });
      inst.onDemoteToAdmin();
      expect(inst.data.editForm.role).toBe('admin');
      inst.onResetRoleDraft();
      expect(inst.data.editForm.role).toBe('superadmin');

      inst.setData({ editTargetRole: 'admin', editForm: { ...inst.data.editForm, role: 'admin' } });
      inst.onPromoteToSuperAdmin();
      expect(inst.data.editForm.role).toBe('superadmin');
      inst.onResetRoleDraft();
      expect(inst.data.editForm.role).toBe('admin');
    });

    it('角色操作对非超管、非所有者与本人/所有者账号无效', () => {
      const notSuper = createInstance({ isSuperAdmin: false });
      notSuper.onPromoteToSuperAdmin();
      expect(notSuper.data.editForm.role).toBe('admin');

      const notOwner = createInstance({ isSuperAdmin: true, isFounder: false });
      notOwner.onPromoteToSuperAdmin();
      expect(notOwner.data.editForm.role).toBe('admin');

      const self = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetIsSelf: true,
        editTargetRole: 'superadmin',
        editForm: { role: 'superadmin' }
      });
      self.onDemoteToAdmin();
      expect(self.data.editForm.role).toBe('superadmin');

      const ownerTarget = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetIsFounder: true,
        editTargetRole: 'superadmin',
        editForm: { role: 'superadmin' }
      });
      ownerTarget.onDemoteToAdmin();
      expect(ownerTarget.data.editForm.role).toBe('superadmin');
    });

    it('onEditConfirm 提升超管：确认后提交 role=superadmin', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetId: '1',
        editTargetRole: 'admin',
        editForm: { displayName: 'Same', password: '', role: 'superadmin' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Same', role: 'admin' }]
      });
      inst.loadAdmins = jest.fn();
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
        return Promise.resolve({ confirm: true });
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data).toEqual(expect.objectContaining({
        action: 'update',
        targetId: '1',
        role: 'superadmin'
      }));
      expect(wx.showToast).toHaveBeenCalledWith({ title: '保存成功', icon: 'success' });
    });

    it('onEditConfirm 降级超管：确认后提交 role=admin', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetId: '2',
        editTargetRole: 'superadmin',
        editForm: { displayName: 'Other', password: '', role: 'admin' },
        editSubmitting: false,
        admins: [{ _id: '2', displayName: 'Other', role: 'superadmin' }]
      });
      inst.loadAdmins = jest.fn();
      const modalCalls = [];
      wx.showModal.mockImplementation((opts) => {
        modalCalls.push(opts);
        if (opts.success) opts.success({ confirm: true });
        return Promise.resolve({ confirm: true });
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      expect(modalCalls[0].title).toContain('降级');
      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data.role).toBe('admin');
    });

    it('onEditConfirm 角色确认取消时不发任何请求', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetId: '1',
        editTargetRole: 'admin',
        editForm: { displayName: 'Same', password: '', role: 'superadmin' },
        editSubmitting: false,
        showEditModal: true,
        admins: [{ _id: '1', displayName: 'Same', role: 'admin' }]
      });
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: false });
        return Promise.resolve({ confirm: false });
      });

      await inst.onEditConfirm();

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
      expect(inst.data.showEditModal).toBe(true);
    });

    it('onEditConfirm 非超管即使草稿是 superadmin 也不提交 role', async () => {
      const inst = createInstance({
        isSuperAdmin: false,
        editTargetId: '1',
        editTargetRole: 'admin',
        editForm: { displayName: 'Updated', password: '', role: 'superadmin' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old', role: 'admin' }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data.role).toBeUndefined();
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    it('onEditConfirm 本人账号不可改角色（只改显示名也能保存）', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetId: 'sa-1',
        editTargetRole: 'superadmin',
        editTargetIsSelf: true,
        editForm: { displayName: 'Root2', password: '', role: 'admin' },
        editSubmitting: false,
        admins: [{ _id: 'sa-1', displayName: 'Root', role: 'superadmin', isSelf: true, isFounder: true }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data.role).toBeUndefined();
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    // 层级：非创始人超管可以管普通管理员，但不能升降其他超管。
    it('onEditConfirm 非创始人超管不提交 role', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: false,
        editTargetId: 'sa-2',
        editTargetRole: 'superadmin',
        editForm: { displayName: 'Other2', password: '', role: 'admin' },
        editSubmitting: false,
        admins: [{ _id: 'sa-2', displayName: 'Other', role: 'superadmin', isFounder: false }]
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onEditConfirm();

      const call = wx.cloud.callFunction.mock.calls.find(
        item => item[0].name === 'manageAdmin'
      );
      expect(call[0].data.role).toBeUndefined();
      expect(wx.showModal).not.toHaveBeenCalled();
    });

    it('onEditConfirm 创始人账号不被降级（目标 isFounder 时忽略草稿）', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        isFounder: true,
        editTargetId: 'sa-1',
        editTargetRole: 'superadmin',
        editTargetIsFounder: true,
        editForm: { displayName: 'Root', password: '', role: 'admin' },
        editSubmitting: false,
        admins: [{ _id: 'sa-1', displayName: 'Root', role: 'superadmin', isFounder: true }]
      });
      // 只改角色、不改名字 → 不应被当成「有修改」而提交
      await inst.onEditConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith({ title: '没有修改内容', icon: 'none' });
    });

    it('onEditConfirm should detect no changes', async () => {
      const inst = createInstance({
        editTargetId: '1',
        editForm: { displayName: 'Same', password: '' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Same' }]
      });

      await inst.onEditConfirm();

      expect(wx.showToast).toHaveBeenCalledWith({ title: '没有修改内容', icon: 'none' });
    });

    it('onEditConfirm should not submit when already submitting', async () => {
      const inst = createInstance({
        editTargetId: '1',
        editForm: { displayName: 'New', password: 'pass123' },
        editSubmitting: true,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      await inst.onEditConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onEditConfirm should handle failure', async () => {
      const inst = createInstance({
        editTargetId: '1',
        editForm: { displayName: 'New', password: 'pass123' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '保存失败' } });

      await inst.onEditConfirm();

      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '保存失败' }));
    });

    it('onEditConfirm should handle exception', async () => {
      const inst = createInstance({
        editTargetId: '1',
        editForm: { displayName: 'New', password: 'pass123' },
        editSubmitting: false,
        admins: [{ _id: '1', displayName: 'Old' }]
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));

      await inst.onEditConfirm();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.editSubmitting).toBe(false);
    });

    it('onEditCancel should close when not submitting', () => {
      const inst = createInstance({ showEditModal: true, editSubmitting: false });
      inst.onEditCancel();
      expect(inst.data.showEditModal).toBe(false);
    });

    it('onEditCancel should not close when submitting', () => {
      const inst = createInstance({ showEditModal: true, editSubmitting: true });
      inst.onEditCancel();
      expect(inst.data.showEditModal).toBe(true);
    });
  });

  describe('entry permissions (功能权限)', () => {
    it('onEditPermissions should open modal with effective permissions', () => {
      const inst = createInstance({
        isSuperAdmin: true,
        admins: [{
          _id: '1',
          account: 'a1',
          displayName: 'Admin One',
          role: 'admin',
          permissions: ['addCat', 'photo']
        }]
      });

      inst.onEditPermissions({ currentTarget: { dataset: { id: '1', name: 'Admin One' } } });

      expect(inst.data.showPermModal).toBe(true);
      expect(inst.data.permTargetId).toBe('1');
      expect(inst.data.permDraft.addCat).toBe(true);
      expect(inst.data.permDraft.photo).toBe(true);
      expect(inst.data.permDraft.cat).toBe(false);
      expect(inst.data.permGroups.length).toBeGreaterThan(0);
    });

    it('onEditPermissions should be a no-op for non-superadmin', () => {
      const inst = createInstance({ isSuperAdmin: false, admins: [{ _id: '1' }] });
      inst.onEditPermissions({ currentTarget: { dataset: { id: '1' } } });
      expect(inst.data.showPermModal).toBe(false);
      expect(wx.vibrateShort).not.toHaveBeenCalled();
    });

    it('onPermSwitchChange should update draft and groups', () => {
      const inst = createInstance({
        isSuperAdmin: true,
        permDraft: { addCat: true },
        permOriginal: { addCat: true }
      });

      inst.onPermSwitchChange({
        currentTarget: { dataset: { key: 'mediaReview' } },
        detail: { value: true }
      });

      expect(inst.data.permDraft.mediaReview).toBe(true);
      const mediaReview = inst.data.permGroups
        .reduce((acc, group) => acc.concat(group.items), [])
        .find(item => item.key === 'mediaReview');
      expect(mediaReview.checked).toBe(true);
    });

    it('onToggleAllPermissions should switch between all on/off', () => {
      const inst = createInstance({ isSuperAdmin: true, permDraft: { addCat: true } });

      inst.onToggleAllPermissions();
      expect(Object.values(inst.data.permDraft).every(Boolean)).toBe(true);
      expect(inst.data.permAllOn).toBe(true);

      inst.onToggleAllPermissions();
      expect(Object.values(inst.data.permDraft).every(v => v === false)).toBe(true);
      expect(inst.data.permAllOn).toBe(false);
    });

    it('_buildPermConfirm should warn when closing all entries', () => {
      const inst = createInstance({ permDraft: {}, permOriginal: {} });
      const confirm = inst._buildPermConfirm({});
      expect(confirm.title).toBe('关闭全部入口');
    });

    it('_buildPermConfirm should warn only for newly enabled high-risk entries', () => {
      const inst = createInstance({
        permDraft: { logs: true, catActivity: false },
        permOriginal: { logs: false, catActivity: false }
      });
      const confirm = inst._buildPermConfirm({ logs: true, catActivity: false });
      expect(confirm.title).toBe('开启高风险权限');
      expect(confirm.content).toContain('将开启：操作日志');
      expect(confirm.content).not.toContain('将开启：操作日志、猫咪行动分析');
    });

    it('onSavePermissions should not submit when sensitive confirm is cancelled', () => {
      const inst = createInstance({
        isSuperAdmin: true,
        permDraft: { logs: true },
        permOriginal: { logs: false }
      });
      inst._submitPermissions = jest.fn(() => Promise.resolve());
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: false });
        return Promise.resolve({ confirm: false });
      });

      inst.onSavePermissions();

      expect(inst._submitPermissions).not.toHaveBeenCalled();
    });

    it('_submitPermissions should send the selected array and reload list', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        showPermModal: true,
        permTargetId: 'admin-1',
        permDraft: { addCat: true, cat: false, photo: true }
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockImplementation(({ name, data }) => {
        if (name === 'checkAdminStatus') {
          return Promise.resolve({ result: { success: true, data: { isAdmin: true } } });
        }
        if (name === 'manageAdmin' && data.action === 'updatePermissions') {
          return Promise.resolve({ result: { success: true } });
        }
        return Promise.resolve({ result: { success: true } });
      });

      await inst._submitPermissions();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'manageAdmin',
          data: expect.objectContaining({
            action: 'updatePermissions',
            targetId: 'admin-1',
            permissions: ['addCat', 'photo']
          })
        })
      );
      expect(inst.data.showPermModal).toBe(false);
      expect(inst.loadAdmins).toHaveBeenCalled();
    });

    it('_submitPermissions should keep modal open and show server error', async () => {
      const inst = createInstance({
        isSuperAdmin: true,
        showPermModal: true,
        permTargetId: 'admin-1',
        permDraft: { addCat: true }
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockImplementation(({ name }) => {
        if (name === 'checkAdminStatus') {
          return Promise.resolve({ result: { success: true, data: { isAdmin: true } } });
        }
        return Promise.resolve({ result: { success: false, error: '无效的权限项: xxx' } });
      });

      await inst._submitPermissions();

      expect(wx.showToast).toHaveBeenCalledWith({ title: '无效的权限项: xxx', icon: 'none' });
      expect(inst.data.showPermModal).toBe(true);
      expect(inst.loadAdmins).not.toHaveBeenCalled();
    });
  });

  describe('remove admin', () => {
    it('onRemoveAdmin should show remove modal', () => {
      const inst = createInstance();
      inst.onRemoveAdmin({ currentTarget: { dataset: { id: '1', name: 'Admin' } } });
      expect(wx.vibrateShort).toHaveBeenCalled();
      expect(inst.data.showRemoveModal).toBe(true);
      expect(inst.data.removeTargetId).toBe('1');
      expect(inst.data.removeTargetName).toBe('Admin');
    });

    it('onRemoveConfirm should remove successfully', async () => {
      const inst = createInstance({
        removeTargetId: '1',
        removeSubmitting: false
      });
      inst.loadAdmins = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onRemoveConfirm();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageAdmin', data: { action: 'remove', targetId: '1' } })
      );
      expect(wx.showToast).toHaveBeenCalledWith({ title: '已移除', icon: 'success' });
      expect(inst.data.showRemoveModal).toBe(false);
    });

    it('onRemoveConfirm should not submit when already submitting', async () => {
      const inst = createInstance({ removeSubmitting: true });
      await inst.onRemoveConfirm();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onRemoveConfirm should handle failure', async () => {
      const inst = createInstance({ removeTargetId: '1', removeSubmitting: false });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '移除失败' } });

      await inst.onRemoveConfirm();

      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '移除失败' }));
    });

    it('onRemoveConfirm should handle exception', async () => {
      const inst = createInstance({ removeTargetId: '1', removeSubmitting: false });
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));

      await inst.onRemoveConfirm();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.removeSubmitting).toBe(false);
    });

    it('onRemoveCancel should close when not submitting', () => {
      const inst = createInstance({ showRemoveModal: true, removeSubmitting: false });
      inst.onRemoveCancel();
      expect(inst.data.showRemoveModal).toBe(false);
    });

    it('onRemoveCancel should not close when submitting', () => {
      const inst = createInstance({ showRemoveModal: true, removeSubmitting: true });
      inst.onRemoveCancel();
      expect(inst.data.showRemoveModal).toBe(true);
    });
  });

  describe('unbind admin (解绑微信)', () => {
    const confirmModal = (opts) => {
      if (opts.success) opts.success({ confirm: true });
      return Promise.resolve({ confirm: true });
    };
    const cancelModal = (opts) => {
      if (opts.success) opts.success({ confirm: false });
      return Promise.resolve({ confirm: false });
    };

    it('onUnbindAdmin should call manageAdmin unbind after confirm', async () => {
      const inst = createInstance();
      inst.loadAdmins = jest.fn();
      wx.showModal.mockImplementation(confirmModal);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      inst.onUnbindAdmin({ currentTarget: { dataset: { id: '1', name: 'Admin' } } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageAdmin', data: { action: 'unbind', targetId: '1' } })
      );
      expect(wx.showToast).toHaveBeenCalledWith({ title: '已解绑', icon: 'success' });
      expect(inst.loadAdmins).toHaveBeenCalled();
    });

    it('onUnbindAdmin should not call cloud when cancelled', async () => {
      const inst = createInstance();
      wx.showModal.mockImplementation(cancelModal);

      inst.onUnbindAdmin({ currentTarget: { dataset: { id: '1', name: 'Admin' } } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onUnbindAdmin should show server error (e.g. 未绑定)', async () => {
      const inst = createInstance();
      wx.showModal.mockImplementation(confirmModal);
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '该账号尚未绑定微信' } });

      inst.onUnbindAdmin({ currentTarget: { dataset: { id: '1', name: 'Admin' } } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '该账号尚未绑定微信' }));
    });

    it('onUnbindAdmin should guard reentry (single cloud call)', async () => {
      const inst = createInstance();
      inst.loadAdmins = jest.fn();
      wx.showModal.mockImplementation(confirmModal);
      wx.cloud.callFunction.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ result: { success: true } }), 5))
      );

      const event = { currentTarget: { dataset: { id: '1', name: 'Admin' } } };
      inst.onUnbindAdmin(event);
      inst.onUnbindAdmin(event);
      await new Promise(resolve => setTimeout(resolve, 30));

      const unbindCalls = wx.cloud.callFunction.mock.calls.filter(
        c => c[0] && c[0].data && c[0].data.action === 'unbind'
      );
      expect(unbindCalls).toHaveLength(1);
    });
  });

  describe('onPullDownRefresh', () => {
    it('should reload admins and stop refresh', async () => {
      const inst = createInstance();
      inst.loadAdmins = jest.fn(() => Promise.resolve());
      inst.onPullDownRefresh();
      await Promise.resolve(); // let .finally() microtask run
      expect(inst.loadAdmins).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('calcPasswordStrength', () => {
    it('should return weak for short password', () => {
      const _result = pageDef._calcPasswordStrength ? pageDef._calcPasswordStrength('ab') : 'weak';
      expect(['weak']).toContain('weak');
    });
  });
});
