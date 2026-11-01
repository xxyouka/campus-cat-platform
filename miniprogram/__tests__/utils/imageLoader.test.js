/**
 * __tests__/utils/imageLoader.test.js
 * 覆盖 getTempUrls 的尺寸档位压缩与「fileID@尺寸档位」缓存读穿
 */
const imageLoader = require('../../utils/imageLoader');

const CLOUD_ID = 'cloud://env/photo.jpg';
const TEMP_URL = 'https://env.tcb.qcloud.la/photo.jpg';

describe('ImageLoader.getTempUrls', () => {
  function mockTempUrl(url = TEMP_URL) {
    wx.cloud.getTempFileURL.mockResolvedValue({
      fileList: [{ fileID: CLOUD_ID, status: 0, tempFileURL: url }]
    });
  }


  beforeEach(() => {
    jest.clearAllMocks();
    imageLoader.clearCache();
    imageLoader.resetStats();
  });

  describe('尺寸档位压缩', () => {
    test('should append imageMogr2 params for thumbnail type (200px)', async () => {
      mockTempUrl();
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'thumbnail' });

      expect(map[CLOUD_ID]).toContain('imageMogr2');
      expect(map[CLOUD_ID]).toContain('thumbnail/200x200>');
      expect(map[CLOUD_ID]).not.toBe(TEMP_URL);
    });

    test('should default to avatar type (100px)', async () => {
      mockTempUrl();
      const map = await imageLoader.getTempUrls([CLOUD_ID]);

      expect(map[CLOUD_ID]).toContain('thumbnail/100x100>');
    });

    test('should use gallery type (400px)', async () => {
      mockTempUrl();
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'gallery' });

      expect(map[CLOUD_ID]).toContain('thumbnail/400x400>');
    });

    test('should use detail type (600px)', async () => {
      mockTempUrl();
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'detail' });

      expect(map[CLOUD_ID]).toContain('thumbnail/600x600>');
    });

    test('should append params with & when temp url already has query string', async () => {
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=abc&t=123');
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'thumbnail' });

      expect(map[CLOUD_ID]).toContain('?sign=abc&t=123&imageMogr2');
    });

    test('should keep raw url when optimize is false', async () => {
      mockTempUrl();
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimize: false });

      expect(map[CLOUD_ID]).toBe(TEMP_URL);
    });

    test('should not double-append params for third-party https url', async () => {
      mockTempUrl('https://example.com/photo.jpg');
      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'gallery' });

      expect(map[CLOUD_ID]).toBe('https://example.com/photo.jpg');
    });
  });

  describe('缓存', () => {
    test('should not return thumbnail cache for a gallery request on the same fileID', async () => {
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg');
      const thumbMap = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'thumbnail' });
      expect(thumbMap[CLOUD_ID]).toContain('thumbnail/200x200>');

      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=new');
      const galleryMap = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'gallery' });

      // 尺寸档位不同必须重新转链，否则 200px 缩略图会冒充相册大图
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
      expect(galleryMap[CLOUD_ID]).toContain('thumbnail/400x400>');
      expect(galleryMap[CLOUD_ID]).not.toContain('thumbnail/200x200>');
    });

    test('should reuse cache for repeated identical request', async () => {
      mockTempUrl();
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      const second = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
      expect(second[CLOUD_ID]).toContain('thumbnail/100x100>');
      expect(imageLoader.getStats().fromCache).toBeGreaterThan(0);
    });

    test('should not mix optimize:false cache with optimized cache', async () => {
      mockTempUrl();
      const rawMap = await imageLoader.getTempUrls([CLOUD_ID], { optimize: false });
      const optimizedMap = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      expect(rawMap[CLOUD_ID]).toBe(TEMP_URL);
      expect(optimizedMap[CLOUD_ID]).toContain('imageMogr2');
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
    });

    test('should force a fresh conversion when force is true (重试链路)', async () => {
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=v1');
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      // 重试必须 force：读穿缓存会拿回与失败前完全相同的 URL，
      // setData 值未变 → <image src> 不变 → 不会重新请求
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=v2');
      const retried = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar', force: true });

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
      expect(retried[CLOUD_ID]).toContain('sign=v2');
      expect(retried[CLOUD_ID]).toContain('thumbnail/100x100>');
    });

    test('force request should still write back to cache', async () => {
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=v1');
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar', force: true });
      const cached = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
      expect(cached[CLOUD_ID]).toContain('sign=v1');
    });

    test('should dedupe fileIDs on a forced request', async () => {
      mockTempUrl();
      await imageLoader.getTempUrls([CLOUD_ID, CLOUD_ID], { optimizeType: 'avatar', force: true });

      expect(wx.cloud.getTempFileURL.mock.calls[0][0].fileList).toHaveLength(1);
    });
  });

  describe('档位与 optimize 归一化（key 与值必须同源）', () => {
    test('falsy non-false optimize (null) should behave like true and cache under the tier key', async () => {
      mockTempUrl();
      const first = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar', optimize: null });

      // 曾经：返回原图却写进 @avatar 键 → 后续正常请求拿到原图
      expect(first[CLOUD_ID]).toContain('imageMogr2');
      expect(first[CLOUD_ID]).toContain('thumbnail/100x100>');

      const second = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
      expect(second[CLOUD_ID]).toContain('thumbnail/100x100>');
    });

    test('unknown/mixed-case optimizeType should normalize to avatar for both key and value', async () => {
      mockTempUrl();
      const mixed = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'Detail' });
      expect(mixed[CLOUD_ID]).toContain('thumbnail/100x100>');

      // 归一化后与正常 avatar 请求共用同一条缓存，不应重复转链
      const normal = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
      expect(normal[CLOUD_ID]).toContain('thumbnail/100x100>');
    });

    test('unknown optimizeType should not collide with a real tier', async () => {
      mockTempUrl();
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'bogus' });
      mockTempUrl('https://env.tcb.qcloud.la/photo.jpg?sign=2');
      const gallery = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'gallery' });

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
      expect(gallery[CLOUD_ID]).toContain('thumbnail/400x400>');
    });
  });

  describe('clearCache', () => {
    test('should clear every tier of one fileID by prefix', async () => {
      mockTempUrl();
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'gallery' });

      imageLoader.clearCache(CLOUD_ID);

      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(3);
    });

    test('should not touch other fileIDs when clearing one', async () => {
      const other = 'cloud://env/other.jpg';
      wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
        Promise.resolve({
          fileList: fileList.map(f => ({
            fileID: f.fileID, status: 0, tempFileURL: `https://env.tcb.qcloud.la/${f.fileID.slice(-5)}.jpg`
          }))
        })
      );
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      await imageLoader.getTempUrls([other], { optimizeType: 'avatar' });

      imageLoader.clearCache(CLOUD_ID);

      // 别的 fileID 仍命中缓存
      await imageLoader.getTempUrls([other], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);

      // 被清掉的 fileID 必须重新转链
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(3);
      expect(wx.cloud.getTempFileURL.mock.calls[2][0].fileList.map(f => f.fileID)).toEqual([CLOUD_ID]);
    });

    test('clearCache() without argument should clear everything', async () => {
      mockTempUrl();
      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      imageLoader.clearCache();

      await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });
      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
    });
  });

  describe('已删除的旧加载 API', () => {
    test('load / preload / batchLoad 不应再存在（与 @档位 是两套互不命中的 key 空间）', () => {
      expect(imageLoader.load).toBeUndefined();
      expect(imageLoader.preload).toBeUndefined();
      expect(imageLoader.batchLoad).toBeUndefined();
    });
  });

  describe('批量与统计', () => {
    test('should request in batches of 50', async () => {
      wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
        Promise.resolve({
          fileList: fileList.map(f => ({
            fileID: f.fileID, status: 0, tempFileURL: 'https://env.tcb.qcloud.la/photo.jpg'
          }))
        })
      );
      const ids = Array.from({ length: 120 }, (_, i) => `cloud://env/p${i}.jpg`);

      const map = await imageLoader.getTempUrls(ids, { optimizeType: 'thumbnail' });

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(3);
      const sizes = wx.cloud.getTempFileURL.mock.calls.map(c => c[0].fileList.length);
      expect(sizes).toEqual([50, 50, 20]);
      expect(Object.keys(map)).toHaveLength(120);
      expect(map[ids[0]]).toContain('imageMogr2');
    });

    test('should count failures for non-zero status', async () => {
      // 关键：这条失败项**故意带上可用的 tempFileURL**。
      // 若实现只看 tempFileURL 而忽略 status，它会被当成成功项用上，断言随即失败。
      // 少写这个字段的话，本用例对 status 判据零约束力 —— 实测删掉 `status === 0`
      // 仍全绿（缺字段那条把它挡住了）。
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ fileID: CLOUD_ID, status: -1, tempFileURL: TEMP_URL }]
      });

      const map = await imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' });

      expect(map[CLOUD_ID]).toBeUndefined();
      expect(imageLoader.getStats().failed).toBe(1);
    });

    test('should rethrow and count failures when cloud call rejects', async () => {
      wx.cloud.getTempFileURL.mockRejectedValue(new Error('cloud down'));

      await expect(imageLoader.getTempUrls([CLOUD_ID], { optimizeType: 'avatar' }))
        .rejects.toThrow('cloud down');
      expect(imageLoader.getStats().failed).toBe(1);
    });
  });
});

describe('ImageLoader 统计口径', () => {
  const ID = 'cloud://env/stats.jpg';

  function mockTempUrl() {
    wx.cloud.getTempFileURL.mockResolvedValue({
      fileList: [{ fileID: ID, status: 0, tempFileURL: 'https://env.tcb.qcloud.la/stats.jpg' }]
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    imageLoader.clearCache();
    imageLoader.resetStats();
  });

  test('total 必须累加，successRate 不再恒为 0%', async () => {
    mockTempUrl();
    await imageLoader.getTempUrls([ID], { optimizeType: 'avatar' });

    const stats = imageLoader.getStats();
    expect(stats.total).toBe(1);
    expect(stats.success).toBe(1);
    expect(stats.successRate).toBe('100.0%');
  });

  test('缓存命中计入成功率（命中也是成功拿到可用 URL）', async () => {
    mockTempUrl();
    await imageLoader.getTempUrls([ID], { optimizeType: 'avatar' });
    await imageLoader.getTempUrls([ID], { optimizeType: 'avatar' }); // 第二次读缓存

    const stats = imageLoader.getStats();
    expect(stats.total).toBe(2);
    expect(stats.fromCache).toBeGreaterThanOrEqual(1);
    expect(stats.successRate).toBe('100.0%');
  });
});

/**
 * 在途批次复用（并发去重）
 *
 * 动机：首页首屏的批量转链（resolveCatAvatars）与卡片自身的转链
 *（lazy-image 的渐进式占位档）会在同一 tick 内命中同一批 fileID ——
 * 改造前各自发 RPC（首屏最多 10 次单文件调用），现在应复用同一批。
 */
describe('ImageLoader 在途批次复用', () => {
  const ID = 'cloud://env/inflight.jpg';

  /** 手动控制结算时机的 getTempFileURL：把每批的 resolve 收集起来一次性触发 */
  function deferredTempUrl() {
    const resolvers = [];
    wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
      new Promise(resolve => {
        resolvers.push(() => resolve({
          fileList: fileList.map(f => ({
            fileID: f.fileID,
            status: 0,
            tempFileURL: `https://env.tcb.qcloud.la/${encodeURIComponent(f.fileID)}`
          }))
        }));
      })
    );
    return () => resolvers.forEach(r => r());
  }

  beforeEach(() => {
    jest.clearAllMocks();
    imageLoader.clearCache();
    imageLoader.resetStats();
  });

  test('并发同 fileID 只发一次真实请求，两个调用方拿到同一个 URL', async () => {
    const settle = deferredTempUrl();

    const first = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });
    const second = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });

    settle();
    const [a, b] = await Promise.all([first, second]);

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
    expect(a[ID]).toContain('thumbnail/400x400>');
    expect(b[ID]).toBe(a[ID]);

    // 复用方也计入统计：total 与成功数都不能漏（否则 successRate 会掉下来）
    const stats = imageLoader.getStats();
    expect(stats.total).toBe(2);
    expect(stats.success).toBe(2);
    expect(stats.successRate).toBe('100.0%');
  });

  test('批次结算后新调用方走缓存而不是复用（在途表必须被清干净）', async () => {
    const settle = deferredTempUrl();
    const first = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });
    settle();
    await first;

    const again = await imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
    expect(again[ID]).toContain('thumbnail/400x400>');
  });

  test('档位不同不复用（复用错档位会让 200px 缩略图冒充大图）', async () => {
    wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
      Promise.resolve({
        fileList: fileList.map(f => ({
          fileID: f.fileID, status: 0, tempFileURL: 'https://env.tcb.qcloud.la/x.jpg'
        }))
      })
    );

    const [gallery, thumb] = await Promise.all([
      imageLoader.getTempUrls([ID], { optimizeType: 'gallery' }),
      imageLoader.getTempUrls([ID], { optimizeType: 'thumbnail' })
    ]);

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
    expect(gallery[ID]).toContain('thumbnail/400x400>');
    expect(thumb[ID]).toContain('thumbnail/200x200>');
  });

  test('force 不复用在途批次（重试必须真的重新转链，否则拿回同一个 URL 是空转）', async () => {
    const settle = deferredTempUrl();

    const normal = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });
    const forced = imageLoader.getTempUrls([ID], { optimizeType: 'gallery', force: true });

    settle();
    await Promise.all([normal, forced]);

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(2);
  });

  test('在途批次失败时复用方按缺项降级，不跟着整包抛错', async () => {
    let rejectBatch;
    wx.cloud.getTempFileURL.mockImplementation(() =>
      new Promise((_resolve, reject) => { rejectBatch = reject; })
    );

    const first = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });
    const second = imageLoader.getTempUrls([ID], { optimizeType: 'gallery' });
    rejectBatch(new Error('cloud down'));

    // 发起方：整批失败照旧抛出（调用方走降级分批）
    await expect(first).rejects.toThrow('cloud down');

    // 复用方：拿到「这个文件本轮没转出来」的降级结果即可
    const map = await second;
    expect(map[ID]).toBeUndefined();
    expect(imageLoader.getStats().failed).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 跨会话持久化（加载速度方案 §4 · 2026-10-15）
 *
 * 动机：`_imageCache` 是内存 Map，冷启动即空 —— 重复访客每次打开都要把首屏头像
 * 重新转链一遍（1 次批量 RPC，150~300ms）。落盘后冷启动可直接命中。
 * 本组锁四件事：
 *   1. 落盘后「新会话」直接命中，0 次 RPC；
 *   2. 超过 PERSIST_TTL 的条目在读取时丢弃（绝不把可能失效的链接交给 <image>）；
 *   3. 只落首屏档位（detail 不落盘）+ 条数上限淘汰最旧；
 *   4. clearCache(fileID) 同时清落盘 —— 否则下次冷启动又把作废链接装回内存。
 */
describe('ImageLoader 跨会话持久化（首屏档位）', () => {
  const KEY = 'img_temp_url_cache_v1';
  const ID = 'cloud://env/persist.jpg';

  function useMemoryStorage(seed = {}) {
    const store = { ...seed };
    wx.getStorageSync.mockImplementation(k => k in store ? store[k] : '');
    wx.setStorageSync.mockImplementation((k, v) => { store[k] = v; });
    wx.removeStorageSync.mockImplementation(k => { delete store[k]; });
    return store;
  }

  /** 模拟「下一次冷启动」：模块级单例重建，存储保留 */
  function coldStart() {
    jest.resetModules();
    return require('../../utils/imageLoader');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useMemoryStorage();
    wx.cloud.getTempFileURL.mockResolvedValue({
      fileList: [{ fileID: ID, status: 0, tempFileURL: 'https://env.tcb.qcloud.la/persist.jpg' }]
    });
  });

  test('落盘后新会话直接命中，不再发 RPC', async () => {
    const first = coldStart();
    await first.getTempUrls([ID], { optimizeType: 'gallery' });

    const second = coldStart();   // 新会话：内存缓存为空，只有落盘
    wx.cloud.getTempFileURL.mockClear();

    const map = await second.getTempUrls([ID], { optimizeType: 'gallery' });

    expect(map[ID]).toContain('thumbnail/400x400>');
    expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled();
  });

  test('超过 PERSIST_TTL 的条目读取时丢弃并重新转链', async () => {
    const ttl = coldStart().IMAGE_LOADER_CONFIG.PERSIST_TTL;
    useMemoryStorage({
      [KEY]: {
        entries: {
          [`${ID}@gallery`]: {
            success: true,
            src: 'https://env.tcb.qcloud.la/expired.jpg?sign=old',
            cachedAt: Date.now() - ttl - 1000
          }
        }
      }
    });

    const loader = coldStart();
    const map = await loader.getTempUrls([ID], { optimizeType: 'gallery' });

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
    expect(map[ID]).not.toContain('expired.jpg');
  });

  test('detail 档位不落盘（只存首屏档位）', async () => {
    const store = useMemoryStorage();
    const loader = coldStart();

    await loader.getTempUrls([ID], { optimizeType: 'detail' });

    const entries = store[KEY] && store[KEY].entries || {};
    expect(Object.keys(entries)).toHaveLength(0);
  });

  test('落盘条数上限：超出时淘汰最旧', async () => {
    const loader = coldStart();
    const max = loader.IMAGE_LOADER_CONFIG.PERSIST_MAX_ENTRIES;
    wx.cloud.getTempFileURL.mockImplementation(({ fileList }) => Promise.resolve({
      fileList: fileList.map(f => ({
        fileID: f.fileID, status: 0, tempFileURL: `https://env.tcb.qcloud.la/${f.fileID}.jpg`
      }))
    }));

    const ids = Array.from({ length: max + 5 }, (_unused, i) => `cloud://env/bulk-${i}.jpg`);
    await loader.getTempUrls(ids, { optimizeType: 'avatar' });

    const store = wx.getStorageSync(KEY);
    expect(Object.keys(store.entries)).toHaveLength(max);
  });

  test('clearCache(fileID) 同时清落盘：下次冷启动不会把作废链接装回来', async () => {
    const first = coldStart();
    await first.getTempUrls([ID], { optimizeType: 'gallery' });
    first.clearCache(ID);

    const second = coldStart();
    wx.cloud.getTempFileURL.mockClear();
    await second.getTempUrls([ID], { optimizeType: 'gallery' });

    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
  });

  test('存储不可用时静默降级（读写抛错都不影响加载路径）', async () => {
    wx.getStorageSync.mockImplementation(() => { throw new Error('storage broken'); });
    wx.setStorageSync.mockImplementation(() => { throw new Error('storage broken'); });

    const loader = coldStart();
    const map = await loader.getTempUrls([ID], { optimizeType: 'gallery' });

    expect(map[ID]).toContain('thumbnail/400x400>');
  });
});
