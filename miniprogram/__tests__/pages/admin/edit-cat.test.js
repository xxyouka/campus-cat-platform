/**
 * __tests__/pages/admin/edit-cat.test.js
 *
 * 编辑猫咪页的鉴权门禁回归（FE-18）。
 *
 * 过去鉴权失败分支里有一句 `this.safeSetData({ loading: false })`，
 * 于是门禁失败的瞬间（还没到 1.5s 的自动返回）就把一个**完全空的表单**
 * 亮给用户：所有字段空白、可点、可输入，提交必然失败。
 * 骨架屏至少诚实地表达「还没准备好」—— 这是本页 loading 初值为 true 的用意，
 * 那句 setData 把它抵消了。
 *
 * 顺带把「缺少 id」分支也钉住：它同样不能露出空表单。
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn(), handleDatabaseError: jest.fn() };
const mockAdminAuth = {
  requireAdminAuth: jest.fn(() => Promise.resolve(true)),
  getAdminRole: jest.fn(() => 'superadmin'),
  getAdminPermissions: jest.fn(() => ['cat']),
  hasAdminPermission: jest.fn(() => true),
  checkAdminAuth: jest.fn(() => true),
  clearAdminAuth: jest.fn()
};
const mockObsHelper = { reportEvent: jest.fn(), EVENT_NAMES: { VIEW_DONATION: 'view_donation' } };
const mockMediaChoose = { pickImages: jest.fn() };
const mockCompress = { compressToLimit: jest.fn(file => Promise.resolve(file)) };

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/obsHelper', () => mockObsHelper);
jest.mock('../../../pages/admin/utils/mediaChoose', () => mockMediaChoose);
jest.mock('../../../pages/admin/utils/imageCompressor', () => mockCompress);
jest.mock('../../../utils/pageState', () => ({ getPageStateManager: jest.fn(() => ({ setState: jest.fn(), getState: jest.fn(), setNeedRefresh: jest.fn() })) }));

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/edit-cat/edit-cat');
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockAdminAuth.requireAdminAuth.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

function createInstance(dataOverrides) {
  const applySetData = (target, updates) => {
    for (const key of Object.keys(updates)) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let node = target;
        for (let i = 0; i < parts.length - 1; i++) {
          if (node[parts[i]] === undefined) node[parts[i]] = {};
          node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = updates[key];
      } else {
        target[key] = updates[key];
      }
    }
  };
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    safeSetData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    _isUnmounted: false,
    loadCat: jest.fn(),
    goBack: jest.fn()
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  return inst;
}

describe('edit-cat page', () => {
  describe('鉴权门禁', () => {
    test('鉴权失败时保持 loading=true（骨架屏常驻，不露出空表单）', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();

      await inst.onLoad({ id: 'cat-1' });

      expect(inst.data.loading).toBe(true);
      expect(inst.loadCat).not.toHaveBeenCalled();
    });

    test('鉴权失败时 1.5s 后自动返回', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();

      await inst.onLoad({ id: 'cat-1' });
      jest.advanceTimersByTime(1500);

      expect(inst.goBack).toHaveBeenCalledTimes(1);
    });

    test('鉴权失败时不得有任何「表单已就绪」的 setData', async () => {
      mockAdminAuth.requireAdminAuth.mockResolvedValue(false);
      const inst = createInstance();

      await inst.onLoad({ id: 'cat-1' });

      // 任何把 loading 翻成 false 的写入都会露出空表单
      const loadingWrites = inst.safeSetData.mock.calls
        .map(([arg]) => arg)
        .filter(arg => arg && Object.prototype.hasOwnProperty.call(arg, 'loading') && arg.loading === false);
      expect(loadingWrites).toHaveLength(0);
    });

    test('缺少 id 时同样不露出空表单', async () => {
      const inst = createInstance();
      wx.showToast.mockReset();

      await inst.onLoad({});

      expect(inst.data.loading).toBe(true);
      expect(inst.loadCat).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1500);
      expect(inst.goBack).toHaveBeenCalledTimes(1);
    });

    test('鉴权通过且有 id：正常加载', async () => {
      const inst = createInstance();
      await inst.onLoad({ id: 'cat-1' });

      expect(inst.loadCat).toHaveBeenCalledWith('cat-1');
      expect(inst.data.catId).toBe('cat-1');
    });
  });

  describe('好猫星级', () => {
    test('loadCat 回填已有星级（数字）', async () => {
      const inst = createInstance();
      inst.loadCat = pageDef.loadCat.bind(inst);
      inst.callAdminFunction = jest.fn(() => Promise.resolve({
        result: { success: true, data: { cat: { name: '惜惜', adoptLevel: 4 } } }
      }));

      await inst.loadCat();

      expect(inst.data.form.adoptLevel).toBe(4);
    });

    test('loadCat 对未评级（字段缺失 / 0）回填 0', async () => {
      const inst = createInstance();
      inst.loadCat = pageDef.loadCat.bind(inst);
      inst.callAdminFunction = jest.fn(() => Promise.resolve({
        result: { success: true, data: { cat: { name: '煤球' } } }
      }));

      await inst.loadCat();

      expect(inst.data.form.adoptLevel).toBe(0);
    });

    test('onAdoptLevel 把 dataset 字符串转成数字', () => {
      const inst = createInstance();
      inst.onAdoptLevel({ currentTarget: { dataset: { value: '5' } } });
      expect(inst.data.form.adoptLevel).toBe(5);
    });

    test('保存时 updateData 下发 adoptLevel 数字（4 = 已评星）', async () => {
      const inst = createInstance({
        loading: false,
        form: { ...pageDef.data.form, name: '惜惜', adoptLevel: 4 }
      });
      inst.verifyAdmin = jest.fn(() => Promise.resolve(true));
      inst.callAdminFunction = jest.fn(() => Promise.resolve({ result: { success: true } }));

      await inst.onSave();

      const updateCall = inst.callAdminFunction.mock.calls.find(c => c[0] === 'updateCat');
      expect(updateCall[1].updateData.adoptLevel).toBe(4);
      inst.onUnload();
    });

    test('保存时 updateData 下发 adoptLevel = 0（取消评级）', async () => {
      const inst = createInstance({
        loading: false,
        form: { ...pageDef.data.form, name: '惜惜', adoptLevel: 0 }
      });
      inst.verifyAdmin = jest.fn(() => Promise.resolve(true));
      inst.callAdminFunction = jest.fn(() => Promise.resolve({ result: { success: true } }));

      await inst.onSave();

      const updateCall = inst.callAdminFunction.mock.calls.find(c => c[0] === 'updateCat');
      expect(updateCall[1].updateData.adoptLevel).toBe(0);
      inst.onUnload();
    });
  });
});