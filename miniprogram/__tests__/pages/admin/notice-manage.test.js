const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn(),
  handleValidationError: jest.fn()
};
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin'),
  checkAdminAuth: jest.fn(() => true),
  clearAdminAuth: jest.fn()
};
const mockDateFormat = {
  formatDateShort: jest.fn(() => '01-15'),
  formatDate: jest.fn(() => '01-15'),
  formatDateTime: jest.fn(() => '2025-01-15 10:30'),
  timeAgo: jest.fn(() => '1天前')
};

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/dateFormat', () => mockDateFormat);
jest.mock('../../../behaviors/backToTopBehavior', () => ({}));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/notice-manage/notice-manage');
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
  mockAdminAuth.getAdminRole.mockReturnValue('superadmin');
  wx.cloud.callFunction.mockReset();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
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
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      applySetData(this.data, updates);
    }),
    _deleting: false,
    _cachedNotices: null,
    _cacheTime: 0,
    _backToTopThreshold: 400
  };
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

describe('notice-manage page', () => {
  describe('onLoad', () => {
    it('should load notices for superadmin', async () => {
      const inst = createInstance();
      inst.loadNotices = jest.fn();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.loadNotices).toHaveBeenCalled();
    });

    it('should allow ordinary admin (with notice permission) access', async () => {
      mockAdminAuth.getAdminRole.mockReturnValue('admin');
      const inst = createInstance();
      inst.loadNotices = jest.fn();
      await inst.onLoad();
      expect(inst.data.statusBarHeight).toBe(20);
      expect(inst.loadNotices).toHaveBeenCalled();
    });

    it('should return early when auth fails', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();
      inst.loadNotices = jest.fn();
      await inst.onLoad();
      expect(inst.loadNotices).not.toHaveBeenCalled();
    });
  });

  describe('onShow', () => {
    it('should skip first onShow (onLoad already loaded)', () => {
      const inst = createInstance();
      inst.loadNotices = jest.fn();
      inst.onShow();
      expect(inst.loadNotices).not.toHaveBeenCalled();
    });

    it('should use cached notices within cache period', () => {
      const inst = createInstance();
      inst._firstShowSkipped = true; // onLoad 已完成首载
      inst._cachedNotices = [{ _id: '1', title: 'Test' }];
      inst._cacheTime = Date.now() - 5000;
      inst.loadNotices = jest.fn();
      inst.onShow();
      expect(inst.data.notices).toEqual([{ _id: '1', title: 'Test' }]);
      expect(inst.loadNotices).not.toHaveBeenCalled();
    });

    it('should reload when cache expired', () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst._cachedNotices = [{ _id: '1', title: 'Test' }];
      inst._cacheTime = Date.now() - 30000;
      inst.loadNotices = jest.fn();
      inst.onShow();
      expect(inst.loadNotices).toHaveBeenCalled();
    });

    it('should reload when no cache', () => {
      const inst = createInstance();
      inst._firstShowSkipped = true;
      inst.loadNotices = jest.fn();
      inst.onShow();
      expect(inst.loadNotices).toHaveBeenCalled();
    });
  });

  describe('loadNotices', () => {
    it('should load and format notices', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            notices: [
              { _id: '1', title: 'Notice 1', content: 'Content 1', createTime: '2025-01-15T10:00:00' },
              { _id: '2', title: 'Notice 2', content: 'Content 2', createTime: '2025-01-14T10:00:00' }
            ]
          }
        }
      });

      await inst.loadNotices();

      expect(inst.data.notices.length).toBe(2);
      expect(inst.data.loading).toBe(false);
      expect(mockDateFormat.formatDateShort).toHaveBeenCalled();
      expect(inst._cachedNotices).toBeDefined();
    });

    it('业务失败（success:false）不再静默成「暂无公告」', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, error: '查询失败' }
      });

      await inst.loadNotices();

      // 不写入空数组缓存，空态不会被污染成「真的没有公告」
      expect(inst._cachedNotices).toBeNull();
      expect(inst.data.loading).toBe(false);
    });

    it('should handle empty notices', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockResolvedValue({ result: { data: { notices: [] } } });
      await inst.loadNotices();
      expect(inst.data.notices).toEqual([]);
      expect(inst.data.loading).toBe(false);
    });

    it('should handle load error', async () => {
      const inst = createInstance();
      wx.cloud.callFunction.mockRejectedValue(new Error('fail'));
      await inst.loadNotices();
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.loading).toBe(false);
    });
  });

  describe('onPullDownRefresh', () => {
    it('should clear cache and reload', async () => {
      const inst = createInstance();
      inst._cachedNotices = [{ _id: '1' }];
      inst.loadNotices = jest.fn().mockResolvedValue();
      await inst.onPullDownRefresh();
      expect(inst._cachedNotices).toBeNull();
      expect(inst.loadNotices).toHaveBeenCalled();
      expect(wx.stopPullDownRefresh).toHaveBeenCalled();
    });
  });

  describe('add and edit', () => {
    it('onAdd should open modal in add mode', () => {
      const inst = createInstance();
      inst.onAdd();
      expect(inst.data.modalShow).toBe(true);
      expect(inst.data.isEdit).toBe(false);
      expect(inst.data.form._id).toBe('');
    });

    it('onEdit should open modal in edit mode with data', () => {
      const inst = createInstance();
      const notice = { _id: '1', title: 'Test', content: 'Content' };
      inst.onEdit({ currentTarget: { dataset: { notice } } });
      expect(inst.data.modalShow).toBe(true);
      expect(inst.data.isEdit).toBe(true);
      expect(inst.data.form._id).toBe('1');
      expect(inst.data.form.title).toBe('Test');
    });
  });

  describe('delete', () => {
    it('onDelete should show confirmation modal', () => {
      const inst = createInstance();
      inst.onDelete({ currentTarget: { dataset: { id: '1' } } });
      expect(wx.showModal).toHaveBeenCalled();
    });

    it('onDelete should delete on confirm', async () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: true });
      });
      const inst = createInstance({
        notices: [{ _id: '1', title: 'Test' }, { _id: '2', title: 'Other' }]
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      inst.onDelete({ currentTarget: { dataset: { id: '1' } } });
      await Promise.resolve();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageNotice', data: expect.objectContaining({ action: 'delete' }) })
      );
    });

    it('onDelete should not delete on cancel', async () => {
      wx.showModal.mockImplementation((opts) => {
        if (opts.success) opts.success({ confirm: false });
      });
      const inst = createInstance({ notices: [{ _id: '1', title: 'Test' }] });
      inst.onDelete({ currentTarget: { dataset: { id: '1' } } });
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('onDelete should prevent duplicate delete', () => {
      const inst = createInstance();
      inst._deleting = true;
      inst.onDelete({ currentTarget: { dataset: { id: '1' } } });
      expect(wx.showModal).not.toHaveBeenCalled();
    });
  });

  describe('form input', () => {
    it('onTitleInput should update title and clear error', () => {
      const inst = createInstance();
      inst.onTitleInput({ detail: { value: 'New Title' } });
      expect(inst.data.form.title).toBe('New Title');
      expect(inst.data.formErrors.title).toBe('');
    });

    it('onContentInput should update content and clear error', () => {
      const inst = createInstance();
      inst.onContentInput({ detail: { value: 'New Content' } });
      expect(inst.data.form.content).toBe('New Content');
      expect(inst.data.formErrors.content).toBe('');
    });
  });

  describe('onSubmit', () => {
    it('should validate empty title', async () => {
      const inst = createInstance({
        form: { _id: '', title: '', content: 'Some content' }
      });
      await inst.onSubmit();
      expect(inst.data.formErrors.title).toBe('标题不能为空');
      expect(inst.data.submitting).toBe(false);
    });

    it('should validate title length', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'a'.repeat(101), content: 'Some content' }
      });
      await inst.onSubmit();
      expect(inst.data.formErrors.title).toBe('标题不能超过100个字');
    });

    it('should validate empty content', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'Title', content: '' }
      });
      await inst.onSubmit();
      expect(inst.data.formErrors.content).toBe('内容不能为空');
    });

    it('should validate content length', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'Title', content: 'a'.repeat(5001) }
      });
      await inst.onSubmit();
      expect(inst.data.formErrors.content).toBe('内容不能超过5000个字');
    });

    it('should prevent duplicate submit', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'Title', content: 'Content' }
      });
      inst.data.submitting = true;
      await inst.onSubmit();
      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    it('should add notice successfully', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'New Notice', content: 'Content here' },
        isEdit: false
      });
      inst.loadNotices = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onSubmit();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageNotice', data: expect.objectContaining({ action: 'add' }) })
      );
      expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('已添加');
      expect(inst.data.modalShow).toBe(false);
    });

    it('should update notice successfully', async () => {
      const inst = createInstance({
        form: { _id: '1', title: 'Updated', content: 'Updated content' },
        isEdit: true
      });
      inst.loadNotices = jest.fn();
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });

      await inst.onSubmit();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'manageNotice', data: expect.objectContaining({ action: 'update', noticeId: '1' }) })
      );
      expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('已更新');
    });

    it('should handle submit failure', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'Title', content: 'Content' },
        isEdit: false
      });
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, message: 'fail' } });

      await inst.onSubmit();

      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });

    it('should handle submit exception', async () => {
      const inst = createInstance({
        form: { _id: '', title: 'Title', content: 'Content' },
        isEdit: false
      });
      wx.cloud.callFunction.mockRejectedValue(new Error('network'));

      await inst.onSubmit();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(inst.data.submitting).toBe(false);
    });
  });

  describe('onModalClose', () => {
    it('should close modal', () => {
      const inst = createInstance({ modalShow: true });
      inst.onModalClose();
      expect(inst.data.modalShow).toBe(false);
    });
  });

  describe('stopPropagation', () => {
    it('should be a no-op function', () => {
      const inst = createInstance();
      expect(() => inst.stopPropagation()).not.toThrow();
    });
  });
});
