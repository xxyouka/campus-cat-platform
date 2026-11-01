/**
 * utils/startupTrace —— 启动埋点
 *
 * 这套埋点的价值全在「数字准」：埋错了比没有埋更糟（会让人照着错的方向优化）。
 * 所以这里重点锁三件事：
 *   1. 基础库不支持 wx.getPerformance 时必须全程静默，绝不能成为启动路径上的故障源
 *   2. mark 只能记第一次（重复调用的 onReady/返回页面不能污染数据）
 *   3. finishFirstRender 必须走 nextTick —— 直接打点量到的是「数据提交」不是「用户看见」
 */
const trace = require('../../utils/startupTrace');

let mockPerf;
let hasGetPerformance;

function setup () {
  jest.resetModules();
  hasGetPerformance = true;
  mockPerf = {
    marks: [],
    entries: [],
    mark (name) { this.marks.push(name); },
    getEntries () { return this.entries; }
  };
  global.wx = Object.assign({}, global.wx, {
    getPerformance: () => hasGetPerformance ? mockPerf : undefined,
    nextTick: (fn) => fn(),
    showModal: jest.fn(),
    showToast: jest.fn()
  });
}

describe('startupTrace', () => {
  beforeEach(setup);

  test('init 打上基准点，且重复调用不重复打', () => {
    trace.init();
    trace.init();
    expect(mockPerf.marks.filter(m => m === 'launch_start')).toHaveLength(1);
  });

  test('mark 记录相对基准点的毫秒数', () => {
    trace.init();
    trace.mark('cloud-ready');
    const r = trace.report();
    expect(r.marks).toHaveProperty('cloud-ready');
    expect(typeof r.relative['cloud-ready']).toBe('number');
    expect(r.relative['cloud-ready']).toBeGreaterThanOrEqual(0);
  });

  test('基础库不支持 getPerformance 时全程不抛（埋点不能成为故障源）', () => {
    hasGetPerformance = false;
    expect(() => trace.init()).not.toThrow();
    expect(() => trace.mark('x')).not.toThrow();
    expect(() => trace.markRoute('index')).not.toThrow();
    expect(() => trace.finishFirstRender('index')).not.toThrow();
    // 降级后 marks 为空对象，report 仍要能返回结构
    const r = trace.report();
    expect(r).toHaveProperty('marks');
    expect(r).toHaveProperty('official');
  });

  /**
   * 降级期**也要出数字**，不能出空白。
   *
   * 这里曾有个真实 bug：基准点只在 wx.getPerformance 存在时才记，于是老基础库上
   * 整份报告全空 —— 而「是不是基础库太老导致的」恰恰要靠这份数据判断，
   * 空白等于把排查线索一起扔了。
   */
  test('不支持 getPerformance 时仍有相对耗时可用（Date.now 兜底）', () => {
    hasGetPerformance = false;
    trace.init();
    trace.mark('cloud-ready');
    const r = trace.report();
    expect(r.relative).toHaveProperty('cloud-ready');
    expect(typeof r.relative['cloud-ready']).toBe('number');
    expect(r.relative['cloud-ready']).toBeGreaterThanOrEqual(0);
    // 官方条目为空，但不应影响自有数据
    expect(r.official).toBeNull();
  });

  test('忘记调 init 也不丢打点（mark 内部自愈）', () => {
    hasGetPerformance = false;
    trace.mark('orphan');
    expect(trace.report().marks).toHaveProperty('orphan');
  });

  test('finishFirstRender 走 wx.nextTick（否则量到的是提交而非渲染）', () => {
    const nextTick = jest.fn(fn => fn());
    global.wx.nextTick = nextTick;
    trace.init();
    trace.finishFirstRender('index');
    expect(nextTick).toHaveBeenCalled();
  });

  test('wx.nextTick 不存在时降级 setTimeout，不丢打点', () => {
    delete global.wx.nextTick;
    jest.useFakeTimers();
    trace.init();
    trace.finishFirstRender('index');
    jest.runAllTimers();
    jest.useRealTimers();
    const r = trace.report();
    expect(Object.keys(r.marks).some(k => k.indexOf('first-render:index') === 0)).toBe(true);
  });

  test('首屏只记第一次：重复 finishFirstRender 不覆盖', () => {
    trace.init();
    trace.finishFirstRender('index');
    const first = trace.report().marks['first-render:index'];
    trace.finishFirstRender('index');
    expect(trace.report().marks['first-render:index']).toBe(first);
  });

  test('markRoute 只记首个路由（分享进入其它页不算冷启动）', () => {
    trace.init();
    trace.markRoute('index');
    trace.markRoute('pages/detail/detail');
    expect(trace.report().firstRoute).toBe('index');
  });

  test('formatReport 输出可读的相对耗时，含官方条目', () => {
    mockPerf.entries = [{ name: 'appLaunch', duration: 812 }, { name: 'route', duration: 233 }];
    trace.init();
    trace.mark('cloud-ready');
    const text = trace.formatReport();
    expect(typeof text).toBe('string');
    expect(text).toContain('cloud-ready');
    expect(text).toContain('appLaunch');
    expect(text).toContain('812');
  });

  test('formatReport 在完全没打点时也不抛（面板不能自己崩）', () => {
    expect(() => trace.formatReport()).not.toThrow();
  });
});