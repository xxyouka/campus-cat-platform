const ErrorHandler = require('../../utils/errorHandler');

describe('ErrorHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handle', () => {
    test('should handle Error object and show toast', () => {
      const error = new Error('test error');
      const result = ErrorHandler.handle(error);
      expect(result).toBeTruthy();
      expect(wx.showToast).toHaveBeenCalled();
    });

    test('should handle string error', () => {
      const result = ErrorHandler.handle('something went wrong');
      expect(result).toBeTruthy();
      expect(wx.showToast).toHaveBeenCalled();
    });

    test('should not show toast when show is false', () => {
      ErrorHandler.handle('error', { show: false });
      expect(wx.showToast).not.toHaveBeenCalled();
    });

    test('should not log when log is false', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      ErrorHandler.handle('error', { log: false });
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('should use custom duration', () => {
      ErrorHandler.handle('error', { duration: 3000 });
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 3000 })
      );
    });

    test('should handle null/undefined error', () => {
      const result = ErrorHandler.handle(null);
      expect(result).toBeTruthy();
    });

    test('should use title as fallback message', () => {
      const result = ErrorHandler.handle(null, { title: '自定义标题' });
      expect(result).toBeTruthy();
    });

    test('should use friendly message by default', () => {
      const error = new Error('timeout');
      const result = ErrorHandler.handle(error);
      expect(result).toContain('稍后');
    });

    test('should use raw message when friendly is false', () => {
      const result = ErrorHandler.handle('raw error msg', { friendly: false });
      expect(result).toBe('raw error msg');
    });
  });

  describe('try', () => {
    test('should return result on success', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await ErrorHandler.try(fn);
      expect(result).toBe('success');
    });

    test('should handle error on failure', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const result = await ErrorHandler.try(fn);
      expect(result).toBeTruthy();
      expect(wx.showToast).toHaveBeenCalled();
    });
  });

  describe('handleNetworkError', () => {
    test('should handle timeout error', () => {
      const error = { errMsg: 'request:fail timeout' };
      const result = ErrorHandler.handleNetworkError(error);
      expect(result).toContain('网络');
    });

    test('should handle connection fail error', () => {
      const error = { errMsg: 'request:fail' };
      const result = ErrorHandler.handleNetworkError(error);
      expect(result).toContain('网络');
    });

    test('should handle cloud function fail', () => {
      const error = { errMsg: 'cloud function request fail' };
      const result = ErrorHandler.handleNetworkError(error);
      expect(result).toContain('云函数');
    });

    test('should handle unknown error with fallback', () => {
      const error = { errMsg: 'something unknown' };
      const result = ErrorHandler.handleNetworkError(error);
      expect(result).toContain('重试');
    });

    test('should not show toast when show is false', () => {
      ErrorHandler.handleNetworkError({ errMsg: 'timeout' }, { show: false });
      expect(wx.showToast).not.toHaveBeenCalled();
    });
  });

  describe('handleCloudFunctionResult', () => {
    test('should return false for null result', () => {
      expect(ErrorHandler.handleCloudFunctionResult(null)).toBe(false);
    });

    test('should return false for result without result field', () => {
      expect(ErrorHandler.handleCloudFunctionResult({})).toBe(false);
    });

    test('should return false when success is false', () => {
      const result = ErrorHandler.handleCloudFunctionResult({
        result: { success: false, message: '操作失败' }
      });
      expect(result).toBe(false);
    });

    test('should return true when success is true', () => {
      const result = ErrorHandler.handleCloudFunctionResult({
        result: { success: true }
      });
      expect(result).toBe(true);
    });

    test('should not show toast when show is false', () => {
      ErrorHandler.handleCloudFunctionResult(null, { show: false });
      expect(wx.showToast).not.toHaveBeenCalled();
    });
  });

  describe('handleValidationError', () => {
    test('should combine field and message', () => {
      const result = ErrorHandler.handleValidationError('姓名', '不能为空');
      expect(result).toContain('姓名');
      expect(result).toContain('不能为空');
    });
  });

  describe('handleDatabaseError', () => {
    test('should handle permission denied', () => {
      const error = new Error('permission denied');
      const result = ErrorHandler.handleDatabaseError(error);
      expect(result).toContain('无权');
    });

    test('should handle collection not found', () => {
      const error = new Error('collection not found');
      const result = ErrorHandler.handleDatabaseError(error);
      expect(result).toContain('未找到');
    });

    test('should handle unknown database error', () => {
      const error = new Error('something else');
      const result = ErrorHandler.handleDatabaseError(error);
      expect(result).toContain('重试');
    });
  });

  describe('handleStorageError', () => {
    test('should handle file not found', () => {
      const error = new Error('no such file');
      const result = ErrorHandler.handleStorageError(error);
      expect(result).toContain('未找到');
    });

    test('should handle file size exceed', () => {
      const error = new Error('file size exceed limit');
      const result = ErrorHandler.handleStorageError(error);
      expect(result).toContain('超限');
    });

    test('should handle upload failed', () => {
      const error = new Error('upload failed');
      const result = ErrorHandler.handleStorageError(error);
      expect(result).toContain('上传');
    });

    test('should handle unknown storage error', () => {
      const error = new Error('unknown storage error');
      const result = ErrorHandler.handleStorageError(error);
      expect(result).toContain('重试');
    });
  });

  describe('showLoading / hideLoading', () => {
    test('should call wx.showLoading', () => {
      ErrorHandler.showLoading('加载中');
      expect(wx.showLoading).toHaveBeenCalledWith({ title: '加载中', mask: true });
    });

    test('should use default title', () => {
      ErrorHandler.showLoading();
      expect(wx.showLoading).toHaveBeenCalledWith({ title: '加载中…', mask: true });
    });

    test('should call wx.hideLoading', () => {
      ErrorHandler.hideLoading();
      expect(wx.hideLoading).toHaveBeenCalled();
    });
  });

  describe('toast', () => {
    test('should show toast with message', () => {
      ErrorHandler.toast('提示消息');
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '提示消息', icon: 'none' })
      );
    });

    test('should not log by default', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      ErrorHandler.toast('提示');
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('showSuccess', () => {
    test('should show success toast', () => {
      ErrorHandler.showSuccess('操作成功');
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '操作成功', icon: 'success' })
      );
    });
  });

  describe('showConfirm', () => {
    test('should return true when user confirms', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: true }));
      const result = await ErrorHandler.showConfirm('标题', '内容');
      expect(result).toBe(true);
    });

    test('should return false when user cancels', async () => {
      wx.showModal.mockImplementation(({ success }) => success({ confirm: false }));
      const result = await ErrorHandler.showConfirm('标题', '内容');
      expect(result).toBe(false);
    });

    test('should return false on fail', async () => {
      wx.showModal.mockImplementation(({ fail }) => fail());
      const result = await ErrorHandler.showConfirm('标题', '内容');
      expect(result).toBe(false);
    });
  });

  describe('getFriendlyMessage', () => {
    test('should return timeout message', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('timeout'))).toContain('稍后');
    });

    test('should return offline message for network error', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('network error'))).toContain('网络');
    });

    test('should return server error for 500', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('500 Internal'))).toContain('服务器');
    });

    test('should return permission denied', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('permission denied'))).toContain('权限');
    });

    test('隐私授权被拒必须单独映射，不得落进通用「您没有权限执行此操作」', () => {
      const msg = ErrorHandler.getFriendlyMessage(
        new Error('chooseMedia:fail privacy permission is not authorized')
      );
      expect(msg).toContain('隐私');
      expect(msg).not.toContain('您没有权限执行此操作');
    });

    test('should return login required', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('unauthorized'))).toContain('登录');
    });

    test('should return not found', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('not found'))).toContain('未找到');
    });

    test('should return cloud function message', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('cloud function error'))).toContain('服务');
    });

    test('should return original message as fallback', () => {
      expect(ErrorHandler.getFriendlyMessage(new Error('普通错误'))).toBe('普通错误');
    });

    test('should handle string error', () => {
      expect(ErrorHandler.getFriendlyMessage('timeout')).toContain('稍后');
    });
  });

  describe('handleWithScene', () => {
    test('should add scene prefix', () => {
      const result = ErrorHandler.handleWithScene(new Error('timeout'), 'loadData');
      expect(result).toContain('加载失败');
    });

    test('should not add prefix for unknown scene', () => {
      const result = ErrorHandler.handleWithScene(new Error('timeout'), 'unknownScene');
      expect(result).not.toContain('失败');
    });

    test('should not show toast when show is false', () => {
      ErrorHandler.handleWithScene(new Error('err'), 'loadData', { show: false });
      expect(wx.showToast).not.toHaveBeenCalled();
    });
  });

  describe('withRetry', () => {
    test('should return result on first try', async () => {
      const op = jest.fn().mockResolvedValue('ok');
      const result = await ErrorHandler.withRetry(op);
      expect(result).toBe('ok');
      expect(op).toHaveBeenCalledTimes(1);
    });

    test('should retry on failure and succeed', async () => {
      const op = jest.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('ok');
      const result = await ErrorHandler.withRetry(op, 3);
      expect(result).toBe('ok');
      expect(op).toHaveBeenCalledTimes(2);
    });

    test('should throw after max retries', async () => {
      const op = jest.fn().mockRejectedValue(new Error('always fail'));
      await expect(ErrorHandler.withRetry(op, 2)).rejects.toThrow('always fail');
      expect(op).toHaveBeenCalledTimes(2);
    });

    test('should not retry non-retryable errors', async () => {
      const op = jest.fn().mockRejectedValue(new Error('permission denied'));
      await expect(ErrorHandler.withRetry(op, 3)).rejects.toThrow('permission denied');
      expect(op).toHaveBeenCalledTimes(1);
    });

    test('should respect shouldRetry callback', async () => {
      const op = jest.fn().mockRejectedValue(new Error('fail'));
      const shouldRetry = jest.fn().mockReturnValue(false);
      await expect(ErrorHandler.withRetry(op, 3, shouldRetry)).rejects.toThrow('fail');
      expect(shouldRetry).toHaveBeenCalled();
    });
  });

  describe('monitorPerformance', () => {
    test('should return result and log time', async () => {
      const fn = jest.fn().mockResolvedValue('done');
      const result = await ErrorHandler.monitorPerformance('testOp', fn);
      expect(result).toBe('done');
    });

    test('should throw and log on failure', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(ErrorHandler.monitorPerformance('testOp', fn)).rejects.toThrow('boom');
    });
  });

  describe('handleGlobalError', () => {
    test('should handle timeout string error', () => {
      ErrorHandler.handleGlobalError('request timeout');
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('稍后') })
      );
    });

    test('should handle network string error', () => {
      ErrorHandler.handleGlobalError('network error');
      expect(wx.showToast).toHaveBeenCalled();
    });

    test('should show default message for unknown error', () => {
      ErrorHandler.handleGlobalError('something weird');
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '程序出现异常' })
      );
    });
  });

  describe('handleUnhandledRejection', () => {
    test('should log the reason', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      ErrorHandler.handleUnhandledRejection({ reason: 'test reason' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('initGlobalErrorCatch', () => {
    test('should not throw', () => {
      expect(() => ErrorHandler.initGlobalErrorCatch({})).not.toThrow();
    });
  });

  describe('callCloudFunction', () => {
    test('should call wx.cloud.callFunction', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      const _result = await ErrorHandler.callCloudFunction('testFn', { a: 1 });
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'testFn', data: { a: 1 } })
      );
    });
  });

  describe('ERROR_LEVELS', () => {
    test('should have correct error levels', () => {
      expect(ErrorHandler.ERROR_LEVELS.FATAL).toBe('fatal');
      expect(ErrorHandler.ERROR_LEVELS.ERROR).toBe('error');
      expect(ErrorHandler.ERROR_LEVELS.WARN).toBe('warn');
      expect(ErrorHandler.ERROR_LEVELS.INFO).toBe('info');
    });
  });

  describe('USER_FRIENDLY_MESSAGES', () => {
    test('should have network messages', () => {
      expect(ErrorHandler.USER_FRIENDLY_MESSAGES.network.timeout).toBeTruthy();
      expect(ErrorHandler.USER_FRIENDLY_MESSAGES.network.offline).toBeTruthy();
    });

    test('should have data messages', () => {
      expect(ErrorHandler.USER_FRIENDLY_MESSAGES.data.notFound).toBeTruthy();
    });

    test('should have permission messages', () => {
      expect(ErrorHandler.USER_FRIENDLY_MESSAGES.permission.denied).toBeTruthy();
    });
  });
});
