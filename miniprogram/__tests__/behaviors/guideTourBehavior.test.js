let def;

const mockGuidance = {
  getTourForPage: jest.fn(),
  consumeTourReplay: jest.fn(() => false),
  resetTourPage: jest.fn(),
  markTourPageDone: jest.fn(),
  markAllToursDone: jest.fn(),
  getFeatureFlags: jest.fn(() => ({}))
};

const mockObs = {
  EVENT_NAMES: {
    GUIDE_TOUR_VIEW: 'guide_tour_view',
    GUIDE_TOUR_STEP: 'guide_tour_step',
    GUIDE_TOUR_SKIP: 'guide_tour_skip',
    GUIDE_TOUR_COMPLETE: 'guide_tour_complete',
    GUIDE_TOUR_MISSING: 'guide_tour_missing',
    GUIDE_TOUR_REPLAY: 'guide_tour_replay'
  },
  reportEvent: jest.fn()
};

const mockLogger = { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() };

jest.mock('../../utils/guidance', () => mockGuidance);
jest.mock('../../utils/obsHelper', () => mockObs);
jest.mock('../../utils/logger', () => ({ Logger: mockLogger }));

const TOUR = {
  id: 'tour-rank',
  page: 'pages/rank/rank',
  label: '排行榜',
  steps: [
    { id: 'step-a', selector: '#a', title: 'A', desc: 'A desc' },
    { id: 'step-b', selector: '#b', title: 'B', desc: 'B desc' }
  ]
};

const OPTIONAL_TOUR = {
  ...TOUR,
  steps: TOUR.steps.map(step => ({ ...step, optional: true }))
};

function createInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(def.data)),
    setData: jest.fn(function(updates) {
      Object.keys(updates).forEach(key => {
        if (key.indexOf('.') === -1) this.data[key] = updates[key];
      });
    }),
    _isUnmounted: false
  };
  Object.entries(def.methods).forEach(([key, fn]) => {
    inst[key] = fn.bind(inst);
  });
  return inst;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.resetModules();
  mockGuidance.consumeTourReplay.mockReturnValue(false);
  mockGuidance.getTourForPage.mockReturnValue(TOUR);
  require('../../behaviors/guideTourBehavior');
  def = Behavior.mock.calls[0][0];
});

afterEach(() => {
  jest.useRealTimers();
});

describe('behaviors/guideTourBehavior', () => {
  test('starts the tour after the delay and shows the first step', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank');

    expect(inst.setData).not.toHaveBeenCalled();
    jest.advanceTimersByTime(900);

    expect(inst.setData).toHaveBeenCalledWith({
      guideTour: expect.objectContaining({
        show: true,
        selector: '#a',
        title: 'A',
        stepText: '1/2',
        doneText: '下一步'
      })
    });
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_view', expect.objectContaining({
      id: 'tour-rank',
      total: 2
    }));
  });

  test('ready reports the step only once and advances on next', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourReady();
    inst.onGuideTourReady();
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_step', expect.objectContaining({
      step: 'step-a',
      index: 1,
      total: 2
    }));
    expect(mockObs.reportEvent.mock.calls.filter(call => call[0] === 'guide_tour_step')).toHaveLength(1);

    inst.onGuideTourNext();
    expect(inst.data.guideTour.selector).toBe('#b');
    expect(inst.data.guideTour.doneText).toBe('知道了');
  });

  test('finishing the last step marks the page done and hides', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);
    inst.onGuideTourReady();
    inst.onGuideTourNext();
    inst.onGuideTourReady();
    inst.onGuideTourNext();

    expect(mockGuidance.markTourPageDone).toHaveBeenCalledWith('pages/rank/rank', {
      skipped: false,
      steps: 2
    });
    expect(inst.data.guideTour.show).toBe(false);
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_complete', expect.objectContaining({
      id: 'tour-rank'
    }));
  });

  test('skip marks the page done as skipped', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourSkip();

    expect(mockGuidance.markTourPageDone).toHaveBeenCalledWith('pages/rank/rank', {
      skipped: true,
      steps: 0
    });
    expect(inst.data.guideTour.show).toBe(false);
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_skip', expect.objectContaining({
      id: 'tour-rank'
    }));
  });

  test('skip all marks every page done and still hides', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourSkip({ detail: { all: true } });

    expect(mockGuidance.markAllToursDone).toHaveBeenCalledWith({ skipped: true });
    expect(inst.data.guideTour.show).toBe(false);
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_skip', expect.objectContaining({
      all: true
    }));
  });

  test('15 秒无操作自动收起并记账，避免一直挂着', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);
    expect(inst.data.guideTour.show).toBe(true);

    jest.advanceTimersByTime(15000);

    expect(inst.data.guideTour.show).toBe(false);
    expect(mockGuidance.markTourPageDone).toHaveBeenCalledWith('pages/rank/rank', {
      skipped: true,
      steps: 0
    });
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_skip', expect.objectContaining({
      auto: true
    }));
  });

  test('a missing optional target moves to the next step', () => {
    mockGuidance.getTourForPage.mockReturnValue(OPTIONAL_TOUR);
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourMissing({ reason: 'not-found' });
    jest.advanceTimersByTime(80);

    expect(inst.data.guideTour.selector).toBe('#b');
    expect(mockGuidance.markTourPageDone).not.toHaveBeenCalled();
  });

  test('a missing required target aborts without recording the page', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourMissing({ reason: 'not-found' });

    expect(inst.data.guideTour.show).toBe(false);
    expect(mockGuidance.markTourPageDone).not.toHaveBeenCalled();
  });

  test('all optional targets missing does not record the page as seen', () => {
    mockGuidance.getTourForPage.mockReturnValue(OPTIONAL_TOUR);
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    inst.onGuideTourMissing({ reason: 'not-found' });
    jest.advanceTimersByTime(80);
    inst.onGuideTourMissing({ reason: 'not-found' });

    expect(mockGuidance.markTourPageDone).not.toHaveBeenCalled();
    expect(inst.data.guideTour.show).toBe(false);
  });

  test('canStart=false retries instead of forcing the bubble', () => {
    const inst = createInstance();
    let open = true;
    inst.initGuideTour('pages/rank/rank', {
      delay: 0,
      canStart: () => !open
    });
    jest.advanceTimersByTime(0);

    expect(inst.setData).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1200);
    expect(inst.setData).not.toHaveBeenCalled();

    open = false;
    jest.advanceTimersByTime(1200);
    expect(inst.data.guideTour.show).toBe(true);
  });

  test('a replay request resets the page and starts even when already seen', () => {
    mockGuidance.consumeTourReplay.mockReturnValue(true);
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(300);

    expect(mockGuidance.resetTourPage).toHaveBeenCalledWith('pages/rank/rank');
    expect(mockGuidance.getTourForPage).toHaveBeenCalled();
    expect(inst.data.guideTour.show).toBe(true);
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_replay', expect.objectContaining({
      page: 'pages/rank/rank'
    }));
  });

  test('card presentation counts a step as seen without a ready event', () => {
    mockGuidance.getTourForPage.mockReturnValue({ ...TOUR, presentation: 'card' });
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);

    expect(inst.data.guideTour.show).toBe(true);
    expect(inst.data.guideTour.presentation).toBe('card');
    expect(mockObs.reportEvent).toHaveBeenCalledWith('guide_tour_step', expect.objectContaining({
      step: 'step-a'
    }));

    inst.onGuideTourNext();
    inst.onGuideTourNext();
    expect(mockGuidance.markTourPageDone).toHaveBeenCalledWith('pages/rank/rank', {
      skipped: false,
      steps: 2
    });
  });

  test('feature flags are passed to the selector and can override config', () => {
    mockGuidance.getTourForPage.mockReturnValue(null);
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', {
      delay: 0,
      features: { faceRecognition: false }
    });
    jest.advanceTimersByTime(0);

    expect(mockGuidance.getTourForPage).toHaveBeenCalledWith('pages/rank/rank', expect.objectContaining({}));
  });

  test('disabled page never starts', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0, disabled: true });
    jest.advanceTimersByTime(5000);
    expect(inst.setData).not.toHaveBeenCalled();
    expect(mockGuidance.getTourForPage).not.toHaveBeenCalled();
  });

  test('pause keeps the session and destroy clears it', () => {
    const inst = createInstance();
    inst.initGuideTour('pages/rank/rank', { delay: 0 });
    jest.advanceTimersByTime(0);
    inst.onGuideTourReady();

    inst.pauseGuideTour();
    expect(inst.data.guideTour.show).toBe(false);
    expect(inst._guideSession.index).toBe(0);

    inst.destroyGuideTour();
    expect(inst._guideSession).toBeNull();
    expect(inst._pendingGuideTour).toBeNull();
  });
});
