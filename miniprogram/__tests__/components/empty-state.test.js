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

  return instance;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  require('../../components/empty-state/empty-state');
  def = Component.mock.calls[0][0];
});

describe('empty-state', () => {
  describe('properties', () => {
    test('icon defaults to cat', () => {
      expect(def.properties.icon.type).toBe(String);
      expect(def.properties.icon.value).toBe('cat');
    });

    test('decoration defaults to paw', () => {
      expect(def.properties.decoration.type).toBe(String);
      expect(def.properties.decoration.value).toBe('paw');
    });

    test('title defaults to 暂无内容', () => {
      expect(def.properties.title.type).toBe(String);
      expect(def.properties.title.value).toBe('暂无内容');
    });

    test('subtitle defaults to empty string', () => {
      expect(def.properties.subtitle.type).toBe(String);
      expect(def.properties.subtitle.value).toBe('');
    });

    test('showAction defaults to false', () => {
      expect(def.properties.showAction.type).toBe(Boolean);
      expect(def.properties.showAction.value).toBe(false);
    });

    test('actionText defaults to 去看看', () => {
      expect(def.properties.actionText.type).toBe(String);
      expect(def.properties.actionText.value).toBe('去看看');
    });
  });

  describe('methods', () => {
    test('onAction triggers action event', () => {
      const instance = createInstance();
      instance.onAction();
      expect(instance.triggerEvent).toHaveBeenCalledWith('action');
    });

    test('onAction triggers event exactly once', () => {
      const instance = createInstance();
      instance.onAction();
      expect(instance.triggerEvent).toHaveBeenCalledTimes(1);
    });

    test('onAction triggers event with no extra arguments', () => {
      const instance = createInstance();
      instance.onAction();
      expect(instance.triggerEvent).toHaveBeenCalledWith('action');
      expect(instance.triggerEvent.mock.calls[0].length).toBe(1);
    });
  });

  describe('instance with custom properties', () => {
    test('uses custom icon when provided', () => {
      const instance = createInstance({ icon: '\u{1F415}' });
      expect(instance.properties.icon).toBe('\u{1F415}');
    });

    test('uses custom title when provided', () => {
      const instance = createInstance({ title: '没有猫咪' });
      expect(instance.properties.title).toBe('没有猫咪');
    });

    test('uses custom actionText when provided', () => {
      const instance = createInstance({ actionText: '添加猫咪' });
      expect(instance.properties.actionText).toBe('添加猫咪');
    });

    test('showAction can be set to true', () => {
      const instance = createInstance({ showAction: true });
      expect(instance.properties.showAction).toBe(true);
    });
  });
});
