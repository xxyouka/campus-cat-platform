const {
  monitorApi,
  monitorPageLoad,
  monitorFunction,
  getPerformanceReport,
  clearPerformanceData,
  configure,
  printPerformanceReport
} = require('../../utils/performanceMonitor');

const { Logger } = require('../../utils/logger');

describe('performanceMonitor', () => {
  let loggerSpy;

  beforeEach(() => {
    clearPerformanceData();
    configure({
      enabled: true,
      sampleRate: 1.0,
      thresholds: { api: 1000, render: 100, load: 1500 }
    });
    loggerSpy = {
      log: jest.spyOn(Logger, 'log').mockImplementation(() => {}),
      warn: jest.spyOn(Logger, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(Logger, 'error').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    loggerSpy.log.mockRestore();
    loggerSpy.warn.mockRestore();
    loggerSpy.error.mockRestore();
  });

  describe('monitorApi', () => {
    test('should call fn and return result when enabled', async () => {
      const fn = jest.fn().mockResolvedValue('data');
      const result = await monitorApi('getCatList', fn);
      expect(result).toBe('data');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('should record apiCalls with success:true on success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('getCatList', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
      expect(report.apiStats.count).toBe(1);
    });

    test('should log via Logger.log when duration is within threshold', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('fastApi', fn);
      expect(loggerSpy.log).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('fastApi'),
        expect.objectContaining({ duration: expect.any(Number) })
      );
    });

    test('should log via Logger.warn when duration exceeds api threshold', async () => {
      const fn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1100));
        return 'slow';
      });
      await monitorApi('slowApi', fn);
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('slowApi'),
        expect.objectContaining({
          duration: expect.any(Number),
          threshold: 1000
        })
      );
    });

    test('should record apiCalls with success:false on error and re-throw', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('network'));
      await expect(monitorApi('failApi', fn)).rejects.toThrow('network');
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
      expect(report.summary.apiSuccessRate).toBe('0.00');
    });

    test('should log error via Logger.error on failure', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('timeout'));
      await expect(monitorApi('failApi', fn)).rejects.toThrow('timeout');
      expect(loggerSpy.error).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('failApi'),
        expect.any(Error)
      );
    });

    test('should skip monitoring when CONFIG.enabled is false', async () => {
      configure({ enabled: false });
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await monitorApi('skipApi', fn);
      expect(result).toBe('ok');
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(0);
    });

    test('should skip monitoring when random > sampleRate', async () => {
      configure({ sampleRate: 0 });
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await monitorApi('skipApi', fn);
      expect(result).toBe('ok');
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(0);
    });

    test('should still call fn even when monitoring is skipped', async () => {
      configure({ enabled: false });
      const fn = jest.fn().mockResolvedValue('data');
      await monitorApi('test', fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('monitorPageLoad', () => {
    test('should call fn and return result when enabled', async () => {
      const fn = jest.fn().mockResolvedValue('loaded');
      const result = await monitorPageLoad('index', fn);
      expect(result).toBe('loaded');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('should record pageLoads with success:true on success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorPageLoad('index', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.pageLoads).toBe(1);
      expect(report.pageStats.count).toBe(1);
    });

    test('should log via Logger.log when duration is within threshold', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorPageLoad('index', fn);
      expect(loggerSpy.log).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('index'),
        expect.objectContaining({ duration: expect.any(Number) })
      );
    });

    test('should log via Logger.warn when duration exceeds load threshold', async () => {
      const fn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1600));
        return 'slow';
      });
      await monitorPageLoad('slowPage', fn);
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('slowPage'),
        expect.objectContaining({
          duration: expect.any(Number),
          threshold: 1500
        })
      );
    });

    test('should record pageLoads with success:false on error and re-throw', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('crash'));
      await expect(monitorPageLoad('failPage', fn)).rejects.toThrow('crash');
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.pageLoads).toBe(1);
      expect(report.summary.pageSuccessRate).toBe('0.00');
    });

    test('should log error via Logger.error on failure', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('crash'));
      await expect(monitorPageLoad('failPage', fn)).rejects.toThrow('crash');
      expect(loggerSpy.error).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('failPage'),
        expect.any(Error)
      );
    });

    test('should skip monitoring when CONFIG.enabled is false', async () => {
      configure({ enabled: false });
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await monitorPageLoad('skipPage', fn);
      expect(result).toBe('ok');
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.pageLoads).toBe(0);
    });

    test('should still call fn even when monitoring is skipped', async () => {
      configure({ enabled: false });
      const fn = jest.fn().mockResolvedValue('data');
      await monitorPageLoad('test', fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('monitorFunction', () => {
    test('should call fn and return result when enabled', () => {
      const fn = jest.fn().mockReturnValue(42);
      const result = monitorFunction('calc', fn);
      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('should log via Logger.warn when duration exceeds render threshold', () => {
      const fn = jest.fn().mockImplementation(() => {
        const start = Date.now();
        while (Date.now() - start < 150) { /* ignore */ }
        return 'slow';
      });
      monitorFunction('slowOp', fn);
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('slowOp'),
        expect.objectContaining({
          duration: expect.any(Number),
          threshold: 100
        })
      );
    });

    test('should not warn when duration is within render threshold', () => {
      const fn = jest.fn().mockReturnValue('fast');
      monitorFunction('fastOp', fn);
      expect(loggerSpy.warn).not.toHaveBeenCalled();
    });

    test('should log error via Logger.error and re-throw on failure', () => {
      const fn = jest.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => monitorFunction('failOp', fn)).toThrow('boom');
      expect(loggerSpy.error).toHaveBeenCalledWith(
        'performance',
        expect.stringContaining('failOp'),
        expect.any(Error)
      );
    });

    test('should skip monitoring when CONFIG.enabled is false', () => {
      configure({ enabled: false });
      const fn = jest.fn().mockReturnValue('ok');
      const result = monitorFunction('skipOp', fn);
      expect(result).toBe('ok');
      expect(loggerSpy.warn).not.toHaveBeenCalled();
    });

    test('should still call fn even when monitoring is skipped', () => {
      configure({ enabled: false });
      const fn = jest.fn().mockReturnValue('data');
      monitorFunction('test', fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPerformanceReport', () => {
    test('should return empty report when no data', () => {
      const report = getPerformanceReport();
      expect(report.summary.apiCalls).toBe(0);
      expect(report.summary.pageLoads).toBe(0);
      expect(report.summary.apiSuccessRate).toBe(0);
      expect(report.summary.pageSuccessRate).toBe(0);
      expect(report.apiStats).toEqual({ count: 0, avg: 0, min: 0, max: 0, p95: 0 });
      expect(report.pageStats).toEqual({ count: 0, avg: 0, min: 0, max: 0, p95: 0 });
      expect(report.slowApis).toEqual([]);
      expect(report.slowPages).toEqual([]);
      expect(report.recommendations).toEqual([]);
    });

    test('should filter data by duration option', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('recent', fn);
      const report = getPerformanceReport({ duration: 0 });
      expect(report.summary.apiCalls).toBe(0);
    });

    test('should include data within duration window', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('recent', fn);
      const report = getPerformanceReport({ duration: 60000 });
      expect(report.summary.apiCalls).toBe(1);
    });

    test('should calculate apiStats correctly', async () => {
      const fastFn = jest.fn().mockResolvedValue('ok');
      await monitorApi('a', fastFn);
      await monitorApi('b', fastFn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.apiStats.count).toBe(2);
      expect(report.apiStats.avg).toBeGreaterThanOrEqual(0);
      expect(report.apiStats.min).toBeLessThanOrEqual(report.apiStats.max);
      expect(report.apiStats.p95).toBeGreaterThanOrEqual(0);
    });

    test('should calculate pageStats correctly', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorPageLoad('p1', fn);
      await monitorPageLoad('p2', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.pageStats.count).toBe(2);
      expect(report.pageStats.avg).toBeGreaterThanOrEqual(0);
    });

    test('should calculate success rate correctly', async () => {
      const okFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      await monitorApi('ok', okFn);
      await monitorApi('ok2', okFn);
      try { await monitorApi('fail', failFn); } catch (e) { /* ignore */ }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiSuccessRate).toBe('66.67');
    });

    test('should identify slowApis exceeding api threshold', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1100));
        return 'slow';
      });
      await monitorApi('slowOne', slowFn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.slowApis.length).toBe(1);
      expect(report.slowApis[0].name).toBe('slowOne');
    });

    test('should identify slowPages exceeding load threshold', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1600));
        return 'slow';
      });
      await monitorPageLoad('slowPage', slowFn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.slowPages.length).toBe(1);
      expect(report.slowPages[0].page).toBe('slowPage');
    });

    test('should limit slowApis to 10 entries', async () => {
      const originalNow = Date.now;
      let callCount = 0;
      Date.now = jest.fn(() => {
        callCount++;
        return 1000000 + callCount * 1100;
      });
      const fastFn = jest.fn().mockResolvedValue('ok');
      for (let i = 0; i < 12; i++) {
        await monitorApi(`slow${i}`, fastFn);
      }
      Date.now = originalNow;
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.slowApis.length).toBe(10);
    });

    test('should limit slowPages to 10 entries', async () => {
      const originalNow = Date.now;
      let callCount = 0;
      Date.now = jest.fn(() => {
        callCount++;
        return 1000000 + callCount * 1600;
      });
      const fastFn = jest.fn().mockResolvedValue('ok');
      for (let i = 0; i < 12; i++) {
        await monitorPageLoad(`slow${i}`, fastFn);
      }
      Date.now = originalNow;
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.slowPages.length).toBe(10);
    });

    test('should default duration to 5 minutes', () => {
      const report = getPerformanceReport();
      expect(report).toBeDefined();
    });
  });

  describe('calculateStats (via getPerformanceReport)', () => {
    test('should return zeros for empty data', () => {
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.apiStats).toEqual({ count: 0, avg: 0, min: 0, max: 0, p95: 0 });
    });

    test('should compute min, max, avg, p95 for single entry', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('single', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.apiStats.count).toBe(1);
      expect(report.apiStats.min).toBe(report.apiStats.max);
      expect(report.apiStats.avg).toBe(report.apiStats.min);
      expect(report.apiStats.p95).toBe(report.apiStats.min);
    });

    test('should compute correct stats for multiple entries', async () => {
      const durations = [50, 100, 150, 200, 300];
      for (const d of durations) {
        const fn = jest.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, d));
          return 'ok';
        });
        await monitorApi(`api${d}`, fn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.apiStats.count).toBe(5);
      expect(report.apiStats.min).toBeLessThanOrEqual(report.apiStats.max);
      expect(report.apiStats.avg).toBeGreaterThanOrEqual(0);
    });
  });

  describe('generateRecommendations (via getPerformanceReport)', () => {
    test('should recommend API optimization when avg exceeds api threshold', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1100));
        return 'slow';
      });
      for (let i = 0; i < 3; i++) {
        await monitorApi(`slow${i}`, slowFn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.recommendations).toEqual(
        expect.arrayContaining([expect.stringContaining('API')])
      );
    });

    test('should recommend page optimization when avg exceeds load threshold', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1600));
        return 'slow';
      });
      for (let i = 0; i < 3; i++) {
        await monitorPageLoad(`slow${i}`, slowFn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.recommendations).toEqual(
        expect.arrayContaining([expect.stringContaining('页面')])
      );
    });

    test('should recommend checking slow APIs when more than 5 slowApis', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1100));
        return 'slow';
      });
      for (let i = 0; i < 6; i++) {
        await monitorApi(`slow${i}`, slowFn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.recommendations).toEqual(
        expect.arrayContaining([expect.stringContaining('慢请求')])
      );
    });

    test('should recommend checking slow pages when more than 3 slowPages', async () => {
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 1600));
        return 'slow';
      });
      for (let i = 0; i < 4; i++) {
        await monitorPageLoad(`slow${i}`, slowFn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.recommendations).toEqual(
        expect.arrayContaining([expect.stringContaining('慢加载')])
      );
    });

    test('should return empty recommendations when everything is fast', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('fast', fn);
      await monitorPageLoad('fastPage', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.recommendations).toEqual([]);
    });
  });

  describe('clearPerformanceData', () => {
    test('should clear all performance data arrays', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      await monitorPageLoad('testPage', fn);
      clearPerformanceData();
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(0);
      expect(report.summary.pageLoads).toBe(0);
    });

    test('should allow fresh data after clearing', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('before', fn);
      clearPerformanceData();
      await monitorApi('after', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
    });
  });

  describe('configure', () => {
    test('should update CONFIG.enabled', async () => {
      configure({ enabled: false });
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(0);
    });

    test('should update CONFIG.sampleRate', async () => {
      configure({ sampleRate: 0 });
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(0);
    });

    test('should update CONFIG.thresholds', async () => {
      const originalNow = Date.now;
      let callCount = 0;
      Date.now = jest.fn(() => {
        callCount++;
        return callCount * 500;
      });
      configure({ thresholds: { api: 0, render: 0, load: 0 } });
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      Date.now = originalNow;
      expect(loggerSpy.warn).toHaveBeenCalled();
    });

    test('should merge options with existing CONFIG', () => {
      configure({ enabled: false });
      configure({ enabled: true });
      const fn = jest.fn().mockReturnValue('ok');
      const result = monitorFunction('test', fn);
      expect(result).toBe('ok');
    });

    test('should restore defaults after reconfigure', async () => {
      configure({ enabled: false, sampleRate: 0 });
      configure({ enabled: true, sampleRate: 1.0 });
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
    });
  });

  describe('printPerformanceReport', () => {
    test('should call getPerformanceReport without throwing', () => {
      expect(() => printPerformanceReport()).not.toThrow();
    });

    test('should reflect recorded data', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('printed', fn);
      expect(() => printPerformanceReport()).not.toThrow();
    });
  });

  describe('trimData (MAX_DATA_LENGTH=200)', () => {
    test('should keep only last 200 apiCalls entries', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      for (let i = 0; i < 210; i++) {
        await monitorApi(`api${i}`, fn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(200);
    });

    test('should keep only last 200 pageLoads entries', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      for (let i = 0; i < 210; i++) {
        await monitorPageLoad(`page${i}`, fn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.pageLoads).toBe(200);
    });

    test('should keep most recent entries after trim', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      for (let i = 0; i < 210; i++) {
        await monitorApi(`api${i}`, fn);
      }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.apiStats.count).toBe(200);
    });
  });

  describe('calculateSuccessRate', () => {
    test('should return 0 for empty data', () => {
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiSuccessRate).toBe(0);
    });

    test('should return 100.00 for all success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('ok1', fn);
      await monitorApi('ok2', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiSuccessRate).toBe('100.00');
    });

    test('should return 0.00 for all failures', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      try { await monitorApi('fail1', fn); } catch (e) { /* ignore */ }
      try { await monitorApi('fail2', fn); } catch (e) { /* ignore */ }
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiSuccessRate).toBe('0.00');
    });

    test('should calculate mixed success rate', async () => {
      const okFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      await monitorApi('ok', okFn);
      try { await monitorApi('fail', failFn); } catch (e) { /* ignore */ }
      await monitorApi('ok2', okFn);
      await monitorApi('ok3', okFn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiSuccessRate).toBe('75.00');
    });
  });

  describe('integration', () => {
    test('should track mixed api and page load data', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      await monitorApi('api1', fn);
      await monitorPageLoad('page1', fn);
      try { await monitorApi('api2', failFn); } catch (e) { /* ignore */ }
      await monitorPageLoad('page2', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(2);
      expect(report.summary.pageLoads).toBe(2);
      expect(report.summary.apiSuccessRate).toBe('50.00');
      expect(report.summary.pageSuccessRate).toBe('100.00');
    });

    test('should handle configure then monitor then report', async () => {
      configure({ thresholds: { api: 500, render: 50, load: 800 } });
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('test', fn);
      await monitorPageLoad('testPage', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
      expect(report.summary.pageLoads).toBe(1);
    });

    test('should handle clear then re-record', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await monitorApi('before', fn);
      clearPerformanceData();
      await monitorApi('after', fn);
      await monitorPageLoad('afterPage', fn);
      const report = getPerformanceReport({ duration: Infinity });
      expect(report.summary.apiCalls).toBe(1);
      expect(report.summary.pageLoads).toBe(1);
    });
  });
});
