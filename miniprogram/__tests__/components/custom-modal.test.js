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
  require('../../components/custom-modal/custom-modal');
  def = Component.mock.calls[0][0];
});

describe('custom-modal', () => {
  describe('options', () => {
    test('sets styleIsolation to isolated', () => {
      expect(def.options.styleIsolation).toBe('isolated');
    });
  });

  describe('properties', () => {
    test('show defaults to false', () => {
      expect(def.properties.show.type).toBe(Boolean);
      expect(def.properties.show.value).toBe(false);
    });

    test('icon defaults to empty string', () => {
      expect(def.properties.icon.type).toBe(String);
      expect(def.properties.icon.value).toBe('');
    });

    test('title defaults to empty string', () => {
      expect(def.properties.title.type).toBe(String);
      expect(def.properties.title.value).toBe('');
    });

    test('content defaults to empty string', () => {
      expect(def.properties.content.type).toBe(String);
      expect(def.properties.content.value).toBe('');
    });

    test('confirmText defaults to 确定', () => {
      expect(def.properties.confirmText.type).toBe(String);
      expect(def.properties.confirmText.value).toBe('确定');
    });

    test('cancelText defaults to empty string', () => {
      expect(def.properties.cancelText.type).toBe(String);
      expect(def.properties.cancelText.value).toBe('');
    });

    test('showCancel defaults to false', () => {
      expect(def.properties.showCancel.type).toBe(Boolean);
      expect(def.properties.showCancel.value).toBe(false);
    });

    test('maskClosable defaults to true', () => {
      expect(def.properties.maskClosable.type).toBe(Boolean);
      expect(def.properties.maskClosable.value).toBe(true);
    });

    test('inputMode defaults to false', () => {
      expect(def.properties.inputMode.type).toBe(Boolean);
      expect(def.properties.inputMode.value).toBe(false);
    });

    test('inputValue defaults to empty string', () => {
      expect(def.properties.inputValue.type).toBe(String);
      expect(def.properties.inputValue.value).toBe('');
    });

    test('input2Mode defaults to false', () => {
      expect(def.properties.input2Mode.type).toBe(Boolean);
      expect(def.properties.input2Mode.value).toBe(false);
    });
  });

  describe('data', () => {
    test('has correct default values', () => {
      expect(def.data._leaving).toBe(false);
      expect(def.data._inputValue).toBe('');
      expect(def.data._input2Value).toBe('');
    });
  });

  describe('observers', () => {
    test('show observer sets _leaving when show becomes false', () => {
      jest.useFakeTimers();
      const instance = createInstance();
      instance._leaveTimer = null;

      def.observers['show'].call(instance, false);

      expect(instance.data._leaving).toBe(true);
      expect(instance._leaveTimer).not.toBeNull();

      jest.advanceTimersByTime(280);
      expect(instance.data._leaving).toBe(false);
      expect(instance._leaveTimer).toBeNull();
      jest.useRealTimers();
    });

    test('show observer clears existing leave timer when show becomes false', () => {
      jest.useFakeTimers();
      const instance = createInstance();
      const existingTimer = setTimeout(() => {}, 10000);
      instance._leaveTimer = existingTimer;

      def.observers['show'].call(instance, false);

      expect(instance.data._leaving).toBe(true);
      clearTimeout(existingTimer);
      jest.useRealTimers();
    });

    test('show observer clears timer and resets state when show becomes true', () => {
      jest.useFakeTimers();
      const instance = createInstance({ inputValue: 'hello', input2Value: 'world' });
      instance._leaveTimer = setTimeout(() => {}, 10000);

      def.observers['show'].call(instance, true);

      expect(instance.data._leaving).toBe(false);
      expect(instance.data._inputValue).toBe('hello');
      expect(instance.data._input2Value).toBe('world');
      expect(instance._leaveTimer).toBeNull();
      jest.useRealTimers();
    });

    test('inputValue observer updates _inputValue when show is true', () => {
      const instance = createInstance({ show: true });
      def.observers['inputValue'].call(instance, 'new value');
      expect(instance.data._inputValue).toBe('new value');
    });

    test('inputValue observer does not update _inputValue when show is false', () => {
      const instance = createInstance({ show: false });
      def.observers['inputValue'].call(instance, 'new value');
      expect(instance.data._inputValue).toBe('');
    });

    test('input2Value observer updates _input2Value when show is true', () => {
      const instance = createInstance({ show: true });
      def.observers['input2Value'].call(instance, 'new value2');
      expect(instance.data._input2Value).toBe('new value2');
    });

    test('input2Value observer does not update _input2Value when show is false', () => {
      const instance = createInstance({ show: false });
      def.observers['input2Value'].call(instance, 'new value2');
      expect(instance.data._input2Value).toBe('');
    });
  });

  describe('lifetimes', () => {
    test('detached clears leave timer', () => {
      jest.useFakeTimers();
      const instance = createInstance();
      instance._leaveTimer = setTimeout(() => {}, 10000);

      instance.detached();

      expect(instance._leaveTimer).toBeNull();
      jest.useRealTimers();
    });

    test('detached handles no timer gracefully', () => {
      const instance = createInstance();
      instance._leaveTimer = null;
      expect(() => instance.detached()).not.toThrow();
    });
  });

  describe('methods', () => {
    test('onStopPropagation does nothing', () => {
      const instance = createInstance();
      expect(() => instance.onStopPropagation()).not.toThrow();
    });

    test('preventDefault does nothing', () => {
      const instance = createInstance();
      expect(() => instance.preventDefault()).not.toThrow();
    });

    test('onMaskTap triggers cancel when maskClosable is true', () => {
      const instance = createInstance({ maskClosable: true });
      instance.onMaskTap();
      expect(instance.triggerEvent).toHaveBeenCalledWith('cancel');
    });

    test('onMaskTap does not trigger cancel when maskClosable is false', () => {
      const instance = createInstance({ maskClosable: false });
      instance.onMaskTap();
      expect(instance.triggerEvent).not.toHaveBeenCalled();
    });

    test('onCancel triggers cancel event', () => {
      const instance = createInstance();
      instance.onCancel();
      expect(instance.triggerEvent).toHaveBeenCalledWith('cancel');
    });

    test('onConfirm triggers confirm event with input values', () => {
      const instance = createInstance();
      instance.data._inputValue = 'test input';
      instance.data._input2Value = 'test input2';
      instance.onConfirm();
      expect(instance.triggerEvent).toHaveBeenCalledWith('confirm', {
        confirm: true,
        value: 'test input',
        value2: 'test input2'
      });
    });

    test('onConfirm triggers confirm event with empty values by default', () => {
      const instance = createInstance();
      instance.onConfirm();
      expect(instance.triggerEvent).toHaveBeenCalledWith('confirm', {
        confirm: true,
        value: '',
        value2: ''
      });
    });

    test('onInput updates _inputValue and triggers inputchange', () => {
      const instance = createInstance();
      instance.onInput({ detail: { value: 'typed text' } });
      expect(instance.data._inputValue).toBe('typed text');
      expect(instance.triggerEvent).toHaveBeenCalledWith('inputchange', { value: 'typed text' });
    });

    test('onInput2 updates _input2Value and triggers input2change', () => {
      const instance = createInstance();
      instance.onInput2({ detail: { value: 'typed text2' } });
      expect(instance.data._input2Value).toBe('typed text2');
      expect(instance.triggerEvent).toHaveBeenCalledWith('input2change', { value: 'typed text2' });
    });
  });
});
