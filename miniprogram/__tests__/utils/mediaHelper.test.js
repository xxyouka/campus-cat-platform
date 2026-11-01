const MediaHelper = require('../../utils/mediaHelper');

jest.mock('../../utils/imageLoader', () => ({
  getTempUrls: jest.fn()
}));

jest.mock('../../utils/imageOptimizer', () => {
  // 模拟真实实现的追加形态：单请求内用 "/" 串联，thumbnail 在首位
  const getAvatarUrl = jest.fn(url => url ? `${url}?optimized&imageMogr2/thumbnail/100x100>/format/webp/quality/85` : '');
  const getThumbnailUrl = jest.fn(url => url ? `thumb_${url}` : '');
  const getGalleryUrl = jest.fn(url => url ? `${url}?optimized&imageMogr2/thumbnail/400x400>/format/webp/quality/85` : '');
  // 真实实现的 type 分派入口（mediaHelper 的 toAvatarUrl 现在走这里）
  const dispatch = { avatar: getAvatarUrl, thumbnail: getThumbnailUrl, gallery: getGalleryUrl, detail: getThumbnailUrl };
  const getOptimizedUrl = jest.fn((url, type = 'thumbnail') => (dispatch[type] || getThumbnailUrl)(url));
  return { getAvatarUrl, getThumbnailUrl, getGalleryUrl, getDetailUrl: getThumbnailUrl, getOptimizedUrl };
});

const imageLoader = require('../../utils/imageLoader');
const ImageOptimizer = require('../../utils/imageOptimizer');

describe('MediaHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('selectAvatar', () => {
    test('should return null for null cat', () => {
      expect(MediaHelper.selectAvatar(null)).toBeNull();
    });

    test('should return avatar if present', () => {
      expect(MediaHelper.selectAvatar({ avatar: 'http://cat.jpg' })).toBe('http://cat.jpg');
    });

    test('should return first image as fallback', () => {
      expect(MediaHelper.selectAvatar({ images: ['http://img1.jpg'] })).toBe('http://img1.jpg');
    });

    test('should return null when no avatar or images', () => {
      expect(MediaHelper.selectAvatar({ name: '小花' })).toBeNull();
    });

    test('should prefer avatar over images', () => {
      expect(MediaHelper.selectAvatar({ avatar: 'http://avatar.jpg', images: ['http://img.jpg'] }))
        .toBe('http://avatar.jpg');
    });

    test('should return null for empty images array', () => {
      expect(MediaHelper.selectAvatar({ images: [] })).toBeNull();
    });
  });

  describe('resolveSingleUrl', () => {
    test('should return empty string for null url', async () => {
      expect(await MediaHelper.resolveSingleUrl(null)).toBe('');
    });

    test('should return empty string for empty url', async () => {
      expect(await MediaHelper.resolveSingleUrl('')).toBe('');
    });

    test('should optimize http url by default', async () => {
      const result = await MediaHelper.resolveSingleUrl('http://example.com/cat.jpg');
      expect(result).toContain('optimized');
    });

    test('should return raw http url when optimize is false', async () => {
      const result = await MediaHelper.resolveSingleUrl('http://example.com/cat.jpg', { optimize: false });
      expect(result).toBe('http://example.com/cat.jpg');
    });

    test('should resolve cloud:// url', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://test': 'http://resolved.jpg' });
      const result = await MediaHelper.resolveSingleUrl('cloud://test');
      expect(result).toBe('http://resolved.jpg');
    });

    test('should fallback to original cloud url on error', async () => {
      imageLoader.getTempUrls.mockRejectedValue(new Error('fail'));
      const result = await MediaHelper.resolveSingleUrl('cloud://test');
      expect(result).toBe('cloud://test');
    });

    test('should return url as-is for other protocols', async () => {
      const result = await MediaHelper.resolveSingleUrl('wxfile://tmp');
      expect(result).toBe('wxfile://tmp');
    });
  });

  describe('resolveCatAvatars', () => {
    test('should return cats as-is for empty array', async () => {
      const result = await MediaHelper.resolveCatAvatars([]);
      expect(result).toEqual([]);
    });

    test('should return cats as-is for null', async () => {
      const result = await MediaHelper.resolveCatAvatars(null);
      expect(result).toBeNull();
    });

    test('should process cats with http avatars', async () => {
      const cats = [{ _id: '1', name: '小花', avatar: 'http://cat.jpg' }];
      const result = await MediaHelper.resolveCatAvatars(cats);
      expect(result[0].avatar).toBe('http://cat.jpg');
      expect(result[0].photoCount).toBe(0);
    });

    test('should process cats with cloud:// avatars', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://test': 'http://resolved.jpg' });
      const cats = [{ _id: '1', name: '小花', avatar: 'cloud://test' }];
      const result = await MediaHelper.resolveCatAvatars(cats);
      // 主路径与降级路径共用同一个出口函数（getAvatarUrl 在真实实现中对已带 imageMogr2 的 URL 幂等，
      // 因此这里是「同一形态」的断言，而不是对 mock 前缀本身的断言）
      expect(result[0].avatar).toBe(ImageOptimizer.getAvatarUrl('http://resolved.jpg'));
    });

    test('should use existing avatarLoaded status', async () => {
      const cats = [{ _id: '1', name: '小花', avatar: 'http://cat.jpg' }];
      const existing = [{ _id: '1', avatarLoaded: true }];
      const result = await MediaHelper.resolveCatAvatars(cats, existing);
      expect(result[0].avatarLoaded).toBe(true);
    });

    // 首页大头照回归：.cat-image-wrap 是 220rpx（@2x/@3x 需 220/330 物理像素），
    // options.type 以前只被 resolveSingleUrl 读取、resolveCatAvatars 两处硬编码 avatar，
    // 于是首页怎么传都拿回 100x100，被放大 2~3 倍 → 糊。
    test('options.type 必须透传到 getTempUrls 与最终 URL（首页 gallery 档回归）', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://test': 'http://resolved.jpg' });
      const cats = [{ _id: '1', name: '小花', avatar: 'cloud://test' }];

      const result = await MediaHelper.resolveCatAvatars(cats, [], { type: 'gallery' });

      expect(imageLoader.getTempUrls).toHaveBeenCalledWith(['cloud://test'], { optimizeType: 'gallery' });
      expect(result[0].avatar).toBe(ImageOptimizer.getGalleryUrl('http://resolved.jpg'));
      // 必须是 400x400 而不是 100x100
      expect(result[0].avatar).toContain('thumbnail/400x400>');
      expect(result[0].avatar).not.toContain('thumbnail/100x100>');
    });

    test('不传 options.type 时保持 avatar 档（向后兼容，另外 7 处小头像调用方不受影响）', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://test': 'http://resolved.jpg' });
      const cats = [{ _id: '1', name: '小花', avatar: 'cloud://test' }];

      const result = await MediaHelper.resolveCatAvatars(cats);

      expect(imageLoader.getTempUrls).toHaveBeenCalledWith(['cloud://test'], { optimizeType: 'avatar' });
      expect(result[0].avatar).toBe(ImageOptimizer.getAvatarUrl('http://resolved.jpg'));
    });

    test('降级路径（批量失败）也必须用同一档位，否则两条路径清晰度不一致', async () => {
      const tempUrl = 'https://env.tcb.qcloud.la/a.jpg';
      imageLoader.getTempUrls.mockRejectedValue(new Error('batch fail'));
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ status: 0, tempFileURL: tempUrl }]
      });

      const result = await MediaHelper.resolveCatAvatars(
        [{ _id: '1', avatar: 'cloud://test' }],
        [],
        { type: 'gallery' }
      );

      expect(result[0].avatar).toBe(ImageOptimizer.getGalleryUrl(tempUrl));
    });

    test('should use photoCountsMap', async () => {
      const cats = [{ _id: '1', name: '小花', avatar: 'http://cat.jpg' }];
      const result = await MediaHelper.resolveCatAvatars(cats, [], { photoCountsMap: { '1': 5 } });
      expect(result[0].photoCount).toBe(5);
    });

    test('should handle cloud url resolution failure gracefully', async () => {
      imageLoader.getTempUrls.mockRejectedValue(new Error('batch fail'));
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ status: 0, tempFileURL: 'http://fallback.jpg' }]
      });
      const cats = [{ _id: '1', name: '小花', avatar: 'cloud://test' }];
      const result = await MediaHelper.resolveCatAvatars(cats);
      expect(result[0]).toBeTruthy();
    });

    test('should return same avatar shape on main path and fallback path', async () => {
      const tempUrl = 'https://env.tcb.qcloud.la/a.jpg';
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://test': tempUrl });
      const main = await MediaHelper.resolveCatAvatars([{ _id: '1', avatar: 'cloud://test' }]);

      imageLoader.getTempUrls.mockRejectedValue(new Error('batch fail'));
      wx.cloud.getTempFileURL.mockResolvedValue({
        fileList: [{ status: 0, tempFileURL: tempUrl }]
      });
      const fallback = await MediaHelper.resolveCatAvatars([{ _id: '1', avatar: 'cloud://test' }]);

      expect(fallback[0].avatar).toBe(main[0].avatar);
    });

    test('should resolve all cloud avatars via fallback batches', async () => {
      imageLoader.getTempUrls.mockRejectedValue(new Error('batch fail'));
      wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
        Promise.resolve({ fileList: [{ status: 0, tempFileURL: `https://env.tcb.qcloud.la/${fileList[0].fileID}.jpg` }] })
      );
      const cats = Array.from({ length: 120 }, (_, i) => ({ _id: `c${i}`, avatar: `cloud://a${i}` }));

      const result = await MediaHelper.resolveCatAvatars(cats);

      expect(wx.cloud.getTempFileURL).toHaveBeenCalledTimes(120);
      result.forEach(cat => expect(cat.avatar).toContain('imageMogr2'));
    });

    test('should format updateTime', async () => {
      const date = new Date('2026-01-15T10:00:00Z');
      const cats = [{ _id: '1', name: '小花', avatar: 'http://cat.jpg', updateTime: date }];
      const result = await MediaHelper.resolveCatAvatars(cats);
      expect(result[0].updateTime).toBeTruthy();
    });
  });

  describe('resolvePhotoUrls', () => {
    test('should fill displayUrl fallback when no cloud urls', async () => {
      const photos = [{ url: 'http://photo1.jpg' }, { url: 'http://photo2.jpg' }];
      const result = await MediaHelper.resolvePhotoUrls(photos);
      // displayUrl 兜底为原始 url：详情页 wx:if 依赖 displayUrl/_cloudFileID，
      // 两者都缺失时整格照片会被隐藏
      expect(result.map(p => p.displayUrl)).toEqual(['http://photo1.jpg', 'http://photo2.jpg']);
    });

    test('should resolve cloud:// photo urls', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://photo': 'http://resolved.jpg' });
      const photos = [{ url: 'cloud://photo' }];
      const result = await MediaHelper.resolvePhotoUrls(photos);
      expect(result[0].displayUrl).toBe('http://resolved.jpg');
    });

    test('should keep cloud file id when requested', async () => {
      imageLoader.getTempUrls.mockResolvedValue({ 'cloud://photo': 'http://resolved.jpg' });
      const photos = [{ url: 'cloud://photo' }];
      const result = await MediaHelper.resolvePhotoUrls(photos, { keepCloudFileID: true });
      expect(result[0]._cloudFileID).toBe('cloud://photo');
    });

    test('should keep renderable fallback when resolution fails', async () => {
      imageLoader.getTempUrls.mockRejectedValue(new Error('fail'));
      const photos = [{ url: 'cloud://photo' }];
      const result = await MediaHelper.resolvePhotoUrls(photos, { keepCloudFileID: true });
      // 失败时也要保证照片格能渲染（displayUrl/_cloudFileID 至少有一个存在），
      // 交给 lazy-image 的转链/重试链路自愈
      expect(result[0].displayUrl).toBe('cloud://photo');
      expect(result[0]._cloudFileID).toBe('cloud://photo');
    });
  });

  describe('isValidUrl', () => {
    test('should return false for null', () => {
      expect(MediaHelper.isValidUrl(null)).toBe(false);
    });

    test('should return false for empty string', () => {
      expect(MediaHelper.isValidUrl('')).toBe(false);
    });

    test('should return false for non-string', () => {
      expect(MediaHelper.isValidUrl(123)).toBe(false);
    });

    test('should accept http url', () => {
      expect(MediaHelper.isValidUrl('http://example.com')).toBe(true);
    });

    test('should accept https url', () => {
      expect(MediaHelper.isValidUrl('https://example.com')).toBe(true);
    });

    test('should accept cloud:// url', () => {
      expect(MediaHelper.isValidUrl('cloud://test')).toBe(true);
    });

    test('should accept local path', () => {
      expect(MediaHelper.isValidUrl('/images/cat.png')).toBe(true);
    });

    test('should accept wxfile:// url', () => {
      expect(MediaHelper.isValidUrl('wxfile://tmp')).toBe(true);
    });

    test('should reject unknown protocol', () => {
      expect(MediaHelper.isValidUrl('ftp://example.com')).toBe(false);
    });
  });
});
