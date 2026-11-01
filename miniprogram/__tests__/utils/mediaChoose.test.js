/**
 * __tests__/utils/mediaChoose.test.js
 *
 * utils/mediaChoose.js 修复的是「PC 端点击上传大头照完全没反应」：
 * wx.chooseMedia 在 PC 端既不触发 success 也不触发 fail，而调用侧原先只传了 success，
 * 于是失败被彻底吞掉。本文件把这个降级契约钉死：
 *
 *   1. chooseMedia 报错（PC 端/旧基础库）→ 必须回退 wx.chooseImage，且结果结构统一；
 *   2. 用户主动取消 → 不得回退重试（会二次弹选择器），也不得当成错误提示；
 *   3. 权限/隐私类失败 → 同样不得回退（chooseImage 是另一个隐私接口，回退只会再弹一次
 *      授权弹窗且必然同样失败）；真机旧症状即「弹两次授权弹窗 → 您没有权限执行此操作」；
 *   4. 两个 API 都不可用 → 返回可展示的错误，不允许静默返回空。
 */

const {
  pickImages,
  isApiAvailable,
  isPcPlatform,
  shouldUseChooseMedia,
  MAX_IMAGE_COUNT
} = require('../../pages/admin/utils/mediaChoose');

/** 让 chooseMedia 以「PC 端式」失败：只有 fail，没有 success */
function failChooseMedia(errMsg = 'chooseMedia:fail api is not supported on pc') {
  wx.chooseMedia.mockImplementation((opts) => {
    if (opts.fail) opts.fail({ errMsg });
  });
}

function succeedChooseMedia(path = '/tmp/media.jpg') {
  wx.chooseMedia.mockImplementation((opts) => {
    opts.success({ tempFiles: [{ tempFilePath: path, size: 1024 }] });
  });
}

function succeedChooseImage(path = '/tmp/legacy.jpg') {
  wx.chooseImage.mockImplementation((opts) => {
    opts.success({ tempFilePaths: [path] });
  });
}

describe('utils/mediaChoose', () => {
  beforeEach(() => {
    // 用 resetWxStubs 而非 jest.clearAllMocks()：后者保留调用记录但对实现无能为力，
    // 而本套件会在用例里覆盖 wx.getDeviceInfo / wx.chooseMedia 等桩的默认实现。
    // resetWxStubs 会把 setup.js 登记的默认值装回去，保证「未显式指定」的环境判定
    // （canIUse / platform）与本套件其他用例一致，不会因执行顺序而漂移。
    resetWxStubs();
    wx.canIUse.mockReturnValue(true);
  });

  describe('pickImages —— chooseMedia 可用时', () => {
    test('直接返回 chooseMedia 的结果，不触碰 chooseImage', async () => {
      succeedChooseMedia('/tmp/a.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(true);
      expect(res.files[0].tempFilePath).toBe('/tmp/a.jpg');
      expect(wx.chooseImage).not.toHaveBeenCalled();
    });

    test('用户取消不视为错误，且不回退重试（否则会二次弹选择器）', async () => {
      failChooseMedia('chooseMedia:fail cancel');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(false);
      expect(res.cancelled).toBe(true);
      expect(res.error).toBeUndefined();
      expect(wx.chooseImage).not.toHaveBeenCalled();
    });

    test('隐私授权失败（privacy permission）不回退：不得再弹第二次授权弹窗', async () => {
      failChooseMedia('chooseMedia:fail privacy permission is not authorized');
      // 若发生回退，chooseImage 会「成功」；用它反证回退未发生
      succeedChooseImage('/tmp/should-not-happen.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(false);
      expect(res.cancelled).toBeFalsy();
      expect(res.error.errMsg).toContain('privacy permission');
      expect(wx.chooseImage).not.toHaveBeenCalled();
    });

    test('系统权限类失败（中文「权限」）同样不回退', async () => {
      failChooseMedia('chooseMedia:fail 系统权限未授予');
      succeedChooseImage('/tmp/should-not-happen.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(false);
      expect(res.error.errMsg).toContain('权限');
      expect(wx.chooseImage).not.toHaveBeenCalled();
    });

    test('success 但 tempFiles 为空，同样按取消处理', async () => {
      wx.chooseMedia.mockImplementation((opts) => opts.success({ tempFiles: [] }));

      const res = await pickImages({ count: 1 });

      expect(res.cancelled).toBe(true);
      expect(res.ok).toBe(false);
    });

    test('同步抛错也要降级，不能让异常冒泡到页面点击处理里', async () => {
      wx.chooseMedia.mockImplementation(() => { throw new Error('boom'); });
      succeedChooseImage('/tmp/fallback.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(true);
      expect(res.files[0].tempFilePath).toBe('/tmp/fallback.jpg');
    });
  });

  describe('pickImages —— PC 端降级路径（本次缺陷的回归点）', () => {
    test('PC 端直接跳过 chooseMedia（它在 PC 上是静默挂起，等 fail 回退永远等不到）', async () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'windows' });
      // 模拟真实 PC 行为：调用后没有任何回调，Promise 永不 settle。
      // 若实现退化成「先调 chooseMedia 再等 fail」，本用例将挂起直到 jest 超时。
      wx.chooseMedia.mockImplementation(() => {});
      succeedChooseImage('/tmp/pc-direct.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(true);
      expect(res.files[0].tempFilePath).toBe('/tmp/pc-direct.jpg');
      expect(wx.chooseMedia).not.toHaveBeenCalled();
    });

    test('chooseMedia 报错时回退 chooseImage 并返回统一结构', async () => {
      failChooseMedia();
      succeedChooseImage('/tmp/pc.jpg');

      const res = await pickImages({ count: 1 });

      expect(wx.chooseMedia).toHaveBeenCalled();
      expect(wx.chooseImage).toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.files).toEqual([{ tempFilePath: '/tmp/pc.jpg' }]);
    });

    // 模拟「API 不存在」时不要 delete wx.chooseMedia ——那是在破坏全局桩对象，
    // 恢复时赋值回去的可能是已被 resetWxStubs 重置过的桩，跨用例互相污染。
    // 改成把桩置为 undefined：isApiAvailable 用typeof 检查存在性，语义等价且无副作用。
    test('chooseMedia 完全不存在（旧基础库）时直接用 chooseImage', async () => {
      wx.chooseMedia = undefined;
      succeedChooseImage('/tmp/old-lib.jpg');

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(true);
      expect(res.files[0].tempFilePath).toBe('/tmp/old-lib.jpg');
      expect(wx.chooseImage).toHaveBeenCalled();
    });

    test('chooseImage 走 Promise 形态时也能取到结果（部分基础库返回 Promise）', async () => {
      failChooseMedia();
      wx.chooseImage.mockImplementation(() => Promise.resolve({ tempFilePaths: ['/tmp/promise.jpg'] }));

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(true);
      expect(res.files[0].tempFilePath).toBe('/tmp/promise.jpg');
    });

    test('chooseImage 也失败时返回带原因的 error，绝不静默成功', async () => {
      failChooseMedia();
      wx.chooseImage.mockImplementation((opts) => opts.fail({ errMsg: 'chooseImage:fail no permission' }));

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(false);
      expect(res.cancelled).toBeFalsy();
      expect(res.error.errMsg).toContain('no permission');
    });

    // 同样不 delete：置undefined 即可表达「API 不存在」，且不会破坏桩对象
    test('chooseMedia 不可用且 chooseImage 也不可用：给出可展示的错误', async () => {
      wx.canIUse.mockImplementation(() => false);
      wx.chooseMedia = undefined;
      wx.chooseImage = undefined;

      const res = await pickImages({ count: 1 });

      expect(res.ok).toBe(false);
      expect(res.error.errMsg).toContain('chooseImage');
    });

    test('chooseImage 分支的用户取消同样识别为取消', async () => {
      failChooseMedia();
      wx.chooseImage.mockImplementation((opts) => opts.fail({ errMsg: 'chooseImage:fail cancel' }));

      const res = await pickImages({ count: 1 });

      expect(res.cancelled).toBe(true);
      expect(res.ok).toBe(false);
    });
  });

  describe('参数规范化', () => {
    test('count 向上钳制到 9（与 wx API 上限一致）', async () => {
      succeedChooseMedia();

      await pickImages({ count: 100 });

      expect(wx.chooseMedia.mock.calls[0][0].count).toBe(MAX_IMAGE_COUNT);
    });

    test('count 非法时回退为 1（0 / 负数 / 非数字）', async () => {
      succeedChooseMedia();

      await pickImages({ count: 0 });
      await pickImages({ count: -3 });
      await pickImages({ count: 'abc' });
      await pickImages();

      const counts = wx.chooseMedia.mock.calls.map((call) => call[0].count);
      expect(counts).toEqual([1, 1, 1, 1]);
    });

    test('PC 端收敛 sourceType 为相册（PC 没有摄像头，留 camera 只会点了没反应）', async () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'windows' });
      succeedChooseImage('/tmp/pc-src.jpg');

      await pickImages({ count: 1 });

      // 断言对象必须是 chooseImage —— PC 端 shouldUseChooseMedia() 返回 false，
      // chooseMedia 压根不会被调用（它在 PC 上是静默挂起，见上方用例）。
      // 本用例原本断言 chooseMedia，早于「PC 端主动跳过 chooseMedia」那轮改动，
      // 属于断言写错了对象，不是实现回归。
      expect(wx.chooseMedia).not.toHaveBeenCalled();
      expect(wx.chooseImage.mock.calls[0][0].sourceType).toEqual(['album']);
    });

    test('移动端保留相册 + 拍照两个来源', async () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'ios' });
      succeedChooseMedia();

      await pickImages({ count: 1 });

      expect(wx.chooseMedia.mock.calls[0][0].sourceType).toEqual(['album', 'camera']);
    });

    test('mediaType 固定为 image（本兼容层只服务选图）', async () => {
      succeedChooseMedia();

      await pickImages({ count: 1 });

      expect(wx.chooseMedia.mock.calls[0][0].mediaType).toEqual(['image']);
    });
  });

  describe('isPcPlatform', () => {
    test('windows / mac 为 PC', () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'windows' });
      expect(isPcPlatform()).toBe(true);
      wx.getDeviceInfo.mockReturnValue({ platform: 'mac' });
      expect(isPcPlatform()).toBe(true);
    });

    test('ios / android / devtools 不是 PC', () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'ios' });
      expect(isPcPlatform()).toBe(false);
      wx.getDeviceInfo.mockReturnValue({ platform: 'android' });
      expect(isPcPlatform()).toBe(false);
      wx.getDeviceInfo.mockReturnValue({ platform: 'devtools' });
      expect(isPcPlatform()).toBe(false);
    });

    test('取设备信息抛错时按非 PC 处理（不阻断选图）', () => {
      wx.getDeviceInfo.mockImplementation(() => { throw new Error('no info'); });
      wx.getSystemInfoSync.mockImplementation(() => { throw new Error('no info'); });

      expect(isPcPlatform()).toBe(false);
    });
  });

  describe('shouldUseChooseMedia', () => {
    test('PC 端为 false（无论 chooseMedia 是否存在）', () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'windows' });
      expect(shouldUseChooseMedia()).toBe(false);
      wx.getDeviceInfo.mockReturnValue({ platform: 'mac' });
      expect(shouldUseChooseMedia()).toBe(false);
    });

    test('移动端且 API 可用为 true', () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'ios' });
      expect(shouldUseChooseMedia()).toBe(true);
    });

    test('API 不可用时为 false', () => {
      wx.getDeviceInfo.mockReturnValue({ platform: 'ios' });
      wx.canIUse.mockReturnValue(false);
      expect(shouldUseChooseMedia()).toBe(false);
    });
  });

  describe('isApiAvailable', () => {
    test('函数不存在 → false', () => {
      expect(isApiAvailable('notARealApi')).toBe(false);
    });

    test('canIUse 返回 false → false', () => {
      wx.canIUse.mockReturnValue(false);
      expect(isApiAvailable('chooseMedia')).toBe(false);
    });

    test('canIUse 缺失时按「函数存在即可用」处理', () => {
      const original = wx.canIUse;
      delete wx.canIUse;

      try {
        expect(isApiAvailable('chooseMedia')).toBe(true);
      } finally {
        wx.canIUse = original;
      }
    });

    test('canIUse 自身抛错时按不可用处理（不得让异常冒到点击处理）', () => {
      wx.canIUse.mockImplementation(() => { throw new Error('canIUse exploded'); });

      expect(isApiAvailable('chooseMedia')).toBe(false);
    });
  });
});
