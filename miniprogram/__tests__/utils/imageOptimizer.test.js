const ImageOptimizer = require('../../utils/imageOptimizer');

describe('ImageOptimizer', () => {
  describe('optimizeImageUrl', () => {
    test('should add optimization params to cloud URL', () => {
      const result = ImageOptimizer.optimizeImageUrl('cloud://test.jpg', {
        width: 400, height: 400, quality: 85, format: 'webp'
      });
      expect(result).toContain('imageMogr2');
      expect(result).toContain('format/webp');
      expect(result).toContain('quality/85');
      expect(result).toContain('thumbnail/400x400>');
    });

    test('should add optimization params to TCB temp https URL', () => {
      const result = ImageOptimizer.optimizeImageUrl('https://myenv.tcb.qcloud.la/image.jpg');
      expect(result).toContain('imageMogr2');
    });

    test('should return third-party https URL as-is (imageMogr2 only works on TCB)', () => {
      const url = 'https://example.com/image.jpg';
      expect(ImageOptimizer.optimizeImageUrl(url)).toBe(url);
    });

    test('should return URL as-is if already optimized', () => {
      const url = 'cloud://test.jpg?imageMogr2/format/jpg';
      expect(ImageOptimizer.optimizeImageUrl(url)).toBe(url);
    });

    test('should return empty string for empty URL', () => {
      expect(ImageOptimizer.optimizeImageUrl('')).toBe('');
    });

    test('should return null for null URL', () => {
      expect(ImageOptimizer.optimizeImageUrl(null)).toBeNull();
    });

    test('should return URL as-is for non-cloud/non-https', () => {
      expect(ImageOptimizer.optimizeImageUrl('wxfile://tmp')).toBe('wxfile://tmp');
    });

    test('should use default params', () => {
      const result = ImageOptimizer.optimizeImageUrl('cloud://test.jpg');
      expect(result).toContain('quality/80');
      expect(result).toContain('format/jpg');
      expect(result).toContain('thumbnail/300x300>');
    });
  });

  describe('getAvatarUrl', () => {
    test('should return 100x100 optimized URL', () => {
      const result = ImageOptimizer.getAvatarUrl('cloud://test.jpg');
      expect(result).toContain('thumbnail/100x100>');
      expect(result).toContain('format/webp');
      expect(result).toContain('quality/85');
    });

    test('should handle empty URL', () => {
      expect(ImageOptimizer.getAvatarUrl('')).toBe('');
    });
  });

  describe('getThumbnailUrl', () => {
    test('should return 200x200 thumbnail URL', () => {
      const result = ImageOptimizer.getThumbnailUrl('cloud://test.jpg');
      expect(result).toContain('thumbnail/200x200>');
    });
  });

  describe('getGalleryUrl', () => {
    test('should return 400x400 gallery URL', () => {
      const result = ImageOptimizer.getGalleryUrl('cloud://test.jpg');
      expect(result).toContain('thumbnail/400x400>');
    });
  });

  describe('getDetailUrl', () => {
    test('should return 600x600 detail URL', () => {
      const result = ImageOptimizer.getDetailUrl('cloud://test.jpg');
      expect(result).toContain('thumbnail/600x600>');
      expect(result).toContain('quality/90');
      expect(result).toContain('format/jpg');
    });
  });

  describe('getShareUrl（2026-10-12 分享糊图回归）', () => {
    // 背景：详情页分享卡片图原样用了页面头像档（100x100 webp），被微信卡片放大成糊图。
    // getShareUrl 的核心契约：**替换**已存在的 imageMogr2 段，而不是像 optimizeImageUrl 那样幂等跳过。
    test('替换已存在的缩略参数：100×100 头像档 → 800×640 分享档', () => {
      const url = 'https://env.tcb.qcloud.la/a.jpg?sign=s&t=1&imageMogr2/thumbnail/100x100>/format/webp/quality/85';
      const result = ImageOptimizer.getShareUrl(url);
      expect(result).toContain('thumbnail/800x640>');
      expect(result).toContain('format/jpg');
      expect(result).not.toContain('100x100');
      expect(result).not.toContain('webp');
      // 旧签名参数必须保留（剥掉的只能是 imageMogr2 段）
      expect(result).toContain('sign=s');
      expect(result).toContain('&imageMogr2/');
    });

    test('400×400 聚合档同样被替换', () => {
      const url = 'https://env.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/400x400>/format/webp/quality/85';
      const result = ImageOptimizer.getShareUrl(url);
      expect(result).toContain('thumbnail/800x640>');
      expect(result).not.toContain('400x400');
    });

    test('干净链接直接追加（已有查询串用 & 连接）', () => {
      const result = ImageOptimizer.getShareUrl('https://env.tcb.qcloud.la/a.jpg?sign=s');
      expect(result).toBe('https://env.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/800x640>/format/jpg/quality/85');
    });

    test('仅带 imageMogr2 的链接：剥掉后用 ? 重新拼接', () => {
      const result = ImageOptimizer.getShareUrl('cloud://test.jpg?imageMogr2/thumbnail/100x100>/format/webp/quality/85');
      expect(result).toBe('cloud://test.jpg?imageMogr2/thumbnail/800x640>/format/jpg/quality/85');
    });

    test('第三方直链原样返回（imageMogr2 对其无效）', () => {
      const url = 'https://example.com/a.jpg';
      expect(ImageOptimizer.getShareUrl(url)).toBe(url);
    });

    test('空值原样返回', () => {
      expect(ImageOptimizer.getShareUrl('')).toBe('');
      expect(ImageOptimizer.getShareUrl(null)).toBeNull();
    });
  });

  describe('optimizeBatch', () => {
    test('should batch optimize URLs', () => {
      const urls = ['cloud://1.jpg', 'cloud://2.jpg', 'cloud://3.jpg'];
      const results = ImageOptimizer.optimizeBatch(urls, 'thumbnail');
      expect(results).toHaveLength(3);
      results.forEach(r => expect(r).toContain('imageMogr2'));
    });

    test('should return empty array for non-array input', () => {
      expect(ImageOptimizer.optimizeBatch(null)).toEqual([]);
      expect(ImageOptimizer.optimizeBatch('not array')).toEqual([]);
    });

    test('should use default thumbnail for invalid type', () => {
      const results = ImageOptimizer.optimizeBatch(['cloud://test.jpg'], 'invalid');
      expect(results[0]).toContain('thumbnail/200x200>');
    });

    test('should optimize avatar type', () => {
      const results = ImageOptimizer.optimizeBatch(['cloud://test.jpg'], 'avatar');
      expect(results[0]).toContain('thumbnail/100x100>');
    });

    test('should optimize gallery type', () => {
      const results = ImageOptimizer.optimizeBatch(['cloud://test.jpg'], 'gallery');
      expect(results[0]).toContain('thumbnail/400x400>');
    });

    test('should optimize detail type', () => {
      const results = ImageOptimizer.optimizeBatch(['cloud://test.jpg'], 'detail');
      expect(results[0]).toContain('thumbnail/600x600>');
    });
  });

  describe('needsOptimization', () => {
    test('should return true for unoptimized cloud URL', () => {
      expect(ImageOptimizer.needsOptimization('cloud://test.jpg')).toBe(true);
    });

    test('should return false for already optimized URL', () => {
      expect(ImageOptimizer.needsOptimization('cloud://test.jpg?imageMogr2/format/jpg')).toBe(false);
    });

    test('should return true for unoptimized https URL', () => {
      expect(ImageOptimizer.needsOptimization('https://example.com/img.jpg')).toBe(true);
    });

    test('should return false for empty URL', () => {
      expect(ImageOptimizer.needsOptimization('')).toBe(false);
    });

    test('should return false for null URL', () => {
      expect(ImageOptimizer.needsOptimization(null)).toBe(false);
    });

    test('should return false for local path', () => {
      expect(ImageOptimizer.needsOptimization('/images/cat.png')).toBe(false);
    });
  });

  describe('imageMogr2 参数结构契约（防回归：| 曾导致只有第一段生效）', () => {
    // 数据万象里 "|" 是「多请求管道」操作符，每段都要自带 imageMogr2/ 前缀；
    // 单请求内多操作必须用 "/" 串联，否则只有第一段生效。
    // 原实现 `format/..|quality/..|thumbnail/..` 实测对 960x540 原图返回 136010B 全尺寸原图。
    const TIERS = [
      ['getAvatarUrl', 100],
      ['getThumbnailUrl', 200],
      ['getGalleryUrl', 400],
      ['getDetailUrl', 600]
    ];

    test.each(TIERS)('%s 产出的参数串不含 | 且 thumbnail 早于 format', (method, size) => {
      const result = ImageOptimizer[method]('cloud://test.jpg?sign=abc');
      const query = result.slice(result.indexOf('imageMogr2'));

      expect(query).not.toContain('|');
      expect(query).toContain(`thumbnail/${size}x${size}>`);
      expect(query.indexOf('thumbnail/')).toBeGreaterThan(-1);
      expect(query.indexOf('thumbnail/')).toBeLessThan(query.indexOf('format/'));
      expect(query.indexOf('format/')).toBeLessThan(query.indexOf('quality/'));
    });

    test.each(TIERS)('%s 的 thumbnail 值是 "宽x高>" 收缩语义', (method, size) => {
      const query = ImageOptimizer[method]('cloud://test.jpg');
      expect(query).toContain(`imageMogr2/thumbnail/${size}x${size}>/`);
    });

    test('默认档位同样满足结构契约', () => {
      const query = ImageOptimizer.optimizeImageUrl('cloud://test.jpg');
      expect(query).not.toContain('|');
      expect(query).toContain('imageMogr2/thumbnail/300x300>/format/jpg/quality/80');
    });
  });

  describe('http:// TCB 直链', () => {
    test('should optimize legacy http TCB temp URL', () => {
      const result = ImageOptimizer.optimizeImageUrl('http://myenv.tcb.qcloud.la/image.jpg');
      expect(result).toContain('imageMogr2/thumbnail/300x300>');
    });

    test('needsOptimization should be true for http TCB URL', () => {
      expect(ImageOptimizer.needsOptimization('http://myenv.tcb.qcloud.la/image.jpg')).toBe(true);
    });

    test('should still skip third-party http URL', () => {
      const url = 'http://example.com/image.jpg';
      expect(ImageOptimizer.optimizeImageUrl(url)).toBe(url);
    });
  });

  describe('getImageInfo', () => {
    test('should call wx.getImageInfo', async () => {
      wx.getImageInfo = jest.fn(({ success }) => success({ width: 100, height: 100 }));
      const result = await ImageOptimizer.getImageInfo('cloud://test.jpg');
      expect(result).toEqual({ width: 100, height: 100 });
    });

    test('should reject on failure', async () => {
      wx.getImageInfo = jest.fn(({ fail }) => fail(new Error('fail')));
      await expect(ImageOptimizer.getImageInfo('cloud://bad.jpg')).rejects.toThrow('fail');
    });
  });

  describe('preloadImages', () => {
    test('should not throw for non-array input', () => {
      expect(() => ImageOptimizer.preloadImages(null)).not.toThrow();
      expect(() => ImageOptimizer.preloadImages('string')).not.toThrow();
    });

    test('should skip null/empty URLs', () => {
      wx.getImageInfo = jest.fn(({ success }) => success({ width: 100, height: 100 }));
      ImageOptimizer.preloadImages([null, '', 'cloud://test.jpg']);
    });
  });

  // loadImageWithRetry / batchLoadWithRetry 已删除（全仓无调用方，且返回的 URL 不含尺寸参数，
  // 调用方会静默绕过 imageLoader 的档位与缓存）。取临时链接统一走 utils/imageLoader.getTempUrls。

  describe('已删除的绕过优化链 API', () => {
    test('不应再暴露 loadImageWithRetry / batchLoadWithRetry', () => {
      expect(ImageOptimizer.loadImageWithRetry).toBeUndefined();
      expect(ImageOptimizer.batchLoadWithRetry).toBeUndefined();
    });
  });
});
