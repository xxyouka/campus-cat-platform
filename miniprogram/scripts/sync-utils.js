/**
 * scripts/sync-utils.js
 *
 * Syncs the canonical cloud function modules from cloudfunctions/ (utils/ and
 * common/) to each cloud function's local directory.
 *
 * The managed module list lives in scripts/managed-modules.js and is shared
 * with build-cloud.js, so both scripts copy and verify exactly the same set of
 * modules. Previously contentSecurity.js, beijingTime.js and
 * common/operationLogger.js were only checked by build-cloud.js, and the two
 * scripts could disagree about which modules were in scope.
 *
 * Usage:
 *   node scripts/sync-utils.js            # Copy canonical files to all cloud functions
 *   node scripts/sync-utils.js --check    # Report differences only, exit 1 if any found
 *   node scripts/sync-utils.js --force    # Explicitly force overwrite (same as default)
 */

const fs = require('fs');
const path = require('path');

const {
  CLOUD_FUNCTIONS_DIR,
  MANAGED_MODULES,
  getCloudFunctionDirs,
  findDirsMissingIndex
} = require('./managed-modules');

// --- Helpers ---

/**
 * Read the canonical module files from cloudfunctions/.
 * Returns an object mapping relative source path -> content (utf-8).
 */
function readCanonicalFiles() {
  const files = {};
  for (const { source } of MANAGED_MODULES) {
    const filePath = path.join(CLOUD_FUNCTIONS_DIR, source);
    if (!fs.existsSync(filePath)) {
      console.error(`[ERROR] Canonical file missing: ${filePath}`);
      process.exit(1);
    }
    files[source] = fs.readFileSync(filePath, 'utf-8');
  }
  return files;
}

/**
 * Compute diffs between the canonical files and each cloud function's copies.
 * Each module only applies to the cloud functions listed in its `targets`
 * (null targets were already expanded to every cloud function by
 * managed-modules.js).
 * Returns an array of { dirName, added, modified, unchanged }.
 */
function computeDiffs(canonicalFiles) {
  const byFunction = new Map(
    getCloudFunctionDirs().map((name) => [
      name,
      { dirName: name, added: [], modified: [], unchanged: [] }
    ])
  );

  for (const { source, targets } of MANAGED_MODULES) {
    for (const dirName of targets) {
      const entry = byFunction.get(dirName);
      if (!entry) {
        console.warn(`[WARN] Not a cloud function directory, skipped: ${dirName} (${source})`);
        continue;
      }

      const destPath = path.join(CLOUD_FUNCTIONS_DIR, dirName, source);
      if (!fs.existsSync(destPath)) {
        entry.added.push(source);
      } else if (fs.readFileSync(destPath, 'utf-8') !== canonicalFiles[source]) {
        entry.modified.push(source);
      } else {
        entry.unchanged.push(source);
      }
    }
  }

  return [...byFunction.values()];
}

// --- Commands ---

/**
 * --check mode: report differences, exit code 1 if any found.
 */
function checkSync(diffs) {
  let anyDifferences = false;

  for (const { dirName, added, modified, unchanged } of diffs) {
    if (added.length === 0 && modified.length === 0) {
      continue;
    }

    anyDifferences = true;
    const parts = [];
    if (added.length > 0) parts.push(`missing: ${added.join(', ')}`);
    if (modified.length > 0) parts.push(`modified: ${modified.join(', ')}`);
    console.log(`[DIFF] ${dirName}/ - ${parts.join('; ')}`);
    if (unchanged.length > 0) {
      console.log(`       (${unchanged.length} file(s) unchanged)`);
    }
  }

  if (!anyDifferences) {
    console.log('[OK] All cloud function copies are in sync with canonical sources.');
  } else {
    console.log('\n[DONE] Differences found. Run without --check to sync.');
    process.exitCode = 1;
  }
}

/**
 * Sync mode: copy canonical files to each cloud function's local directory.
 */
function syncUtils(canonicalFiles, diffs) {
  let totalCopied = 0;

  for (const { dirName, added, modified, unchanged } of diffs) {
    const filesToCopy = [...added, ...modified];

    if (filesToCopy.length === 0) {
      if (unchanged.length > 0) {
        console.log(`[SKIP] ${dirName}/ - already in sync (${unchanged.length} files)`);
      }
      continue;
    }

    for (const source of filesToCopy) {
      const destPath = path.join(CLOUD_FUNCTIONS_DIR, dirName, source);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, canonicalFiles[source], 'utf-8');
      const status = added.includes(source) ? 'ADDED' : 'UPDATED';
      console.log(`[${status}] ${dirName}/${source}`);
      totalCopied++;
    }

    if (unchanged.length > 0) {
      console.log(`        (${unchanged.length} file(s) unchanged)`);
    }
  }

  console.log(`\n[DONE] Synced ${totalCopied} file(s) across ${diffs.length} cloud function(s).`);
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);

  // 未识别的参数必须显式报错，不能默认落进 sync（覆盖）分支：
  // 「先覆盖再比对」的一致性检查恒为真 —— 一次手滑拼错（--Check / --dry-run / --force）
  // 就会把副本刷成与源一致，让 build-cloud:verify 与 verify-sync 两个门禁同时变绿，
  // 把本该发现的漂移掩盖掉。与 build-cloud.js 的未知命令守卫同因同源。
  const KNOWN_FLAGS = ['--check'];
  const unknownFlags = args.filter((a) => !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length > 0) {
    console.error(`[ERROR] 未知参数: ${unknownFlags.join(' ')}`);
    console.error(`        可用参数: ${KNOWN_FLAGS.join(' | ')}（不带参数等同于 sync，会就地覆盖副本）`);
    console.error('        仅做只读检查请用 --check。');
    process.exitCode = 1;
    return;
  }

  const checkMode = args.includes('--check');

  console.log(`[INFO] Canonical source: ${CLOUD_FUNCTIONS_DIR}`);
  console.log(`[INFO] Mode: ${checkMode ? 'check (read-only)' : 'sync (overwrite)'}\n`);

  // Read canonical files
  const canonicalFiles = readCanonicalFiles();
  console.log(`[INFO] Read ${Object.keys(canonicalFiles).length} canonical file(s).`);

  // 缺 index.js 的目录不在 getCloudFunctionDirs() 里，computeDiffs 也不会扫它，
  // 必须单独报出来，否则整目录级的偏差会被无声放过
  const missingIndex = findDirsMissingIndex();
  if (missingIndex.length > 0) {
    for (const name of missingIndex) {
      console.error(`[ERROR] Cloud function directory missing index.js: ${name}`);
    }
    process.exitCode = 1;
  }

  if (getCloudFunctionDirs().length === 0) {
    // 扫描范围为零时「没有差异」是废话而非通过，必须失败
    console.error('[ERROR] No cloud function directories found.');
    process.exitCode = 1;
    return;
  }

  const diffs = computeDiffs(canonicalFiles);
  console.log(`[INFO] Scanned ${diffs.length} cloud function(s).\n`);

  if (checkMode) {
    checkSync(diffs);
  } else {
    syncUtils(canonicalFiles, diffs);
  }
}

main();
