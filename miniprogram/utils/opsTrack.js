/**
 * utils/opsTrack.js - 运营面板的最小客户端埋点
 *
 * 只做两件事：
 *   1. 每次冷启动（同一天只报一次）告诉服务端「今天来过」；
 *   2. 记录用户进过哪些**页面入口**，供管理端每周淘汰无人使用的入口。
 *
 * 为什么不是每进一个页面就发一次云调用：
 *   - 入口使用是低频决策数据，不需要实时；
 *   - 每次页面切换都发请求会拖慢主流程、也会放大云函数成本。
 *   所以入口先写本地队列，onHide / 下次启动时批量上报（最多 12 条/次）。
 *   服务端按「日期 + 匿名用户 + 入口名」生成唯一文档，重复上报天然幂等。
 *
 * 隐私：只记录入口 slug，不记录猫名、搜索词、位置、图片或任何内容。
 */

const { Logger } = require('./logger');

const SESSION_KEY = '_opsSessionDay';
const QUEUE_KEY = '_opsEntryQueue';
const MAX_QUEUE = 40;
const MAX_BATCH = 12;

/**
 * 入口注册表：既是「允许上报的白名单」，也是管理端看板的中文标签来源。
 * 新增用户端入口时在这里登记一次，并记得在对应页面调用 entry('name')；
 * 下线入口时把这里和页面调用一起删掉（看板会保留 28 天历史，不会立刻消失）。
 */
const ENTRY_REGISTRY = [
  { name: 'campus_map', label: '寻猫地图', hint: '首页地图 / 打卡选点', group: '核心' },
  { name: 'rank', label: '猫咪榜单', hint: '「我的」→ 排行榜', group: '内容' },
  { name: 'favorites', label: '我的关注', hint: '「我的」→ 我的关注', group: '内容' },
  { name: 'meets', label: '相遇记录', hint: '「我的」→ 相遇记录', group: '内容' },
  { name: 'notifications', label: '消息通知', hint: '「我的」→ 消息', group: '内容' },
  { name: 'notice', label: '公告', hint: '首页公告入口', group: '内容' },
  { name: 'gallery', label: '相册', hint: '底部 Tab', group: '内容' },
  { name: 'report', label: '反馈与上报', hint: '猫咪详情页 → 信息有误 / 受伤 / 走失', group: '支持' },
  { name: 'help', label: '使用帮助', hint: '「我的」→ 使用帮助', group: '支持' }
];

const KNOWN_ENTRIES = new Set(ENTRY_REGISTRY.map(item => item.name));

let _inFlight = null;
let _sessionDay = '';
const _sessionEntries = new Set();

/** 北京时间日期键（零填充），与服务端 opsDayKey 同口径 */
function localDayKey(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function makeEntryId(name, at) {
  return `${name}_${at}_${Math.random().toString(36).slice(2, 8)}`;
}

function readQueue() {
  try {
    const raw = wx.getStorageSync(QUEUE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(item => item && typeof item.name === 'string' && KNOWN_ENTRIES.has(item.name))
      .map(item => ({
        name: item.name,
        at: typeof item.at === 'number' ? item.at : Date.now(),
        id: typeof item.id === 'string' ? item.id : ''
      }))
      .slice(-MAX_QUEUE);
  } catch (e) {
    return [];
  }
}

function writeQueue(queue) {
  try {
    if (!queue.length) wx.removeStorageSync(QUEUE_KEY);
    else wx.setStorageSync(QUEUE_KEY, queue);
  } catch (e) {
    // 本地存储失败只是少一次上报，不影响用户
  }
}

function removeConsumed(consumed) {
  if (!consumed.length) return;
  const ids = new Set(consumed.map(item => item.id).filter(Boolean));
  const fallback = new Set(consumed.filter(item => !item.id).map(item => `${item.name}|${item.at}`));
  const current = readQueue();
  const remaining = current.filter((item) => {
    if (item.id && ids.has(item.id)) return false;
    if (!item.id && fallback.has(`${item.name}|${item.at}`)) return false;
    return true;
  });
  writeQueue(remaining);
}

async function callTrackOps(payload) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') return false;
  try {
    const res = await wx.cloud.callFunction({ name: 'trackOps', data: payload });
    return !!(res && res.result && res.result.success);
  } catch (e) {
    Logger.debug('ops', '运营埋点上报失败（非致命）', e && e.message);
    return false;
  }
}

/**
 * 冷启动上报：同一天只报 session；同时顺带把上次残留的入口队列发出去。
 * 不阻塞启动（调用方不需要 await）。
 * @returns {Promise<void>}
 */
function bootstrap() {
  return runExclusive(async () => {
    let lastDay = '';
    try {
      lastDay = wx.getStorageSync(SESSION_KEY) || '';
    } catch (e) {
      lastDay = '';
    }

    const day = localDayKey(Date.now());
    const queue = readQueue();
    const wantSession = lastDay !== day;
    if (!wantSession && queue.length === 0) return;

    const batch = queue.slice(0, MAX_BATCH);
    const success = await callTrackOps({
      session: wantSession,
      entries: batch.map(item => item.name)
    });
    if (!success) return;

    if (wantSession) {
      try { wx.setStorageSync(SESSION_KEY, day); } catch (e) { /* ignore */ }
    }
    removeConsumed(batch);
  });
}

/**
 * 把本地入口队列发出去。onHide / onShow 都可调用；失败保留队列等下次。
 * @returns {Promise<void>}
 */
function flush() {
  return runExclusive(async () => {
    const queue = readQueue();
    if (queue.length === 0) return;
    const batch = queue.slice(0, MAX_BATCH);
    const success = await callTrackOps({ entries: batch.map(item => item.name) });
    if (success) removeConsumed(batch);
  });
}

/**
 * 同一时刻只允许一轮上报：onLaunch 的 bootstrap 与 onShow/onHide 的 flush
 * 可能几乎同时触发。服务端幂等，但没必要发两遍。
 */
function runExclusive(task) {
  if (_inFlight) return _inFlight;
  _inFlight = Promise.resolve()
    .then(task)
    .catch((e) => {
      Logger.debug('ops', '运营埋点任务失败（非致命）', e && e.message);
    })
    .finally(() => {
      _inFlight = null;
    });
  return _inFlight;
}

/**
 * 记录一次入口使用。只写本地队列，不发网络。
 * @param {string} name 必须是 ENTRY_REGISTRY 中登记过的 slug
 * @returns {boolean} 是否入队（同一会话内重复进入同一入口返回 false）
 */
function entry(name) {
  if (!KNOWN_ENTRIES.has(name)) {
    Logger.warn('ops', '未登记的入口，已忽略', { name });
    return false;
  }

  // 去重键按「自然日」而不是「进程生命周期」：小程序可能被挂在后台跨天，
  // 只按进程去重会让第二天的同一入口永远不再上报。
  const today = localDayKey(Date.now());
  if (today !== _sessionDay) {
    _sessionDay = today;
    _sessionEntries.clear();
  }
  if (_sessionEntries.has(name)) return false;
  _sessionEntries.add(name);

  try {
    const at = Date.now();
    const queue = readQueue();
    queue.push({ name, at, id: makeEntryId(name, at) });
    writeQueue(queue.slice(-MAX_QUEUE));
    return true;
  } catch (e) {
    return false;
  }
}

function getRegistry() {
  return ENTRY_REGISTRY.map(item => ({ ...item }));
}

module.exports = {
  ENTRY_REGISTRY,
  bootstrap,
  flush,
  entry,
  getRegistry
};
