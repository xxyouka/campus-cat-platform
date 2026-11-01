const Validator = require('../../utils/validator');

describe('Validator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeKeyword', () => {
    test('should return empty for null/undefined/empty/non-string', () => {
      expect(Validator.sanitizeKeyword(null)).toBe('');
      expect(Validator.sanitizeKeyword(undefined)).toBe('');
      expect(Validator.sanitizeKeyword('')).toBe('');
      expect(Validator.sanitizeKeyword(123)).toBe('');
      expect(Validator.sanitizeKeyword({})).toBe('');
    });

    test('should remove HTML tags', () => {
      expect(Validator.sanitizeKeyword('<script>alert(1)</script>')).toBe('alert(1)');
    });

    test('should remove javascript: protocol', () => {
      expect(Validator.sanitizeKeyword('javascript:alert(1)')).toBe('alert(1)');
    });

    test('should remove event handlers', () => {
      expect(Validator.sanitizeKeyword('img onerror=alert(1)')).toBe('img alert(1)');
    });

    test('should remove CSS expression', () => {
      const result = Validator.sanitizeKeyword('style expression(x)');
      expect(result).not.toContain('expression');
    });

    test('should remove special characters', () => {
      expect(Validator.sanitizeKeyword('test<>"\'&\\')).toBe('test');
    });

    test('should truncate over 50 chars', () => {
      const longStr = 'a'.repeat(100);
      expect(Validator.sanitizeKeyword(longStr).length).toBe(50);
    });

    test('should trim whitespace', () => {
      expect(Validator.sanitizeKeyword('  hello  ')).toBe('hello');
    });

    test('should preserve Chinese and English', () => {
      expect(Validator.sanitizeKeyword('橘猫小黑')).toBe('橘猫小黑');
      expect(Validator.sanitizeKeyword('hello world')).toBe('hello world');
    });
  });

  describe('validatePagination', () => {
    test('should return defaults for undefined', () => {
      const result = Validator.validatePagination(undefined, undefined);
      expect(result.page).toBe(0);
      expect(result.pageSize).toBe(20);
    });

    test('should cap pageSize at 100', () => {
      expect(Validator.validatePagination(0, 200).pageSize).toBe(100);
    });

    test('should floor pageSize at 1', () => {
      expect(Validator.validatePagination(0, -5).pageSize).toBe(1);
    });

    test('should return valid values as-is', () => {
      expect(Validator.validatePagination(2, 50)).toEqual({ page: 2, pageSize: 50 });
    });

    test('should floor negative page at 0', () => {
      expect(Validator.validatePagination(-5, 10).page).toBe(0);
    });

    test('should parse string numbers', () => {
      expect(Validator.validatePagination('3', '30')).toEqual({ page: 3, pageSize: 30 });
    });
  });

  describe('isAllowedImageType', () => {
    test('should allow valid image types', () => {
      expect(Validator.isAllowedImageType('photo.jpg')).toBe(true);
      expect(Validator.isAllowedImageType('photo.jpeg')).toBe(true);
      expect(Validator.isAllowedImageType('photo.png')).toBe(true);
      expect(Validator.isAllowedImageType('photo.gif')).toBe(true);
      expect(Validator.isAllowedImageType('photo.webp')).toBe(true);
    });

    test('should reject non-image types', () => {
      expect(Validator.isAllowedImageType('file.exe')).toBe(false);
      expect(Validator.isAllowedImageType('file.svg')).toBe(false);
      expect(Validator.isAllowedImageType('script.js')).toBe(false);
    });

    test('should return false for null/undefined/no-extension', () => {
      expect(Validator.isAllowedImageType(null)).toBe(false);
      expect(Validator.isAllowedImageType(undefined)).toBe(false);
      expect(Validator.isAllowedImageType('noextension')).toBe(false);
    });
  });

  describe('validateCatId', () => {
    test('should reject empty id', () => {
      expect(Validator.validateCatId('', { autoBack: false })).toBe(false);
      expect(Validator.validateCatId(null, { autoBack: false })).toBe(false);
    });

    test('should reject invalid format', () => {
      expect(Validator.validateCatId('invalid-id', { autoBack: false })).toBe(false);
    });

    test('should accept valid hex id', () => {
      expect(Validator.validateCatId('a1b2c3d4e5f6a7b8c9d0e1f2', { autoBack: false })).toBe(true);
    });

    test('should show toast and navigate back on failure with autoBack', () => {
      // 用假定时器避免遗留真实定时器跨用例触发（1.5s 后补一刀 navigateBack）
      jest.useFakeTimers();
      Validator.validateCatId('');
      expect(wx.showToast).toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('should not navigate back when autoBack is false', () => {
      jest.useFakeTimers();
      Validator.validateCatId('', { autoBack: false });
      jest.advanceTimersByTime(2000);
      expect(wx.navigateBack).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('autoBack 到点且页面未切换时才返回上一页', () => {
      jest.useFakeTimers();
      getCurrentPages.mockReturnValue([{ route: 'pages/detail/detail' }]);
      Validator.validateCatId('');
      jest.advanceTimersByTime(2000);
      expect(wx.navigateBack).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    test('autoBack 到点但用户已手动离开：不补退一层', () => {
      jest.useFakeTimers();
      getCurrentPages.mockReturnValue([{ route: 'pages/detail/detail' }]);
      Validator.validateCatId('');
      // 用户 1.5s 内自己返回了
      getCurrentPages.mockReturnValue([{ route: 'pages/index/index' }]);
      jest.advanceTimersByTime(2000);
      expect(wx.navigateBack).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('validateTextLength', () => {
    test('should return true for empty text', () => {
      expect(Validator.validateTextLength('', 100)).toBe(true);
      expect(Validator.validateTextLength(null, 100)).toBe(true);
    });

    test('should return true for text within limit', () => {
      expect(Validator.validateTextLength('hello', 10)).toBe(true);
    });

    test('should return false for text exceeding limit', () => {
      expect(Validator.validateTextLength('a'.repeat(11), 10)).toBe(false);
      expect(wx.showToast).toHaveBeenCalled();
    });

    test('should use custom field name in message', () => {
      Validator.validateTextLength('a'.repeat(11), 10, '描述');
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('描述') })
      );
    });
  });

  describe('validate', () => {
    test('required rule - reject empty values', () => {
      const rules = [{ required: true, message: '此项为必填项' }];
      expect(Validator.validate('', rules).valid).toBe(false);
      expect(Validator.validate(null, rules).valid).toBe(false);
      expect(Validator.validate(undefined, rules).valid).toBe(false);
    });

    test('required rule - pass valid values', () => {
      const rules = [{ required: true }];
      expect(Validator.validate('hello', rules).valid).toBe(true);
      expect(Validator.validate(0, rules).valid).toBe(true);
    });

    test('type rule - string', () => {
      const rules = [{ type: 'string' }];
      expect(Validator.validate('hello', rules).valid).toBe(true);
      expect(Validator.validate(123, rules).valid).toBe(false);
    });

    test('type rule - number', () => {
      const rules = [{ type: 'number' }];
      expect(Validator.validate(123, rules).valid).toBe(true);
      expect(Validator.validate('hello', rules).valid).toBe(false);
    });

    test('type rule - array', () => {
      const rules = [{ type: 'array' }];
      expect(Validator.validate([1, 2, 3], rules).valid).toBe(true);
      expect(Validator.validate('not array', rules).valid).toBe(false);
    });

    test('maxLength rule', () => {
      const rules = [{ maxLength: 5, message: '不能超过5个字符' }];
      expect(Validator.validate('hello', rules).valid).toBe(true);
      expect(Validator.validate('hello world', rules).valid).toBe(false);
    });

    test('min rule', () => {
      const rules = [{ min: 0 }];
      expect(Validator.validate(0, rules).valid).toBe(true);
      expect(Validator.validate(-1, rules).valid).toBe(false);
    });

    test('max rule', () => {
      const rules = [{ max: 100 }];
      expect(Validator.validate(99, rules).valid).toBe(true);
      expect(Validator.validate(101, rules).valid).toBe(false);
    });

    test('pattern rule', () => {
      const rules = [{ pattern: /^[a-z]+$/, message: '格式不正确' }];
      expect(Validator.validate('abc', rules).valid).toBe(true);
      expect(Validator.validate('ABC', rules).valid).toBe(false);
    });

    test('combined rules', () => {
      const rules = [
        { required: true },
        { type: 'string' },
        { maxLength: 10 }
      ];
      expect(Validator.validate('', rules).valid).toBe(false);
      expect(Validator.validate(123, rules).valid).toBe(false);
      expect(Validator.validate('a'.repeat(11), rules).valid).toBe(false);
      expect(Validator.validate('valid', rules).valid).toBe(true);
    });

    test('should return custom messages', () => {
      const rules = [{ required: true, message: '名字必填' }];
      expect(Validator.validate('', rules).message).toBe('名字必填');
    });

    test('should return default messages when not specified', () => {
      const rules = [{ required: true }];
      expect(Validator.validate('', rules).message).toBe('此项为必填项');
    });

    test('type check should skip null/undefined values', () => {
      const rules = [{ type: 'string' }];
      expect(Validator.validate(null, rules).valid).toBe(true);
      expect(Validator.validate(undefined, rules).valid).toBe(true);
    });
  });
});
