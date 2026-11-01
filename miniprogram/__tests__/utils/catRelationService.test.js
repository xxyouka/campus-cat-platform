/**
 * __tests__/utils/catRelationService.test.js
 *
 * 补齐 utils/catRelationService.js 的测试覆盖（此前该文件覆盖率仅 11%，
 * 是全项目最低 —— 前几轮都没审它，但它承载关系查询与字段归一化）。
 *
 * 重点锁两件事：
 *  1. `normalizeRelation` 的双向字段映射（前端 fromCatId/toCatId 云函数 catId/relatedCatId）
 *  2. `addRelation` 的入参兼容（页面字段名与云函数契约名不一致）
 */
const {
  getRelationColor,
  getRelationLabel,
  getRelationsByCatId,
  addRelation,
  removeRelation,
  getRelationTypes
} = require('../../utils/catRelationService');

// normalizeRelation 未对外导出（合理：它只是 getRelationsByCatId 的内部实现），
// 故通过 getRelationsByCatId 的返回间接验证其归一化行为。
async function normalizeViaApi(raw) {
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: [raw] } });
  const res = await getRelationsByCatId(raw.catId || 'c1');
  return res.data[0];
}

describe('utils/catRelationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.getApp = jest.fn(() => ({ globalData: { theme: 'light' } }));
    global.wx = {
      cloud: { callFunction: jest.fn() },
      getStorageSync: jest.fn(() => '')
    };
  });

  describe('getRelationColor', () => {
    test('已知类型返回亮色系颜色', () => {
      expect(getRelationColor('mother', 'light')).toBe('#E8927C');
      expect(getRelationColor('child', 'light')).toBe('#7EB5E8');
    });

    test('暗色主题返回 colorDark', () => {
      expect(getRelationColor('mother', 'dark')).toBe('#F5A593');
    });

    test('未知类型回退灰色而不是抛错', () => {
      expect(getRelationColor('not_exist', 'light')).toBe('#999');
      expect(getRelationColor(undefined, 'light')).toBe('#999');
    });

    test('不传 theme 时从 globalData 读取，getApp 抛错则回退 light', () => {
      expect(getRelationColor('mother')).toBe('#E8927C');
      global.getApp.mockImplementation(() => { throw new Error('no app'); });
      expect(getRelationColor('mother')).toBe('#E8927C');
    });
  });

  describe('getRelationLabel（方向口径）', () => {
    test('朋友 / 敌对是对称关系，反向也保持同一标签', () => {
      expect(getRelationLabel('friend')).toBe('朋友');
      expect(getRelationLabel('friend', { isReverse: true })).toBe('朋友');
      expect(getRelationLabel('hostile')).toBe('敌对');
      expect(getRelationLabel('hostile', { isReverse: true })).toBe('敌对');
    });
  });

  describe('normalizeRelation（经 getRelationsByCatId 间接验证）', () => {
    test('把云函数的 catId/relatedCatId 映射为前端 from/to 双向字段', async () => {
      const r = await normalizeViaApi({
        _id: 'rel1', catId: 'c1', relatedCatId: 'c2', type: 'mother',
        cat: { _id: 'c1', name: '橘妈' },
        relatedCat: { _id: 'c2', name: '橘宝' },
        note: '亲母女', createTime: '2026-01-01'
      });
      expect(r.fromCatId).toBe('c1');
      expect(r.toCatId).toBe('c2');
      expect(r.fromCat.name).toBe('橘妈');
      expect(r.toCat.name).toBe('橘宝');
      expect(r.description).toBe('亲母女');
    });

    test('缺 cat/relatedCat 时回退占位对象（不返回 undefined）', async () => {
      const r = await normalizeViaApi({ _id: 'rel2', catId: 'c1', relatedCatId: 'c2', type: 'other' });
      expect(r.fromCat).toEqual({ _id: 'c1', name: '未知猫咪' });
      expect(r.toCat).toEqual({ _id: 'c2', name: '未知猫咪' });
      expect(r.description).toBe('');
    });

    test('未知 type 时 relationInfo 回退到 other', async () => {
      const r = await normalizeViaApi({ _id: 'r3', catId: 'a', relatedCatId: 'b', type: 'weird_type' });
      expect(r.relationInfo.label).toBe('其他');
    });
  });

  describe('getRelationsByCatId', () => {
    test('成功时返回归一化后的列表与 total', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          data: [{ _id: 'r1', catId: 'c1', relatedCatId: 'c2', type: 'mother' }],
          total: 1
        }
      });
      const res = await getRelationsByCatId('c1');
      expect(res.success).toBe(true);
      expect(res.total).toBe(1);
      expect(res.data[0].fromCatId).toBe('c1');
    });

    test('旧版云函数不返回 total 时用列表长度兜底', async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: { success: true, data: [{ _id: 'r1', catId: 'c1', relatedCatId: 'c2', type: 'mother' }] }
      });
      const res = await getRelationsByCatId('c1');
      expect(res.total).toBe(1);
    });

    test('业务失败返回 success:false 而非抛错', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '无权限' } });
      const res = await getRelationsByCatId('c1');
      expect(res.success).toBe(false);
      expect(res.error).toBe('无权限');
    });

    test('网络异常被捕获并转成 success:false', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('network down'));
      const res = await getRelationsByCatId('c1');
      expect(res.success).toBe(false);
      expect(res.error).toBe('network down');
    });
  });

  describe('addRelation', () => {
    test('兼容页面字段名（fromCatId/toCatId/relationType/description）', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true, data: { _id: 'rel_new' } } });

      await addRelation({
        fromCatId: 'c1', toCatId: 'c2', relationType: 'mother', description: '测试'
      });

      const sent = wx.cloud.callFunction.mock.calls[0][0].data.data;
      expect(sent).toEqual({ catId: 'c1', relatedCatId: 'c2', type: 'mother', note: '测试' });
    });

    test('兼容云函数字段名（catId/relatedCatId/type/note）', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await addRelation({ catId: 'c1', relatedCatId: 'c2', type: 'father', note: '直接' });
      const sent = wx.cloud.callFunction.mock.calls[0][0].data.data;
      expect(sent).toEqual({ catId: 'c1', relatedCatId: 'c2', type: 'father', note: '直接' });
    });

    test('note 优先于 description（note 已定义时不回退）', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await addRelation({ catId: 'a', relatedCatId: 'b', type: 'other', note: '', description: '兜底' });
      const sent = wx.cloud.callFunction.mock.calls[0][0].data.data;
      // note 显式传空串时应保持空串，而不是回退到 description
      expect(sent.note).toBe('');
    });

    test('从storage 读取管理员账号并带上', async () => {
      wx.getStorageSync.mockReturnValue('admin_from_storage');
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await addRelation({ catId: 'a', relatedCatId: 'b', type: 'other' });
      expect(wx.cloud.callFunction.mock.calls[0][0].data._adminAccount).toBe('admin_from_storage');
    });

    test('_adminAccount 显式传入时优先于 storage', async () => {
      wx.getStorageSync.mockReturnValue('from_storage');
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await addRelation({ catId: 'a', relatedCatId: 'b', type: 'other', _adminAccount: 'explicit' });
      expect(wx.cloud.callFunction.mock.calls[0][0].data._adminAccount).toBe('explicit');
    });

    test('业务失败与网络异常都转成 success:false', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({ result: { success: false, error: '关系已存在' } });
      const r1 = await addRelation({ catId: 'a', relatedCatId: 'b', type: 'other' });
      expect(r1).toEqual({ success: false, error: '关系已存在' });

      wx.cloud.callFunction.mockRejectedValueOnce(new Error('timeout'));
      const r2 = await addRelation({ catId: 'a', relatedCatId: 'b', type: 'other' });
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('timeout');
    });
  });

  describe('removeRelation', () => {
    test('成功时返回 success:true', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: true } });
      await expect(removeRelation('rel1')).resolves.toEqual({ success: true });
    });

    test('失败时透传错误', async () => {
      wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: '记录不存在' } });
      const r = await removeRelation('rel1');
      expect(r).toEqual({ success: false, error: '记录不存在' });
    });

    test('网络异常被捕获', async () => {
      wx.cloud.callFunction.mockRejectedValue(new Error('offline'));
      const r = await removeRelation('rel1');
      expect(r.success).toBe(false);
    });
  });

  describe('getRelationTypes', () => {
    test('返回全部关系类型定义', () => {
      const types = getRelationTypes();
      expect(Object.keys(types)).toEqual(
        expect.arrayContaining(['mother', 'father', 'child', 'sibling', 'litter', 'friend', 'hostile', 'other'])
      );
      expect(types.friend.label).toBe('朋友');
      expect(types.hostile.label).toBe('敌对');
    });
  });
});
