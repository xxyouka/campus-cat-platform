// __tests__/cloudfunctions/entryCoverageGuard.test.js
//
// 为什么需要这个文件：
// jest.config.js 里有逐文件阈值（'./cloudfunctions/*/index.js': {...}），注释说它是为了
// 「保证每个入口都被真实执行过，而不是漏在统计口径之外」。**但它做不到这件事** ——
// Jest 只对「出现在 coverage map 里的文件」套路径阈值，从未被 require 的文件根本不进 map，
// 阈值对它恒为放行。实测曾有 22 个入口（含 8 个写库路径）整个从统计里消失，
// 而 exit code 仍是 0、配置注释写得像已经守住了。
//
// 这个守卫直接清点入口与测试的 require 关系，并采用「债务上限棘轮」：
//   - 新增云函数却不补测试 → 立刻红（上限被突破）
//   - 每补一个入口测试 → 把上限往下调一格，让剩余债务持续可见
//   - 不允许把缺口「洗」进豁免，豁免必须写理由且要真实存在于清单
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FN_ROOT = path.join(ROOT, 'cloudfunctions');
const TESTS_ROOT = path.join(ROOT, '__tests__');

// 共享模块目录，不是云函数入口
const NON_FUNCTION_DIRS = new Set(['common', 'utils']);

/** 递归收集目录下所有 .js 文件（跳过 node_modules 与 coverage） */
function collectJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 当前已知的入口测试债务。每补一个就把对应行删掉，
// 并把下面的 DEBT_CEILING 降到新数量。只减不增。
// 格式：函数名 —— 一句话说明它是读接口还是写接口（写接口优先补）。
// 2026-10-12：getCatPhotoCounts 已补入口测试（照片计数聚合的隐式 20 条上限，
// 见 __tests__/cloudfunctions/getCatPhotoCounts.test.js），从台账移除。
// 2026-10-15：getAdminStats 已补入口测试（容器内 60s 缓存 + 鉴权在缓存之前 +
// 失败不写缓存，见 __tests__/cloudfunctions/getAdminStats.test.js），从台账移除。
// 2026-10-18：getPhotosByCat 已补入口测试（count 与分页 get 必须并行 + liked 标注 +
// hasMore 末页边界，见 __tests__/cloudfunctions/getPhotosByCat.test.js），从台账移除。
// ---------------------------------------------------------------------------
const KNOWN_UNTESTED = [
  // catRelation 已移出台账（2026-10-19 · P2）：新增 listAll 的服务端筛选契约测试
  // （__tests__/cloudfunctions/catRelationListAll.test.js）。
];

// 债务上限 = 台账条数。每补一个入口测试就把台账里对应行删掉，
// 这个数字随之下降（只减不增）。catRelation 已于 2026-10-19（P2）移出，
// getCatRank 于 2026-10-31 补入口测试后移出；getFavRank/getMeetRank 由
// rankLimits.test.js 覆盖后移出；markNotificationRead、recordView 与 migrateMeetStatusTag
// 由专属测试覆盖后移出；addDonation 权限拒绝、getMyMeetCount 日期/ID 边界、
// getMyMeets 并发查询、initDatabase 权限、getRecentMeets 空结果短路与
// checkAdminStatus 权限摘要、getNotices 公告可见范围与分页、getOpenId 身份边界，
// getPublicDonations 白名单字段与限流测试后移出，现 0 条。
const DEBT_CEILING = KNOWN_UNTESTED.length;

// 有意豁免：写清楚理由，且会校验真实存在于清单
const WHITELIST = new Map([
  // 定时任务函数，仅由云开发定时触发器调用（App 内调不到）。
  // 其安全契约（必须校验 event.Type === 'Timer'）已由 security.test.js 的
  // 多层「伪造 Timer」用例锁定，因此不需要常规入口测试。
  ['backupData', '定时器触发；Timer 伪造拒绝由 security.test.js 锁定'],
  ['reconcileMeetCount', '定时器触发；Timer 伪造拒绝由 security.test.js 锁定'],
  // sweepLostCats 同样是定时任务（每天 04:00 自动标记走失），但不是「只读」：
  // 它会成批改写猫咪状态。因此它的入口测试（含伪造 Timer 被拒、异常闸门、
  // 幂等复位）写在 __tests__/cloudfunctions/sweepLostCats.test.js，而不是记进债务台账。
  ['sweepLostCats', '定时器触发；入口与 Timer 伪造拒绝由 sweepLostCats.test.js 锁定'],
  // HTTP 回调入口：由微信消息推送调用，需先验签解密。
  ['mediaCheckCallback', 'HTTP 回调；trace_id 反查防伪造由专属测试锁定']
]);

describe('云函数入口覆盖守卫', () => {
  const fnDirs = fs.readdirSync(FN_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !NON_FUNCTION_DIRS.has(d.name))
    .map(d => d.name)
    .sort();

  const cloudbaserc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'));
  const manifestNames = (cloudbaserc.functions || []).map(f => f.name).sort();

  const testSources = collectJs(TESTS_ROOT).map(f => ({
    file: path.relative(ROOT, f).replace(/\\/g, '/'),
    src: fs.readFileSync(f, 'utf8')
  }));

  /**
   * 判断某个云函数入口是否**真的被测试加载过**。
   *
   * 曾经的实现是 `src.includes('cloudfunctions/<fn>/index')` —— 只要有测试在
   * 任何位置提到这个路径就算「有测试」。实测 `docsConsistencyGuard.test.js`
   * 里的一句 `read('cloudfunctions/getConfig/index.js')`（fs.readFileSync 读文本，
   * 从不执行）就把 getConfig 判成了已测，于是：
   *   - 真实未测数是 21，台账却只登记 20 → 债务棘轮的基准偏移了一格；
   *   - getConfig 从未进入 coverage map，jest.config.js 里那条云函数入口的逐文件阈值对它恒放行。
   * 也就是说，这个专门用来防「入口漏测」的守卫，被一句文本读取骗过了。
   *
   * 现在要求三件事同时成立：
   *   1. 该行不是注释（块注释与行注释都要剥掉，文件头的用法示例不算数）；
   *   2. 确实是一个 `require('…/cloudfunctions/<fn>/index')` 字面量调用；
   *   3. 不在 jest.mock/doMock/unmock 里 —— 那些把真模块换成了桩，
   *      入口根本没执行过，不能算「被测过」。
   */
  const stripComments = (src) =>
    src
      // ① 整块注释（可能跨行）
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(line => {
        // ② 块注释的续行：以 * 开头。必须单独判一次 —— 上一步只能干掉
        //    带完整 /* … */ 的整块，取片段测试时续行会以裸 `* …` 的形态留在数组里。
        if (/^\s*\*/.test(line)) return '';
        // ③ 行注释。require 的路径里不会出现 //，所以直接截断是安全的。
        const at = line.indexOf('//');
        return at === -1 ? line : line.slice(0, at);
      })
      .join('\n');

  /** 单行里是否存在指向该入口的真实 require 调用（判定逻辑的唯一实现，供自检复用） */
  const countsAsEntryRequire = (line, entryPath) => {
    if (/jest\.(mock|doMock|unmock)\s*\(/.test(line)) return false;
    const calls = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
    return calls.some(call => call.includes(entryPath));
  };

  const hasEntryTest = (fnName) => {
    const entryPath = `cloudfunctions/${fnName}/index`;
    return testSources.some(({ src }) =>
      stripComments(src).split(/\r?\n/).some(line => countsAsEntryRequire(line, entryPath))
    );
  };

  test('部署清单与 cloudfunctions 目录一一对应（不出现"清单有但目录没了"或反之）', () => {
    expect(manifestNames).toEqual(fnDirs);
  });

  // ---------------------------------------------------------------------
  // 守卫自身的反向验证。
  // hasEntryTest 一旦被改回「文本里提到路径就算」，本组立刻红 ——
  // 历史上正是这样被 docsConsistencyGuard 里的一句 read(...) 骗过，
  // 而守卫本身一路绿灯。
  // ---------------------------------------------------------------------
  describe('守卫自身的判定边界', () => {
    const ENTRY = 'cloudfunctions/getConfig/index';
    const countedIn = (line) => stripComments(line).split(/\r?\n/)
      .some(l => countsAsEntryRequire(l, ENTRY));

    test.each([
      ["const src = read('cloudfunctions/getConfig/index.js');", 'fs 读文本，从不执行'],
      ["/*\n * 用例：require('../../cloudfunctions/getConfig/index');\n */", '整块注释里的用法示例'],
      ["* 用例：require('../../cloudfunctions/getConfig/index');", '块注释的续行（无 /* 与 */ 包裹）'],
      ['// 见 cloudfunctions/getConfig/index.js', '行注释'],
      ["jest.mock('../../cloudfunctions/getConfig/index');", '被 jest 桩替换'],
      ["const s = 'cloudfunctions/getConfig/index';", '纯字符串字面量'],
      ['const p = "cloudfunctions/getConfig/index"; const x = require(p);', 'require 的是变量而非字面量']
    ])('不该被算成「已测」：%s（%s）', (line) => {
      expect(countedIn(line)).toBe(false);
    });

    test.each([
      ["const getConfig = require('../../cloudfunctions/getConfig/index');", '仓库内最常见写法（../../ 前缀）'],
      ["main = require('../../cloudfunctions/getConfig/index').main;", '带属性取用'],
      ["const { ok } = require('./cloudfunctions/getConfig/index');", './ 前缀']
    ])('真实 require 必须能被认出：%s（%s）', (line) => {
      expect(countedIn(line)).toBe(true);
    });

    test('getConfig 必须有真入口测试（它曾被 read() 误判为已测）', () => {
      expect(hasEntryTest('getConfig')).toBe(true);
    });
  });

  test.each(manifestNames)('%s 的入口要么有测试，要么已登记债务台账', (fnName) => {
    if (WHITELIST.has(fnName)) return;

    const loaded = hasEntryTest(fnName);
    const debtListed = KNOWN_UNTESTED.includes(fnName);

    // 未登记又没测试 = 有人加了云函数却什么都没做，这正是本守卫要拦的形态。
    // 失败信息直接把「该怎么做」说出来，避免看到红还要来翻代码。
    expect({
      fn: fnName,
      hasEntryTest: loaded,
      inDebtLedger: debtListed,
      ok: loaded || debtListed,
      howToFix: loaded
        ? ''
        : debtListed
          ? '已在台账中排期，补好测试后从 KNOWN_UNTESTED 删掉并调低 DEBT_CEILING'
          : `请在 __tests__ 下 require('cloudfunctions/${fnName}/index') 补入口测试，` +
            '或确有理由就先加进 KNOWN_UNTESTED 台账（会上调到 DEBT_CEILING）'
    }).toEqual(expect.objectContaining({ ok: true }));
  });

  test('入口测试债务不得增长（棘轮）', () => {
    const actual = manifestNames.filter(
      name => !WHITELIST.has(name) && !hasEntryTest(name)
    );
    // 未登记的缺口 = 有人加了函数没补测试，也没在 KNOWN_UNTESTED 记账
    const unlisted = actual.filter(name => !KNOWN_UNTESTED.includes(name));

    expect({
      unlisted,
      ceiling: DEBT_CEILING,
      actualCount: actual.length
    }).toEqual({
      unlisted: [],
      ceiling: DEBT_CEILING,
      actualCount: DEBT_CEILING
    });
  });

  test('债务台账与豁免表都不许有已不存在的过期条目', () => {
    // 正向遍历清单：台账里的项应当确实还没有测试；已有测试却仍挂在台账里说明忘了销账
    manifestNames.forEach(name => {
      if (KNOWN_UNTESTED.includes(name)) {
        expect(hasEntryTest(name)).toBe(false);
      }
      if (WHITELIST.has(name)) {
        expect(manifestNames).toContain(name);
      }
    });

    // 反向遍历台账/豁免表：条目必须真实存在于部署清单中。
    // 少了这一条，往台账里塞一个压根不存在的函数名不会被发现 ——
    // 台账会慢慢长出一堆幽灵条目，最后没人敢信它，棘轮也就失去意义。
    KNOWN_UNTESTED.forEach(name => {
      expect(manifestNames).toContain(name);
    });
    WHITELIST.forEach((_reason, name) => {
      expect(manifestNames).toContain(name);
    });
  });
});
