let def;

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
    triggerEvent: jest.fn()
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
  require('../../components/custom-navbar/custom-navbar');
  def = Component.mock.calls[0][0];
});

describe('custom-navbar', () => {
  describe('properties', () => {
    test('title defaults to empty string', () => {
      expect(def.properties.title.type).toBe(String);
      expect(def.properties.title.value).toBe('');
    });

    test('subtitle defaults to empty string', () => {
      expect(def.properties.subtitle.type).toBe(String);
      expect(def.properties.subtitle.value).toBe('');
    });

    test('theme defaults to default', () => {
      expect(def.properties.theme.type).toBe(String);
      expect(def.properties.theme.value).toBe('default');
    });

    test('showBack defaults to false', () => {
      expect(def.properties.showBack.type).toBe(Boolean);
      expect(def.properties.showBack.value).toBe(false);
    });

    // 返回键从「描边胶囊 + 毛玻璃底 + 「返回」文字」改成「只画箭头 + 隐形热区」：
    // 叠加三层后左区宽出近一倍，在 32rpx 边距下又长又笨。
    // 这里锁死默认值，防止有人顺手把文字加回来。
    test('showBackText defaults to false（默认只画箭头，不带「返回」文字）', () => {
      expect(def.properties.showBackText.type).toBe(Boolean);
      expect(def.properties.showBackText.value).toBe(false);
    });
  });

  describe('data', () => {
    test('has correct default values', () => {
      expect(def.data.statusBarHeight).toBe(20);
      expect(def.data.navBarHeight).toBe(44);
    });
  });

  describe('lifetimes', () => {
    test('attached calls _initNavBar', () => {
      const instance = createInstance();
      instance._initNavBar = jest.fn();
      instance.attached();
      expect(instance._initNavBar).toHaveBeenCalled();
    });
  });

  describe('observers', () => {
    test('statusBarHeight and navBarHeight observer triggers heightchange event', () => {
      const instance = createInstance();
      def.observers['statusBarHeight, navBarHeight'].call(instance, 20, 44);
      expect(instance.triggerEvent).toHaveBeenCalledWith(
        'heightchange',
        { totalHeight: 64, statusBarHeight: 20, navBarHeight: 44 }
      );
    });

    test('observer does not trigger event when statusBarHeight is 0', () => {
      const instance = createInstance();
      def.observers['statusBarHeight, navBarHeight'].call(instance, 0, 44);
      expect(instance.triggerEvent).not.toHaveBeenCalled();
    });

    test('observer does not trigger event when navBarHeight is 0', () => {
      const instance = createInstance();
      def.observers['statusBarHeight, navBarHeight'].call(instance, 20, 0);
      expect(instance.triggerEvent).not.toHaveBeenCalled();
    });
  });

  describe('methods', () => {
    describe('_initNavBar', () => {
      test('sets statusBarHeight and navBarHeight from window info', () => {
        wx.getWindowInfo.mockReturnValue({
          windowHeight: 800,
          windowWidth: 375,
          statusBarHeight: 44,
          pixelRatio: 2,
          screenHeight: 800,
          screenWidth: 375
        });
        wx.getDeviceInfo.mockReturnValue({
          brand: 'Apple',
          model: 'iPhone 14',
          system: 'iOS 16',
          platform: 'ios'
        });

        const instance = createInstance();
        instance._initNavBar();

        expect(instance.data.statusBarHeight).toBe(44);
        expect(instance.data.navBarHeight).toBe(44);
      });

      test('uses navBarHeight 48 for Android platform', () => {
        wx.getWindowInfo.mockReturnValue({
          windowHeight: 800,
          windowWidth: 375,
          statusBarHeight: 24,
          pixelRatio: 2,
          screenHeight: 800,
          screenWidth: 375
        });
        wx.getDeviceInfo.mockReturnValue({
          brand: 'Google',
          model: 'Pixel 7',
          system: 'Android 13',
          platform: 'android'
        });

        const instance = createInstance();
        instance._initNavBar();

        expect(instance.data.statusBarHeight).toBe(24);
        expect(instance.data.navBarHeight).toBe(48);
      });

      test('uses navBarHeight 48 for wide screens on other platforms', () => {
        wx.getWindowInfo.mockReturnValue({
          windowHeight: 800,
          windowWidth: 768,
          statusBarHeight: 20,
          pixelRatio: 2,
          screenHeight: 800,
          screenWidth: 768
        });
        wx.getDeviceInfo.mockReturnValue({
          brand: 'devtools',
          model: 'devtools',
          system: 'devtools',
          platform: 'devtools'
        });

        const instance = createInstance();
        instance._initNavBar();

        expect(instance.data.navBarHeight).toBe(48);
      });

      test('uses navBarHeight 44 for narrow screens on other platforms', () => {
        wx.getWindowInfo.mockReturnValue({
          windowHeight: 800,
          windowWidth: 375,
          statusBarHeight: 20,
          pixelRatio: 2,
          screenHeight: 800,
          screenWidth: 375
        });
        wx.getDeviceInfo.mockReturnValue({
          brand: 'devtools',
          model: 'devtools',
          system: 'devtools',
          platform: 'devtools'
        });

        const instance = createInstance();
        instance._initNavBar();

        expect(instance.data.navBarHeight).toBe(44);
      });

      test('falls back to defaults when getWindowInfo throws', () => {
        wx.getWindowInfo.mockImplementation(() => { throw new Error('fail'); });
        wx.getDeviceInfo.mockReturnValue({
          brand: 'devtools',
          model: 'devtools',
          system: 'devtools',
          platform: 'devtools'
        });

        const instance = createInstance();
        instance._initNavBar();

        expect(instance.data.statusBarHeight).toBe(20);
        expect(instance.data.navBarHeight).toBe(44);
      });
    });

    describe('onBack', () => {
      test('navigates back when pages length > 1 and prev page is not tabbar', () => {
        getCurrentPages.mockReturnValue([
          { route: 'pages/detail/detail' },
          { route: 'pages/edit-cat/edit-cat' }
        ]);

        const instance = createInstance();
        instance.onBack();

        expect(wx.navigateBack).toHaveBeenCalledWith({ delta: 1 });
        expect(instance.triggerEvent).toHaveBeenCalledWith('back');
      });

      test('switches to tab when prev page is a tabbar page', () => {
        getCurrentPages.mockReturnValue([
          { route: 'pages/gallery/gallery' },
          { route: 'pages/detail/detail' }
        ]);

        const instance = createInstance();
        instance.onBack();

        expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/gallery/gallery' });
        expect(instance.triggerEvent).toHaveBeenCalledWith('back');
      });

      test('switches to index when only one page in stack', () => {
        getCurrentPages.mockReturnValue([
          { route: 'pages/detail/detail' }
        ]);

        const instance = createInstance();
        instance.onBack();

        expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
        expect(instance.triggerEvent).toHaveBeenCalledWith('back');
      });

      test('switches to index when pages array is empty', () => {
        getCurrentPages.mockReturnValue([]);

        const instance = createInstance();
        instance.onBack();

        expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
        expect(instance.triggerEvent).toHaveBeenCalledWith('back');
      });

      test('recognizes profile as tabbar page', () => {
        getCurrentPages.mockReturnValue([
          { route: 'pages/profile/profile' },
          { route: 'pages/detail/detail' }
        ]);

        const instance = createInstance();
        instance.onBack();

        expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/profile/profile' });
      });
    });
  });
});
