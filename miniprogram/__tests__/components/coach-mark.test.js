let def;

function createInstance(propOverrides = {}) {
  const instance = {
    data: JSON.parse(JSON.stringify(def.data || {})),
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    properties: {},
    triggerEvent: jest.fn(),
    _measureTimer: null
  };

  Object.entries(def.properties || {}).forEach(([key, prop]) => {
    instance.properties[key] = propOverrides[key] !== undefined ? propOverrides[key] : prop.value;
  });

  Object.entries(def.methods || {}).forEach(([key, fn]) => {
    instance[key] = typeof fn === 'function' ? fn.bind(instance) : fn;
  });

  return instance;
}

function mockRect(rect) {
  wx.createSelectorQuery.mockReturnValue({
    select: jest.fn(() => ({
      boundingClientRect: jest.fn(() => ({
        exec: jest.fn(callback => callback([rect]))
      }))
    }))
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  require('../../components/coach-mark/coach-mark');
  def = Component.mock.calls[0][0];
});

describe('coach-mark', () => {
  describe('properties', () => {
    test('show/selector/title/desc defaults are safe', () => {
      expect(def.properties.show.value).toBe(false);
      expect(def.properties.selector.value).toBe('');
      expect(def.properties.placement.value).toBe('auto');
      expect(def.properties.padding.value).toBe(8);
      expect(def.properties.autoScroll.value).toBe(false);
      expect(def.properties.stepText.value).toBe('');
      expect(def.properties.doneText.value).toBe('知道了');
      expect(def.properties.skipText.value).toBe('跳过本页');
    });
  });

  describe('_computeLayout', () => {
    const win = { windowWidth: 375, windowHeight: 667 };

    test('目标在屏幕上半部时，气泡放在下方', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 120, left: 100, width: 100, height: 40 }, win);

      expect(layout._visible).toBe(true);
      expect(layout.bubbleAbove).toBe(false);
      expect(layout.bubbleStyle).toContain('top:180px');
      expect(layout.bubbleStyle).toContain('width:264px');
    });

    test('目标在屏幕下半部时，气泡放在上方', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 560, left: 100, width: 100, height: 40 }, win);

      expect(layout.bubbleAbove).toBe(true);
      // bottom = 667 - (560-8) + 12 = 127
      expect(layout.bubbleStyle).toContain('bottom:127px');
    });

    test('placement=below 时强制放下方', () => {
      const inst = createInstance({ placement: 'below' });
      const layout = inst._computeLayout({ top: 560, left: 100, width: 100, height: 40 }, win);
      expect(layout.bubbleAbove).toBe(false);
    });

    test('光环正好围住目标，且不越出视口', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 100, left: 50, width: 120, height: 40 }, win);

      expect(layout.ringStyle).toContain('top:92px');
      expect(layout.ringStyle).toContain('left:42px');
      expect(layout.ringStyle).toContain('width:136px');
      expect(layout.ringStyle).toContain('height:56px');
      // 轻量模式不再渲染蒙层
      expect(layout.maskTopStyle).toBeUndefined();
    });

    test('目标贴左边缘时气泡不越界', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 100, left: 0, width: 40, height: 40 }, win);
      expect(layout.bubbleStyle).toContain('left:20px');
    });

    test('目标贴右边缘时气泡不越界', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 100, left: 335, width: 40, height: 40 }, win);
      // 375 - 264 - 20 = 91
      expect(layout.bubbleStyle).toContain('left:91px');
    });

    test('小屏（320）气泡宽度收窄，不溢出', () => {
      const inst = createInstance();
      const layout = inst._computeLayout(
        { top: 100, left: 100, width: 80, height: 40 },
        { windowWidth: 320, windowHeight: 480 }
      );
      expect(layout.bubbleStyle).toContain('width:256px');
    });

    test('目标贴底时光环不越出视口', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 640, left: 10, width: 50, height: 27 }, win);
      expect(layout.ringStyle).toContain('height:35px');
    });

    test('目标很高（整张卡片）时气泡放进洞里，避免超出屏幕', () => {
      const inst = createInstance();
      const layout = inst._computeLayout({ top: 120, left: 20, width: 335, height: 420 }, win);

      expect(layout.showArrow).toBe(false);
      expect(layout.bubbleStyle).toContain('top:132px');
      expect(layout.bubbleStyle).not.toContain('bottom:');
    });

    test('高卡片上方有空间时气泡放到洞外，卡片保持可点', () => {
      const inst = createInstance();
      // 「我的」页实时推送卡：高约 320px，上方还有快速入口区
      const layout = inst._computeLayout({ top: 360, left: 20, width: 335, height: 320 }, win);

      expect(layout.bubbleAbove).toBe(true);
      expect(layout.showArrow).toBe(true);
      expect(layout.bubbleStyle).toContain('bottom:');
      // 洞本身不被气泡覆盖：气泡底边在洞上方
      expect(layout.bubbleStyle).toContain('bottom:327px');
    });
  });

  describe('_measure', () => {
    test('量到目标后显示高亮', () => {
      mockRect({ top: 100, left: 100, width: 80, height: 40 });
      const inst = createInstance({ selector: '#target' });

      inst._measure(0);

      expect(inst.data._visible).toBe(true);
      expect(inst.triggerEvent).toHaveBeenCalledWith('ready', { selector: '#target' });
      expect(inst.triggerEvent).not.toHaveBeenCalledWith('missing', expect.anything());
    });

    test('布局后续变化时静默重量会跟着挪，但不重复记账', () => {
      jest.useFakeTimers();
      const inst = createInstance({ selector: '#target', show: true });

      mockRect({ top: 100, left: 100, width: 80, height: 40 });
      inst._measure(0);
      const firstTop = inst.data.ringStyle;

      // 模拟「我的」页：日历数据落地后，推送卡下移 200px
      mockRect({ top: 300, left: 100, width: 80, height: 40 });
      inst._measure(0, true);

      expect(inst.data.ringStyle).not.toBe(firstTop);
      expect(inst.triggerEvent).toHaveBeenCalledTimes(1);
      expect(inst.triggerEvent).toHaveBeenCalledWith('ready', { selector: '#target' });

      inst._cancelWatch();
      jest.useRealTimers();
    });

    test('三次量不到目标：触发 missing 且保持隐藏（不冤枉用户「已看过」）', () => {
      jest.useFakeTimers();
      mockRect({ top: 0 });
      const inst = createInstance({ selector: '#missing' });

      inst._measure(0);
      jest.advanceTimersByTime(120);
      jest.advanceTimersByTime(120);

      expect(inst.triggerEvent).toHaveBeenCalledWith('missing', {
        selector: '#missing',
        reason: 'not-found'
      });
      expect(inst.data._visible).toBe(false);
      jest.useRealTimers();
    });

    test('显式开启 autoScroll 时才滚动到目标，仍不可见则放弃', () => {
      jest.useFakeTimers();
      mockRect({ top: 900, left: 100, width: 80, height: 40 });
      const inst = createInstance({ selector: '#below-fold', autoScroll: true });

      inst._measure(0);
      expect(wx.pageScrollTo).not.toHaveBeenCalled();

      // 前两次先重量（面板/数据可能还在动），第三次才滚页面
      jest.advanceTimersByTime(250);
      jest.advanceTimersByTime(250);
      expect(wx.pageScrollTo).toHaveBeenCalledWith({ selector: '#below-fold', offsetTop: -110, duration: 300 });

      jest.advanceTimersByTime(380);
      expect(inst.triggerEvent).toHaveBeenCalledWith('missing', {
        selector: '#below-fold',
        reason: 'out-of-viewport'
      });
      expect(inst.data._visible).toBe(false);
      jest.useRealTimers();
    });

    test('默认不滚动页面：目标在视口外只重试，最后跳过', () => {
      jest.useFakeTimers();
      mockRect({ top: 900, left: 100, width: 80, height: 40 });
      const inst = createInstance({ selector: '#in-panel' });

      inst._measure(0);
      for (let i = 0; i < 4; i++) jest.advanceTimersByTime(250);

      expect(wx.pageScrollTo).not.toHaveBeenCalled();
      expect(inst.triggerEvent).toHaveBeenCalledWith('missing', {
        selector: '#in-panel',
        reason: 'out-of-viewport'
      });
      jest.useRealTimers();
    });

    test('没有 selector 时直接报 missing', () => {
      const inst = createInstance();
      inst._measure(0);
      expect(inst.triggerEvent).toHaveBeenCalledWith('missing', {
        selector: '',
        reason: 'no-selector'
      });
    });

    test('createSelectorQuery 不可用时报 missing', () => {
      wx.createSelectorQuery.mockImplementation(() => { throw new Error('unsupported'); });
      const inst = createInstance({ selector: '#target' });
      inst._measure(0);
      expect(inst.triggerEvent).toHaveBeenCalledWith('missing', {
        selector: '#target',
        reason: 'no-query'
      });
    });
  });

  describe('events', () => {
    test('onDone / onSkip / onSkipAll 分别上报', () => {
      const inst = createInstance();
      inst.onDone();
      inst.onSkip();
      inst.onSkipAll();
      expect(inst.triggerEvent).toHaveBeenNthCalledWith(1, 'done');
      expect(inst.triggerEvent).toHaveBeenNthCalledWith(2, 'skip', { all: false });
      expect(inst.triggerEvent).toHaveBeenNthCalledWith(3, 'skip', { all: true });
    });
  });
});
