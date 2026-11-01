/**
 * __tests__/utils/catRelationPalette.test.js
 *
 * 关系类型色板的单一事实源守卫（D2 / QA-17 / BE-h-1）。
 *
 * 色板过去在两处各写一份：
 *   - cloudfunctions/catRelation/index.js:13-19（权威，云函数 enrich 时用它填 typeColor）
 *   - utils/catRelationService.js:2-9（客户端渲染用）
 * 两份当时逐字相同，但客户端那份**不在任何门禁覆盖范围内**（没登记进
 * scripts/managed-modules.js，磁盘上也没有云函数副本）—— 改一侧漏另一侧静默漂移，
 * 表现为「深色模式下关系类型颜色和云端不一致」（UX-3 的一半成因）。
 *
 * 定案：云端为准，客户端本地副本降级为离线兜底，由 refreshRelationTypes() 覆盖。
 * 本文件锁三件事：
 *   1. 两份字面值必须一致（兜底不能比权威更离谱，否则兜底时颜色突变）；
 *   2. 云函数的 getTypes action 确实返回整份色板（客户端刷新有东西可拿）；
 *   3. refreshRelationTypes 的容错口径：残缺结构宁可不用，也不写半份色板。
 */
const CLOUD_PALETTE_PATH = '../../cloudfunctions/catRelation/index.js';
const CLIENT_SERVICE_PATH = '../../utils/catRelationService';

function loadCloudPalette() {
  jest.resetModules();
  const src = require('fs').readFileSync(require.resolve(CLOUD_PALETTE_PATH), 'utf8');
  // 只取 RELATION_TYPES 字面量：直接从源码里抠出对象，避免把云函数整个 require 起来
  const m = src.match(/const RELATION_TYPES = (\{[\s\S]*?\n\});/);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)();
}

describe('关系类型色板：云端为准，客户端副本仅作离线兜底', () => {
  let cloudPalette;
  let clientPalette;

  beforeEach(() => {
    jest.resetModules();
    cloudPalette = loadCloudPalette();
    clientPalette = require(CLIENT_SERVICE_PATH).RELATION_TYPES;
  });

  afterEach(() => {
    require('wx-server-sdk').__restoreDatabase();
  });

  test('客户端兜底色板与云端逐字相同（label/color/colorDark 全等）', () => {
    expect(Object.keys(clientPalette).sort()).toEqual(Object.keys(cloudPalette).sort());
    Object.keys(cloudPalette).forEach(key => {
      expect(clientPalette[key]).toEqual(cloudPalette[key]);
    });
  });

  test('每个类型都必须有深色色值（UX-3 的根因就是浅色板被深色模式直接复用）', () => {
    Object.entries(cloudPalette).forEach(([key, v]) => {
      expect(typeof v.colorDark).toBe('string');
      expect(v.colorDark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // 深色值必须与浅色值不同，否则等于没提供深色配色
      expect(v.colorDark.toLowerCase()).not.toBe(v.color.toLowerCase());
      expect(key).toBeTruthy();
    });
  });

  test('getRelationColor 按主题取色：深色返回 colorDark，浅色返回 color', () => {
    const { getRelationColor } = require(CLIENT_SERVICE_PATH);

    Object.keys(cloudPalette).forEach(key => {
      expect(getRelationColor(key, 'light')).toBe(cloudPalette[key].color);
      expect(getRelationColor(key, 'dark')).toBe(cloudPalette[key].colorDark);
    });
    // 未知类型兜底为灰色，不得抛错
    expect(getRelationColor('__not_exist__', 'dark')).toBe('#999');
  });

  describe('refreshRelationTypes', () => {
    test('云端返回色板时覆盖本地副本', async () => {
      const mockCloud = require('wx-server-sdk');
      mockCloud.database.mockReturnValue({
        collection: jest.fn(() => ({ where: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) })) }))
      });
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: {
          success: true,
          data: { mother: { label: '妈妈', color: '#111111', colorDark: '#222222' } }
        }
      });

      const svc = require(CLIENT_SERVICE_PATH);
      await expect(svc.refreshRelationTypes()).resolves.toBe(true);
      expect(svc.RELATION_TYPES.mother.color).toBe('#111111');
      expect(svc.getRelationColor('mother', 'dark')).toBe('#222222');
      // 其他类型保持本地兜底，不被整份覆盖清空
      expect(svc.RELATION_TYPES.other).toEqual(cloudPalette.other);
    });

    test('云端返回残缺结构（缺 color）时拒绝写入，保持本地兜底', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { mother: { label: '妈妈' } } }
      });

      const svc = require(CLIENT_SERVICE_PATH);
      await expect(svc.refreshRelationTypes()).resolves.toBe(false);
      expect(svc.RELATION_TYPES.mother).toEqual(cloudPalette.mother);
    });

    test('云函数报错时静默降级（色板拿不到不该打扰用户）', async () => {
      wx.cloud.callFunction.mockRejectedValueOnce(new Error('network down'));

      const svc = require(CLIENT_SERVICE_PATH);
      await expect(svc.refreshRelationTypes()).resolves.toBe(false);
      expect(svc.RELATION_TYPES.mother).toEqual(cloudPalette.mother);
    });

    // action 名必须与 cloudfunctions/catRelation/index.js 的 exports.main 分支一致。
    // 曾误写 getTypes（云端无此分支，恒返回「未知操作」），本用例当时锁定的正是
    // 那个错误值，于是门禁全绿、线上一直拿不到云端色板。
    test('客户端发的是云函数真实存在的 getRelationTypes action', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({ result: { success: true, data: {} } });

      const svc = require(CLIENT_SERVICE_PATH);
      await svc.refreshRelationTypes();

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'catRelation',
        data: { action: 'getRelationTypes' }
      });
    });
  });
});