/**
 * __tests__/components/cat-picker.test.js（组件随管理端下沉到 pages/admin/components/）
 *
 * 回归（2026-10-19）：cat-picker 的聚焦令牌与候选条数上限。
 *
 * 1. **聚焦令牌**：页面拿不到子组件内部 input 的实例，跨组件聚焦只能靠 property
 *    传一个「事件序号」。必须用令牌而不是 Boolean —— input 的 focus 是置位触发型，
 *    停在 true 上第二次就不生效，而「反复点预览条里的名字聚焦」是核心交互。
 * 2. **候选条数**：候选项已不再自带滚动区（嵌套滚动会抢走手势，表现为滑不动），
 *    条数必须由 JS 侧收敛，否则一屏 20 条会把「确认添加」顶出面板。
 */
describe('cat-picker 聚焦令牌与候选上限', () => {
  let def;

  beforeAll(() => {
    global.Component = jest.fn((obj) => {
      def = obj;
      return obj;
    });
    jest.doMock('../../utils/imageLoader', () => ({ getTempUrls: jest.fn(() => Promise.resolve({})) }));
    jest.doMock('../../utils/logger', () => ({
      Logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }
    }));
    require('../../pages/admin/components/cat-picker/cat-picker');
  });

  afterAll(() => {
    delete global.Component;
  });

  function createInstance(overrides) {
    const inst = Object.assign({
      data: JSON.parse(JSON.stringify(def.data)),
      setData: jest.fn(function (u) {
        for (const k of Object.keys(u)) {
          if (k.includes('.')) {
            const parts = k.split('.');
            let t = this.data;
            for (let i = 0; i < parts.length - 1; i++) {
              if (t[parts[i]] === undefined) t[parts[i]] = {};
              t = t[parts[i]];
            }
            t[parts[parts.length - 1]] = u[k];
          } else {
            this.data[k] = u[k];
          }
        }
      }),
      triggerEvent: jest.fn(),
      _seq: 0
    }, overrides);
    for (const key of Object.keys(def.methods)) {
      if (typeof def.methods[key] === 'function') inst[key] = def.methods[key].bind(inst);
    }
    return inst;
  }

  test('声明了 focusToken 属性与 observer', () => {
    expect(def.properties.focusToken).toBeDefined();
    expect(def.properties.focusToken.type).toBe(Number);
    expect(typeof def.observers.focusToken).toBe('function');
  });

  test('令牌变化 → 置位聚焦；随后必须回置，否则第二次点击无效', () => {
    jest.useFakeTimers();
    const inst = createInstance();

    def.observers.focusToken.call(inst, 1);

    expect(inst.data.inputFocus).toBe(true);
    jest.advanceTimersByTime(400);
    expect(inst.data.inputFocus).toBe(false);
    jest.useRealTimers();
  });

  test('令牌为 0（初始值）不触发聚焦，否则一进面板就弹键盘', () => {
    const inst = createInstance();

    def.observers.focusToken.call(inst, 0);

    expect(inst.data.inputFocus).toBe(false);
  });

  test('候选区不是 scroll-view（嵌套滚动会抢手势）', () => {
    const fs = require('fs');
    const wxml = fs.readFileSync(
      require('path').join(__dirname, '../../pages/admin/components/cat-picker/cat-picker.wxml'), 'utf8'
    );
    expect(wxml).not.toMatch(/<scroll-view/);
    expect(wxml).toContain('class="picker-list"');
  });

  test('候选条数与搜索上限一致（10 条）', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../pages/admin/components/cat-picker/cat-picker.js'), 'utf8'
    );
    // 浏览条数必须收敛：候选不再自带滚动区，条数多了会把底栏顶出面板
    const m = src.match(/BROWSE_PAGE_SIZE\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(10);
  });

  test('选中对端已选的那只时拦下并提示', () => {
    // excludeId 是 property，真实运行时组件会把它并进 this.data，测试里同理
    const inst = createInstance({
      data: {
        keyword: '', options: [{ _id: 'c2', name: '惜惜' }], loading: false, browsing: false,
        inputFocus: false, excludeId: 'c2'
      }
    });
    wx.showToast = jest.fn();

    inst.onPick({ currentTarget: { dataset: { id: 'c2' } } });

    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ icon: 'none' }));
    expect(inst.triggerEvent).not.toHaveBeenCalled();
  });

  test('正常选中 → 抛 change 事件并清空候选', () => {
    const inst = createInstance({
      data: {
        keyword: '惜', options: [{ _id: 'c9', name: '大白' }], loading: false, browsing: false, inputFocus: false
      }
    });

    inst.onPick({ currentTarget: { dataset: { id: 'c9' } } });

    expect(inst.triggerEvent).toHaveBeenCalledWith('change', { cat: expect.objectContaining({ _id: 'c9' }) });
    expect(inst.data.options).toEqual([]);
    expect(inst.data.keyword).toBe('');
  });
});