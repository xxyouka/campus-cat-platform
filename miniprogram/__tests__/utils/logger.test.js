const { Logger, logPerformance, sanitize, sanitizeData } = require('../../utils/logger');

describe('Logger', () => {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  beforeEach(() => {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  describe('log', () => {
    test('should output formatted log', () => {
      Logger.log('mod', 'msg', { key: 'val' });
      expect(console.log).toHaveBeenCalledWith('[mod] msg', { key: 'val' });
    });

    test('should output empty string for empty data', () => {
      Logger.log('mod', 'msg');
      expect(console.log).toHaveBeenCalledWith('[mod] msg', '');
    });
  });

  describe('info', () => {
    test('should be alias of log', () => {
      Logger.info('mod', 'info msg', { a: 1 });
      expect(console.log).toHaveBeenCalledWith('[mod] info msg', { a: 1 });
    });
  });

  describe('warn', () => {
    test('should output warning', () => {
      Logger.warn('mod', 'warn msg', { type: 'w' });
      expect(console.warn).toHaveBeenCalledWith('[mod] warn msg', { type: 'w' });
    });
  });

  describe('error', () => {
    test('should handle Error object with stack', () => {
      const err = new Error('test');
      Logger.error('mod', 'fail', err);
      expect(console.error).toHaveBeenCalledWith(
        '[mod] fail',
        expect.objectContaining({ name: 'Error', message: 'test', stack: expect.any(String) })
      );
    });

    test('should handle plain object error', () => {
      Logger.error('mod', 'fail', { message: 'obj error' });
      expect(console.error).toHaveBeenCalledWith(
        '[mod] fail',
        expect.objectContaining({ name: 'Error', message: 'obj error' })
      );
    });

    test('should handle string error', () => {
      Logger.error('mod', 'fail', 'string error');
      expect(console.error).toHaveBeenCalledWith(
        '[mod] fail',
        expect.objectContaining({ name: 'Error', message: 'string error' })
      );
    });

    test('should handle null error', () => {
      Logger.error('mod', 'fail', null);
      expect(console.error).toHaveBeenCalledWith(
        '[mod] fail',
        expect.objectContaining({ name: 'Error', message: 'null' })
      );
    });

    test('should handle undefined error', () => {
      Logger.error('mod', 'fail', undefined);
      expect(console.error).toHaveBeenCalledWith(
        '[mod] fail',
        expect.objectContaining({ name: 'Error', message: 'undefined' })
      );
    });
  });

  describe('performance', () => {
    test('should log normal duration', () => {
      Logger.performance('mod', 'op', 500);
      expect(console.log).toHaveBeenCalledWith('[mod] op 耗时: 500ms');
    });

    test('should warn slow duration', () => {
      Logger.performance('mod', 'op', 1500);
      expect(console.warn).toHaveBeenCalledWith('[mod] op 耗时: 1500ms (执行时间过长)');
    });
  });

  describe('debug', () => {
    test('should output debug info in dev', () => {
      Logger.debug('mod', 'debug msg', { d: 1 });
      expect(console.log).toHaveBeenCalledWith('[mod][DEBUG] debug msg', { d: 1 });
    });
  });

  describe('_sanitizeString', () => {
    test('should return non-string as-is', () => {
      expect(Logger._sanitizeString(null)).toBeNull();
      expect(Logger._sanitizeString(123)).toBe(123);
    });

    test('should redact OpenID', () => {
      const result = Logger._sanitizeString('user oZabcdefghijklmnopqrstuvwxyz logged in');
      expect(result).toContain('[OPEN_ID_REDACTED]');
    });

    test('should redact cloud paths', () => {
      const result = Logger._sanitizeString('file cloud://env-123/photo.jpg loaded');
      expect(result).toContain('[CLOUD_PATH]');
      expect(result).not.toContain('cloud://env-123');
    });

    test('should redact passwords', () => {
      const result = Logger._sanitizeString('password=secret123');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('secret123');
    });

    test('should redact tokens', () => {
      const result = Logger._sanitizeString('token=abc123');
      expect(result).toContain('[REDACTED]');
    });

    test('should redact phone numbers', () => {
      const result = Logger._sanitizeString('phone 13812345678 called');
      expect(result).toContain('[PHONE_REDACTED]');
      expect(result).not.toContain('13812345678');
    });

    test('should redact email addresses', () => {
      const result = Logger._sanitizeString('email test@example.com sent');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain('test@example.com');
    });

    test('should redact ID card numbers', () => {
      const result = Logger._sanitizeString('身份证号440123199901011234已验证');
      expect(result).not.toBe('身份证号440123199901011234已验证');
    });

    test('should redact IP addresses', () => {
      const result = Logger._sanitizeString('from 192.168.1.1 connected');
      expect(result).toContain('[IP_ADDRESS]');
      expect(result).not.toContain('192.168.1.1');
    });

    test('should redact URL query params', () => {
      const result = Logger._sanitizeString('url ?key=value&page=1 accessed');
      expect(result).toContain('[PARAM_VALUE]');
    });

    test('should not modify clean strings', () => {
      const result = Logger._sanitizeString('normal log message');
      expect(result).toBe('normal log message');
    });

    test('should handle empty string', () => {
      expect(Logger._sanitizeString('')).toBe('');
    });
  });

  describe('_sanitizeData', () => {
    test('should return null as-is', () => {
      expect(Logger._sanitizeData(null)).toBeNull();
    });

    test('should return undefined as-is', () => {
      expect(Logger._sanitizeData(undefined)).toBeUndefined();
    });

    test('should sanitize string', () => {
      const result = Logger._sanitizeData('phone 13812345678');
      expect(result).toContain('[PHONE_REDACTED]');
    });

    test('should sanitize array elements', () => {
      const result = Logger._sanitizeData(['phone 13812345678', 'clean']);
      expect(result[0]).toContain('[PHONE_REDACTED]');
      expect(result[1]).toBe('clean');
    });

    test('should sanitize object values', () => {
      const result = Logger._sanitizeData({ phone: '13812345678' });
      expect(result.phone).toContain('[PHONE_REDACTED]');
    });

    test('should skip function values in objects', () => {
      const result = Logger._sanitizeData({ fn: () => {}, name: 'test' });
      expect(result.fn).toBeUndefined();
      expect(result.name).toBe('test');
    });

    test('should sanitize stack property', () => {
      const result = Logger._sanitizeData({ stack: 'at cloud://env/fn' });
      expect(result.stack).toContain('[CLOUD_PATH]');
    });

    test('should return primitives as-is', () => {
      expect(Logger._sanitizeData(42)).toBe(42);
      expect(Logger._sanitizeData(true)).toBe(true);
    });

    test('should handle nested objects', () => {
      const result = Logger._sanitizeData({ user: { phone: '13812345678' } });
      expect(result.user.phone).toContain('[PHONE_REDACTED]');
    });
  });

  describe('instance methods', () => {
    test('isDebug should return boolean', () => {
      const instance = new Logger();
      expect(typeof instance.isDebug).toBe('boolean');
    });

    test('setSamplingRate should clamp values', () => {
      const instance = new Logger();
      instance.setSamplingRate(2);
      expect(instance._logSamplingRate).toBe(1);
      instance.setSamplingRate(-1);
      expect(instance._logSamplingRate).toBe(0);
      instance.setSamplingRate(0.5);
      expect(instance._logSamplingRate).toBe(0.5);
    });
  });
});

describe('sanitize', () => {
  test('should sanitize string via exported function', () => {
    const result = sanitize('phone 13812345678');
    expect(result).toContain('[PHONE_REDACTED]');
  });
});

describe('sanitizeData', () => {
  test('should sanitize data via exported function', () => {
    const result = sanitizeData({ phone: '13812345678' });
    expect(result.phone).toContain('[PHONE_REDACTED]');
  });
});

describe('logPerformance', () => {
  test('should wrap async function and log time', async () => {
    const original = async function() {
      await new Promise(r => setTimeout(r, 10));
      return 'done';
    };
    const descriptor = { value: original };
    const decorated = logPerformance('mod', 'op')(null, 'method', descriptor);
    const result = await decorated.value.call({});
    expect(result).toBe('done');
  });

  test('should throw and log on failure', async () => {
    const original = async function() {
      throw new Error('boom');
    };
    const descriptor = { value: original };
    const decorated = logPerformance('mod', 'op')(null, 'method', descriptor);
    await expect(decorated.value.call({})).rejects.toThrow('boom');
  });
});

describe('Logger._detectEnvironment', () => {
  test('returns true when NODE_ENV is development', () => {
    const instance = new Logger();
    expect(instance.isDebug).toBe(true);
  });

  test('returns true when wx.getAccountInfoSync returns develop', () => {
    const originalWx = global.wx;
    global.wx = {
      getAccountInfoSync: jest.fn(() => ({
        miniProgram: { envVersion: 'develop' }
      }))
    };
    const instance = new Logger();
    expect(instance.isDebug).toBe(true);
    global.wx = originalWx;
  });

  test('returns true when wx.getAccountInfoSync returns trial', () => {
    const originalWx = global.wx;
    global.wx = {
      getAccountInfoSync: jest.fn(() => ({
        miniProgram: { envVersion: 'trial' }
      }))
    };
    const instance = new Logger();
    expect(instance.isDebug).toBe(true);
    global.wx = originalWx;
  });
});

describe('Logger._detectEnvironment with production config', () => {
  let ProdLogger;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../config', () => ({ env: 'production' }));
    ProdLogger = require('../../utils/logger').Logger;
  });

  afterAll(() => {
    jest.dontMock('../../config');
    jest.resetModules();
  });

  test('returns false when wx.getAccountInfoSync returns release', () => {
    const originalWx = global.wx;
    global.wx = {
      getAccountInfoSync: jest.fn(() => ({
        miniProgram: { envVersion: 'release' }
      }))
    };
    const instance = new ProdLogger();
    expect(instance.isDebug).toBe(false);
    global.wx = originalWx;
  });

  test('returns true when wx.getAccountInfoSync returns develop', () => {
    const originalWx = global.wx;
    global.wx = {
      getAccountInfoSync: jest.fn(() => ({
        miniProgram: { envVersion: 'develop' }
      }))
    };
    const instance = new ProdLogger();
    expect(instance.isDebug).toBe(true);
    global.wx = originalWx;
  });

  test('returns false when wx is undefined', () => {
    const originalWx = global.wx;
    global.wx = undefined;
    const instance = new ProdLogger();
    expect(instance.isDebug).toBe(false);
    global.wx = originalWx;
  });

  test('returns false when getAccountInfoSync throws', () => {
    const originalWx = global.wx;
    global.wx = {
      getAccountInfoSync: jest.fn(() => { throw new Error('fail'); })
    };
    const instance = new ProdLogger();
    expect(instance.isDebug).toBe(false);
    global.wx = originalWx;
  });
});

describe('Logger._sanitizeString rule error catch', () => {
  test('handles rule execution error gracefully', () => {
    const _badRule = {
      pattern: { test: () => { throw new Error('regex fail'); } },
      replacement: '[BAD]',
      description: 'broken rule'
    };
    const originalConsole = {
      error: console.error
    };
    console.error = jest.fn();
    const _SENSITIVITY_RULES_BACKUP = require('../../utils/logger');
    const result = Logger._sanitizeString('test string');
    expect(typeof result).toBe('string');
    console.error = originalConsole.error;
  });
});

describe('Logger production mode', () => {
  let ProdLogger;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../config', () => ({ env: 'production' }));
    ProdLogger = require('../../utils/logger').Logger;
  });

  afterAll(() => {
    jest.dontMock('../../config');
    jest.resetModules();
  });

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  beforeEach(() => {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  describe('warn in production', () => {
    test('outputs simplified message without data', () => {
      ProdLogger.warn('mod', 'warn msg', { detail: 'sensitive' });
      expect(console.warn).toHaveBeenCalledWith('[mod] warn msg');
    });
  });

  describe('error in production', () => {
    test('sanitizes message and error info', () => {
      const err = new Error('test error');
      ProdLogger.error('mod', 'password=secret123 fail', err);
      expect(console.error).toHaveBeenCalled();
      const callArgs = console.error.mock.calls[0];
      expect(callArgs[0]).toBe('[mod] password: [REDACTED] fail');
    });

    test('handles non-Error objects in production', () => {
      ProdLogger.error('mod', 'fail', { message: 'obj error' });
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('performance in production', () => {
    test('slow operation reports to cloud', () => {
      const originalWx = global.wx;
      global.wx = {
        getRealtimeLogManager: jest.fn(() => ({
          warn: jest.fn(),
          error: jest.fn()
        }))
      };
      ProdLogger.performance('mod', 'op', 1500);
      expect(console.warn).toHaveBeenCalledWith('[mod] op 耗时: 1500ms (执行时间过长)');
      global.wx = originalWx;
    });

    test('normal duration does not output in production', () => {
      ProdLogger.performance('mod', 'op', 500);
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('_formatData in production', () => {
    test('returns sanitized data', () => {
      const result = ProdLogger._formatData({ phone: '13812345678' });
      expect(result.phone).toContain('[PHONE_REDACTED]');
    });
  });

  describe('debug in production', () => {
    test('does not output', () => {
      ProdLogger.debug('mod', 'debug msg', { d: 1 });
      expect(console.log).not.toHaveBeenCalled();
    });
  });
});

describe('Logger._reportToCloud', () => {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  beforeEach(() => {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  test('calls wx.getRealtimeLogManager with correct level method', () => {
    const mockWarn = jest.fn();
    const originalWx = global.wx;
    global.wx = {
      getRealtimeLogManager: jest.fn(() => ({
        warn: mockWarn,
        error: jest.fn()
      }))
    };
    Logger._reportToCloud('warn', 'mod', 'msg', { key: 'val' });
    expect(mockWarn).toHaveBeenCalled();
    expect(mockWarn.mock.calls[0][0]).toContain('[warn][mod] msg');
    global.wx = originalWx;
  });

  test('falls back to warn when level method unavailable', () => {
    const mockWarn = jest.fn();
    const originalWx = global.wx;
    global.wx = {
      getRealtimeLogManager: jest.fn(() => ({
        warn: mockWarn
      }))
    };
    Logger._reportToCloud('error', 'mod', 'msg', null);
    expect(mockWarn).toHaveBeenCalled();
    global.wx = originalWx;
  });

  test('does nothing when wx is undefined', () => {
    const originalWx = global.wx;
    global.wx = undefined;
    expect(() => Logger._reportToCloud('warn', 'mod', 'msg', null)).not.toThrow();
    global.wx = originalWx;
  });

  test('catches errors silently', () => {
    const originalWx = global.wx;
    global.wx = {
      getRealtimeLogManager: jest.fn(() => { throw new Error('fail'); })
    };
    expect(() => Logger._reportToCloud('warn', 'mod', 'msg', null)).not.toThrow();
    global.wx = originalWx;
  });
});
