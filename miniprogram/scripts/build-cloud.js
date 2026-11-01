
// scripts/build-cloud.js - 云函数公共模块构建脚本
// 将 cloudfunctions/ 下的公共模块（auth/response/sanitizer/operationLogger 等）
// 复制到各云函数目录，确保部署时每个云函数自带所需依赖。
//
// 受管模块清单（源文件 + 目标云函数）来自 scripts/managed-modules.js，
// 与 sync-utils.js 共用同一事实源，两个脚本覆盖同一批模块。
// 用法: build | copy | clean | verify
const fs = require('fs');
const path = require('path');
const { CLOUD_FUNCTIONS_DIR: CLOUD_DIR, MANAGED_MODULES, getCloudFunctionDirs, findDirsMissingIndex } = require('./managed-modules');

function copyUtils() {
  console.log('复制公共模块到云函数目录...\n');
  let copied = 0;

  for (const { source, targets } of MANAGED_MODULES) {
    const srcPath = path.join(CLOUD_DIR, source);
    if (!fs.existsSync(srcPath)) {
      console.warn(`源文件不存在: ${source}`);
      continue;
    }

    const content = fs.readFileSync(srcPath, 'utf-8');

    for (const funcName of targets) {
      const destDir = path.join(CLOUD_DIR, funcName);
      if (!fs.existsSync(destDir)) {
        console.warn(`云函数目录不存在: ${funcName}`);
        continue;
      }

      const destPath = path.join(destDir, source);
      const destParentDir = path.dirname(destPath);

      if (!fs.existsSync(destParentDir)) {
        fs.mkdirSync(destParentDir, { recursive: true });
      }

      fs.writeFileSync(destPath, content, 'utf-8');
      console.log(`  ${funcName}/${source}`);
      copied++;
    }
  }

  console.log(`\n共复制 ${copied} 个模块文件\n`);
}

function clean() {
  console.log('清理云函数中的公共模块...\n');
  let removed = 0;

  for (const { source, targets } of MANAGED_MODULES) {
    for (const funcName of targets) {
      const destPath = path.join(CLOUD_DIR, funcName, source);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        console.log(`${funcName}/${source}`);
        removed++;

        const destParentDir = path.dirname(destPath);
        if (fs.existsSync(destParentDir)) {
          const remaining = fs.readdirSync(destParentDir);
          if (remaining.length === 0) {
            fs.rmdirSync(destParentDir);
          }
        }
      }
    }
  }

  console.log(`\n 共移除 ${removed} 个模块文件\n`);
}

/**
 * 扫描云函数入口 index.js 中所有 require('./utils/xxx') / require('./common/xxx')，
 * 返回相对该云函数目录的路径集合（如 'utils/response.js'）。
 */
function scanEntryRequires(funcName) {
  const required = new Set();
  let content;
  try {
    content = fs.readFileSync(path.join(CLOUD_DIR, funcName, 'index.js'), 'utf-8');
  } catch (e) {
    return required;
  }

  const re = /require\(\s*['"]\.\/(utils|common)\/([A-Za-z0-9_.-]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const file = match[2].endsWith('.js') ? match[2] : `${match[2]}.js`;
    required.add(`${match[1]}/${file}`);
  }
  return required;
}

/**
 * 建立「云函数 -> 按清单应持有的受管副本」索引。
 */
function buildManagedIndex() {
  const managedByFunc = new Map();
  for (const { source, targets } of MANAGED_MODULES) {
    for (const funcName of targets) {
      if (!managedByFunc.has(funcName)) managedByFunc.set(funcName, new Set());
      managedByFunc.get(funcName).add(source);
    }
  }
  return managedByFunc;
}

/**
 * 反向校验（双向比对）：
 * 1. 入口 index.js 真正 require 的模块必须存在，否则部署时 MODULE_NOT_FOUND（verify 曾对此报绿）；
 * 2. utils/common 下不得存在未登记在清单里的副本——clean 清不掉、build 也不会恢复/更新；
 * 3. 副本 require 了第三方包时，本函数的 package.json 必须声明该依赖；
 * 4. 深层本地依赖：入口可达模块自身的 require('./xxx') 也必须解析得到真实文件
 *    （见 verifyDeepLocalRequires —— 2026-10-16 subscribeQuota 漏登记事故的兜底）。
 *    第 3 条是补 2026-10-05 的漏：给 getPublicDonations / getFilterOptions 引入
 *    utils/cache.js（内含 require('node-cache')）时，两个门禁都报绿，
 *    但只要本函数 package.json 没声明 node-cache，部署后首次冷启动即 MODULE_NOT_FOUND
 *    ——这类问题只有部署才暴露，故必须在本地门禁就拦下。
 */
function verifyReferences(managedByFunc) {
  let mismatches = 0;
  let orphans = 0;
  let missingDeps = 0;
  let deepMissing = 0;

  for (const funcName of getCloudFunctionDirs()) {
    const managed = managedByFunc.get(funcName) || new Set();

    for (const required of scanEntryRequires(funcName)) {
      if (!fs.existsSync(path.join(CLOUD_DIR, funcName, required))) {
        console.warn(`缺少依赖: ${funcName}/${required}（index.js 已 require，部署时会 MODULE_NOT_FOUND）`);
        mismatches++;
      }
    }

    deepMissing += verifyDeepLocalRequires(funcName);

    // 收集本函数**实际被 require 链**上的托管副本里引用的第三方包。
    // 关键：不能遍历所有托管副本 —— cache.js 被同步到全部 55 个函数，
    // 但只有 3 个入口真正 require 它，其余是「复制了但没用」。
    // 遍历全部会产出 49 条误报，让门禁失去意义（被忽略的真问题也会一起被无视）。
    const declaredDeps = readDeclaredDeps(funcName);
    const thirdParty = new Set();
    for (const rel of managed) {
      const modPath = path.join(CLOUD_DIR, funcName, rel);
      if (!fs.existsSync(modPath)) continue;
      if (!isReachable(funcName, rel)) continue;
      for (const pkg of scanThirdPartyRequires(modPath)) {
        thirdParty.add(pkg);
      }
    }
    for (const pkg of thirdParty) {
      if (!declaredDeps.has(pkg)) {
        console.warn(`依赖未声明: ${funcName} 的副本 require 了 '${pkg}'，但 package.json 未声明（部署后冷启动 MODULE_NOT_FOUND）`);
        missingDeps++;
      }
    }

    for (const subDir of ['utils', 'common']) {
      const dirPath = path.join(CLOUD_DIR, funcName, subDir);
      if (!fs.existsSync(dirPath)) continue;
      for (const file of fs.readdirSync(dirPath)) {
        const rel = `${subDir}/${file}`;
        if (file.endsWith('.js') && !managed.has(rel)) {
          console.warn(`未受管副本: ${funcName}/${rel}（未登记在 managed-modules.js）`);
          orphans++;
        }
      }
    }
  }

  return { mismatches, orphans, missingDeps, deepMissing };
}

/** 读取某云函数 package.json 里声明的 dependencies 键（没有则视为空集） */
function readDeclaredDeps(funcName) {
  const pkgPath = path.join(CLOUD_DIR, funcName, 'package.json');
  if (!fs.existsSync(pkgPath)) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return new Set(Object.keys(pkg.dependencies || {}));
  } catch (e) {
    console.warn(`package.json 解析失败: ${funcName}/package.json`);
    return new Set();
  }
}

// require 解析缓存：funcName -> Map<相对模块路径, 是否从入口可达>
const reachableCache = new Map();

/**
 * 判断某个托管模块（如 'utils/cache.js'）是否真的从入口 index.js 可达。
 * 做法：从 index.js 出发做逐层 require 遍历（深度上限 5，防止循环引用）。
 * 不可达的副本只是「同步过来的冗余文件」，不构成运行时依赖，无需查它的外部依赖。
 */
function isReachable(funcName, rel) {
  return getReachableSet(funcName).has(rel);
}

/** 返回某云函数的「入口可达模块集合」（带缓存；供可达性判断与深层依赖校验共用） */
function getReachableSet(funcName) {
  if (!reachableCache.has(funcName)) {
    reachableCache.set(funcName, computeReachable(funcName));
  }
  return reachableCache.get(funcName);
}

/**
 * 去掉 JS 注释（块注释与行注释）——require 扫描专用。
 * 多数模块的头注释里有用法示例（如 response.js 的 `require('./utils/response')`），
 * 不剥注释会把示例调用当成真实依赖，n 个函数全部假阳性。
 */
function stripJsComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/**
 * 深层依赖校验（补 2026-10-16 的漏）：入口可达的每个本地模块，其自身的
 * require('./xxx') 也必须解析得到真实文件。历史事故：createShopOrder 的
 * virtualPay.js require('./subscribeQuota')，而 subscribeQuota 未登记到该函数的
 * targets —— verify 曾经全绿，部署后运行时才 MODULE_NOT_FOUND。
 * 解析规则与 computeReachable 一致：相对当前模块目录拼接，支持 .js、/index.js 与裸路径（如 .json）。
 */
function verifyDeepLocalRequires(funcName) {
  let missing = 0;
  for (const rel of getReachableSet(funcName)) {
    if (rel === 'index.js' || !rel.endsWith('.js')) continue;
    const abs = path.join(CLOUD_DIR, funcName, rel);
    let content;
    try {
      content = stripJsComments(fs.readFileSync(abs, 'utf-8'));
    } catch (e) {
      continue;
    }
    const re = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), spec)
      );
      const base = path.join(CLOUD_DIR, funcName, resolved);
      const candidates = [`${base}.js`, path.join(base, 'index.js'), base];
      if (!candidates.some((p) => fs.existsSync(p))) {
        console.warn(`缺少深层依赖: ${funcName}/${rel} require('${spec}') → ${resolved} 不存在（部署后运行时 MODULE_NOT_FOUND）`);
        missing++;
      }
    }
  }
  return missing;
}

function computeReachable(funcName) {
  const reachable = new Set();
  const queue = ['index.js'];
  const visited = new Set();
  let depthGuard = 0;

  while (queue.length > 0 && depthGuard++ < 200) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const abs = path.join(CLOUD_DIR, funcName, current);
    if (!fs.existsSync(abs) || !current.endsWith('.js')) continue;
    reachable.add(current);

    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch (e) {
      continue;
    }
    const re = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      // 解析 ./utils/cache → utils/cache（相对当前模块所在目录）
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(current), spec)
      );
      queue.push(resolved.endsWith('.js') ? resolved : `${resolved}.js`);
    }
  }

  return reachable;
}

// Node 内置模块 —— require 它们不需要在 package.json 声明
const NODE_BUILTINS = new Set([
  'fs', 'path', 'crypto', 'os', 'util', 'http', 'https', 'url', 'zlib',
  'stream', 'events', 'buffer', 'querystring', 'child_process', 'assert', 'vm'
]);

/**
 * 扫出文件里 require 的第三方包名（只保留包名部分，忽略子路径）。
 * 判据：以 './' '../' '/' 开头的都是本地路径，其余按包名处理。
 */
function scanThirdPartyRequires(filePath) {
  const found = new Set();
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return found;
  }
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    // 本地相对路径 / 绝对路径不是包名，不校验依赖
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (spec.startsWith('@')) {
      // scoped 包：@scope/name/subpath → 取前两段作为包名
      const pkg = spec.split('/').slice(0, 2).join('/');
      if (pkg.length > 1 && !NODE_BUILTINS.has(pkg)) found.add(pkg);
      continue;
    }
    const pkg = spec.split('/')[0];
    if (NODE_BUILTINS.has(pkg)) continue;
    found.add(pkg);
  }
  return found;
}

/**
 * 校验公共模块一致性。
 * 不一致、缺失、源文件缺失、以及「index.js 已 require 但文件不存在」都会让进程以非 0 退出，
 * 使 `npm run check` 与 CI 真正拦得住（此前 return 值被调用处丢弃，退出码恒为 0）。
 */
function verify() {
  console.log('验证公共模块一致性...\n');
  let mismatches = 0;

  const managedByFunc = buildManagedIndex();

  for (const { source, targets } of MANAGED_MODULES) {
    const srcPath = path.join(CLOUD_DIR, source);
    if (!fs.existsSync(srcPath)) {
      // 规范源文件都不在，无从比对——必须失败，否则等于放弃校验
      console.warn(`源文件缺失: ${source}`);
      mismatches++;
      continue;
    }

    const srcContent = fs.readFileSync(srcPath, 'utf-8');

    for (const funcName of targets) {
      const destPath = path.join(CLOUD_DIR, funcName, source);
      if (!fs.existsSync(destPath)) {
        console.warn(`缺失: ${funcName}/${source}`);
        mismatches++;
        continue;
      }

      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (srcContent !== destContent) {
        console.warn(`不一致: ${funcName}/${source}`);
        mismatches++;
      }
    }
  }

  // 缺 index.js 的目录必须报错：它不在 getCloudFunctionDirs() 里，
  // 上面所有按 targets 遍历的检查都覆盖不到，会成为整目录级的校验盲区
  for (const funcName of findDirsMissingIndex()) {
    console.warn(`云函数目录缺少 index.js: ${funcName}（部署单元残缺，两个门禁都会整目录漏掉它）`);
    mismatches++;
  }

  const reverse = verifyReferences(managedByFunc);
  mismatches += reverse.mismatches;
  const orphans = reverse.orphans;
  const missingDeps = reverse.missingDeps;
  const deepMissing = reverse.deepMissing;

  if (mismatches === 0 && orphans === 0 && missingDeps === 0 && deepMissing === 0) {
    console.log('所有公共模块一致\n');
  } else {
    const parts = [];
    if (mismatches > 0) parts.push(`${mismatches} 个不一致/缺失`);
    if (orphans > 0) parts.push(`${orphans} 个未受管副本`);
    if (missingDeps > 0) parts.push(`${missingDeps} 个依赖未声明`);
    if (deepMissing > 0) parts.push(`${deepMissing} 个深层依赖缺失`);
    console.log(`有 ${parts.join('、')}，请修复后重跑（副本问题运行 build-cloud.js）\n`);
  }

  if (mismatches > 0 || orphans > 0 || missingDeps > 0) {
    process.exitCode = 1;
  }

  return mismatches === 0 && orphans === 0 && missingDeps === 0;
}

const COMMANDS = ['copy', 'clean', 'verify', 'build'];

const command = process.argv[2];

// 未识别的命令必须显式报错，不能落进 default:
// default 是 build（copyUtils + verify），会就地写入 461 个副本文件；而「先复制再校验」
// 的一致性检查恒为真 —— 于是 `build-cloud.js --verify` 这类拼写（实测踩过）不会报错，
// 反而静默地把副本刷成与源一致，把本该发现的漂移掩盖掉。
if (command !== undefined && !COMMANDS.includes(command)) {
  console.error(`[ERROR] 未知命令: ${command}`);
  console.error(`        可用命令: ${COMMANDS.join(' | ')}（不带参数等同于 build）`);
  console.error('        仅做一致性检查请用 verify；copy/build 会就地写入副本。');
  process.exitCode = 1;
} else switch (command) {
  case 'copy':
    copyUtils();
    break;
  case 'clean':
    clean();
    break;
  case 'verify':
    // verify() 内部已在失败时设置 process.exitCode
    verify();
    break;
  case 'build':
  default:
    copyUtils();
    verify();
    break;
}
