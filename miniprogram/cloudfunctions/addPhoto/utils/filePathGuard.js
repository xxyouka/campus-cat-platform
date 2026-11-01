/**
 * cloudfunctions/utils/filePathGuard.js - 云存储路径白名单
 *
 * 背景：云函数用 getTempFileURL 为 fileID 签发临时下载链接时，fileID 可能来自客户端
 * （如 getCatAvatars 的 fileIDs、compressImages 的 fileID）。若不校验路径，调用者
 * 只要知道文件位置，就能为任意云存储对象换取可直接读取的临时链接——包括
 * backups/ 下的全量数据快照与 exports/ 下的导出文件。
 *
 * 因此这里只放行业务目录，其余（含 backups/、exports/）一律拒绝。
 */

const path = require('path');

// 业务上传目录白名单（与各端 uploadFile 的 cloudPath 前缀保持一致）：
//   cats/avatar/**      猫咪头像（pages/admin/add-cat、pages/admin/edit-cat）
//   photos/**           相册图片（pages/admin/photo-manage/album-detail）
// 显式排除 backups/（全量备份，含用户数据）与 exports/（数据导出）。
const ALLOWED_STORAGE_PREFIXES = ['cats/', 'photos/'];

// 云存储对象路径允许出现的字符。
// 收紧到白名单（而不是黑名单）是为了在进入任何判定之前就拒掉控制字符、反斜杠、
// 空白等——它们既不在业务 cloudPath 里出现，也无从解释为合法路径。
//
// 放行中日韩文字与全角标点：管理员上传的文件名可能包含中文。
// 这里用「排除危险类」而非「列举安全类」：放行除控制字符/空白/反斜杠以外的一切字符。
const UNSAFE_STORAGE_PATH_CHARS = /[\u0000-\u001f\u007f\s\\]/;

/**
 * 从 cloud:// fileID 中取出云存储对象路径
 * fileID 形如 cloud://<envId>.<bucketId>/<path>，取第一个 "/" 之后的全部内容
 * @param {string} fileID
 * @returns {string} 对象路径；无法解析时返回空字符串
 */
function extractStoragePath(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) return '';
  const rest = fileID.slice('cloud://'.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) return '';
  return rest.slice(slashIndex + 1);
}

/**
 * 安全归一化云存储对象路径：解码 → 拒绝危险字符/穿越 → posix 归一化。
 * 返回归一化后的路径；任何一步不通过返回 ''（调用方按拒绝处理）。
 *
 * 对抗性审核 P2-1 实测：旧实现只用裸字符串比较，`cats/%2e%2e/%2e%2e/backups/x`
 * 会被 startsWith('cats/') 放行（云存储取对象时会先做一次百分号解码，于是真的
 * 逃到 backups/）。因此判定顺序固定为：
 *   1. 先 decodeURIComponent 一次，把 `%2e%2e` 还原成 `..` 再判；
 *   2. 解码抛错（非法百分号序列）、或解码后仍含 '%'（双重编码，一次还原不了）
 *      → 直接拒绝；
 *   3. 拒绝控制字符、空白、反斜杠（放行中文等非 ASCII 字符，见 UNSAFE_STORAGE_PATH_CHARS 注释）；
 *   4. 拒绝 '..' 段；
 *   5. 用 path.posix.normalize 归一化，防止 `./`、`//` 等写法在归一化后才暴露真实目标目录。
 *
 * @param {string} storagePath 已从 fileID 中取出的对象路径（不含 bucket）
 * @returns {string} 归一化路径；不安全时返回 ''
 */
function normalizeStoragePath(storagePath) {
  if (typeof storagePath !== 'string' || storagePath.length === 0) return '';

  let decoded;
  try {
    decoded = decodeURIComponent(storagePath);
  } catch (err) {
    return '';
  }
  if (decoded.includes('%')) return '';
  if (UNSAFE_STORAGE_PATH_CHARS.test(decoded)) return '';
  // 拒绝路径穿越写法，避免 SDK 归一化后逃逸出白名单目录
  if (decoded.includes('..')) return '';

  const normalized = path.posix.normalize(decoded);
  // 归一化结果不得是绝对路径、也不得向上逃逸（纵深防御：上面已拒绝 '..'）
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    return '';
  }
  return normalized;
}

/**
 * 判断云存储对象路径是否落在白名单目录内。
 * @param {string} storagePath 已从 fileID 中取出的对象路径（不含 bucket）
 * @returns {boolean}
 */
function isAllowedStoragePath(storagePath) {
  const normalized = normalizeStoragePath(storagePath);
  return !!normalized && ALLOWED_STORAGE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * 判断云存储对象路径是否落在**调用方指定**的目录内。
 *
 * 用途：写操作（addPhoto / addCat / updateCat）在「检测失败就删文件」之前，
 * 必须把可删范围收窄到本业务目录 —— 只允许 `photos/`（照片）或 `cats/`（头像），
 * 而不是 filePathGuard 的全量业务白名单。否则普通管理员
 * 可以传入任意已知 fileID（如他人照片、头像），让检测必然失败并触发服务端删除，
 * 形成「任意文件删除」原语。
 *
 * @param {string} storagePath 已从 fileID 中取出的对象路径（不含 bucket）
 * @param {string[]} prefixes 允许的前缀（如 ['photos/']）
 * @returns {boolean}
 */
function isAllowedStoragePathUnder(storagePath, prefixes) {
  const normalized = normalizeStoragePath(storagePath);
  if (!normalized) return false;
  const list = Array.isArray(prefixes) ? prefixes : [];
  return list.some(prefix => normalized.startsWith(prefix));
}

/**
 * 判断 fileID 是否指向业务目录下的文件（可直接为 false 表示拒绝）
 * @param {string} fileID
 * @returns {boolean}
 */
function isAllowedStorageFile(fileID) {
  return isAllowedStoragePath(extractStoragePath(fileID));
}

/**
 * 判断 fileID 是否指向**指定**业务目录下的文件
 * @param {string} fileID
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function isAllowedStorageFileUnder(fileID, prefixes) {
  return isAllowedStoragePathUnder(extractStoragePath(fileID), prefixes);
}

/**
 * 把 fileID 列表拆成「放行」与「被拒绝」两组，保持原顺序并去重。
 *
 * 关于「静默丢弃」：非字符串项、以及不以 `cloud://` 开头的项**完全不参与计数**
 * （既不入 allowed 也不入 rejected，与旧行为一致，调用方无需为客户端传来的
 * 脏数据做展示）；只有 cloud:// 且不在白名单目录下的项才会如实进入 rejected。
 * @param {string[]} fileIDs
 * @returns {{allowed: string[], rejected: string[]}}
 */
function splitByStoragePath(fileIDs) {
  const allowed = [];
  const rejected = [];
  const seen = new Set();
  const list = Array.isArray(fileIDs) ? fileIDs : [];

  for (const fileID of list) {
    if (typeof fileID !== 'string' || !fileID.startsWith('cloud://') || seen.has(fileID)) {
      // 非 cloud:// 项原样跳过，不参与计数（与旧行为一致）
      continue;
    }
    seen.add(fileID);
    if (isAllowedStorageFile(fileID)) {
      allowed.push(fileID);
    } else {
      rejected.push(fileID);
    }
  }

  return { allowed, rejected };
}

module.exports = {
  ALLOWED_STORAGE_PREFIXES,
  extractStoragePath,
  normalizeStoragePath,
  isAllowedStoragePath,
  isAllowedStoragePathUnder,
  isAllowedStorageFile,
  isAllowedStorageFileUnder,
  splitByStoragePath
};
