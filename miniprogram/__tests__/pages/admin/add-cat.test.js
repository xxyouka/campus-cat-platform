const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleValidationError: jest.fn(),
  handleDatabaseError: jest.fn()
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  checkAdminAuthAsync: jest.fn(() => Promise.resolve({ verified: true })),
  getAdminRole: jest.fn(() => 'superadmin'),
  clearAdminAuth: jest.fn(),
  checkAdminAuth: jest.fn(() => true),
  setAdminAuth: jest.fn()
};
const mockPageState = {
  getPageStateManager: jest.fn(() => ({
    setNeedRefresh: jest.fn(),
    checkNeedRefresh: jest.fn(() => null)
  }))
};
const mockObsHelper = {
  reportEvent: jest.fn(),
  EVENT_NAMES: { ADMIN_ADD_CAT: 'admin_add_cat' },
  isAvailable: jest.fn()
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/pageState', () => mockPageState);
jest.mock('../../../utils/obsHelper', () => mockObsHelper);
const mockCallAdminFunction = jest.fn();
const mockVerifyAdmin = jest.fn(() => Promise.resolve(true));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: (...args) => mockVerifyAdmin(...args),
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/add-cat/add-cat');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  mockAdminAuth.checkAdminAuthAsync.mockResolvedValue({ verified: true });
  mockCallAdminFunction.mockImplementation((name, data) => wx.cloud.callFunction({ name, data }));
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  wx.cloud.uploadFile.mockReset();
  wx.cloud.uploadFile.mockResolvedValue({ fileID: 'cloud://test-file-id' });
  wx.chooseMedia = jest.fn();
  wx.vibrateShort = jest.fn();
  // 图片体积相关 API：imageCompressor.compressToLimit 依赖 getFileInfo 判定是否超限，
  // 真实实现在读不到大小时返回 Infinity（失败关闭，防止未压缩的原图被放行）。
  // 测试环境若不 mock，被测路径会误判「图片过大」而在上传前 return，
  // 表现为 uploadFile 零调用 —— 这属于环境缺口，不是页面逻辑问题。
  wx.getFileInfo = jest.fn((opts) => {
    if (opts && opts.success) opts.success({ size: 200 * 1024 });
  });
  wx.compressImage = jest.fn((opts) => {
    if (opts && opts.success) opts.success({ tempFilePath: opts.src });
  });
  wx.showModal.mockReset();
  wx.showModal.mockImplementation((opts) => {
    if (opts.success) opts.success({ confirm: true });
    return Promise.resolve({ confirm: true });
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
    }),
    _saving: false,
    callAdminFunction: (name, data) => wx.cloud.callFunction({ name, data }),
    verifyAdmin: () => Promise.resolve(true)
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
  return inst;
}

describe('add-cat page', () => {
  describe('onLoad', () => {
    it('should set statusBarHeight on auth success', async () => {
      const inst = createInstance();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(20);
    });

    it('should return early when auth fails', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(0);
    });
  });

  describe('form input methods', () => {
    it('onInput should update form field', () => {
      const inst = createInstance();
      inst.onInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: 'Kitty' } });
      expect(inst.data.form.name).toBe('Kitty');
    });

    it('onInputFocus should set inputFocus true', () => {
      const inst = createInstance();
      inst.onInputFocus();
      expect(inst.data.inputFocus).toBe(true);
    });

    it('onInputBlur should set inputFocus false', () => {
      const inst = createInstance({ inputFocus: true });
      inst.onInputBlur();
      expect(inst.data.inputFocus).toBe(false);
    });

    it('onOption should update form field with value', () => {
      const inst = createInstance();
      inst.onOption({ currentTarget: { dataset: { field: 'gender', value: 'male' } } });
      expect(inst.data.form.gender).toBe('male');
    });

    it('onSterilized should set true', () => {
      const inst = createInstance();
      inst.onSterilized({ currentTarget: { dataset: { value: 'true' } } });
      expect(inst.data.form.sterilized).toBe(true);
    });

    it('onSterilized should set false', () => {
      const inst = createInstance();
      inst.onSterilized({ currentTarget: { dataset: { value: 'false' } } });
      expect(inst.data.form.sterilized).toBe(false);
    });

    it('onSterilized should set null for other values', () => {
      const inst = createInstance();
      inst.onSterilized({ currentTarget: { dataset: { value: 'other' } } });
      expect(inst.data.form.sterilized).toBeNull();
    });

    it('onAdoptLevel should set a number (dataset 是字符串，必须转数字)', () => {
      const inst = createInstance();
      inst.onAdoptLevel({ currentTarget: { dataset: { value: '4' } } });
      expect(inst.data.form.adoptLevel).toBe(4);
      inst.onAdoptLevel({ currentTarget: { dataset: { value: '0' } } });
      expect(inst.data.form.adoptLevel).toBe(0);
    });

    it('onAdoptLevel should fall back to 0 for unexpected values', () => {
      const inst = createInstance({ form: { ...pageDef.data.form, adoptLevel: 5 } });
      inst.onAdoptLevel({ currentTarget: { dataset: {} } });
      expect(inst.data.form.adoptLevel).toBe(0);
    });

    it('onDate should update date field', () => {
      const inst = createInstance();
      inst.onDate({ currentTarget: { dataset: { field: 'deceasedTime' } }, detail: { value: '2025-01-01' } });
      expect(inst.data.form.deceasedTime).toBe('2025-01-01');
    });
  });

  describe('avatar operations', () => {
    // onChooseAvatar 走 utils/mediaChoose 兼容层（PC 端 chooseMedia 不可用需降级 chooseImage），
    // 因此是异步的：同步断言会赶在 setData 之前执行
    it('onChooseAvatar should call wx.chooseMedia', async () => {
      wx.chooseMedia.mockImplementation((opts) => {
        opts.success({ tempFiles: [{ tempFilePath: '/tmp/avatar.jpg' }] });
      });
      const inst = createInstance();
      await inst.onChooseAvatar();
      expect(wx.chooseMedia).toHaveBeenCalled();
      expect(inst.data.avatar).toBe('/tmp/avatar.jpg');
    });

    it('onRemoveAvatar should clear avatar', () => {
      const inst = createInstance({ avatar: '/tmp/avatar.jpg' });
      inst.onRemoveAvatar();
      expect(inst.data.avatar).toBeNull();
    });
  });

  describe('onCancel', () => {
    it('should navigate back', () => {
      const inst = createInstance();
      inst.onCancel();
      expect(wx.navigateBack).toHaveBeenCalled();
    });
  });

  describe('onSave', () => {
    it('should return early if loading', async () => {
      const inst = createInstance({ loading: true });
      inst._saving = true;
      await inst.onSave();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('should show modal when auth expired', async () => {
      mockAdminAuth.checkAdminAuthAsync.mockResolvedValue({ verified: false });
      const inst = createInstance({ avatar: '/tmp/a.jpg', form: { ...pageDef.data.form, name: 'Kitty' } });
      await inst.onSave();
      expect(wx.showModal).toHaveBeenCalled();
      expect(inst._saving).toBe(false);
    });

    it('should validate name is required', async () => {
      const inst = createInstance({ avatar: '/tmp/a.jpg', form: { ...pageDef.data.form, name: '' } });
      await inst.onSave();
      expect(mockErrorHandler.handleValidationError).toHaveBeenCalledWith('猫咪名字', '不能为空');
      expect(inst._saving).toBe(false);
    });

    it('should validate name trim is required', async () => {
      const inst = createInstance({ avatar: '/tmp/a.jpg', form: { ...pageDef.data.form, name: '   ' } });
      await inst.onSave();
      expect(mockErrorHandler.handleValidationError).toHaveBeenCalledWith('猫咪名字', '不能为空');
    });

    it('should validate avatar is required', async () => {
      const inst = createInstance({ avatar: null, form: { ...pageDef.data.form, name: 'Kitty' } });
      await inst.onSave();
      expect(mockErrorHandler.handleValidationError).toHaveBeenCalledWith('大头照', '至少上传一张');
    });

    it('should successfully save cat', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty', gender: 'male', color: 'orange' }
      });
      wx.cloud.uploadFile.mockResolvedValue({ fileID: 'cloud://avatar-id' });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onSave();

      expect(wx.cloud.uploadFile).toHaveBeenCalled();
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'addCat' })
      );
      expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('添加成功');
      // 成功路径保持 loading 与提交锁直到跳转：1.5s 窗口内二次点击会生成重复猫咪
      expect(inst.data.loading).toBe(true);
      expect(inst._saving).toBe(true);
      // 清理延迟返回定时器，避免测试进程悬挂
      inst.onUnload();
    });

    it('should send adoptLevel as a number in catData', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty', adoptLevel: 5 }
      });
      wx.cloud.uploadFile.mockResolvedValue({ fileID: 'cloud://avatar-id' });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onSave();

      const addCall = wx.cloud.callFunction.mock.calls.find(c => c[0].name === 'addCat');
      expect(addCall[0].data.catData.adoptLevel).toBe(5);
      inst.onUnload();
    });

    it('should send adoptLevel = 0 when unrated', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty', adoptLevel: 0 }
      });
      wx.cloud.uploadFile.mockResolvedValue({ fileID: 'cloud://avatar-id' });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onSave();

      const addCall = wx.cloud.callFunction.mock.calls.find(c => c[0].name === 'addCat');
      expect(addCall[0].data.catData.adoptLevel).toBe(0);
      inst.onUnload();
    });

    it('should handle cloud function failure', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty' }
      });
      wx.cloud.uploadFile.mockResolvedValue({ fileID: 'cloud://avatar-id' });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, message: 'DB error' } });

      await inst.onSave();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });

    it('should handle upload exception', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty' }
      });
      wx.cloud.uploadFile.mockRejectedValue(new Error('upload fail'));

      await inst.onSave();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
      expect(inst._saving).toBe(false);
    });

    it('should prevent double save', async () => {
      const inst = createInstance({
        avatar: '/tmp/avatar.jpg',
        form: { ...pageDef.data.form, name: 'Kitty' }
      });
      inst._saving = true;
      await inst.onSave();
      expect(wx.cloud.uploadFile).not.toHaveBeenCalled();
    });
  });
});
