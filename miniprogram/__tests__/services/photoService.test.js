const {
  loadPhotos,
  applyPrefetchCache,
  loadFullPhotosQuietly,
  onPreviewPhoto,
  saveImageToAlbum,
  togglePhotoLike
} = require('../../services/photoService');

jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

jest.mock('../../utils/performanceMonitor', () => ({
  monitorApi: jest.fn((name, fn) => fn())
}));

jest.mock('../../utils/imageLoader', () => ({
  preloadAboveFold: jest.fn(),
  getSingleTempUrl: jest.fn(),
  // 预览时的批量换链兜底：wx.previewImage 只认 http(s)，残留的 cloud:// 必须先换链
  getTempUrls: jest.fn()
}));

jest.mock('../../utils/dateFormat', () => ({
  formatDateShort: jest.fn(d => d ? '2026-05-01' : '')
}));

jest.mock('../../utils/photoUtils', () => ({
  resolvePhotoUrls: jest.fn(photos => Promise.resolve(photos))
}));

jest.mock('../../utils/avatarHelper', () => ({
  resolveCatAvatars: jest.fn(cats => Promise.resolve(cats))
}));

jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn()
}));

function createMockPage(overrides = {}) {
  return {
    data: {
      catId: 'cat-1',
      photoPage: 0,
      photoPageSize: 10,
      photos: [],
      hasMorePhotos: true,
      loadingMore: false,
      totalLikes: 0,
      cat: null,
      updateTime: '',
      showSkeleton: true,
      loading: true,
      viewCountDisplay: 0,
      ...overrides.data
    },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _computeTotalLikes: jest.fn(),
    _loadFullPhotosQuietly: jest.fn(),
    _photoCountsMap: {},
    ...overrides
  };
}

describe('photoService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadPhotos', () => {
    test('renders photo rows before background URL conversion completes', async () => {
      let resolveUrls;
      const pendingUrls = new Promise(resolve => { resolveUrls = resolve; });
      const photoUtils = require('../../utils/photoUtils');
      photoUtils.resolvePhotoUrls.mockReturnValueOnce(pendingUrls);
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: {
            photos: [{ _id: 'p1', url: 'cloud://p1', liked: true }],
            total: 1,
            hasMore: false
          }
        }
      });

      const page = createMockPage();
      await loadPhotos(page, true);

      expect(page.data.photos).toEqual([
        expect.objectContaining({
          _id: 'p1',
          displayUrl: 'cloud://p1',
          _cloudFileID: 'cloud://p1',
          _liked: true
        })
      ]);
      expect(page.data.photoPage).toBe(1);

      resolveUrls([{
        _id: 'p1',
        url: 'cloud://p1',
        _cloudFileID: 'cloud://p1',
        displayUrl: 'https://temp.example/p1'
      }]);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(page.data.photos[0].displayUrl).toBe('https://temp.example/p1');
    });

    test('should load photos with pagination', async () => {
      const photos = [
        { _id: 'p1', createTime: '2026-05-01', _cloudFileID: 'cloud://p1' },
        { _id: 'p2', createTime: '2026-05-02', _cloudFileID: 'cloud://p2' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos, hasMore: true }
      });

      const page = createMockPage();
      await loadPhotos(page);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'getPhotosByCat',
          data: { catId: 'cat-1', page: 1, pageSize: 10 }
        })
      );
      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ photoPage: 1 })
      );
      expect(page._computeTotalLikes).toHaveBeenCalled();
    });

    test('should reset photos when reset is true', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos: [], hasMore: false }
      });

      const page = createMockPage({
        data: { photos: [{ _id: 'old' }], photoPage: 3 }
      });
      await loadPhotos(page, true);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: [],
          hasMorePhotos: true,
          loadingMore: false,
          totalLikes: 0
        })
      );
    });

    test('should append new photos to existing when not reset', async () => {
      const newPhotos = [
        { _id: 'p2', createTime: '2026-05-02', _cloudFileID: 'cloud://p2' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos: newPhotos, hasMore: false }
      });

      const page = createMockPage({
        data: {
          catId: 'cat-1',
          photoPage: 1,
          photoPageSize: 10,
          photos: [{ _id: 'p1', createTime: '2026-05-01' }],
          hasMorePhotos: true,
          loadingMore: false,
          totalLikes: 0
        }
      });
      await loadPhotos(page);

      // 加载更多时应请求下一页（photoPage=1 已加载，本次请求第 2 页）
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'getPhotosByCat',
          data: { catId: 'cat-1', page: 2, pageSize: 10 }
        })
      );

      const mergedCall = page.setData.mock.calls.find(c => c[0].photos);
      expect(mergedCall[0].photos).toHaveLength(2);
    });

    test('should handle error from cloud function', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('cloud error'));

      const page = createMockPage();
      await loadPhotos(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loadingMore: false })
      );
    });

    test('should throw when result success is false with message', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false, message: '权限不足' }
      });

      const page = createMockPage();
      await loadPhotos(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ loadingMore: false })
      );
    });

    test('should set hasMorePhotos false when fewer photos than pageSize', async () => {
      const photos = [{ _id: 'p1', createTime: '2026-05-01' }];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos, hasMore: false }
      });

      const page = createMockPage();
      await loadPhotos(page);

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ hasMorePhotos: false })
      );
    });

    test('should preload above fold photos', async () => {
      const imageLoader = require('../../utils/imageLoader');
      const photos = Array.from({ length: 10 }, (_, i) => ({
        _id: `p${i}`, _cloudFileID: `cloud://p${i}`
      }));
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos, hasMore: true }
      });

      const page = createMockPage();
      await loadPhotos(page);

      expect(imageLoader.preloadAboveFold).toHaveBeenCalled();
    });

    test('should set loadingMore in finally block', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos: [], hasMore: false }
      });

      const page = createMockPage();
      await loadPhotos(page);

      expect(page.setData.mock.calls.some(([updates]) => updates.loadingMore === false)).toBe(true);
    });

    // 过期守卫回归：与文件末尾 loadFullPhotosQuietly 是同一条逻辑的两个副本，
    // 那边已加、这边一直漏。两段 await（云调用 + 转链）期间用户可能
    // 点了关系猫跳到别的详情页，旧响应回来会覆盖新猫咪的照片。
    test('await 期间 catId 变化：丢弃过期响应，不覆盖 photos', async () => {
      let resolveCall;
      wx.cloud.callFunction.mockImplementationOnce(() => new Promise((r) => { resolveCall = r; }));

      const page = createMockPage();
      const pending = loadPhotos(page);

      // 用户跳到另一只猫的详情页
      page.data.catId = 'cat-2';
      resolveCall({ result: { success: true, photos: [{ _id: 'p-old' }], hasMore: true } });
      await pending;

      expect(page.data.photos).toEqual([]);
      expect(page._computeTotalLikes).not.toHaveBeenCalled();
    });

    test('await 期间用户翻页：丢弃过期响应，不覆盖 photoPage', async () => {
      let resolveCall;
      wx.cloud.callFunction.mockImplementationOnce(() => new Promise((r) => { resolveCall = r; }));

      const page = createMockPage();
      const pending = loadPhotos(page);

      // 首屏在途时用户已翻到第 2 页
      page.data.photoPage = 2;
      resolveCall({ result: { success: true, photos: [{ _id: 'p-old' }], hasMore: true } });
      await pending;

      expect(page.data.photoPage).toBe(2);
      expect(page.data.photos).toEqual([]);
    });

    test('reset 场景下 catId 未变：正常写入', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos: [{ _id: 'p1' }], hasMore: true }
      });

      const page = createMockPage();
      await loadPhotos(page, true);

      expect(page.data.photos.map(p => p._id)).toEqual(['p1']);
      expect(page.data.photoPage).toBe(1);
    });
  });

  describe('applyPrefetchCache', () => {
    test('should return false when cat is null', async () => {
      const page = createMockPage();
      const result = await applyPrefetchCache(page, { cat: null }, 'cat-1');

      expect(result).toBe(false);
    });

    test('should apply cached data and return true', async () => {
      const cat = {
        _id: 'cat-1',
        name: '小橘',
        avatar: 'cloud://avatar',
        updateTime: '2026-05-01T00:00:00',
        viewCount: 500
      };
      const photos = [{ _id: 'p1', createTime: '2026-05-01' }];
      const cache = { cat, photos, totalPhotoCount: 10 };

      const page = createMockPage();
      const result = await applyPrefetchCache(page, cache, 'cat-1');

      expect(result).toBe(true);
      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          catId: 'cat-1',
          loading: false,
          showSkeleton: false,
          loadingMore: false
        })
      );
    });

    // 回归（FE-14）：预取只缓存 20 条、翻页按 30/页。
    // photoPage 记 1 会让第一次翻页直接要第 2 页（skip=30），**永久跳过第 21~30 条**，
    // 而 hasMorePhotos 仍按总数算出 true —— 用户只看到照片凭空少一截，没有任何报错。
    // 口径：记 0 页 + 首次翻页重取前 30 条，重叠由 dedupePhotos 去掉。
    test('photoPage 必须记 0（预取的 20 条不等于一整页）', async () => {
      const cat = { _id: 'cat-1', name: '小橘', updateTime: '2026-05-01T00:00:00' };
      const page = createMockPage();
      await applyPrefetchCache(page, { cat, photos: [], totalPhotoCount: 60 }, 'cat-1');
      expect(page.data.photoPage).toBe(0);
    });

    test('预取后第一次翻页能取回第 21~30 条，且不与预取重复', async () => {
      const cat = { _id: 'cat-1', name: '小橘', updateTime: '2026-05-01T00:00:00' };
      // 预取 20 条（p1..p20）
      const prefetched = Array.from({ length: 20 }, (_, i) => ({
        _id: `p${i + 1}`, createTime: '2026-05-01'
      }));
      const page = createMockPage({ data: { photoPageSize: 30 } });   // 与 detail.js:45 真实值一致
      await applyPrefetchCache(page, { cat, photos: prefetched, totalPhotoCount: 60 }, 'cat-1');

      // 服务端对 page=1/pageSize=30 返回完整前 30 条
      const first30 = Array.from({ length: 30 }, (_, i) => ({
        _id: `p${i + 1}`, createTime: '2026-05-01', _cloudFileID: `cloud://p${i + 1}`
      }));
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, photos: first30, hasMore: true } });

      await loadPhotos(page);

      // 请求的必须是第 1 页（而不是第 2 页），否则 21~30 永远取不到
      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ page: 1, pageSize: 30 }) })
      );
      // 结果是 30 条且无重复（预取的 20 条与本次重叠，必须被去重）
      const ids = page.data.photos.map(p => p._id);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
      // 第 21~30 条确实在列
      expect(ids).toContain('p21');
      expect(ids).toContain('p30');
    });

    test('should format dates for cat fields', async () => {
      const { formatDateShort } = require('../../utils/dateFormat');
      const cat = {
        _id: 'cat-1',
        avatar: 'cloud://avatar',
        updateTime: '2026-05-01T00:00:00',
        deceasedTime: '2026-04-01T00:00:00',
        lostTime: '2026-03-01T00:00:00'
      };
      const cache = { cat, photos: [], totalPhotoCount: 0 };

      const page = createMockPage();
      await applyPrefetchCache(page, cache, 'cat-1');

      expect(formatDateShort).toHaveBeenCalledWith('2026-05-01T00:00:00');
      expect(formatDateShort).toHaveBeenCalledWith('2026-04-01T00:00:00');
      expect(formatDateShort).toHaveBeenCalledWith('2026-03-01T00:00:00');
    });

    test('should resolve avatar using AvatarHelper', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      AvatarHelper.resolveCatAvatars.mockResolvedValue([
        { _id: 'cat-1', avatar: 'resolved-url' }
      ]);
      const cat = { _id: 'cat-1', avatar: 'cloud://avatar' };
      const cache = { cat, photos: [], totalPhotoCount: 0 };

      const page = createMockPage();
      await applyPrefetchCache(page, cache, 'cat-1');

      expect(AvatarHelper.resolveCatAvatars).toHaveBeenCalledWith([cat], []);
    });

    test('should schedule loadFullPhotosQuietly when photos incomplete', async () => {
      jest.useFakeTimers();
      const cat = { _id: 'cat-1', avatar: '' };
      const cache = { cat, photos: [{ _id: 'p1' }], totalPhotoCount: 5 };

      const page = createMockPage();
      await applyPrefetchCache(page, cache, 'cat-1');

      jest.advanceTimersByTime(500);
      expect(page._loadFullPhotosQuietly).toHaveBeenCalled();
      jest.useRealTimers();
    });

    test('should compute total likes', async () => {
      const cat = { _id: 'cat-1', avatar: '' };
      const photos = [{ _id: 'p1' }];
      const cache = { cat, photos, totalPhotoCount: 1 };

      const page = createMockPage();
      await applyPrefetchCache(page, cache, 'cat-1');

      expect(page._computeTotalLikes).toHaveBeenCalledWith(photos);
    });

    test('should handle viewCount display for 1000+', async () => {
      const cat = { _id: 'cat-1', avatar: '', viewCount: 2500 };
      const cache = { cat, photos: [], totalPhotoCount: 0 };

      const page = createMockPage();
      await applyPrefetchCache(page, cache, 'cat-1');

      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ viewCountDisplay: '2.5k' })
      );
    });
  });

  describe('loadFullPhotosQuietly', () => {
    test('should load full photos in background', async () => {
      const photos = [
        { _id: 'p1', createTime: '2026-05-01' },
        { _id: 'p2', createTime: '2026-05-02' }
      ];
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, photos, hasMore: false }
      });

      const page = createMockPage();
      await loadFullPhotosQuietly(page);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'getPhotosByCat',
          data: { catId: 'cat-1', page: 1, pageSize: 10 }
        })
      );
      expect(page.setData).toHaveBeenCalledWith(
        expect.objectContaining({ photos: expect.any(Array) })
      );
    });

    test('should handle errors silently', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('quiet error'));

      const page = createMockPage();
      await expect(loadFullPhotosQuietly(page)).resolves.toBeUndefined();
    });
  });

  describe('onPreviewPhoto', () => {
    let imageLoader;

    beforeEach(() => {
      imageLoader = require('../../utils/imageLoader');
      imageLoader.getSingleTempUrl.mockResolvedValue('');
      // 批量换链兜底：默认返回空对象（= 没换到，测试各自按需覆盖）
      imageLoader.getTempUrls.mockResolvedValue({});
    });

    test('should preview photo at given index', async () => {
      const page = createMockPage({
        data: {
          photos: [
            { displayUrl: 'url1', _cloudFileID: 'cloud://1' },
            { displayUrl: 'url2', _cloudFileID: 'cloud://2' }
          ]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({
          current: 'url1',
          urls: ['url1', 'url2']
        })
      );
    });

    test('should upgrade the tapped photo to detail tier', async () => {
      imageLoader.getSingleTempUrl.mockResolvedValue('https://tcb/detail.jpg?imageMogr2/thumbnail/600x600>');

      const page = createMockPage({
        data: {
          photos: [
            { displayUrl: 'gallery-1', _cloudFileID: 'cloud://1' },
            { displayUrl: 'gallery-2', _cloudFileID: 'cloud://2' }
          ]
        }
      });
      const e = { currentTarget: { dataset: { index: 1 } } };

      await onPreviewPhoto(page, e);

      expect(imageLoader.getSingleTempUrl).toHaveBeenCalledWith('cloud://2', { optimizeType: 'detail' });
      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({
          // 点第 2 张：只把第 2 项换成 detail 链接，current 必须仍在 urls 内
          current: 'https://tcb/detail.jpg?imageMogr2/thumbnail/600x600>',
          urls: ['gallery-1', 'https://tcb/detail.jpg?imageMogr2/thumbnail/600x600>']
        })
      );
    });

    test('should fall back to the gallery url when the detail conversion fails', async () => {
      imageLoader.getSingleTempUrl.mockResolvedValue('');

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'gallery-1', _cloudFileID: 'cloud://1' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({ current: 'gallery-1', urls: ['gallery-1'] })
      );
    });

    test('should keep index aligned when earlier photos are not previewable', async () => {
      const page = createMockPage({
        data: {
          photos: [
            { displayUrl: null, _cloudFileID: null },
            { displayUrl: null, _cloudFileID: null },
            { displayUrl: 'url3' },
            { displayUrl: 'url4' }
          ]
        }
      });
      const e = { currentTarget: { dataset: { index: 2 } } };

      await onPreviewPhoto(page, e);

      // 前两项被过滤掉：点第 3 张必须打开 url3 而不是 url（曾经的错位 bug）
      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({ current: 'url3', urls: ['url3', 'url4'] })
      );
    });

    test('should return early when photos is empty', async () => {
      const page = createMockPage({ data: { photos: [] } });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).not.toHaveBeenCalled();
    });

    test('should return early when photos is null', async () => {
      const page = createMockPage({ data: { photos: null } });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).not.toHaveBeenCalled();
    });

    test('should clamp index to valid range', async () => {
      const page = createMockPage({
        data: {
          photos: [
            { displayUrl: 'url1' },
            { displayUrl: 'url2' }
          ]
        }
      });
      const e = { currentTarget: { dataset: { index: 10 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({ current: 'url2' })
      );
    });

    test('should show toast when no valid URLs', async () => {
      const page = createMockPage({
        data: {
          photos: [{ displayUrl: null, _cloudFileID: null }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '图片加载中…' })
      );
    });

    test('只有 cloudFileID 时：先批量换链，previewImage 只收 https（cloud:// 渲染不出来）', async () => {
      const imageLoaderRef = require('../../utils/imageLoader');
      imageLoaderRef.getTempUrls.mockResolvedValue({ 'cloud://fallback': 'https://cdn/fallback.jpg' });
      const page = createMockPage({
        data: {
          photos: [
            { cloudFileID: 'cloud://fallback' }
          ]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(imageLoaderRef.getTempUrls).toHaveBeenCalledWith(['cloud://fallback'], { optimizeType: 'detail' });
      expect(wx.previewImage).toHaveBeenCalledWith(
        expect.objectContaining({
          current: 'https://cdn/fallback.jpg',
          urls: ['https://cdn/fallback.jpg']
        })
      );
      // 换链拿不到时宁可不预览，也不把 cloud:// 交给 previewImage（否则左右滑动全白）
      expect(wx.previewImage.mock.calls[0][0].urls.every(u => !String(u).startsWith('cloud://'))).toBe(true);
    });

    test('批量换链全部失败：退化为「图片加载中」提示，不预览坏图', async () => {
      const imageLoaderRef = require('../../utils/imageLoader');
      imageLoaderRef.getTempUrls.mockResolvedValue({});
      imageLoaderRef.getSingleTempUrl.mockResolvedValue('');
      const page = createMockPage({
        data: { photos: [{ cloudFileID: 'cloud://nope' }] }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await onPreviewPhoto(page, e);

      expect(wx.previewImage).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '图片加载中…' }));
    });
  });

  describe('saveImageToAlbum', () => {
    test('should download network image to local file before saving', async () => {
      wx.downloadFile.mockResolvedValue({ statusCode: 200, tempFilePath: 'wxfile://tmp/img.jpg' });

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/img.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.downloadFile).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/img.jpg' })
      );
      // saveImageToPhotosAlbum 只接受本地临时文件路径，网络 URL 直接传必然失败
      expect(wx.saveImageToPhotosAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'wxfile://tmp/img.jpg' })
      );
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('已保存') })
      );
    });

    test('should convert cloud:// URL to temp URL', async () => {
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ tempFileURL: 'https://temp.url/img.jpg' }]
      });

      const page = createMockPage({
        data: {
          photos: [{
            displayUrl: 'cloud://abc',
            _cloudFileID: 'cloud://abc'
          }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledWith(
        expect.objectContaining({ fileList: ['cloud://abc'] })
      );
      expect(wx.saveImageToPhotosAlbum).toHaveBeenCalled();
    });

    test('should return early when photo not found', async () => {
      const page = createMockPage({ data: { photos: [] } });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.saveImageToPhotosAlbum).not.toHaveBeenCalled();
    });

    test('should show modal on auth deny error', async () => {
      wx.saveImageToPhotosAlbum.mockRejectedValue({
        errMsg: 'saveImageToPhotosAlbum:fail auth deny'
      });

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/img.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.showModal).toHaveBeenCalledWith(
        expect.objectContaining({ title: '需要权限' })
      );
    });

    test('should show toast on general error', async () => {
      wx.saveImageToPhotosAlbum.mockRejectedValue(new Error('unknown error'));

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/img.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '保存失败，请重试' })
      );
    });

    test('should refuse to save a downscaled derivative when the fileID is missing', async () => {
      const page = createMockPage({
        data: {
          photos: [{
            displayUrl: 'https://env.tcb.qcloud.la/p.jpg?imageMogr2/thumbnail/400x400>/format/webp/quality/85'
          }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      // 无 fileID 时 displayUrl 只是 400px 派生图：静默存进相册 = 用户以为存了原图
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '原图暂不可用，请稍后再试' })
      );
      expect(wx.downloadFile).not.toHaveBeenCalled();
      expect(wx.saveImageToPhotosAlbum).not.toHaveBeenCalled();
    });

    test('should still save an unoptimized third-party URL when the fileID is missing', async () => {
      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/original.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.saveImageToPhotosAlbum).toHaveBeenCalled();
    });

    test('should show toast when URL remains cloud:// after conversion', async () => {
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ tempFileURL: null }]
      });

      const page = createMockPage({
        data: {
          photos: [{
            displayUrl: 'cloud://abc',
            _cloudFileID: 'cloud://abc'
          }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '图片加载中，请稍后再试' })
      );
    });

    test('should handle fail auth error message', async () => {
      wx.saveImageToPhotosAlbum.mockRejectedValue({
        errMsg: 'saveImageToPhotosAlbum:fail auth'
      });

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/img.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.showModal).toHaveBeenCalled();
    });

    test('should show toast when download statusCode is not 200', async () => {
      wx.showToast.mockClear();
      wx.saveImageToPhotosAlbum.mockResolvedValue({});
      wx.downloadFile.mockResolvedValue({ statusCode: 403, tempFilePath: '' });

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/expired.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.saveImageToPhotosAlbum).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '保存失败，请重试' })
      );
    });

    test('should show toast when downloadFile rejects', async () => {
      wx.showToast.mockClear();
      wx.downloadFile.mockRejectedValue(new Error('download fail'));

      const page = createMockPage({
        data: {
          photos: [{ displayUrl: 'https://example.com/img.jpg' }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.saveImageToPhotosAlbum).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '保存失败，请重试' })
      );
    });

    test('should fetch original image via cloud fileID instead of compressed displayUrl', async () => {
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ tempFileURL: 'https://temp.url/origin.jpg' }]
      });
      wx.downloadFile.mockResolvedValue({ statusCode: 200, tempFilePath: 'wxfile://tmp/origin.jpg' });

      const page = createMockPage({
        data: {
          photos: [{
            displayUrl: 'https://temp.url/origin.jpg?imageMogr2/thumbnail/400x400>/format/webp/quality/85',
            _cloudFileID: 'cloud://abc'
          }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0 } } };

      await saveImageToAlbum(page, e);

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledWith(
        expect.objectContaining({ fileList: ['cloud://abc'] })
      );
      expect(wx.downloadFile).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://temp.url/origin.jpg' })
      );
    });
  });

  describe('togglePhotoLike', () => {
    test('should optimistically update like state', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: false, likeCount: 5 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      const setDataCall = page.setData.mock.calls.find(c => c[0].photos);
      expect(setDataCall[0].photos[0]._liked).toBe(true);
      expect(setDataCall[0].photos[0].likeCount).toBe(6);
    });

    test('should rollback on cloud function failure', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('like error'));

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: false, likeCount: 5 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      const rollbackCall = page.setData.mock.calls.filter(c => c[0].photos);
      const lastCall = rollbackCall[rollbackCall.length - 1];
      expect(lastCall[0].photos[0]._liked).toBe(false);
      expect(lastCall[0].photos[0].likeCount).toBe(5);
    });

    test('should rollback when result success is false', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: false }
      });

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: false, likeCount: 5 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      const rollbackCall = page.setData.mock.calls.filter(c => c[0].photos);
      const lastCall = rollbackCall[rollbackCall.length - 1];
      expect(lastCall[0].photos[0]._liked).toBe(false);
      expect(lastCall[0].photos[0].likeCount).toBe(5);
    });

    test('should return early when photo not found', async () => {
      const page = createMockPage({ data: { photos: [] } });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      expect(wx.cloud.callFunction).not.toHaveBeenCalled();
    });

    test('should decrement like count when unliking', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: true, likeCount: 5 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      const setDataCall = page.setData.mock.calls.find(c => c[0].photos);
      expect(setDataCall[0].photos[0]._liked).toBe(false);
      expect(setDataCall[0].photos[0].likeCount).toBe(4);
    });

    test('should not decrement below 0', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: true, likeCount: 0 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      const setDataCall = page.setData.mock.calls.find(c => c[0].photos);
      expect(setDataCall[0].photos[0].likeCount).toBe(0);
    });

    test('should compute total likes after toggle', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true }
      });

      const page = createMockPage({
        data: {
          photos: [{ _id: 'p1', _liked: false, likeCount: 5 }]
        }
      });
      const e = { currentTarget: { dataset: { index: 0, photoId: 'p1' } } };

      await togglePhotoLike(page, e);

      expect(page._computeTotalLikes).toHaveBeenCalled();
    });
  });
});
