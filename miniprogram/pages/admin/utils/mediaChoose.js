/**
 * utils/mediaChoose.js - 选图 API 的跨端兼容封装
 *
 * 为什么需要这一层：
 * wx.chooseMedia 在 **PC 端（Windows / Mac 微信及开发者工具）不被支持**：调用后既不触发
 * success 也不触发 fail，表现为「点了没反应」。社区已有对应反馈：
 *   - uni.chooseMedia 微信小程序 pc 端无法选择文件，手机端可以，无任何报错
 *   - chooseMedia: fail function not exist
 * 而本项目的管理端上传（添加猫咪的大头照、相册批量上传）原先全都直接调 wx.chooseMedia，
 * 且只传了 success —— 于是 PC 上一声不响地什么都不发生，用户无从判断是卡了还是没点中。
 *
 * 该 API 是 2.10.0 才引入的，同理在旧基础库上也不存在。降级目标 wx.chooseImage 虽然已被
 * 官方标记废弃，但在 PC 端与各基础库版本上都可用，是这里唯一可靠的兜底。
 *
 * 返回约定（两个 API 的返回结构不同，这里统一）：
 *   { ok: true,  files: [{ tempFilePath, size? }, ...] }  选择成功
 *   { ok: false, cancelled: true }                        用户主动取消（不是错误，勿提示）
 *   { ok: false, cancelled: false, error: {...} }         真实失败
 *
 * 权限/隐私类失败视为终态、不回退（见 isTerminalPickerError）：
 * 回退到另一个隐私 API 会再弹一次授权弹窗，且必然同样失败。
 */

const SUCCESS = 'ok';
const CANCELLED = 'cancel';

/** 单次选择上限（与 wx.chooseMedia 的 count 上限一致） */
const MAX_IMAGE_COUNT = 9;

/**
 * 规范化调用参数
 * @param {object} options
 * @param {number} [options.count] 选择数量上限
 * @param {string[]} [options.sourceType] 来源；PC 端会收敛为相册
 */
function buildOptions(options = {}) {
  const requested = Number(options.count) || 1;
  const count = Math.min(Math.max(1, requested), MAX_IMAGE_COUNT);
  // PC 端没有摄像头，「拍摄」入口点了同样会没反应，这里只留相册
  const sourceType = isPcPlatform() ? ['album'] : options.sourceType || ['album', 'camera'];
  return { count, sourceType };
}

/**
 * 是否 PC（Windows / Mac）端
 *
 * 两个用途：收敛 sourceType（PC 无摄像头），以及决定是否跳过 wx.chooseMedia
 * （PC 上它静默挂起，必须主动跳过而非等 fail 回退）。
 *
 * 判定失败时返回 false —— 即退化为「照常尝试 chooseMedia + 报错回退」的老路径，
 * 不会把能用的环境误判成 PC 而白白降级。
 */
function isPcPlatform() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    const platform = info && info.platform || '';
    return platform === 'windows' || platform === 'mac';
  } catch (e) {
    return false;
  }
}

/**
 * 该选图 API 是否可用
 *
 * canIUse 只回答「这个 API 是否存在」，不保证「调用后是否真的响应」——
 * PC 端的 chooseMedia 就能通过 canIUse 检查却静默无响应，故平台判定必须另行叠加
 * （见 shouldUseChooseMedia）。
 */
function isApiAvailable(name) {
  if (typeof wx[name] !== 'function') return false;
  // canIUse 缺失时按「函数存在即可用」处理：具体可用性仍由调用失败后的回退兜底
  if (typeof wx.canIUse !== 'function') return true;
  try {
    return wx.canIUse(name);
  } catch (e) {
    return false;
  }
}

/** 用户取消：两个 API 的 errMsg 分别为 cancel / chooseMedia:fail cancel */
function isCancelled(err) {
  const msg = err && err.errMsg || '';
  return msg.includes(CANCELLED);
}

/**
 * 权限/隐私类失败：视为终态，不再回退。
 *
 * chooseMedia 与 chooseImage 都是隐私接口。前者因隐私授权/系统权限被拒时，
 * 立即回退后者只会再走一次授权流程（真机表现：「弹两次授权弹窗 → 最终失败」，
 * 报错 privacy permission is not authorized 被错误文案映射成「您没有权限执行此操作」）；
 * 且权限是平台级状态，换个 API 也不会成功。
 */
const TERMINAL_ERROR_PATTERN = /privacy|permission|权限|未授权/i;

function isTerminalPickerError(error) {
  return TERMINAL_ERROR_PATTERN.test(String(error || ''));
}

/** 失败信息里带上取用过的 API，便于区分「回退也失败」与「首个 API 就失败」 */
function describeError(err) {
  return err && err.errMsg || err && err.message || '未知错误';
}

/** wx.chooseMedia 分支 */
function pickViaChooseMedia({ count, sourceType }) {
  return new Promise((resolve) => {
    try {
      wx.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType,
        sizeType: ['compressed'],
        success: (res) => {
          const files = res && res.tempFiles;
          resolve(
            Array.isArray(files) && files.length > 0
              ? { status: SUCCESS, files }
              : { status: CANCELLED }
          );
        },
        fail: (err) => resolve({
          status: isCancelled(err) ? CANCELLED : 'fail',
          error: describeError(err)
        })
      });
    } catch (err) {
      resolve({ status: 'fail', error: describeError(err) });
    }
  });
}

/** wx.chooseImage 分支（旧 API，PC 端可用） */
function pickViaChooseImage({ count, sourceType }) {
  return new Promise((resolve) => {
    const onSuccess = (res) => {
      const paths = res && res.tempFilePaths || [];
      resolve(
        paths.length > 0
          ? { status: SUCCESS, files: paths.map((tempFilePath) => ({ tempFilePath })) }
          : { status: CANCELLED }
      );
    };
    const onFail = (err) => resolve({
      status: isCancelled(err) ? CANCELLED : 'fail',
      error: describeError(err)
    });

    try {
      const ret = wx.chooseImage({ count, sizeType: ['compressed'], sourceType, success: onSuccess, fail: onFail });
      // 该 API 在部分基础库下会返回 Promise；此时回调不生效，须从 Promise 取值
      if (ret && typeof ret.then === 'function') {
        ret.then(onSuccess).catch(onFail);
      }
    } catch (err) {
      resolve({ status: 'fail', error: describeError(err) });
    }
  });
}

/**
 * 是否需要走 wx.chooseMedia
 *
 * PC 端必须**主动跳过**它，而不是「调用后等 fail 再回退」：PC 上该 API 是静默挂起 ——
 * 既不触发 success 也不触发 fail，Promise 永不 settle，回退分支根本没机会执行。
 */
function shouldUseChooseMedia() {
  if (!isApiAvailable('chooseMedia')) return false;
  return !isPcPlatform();
}

/**
 * 选图（手机端优先 chooseMedia，PC 端或该 API 不可用时自动降级 chooseImage）
 * @param {object} [options] 见 buildOptions
 * @returns {Promise<{ok: boolean, files?: Array, cancelled?: boolean, error?: object}>}
 */
async function pickImages(options) {
  const normalized = buildOptions(options);

  if (shouldUseChooseMedia()) {
    const media = await pickViaChooseMedia(normalized);
    if (media.status === SUCCESS) {
      return { ok: true, files: media.files };
    }
    if (media.status === CANCELLED) {
      return { ok: false, cancelled: true };
    }
    // 权限/隐私类失败直接返回：回退到另一个隐私 API 只会再弹一次授权弹窗
    if (isTerminalPickerError(media.error)) {
      return { ok: false, error: { errMsg: `选图失败：${media.error}` } };
    }
    // 真的报错（而非静默挂起）时继续尝试旧 API，而不是直接放弃
    return fallbackToChooseImage(normalized, media.error);
  }

  return fallbackToChooseImage(normalized, null);
}

async function fallbackToChooseImage(normalized, firstError) {
  if (!isApiAvailable('chooseImage')) {
    // firstError 为空表示本就没尝试 chooseMedia（PC 端主动跳过或该 API 不存在），
    // 此时不该把它写进错误里，否则会误导排查方向
    const reason = firstError ? `chooseMedia（${firstError}）、` : '';
    return {
      ok: false,
      error: { errMsg: `选图失败：${reason}当前环境不支持 chooseImage` }
    };
  }

  const legacy = await pickViaChooseImage(normalized);
  if (legacy.status === SUCCESS) {
    return { ok: true, files: legacy.files };
  }
  if (legacy.status === CANCELLED) {
    return { ok: false, cancelled: true };
  }
  return { ok: false, error: { errMsg: `选图失败：${legacy.error}` } };
}

module.exports = {
  pickImages,
  isApiAvailable,
  isPcPlatform,
  shouldUseChooseMedia,
  MAX_IMAGE_COUNT
};
