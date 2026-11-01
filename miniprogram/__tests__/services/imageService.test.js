const {
  resolveAvatarsAsync,
  preloadFirstScreen,
  onImageLoad,
  onImageError
} = require('../../services/imageService');

jest.mock('../../utils/imageLoader', () => ({
  preloadAboveFold: jest.fn()
}));

jest.mock('../../utils/imageRetryManager', () => ({
  handleError: jest.fn()
}));

jest.mock('../../utils/avatarHelper', () => ({
  resolveCatAvatars: jest.fn(cats => Promise.resolve(cats))
}));

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

function createMockPage(overrides = {}) {
  return {
    data: {
      cats: [],
      filteredCats: [],
      ...overrides.data
    },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _retryingCatIds: null,
    ...overrides
  };
}

describe('imageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolveAvatarsAsync', () => {
    test('should resolve avatars and batch setData', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const cats = [
        { _id: '1', avatar: 'cloud://a1', _cloudFileID: 'cloud://a1', avatarLoaded: false },
        { _id: '2', avatar: 'cloud://a2', _cloudFileID: 'cloud://a2', avatarLoaded: false }
      ];
      AvatarHelper.resolveCatAvatars.mockResolvedValue(cats);

      const page = createMockPage({
        data: {
          cats: [
            { _id: '1', avatar: '', _cloudFileID: '', avatarLoaded: false },
            { _id: '2', avatar: '', _cloudFileID: '', avatarLoaded: false }
          ],
          filteredCats: [
            { _id: '1', avatar: '', _cloudFileID: '', avatarLoaded: false },
            { _id: '2', avatar: '', _cloudFileID: '', avatarLoaded: false }
          ]
        }
      });

      await resolveAvatarsAsync(cats, page);

      // 首页专用：档位必须是 gallery（220rpx 大头照需要 400x400 源图，
      // avatar 档的 100x100 会被放大 2~3 倍 —— 见 services/catService.js 同档位注释）
      expect(AvatarHelper.resolveCatAvatars)
        .toHaveBeenCalledWith(cats, page.data.cats, { type: 'gallery' });
      expect(page.setData).toHaveBeenCalled();
    });

    test('should return early when cats is empty', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const page = createMockPage();

      await resolveAvatarsAsync([], page);

      expect(AvatarHelper.resolveCatAvatars).not.toHaveBeenCalled();
    });

    test('should return early when cats is null', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const page = createMockPage();

      await resolveAvatarsAsync(null, page);

      expect(AvatarHelper.resolveCatAvatars).not.toHaveBeenCalled();
    });

    test('should return early when cats is undefined', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const page = createMockPage();

      await resolveAvatarsAsync(undefined, page);

      expect(AvatarHelper.resolveCatAvatars).not.toHaveBeenCalled();
    });

    test('should handle errors gracefully', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      AvatarHelper.resolveCatAvatars.mockRejectedValue(new Error('resolve error'));

      const cats = [{ _id: '1', avatar: 'cloud://a1' }];
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatar: '' }],
          filteredCats: [{ _id: '1', avatar: '' }]
        }
      });

      await expect(resolveAvatarsAsync(cats, page)).resolves.toBeUndefined();
    });

    test('should only patch cats with _id and avatar', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const resolvedCats = [
        { _id: '1', avatar: 'url1', _cloudFileID: 'cloud://1', avatarLoaded: true },
        { _id: '2', avatar: null, _cloudFileID: null, avatarLoaded: false }
      ];
      AvatarHelper.resolveCatAvatars.mockResolvedValue(resolvedCats);

      const page = createMockPage({
        data: {
          cats: [
            { _id: '1', avatar: '' },
            { _id: '2', avatar: '' }
          ],
          filteredCats: [
            { _id: '1', avatar: '' },
            { _id: '2', avatar: '' }
          ]
        }
      });

      await resolveAvatarsAsync(resolvedCats, page);

      const setDataCalls = page.setData.mock.calls.map(c => c[0]);
      const hasCat1Patch = setDataCalls.some(obj => obj['cats[0].avatar'] === 'url1');
      expect(hasCat1Patch).toBe(true);
    });

    test('should batch setData in groups of 8', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const cats = Array.from({ length: 12 }, (_, i) => ({
        _id: String(i), avatar: `url${i}`, _cloudFileID: `cloud://${i}`, avatarLoaded: true
      }));
      AvatarHelper.resolveCatAvatars.mockResolvedValue(cats);

      const page = createMockPage({
        data: {
          cats: cats.map(c => ({ ...c, avatar: '' })),
          filteredCats: cats.map(c => ({ ...c, avatar: '' }))
        }
      });

      await resolveAvatarsAsync(cats, page);

      const batchCalls = page.setData.mock.calls.filter(
        c => Object.keys(c[0]).some(k => k.startsWith('cats['))
      );
      expect(batchCalls.length).toBeGreaterThanOrEqual(2);
    });

    test('should update both cats and filteredCats indices', async () => {
      const AvatarHelper = require('../../utils/avatarHelper');
      const resolvedCats = [
        { _id: '1', avatar: 'url1', _cloudFileID: 'cloud://1', avatarLoaded: true }
      ];
      AvatarHelper.resolveCatAvatars.mockResolvedValue(resolvedCats);

      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatar: '' }],
          filteredCats: [{ _id: '1', avatar: '' }]
        }
      });

      await resolveAvatarsAsync(resolvedCats, page);

      const setDataCall = page.setData.mock.calls.find(
        c => c[0]['cats[0].avatar'] !== undefined
      );
      expect(setDataCall[0]).toEqual(
        expect.objectContaining({
          'cats[0].avatar': 'url1',
          'filteredCats[0].avatar': 'url1'
        })
      );
    });
  });

  describe('preloadFirstScreen', () => {
    // 档位必须是 gallery：imageLoader 的缓存键是「fileID@档位」，
    // 首页 wxml 的 lazy-image 已改用 gallery（220rpx 大头照需要 400×400 源图）。
    // 用 avatar 档预热出来的条目永远不会被渲染侧的 gallery 请求命中，预热等于白做。
    test('should preload first 10 avatars', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = Array.from({ length: 15 }, (_, i) => ({
        _id: String(i), avatar: `cloud://avatar${i}`
      }));

      preloadFirstScreen(cats);

      expect(imageLoader.preloadAboveFold).toHaveBeenCalledWith(
        expect.arrayContaining(['cloud://avatar0']),
        'gallery'
      );
      const calledIds = imageLoader.preloadAboveFold.mock.calls[0][0];
      expect(calledIds.length).toBe(10);
    });

    test('should handle empty cats array', () => {
      const imageLoader = require('../../utils/imageLoader');

      preloadFirstScreen([]);

      expect(imageLoader.preloadAboveFold).not.toHaveBeenCalled();
    });

    // 只预热 gallery 时，卡片渐进式加载的 thumbnail 占位档是缓存未命中，
    // 每张卡各发一次单文件转链（首屏最多 10 次）；两档各预热一批才能收敛掉。
    test('两档都要预热：gallery（渲染档）与 thumbnail（渐进式占位档）', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = [{ _id: '1', avatar: 'cloud://avatar1' }];

      preloadFirstScreen(cats);

      expect(imageLoader.preloadAboveFold).toHaveBeenCalledWith(['cloud://avatar1'], 'gallery');
      expect(imageLoader.preloadAboveFold).toHaveBeenCalledWith(['cloud://avatar1'], 'thumbnail');
    });

    test('gallery 档必须先于 thumbnail 档（顺序变化不应悄悄发生）', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = [{ _id: '1', avatar: 'cloud://avatar1' }];

      preloadFirstScreen(cats);

      const types = imageLoader.preloadAboveFold.mock.calls.map(c => c[1]);
      expect(types).toEqual(['gallery', 'thumbnail']);
    });

    test('should filter out non-cloud avatar IDs', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = [
        { _id: '1', avatar: 'https://example.com/img.jpg' },
        { _id: '2', avatar: 'cloud://avatar2' }
      ];

      preloadFirstScreen(cats);

      expect(imageLoader.preloadAboveFold).toHaveBeenCalledWith(
        ['cloud://avatar2'], 'gallery'
      );
    });

    test('should use _cloudFileID as fallback', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = [
        { _id: '1', _cloudFileID: 'cloud://fallback1' },
        { _id: '2', avatar: 'cloud://avatar2' }
      ];

      preloadFirstScreen(cats);

      expect(imageLoader.preloadAboveFold).toHaveBeenCalledWith(
        ['cloud://fallback1', 'cloud://avatar2'], 'gallery'
      );
    });

    test('should not call preload when all IDs are non-cloud', () => {
      const imageLoader = require('../../utils/imageLoader');
      const cats = [
        { _id: '1', avatar: 'https://example.com/1.jpg' },
        { _id: '2', avatar: 'https://example.com/2.jpg' }
      ];

      preloadFirstScreen(cats);

      expect(imageLoader.preloadAboveFold).not.toHaveBeenCalled();
    });
  });

  describe('onImageLoad', () => {
    test('should mark avatarLoaded true for matching cat', () => {
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatarLoaded: false }],
          filteredCats: [{ _id: '1', avatarLoaded: false }]
        }
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageLoad(e, page);

      expect(page.setData).toHaveBeenCalledWith({
        'cats[0].avatarLoaded': true,
        'filteredCats[0].avatarLoaded': true
      });
    });

    test('should clear cat from retrying set', () => {
      const retrySet = new Set(['1', '2']);
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatarLoaded: false }],
          filteredCats: [{ _id: '1', avatarLoaded: false }]
        },
        _retryingCatIds: retrySet
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageLoad(e, page);

      expect(retrySet.has('1')).toBe(false);
      expect(retrySet.has('2')).toBe(true);
    });

    test('should handle cat not in cats array', () => {
      const page = createMockPage({
        data: {
          cats: [{ _id: '2', avatarLoaded: false }],
          filteredCats: []
        }
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageLoad(e, page);

      expect(page.setData).not.toHaveBeenCalled();
    });

    test('should handle cat not in filteredCats array', () => {
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatarLoaded: false }],
          filteredCats: [{ _id: '2', avatarLoaded: false }]
        }
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageLoad(e, page);

      expect(page.setData).toHaveBeenCalledWith({
        'cats[0].avatarLoaded': true
      });
    });

    test('should not throw when _retryingCatIds is null', () => {
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', avatarLoaded: false }],
          filteredCats: []
        },
        _retryingCatIds: null
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      expect(() => onImageLoad(e, page)).not.toThrow();
    });
  });

  describe('onImageError', () => {
    test('should add cat to retry set and call imageRetryManager', () => {
      const imageRetryManager = require('../../utils/imageRetryManager');
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', _cloudFileID: 'cloud://avatar1' }],
          filteredCats: []
        }
      });
      const e = { currentTarget: { dataset: { id: '1' } }, detail: { errMsg: 'load fail' } };

      onImageError(e, page);

      expect(page._retryingCatIds).toBeInstanceOf(Set);
      expect(page._retryingCatIds.has('1')).toBe(true);
      expect(imageRetryManager.handleError).toHaveBeenCalledWith(
        // 第四个参数是尺寸档位：必须与首屏解析一致（gallery），
        // 否则重试成功会把已经清晰的头像换成 100x100 的糊图
        '1', 'cloud://avatar1', page, 'gallery'
      );
    });

    test('should prevent duplicate retries for same cat', () => {
      const imageRetryManager = require('../../utils/imageRetryManager');
      const retrySet = new Set(['1']);
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', _cloudFileID: 'cloud://avatar1' }],
          filteredCats: []
        },
        _retryingCatIds: retrySet
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageError(e, page);

      expect(imageRetryManager.handleError).not.toHaveBeenCalled();
    });

    test('should initialize _retryingCatIds if not set', () => {
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', _cloudFileID: 'cloud://avatar1' }],
          filteredCats: []
        },
        _retryingCatIds: null
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageError(e, page);

      expect(page._retryingCatIds).toBeInstanceOf(Set);
      expect(page._retryingCatIds.has('1')).toBe(true);
    });

    test('should remove from retry set when cat not found', () => {
      const imageRetryManager = require('../../utils/imageRetryManager');
      const page = createMockPage({
        data: {
          cats: [{ _id: '2', _cloudFileID: 'cloud://avatar2' }],
          filteredCats: []
        }
      });
      const e = { currentTarget: { dataset: { id: '1' } } };

      onImageError(e, page);

      expect(page._retryingCatIds.has('1')).toBe(false);
      expect(imageRetryManager.handleError).not.toHaveBeenCalled();
    });

    test('should log warning with error message', () => {
      const { Logger } = require('../../utils/logger');
      const page = createMockPage({
        data: {
          cats: [{ _id: '1', _cloudFileID: 'cloud://avatar1' }],
          filteredCats: []
        }
      });
      const e = {
        currentTarget: { dataset: { id: '1' } },
        detail: { errMsg: 'image load timeout' }
      };

      onImageError(e, page);

      expect(Logger.warn).toHaveBeenCalledWith(
        'index',
        '图片加载失败，将尝试重试',
        expect.objectContaining({ catId: '1', error: 'image load timeout' })
      );
    });
  });
});
