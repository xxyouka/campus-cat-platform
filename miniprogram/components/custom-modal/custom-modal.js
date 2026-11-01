// components/custom-modal/custom-modal.js - 通用弹窗组件
Component({
  options: {
    styleIsolation: 'isolated'
  },

  properties: {
    show:             { type: Boolean, value: false },
    icon:             { type: String,  value: '' },
    title:            { type: String,  value: '' },
    content:          { type: String,  value: '' },
    confirmText:      { type: String,  value: '确定' },
    cancelText:       { type: String,  value: '' },
    showCancel:       { type: Boolean, value: false },
    maskClosable:     { type: Boolean, value: true },
    inputMode:        { type: Boolean, value: false },
    inputType:        { type: String,  value: 'text' },
    inputValue:       { type: String,  value: '' },
    inputPlaceholder: { type: String,  value: '请输入' },
    inputPassword:    { type: Boolean, value: false },
    inputFocus:       { type: Boolean, value: false },
    inputMaxlength:   { type: Number,  value: 50 },
    input2Mode:       { type: Boolean, value: false },
    input2Value:      { type: String,  value: '' },
    input2Placeholder:{ type: String,  value: '请输入' },
    input2Password:   { type: Boolean, value: false },
    input2Maxlength:  { type: Number,  value: 50 },
  },

  data: {
    _leaving: false,
    _inputValue: '',
    _input2Value: ''
  },

  observers: {
    'show': function(newVal) {
      if (!newVal) {
        this.setData({ _leaving: true });
        if (this._leaveTimer) clearTimeout(this._leaveTimer);
        this._leaveTimer = setTimeout(() => {
          this.setData({ _leaving: false });
          this._leaveTimer = null;
        }, 280);
      } else {
        if (this._leaveTimer) {
          clearTimeout(this._leaveTimer);
          this._leaveTimer = null;
        }
        this.setData({
          _leaving: false,
          _inputValue: this.properties.inputValue,
          _input2Value: this.properties.input2Value
        });
      }
    },
    'inputValue': function(newVal) {
      if (this.properties.show) {
        this.setData({ _inputValue: newVal });
      }
    },
    'input2Value': function(newVal) {
      if (this.properties.show) {
        this.setData({ _input2Value: newVal });
      }
    }
  },

  lifetimes: {
    detached() {
      if (this._leaveTimer) {
        clearTimeout(this._leaveTimer);
        this._leaveTimer = null;
      }
    }
  },

  methods: {
    onStopPropagation() {},
    preventDefault() {},
    onMaskTap() {
      if (this.properties.maskClosable) {
        this.triggerEvent('cancel');
      }
    },
    onCancel() {
      this.triggerEvent('cancel');
    },
    onConfirm() {
      this.triggerEvent('confirm', {
        confirm: true,
        value:  this.data._inputValue,
        value2: this.data._input2Value
      });
    },
    onInput(e) {
      this.setData({ _inputValue: e.detail.value });
      this.triggerEvent('inputchange', { value: e.detail.value });
    },
    onInput2(e) {
      this.setData({ _input2Value: e.detail.value });
      this.triggerEvent('input2change', { value: e.detail.value });
    }
  }
});
