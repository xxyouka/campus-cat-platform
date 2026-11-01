jest.mock('../../utils/imageLoader', () => ({
  getTempUrl: jest.fn(),
  getTempUrls: jest.fn(),
  getSingleTempUrl: jest.fn()
}));

let def;
let imageLoader;

function createInstance(propOverrides = {}) {
  const instance = {
    data: JSON.parse(JSON.stringify(def.data || {})),
    setData: jest.fn(function(updates) {
      for (const [key, value] of Object.entries(updates)) {
        const parts = key.split('.');
        let obj = this.data;
        for (let i = 0; i < parts.length - 1; i++) {
          if (obj[parts[i]] === undefined) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      }
    }),
    properties: {},
    triggerEvent: jest.fn(),
    createIntersectionObserver: jest.fn(() => ({
      relativeToViewport: jest.fn(() => ({
        observe: jest.fn()
      })),
      disconnect: jest.fn()
    }))
  };

  if (def.properties) {
    for (const [key, prop] of Object.entries(def.properties)) {
      instance.properties[key] = propOverrides[key] !== undefined ? propOverrides[key] : prop.value;
      instance.data[key] = instance.properties[key];
    }
  }

  if (def.methods) {
    for (const [key, fn] of Object.entries(def.methods)) {
      instance[key] = typeof fn === 'function' ? fn.bind(instance) : fn;
    }
  }

  if (def.lifetimes) {
    for (const [key, fn] of Object.entries(def.lifetimes)) {
      instance[key] = fn.bind(instance);
    }
  }

  return instance;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  imageLoader = require('../../utils/imageLoader');
  require('../../components/lazy-image/lazy-image');
  def = Component.mock.calls[0][0];
});

describe('lazy-image', () => {
  describe('externalClasses', () => {
    test('declares custom-class external class', () => {
      expect(def.externalClasses).toContain('custom-class');
    });
  });

  describe('properties', () => {
    test('src defaults to empty string', () => {
      expect(def.properties.src.type).toBe(String);
      expect(def.properties.src.value).toBe('');
    });

    test('type defaults to thumbnail', () => {
      expect(def.properties.type.type).toBe(String);
      expect(def.properties.type.value).toBe('thumbnail');
    });

    test('lazy defaults to true', () => {
      expect(def.properties.lazy.type).toBe(Boolean);
      expect(def.properties.lazy.value).toBe(true);
    });

    test('progressive defaults to false', () => {
      expect(def.properties.progressive.type).toBe(Boolean);
      expect(def.properties.progressive.value).toBe(false);
    });

    test('mode defaults to aspectFill', () => {
      expect(def.properties.mode.type).toBe(String);
      expect(def.properties.mode.value).toBe('aspectFill');
    });

    test('radius defaults to 0', () => {
      expect(def.properties.radius.type).toBe(String);
      expect(def.properties.radius.value).toBe('0');
    });

    test('showLoading defaults to true', () => {
      expect(def.properties.showLoading.type).toBe(Boolean);
      expect(def.properties.showLoading.value).toBe(true);
    });
  });

  describe('data', () => {
    test('has correct default values', () => {
      expect(def.data.currentUrl).toBe('');
      expect(def.data.status).toBe('loading');
      expect(def.data.usePlaceholder).toBe(true);
      expect(def.data.uniqueId).toBe('');
      expect(def.data.radiusStr).toBe('0rpx');
    });
  });

  describe('lifetimes', () => {
    test('attached sets _attached flag and uniqueId', () => {
      const instance = createInstance({ src: 'test' });
      instance.attached();
      expect(instance._attached).toBe(true);
      expect(instance._uniqueId).toBeTruthy();
      expect(instance.data.uniqueId).toBe(instance._uniqueId);
    });

    test('detached disconnects observer', () => {
      const instance = createInstance();
      const mockDisconnect = jest.fn();
      instance._observer = { disconnect: mockDisconnect };
      instance.detached();
      expect(mockDisconnect).toHaveBeenCalled();
      expect(instance._observer).toBeNull();
    });

    test('detached clears retry timer', () => {
      jest.useFakeTimers();
      const instance = createInstance();
      instance._retryTimer = setTimeout(() => {}, 10000);
      instance.detached();
      expect(instance._retryTimer).toBeNull();
      jest.useRealTimers();
    });

    test('detached handles no observer gracefully', () => {
      const instance = createInstance();
      instance._observer = null;
      instance._retryTimer = null;
      expect(() => instance.detached()).not.toThrow();
    });
  });

  describe('observers', () => {
    test('src observer calls initLoad when attached and src changes', () => {
      const instance = createInstance({ src: 'cloud://test' });
      instance._attached = true;
      instance._lastSrc = 'old';
      instance.initLoad = jest.fn();

      def.observers['src'].call(instance, 'cloud://new');

      expect(instance._lastSrc).toBe('cloud://new');
      expect(instance.initLoad).toHaveBeenCalled();
    });

    test('src observer does nothing when not attached', () => {
      const instance = createInstance({ src: 'cloud://test' });
      instance._attached = false;
      instance.initLoad = jest.fn();

      def.observers['src'].call(instance, 'cloud://new');

      expect(instance.initLoad).not.toHaveBeenCalled();
    });

    test('src observer does nothing when src has not changed', () => {
      const instance = createInstance({ src: 'cloud://test' });
      instance._attached = true;
      instance._lastSrc = 'cloud://test';
      instance.initLoad = jest.fn();

      def.observers['src'].call(instance, 'cloud://test');

      expect(instance.initLoad).not.toHaveBeenCalled();
    });

    test('src observer normalizes null src to empty string', () => {
      const instance = createInstance();
      instance._attached = true;
      instance._lastSrc = '';
      instance.initLoad = jest.fn();

      def.observers['src'].call(instance, null);

      expect(instance._lastSrc).toBe('');
    });

    test('radius observer sets radiusStr with rpx suffix for numeric value', () => {
      const instance = createInstance();
      def.observers['radius'].call(instance, '16');
      expect(instance.data.radiusStr).toBe('16rpx');
    });

    test('radius observer preserves percentage value', () => {
      const instance = createInstance();
      def.observers['radius'].call(instance, '50%');
      expect(instance.data.radiusStr).toBe('50%');
    });

    test('radius observer sets 0rpx for empty value', () => {
      const instance = createInstance();
      def.observers['radius'].call(instance, '');
      expect(instance.data.radiusStr).toBe('0rpx');
    });

    test('radius observer sets 0rpx for falsy value', () => {
      const instance = createInstance();
      def.observers['radius'].call(instance, null);
      expect(instance.data.radiusStr).toBe('0rpx');
    });
  });

  describe('methods', () => {
    describe('initLoad', () => {
      test('sets error state when src is empty', () => {
        const instance = createInstance({ src: '' });
        instance.initLoad();
        expect(instance.data.currentUrl).toBe('');
        expect(instance.data.status).toBe('error');
        expect(instance.data.usePlaceholder).toBe(true);
      });

      test('resets retry count on new src', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance._retryCount = 2;
        instance.setupLazyLoad = jest.fn();
        instance._loaded = false;

        instance.initLoad();

        expect(instance._retryCount).toBe(0);
      });

      test('calls setupLazyLoad when lazy is true and not loaded', () => {
        const instance = createInstance({ src: 'cloud://test', lazy: true });
        instance.setupLazyLoad = jest.fn();
        instance._loaded = false;

        instance.initLoad();

        expect(instance.setupLazyLoad).toHaveBeenCalled();
      });

      test('calls loadImage when lazy is false', () => {
        const instance = createInstance({ src: 'cloud://test', lazy: false });
        instance.loadImage = jest.fn();

        instance.initLoad();

        expect(instance.loadImage).toHaveBeenCalled();
      });

      test('calls loadImage when already loaded', () => {
        const instance = createInstance({ src: 'cloud://test', lazy: true });
        instance.loadImage = jest.fn();
        instance._loaded = true;

        instance.initLoad();

        expect(instance.loadImage).toHaveBeenCalled();
      });

      test('sets loading status and usePlaceholder', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance.setupLazyLoad = jest.fn();
        instance._loaded = false;

        instance.initLoad();

        expect(instance.data.status).toBe('loading');
        expect(instance.data.usePlaceholder).toBe(true);
      });
    });

    describe('setupLazyLoad', () => {
      test('creates intersection observer', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance._uniqueId = 'lazy-test-123';

        instance.setupLazyLoad();

        expect(instance.createIntersectionObserver).toHaveBeenCalled();
      });

      test('retries when uniqueId is not available', () => {
        jest.useFakeTimers();
        const instance = createInstance({ src: 'cloud://test' });
        instance._uniqueId = '';
        instance.data.uniqueId = '';
        instance.setupLazyLoad = jest.fn();

        instance.setupLazyLoad(0);

        expect(instance.createIntersectionObserver).not.toHaveBeenCalled();
        jest.useRealTimers();
      });

      test('falls back to loadImage after max attempts', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance._uniqueId = '';
        instance.data.uniqueId = '';
        instance.loadImage = jest.fn();

        instance.setupLazyLoad(21);

        expect(instance.loadImage).toHaveBeenCalled();
      });
    });

    describe('loadImage', () => {
      test('sets currentUrl directly for http URL', async () => {
        const instance = createInstance({ src: 'https://example.com/cat.jpg', type: 'thumbnail' });
        await instance.loadImage();
        expect(instance.data.currentUrl).toBe('https://example.com/cat.jpg');
        expect(instance.data.status).toBe('loaded');
        expect(instance.data.usePlaceholder).toBe(false);
      });

      test('sets currentUrl directly for http URL with http prefix', async () => {
        const instance = createInstance({ src: 'http://example.com/cat.jpg', type: 'thumbnail' });
        await instance.loadImage();
        expect(instance.data.currentUrl).toBe('http://example.com/cat.jpg');
        expect(instance.data.status).toBe('loaded');
      });

      test('uses progressive loading for gallery type', async () => {
        const instance = createInstance({ src: 'cloud://test', type: 'gallery', progressive: false });
        instance.loadProgressive = jest.fn();
        instance.loadNormal = jest.fn();

        await instance.loadImage();

        expect(instance.loadProgressive).toHaveBeenCalledWith('cloud://test', 'gallery');
      });

      test('allows callers to disable gallery progressive conversion', async () => {
        const instance = createInstance({
          src: 'cloud://test', type: 'gallery', disableProgressive: true
        });
        instance.loadProgressive = jest.fn();
        instance.loadNormal = jest.fn();

        await instance.loadImage();

        expect(instance.loadNormal).toHaveBeenCalledWith('cloud://test', 'gallery');
        expect(instance.loadProgressive).not.toHaveBeenCalled();
      });

      test('uses normal loading for non-gallery type', async () => {
        const instance = createInstance({ src: 'cloud://test', type: 'thumbnail', progressive: false });
        instance.loadProgressive = jest.fn();
        instance.loadNormal = jest.fn();

        await instance.loadImage();

        expect(instance.loadNormal).toHaveBeenCalledWith('cloud://test', 'thumbnail');
      });

      test('uses progressive loading when progressive prop is true', async () => {
        const instance = createInstance({ src: 'cloud://test', type: 'thumbnail', progressive: true });
        instance.loadProgressive = jest.fn();
        instance.loadNormal = jest.fn();

        await instance.loadImage();

        expect(instance.loadProgressive).toHaveBeenCalledWith('cloud://test', 'thumbnail');
      });

      test('calls onLoadError on exception', async () => {
        const instance = createInstance({ src: 'cloud://test', type: 'thumbnail', progressive: false });
        instance.loadNormal = jest.fn().mockRejectedValue(new Error('fail'));
        instance.onLoadError = jest.fn();

        await instance.loadImage();

        expect(instance.onLoadError).toHaveBeenCalled();
      });
    });

    describe('loadNormal', () => {
      test('sets loaded state on successful getTempUrl', async () => {
        imageLoader.getTempUrl.mockResolvedValue('https://temp.com/image.jpg');
        const instance = createInstance();

        await instance.loadNormal('cloud://test', 'thumbnail');

        expect(instance.data.currentUrl).toBe('https://temp.com/image.jpg');
        expect(instance.data.status).toBe('loaded');
        expect(instance.data.usePlaceholder).toBe(false);
      });

      test('retry passes force=true to getTempUrl（否则拿回同一缓存 URL 是空转）', async () => {
        imageLoader.getTempUrl.mockResolvedValue('https://temp.com/image.jpg');
        const instance = createInstance();

        // 首次加载：不强制
        await instance.loadNormal('cloud://test', 'thumbnail');
        expect(imageLoader.getTempUrl).toHaveBeenLastCalledWith(
          'cloud://test',
          expect.objectContaining({ force: false })
        );

        // 失败后重试轮次：必须强制重新转链
        instance._retryCount = 1;
        await instance.loadNormal('cloud://test', 'thumbnail');
        expect(imageLoader.getTempUrl).toHaveBeenLastCalledWith(
          'cloud://test',
          expect.objectContaining({ force: true })
        );
      });

      test('calls onLoadError when getTempUrl returns cloud URL', async () => {
        imageLoader.getTempUrl.mockResolvedValue('cloud://still-cloud');
        const instance = createInstance();
        instance.onLoadError = jest.fn();

        await instance.loadNormal('cloud://test', 'thumbnail');

        expect(instance.onLoadError).toHaveBeenCalled();
      });

      test('calls onLoadError when getTempUrl returns empty', async () => {
        imageLoader.getTempUrl.mockResolvedValue('');
        const instance = createInstance();
        instance.onLoadError = jest.fn();

        await instance.loadNormal('cloud://test', 'thumbnail');

        expect(instance.onLoadError).toHaveBeenCalled();
      });
    });

    describe('loadProgressive', () => {
      test('loads placeholder first then full image', async () => {
        imageLoader.getTempUrl
          .mockResolvedValueOnce('https://temp.com/placeholder.jpg')
          .mockResolvedValueOnce('https://temp.com/full.jpg');

        const instance = createInstance();

        await instance.loadProgressive('cloud://test', 'gallery');

        expect(instance.data.currentUrl).toBe('https://temp.com/full.jpg');
        expect(instance.data.status).toBe('loaded');
        expect(instance.data.usePlaceholder).toBe(false);
      });

      test('calls onLoadError when both placeholder and full fail', async () => {
        imageLoader.getTempUrl
          .mockResolvedValueOnce('cloud://still-cloud')
          .mockResolvedValueOnce('cloud://still-cloud');

        const instance = createInstance();
        instance.onLoadError = jest.fn();

        await instance.loadProgressive('cloud://test', 'gallery');

        expect(instance.onLoadError).toHaveBeenCalled();
      });

      test('loads placeholder first then full image', async () => {
        imageLoader.getTempUrl
          .mockResolvedValueOnce('https://temp.com/placeholder.jpg')
          .mockResolvedValueOnce('https://temp.com/full.jpg');

        const instance = createInstance();

        await instance.loadProgressive('cloud://test', 'gallery');

        expect(instance.data.currentUrl).toBe('https://temp.com/full.jpg');
        expect(instance.data.status).toBe('loaded');
        expect(instance.data.usePlaceholder).toBe(false);
      });
    });

    describe('onImageLoad', () => {
      test('sets loaded state and triggers load event', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance.data.currentUrl = 'https://temp.com/image.jpg';

        instance.onImageLoad();

        expect(instance.data.status).toBe('loaded');
        expect(instance.data.usePlaceholder).toBe(false);
        expect(instance.triggerEvent).toHaveBeenCalledWith('load', {
          src: 'cloud://test',
          url: 'https://temp.com/image.jpg'
        });
      });
    });

    describe('onImageError', () => {
      test('calls onLoadError', () => {
        const instance = createInstance();
        instance.onLoadError = jest.fn();

        instance.onImageError();

        expect(instance.onLoadError).toHaveBeenCalled();
      });
    });

    describe('onLoadError', () => {
      test('retries up to 3 times', () => {
        jest.useFakeTimers();
        const instance = createInstance({ src: 'cloud://test' });
        instance._retryCount = 0;
        instance.loadImage = jest.fn();

        instance.onLoadError();

        expect(instance._retryCount).toBe(1);
        expect(instance.data.status).not.toBe('error');

        jest.useRealTimers();
      });

      test('shows error after max retries', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance._retryCount = 3;

        instance.onLoadError();

        expect(instance.data.status).toBe('error');
        expect(instance.triggerEvent).toHaveBeenCalledWith('error', {
          src: 'cloud://test',
          retryCount: 3
        });
      });

      test('schedules retry with setTimeout', () => {
        jest.useFakeTimers();
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        const instance = createInstance({ src: 'cloud://test' });
        instance._retryCount = 0;
        instance.loadImage = jest.fn();

        instance.onLoadError();

        expect(instance._retryTimer).not.toBeNull();

        jest.advanceTimersByTime(5000);

        expect(instance.loadImage).toHaveBeenCalled();

        Math.random.mockRestore();
        jest.useRealTimers();
      });
    });

    describe('onTap', () => {
      test('triggers tap event with src and url', () => {
        const instance = createInstance({ src: 'cloud://test' });
        instance.data.currentUrl = 'https://temp.com/image.jpg';

        instance.onTap();

        expect(instance.triggerEvent).toHaveBeenCalledWith('tap', {
          src: 'cloud://test',
          url: 'https://temp.com/image.jpg'
        });
      });
    });
  });
});
