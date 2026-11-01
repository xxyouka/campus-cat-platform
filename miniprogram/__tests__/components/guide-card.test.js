let def;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  require('../../components/guide-card/guide-card');
  def = Component.mock.calls[0][0];
});

function createInstance(propOverrides = {}) {
  const inst = {
    properties: {},
    triggerEvent: jest.fn()
  };
  Object.entries(def.properties || {}).forEach(([key, prop]) => {
    inst.properties[key] = propOverrides[key] !== undefined ? propOverrides[key] : prop.value;
  });
  Object.entries(def.methods || {}).forEach(([key, fn]) => {
    inst[key] = fn.bind(inst);
  });
  return inst;
}

describe('guide-card', () => {
  test('默认值安全：不显示、文案为空、按钮有默认词', () => {
    expect(def.properties.show.value).toBe(false);
    expect(def.properties.title.value).toBe('');
    expect(def.properties.desc.value).toBe('');
    expect(def.properties.stepText.value).toBe('');
    expect(def.properties.doneText.value).toBe('知道了');
    expect(def.properties.skipText.value).toBe('跳过');
    expect(def.properties.offsetBottom.value).toBe(0);
  });

  test('done / skip 分别抛事件', () => {
    const inst = createInstance();
    inst.onDone();
    inst.onSkip();
    expect(inst.triggerEvent).toHaveBeenNthCalledWith(1, 'done');
    expect(inst.triggerEvent).toHaveBeenNthCalledWith(2, 'skip');
  });

  test('preventDefault 是空实现，只为 catchtouchmove 占位', () => {
    const inst = createInstance();
    expect(() => inst.preventDefault()).not.toThrow();
  });
});
