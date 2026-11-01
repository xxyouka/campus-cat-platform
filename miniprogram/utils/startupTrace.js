/**
 * utils/startupTrace.js - 小程序启动各阶段耗时埋点
 *
 * 为什么要它：现在项目里只有 performanceMonitor 的 Date.now() 接口耗时统计，
 * 而「首屏到底慢在哪」这个问题它答不了 —— 用户看到的是一片白屏，
 * 我们却不知道这 1.5s 是花在 JS 解析、云调用往返，还是 setData 渲染上。
 * 靠猜着改性能是本末倒置，得先把数字拉出来。
 *
 * 关键设计：**时间基准用 wx.getPerformance()，不用 Date.now()**。
 * Date.now() 是墙钟时间，会被用户改系统时间、NTP 校时影响；
 * 而微信官方文档里 performance.mark/measure 就是为这个场景设计的，
 * 它给的是单调递增的相对时间，和「小程序启动」的官方口径（appLaunch / route）对得上。
 *
 * 用法：
 *   const trace = require('../../utils/startupTrace');
 *   trace.init();                       // app.js onLaunch 最开头，早于任何 await
 *   trace.mark('cloud-init');           // 某个阶段完成
 *   trace.finishFirstRender('index');   // 首屏真正画出（wx.nextTick 之后）
 *   trace.report();                     // 打印汇总
 *
 * 什么时候读数据：点「性能面板」按钮 → wx.showModal 把汇总显示出来。
 * 真机上没有 vConsole，用户也能直接截图给自己看。
 */
const { Logger } = require('./logger');

/**
 * 拿到 performance 对象。
 * 基础库 < 2.9.0 没有 wx.getPerformance，这里降级成 null 并全程静默 ——
 * 埋点绝不能成为启动路径上的新故障源。
 */
function perf () {
  try {
    if (wx && typeof wx.getPerformance === 'function') return wx.getPerformance();
  } catch (e) { /* ignore */ }
  return null;
}

/** marks：阶段名 → 相对毫秒 */
const marks = {};
/** finishes：首屏完成时刻 */
let firstRenderAt = null;
let inited = false;
/** 页面栈首次进入的路由（route 阶段的终点） */
let firstRoute = '';

/**
 * 初始化。必须在 app.js onLaunch 的**第一行**调用。
 *
 * 早于它的一切都不算「启动耗时」，所以这个函数自己不做任何事，
 * 只记下基准点。
 */
function init () {
  if (inited) return marks;
  inited = true;
  // 基准点**不依赖 getPerformance**：即使基础库不支持，Date.now() 这条
  // 兜底路径也要能出数字。否则「不支持时全程静默」就变成了「完全没数据」，
  // 而降级期的数字恰恰是判断「是不是基础库太老」的唯一依据。
  const p = perf();
  try {
    if (p && p.mark) p.mark('launch_start');
  } catch (e) { /* ignore */ }
  marks.launch_start = Date.now();
  return marks;
}

/**
 * 打一个阶段完成点。
 *
 * @param {string} name 阶段名（如 'cloud-init' / 'openid-cached'）
 */
function mark (name) {
  if (!inited) init();          // 容错：万一调用方忘了 init，也不能丢打点
  const p = perf();
  try {
    if (p && p.mark) p.mark(name);
  } catch (e) { /* ignore */ }
  // 只记第一次：onReady 之类的会被重复调用，后来的不该覆盖先来的
  if (marks[name] === undefined) marks[name] = Date.now();
}

/**
 * 记录「首屏真正画出来」的时刻。
 *
 * 为什么要 wx.nextTick：setData 把数据交下去之后，视图层的实际渲染在
 * 下一个 tick 才发生。直接在 setData 之后打点，量到的是「数据提交」，
 * 不是「用户看到东西」—— 那个瞬间用户还在看骨架屏。
 *
 * @param {string} name 页面名
 */
function finishFirstRender (name) {
  const p = perf();
  const doFinish = () => {
    if (firstRenderAt !== null) return;    // 只记第一次
    firstRenderAt = Date.now();
    marks['first-render:' + name] = firstRenderAt;
    try {
      p && p.mark && p.mark('firstRender');
    } catch (e) { /* ignore */ }
  };
  try {
    if (wx && typeof wx.nextTick === 'function') wx.nextTick(doFinish);
    else setTimeout(doFinish, 0);
  } catch (e) { doFinish(); }
}

/**
 * 页面 onLoad 时调用，记录「路由阶段结束」。
 * @param {string} route 路由名
 */
function markRoute (route) {
  if (!firstRoute) firstRoute = route;
  mark('route:' + route);
}

/**
 * 汇总启动耗时。
 *
 * 三类时间分开报，因为它们的成因完全不同：
 *   - appLaunch：小程序启动（拉代码、初始化环境）—— 服务端/客户端启动耗时
 *   - route：路由到页面 onLoad —— 页面注册与实例化
 *   - first-render：首屏画出来 —— 页面自己的活（网络 + setData + 渲染）
 *
 * @returns {object} 汇总数据
 */
function report () {
  const p = perf();
  const out = {
    marks: { ...marks },
    firstRenderAt,
    firstRoute,
    official: null
  };

  // 官方口径：wx.getPerformance() 返回 appLaunch / route 等条目
  try {
    if (p && typeof p.getEntries === 'function') {
      out.official = p.getEntries();
    } else if (p && typeof p.getEntriesByType === 'function') {
      out.official = p.getEntriesByType('navigation');
    }
  } catch (e) { /* ignore */ }

  // 派生指标：从进程/启动基准点算的相对毫秒
  const base = marks.launch_start;
  if (base !== undefined) {
    const rel = {};
    for (const [k, v] of Object.entries(marks)) {
      rel[k] = v - base;
    }
    out.relative = rel;
  }
  return out;
}

/**
 * 生成给 wx.showModal 用的文本（真机上没有 vConsole，只能这样把数字带出来）。
 */
function formatReport () {
  const r = report();
  const lines = [];
  lines.push('启动耗时（相对进程基准，ms）');
  const rel = r.relative || {};
  // 按打点顺序输出，避免按字母排导致看不出先后
  const order = Object.keys(r.marks);
  for (const k of order) {
    lines.push(k + ': ' + (rel[k] !== undefined ? rel[k] : '-'));
  }
  if (r.official && r.official.length) {
    lines.push('');
    lines.push('官方条目：');
    for (const e of r.official) {
      lines.push((e.name || e.entryType) + '=' + (e.duration !== undefined ? Math.round(e.duration) : '-'));
    }
  }
  return lines.join('\n');
}

module.exports = {
  init,
  mark,
  markRoute,
  finishFirstRender,
  report,
  formatReport
};

// eslint-disable-next-line no-console
Logger && Logger.info && Logger.info('startupTrace', '模块已加载');