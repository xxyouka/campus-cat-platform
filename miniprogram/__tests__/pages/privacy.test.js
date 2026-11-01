let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/privacy/privacy');
});

beforeEach(() => {
  jest.clearAllMocks();
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...pageDef.data, ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('privacy page', () => {
  describe('onLoad', () => {
    test('sets statusBarHeight from getWindowInfo', () => {
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        statusBarHeight: 20
      }));
    });

    test('sets statusBarHeight to 0 when getWindowInfo returns undefined', () => {
      wx.getWindowInfo.mockReturnValueOnce({ statusBarHeight: undefined, windowHeight: 800, windowWidth: 375, pixelRatio: 2, screenHeight: 800, screenWidth: 375 });
      const inst = createInstance();
      inst.onLoad();
      expect(inst.setData).toHaveBeenCalledWith(expect.objectContaining({
        statusBarHeight: 0
      }));
    });
  });

  describe('toggleSection', () => {
    test('expands a collapsed section', () => {
      const inst = createInstance({
        sections: [
          { id: 1, title: '信息收集', expanded: false },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
      inst.toggleSection({ currentTarget: { dataset: { id: 1 } } });
      expect(inst.setData).toHaveBeenCalledWith({
        sections: [
          { id: 1, title: '信息收集', expanded: true },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
    });

    test('collapses an expanded section', () => {
      const inst = createInstance({
        sections: [
          { id: 1, title: '信息收集', expanded: true },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
      inst.toggleSection({ currentTarget: { dataset: { id: 1 } } });
      expect(inst.setData).toHaveBeenCalledWith({
        sections: [
          { id: 1, title: '信息收集', expanded: false },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
    });

    test('toggles middle section without affecting others', () => {
      const inst = createInstance({
        sections: [
          { id: 1, title: '信息收集', expanded: true },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
      inst.toggleSection({ currentTarget: { dataset: { id: 2 } } });
      expect(inst.setData).toHaveBeenCalledWith({
        sections: [
          { id: 1, title: '信息收集', expanded: true },
          { id: 2, title: '第三方服务', expanded: true },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
    });

    test('toggles last section', () => {
      const inst = createInstance({
        sections: [
          { id: 1, title: '信息收集', expanded: false },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: false }
        ]
      });
      inst.toggleSection({ currentTarget: { dataset: { id: 3 } } });
      expect(inst.setData).toHaveBeenCalledWith({
        sections: [
          { id: 1, title: '信息收集', expanded: false },
          { id: 2, title: '第三方服务', expanded: false },
          { id: 3, title: '联系我们', expanded: true }
        ]
      });
    });
  });

  describe('onBack', () => {
    test('navigates back', () => {
      const inst = createInstance();
      inst.onBack();
      expect(wx.navigateBack).toHaveBeenCalled();
    });
  });

  describe('onShareAppMessage', () => {
    test('returns share object with title and path', () => {
      const inst = createInstance();
      const result = inst.onShareAppMessage();
      expect(result).toEqual({
        title: '校园猫猫隐私政策 | 数据怎么收集、怎么用',
        path: '/pages/privacy/privacy'
      });
    });
  });

  describe('onShareTimeline', () => {
    test('returns share timeline object with title and query', () => {
      const inst = createInstance();
      const result = inst.onShareTimeline();
      expect(result).toEqual({
        title: '校园猫猫隐私政策 - 你的数据如何被保护',
        query: ''
      });
    });
  });

  describe('initial data', () => {
    test('has four sections defined', () => {
      expect(pageDef.data.sections.length).toBe(4);
    });

    test('all sections start collapsed', () => {
      pageDef.data.sections.forEach(section => {
        expect(section.expanded).toBe(false);
      });
    });

    test('sections have correct ids and titles', () => {
      expect(pageDef.data.sections[0]).toEqual({ id: 1, title: '信息收集', expanded: false });
      expect(pageDef.data.sections[1]).toEqual({ id: 2, title: '照片与相册', expanded: false });
      expect(pageDef.data.sections[2]).toEqual({ id: 3, title: '第三方服务', expanded: false });
      expect(pageDef.data.sections[3]).toEqual({ id: 4, title: '联系我们', expanded: false });
    });

    test('statusBarHeight defaults to 0', () => {
      expect(pageDef.data.statusBarHeight).toBe(0);
    });
  });
});
