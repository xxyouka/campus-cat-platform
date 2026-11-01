const backToTopBehavior = require('../../behaviors/backToTopBehavior');

function createMockContext(overrides = {}) {
  const ctx = {
    data: { ...backToTopBehavior.data },
    setData: jest.fn(function(updates) {
      Object.assign(this.data, updates);
    }),
    _scrollRaf: false,
    ...overrides
  };
  Object.assign(ctx, backToTopBehavior.methods);
  return ctx;
}

describe('backToTopBehavior', () => {
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createMockContext();
  });

  describe('data', () => {
    test('should have showBackToTop initialized as false', () => {
      expect(backToTopBehavior.data.showBackToTop).toBe(false);
    });
  });

  describe('onPageScroll', () => {
    test('should call _handleScroll via nextTick', () => {
      const handleScrollSpy = jest.spyOn(ctx, '_handleScroll');
      ctx.onPageScroll({ scrollTop: 800 });
      expect(handleScrollSpy).toHaveBeenCalledWith(800);
      handleScrollSpy.mockRestore();
    });

    test('should skip if _scrollRaf is already true', () => {
      ctx._scrollRaf = true;
      const handleScrollSpy = jest.spyOn(ctx, '_handleScroll');
      ctx.onPageScroll({ scrollTop: 800 });
      expect(handleScrollSpy).not.toHaveBeenCalled();
      handleScrollSpy.mockRestore();
    });

    test('should reset _scrollRaf to false after nextTick', () => {
      ctx.onPageScroll({ scrollTop: 100 });
      expect(ctx._scrollRaf).toBe(false);
    });

    test('should set _scrollRaf to true before nextTick runs', () => {
      let rafValueDuringCall = null;
      wx.nextTick = jest.fn(fn => {
        rafValueDuringCall = ctx._scrollRaf;
        fn();
      });
      ctx.onPageScroll({ scrollTop: 100 });
      expect(rafValueDuringCall).toBe(true);
      wx.nextTick = jest.fn(fn => fn());
    });
  });

  describe('_handleScroll', () => {
    test('should show back to top when scrollTop exceeds default threshold', () => {
      ctx._handleScroll(601);
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: true });
    });

    test('should not show back to top when scrollTop is below threshold', () => {
      ctx.data.showBackToTop = true;
      ctx._handleScroll(500);
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: false });
    });

    test('should use custom _backToTopThreshold when set', () => {
      ctx._backToTopThreshold = 300;
      ctx._handleScroll(350);
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: true });
    });

    test('should default threshold to 600 when _backToTopThreshold is not set', () => {
      ctx.data.showBackToTop = true;
      ctx._handleScroll(600);
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: false });
    });

    test('should not call setData if showBackToTop state has not changed', () => {
      ctx.data.showBackToTop = false;
      ctx._handleScroll(100);
      expect(ctx.setData).not.toHaveBeenCalled();
    });

    test('should not call setData when already showing and scroll remains above threshold', () => {
      ctx.data.showBackToTop = true;
      ctx._handleScroll(800);
      expect(ctx.setData).not.toHaveBeenCalled();
    });

    test('should hide back to top when scrolling back below threshold', () => {
      ctx.data.showBackToTop = true;
      ctx._handleScroll(100);
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: false });
    });
  });

  describe('onBackToTop', () => {
    test('should call wx.pageScrollTo with scrollTop 0', () => {
      ctx.onBackToTop();
      expect(wx.pageScrollTo).toHaveBeenCalledWith({ scrollTop: 0, duration: 300 });
    });

    test('should set showBackToTop to false', () => {
      ctx.data.showBackToTop = true;
      ctx.onBackToTop();
      expect(ctx.setData).toHaveBeenCalledWith({ showBackToTop: false });
    });
  });
});
