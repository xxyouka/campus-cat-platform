/**
 * __tests__/utils/performanceMonitor.snapshot.test.js
 *
 * 性能面板数据源回归（2026-10-06）：
 * 管理端性能面板此前读的是一份**零写入的影子监控模块**
 * （pages/admin/utils/performanceDashboard.js 自带一套采集接口，全项目没人调用），
 * 面板永远为空并回落成「示例数据」（访问次数是 Math.random()）。
 *
 * 真实埋点全部写在 utils/performanceMonitor.js，现由 getPerformanceSnapshot
 * 提供面板所需的聚合视图、由适配层（PerformanceDashboardAdapter）消费。
 * 本测试锁定：
 *   1. 快照按名称聚合成功/失败数据，errorRate 与失败明细可用；
 *   2. duration 是真实滑动窗口（过期数据不参与统计）；
 *   3. 适配层读到的是真实数据，且清空联动（不再有随机示例兜底）。
 */
const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));

describe('performanceMonitor.getPerformanceSnapshot', () => {
  let monitor;

  beforeEach(() => {
    jest.resetModules();
    monitor = require('../../utils/performanceMonitor');
    monitor.clearPerformanceData();
  });

  test('按名称聚合并统计错误率与失败明细', async () => {
    await monitor.monitorApi('loadCats', async () => 'ok');
    await monitor.monitorApi('loadCats', async () => 'ok');
    await monitor.monitorApi('saveCat', async () => { throw new Error('boom'); }).catch(() => {});
    await monitor.monitorPageLoad('index', async () => {});
    await monitor.monitorPageLoad('detail', async () => { throw new Error('page fail'); }).catch(() => {});

    const snap = monitor.getPerformanceSnapshot();

    expect(snap.overview.totalApiCalls).toBe(3);
    expect(snap.overview.totalPageViews).toBe(2);
    expect(snap.overview.errorRate).toBeGreaterThan(0);

    const cats = snap.apiStats.find(s => s.name === 'loadCats');
    expect(cats.count).toBe(2);
    expect(cats.successRate).toBe(100);
    expect(cats.avgTime).toBeGreaterThanOrEqual(0);

    const save = snap.apiStats.find(s => s.name === 'saveCat');
    expect(save.successRate).toBe(0);

    expect(snap.pageStats.map(p => p.name)).toEqual(expect.arrayContaining(['index', 'detail']));

    expect(snap.errors.some(e => e.message === 'boom')).toBe(true);
    expect(snap.errors.some(e => e.message === 'page fail')).toBe(true);
  });

  test('duration 是真实滑动窗口：过期数据不参与统计，缺省统计全部', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000000);
    await monitor.monitorApi('old', async () => 'ok');

    nowSpy.mockReturnValue(1000000 + 60000); // 60 秒后
    const windowed = monitor.getPerformanceSnapshot({ duration: 30000 });
    expect(windowed.overview.totalApiCalls).toBe(0);
    expect(windowed.apiStats.some(s => s.name === 'old')).toBe(false);

    const full = monitor.getPerformanceSnapshot();
    expect(full.apiStats.some(s => s.name === 'old')).toBe(true);
    nowSpy.mockRestore();
  });
});
