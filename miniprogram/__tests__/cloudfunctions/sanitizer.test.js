const sanitizer = require('../../cloudfunctions/utils/sanitizer');

describe('Sanitizer.escape', () => {
  test('转义HTML实体', () => {
    expect(sanitizer.escape('&')).toBe('&amp;');
    expect(sanitizer.escape('<')).toBe('&lt;');
    expect(sanitizer.escape('>')).toBe('&gt;');
    expect(sanitizer.escape('"')).toBe('&quot;');
    expect(sanitizer.escape("'")).toBe('&#x27;');
  });

  test('截断超长字符串', () => {
    const longStr = 'a'.repeat(600);
    const result = sanitizer.escape(longStr);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  test('自定义maxLength截断', () => {
    const str = 'a'.repeat(100);
    const result = sanitizer.escape(str, { maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
  });

  test('去除首尾空格', () => {
    expect(sanitizer.escape('  hello  ')).toBe('hello');
  });

  test('非字符串原样返回', () => {
    expect(sanitizer.escape(123)).toBe(123);
    expect(sanitizer.escape(null)).toBe(null);
    expect(sanitizer.escape(undefined)).toBe(undefined);
  });
});

describe('Sanitizer.sanitize', () => {
  test('移除HTML标签', () => {
    expect(sanitizer.sanitize('hello <b>bold</b> world')).toBe('hello bold world');
  });

  test('移除javascript:协议', () => {
    expect(sanitizer.sanitize('点击javascript:alert(1)链接')).toBe('点击alert(1)链接');
  });

  test('移除事件处理器', () => {
    const result = sanitizer.sanitize('这是一段很长的正常文字内容用来稀释 onerror=alert(1) 事件的过滤比例测试');
    expect(result).not.toContain('onerror');
  });

  test('移除控制字符', () => {
    const result = sanitizer.sanitize('hello\x00world\x01test');
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
  });

  test('清洗后为空返回空字符串', () => {
    expect(sanitizer.sanitize('   ')).toBe('');
    expect(sanitizer.sanitize('<><><>')).toBe('');
  });

  test('过滤率过高返回空字符串', () => {
    const malicious = '<script>onerror=javascript:alert(1)</script>';
    const result = sanitizer.sanitize(malicious, { fieldName: 'test' });
    expect(result).toBe('');
  });

  test('非字符串原样返回', () => {
    expect(sanitizer.sanitize(123)).toBe(123);
    expect(sanitizer.sanitize(null)).toBe(null);
  });

  test('正常文本保留', () => {
    expect(sanitizer.sanitize('橘猫小黑')).toBe('橘猫小黑');
    expect(sanitizer.sanitize('hello world')).toBe('hello world');
  });
});

describe('Sanitizer.strict', () => {
  test('仅保留安全字符', () => {
    expect(sanitizer.strict('hello世界123')).toBe('hello世界123');
  });

  test('移除危险字符', () => {
    const result = sanitizer.strict('<script>alert(1)</script>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  test('截断到maxLength', () => {
    const str = 'a'.repeat(100);
    const result = sanitizer.strict(str, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  test('非字符串返回空字符串', () => {
    expect(sanitizer.strict(123)).toBe('');
    expect(sanitizer.strict(null)).toBe('');
    expect(sanitizer.strict(undefined)).toBe('');
  });
});

describe('Sanitizer.sanitizeObject', () => {
  test('清洗对象中所有字符串字段', () => {
    const obj = {
      name: '正常名字 <b>带标签</b>',
      age: 25,
      active: true
    };
    const result = sanitizer.sanitizeObject(obj);
    expect(result.name).not.toContain('<b>');
    expect(result.name).toContain('正常名字');
    expect(result.age).toBe(25);
    expect(result.active).toBe(true);
  });

  test('处理嵌套对象', () => {
    const obj = {
      user: {
        bio: '简介 <b>hello</b> 内容'
      }
    };
    const result = sanitizer.sanitizeObject(obj);
    expect(result.user.bio).not.toContain('<b>');
    expect(result.user.bio).toContain('简介');
  });

  test('处理数组字段', () => {
    const obj = {
      tags: ['标签 <em>1</em>', 'safe']
    };
    const result = sanitizer.sanitizeObject(obj);
    expect(result.tags[0]).not.toContain('<em>');
    expect(result.tags[1]).toBe('safe');
  });

  test('空值或非对象原样返回', () => {
    expect(sanitizer.sanitizeObject(null)).toBe(null);
    expect(sanitizer.sanitizeObject(undefined)).toBe(undefined);
    expect(sanitizer.sanitizeObject('string')).toBe('string');
  });
});

describe('Sanitizer.isValidObjectId', () => {
  test('有效的十六进制ID返回true', () => {
    expect(sanitizer.isValidObjectId('abcdef1234567890abcdef12')).toBe(true);
    expect(sanitizer.isValidObjectId('a'.repeat(20))).toBe(true);
    expect(sanitizer.isValidObjectId('a'.repeat(40))).toBe(true);
  });

  test('无效ID返回false', () => {
    expect(sanitizer.isValidObjectId('short')).toBe(false);
    expect(sanitizer.isValidObjectId('g'.repeat(24))).toBe(false);
    expect(sanitizer.isValidObjectId('a'.repeat(19))).toBe(false);
    expect(sanitizer.isValidObjectId('a'.repeat(41))).toBe(false);
    expect(sanitizer.isValidObjectId('')).toBe(false);
    expect(sanitizer.isValidObjectId(null)).toBe(false);
    expect(sanitizer.isValidObjectId(123)).toBe(false);
  });
});

describe('Sanitizer.validateUrl', () => {
  test('空值返回URL不能为空', () => {
    expect(sanitizer.validateUrl(null)).toEqual({ isValid: false, url: '', error: 'URL不能为空' });
    expect(sanitizer.validateUrl(undefined)).toEqual({ isValid: false, url: '', error: 'URL不能为空' });
    expect(sanitizer.validateUrl('')).toEqual({ isValid: false, url: '', error: 'URL不能为空' });
    expect(sanitizer.validateUrl(123)).toEqual({ isValid: false, url: '', error: 'URL不能为空' });
  });

  test('有效https URL通过验证', () => {
    const result = sanitizer.validateUrl('https://example.com/photo.jpg');
    expect(result).toEqual({ isValid: true, url: 'https://example.com/photo.jpg' });
  });

  test('cloud:// URL通过验证', () => {
    const result = sanitizer.validateUrl('cloud://env-123.photos/cat.jpg');
    expect(result.isValid).toBe(true);
    expect(result.url).toBe('cloud://env-123.photos/cat.jpg');
  });

  test('URL前后空格被trim', () => {
    const result = sanitizer.validateUrl('  https://example.com  ');
    expect(result).toEqual({ isValid: true, url: 'https://example.com' });
  });

  test('无效URL格式返回错误', () => {
    const result = sanitizer.validateUrl('not-a-valid-url');
    expect(result).toEqual({ isValid: false, url: '', error: '无效的URL格式' });
  });

  test('不允许的http协议返回错误', () => {
    const result = sanitizer.validateUrl('http://example.com');
    expect(result).toEqual({ isValid: false, url: '', error: '不允许的URL协议' });
  });

  test('不允许的ftp协议返回错误', () => {
    const result = sanitizer.validateUrl('ftp://files.example.com');
    expect(result).toEqual({ isValid: false, url: '', error: '不允许的URL协议' });
  });

  test('javascript:协议不在白名单被拒绝', () => {
    const result = sanitizer.validateUrl('javascript:alert(1)');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('不允许的URL协议');
  });

  test('data:协议不在白名单被拒绝', () => {
    const result = sanitizer.validateUrl('data:text/html,<script>alert(1)</script>');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('不允许的URL协议');
  });

  test('vbscript:协议不在白名单被拒绝', () => {
    const result = sanitizer.validateUrl('vbscript:MsgBox("x")');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('不允许的URL协议');
  });

  test('https URL包含javascript:危险内容被检测', () => {
    const result = sanitizer.validateUrl('https://example.com/page?redirect=javascript:alert(1)');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('检测到危险的URL内容');
  });

  test('https URL包含data:text/html危险内容被检测', () => {
    const result = sanitizer.validateUrl('https://example.com/src=data:text/html,evil');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('检测到危险的URL内容');
  });

  test('https URL包含vbscript:危险内容被检测', () => {
    const result = sanitizer.validateUrl('https://example.com/vbscript:MsgBox');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('检测到危险的URL内容');
  });
});

describe('Sanitizer.sanitize allowNewlines=false', () => {
  test('allowNewlines=false移除换行符', () => {
    const result = sanitizer.sanitize('hello\nworld\r\ntest', { allowNewlines: false });
    expect(result).toBe('helloworldtest');
  });

  test('allowNewlines=true保留换行符', () => {
    const result = sanitizer.sanitize('hello\nworld', { allowNewlines: true });
    expect(result).toBe('hello\nworld');
  });
});

describe('Sanitizer.sanitize fullwidth character conversion', () => {
  test('全角字母转换为半角', () => {
    const result = sanitizer.sanitize('ＡＢＣ123');
    expect(result).toBe('ABC123');
  });

  test('全角数字转换为半角', () => {
    const result = sanitizer.sanitize('１２３');
    expect(result).toBe('123');
  });

  test('全角符号转换为半角', () => {
    const result = sanitizer.sanitize('！？');
    expect(result).toBe('!?');
  });
});

describe('Sanitizer.sanitize expression/url/@import/behavior removal', () => {
  test('移除expression()', () => {
    const result = sanitizer.sanitize('style expression(alert(1)) end');
    expect(result).not.toContain('expression');
  });

  test('移除url(javascript:)', () => {
    const result = sanitizer.sanitize('background url("javascript:alert(1)") end');
    expect(result).not.toContain('javascript');
  });

  test('移除@import', () => {
    const result = sanitizer.sanitize('css @import url(evil) end');
    expect(result).not.toContain('@import');
  });

  test('移除behavior:url', () => {
    const result = sanitizer.sanitize('style behavior:url(evil) end');
    expect(result).not.toContain('behavior');
  });
});

describe('Sanitizer.escape trimSpaces=false', () => {
  test('trimSpaces=false保留首尾空格', () => {
    const result = sanitizer.escape('  hello  ', { trimSpaces: false });
    expect(result).toBe('  hello  ');
  });

  test('trimSpaces=true默认去除首尾空格', () => {
    const result = sanitizer.escape('  hello  ', { trimSpaces: true });
    expect(result).toBe('hello');
  });
});

describe('Sanitizer.sanitizeObject with fieldRules', () => {
  test('fieldRules传递maxLength到sanitize', () => {
    const obj = { name: 'a'.repeat(100), bio: 'normal text' };
    const result = sanitizer.sanitizeObject(obj, {
      name: { maxLength: 50 }
    });
    expect(result.name.length).toBeLessThanOrEqual(50);
    expect(result.bio).toBe('normal text');
  });

  test('fieldRules传递allowNewlines到sanitize', () => {
    const obj = { bio: 'line1\nline2' };
    const result = sanitizer.sanitizeObject(obj, {
      bio: { allowNewlines: false }
    });
    expect(result.bio).not.toContain('\n');
  });

  test('fieldRules中nested规则传递到嵌套对象', () => {
    const obj = {
      profile: { intro: 'hello <b>world</b>' }
    };
    const result = sanitizer.sanitizeObject(obj, {
      profile: { nested: {} }
    });
    expect(result.profile.intro).not.toContain('<b>');
  });
});
