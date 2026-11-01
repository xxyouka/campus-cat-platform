/**
 * __tests__/utils/imageLoader.cacheCapacity.test.js
 *
 * 覆盖 imageLoader 缓存的两个容量相关修复点（原测试文件里完全没有覆盖）：
 *   1) CACHE_MAX_SIZE = 300：旧值 50 撑不住「一次整页预热 120~200 条」的规模，
 *      单次批量预热（FIFO 逐出最旧条目）就会把 load() 依赖的条目冲掉；
 *   2) _getFromCache 命中后把条目移到队尾（LRU）：否则热条目会按插入顺序被逐出。
 *
 * 原测试文件里唯一制造 120 条预热的用例只断言返回的 urlMap，从不读 cacheSize；
 * 其余缓存用例最多放 2~3 条，远低于任何容量阈值，逐出路径从未被触发。
 */
const imageLoader = require('../../utils/imageLoader');

/** 按请求批次逐个回传可用临时链接：不同 fileID 必须各自成条目 */
function mockAllTempUrls() {
  wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
    Promise.resolve({
      fileList: fileList.map(f => ({
        fileID: f.fileID,
        status: 0,
        tempFileURL: `https://env.tcb.qcloud.la/${encodeURIComponent(f.fileID)}`
      }))
    })
  );
}

describe('ImageLoader 缓存容量与逐出（CACHE_MAX_SIZE / LRU）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    imageLoader.clearCache();
    imageLoader.resetStats();
  });

  test('批量预热 120 条后缓存容量为 120，且二次请求零云调用', async () => {
    mockAllTempUrls();
    const ids = Array.from({ length: 120 }, (_, i) => `cloud://env/capacity${i}.jpg`);

    const map = await imageLoader.getTempUrls(ids, { optimizeType: 'thumbnail' });

    expect(Object.keys(map)).toHaveLength(120);
    // CACHE_MAX_SIZE 被改回 50 时后 70 条会被 FIFO 逐出，此处变红
    expect(imageLoader.getStats().cacheSize).toBe(120);

    // 容量足够时整批都在缓存里：二次请求不该再打云调用
    wx.cloud.getTempFileURL.mockClear();
    const second = await imageLoader.getTempUrls(ids, { optimizeType: 'thumbnail' });

    expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled();
    expect(Object.keys(second)).toHaveLength(120);
    expect(imageLoader.getStats().fromCache).toBeGreaterThanOrEqual(120);
  });

  test('顶满后 LRU 命中的热条目不被逐出，最旧的非热条目按插入顺序被逐出', async () => {
    mockAllTempUrls();
    const fill = Array.from({ length: 300 }, (_, i) => `cloud://env/lru${i}.jpg`);

    await imageLoader.getTempUrls(fill, { optimizeType: 'thumbnail' });
    expect(imageLoader.getStats().cacheSize).toBe(300);

    // fill[0] 是插入最早的一条（队首、最易被逐出）
    const hot = fill[0];
    wx.cloud.getTempFileURL.mockClear();
    await imageLoader.getTempUrls([hot], { optimizeType: 'thumbnail' });
    expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled(); // 缓存命中

    // 顶满状态下新增一条：触发一次逐出
    await imageLoader.getTempUrls(['cloud://env/lru-newest.jpg'], { optimizeType: 'thumbnail' });
    expect(imageLoader.getStats().cacheSize).toBe(300);

    // 命中已把 hot 移到队尾；删掉 _getFromCache 的 delete+set（LRU）后，
    // 队首的 hot 会被这次写入逐出 → 下面两条断言变红
    wx.cloud.getTempFileURL.mockClear();
    const hotAgain = await imageLoader.getTempUrls([hot], { optimizeType: 'thumbnail' });
    expect(wx.cloud.getTempFileURL).not.toHaveBeenCalled();
    expect(hotAgain[hot]).toBeDefined();

    // 对照组：真正最旧的 fill[1] 已按插入顺序被逐出，必须重新转链
    await imageLoader.getTempUrls([fill[1]], { optimizeType: 'thumbnail' });
    expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(1);
  });
});
