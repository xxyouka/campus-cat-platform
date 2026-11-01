/**
 * __tests__/pages/admin/relation-manage.test.js
 *
 * 覆盖 2026-10-25 的关系管理改版（按猫聚合 + 批量添加 + 单条编辑）：
 *   1. 聚合：一条关系落进双方卡片，反向卡片用反向标签（child 按性别显示妈妈/爸爸）；
 *   2. 筛选：搜索 / 分组段全在客户端做（全量已拉齐，不再按页过滤）；
 *   3. 添加：基准猫 → 类型 → **多选对方猫** → 一次提交；不再有确认弹窗；
 *   4. 选猫面板：filterCats 分页 + 搜索，已有关系的猫置灰，跨页保留勾选；
 *   5. 编辑：从哪张卡片点进去，主语就是哪只猫；反向卡片要反推类型；
 *   6. 删除撤销 / 详情页入口 / safeDecode / 导航胶囊避让等既有口径不回归。
 */
const fs = require('fs');
const path = require('path');

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
const mockErrorHandler = { handle: jest.fn(), showSuccess: jest.fn(), handleDatabaseError: jest.fn() };
const mockAdminAuth = { requireAdminAuth: jest.fn(() => Promise.resolve(true)) };

jest.mock('../../../utils/logger', () => ({ Logger: mockLogger }));
jest.mock('../../../utils/errorHandler', () => mockErrorHandler);
jest.mock('../../../utils/adminAuth', () => mockAdminAuth);
jest.mock('../../../utils/imageLoader', () => ({
  getTempUrls: jest.fn(() => Promise.resolve({}))
}));

const mockAddRelation = jest.fn();
const mockUpdateRelation = jest.fn();
const mockRemoveRelation = jest.fn();
const mockRefreshRelationTypes = jest.fn(() => Promise.resolve(false));
const mockCallAdminFunction = jest.fn();

jest.mock('../../../utils/catRelationService', () => {
  // 类型表 / 正反向标签用真实实现：本套件要锁的正是「反向卡片显示什么」
  const actual = jest.requireActual('../../../utils/catRelationService');
  return {
    ...actual,
    addRelation: (...args) => mockAddRelation(...args),
    updateRelation: (...args) => mockUpdateRelation(...args),
    removeRelation: (...args) => mockRemoveRelation(...args),
    refreshRelationTypes: (...args) => mockRefreshRelationTypes(...args)
  };
});
jest.mock('../../../pages/admin/behaviors/adminBehavior', () => ({
  callAdminFunction: (...args) => mockCallAdminFunction(...args),
  verifyAdmin: jest.fn(() => Promise.resolve(true)),
  guardPermission: jest.fn(() => true),
  goBack: () => {
    if (global.getCurrentPages().length > 1) global.wx.navigateBack();
    else global.wx.redirectTo({ url: '/pages/admin/admin' });
  }
}));

const UNDO_TIMEOUT_MS = 6000;

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../../pages/admin/relation-manage/relation-manage');
});

function applySetData(data, updates) {
  for (const key of Object.keys(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let target = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = updates[key];
    } else {
      data[key] = updates[key];
    }
  }
}

const instances = [];

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) { applySetData(this.data, updates); }),
    safeSetData: function(updates) { applySetData(this.data, updates); },
    callAdminFunction: (...args) => mockCallAdminFunction(...args)
  };
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function' && !inst[key]) {
      inst[key] = pageDef[key].bind(inst);
    }
  }
  instances.push(inst);
  return inst;
}

// 撤销条 / 高亮 / 搜索防抖都是真定时器：用例结束必须像页面卸载一样清掉，
// 否则 jest 会以「worker failed to exit gracefully」收尾（不是功能失败，但会污染输出）
afterEach(() => {
  instances.splice(0).forEach(inst => {
    if (typeof inst.onUnload === 'function') inst.onUnload();
  });
  jest.useRealTimers();
});

/** 两个测试用猫 id：云函数侧的 CAT_ID_PATTERN 只放行 20-40 位十六进制 */
const CAT_A = 'a'.repeat(24);
const CAT_B = 'b'.repeat(24);
const CAT_C = 'c'.repeat(24);

const RELATIONS = [
  {
    _id: 'r1', catId: CAT_A, relatedCatId: CAT_B, type: 'child',
    catName: '橘座', relatedCatName: '橘子', catColor: '橘猫', relatedCatColor: '狸花',
    catGender: '母', relatedCatGender: '公', note: ''
  },
  {
    _id: 'r2', catId: CAT_A, relatedCatId: CAT_C, type: 'litter',
    catName: '橘座', relatedCatName: '小黑', catColor: '橘猫', relatedCatColor: '奶牛',
    catGender: '母', relatedCatGender: '母', note: '同一窝'
  }
];

describe('relation-manage page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallAdminFunction.mockReset();
    mockAddRelation.mockResolvedValue({ success: true, data: { _id: 'r-new' } });
    mockUpdateRelation.mockResolvedValue({ success: true });
    mockRemoveRelation.mockResolvedValue({ success: true });
    global.wx.cloud.callFunction.mockReset();
    global.wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
  });

  describe('按猫聚合', () => {
    test('一条关系落进双方卡片，反向卡片用反向标签（child + 对方性别 → 妈妈）', () => {
      const inst = createInstance({ loadFailed: false, loading: false });
      inst._relations = RELATIONS;

      inst._aggregate();
      inst._applyFilters();

      const cards = inst.data.cards;
      expect(cards).toHaveLength(3);

      const a = cards.find(c => c.catId === CAT_A);
      expect(a.count).toBe(2);
      expect(a.groups.map(g => g.name)).toEqual(['血缘', '同辈']);
      expect(a.groups[0].chips[0]).toEqual(expect.objectContaining({ label: '子女', otherName: '橘子' }));

      const b = cards.find(c => c.catId === CAT_B);
      // B 是 A 的子女 → B 的卡片上，A 是「妈妈」（A 的性别为母）
      expect(b.groups[0].chips[0]).toEqual(expect.objectContaining({ label: '妈妈', otherName: '橘座' }));

      expect(inst.data.statsText).toBe('3 只猫 · 2 条关系');
      expect(inst.data.hasNoRelations).toBe(false);
    });

    test('分组段带计数：血缘 2 只、同辈 2 只、全部 3 只', () => {
      const inst = createInstance();
      inst._relations = RELATIONS;

      inst._aggregate();

      const seg = inst.data.segments.reduce((acc, s) => { acc[s.key] = s.count; return acc; }, {});
      expect(seg.all).toBe(3);
      expect(seg['血缘']).toBe(2);
      expect(seg['同辈']).toBe(2);
    });

    test('关系为 0 时置 hasNoRelations（空态文案不能是「筛选没命中」）', () => {
      const inst = createInstance();
      inst._relations = [];

      inst._aggregate();

      expect(inst.data.hasNoRelations).toBe(true);
      expect(inst.data.cards).toEqual([]);
    });
  });

  describe('搜索与分组段筛选（纯客户端）', () => {
    function setup() {
      const inst = createInstance({ activeSegment: 'all', searchKeyword: '' });
      inst._relations = RELATIONS;
      inst._aggregate();
      inst._applyFilters();
      return inst;
    }

    test('按名字过滤卡片', () => {
      const inst = setup();
      inst.data.searchKeyword = '小黑';
      inst._applyFilters();
      expect(inst.data.cards.map(c => c.catId)).toEqual([CAT_C]);
    });

    test('按花色过滤卡片', () => {
      const inst = setup();
      inst.data.searchKeyword = '狸花';
      inst._applyFilters();
      expect(inst.data.cards.map(c => c.catId)).toEqual([CAT_B]);
    });

    test('分组段过滤：只看同辈时只剩同辈关系涉及的猫', () => {
      const inst = setup();
      inst.data.activeSegment = '同辈';
      inst._applyFilters();
      expect(inst.data.cards.map(c => c.catId).sort()).toEqual([CAT_A, CAT_C].sort());
    });

    test('清除筛选复位搜索词与分组段', () => {
      const inst = setup();
      inst.data.searchKeyword = '不存在';
      inst.data.activeSegment = '同辈';
      inst.onClearFilters();
      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.activeSegment).toBe('all');
      expect(inst.data.cards).toHaveLength(3);
    });
  });

  describe('全量加载', () => {
    test('翻页拉到 hasMore=false 后一次性聚合', async () => {
      const inst = createInstance();
      mockCallAdminFunction
        .mockResolvedValueOnce({ result: { success: true, data: { relations: [RELATIONS[0]], hasMore: true } } })
        .mockResolvedValueOnce({ result: { success: true, data: { relations: [RELATIONS[1]], hasMore: false } } });

      await inst.reloadAll();

      expect(mockCallAdminFunction).toHaveBeenCalledTimes(2);
      expect(mockCallAdminFunction.mock.calls[1][1]).toEqual(expect.objectContaining({ action: 'listAll', page: 1, pageSize: 100 }));
      expect(inst.data.cards).toHaveLength(3);
      expect(inst.data.loading).toBe(false);
      expect(inst.data.loadFailed).toBe(false);
    });

    test('首次失败置 loadFailed（不得伪装成「暂无关系记录」）', async () => {
      const inst = createInstance();
      mockCallAdminFunction.mockResolvedValue({ result: { success: false, error: 'boom' } });

      await inst.reloadAll();

      expect(inst.data.loadFailed).toBe(true);
      expect(inst.data.loading).toBe(false);
      expect(mockErrorHandler.handle).toHaveBeenCalled();
    });

    test('已加载过之后再失败：保留卡片，不刷成失败态', async () => {
      const inst = createInstance();
      inst._hasLoaded = true;
      inst._relations = RELATIONS;
      inst._aggregate();
      inst._applyFilters();
      mockCallAdminFunction.mockResolvedValue({ result: { success: false, error: 'boom' } });

      await inst.reloadAll();

      expect(inst.data.loadFailed).toBe(false);
      expect(inst.data.cards).toHaveLength(3);
    });

    test('并发重查时丢弃旧响应（慢响应不得覆盖新结果）', async () => {
      const inst = createInstance();
      let releaseOld;
      mockCallAdminFunction
        .mockImplementationOnce(() => new Promise(resolve => { releaseOld = () => resolve({ result: { success: true, data: { relations: [RELATIONS[0]], hasMore: false } } }); }))
        .mockResolvedValueOnce({ result: { success: true, data: { relations: [RELATIONS[1]], hasMore: false } } });

      const first = inst.reloadAll();
      await inst.reloadAll();
      releaseOld();
      await first;

      expect(inst.data.cards.map(c => c.catId).sort()).toEqual([CAT_A, CAT_C].sort());
    });
  });

  describe('详情页入口', () => {
    test('入口猫有卡片：复位筛选并高亮定位', async () => {
      const inst = createInstance();
      inst._entryCat = { id: CAT_B, name: '橘子' };
      inst._relations = RELATIONS;
      inst._aggregate();
      inst.data.searchKeyword = '不相关';

      inst._handleEntry();

      expect(inst.data.searchKeyword).toBe('');
      expect(inst.data.flashCatId).toBe(CAT_B);
    });

    test('入口猫没有关系：打开面板并预填基准猫', async () => {
      const inst = createInstance();
      inst._entryCat = { id: CAT_C, name: '小黑' };
      inst._relations = [];
      inst._aggregate();
      inst._prefillBaseCat = jest.fn();

      inst._handleEntry();

      expect(inst._prefillBaseCat).toHaveBeenCalledWith(CAT_C, '小黑');
    });

    test('预填时档案请求失败也要填上猫（名字用 URL 兜底）', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction.mockRejectedValueOnce(new Error('network down'));

      await inst._prefillBaseCat(CAT_C, '小黑');

      expect(inst.data.showAddPanel).toBe(true);
      expect(inst.data.addForm.catId).toBe(CAT_C);
      expect(inst.data.catAName).toBe('小黑');
      expect(inst.data.catAObj.initialName).toBe('小');
    });
  });

  describe('添加面板：批量选择', () => {
    test('从卡片进入时预填基准猫，未选对方前不可提交', () => {
      const inst = createInstance();
      inst._relations = RELATIONS;
      inst._aggregate();
      inst._applyFilters();

      inst.onOpenAddPanel({ currentTarget: { dataset: { catId: CAT_A } } });

      expect(inst.data.showAddPanel).toBe(true);
      expect(inst.data.addForm.catId).toBe(CAT_A);
      expect(inst.data.addForm.relatedCatIds).toEqual([]);
      expect(inst.data.canSubmit).toBe(false);
    });

    test('换基准猫会清空已选对方猫（换了主语，旧选择不再成立）', () => {
      const inst = createInstance();
      inst.onOpenAddPanel();
      inst.onPickCatA({ detail: { cat: { _id: CAT_A, name: '橘座' } } });
      inst.setData({ 'addForm.relatedCatIds': [CAT_B], pickedCats: [{ _id: CAT_B, name: '橘子' }] });
      inst._syncAddPanelMeta();

      inst.onPickCatA({ detail: { cat: { _id: CAT_C, name: '小黑' } } });

      expect(inst.data.addForm.relatedCatIds).toEqual([]);
      expect(inst.data.pickedCats).toEqual([]);
      expect(inst.data.canSubmit).toBe(false);
    });

    test('类型切换刷新预览标签与配色', () => {
      const inst = createInstance();
      inst.onSelectType({ currentTarget: { dataset: { type: 'mother' } } });
      expect(inst.data.addFormTypeLabel).toBe('妈妈');
      expect(inst.data.addFormTypeColor).toBeTruthy();
    });
  });

  describe('选猫面板（多选）', () => {
    function openPicker(inst, overrides) {
      inst.onOpenAddPanel();
      inst.onPickCatA({ detail: { cat: { _id: CAT_A, name: '橘座' } } });
      inst._relations = RELATIONS;
      Object.assign(inst.data, overrides || {});
      inst.onOpenCatPicker();
    }

    function pickerPayload(cats, hasMore, total) {
      return { result: { success: true, data: { cats, hasMore: !!hasMore, total: total || cats.length } } };
    }

    test('没选基准猫时不开面板', () => {
      const inst = createInstance();
      inst.onOpenAddPanel();

      inst.onOpenCatPicker();

      expect(inst.data.showCatPicker).toBe(false);
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '请先选择基准猫咪' }));
    });

    test('列表用 filterCats 拉取，排除基准猫，已有关系的猫置灰', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction.mockResolvedValueOnce(pickerPayload([
        { _id: CAT_A, name: '橘座', color: '橘猫' },
        { _id: CAT_B, name: '橘子', color: '狸花' },
        { _id: CAT_C, name: '小黑', color: '奶牛' },
        { _id: 'd'.repeat(24), name: '新猫', color: '三花' }
      ]));

      openPicker(inst);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(global.wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: { filters: { page: 1, pageSize: 30 } }
      });
      const opts = inst.data.pickerOptions;
      expect(opts.map(o => o._id)).not.toContain(CAT_A);
      expect(opts.find(o => o._id === CAT_B).disabled).toBe(true);
      expect(opts.find(o => o._id === CAT_C).disabled).toBe(true);
      expect(opts.find(o => o._id === 'd'.repeat(24)).disabled).toBe(false);
    });

    test('勾选 / 取消勾选，已有关系的猫拦下', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction.mockResolvedValueOnce(pickerPayload([
        { _id: CAT_B, name: '橘子' },
        { _id: 'd'.repeat(24), name: '新猫' }
      ]));
      openPicker(inst);
      await new Promise(resolve => setTimeout(resolve, 0));

      inst.onPickerToggle({ currentTarget: { dataset: { id: CAT_B } } });
      expect(inst.data.pickerSelected).toEqual([]);
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '这两只猫已有关系' }));

      inst.onPickerToggle({ currentTarget: { dataset: { id: 'd'.repeat(24) } } });
      expect(inst.data.pickerSelected).toEqual(['d'.repeat(24)]);
      expect(inst.data.pickerOptions.find(o => o._id === 'd'.repeat(24)).selected).toBe(true);

      inst.onPickerToggle({ currentTarget: { dataset: { id: 'd'.repeat(24) } } });
      expect(inst.data.pickerSelected).toEqual([]);
    });

    test('搜索防抖：连续输入只查最后一次，带 keyword 且回到第 1 页', async () => {
      jest.useFakeTimers();
      const inst = createInstance();
      global.wx.cloud.callFunction.mockResolvedValue(pickerPayload([{ _id: 'd'.repeat(24), name: '新猫' }]));
      openPicker(inst);
      await Promise.resolve();

      global.wx.cloud.callFunction.mockClear();
      inst.onPickerSearchInput({ detail: { value: '新' } });
      inst.onPickerSearchInput({ detail: { value: '新猫' } });
      jest.advanceTimersByTime(310);

      expect(global.wx.cloud.callFunction).toHaveBeenCalledTimes(1);
      expect(global.wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: { filters: { page: 1, pageSize: 30, keyword: '新猫' } }
      });
      jest.useRealTimers();
    });

    test('触底续页：追加而不是覆盖', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction
        .mockResolvedValueOnce(pickerPayload([{ _id: 'd'.repeat(24), name: '新猫' }], true, 2))
        .mockResolvedValueOnce(pickerPayload([{ _id: 'e'.repeat(24), name: '另一只' }], false, 2));
      openPicker(inst);
      await new Promise(resolve => setTimeout(resolve, 0));

      inst.onPickerLoadMore();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.data.pickerOptions.map(o => o._id)).toEqual(['d'.repeat(24), 'e'.repeat(24)]);
      expect(inst.data.pickerHasMore).toBe(false);
      expect(global.wx.cloud.callFunction.mock.calls[1][0].data.filters.page).toBe(2);
    });

    test('确定后把这一批带进面板，预览条念出所有名字', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction.mockResolvedValueOnce(pickerPayload([
        { _id: 'd'.repeat(24), name: '新猫' },
        { _id: 'e'.repeat(24), name: '另一只' }
      ]));
      openPicker(inst);
      await new Promise(resolve => setTimeout(resolve, 0));
      inst.onPickerToggle({ currentTarget: { dataset: { id: 'd'.repeat(24) } } });
      inst.onPickerToggle({ currentTarget: { dataset: { id: 'e'.repeat(24) } } });

      inst.onConfirmCatPicker();

      expect(inst.data.showCatPicker).toBe(false);
      expect(inst.data.addForm.relatedCatIds).toEqual(['d'.repeat(24), 'e'.repeat(24)]);
      expect(inst.data.catBSummary).toBe('新猫、另一只');
      expect(inst.data.canSubmit).toBe(true);
    });

    test('一只都没选时不提交（不能把空数组写进 addForm）', async () => {
      const inst = createInstance();
      global.wx.cloud.callFunction.mockResolvedValueOnce(pickerPayload([{ _id: 'd'.repeat(24), name: '新猫' }]));
      openPicker(inst);
      await new Promise(resolve => setTimeout(resolve, 0));

      inst.onConfirmCatPicker();

      expect(inst.data.showCatPicker).toBe(true);
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '请选择至少一只猫咪' }));
    });
  });

  describe('批量提交', () => {
    function ready(ids) {
      const inst = createInstance();
      inst.reloadAll = jest.fn(() => Promise.resolve());
      inst.setData({
        showAddPanel: true,
        'addForm.catId': CAT_A,
        'addForm.relatedCatIds': ids,
        'addForm.type': 'litter',
        'addForm.note': '同一窝'
      });
      inst._syncAddPanelMeta();
      return inst;
    }

    test('一次提交 N 条：逐条串行，载荷正确，面板不关', async () => {
      const ids = ['d'.repeat(24), 'e'.repeat(24), 'f'.repeat(24)];
      const inst = ready(ids);

      inst.onSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockAddRelation).toHaveBeenCalledTimes(3);
      expect(mockAddRelation.mock.calls[0][0]).toEqual({
        catId: CAT_A, relatedCatId: ids[0], type: 'litter', note: '同一窝'
      });
      expect(mockAddRelation.mock.calls[2][0].relatedCatId).toBe(ids[2]);
      // 面板保持打开，只清空这一批的对方猫
      expect(inst.data.showAddPanel).toBe(true);
      expect(inst.data.addForm.catId).toBe(CAT_A);
      expect(inst.data.addForm.relatedCatIds).toEqual([]);
      expect(inst.data.addSuccessText).toContain('已添加 3 条');
      expect(inst.reloadAll).toHaveBeenCalled();
    });

    test('部分失败：成功的仍算数，失败条数说清楚', async () => {
      const ids = ['d'.repeat(24), 'e'.repeat(24)];
      const inst = ready(ids);
      mockAddRelation
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: '该关系已存在' });

      inst.onSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.data.addSuccessText).toContain('已添加 1 条');
      expect(inst.data.addSuccessText).toContain('1 条失败');
      expect(global.wx.showModal).toHaveBeenCalledWith(expect.objectContaining({
        title: '1 条未添加',
        content: expect.stringContaining('该关系已存在')
      }));
    });

    test('全部失败时不提示「已添加」，并保留可重试的上下文', async () => {
      const inst = ready(['d'.repeat(24)]);
      mockAddRelation.mockResolvedValueOnce({ success: false, error: '网络错误' });

      inst.onSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.data.addSuccessText).toBe('');
      expect(inst.reloadAll).not.toHaveBeenCalled();
      expect(global.wx.showModal).toHaveBeenCalled();
    });

    test('提交中重复点击只跑一批', async () => {
      const inst = ready(['d'.repeat(24)]);
      inst.onSubmit();
      inst.onSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockAddRelation).toHaveBeenCalledTimes(1);
    });

    test('没有基准猫 / 没有对方猫时不发请求', () => {
      const noBase = createInstance();
      noBase.onSubmit();
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '请先选择基准猫咪' }));

      const noTargets = createInstance({ addForm: { catId: CAT_A, relatedCatIds: [], type: 'litter', note: '' } });
      noTargets.onSubmit();
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '请选择至少一只猫咪' }));
      expect(mockAddRelation).not.toHaveBeenCalled();
    });
  });

  describe('编辑一条关系', () => {
    function withRelations() {
      const inst = createInstance();
      inst._relations = RELATIONS;
      inst._aggregate();
      inst._applyFilters();
      return inst;
    }

    test('从正向卡片进入：主语是 catId 那一端，类型原样', () => {
      const inst = withRelations();

      inst.onEditChip({ currentTarget: { dataset: { id: 'r1', owner: CAT_A } } });

      expect(inst.data.showEditPanel).toBe(true);
      expect(inst.data.editRel).toEqual(expect.objectContaining({
        relId: 'r1', subjectId: CAT_A, objectId: CAT_B, subjectName: '橘座', objectName: '橘子'
      }));
      expect(inst.data.editForm.type).toBe('child');
      expect(inst.data.editTypeLabel).toBe('子女');
    });

    test('从反向卡片进入：主语换成卡片猫，类型按对方性别反推（子女 → 妈妈）', () => {
      const inst = withRelations();

      inst.onEditChip({ currentTarget: { dataset: { id: 'r1', owner: CAT_B } } });

      expect(inst.data.editRel).toEqual(expect.objectContaining({
        subjectId: CAT_B, objectId: CAT_A, subjectName: '橘子', objectName: '橘座'
      }));
      expect(inst.data.editForm.type).toBe('mother');
      expect(inst.data.editTypeLabel).toBe('妈妈');
    });

    test('父母类反推：妈妈 / 爸爸 → 子女', () => {
      const inst = withRelations();
      inst._relations = [{
        _id: 'r3', catId: CAT_A, relatedCatId: CAT_B, type: 'mother',
        catName: '橘座', relatedCatName: '橘子', catGender: '母', note: ''
      }];

      inst.onEditChip({ currentTarget: { dataset: { id: 'r3', owner: CAT_B } } });

      expect(inst.data.editForm.type).toBe('child');
    });

    test('对方性别未知时按记录方向编辑，并说明原因（不猜性别）', () => {
      const inst = withRelations();
      inst._relations = [{
        _id: 'r4', catId: CAT_A, relatedCatId: CAT_B, type: 'child',
        catName: '橘座', relatedCatName: '橘子', catGender: '', note: ''
      }];

      inst.onEditChip({ currentTarget: { dataset: { id: 'r4', owner: CAT_B } } });

      expect(inst.data.editRel.subjectId).toBe(CAT_A);
      expect(inst.data.editForm.type).toBe('child');
      expect(inst.data.editDirNote).toContain('性别未知');
    });

    test('保存提交主语视角的字段（反向卡片翻方向时 catId 是卡片猫）', async () => {
      const inst = withRelations();
      inst.reloadAll = jest.fn(() => Promise.resolve());
      inst.onEditChip({ currentTarget: { dataset: { id: 'r1', owner: CAT_B } } });
      inst.onEditSelectType({ currentTarget: { dataset: { type: 'friend' } } });
      inst.onEditNoteInput({ detail: { value: '常一起晒太阳' } });

      inst.onSaveEdit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockUpdateRelation).toHaveBeenCalledWith({
        id: 'r1',
        catId: CAT_B,
        relatedCatId: CAT_A,
        type: 'friend',
        note: '常一起晒太阳'
      });
      expect(inst.data.showEditPanel).toBe(false);
      expect(inst.reloadAll).toHaveBeenCalled();
    });

    test('保存失败时面板不关（不能把用户改了一半的内容吞掉）', async () => {
      const inst = withRelations();
      mockUpdateRelation.mockResolvedValueOnce({ success: false, error: '该关系已存在' });

      inst.onEditChip({ currentTarget: { dataset: { id: 'r1', owner: CAT_A } } });
      inst.onSaveEdit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.data.showEditPanel).toBe(true);
      expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '该关系已存在' }));
    });

    test('编辑面板里删除：走既有删除 + 撤销条', async () => {
      const inst = withRelations();
      inst.reloadAll = jest.fn(() => Promise.resolve());

      inst.onEditChip({ currentTarget: { dataset: { id: 'r1', owner: CAT_A } } });
      inst.onDeleteFromEdit();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.data.showEditPanel).toBe(false);
      expect(mockRemoveRelation).toHaveBeenCalledWith('r1');
      expect(inst.data.undoBar).toEqual(expect.objectContaining({ catId: CAT_A, relatedCatId: CAT_B }));
    });
  });

  describe('删除与撤销', () => {
    test('删除成功后弹出撤销条并重查', async () => {
      const inst = createInstance();
      inst._relations = RELATIONS;
      inst.reloadAll = jest.fn(() => Promise.resolve());

      inst.onDeleteChip({ currentTarget: { dataset: { id: 'r1' } } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockRemoveRelation).toHaveBeenCalledWith('r1');
      expect(inst.data.undoBar).toEqual(expect.objectContaining({ catName: '橘座', relatedCatName: '橘子' }));
      expect(inst.reloadAll).toHaveBeenCalled();
    });

    test('撤销用删除瞬间的原始字段重建关系', async () => {
      const inst = createInstance({
        undoBar: { catId: CAT_A, relatedCatId: CAT_B, type: 'child', note: '', catName: '橘座', relatedCatName: '橘子' }
      });
      inst.reloadAll = jest.fn(() => Promise.resolve());

      inst.onUndoDelete();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockAddRelation).toHaveBeenCalledWith({
        catId: CAT_A, relatedCatId: CAT_B, type: 'child', note: ''
      });
      expect(inst.data.undoBar).toBeNull();
      expect(inst.reloadAll).toHaveBeenCalled();
    });

    test('撤销失败也要重查（关系可能已被别人重建）', async () => {
      const inst = createInstance({
        undoBar: { catId: CAT_A, relatedCatId: CAT_B, type: 'child', note: '', catName: '橘座', relatedCatName: '橘子' }
      });
      inst.reloadAll = jest.fn(() => Promise.resolve());
      mockAddRelation.mockResolvedValueOnce({ success: false, error: '该关系已存在' });

      inst.onUndoDelete();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(inst.reloadAll).toHaveBeenCalled();
      expect(inst.data.undoBar).toBeNull();
    });

    test('撤销条到点自动消失', () => {
      jest.useFakeTimers();
      const inst = createInstance();

      inst._showUndoBar({ catId: CAT_A, relatedCatId: CAT_B, type: 'child', note: '', catName: '橘座', relatedCatName: '橘子' });
      expect(inst.data.undoBar).not.toBeNull();
      jest.advanceTimersByTime(UNDO_TIMEOUT_MS + 10);

      expect(inst.data.undoBar).toBeNull();
      jest.useRealTimers();
    });

    test('onUnload 清掉撤销条 / 高亮 / 搜索防抖定时器', () => {
      jest.useFakeTimers();
      const inst = createInstance();
      inst._undoTimer = setTimeout(() => {}, 10000);
      inst._flashTimer = setTimeout(() => {}, 10000);
      inst._pickerTimer = setTimeout(() => {}, 10000);

      inst.onUnload();

      expect(inst._undoTimer).toBeNull();
      expect(inst._flashTimer).toBeNull();
      expect(inst._pickerTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  describe('safeDecode：已解码的值再解码会抛 URIError', () => {
    function safeDecode(v) {
      return require('../../../pages/admin/relation-manage/relation-manage').safeDecode(v);
    }

    test('已解码的中文原样返回', () => {
      expect(safeDecode('斜斜')).toBe('斜斜');
    });

    test('未解码的百分号串正常解码', () => {
      expect(safeDecode('%E6%96%9C%E6%96%9C')).toBe('斜斜');
    });

    test('非法转义返回原值，绝不抛', () => {
      expect(safeDecode('100%')).toBe('100%');
      expect(safeDecode('%E4%B8')).toBe('%E4%B8');
    });

    test('空值安全', () => {
      expect(safeDecode('')).toBe('');
      expect(safeDecode(undefined)).toBe('');
    });
  });

  describe('inverseType', () => {
    function inverseType(type, gender) {
      return require('../../../pages/admin/relation-manage/relation-manage').inverseType(type, gender);
    }

    test('妈妈 / 爸爸 与 子女 互转', () => {
      expect(inverseType('mother')).toBe('child');
      expect(inverseType('father')).toBe('child');
      expect(inverseType('child', '母')).toBe('mother');
      expect(inverseType('child', '公')).toBe('father');
    });

    test('子女 + 性别未知 = 无法反推（返回 null，调用方回退）', () => {
      expect(inverseType('child', '')).toBeNull();
      expect(inverseType('child', '未知')).toBeNull();
    });

    test('对称类型原样返回', () => {
      ['sibling', 'litter', 'friend', 'hostile', 'other'].forEach(type => {
        expect(inverseType(type)).toBe(type);
      });
    });

    test('类型表里没有的 key 返回 null（不得写出一个非法类型）', () => {
      expect(inverseType('nope')).toBeNull();
    });
  });

  describe('导航栏胶囊避让', () => {
    test('按胶囊实测宽度返回右侧安全边距', () => {
      const saved = global.wx.getMenuButtonBoundingClientRect;
      global.wx.getMenuButtonBoundingClientRect = () => ({ left: 281, width: 87, height: 32 });
      const inst = createInstance();
      expect(inst._getMenuSafeRight({ windowWidth: 375 })).toBe(102);
      if (saved) global.wx.getMenuButtonBoundingClientRect = saved;
      else delete global.wx.getMenuButtonBoundingClientRect;
    });

    test('取不到胶囊信息时兜底 32px', () => {
      const saved = global.wx.getMenuButtonBoundingClientRect;
      delete global.wx.getMenuButtonBoundingClientRect;
      const inst = createInstance();
      expect(inst._getMenuSafeRight({ windowWidth: 375 })).toBe(32);
      if (saved) global.wx.getMenuButtonBoundingClientRect = saved;
    });
  });

  describe('WXML / WXSS 契约', () => {
    function readWxml() {
      return fs.readFileSync(
        path.join(__dirname, '../../../pages/admin/relation-manage/relation-manage.wxml'),
        'utf8'
      );
    }

    test('「添加关系」入口在内容区工具条，不在导航栏', () => {
      const wxml = readWxml();
      const navBlock = wxml.slice(wxml.indexOf('class="nav-bar"'), wxml.indexOf('class="main-content"'));
      expect(navBlock).not.toContain('onOpenAddPanel');
      expect(wxml).toContain('class="add-btn" bindtap="onOpenAddPanel"');
    });

    test('添加面板保留方向预览条，基准猫名可点回选猫器', () => {
      const wxml = readWxml();
      expect(wxml).toContain('class="sentence"');
      expect(wxml).toContain('bindtap="onEditCatA"');
      expect(wxml).toContain('focus-token="{{focusTokenA}}"');
      // 换向入口已退休：多选批次没有唯一「另一端」可换，方向改由编辑面板承担
      expect(wxml).not.toContain('onSwapCats');
    });

    test('对方猫是多选入口，提交按钮显示这批的条数', () => {
      const wxml = readWxml();
      expect(wxml).toContain('bindtap="onOpenCatPicker"');
      expect(wxml).toContain("'添加 ' + pickedCats.length + ' 条关系'");
    });

    test('关系 chip 点开编辑，并带上卡片猫作为主语', () => {
      const wxml = readWxml();
      expect(wxml).toContain('bindtap="onEditChip"');
      expect(wxml).toContain('data-owner="{{card.catId}}"');
    });

    /**
     * 回归（2026-10-25 · 真机截图发现）：卡片列表的 wx:for 没写 wx:for-item="card"，
     * 模板里却全在写 card.name / card.count / card.avatar —— 循环变量默认叫 item，
     * 于是 8 张卡片渲染成 8 个没有名字、没有条数、头像空圈的壳子。
     * 数据侧断言（cards 有 name/count）全都过得去，只有模板绑定会静默变空，故单锁一条。
     */
    test('猫卡片循环必须把循环变量声明为 card（否则整张卡取到 undefined）', () => {
      const wxml = readWxml();
      const loop = wxml.match(/wx:for="\{\{cards\}\}"([^>]*)>/);
      expect(loop).not.toBeNull();
      expect(loop[1]).toContain('wx:for-item="card"');
      expect(wxml).toContain('{{card.name}}');
      expect(wxml).toContain('{{card.count}}');
    });

    test('选猫面板是独立一层（叠在添加面板之上）', () => {
      const wxml = readWxml();
      expect(wxml).toContain('wx:if="{{showCatPicker}}"');
      expect(wxml).toContain('class="panel-overlay picker-overlay"');
      expect(wxml).toContain('bindscrolltolower="onPickerLoadMore"');
    });

    test('面板必须能滚到底：scroll-view 要有确定高度', () => {
      const css = fs.readFileSync(
        path.join(__dirname, '../../../pages/admin/relation-manage/relation-manage.wxss'),
        'utf8'
      );
      const rule = css.match(/\.panel-body\s*\{([^}]*)\}/);
      expect(rule).not.toBeNull();
      expect(rule[1]).toMatch(/max-height\s*:\s*calc\(/);
      expect(rule[1]).not.toMatch(/^\s*height\s*:\s*0\s*;/m);

      const picker = css.match(/\.picker-scroll\s*\{([^}]*)\}/);
      expect(picker).not.toBeNull();
      expect(picker[1]).toMatch(/max-height\s*:\s*calc\(/);
    });

    test('选猫器只用一次（基准猫），并且候选项不自带滚动区', () => {
      const wxml = readWxml();
      expect((wxml.match(/<cat-picker/g) || []).length).toBe(1);

      const pickerWxml = fs.readFileSync(
        path.join(__dirname, '../../../pages/admin/components/cat-picker/cat-picker.wxml'),
        'utf8'
      );
      expect(pickerWxml).toContain('class="picker-list"');
      expect(pickerWxml).not.toMatch(/<scroll-view[^>]*picker-list/);
    });
  });
});
