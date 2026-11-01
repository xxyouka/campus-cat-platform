/** __tests__/pages/report.test.js - 用户反馈页 */
let pageDef;

beforeAll(() => {
  global.Page = jest.fn((obj) => { pageDef = obj; return obj; });
  require('../../subpackages/feedback/report/report');
});

function createInstance(dataOverrides = {}) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
    safeSetData: jest.fn(function(updates) { Object.assign(this.data, updates); }),
    _isUnmounted: false
  };
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('report page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { id: 'r1' } } });
  });

  test('onLoad 解码猫信息', () => {
    const inst = createInstance();
    inst.onLoad({
      catId: 'cat1',
      catName: encodeURIComponent('斑斑'),
      catAvatar: encodeURIComponent('cloud://avatar')
    });
    expect(inst.data.catId).toBe('cat1');
    expect(inst.data.catName).toBe('斑斑');
    expect(inst.data.catAvatar).toBe('cloud://avatar');
    expect(inst.data.entryError).toBe('');
  });

  test('缺少 catId 时进入小程序意见反馈模式', () => {
    const inst = createInstance();
    inst.onLoad({});
    expect(inst.data.mode).toBe('app');
    expect(inst.data.type).toBe('other');
    expect(inst.data.entryError).toBe('');
  });

  test('意见反馈模式提交：catId 为空、type 固定 other', async () => {
    const inst = createInstance();
    inst.onLoad({});
    inst.data.description = '相册页偶尔加载不出来，希望修复';
    await inst.onSubmit();
    expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submitReport',
      data: expect.objectContaining({ catId: '', type: 'other' })
    }));
    expect(inst.data.submitted).toBe(true);
  });

  test('描述草稿按 catId 持久化并在提交成功后清除', async () => {
    jest.useFakeTimers();
    const inst = createInstance();
    inst.onLoad({ catId: 'cat1' });
    inst.onInput({ detail: { value: '名字写错了，应该叫斑斑' } });
    jest.advanceTimersByTime(500);
    expect(wx.setStorageSync).toHaveBeenCalledWith('report_draft_cat1', '名字写错了，应该叫斑斑');
    jest.useRealTimers();
    await inst.onSubmit();
    expect(wx.removeStorageSync).toHaveBeenCalledWith('report_draft_cat1');
  });

  test('类型与描述输入', () => {
    const inst = createInstance({ catId: 'cat1' });
    // 用户端只保留三类；「疑似走失」不再出现
    expect(inst.data.types.map(item => item.key)).toEqual(['info_error', 'injured', 'other']);
    inst.onTypeTap({ currentTarget: { dataset: { type: 'injured' } } });
    inst.onInput({ detail: { value: '右耳有个缺口' } });
    expect(inst.data.type).toBe('injured');
    expect(inst.data.description).toBe('右耳有个缺口');
    expect(inst.data.descLength).toBe(6);
  });

  test('validate 拦截空猫 / 过短描述', () => {
    const inst = createInstance();
    expect(inst.validate()).toContain('猫咪详情页');
    inst.data.catId = 'cat1';
    inst.data.description = '太短';
    expect(inst.validate()).toContain('至少写');
    inst.data.description = '这是一段足够长的描述';
    expect(inst.validate()).toBe('');
  });

  test('提交成功进入成功态', async () => {
    const inst = createInstance({ catId: 'cat1', catName: '斑斑' });
    inst.data.description = '名字写错了，应该叫斑斑';
    await inst.onSubmit();
    expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submitReport',
      data: expect.objectContaining({ catId: 'cat1', type: 'info_error' })
    }));
    expect(inst.data.submitted).toBe(true);
    expect(inst.data.submitting).toBe(false);
  });

  test('提交失败提示错误并解除 submitting', async () => {
    wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '今天反馈得有点多' } });
    const inst = createInstance({ catId: 'cat1' });
    inst.data.description = '名字写错了，应该叫斑斑';
    await inst.onSubmit();
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '今天反馈得有点多' }));
    expect(inst.data.submitted).toBe(false);
    expect(inst.data.submitting).toBe(false);
  });

  test('返回猫咪优先 navigateBack，失败则回详情', () => {
    const inst = createInstance({ catId: 'cat1' });
    inst.onBackToCat();
    expect(wx.navigateBack).toHaveBeenCalled();
  });
});
