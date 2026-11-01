/**
 * __tests__/pages/admin/album-detail.test.js
 *
 * 相册详情（批量传图）此前零测试覆盖。本文件锁定（2026-10-06 修复后的行为）：
 *   1. 上传成功：入库计数、刷新标记（photo-manage 消费）、列表重拉；
 *   2. 服务端**明确拒绝**（success:false）→ 回收未入库文件；
 *   3. 超时/断网（reject）属歧义失败 → **不得**删文件（服务端可能已入库，删了就是坏图）；
 *   4. 压缩超限：不发上传、按「第 N 张 + 原因」提示；
 *   5. 删除照片：重置分页游标并重拉 + 通知相册列表刷新（offset 分页删一条会漏一张）。
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = {
  handle: jest.fn(),
  showSuccess: jest.fn(),
  handleDatabaseError: jest.fn(),
  handleValidationError: jest.fn()
};
const mockAdminAuth = { requireAdminAuth: jest.fn(() => Promise.resolve(true)), getAdminRole: jest.fn(() => 'superadmin') };
const mockPageState = { setNeedRefresh: jest.fn(), checkNeedRefresh: jest.fn(() => null) };
const mockPickImages = jest.fn();
const mockCompressToLimit = jest.fn();
const mockCallAdminFunction = jest.fn();

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/imageLoader', () => ({ getTempUrls: jest.fn(() => Promise.resolve({})) }));
jest.mock('../../../utils/pageState', () => ({ getPageStateManager: jest.fn(() => mockPageState) }));
jest.mock('../../../pages/admin/utils/mediaChoose', () => ({ pickImages: (...args) => mockPickImages(...args) }));
jest.mock('../../../pages/admin/utils/imageCompressor', () => ({
  compressToLimit: (...args) => mockCompressToLimit(...args)
}));
jest.mock('../../../utils/obsHelper', () => ({
  reportEvent: jest.fn(),
  EVENT_NAMES: { ADMIN_ADD_PHOTO: 'admin_add_photo' }
}));
jest.mock('../../../utils/dateFormat', () => ({ formatDateShort: jest.fn(() => '10-06') }));
jest.mock('../../../behaviors/backToTopBehavior', () => ({}));
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  // 同 adminBehavior.js:53-60：栈深>1 走 navigateBack，否则 redirectTo 兜底
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/photo-manage/album-detail');
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let target = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = updates[key];
    } else {
      data[key] = updates[key];
    }
  }
}

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), catId: 'cat-1', ...dataOverrides },
    setData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    safeSetData: function(updates) { applySetData(this.data, updates); },
    _isUnmounted: false,
    _uploading: false,
    _deleting: false,
    _uploadCancelled: false,
    callAdminFunction: (...args) => mockCallAdminFunction(...args),
    verifyAdmin: () => Promise.resolve(true),
    // 列表重拉与转链不在本文件断言范围：stub 掉，聚焦上传/删除的状态机
    loadPhotos: jest.fn(() => Promise.resolve())
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

const PHOTO_FILE = 'cloud://mock-env.bucket/photos/1.jpg';

/**
   * 回归（2026-10-11 · P0 级真实缺陷）：点进相册详情后**永远骨架屏、一张照片都不请求**。
   *
   * 成因是两种语义共用了一个字段：
   *   - `data.loading` 初值为 true，是**展示状态**（骨架屏常驻，避免鉴权期间闪「暂无照片」）；
   *   - `loadPhotos()` 却拿它当「请求在途」的守卫：`if (this.data.loading) return;`
   * 于是 onLoad 鉴权通过后 `await this.loadPhotos()` 当场早退，_loadedOnce 永不置位，
   * onShow 再调又早退 —— 整页没有一次 getPhotosByCat 发出，用户看到的是「什么都没有」。
   *
   * 为什么以前没被测出来：本文件的 `createInstance` 把 loadPhotos **整个 stub 掉**
   * （注释写「列表重拉与转链不在本文件断言范围」），断言只到「loadPhotos 被调用过」为止，
   * 守卫根本没被执行 —— **桩把 bug 藏住了**。
   * 所以下面这组用例一律使用**真实** loadPhotos，宁可慢一点，也不能让桩再遮住这类缺陷。
   */
describe('首次加载：真实 loadPhotos（不 stub）', () => {
  function createRealInstance(overrides = {}) {
    const inst = createInstance(overrides);
    // 把桩换回真实实现：这是本组用例存在的全部意义
    delete inst.loadPhotos;
    inst.loadPhotos = pageDef.loadPhotos.bind(inst);
    inst.resolveUrls = jest.fn(() => Promise.resolve());
    return inst;
  }

  const okResult = {
    result: { success: true, data: { photos: [{ _id: 'p1', url: 'https://x/1.jpg' }], hasMore: false } }
  };

  test('前提坐实：data.loading 初值为 true（骨架屏常驻，正是旧守卫早退的原因）', () => {
    expect(pageDef.data.loading).toBe(true);
  });

  test('loading 初值为 true 时，loadPhotos 仍必须真的发请求', async () => {
    const inst = createRealInstance();
    mockCallAdminFunction.mockResolvedValue(okResult);

    await inst.loadPhotos();

    expect(mockCallAdminFunction).toHaveBeenCalledWith('getPhotosByCat', expect.objectContaining({
      catId: 'cat-1', page: 1
    }));
    expect(inst.data.photos).toHaveLength(1);
    expect(inst._loadedOnce).toBe(true);
    expect(inst.data.loading).toBe(false);
  });

  test('onLoad 鉴权通过 → 必须真的发出 getPhotosByCat（端到端，不 stub 任何一层）', async () => {
    const inst = createRealInstance();
    mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
    mockCallAdminFunction.mockResolvedValue(okResult);

    await inst.onLoad({ catId: 'cat-1', catName: '%E5%B0%8F%E6%A9%98' });

    expect(mockCallAdminFunction).toHaveBeenCalledWith(
      'getPhotosByCat', expect.objectContaining({ catId: 'cat-1' })
    );
    expect(inst.data.loading).toBe(false);
  });

  test('onShow 在未加载过时也要能真的发请求（守卫不得用展示状态）', async () => {
    const inst = createRealInstance();
    inst.data.catId = 'cat-1';
    inst._loadedOnce = false;
    mockCallAdminFunction.mockResolvedValue(okResult);

    inst.onShow();
    await Promise.resolve();

    expect(mockCallAdminFunction).toHaveBeenCalledWith(
      'getPhotosByCat', expect.objectContaining({ catId: 'cat-1' })
    );
  });

  test('并发调用只发一次请求（守卫仍然有效，只是换成实例字段）', async () => {
    const inst = createRealInstance();
    // 本文件的 beforeEach 只复位 wx.cloud 的桩，不复位 mockCallAdminFunction，
    // 所以这里必须自己清一次，否则计数会带上前面用例的调用
    mockCallAdminFunction.mockClear();
    mockCallAdminFunction.mockResolvedValue({
      result: { success: true, data: { photos: [{ _id: 'p1', url: 'https://x/1.jpg' }], hasMore: true } }
    });

    await Promise.all([inst.loadPhotos(), inst.loadPhotos()]);

    const calls = mockCallAdminFunction.mock.calls.filter(c => c[0] === 'getPhotosByCat');
    expect(calls).toHaveLength(1);
  });

  test('触底加载更多在 data.loading 为 true 时也必须放行', async () => {
    const inst = createRealInstance({ page: 1, hasMore: true });
    inst.data.loading = true; // 骨架屏展示中
    mockCallAdminFunction.mockResolvedValue({
      result: { success: true, data: { photos: [{ _id: 'p2', url: 'https://x/2.jpg' }], hasMore: false } }
    });

    inst.onLoadMore();
    await Promise.resolve();

    expect(mockCallAdminFunction).toHaveBeenCalledWith(
      'getPhotosByCat', expect.objectContaining({ page: 2 })
    );
  });
});

describe('album-detail page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPageState.checkNeedRefresh.mockReturnValue(null);
    mockPickImages.mockResolvedValue({ ok: true, files: [{ tempFilePath: '/tmp/a.jpg' }] });
    mockCompressToLimit.mockResolvedValue({ path: '/tmp/a-c.jpg', size: 100, withinLimit: true });
    mockCallAdminFunction.mockReset();
    wx.cloud.uploadFile.mockReset();
    wx.cloud.uploadFile.mockResolvedValue({ fileID: PHOTO_FILE });
    wx.cloud.deleteFile.mockReset();
    wx.cloud.deleteFile.mockResolvedValue({ fileList: [] });
  });

  test('上传成功：入库 + 刷新标记 + 列表重拉', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockResolvedValue({ result: { success: true, data: { id: 'p1' } } });

    await inst.onUploadPhoto();

    expect(mockCallAdminFunction).toHaveBeenCalledWith('addPhoto', expect.objectContaining({
      catId: 'cat-1',
      url: PHOTO_FILE
    }));
    expect(mockErrorHandler.showSuccess).toHaveBeenCalledWith('成功上传 1 张');
    expect(mockPageState.setNeedRefresh).toHaveBeenCalledWith('photo-manage', expect.anything());
    expect(inst.loadPhotos).toHaveBeenCalled();
    expect(wx.cloud.deleteFile).not.toHaveBeenCalled();
  });

  test('服务端明确拒绝（success:false）：回收未入库文件并提示第 N 张', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockResolvedValue({ result: { success: false, error: '猫咪不存在' } });

    await inst.onUploadPhoto();

    expect(wx.cloud.deleteFile).toHaveBeenCalledWith({ fileList: [PHOTO_FILE] });
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '第 1 张：猫咪不存在'
    }));
  });

  test('超时/断网（reject）属歧义失败：不得删文件（服务端可能已入库）', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockRejectedValue(new Error('cloud.callFunction:fail timeout'));

    await inst.onUploadPhoto();

    expect(wx.cloud.deleteFile).not.toHaveBeenCalled();
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '第 1 张上传失败'
    }));
  });

  test('压缩后仍超限：不发上传，提示第 N 张与原因', async () => {
    const inst = createInstance();
    mockCompressToLimit.mockResolvedValue({ path: '/tmp/a.jpg', size: 2 * 1024 * 1024, withinLimit: false });

    await inst.onUploadPhoto();

    expect(wx.cloud.uploadFile).not.toHaveBeenCalled();
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('第 1 张：图片过大')
    }));
  });

  test('删除照片：重置分页游标重拉 + 通知相册列表刷新', async () => {
    const inst = createInstance();
    mockCallAdminFunction.mockResolvedValue({ result: { success: true } });
    wx.showModal.mockImplementation((opts) => { if (opts.success) opts.success({ confirm: true }); });

    inst.onDeletePhoto({ currentTarget: { dataset: { photo: { _id: 'p1' } } } });
    // onDeletePhoto 的 modal success 是 async 回调：等一轮微任务
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCallAdminFunction).toHaveBeenCalledWith('deleteData', { type: 'photo', id: 'p1' });
    expect(inst.data.page).toBe(0);
    expect(inst.data.hasMore).toBe(true);
    expect(inst.loadPhotos).toHaveBeenCalled();
    expect(mockPageState.setNeedRefresh).toHaveBeenCalledWith('photo-manage', expect.anything());
  });

  // 卸载检查回归：onUnload 先置 _isUnmounted = true 就调 _cleanupUploadResources，
  // 在已销毁页面上裸 setData 会抛「页面已销毁」；onCancelUpload 则是
  // await showModal 之后调用，用户可能在等待确认期间已返回上一页。
  describe('_cleanupUploadResources 的卸载守卫', () => {
    test('页面已卸载时不 setData，但仍取消在途上传', () => {
      const inst = createInstance();
      inst._isUnmounted = true;
      inst.setData.mockClear();

      inst._cleanupUploadResources();

      // 取消标记必须生效，否则上传循环会继续往已销毁页面写状态
      expect(inst._uploadCancelled).toBe(true);
      // 但一个字段都不该往已销毁页面上写
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('页面未在卸载中时正常复位上传态', () => {
      const inst = createInstance();
      inst._isUnmounted = false;
      inst.setData.mockClear();

      inst._cleanupUploadResources();

      expect(inst._uploadCancelled).toBe(true);
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({ uploading: false, uploadProgress: 0 }));
    });

    test('onCancelUpload 在 await showModal 期间页面已卸载：不再 setData', async () => {
      const inst = createInstance();
      // showModal 挂起，期间用户返回上一页触发 onUnload
      wx.showModal.mockImplementation(() => new Promise((r) => {
        setTimeout(() => {
          inst.onUnload();
          r({ confirm: true });
        }, 0);
      }));

      await inst.onCancelUpload({});

      expect(inst._uploadCancelled).toBe(true);
      expect(inst.setData).not.toHaveBeenCalled();
    });

    test('onUnload 之后不再有任何上传态写入', () => {
      const inst = createInstance();
      inst.onUnload();
      inst.setData.mockClear();

      inst._cleanupUploadResources();

      expect(inst.setData).not.toHaveBeenCalled();
      expect(inst._uploadCancelled).toBe(true);
    });
  });
});
