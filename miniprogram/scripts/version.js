/**
 * scripts/version.js —— 版本号「一次改全」的唯一入口
 *
 * 背景：版本号曾散在 7 个位置，靠人记。3.7.8 / 3.7.9 两次发版都漏了
 * package-lock.json 的两处（镜像里一直是 3.7.7），而当时没有任何门禁能发现。
 *
 * 用法：
 *   node scripts/version.js check        # 只检查（不一致 exit 1，已挂进 npm run check）
 *   node scripts/version.js bump 3.8.0   # 一次改写全部位置
 *
 * 唯一事实源：package.json 的 version。其余位置一律以它为基准。
 * 刻意**不**动 CHANGELOG.md —— 版本小节要写变更内容，不能机械生成。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const CONFIG_JS = 'config.js';
const GET_CONFIG = 'cloudfunctions/getConfig/index.js';
const README = 'README.md';
const ENV_VARS = 'cloudfunctions/ENV_VARS.md';
const PACKAGE_JSON = 'package.json';
const PACKAGE_LOCK = 'package-lock.json';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel, text) {
  fs.writeFileSync(path.join(ROOT, rel), text, 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function writeJson(rel, obj) {
  write(rel, JSON.stringify(obj, null, 2) + '\n');
}

/** 每个位置：怎么读、怎么改、显示什么说明 */
const TARGETS = [
  {
    file: CONFIG_JS,
    label: '客户端版本号',
    pattern: /version:\s*'([^']+)'/,
    replace: (text, v) => text.replace(/version:\s*'[^']+'/, `version: '${v}'`)
  },
  {
    file: GET_CONFIG,
    label: 'getConfig 兜底值',
    pattern: /process\.env\.APP_VERSION\s*\|\|\s*'([^']+)'/,
    replace: (text, v) => text.replace(/process\.env\.APP_VERSION\s*\|\|\s*'[^']+'/, `process.env.APP_VERSION || '${v}'`)
  },
  {
    file: README,
    label: 'README 徽章',
    pattern: /badge\/version-v([0-9.]+)-/,
    replace: (text, v) => text.replace(/badge\/version-v[0-9.]+-/, `badge/version-v${v}-`)
  },
  {
    file: README,
    label: 'README 环境变量示例',
    pattern: /APP_VERSION = ([0-9.]+)/,
    replace: (text, v) => text.replace(/APP_VERSION = [0-9.]+/, `APP_VERSION = ${v}`)
  },
  {
    file: ENV_VARS,
    label: 'ENV_VARS 默认值说明',
    pattern: /默认值 `([0-9.]+)`（与 package\.json/,
    replace: (text, v) => text.replace(/默认值 `[0-9.]+`（与 package\.json/, `默认值 \`${v}\`（与 package.json`)
  }
];

function collect() {
  const pkg = readJson(PACKAGE_JSON);
  const lock = readJson(PACKAGE_LOCK);
  const expected = pkg.version;
  const rows = [
    { label: 'package.json', file: PACKAGE_JSON, found: expected },
    { label: 'package-lock.json 根', file: PACKAGE_LOCK, found: lock.version },
    { label: 'package-lock.json packages[""]', file: PACKAGE_LOCK, found: lock.packages && lock.packages[''] && lock.packages[''].version }
  ];

  TARGETS.forEach((t) => {
    const text = read(t.file);
    const m = text.match(t.pattern);
    rows.push({ label: t.label, file: t.file, found: m ? m[1] : '(未找到)' });
  });

  return { expected, rows };
}

function check() {
  const { expected, rows } = collect();
  const bad = rows.filter((r) => r.found !== expected);

  if (!bad.length) {
    console.log(`版本号一致：${expected}（${rows.length} 处）`);
    return 0;
  }

  console.error(`版本号不一致（基准 package.json = ${expected}）：`);
  rows.forEach((r) => {
    const mark = r.found === expected ? '  ok ' : '  ✗  ';
    console.error(`${mark}${r.label.padEnd(32)} ${String(r.found).padEnd(10)} ${r.file}`);
  });
  console.error(`\n统一改：node scripts/version.js bump ${expected}`);
  return 1;
}

function bump(next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(`版本号必须形如 3.8.0，收到：${next}`);
    return 1;
  }

  const pkg = readJson(PACKAGE_JSON);
  pkg.version = next;
  writeJson(PACKAGE_JSON, pkg);

  const lock = readJson(PACKAGE_LOCK);
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  writeJson(PACKAGE_LOCK, lock);

  TARGETS.forEach((t) => {
    const text = read(t.file);
    if (!t.pattern.test(text)) {
      throw new Error(`没找到版本号位置：${t.file}（${t.label}）—— 正则已过期，请先修 scripts/version.js`);
    }
    write(t.file, t.replace(text, next));
  });

  console.log(`已把 ${CONFIG_JS} / ${GET_CONFIG} / ${README} / ${ENV_VARS} 改为 ${next}`);
  console.log(`已把 ${PACKAGE_JSON} / ${PACKAGE_LOCK}（两处）改为 ${next}`);
  console.log('别忘了手写 CHANGELOG.md 的新版本小节并更新 README 测试数字。');
  return 0;
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'check') return check();
  if (cmd === 'bump') {
    if (!arg) {
      console.error('用法：node scripts/version.js bump 3.8.0');
      return 1;
    }
    return bump(arg);
  }
  console.error('用法：node scripts/version.js <check|bump <version>>');
  return 1;
}

process.exitCode = main();
