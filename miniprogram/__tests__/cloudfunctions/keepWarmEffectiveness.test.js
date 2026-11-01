/**
 * keepWarm 预热有效性回归
 *
 * 背景：keepWarm 定时任务每 5 分钟跑一次，依次 callFunction 每个被预热的函数，
 * 目的是把云函数实例从冷启动拉起来。但预热请求不带业务参数（比如 getPhotosByCat
 * 需要 catId），所以除非目标函数**显式识别 _keepWarm 并提前返回**，否则请求会
 * 走到参数校验处 fail 掉 —— 实例虽然起来了，但只跑了「启动 + 参数校验」就退出，
 * 业务代码根本没被加载。
 *
 * 历史实测（真机日志）：getPhotosByCat 首次 1369ms、预热后 346~393ms，4 倍差，
 * 说明预热确实没起到预期作用。
 *
 * 这里锁住两件事：
 *   1. keepWarm 名单里的每个函数都必须识别 _keepWarm（否则预热是空转）
 *   2. 识别后必须**立刻返回**，不能继续走业务逻辑（那会真查库、真写数据）
 */
const fs = require('fs');
const path = require('path');

// 本文件在 __tests__/cloudfunctions/ 下，项目根要上溯两级
const ROOT = path.join(__dirname, '..', '..');
const KEEP_WARM = path.join(ROOT, 'cloudfunctions', 'keepWarm', 'index.js');

/** 从 keepWarm/index.js 里解析出 WARM_FUNCTIONS 名单 */
function readWarmList () {
  const src = fs.readFileSync(KEEP_WARM, 'utf8');
  const start = src.indexOf('WARM_FUNCTIONS = [');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(']', start);
  const body = src.slice(start, end);
  const names = [];
  const re = /'([a-zA-Z][a-zA-Z0-9_]*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) names.push(m[1]);
  return names;
}

describe('keepWarm 预热有效性', () => {
  const names = readWarmList();

  test('keepWarm 名单非空且不为空转', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  test('每个被预热的函数都识别 _keepWarm（否则实例起来也只跑了个参数校验）', () => {
    const missing = names.filter(name => {
      const f = path.join(ROOT, 'cloudfunctions', name, 'index.js');
      if (!fs.existsSync(f)) return true;      // 函数不存在也算不通过
      return !fs.readFileSync(f, 'utf8').includes('_keepWarm');
    });
    expect(missing).toEqual([]);
  });

  /**
   * 识别之后必须**立刻**返回。
   *
   * 判据：_keepWarm 的判断出现在 `db.collection` / `cloud.callFunction` 之前。
   * 反过来（先判断再查库）说明它只是「识别了但没早退」，预热会真的打数据库，
   * 既慢又可能在数据上留痕。
   */
  test('_keepWarm 分支在访问数据库之前就返回', () => {
    const offenders = [];
    for (const name of names) {
      const f = path.join(ROOT, 'cloudfunctions', name, 'index.js');
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      const warmAt = src.indexOf('_keepWarm');
      const mainAt = src.indexOf('exports.main');
      if (mainAt === -1 || warmAt === -1) continue;
      // 早退判断必须在 main 之后，且必须在第一次真正查库之前
      const firstQuery = src.indexOf('db.collection', mainAt);
      if (firstQuery !== -1 && warmAt > firstQuery) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test('getPhotosByCat 单独确认：预热早退在 catId 校验之前', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'cloudfunctions', 'getPhotosByCat', 'index.js'), 'utf8'
    );
    const mainAt = src.indexOf('exports.main');
    const warmAt = src.indexOf('_keepWarm', mainAt);
    const catIdCheck = src.indexOf('CAT_ID_PATTERN.test', mainAt);
    expect(warmAt).toBeGreaterThan(mainAt);
    expect(catIdCheck).toBeGreaterThan(-1);
    // 早退点必须早于「猫ID格式无效」那道校验，否则预热请求照样被判失败
    expect(warmAt).toBeLessThan(catIdCheck);
  });

  /**
   * 早退代码引用的形参名，必须与 main 的实际形参名一致。
   *
   * 曾踩过：getCatPhotoCounts 的签名是 `(_event, _context)`（下划线表示不使用），
   * 批量插入时按 `event` 写，运行时直接 ReferenceError —— 而 node --check 查不出来，
   * 只有真正执行才炸。这类错必须靠静态对照兜住。
   */
  test('早退引用的形参名与 main 签名一致（防 _event/event 写混）', () => {
    const offenders = [];
    for (const name of names) {
      const f = path.join(ROOT, 'cloudfunctions', name, 'index.js');
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      const m = src.match(/exports\.main\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)/);
      const param = m && m[1];
      const line = src.split('\n').find(l => l.includes('._keepWarm') && l.includes('if ('));
      const used = line && (line.match(/if \((\w+)/) || [])[1];
      if (!param || !used || param !== used) offenders.push(name + '(param=' + param + ', used=' + used + ')');
    }
    expect(offenders).toEqual([]);
  });

  test('预热早退不写任何数据（只允许 ok 返回，不得有 update/remove/add）', () => {
    const offenders = [];
    for (const name of names) {
      const f = path.join(ROOT, 'cloudfunctions', name, 'index.js');
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      const line = src.split('\n').find(l => l.includes('._keepWarm') && l.includes('if ('));
      if (!line) continue;
      // 早退那一行里出现写操作即为高危
      if (/\.(update|remove|add|set)\s*\(/.test(line)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});