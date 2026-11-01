/**
 * __tests__/pages/admin/imageCompressor.test.js
 *
 * 覆盖 compressToLimit —— 它的存在理由是云函数 contentSecurity.IMAGE_MAX_BYTES：
 * imgSecCheck v2 按**服务端下载的实际字节数**判定，超过 1M 一律拒绝，且拒绝发生在
 * 文件已经上传到云存储之后。所以「压了但没压到 1M 以内」等于白压。
 *
 * 本文件钉死的行为：
 *   1. 原图已达标 → 一次压缩都不做；
 *   2. 未达标 → 按档位递减，达标即停（不做无谓的后续压缩）；
 *   3. 档位用尽仍超标 → 如实返回 withinLimit:false，让调用方拦住上传；
 *   4. 压缩失败 → 回退原图而不是抛错（否则整张照片上传失败）。
 *
 * 注意：档位是「不放大」的 —— 输出边长取 min(原图边长, 档位上限)。
 * 因此用 3000px 原图，三档才会分别落到 1600 / 1200 / 1024。
 */

const { compressToLimit, compressImage } = require('../../../pages/admin/utils/imageCompressor');

const MB = 1024 * 1024;
const ORIGIN = '/tmp/origin.jpg';

/**
 * 安装 wx 桩
 * @param {object} options
 * @param {Function} options.describeSize  filePath → 字节数
 * @param {number}   [options.sourceWidth] 原图边长（方形）
 */
function installWxMocks({ describeSize = () => 1000, sourceWidth = 3000 } = {}) {
  wx.getFileInfo = jest.fn(({ filePath, success, fail }) => {
    Promise.resolve().then(() => {
      if (typeof success === 'function') success({ size: describeSize(filePath) });
      else if (typeof fail === 'function') fail(new Error('getFileInfo fail'));
    });
  });

  wx.getImageInfo = jest.fn(({ src }) =>
    Promise.resolve({ width: sourceWidth, height: sourceWidth, path: src }));

  // createImage 必须返回一个「设置 src 后触发 onload」的对象：
  // 实现的 compressWithCanvas 用 `await new Promise((resolve, reject) => {
  // img.onload = resolve; img.onerror = reject; img.src = filePath; })` 等图加载完成，
  // 若桩返回空对象则 onload 永不触发，Promise 永不 settle，用例必然超时。
  wx.createOffscreenCanvas = jest.fn(({ width, height }) => ({
    width,
    height,
    getContext: jest.fn(() => ({ drawImage: jest.fn() })),
    createImage: jest.fn(() => {
      const img = {};
      Object.defineProperty(img, 'src', {
        set() {
          // 真实环境里 src 赋值后异步触发 onload；这里用微任务模拟，保持 Promise 时序
          Promise.resolve().then(() => {
            if (typeof img.onload === 'function') img.onload();
          });
        }
      });
      return img;
    })
  }));

  // 输出文件名由 destWidth 决定（方形图），据此让 describeSize 能按档位返回不同体积。
  // fail 回调也走 Promise 微任务，与真实 canvasToTempFilePath 的异步行为一致
  wx.canvasToTempFilePath = jest.fn((opts = {}) => {
    const { destWidth, success, fail } = opts;
    Promise.resolve().then(() => {
      if (typeof success === 'function') {
        success({ tempFilePath: `/tmp/c_${destWidth}.jpg` });
      } else if (typeof fail === 'function') {
        fail(new Error('canvasToTempFilePath 未提供 success'));
      }
    });
  });

  wx.getNetworkType = jest.fn(({ success }) => success({ networkType: 'wifi' }));
}

describe('pages/admin/utils/imageCompressor', () => {
  let originalApis;

  beforeEach(() => {
    originalApis = {
      getFileInfo: wx.getFileInfo,
      getImageInfo: wx.getImageInfo,
      createOffscreenCanvas: wx.createOffscreenCanvas,
      canvasToTempFilePath: wx.canvasToTempFilePath,
      getNetworkType: wx.getNetworkType
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(wx, originalApis);
  });

  describe('compressToLimit', () => {
    test('原图已在上限内：不做任何压缩', async () => {
      installWxMocks({ describeSize: () => 300 * 1024 });

      const res = await compressToLimit(ORIGIN, MB);

      expect(res).toEqual({ path: ORIGIN, size: 300 * 1024, withinLimit: true });
      expect(wx.canvasToTempFilePath).not.toHaveBeenCalled();
    });

    test('未达标时按档位递减，达标即停', async () => {
      // 3000px 原图 2M → 档1(1600px) 1.5M 仍超 → 档2(1200px) 800K 达标
      const sizes = {
        [ORIGIN]: 2 * MB,
        '/tmp/c_1600.jpg': 1.5 * MB,
        '/tmp/c_1200.jpg': 800 * 1024
      };
      installWxMocks({ describeSize: (p) => sizes[p] });

      const res = await compressToLimit(ORIGIN, MB);

      expect(res.withinLimit).toBe(true);
      expect(res.path).toBe('/tmp/c_1200.jpg');
      expect(res.size).toBe(800 * 1024);
      // 达标后不得再压第三档
      expect(wx.canvasToTempFilePath).toHaveBeenCalledTimes(2);
      expect(wx.canvasToTempFilePath.mock.calls[0][0].destWidth).toBe(1600);
      expect(wx.canvasToTempFilePath.mock.calls[1][0].destWidth).toBe(1200);
    });

    test('档位用尽仍超标：如实返回 withinLimit:false 与最后一版路径', async () => {
      const sizes = {
        [ORIGIN]: 6 * MB,
        '/tmp/c_1600.jpg': 4 * MB,
        '/tmp/c_1200.jpg': 3 * MB,
        '/tmp/c_1024.jpg': 2 * MB
      };
      installWxMocks({ describeSize: (p) => sizes[p] });

      const res = await compressToLimit(ORIGIN, MB);

      expect(res.withinLimit).toBe(false);
      expect(res.path).toBe('/tmp/c_1024.jpg');
      expect(res.size).toBe(2 * MB);
      expect(wx.canvasToTempFilePath).toHaveBeenCalledTimes(3);
    });

    test('getFileInfo 不可用：不因「读不到大小」而放行，压满档位后按超标处理', async () => {
      installWxMocks();
      wx.getFileInfo = undefined;

      const res = await compressToLimit(ORIGIN, MB);

      expect(res.withinLimit).toBe(false);
      expect(wx.canvasToTempFilePath).toHaveBeenCalledTimes(3);
    });

    // 前两档连 success 和 fail 都不回调 —— 模拟 PC 端离屏 Canvas 不可用时的静默挂起。
    // compressWithCanvas 靠 withTimeout 兜住：15s 后 reject → catch 回退原图继续下一档。
    // 这里用假定时器把 15s 压成瞬时，验证「超时回退」这条契约而不真的等 15 秒。
    test('Canvas 静默挂起时超时回退原图，不死锁整条压缩链路', async () => {
      jest.useFakeTimers();
      try {
        installWxMocks({
          // 挂起时返回原图路径，故前两轮读到的都是原图体积；只有第三档真出图才达标
          describeSize: (p) => p === '/tmp/c_1024.jpg' ? 500 * 1024 : 3 * MB
        });
        let canvasCalls = 0;
        wx.canvasToTempFilePath = jest.fn(({ destWidth, success }) => {
          canvasCalls++;
          if (canvasCalls < 3) return; // 前两档静默挂起：两个回调都不触发
          Promise.resolve().then(() => success({ tempFilePath: `/tmp/c_${destWidth}.jpg` }));
        });

        const pending = compressToLimit(ORIGIN, MB);
        // 推进假定时器，让三次 15s 超时依次到期
        await jest.advanceTimersByTimeAsync(60 * 1000);
        const res = await pending;

        expect(canvasCalls).toBe(3);
        expect(res.withinLimit).toBe(true);
        expect(res.path).toBe('/tmp/c_1024.jpg');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('compressImage 的失败回退契约', () => {
    test('Canvas 压缩失败时返回原图，而不是抛错', async () => {
      installWxMocks();
      wx.canvasToTempFilePath = jest.fn(({ fail }) => fail(new Error('canvas unavailable')));

      const out = await compressImage(ORIGIN, { maxWidth: 1600, maxHeight: 1600, quality: 75 });

      expect(out).toBe(ORIGIN);
    });
  });
});
