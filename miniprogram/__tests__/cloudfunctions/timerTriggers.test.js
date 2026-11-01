/**
 * __tests__/cloudfunctions/timerTriggers.test.js
 *
 * 定时触发器的一致性守卫。
 *
 * 背景（2026-10-11，QA-6 / BE-8 的后续）：定时触发器的定义在**两个文件**里各写了一份 ——
 *   - cloudfunctions/<fn>/config.json   开发者工具「上传并部署」读取的那份；
 *   - cloudbaserc.json 的 functions[].triggers   tcb CLI 部署清单读的那份。
 * 两份可以不一致，而且实测**已经不一致过**：keepWarm 在 config.json 里叫
 * `keepWarmTimer`，在 cloudbaserc.json 里叫 `keepWarmTrigger` —— 同一个触发器两个名字。
 * 部署走哪条链路就只生效哪一个，另一个静默失效，且没有任何报错。
 *
 * 更麻烦的是 backupData / reconcileMeetCount 曾**只存在于 config.json**，
 * cloudbaserc 里没有 triggers 字段：按 cloudbaserc 重建环境会静默丢掉
 * 每日备份与每日对账（两个都靠 isTrustedTimerEvent 强校验 TriggerName，
 * 名字对不上就直接拒绝执行、只打一条 warn 日志）。
 *
 * 所以这里锁三件事：
 *   1. 每个声明了 triggers 的函数，两份文件的触发器定义必须逐字相同；
 *   2. 代码里 isTrustedTimerEvent 校验的 TriggerName 常量，必须能在 config.json 里找到；
 *   3. 改了 cloudbaserc 里的 triggers，不能出现「只有一边有」的情况。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FN_ROOT = path.join(ROOT, 'cloudfunctions');
const cloudbaserc = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'));

const basercFunctions = new Map(
  (cloudbaserc.functions || []).map(f => [f.name, f])
);

/** 读某个函数的 config.json（不存在或无 triggers 时返回 null） */
function readFnTriggers(fnName) {
  const p = path.join(FN_ROOT, fnName, 'config.json');
  if (!fs.existsSync(p)) return null;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(cfg.triggers) && cfg.triggers.length ? cfg.triggers : null;
}

/** 取出两个文件里真正有定时触发器的函数名 */
const fnDirs = fs.readdirSync(FN_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(FN_ROOT, d.name, 'index.js')))
  .map(d => d.name);

const withConfigTriggers = fnDirs.filter(name => readFnTriggers(name));
const withBasercTriggers = [...basercFunctions.entries()]
  .filter(([, f]) => Array.isArray(f.triggers) && f.triggers.length)
  .map(([name]) => name);

describe('定时触发器：config.json 与 cloudbaserc.json 必须一致', () => {
  test('至少存在一个定时触发器（防止守卫本身被架空成空跑）', () => {
    expect(withConfigTriggers.length).toBeGreaterThan(0);
    expect(withConfigTriggers).toEqual(expect.arrayContaining(['keepWarm', 'backupData', 'reconcileMeetCount']));
  });

  test.each(withConfigTriggers)('%s：cloudbaserc.json 的 triggers 与 config.json 逐字相同', (fnName) => {
    const fromConfig = readFnTriggers(fnName);
    const entry = basercFunctions.get(fnName);

    expect(entry).toBeDefined();
    expect(entry.triggers).toEqual(fromConfig);
  });

  test.each(withBasercTriggers)('%s：cloudbaserc.json 里的触发器在 config.json 中也有对应定义', (fnName) => {
    expect(readFnTriggers(fnName)).toEqual(basercFunctions.get(fnName).triggers);
  });

  test('两侧的触发器函数集合完全相同（不允许只有一边有）', () => {
    expect([...withBasercTriggers].sort()).toEqual([...withConfigTriggers].sort());
  });

  /**
   * 最关键的一条：代码里 isTrustedTimerEvent(event, TRIGGER_NAME) 是**强校验**
   * —— 名字对不上直接 return false、只打一条 warn。也就是说「触发器配了但名字写错」
   * 的后果是定时任务静默不执行（每日备份/对账真的没跑），而日志里只有一行 warn。
   */
  test('代码里强校验的 TriggerName 常量，必须与 config.json 的触发器名一致', () => {
    const cases = [
      { fn: 'backupData', constName: /TIMER_TRIGGER_NAME\s*=\s*'([^']+)'/ },
      { fn: 'reconcileMeetCount', constName: /TIMER_TRIGGER_NAME\s*=\s*'([^']+)'/ },
      { fn: 'sweepLostCats', constName: /TIMER_TRIGGER_NAME\s*=\s*'([^']+)'/ }
    ];

    cases.forEach(({ fn, constName }) => {
      const src = fs.readFileSync(path.join(FN_ROOT, fn, 'index.js'), 'utf8');
      const m = src.match(constName);
      expect(m).not.toBeNull(); // 常量必须仍在（改名了就要同步本用例）

      const declared = readFnTriggers(fn).map(t => t.name);
      expect(declared).toContain(m[1]);
    });
  });
});