/**
 * __tests__/cloudfunctions/adoptLevel.test.js
 *
 * 「好猫星级」（cats.adoptLevel）前后端一致性 + 云函数行为回归。
 *
 * 产品口径（2026-10-19 大小姐提出）：不是每只猫都要评 —— 只给「明显不太具备
 * 野外生存能力、但很适合家养」的猫单独标星级（3/4/5 三档），让想领养的人
 * 一眼挑出来。0 / 字段缺失 = 未评级，前台完全不渲染。
 *
 * 这个文件锁三件事：
 *   1. 取值只有一个合法集合：0（未评级）或 3/4/5 的整数；字符串/小数/枚举外的值全部拒绝。
 *   2. 录入页只提供「不评 + 3/4/5」，与后端白名单逐字一致（防止再上演 healthStatus
 *      那种「前端有选项、后端判非法」的锁死）。
 *   3. filterCats 的 adoptLevelMin 只接受白名单值，下发的比较语义是「>= N」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const {
  CAT_ADOPT_LEVEL_VALUES,
  CAT_ADOPT_LEVEL_UNRATED,
  isValidAdoptLevel,
  CAT_ALLOWED_FIELDS,
  CAT_NUMERIC_FIELDS,
  CAT_FIELD_LABELS
} = require('../../cloudfunctions/utils/constants');

describe('好猫星级 —— 常量与取值校验', () => {
  test('合法值只有 0 / 3 / 4 / 5', () => {
    expect(CAT_ADOPT_LEVEL_UNRATED).toBe(0);
    expect(CAT_ADOPT_LEVEL_VALUES).toEqual([3, 4, 5]);
    [0, 3, 4, 5].forEach(v => expect(isValidAdoptLevel(v)).toBe(true));
  });

  test('字符串 / 小数 / 枚举外的值一律拒绝', () => {
    ['4', 4.5, 1, 2, 6, -3, null, undefined, NaN, true, {}, [4]].forEach(v => {
      expect(isValidAdoptLevel(v)).toBe(false);
    });
  });

  test('字段已登记进白名单（否则 addCat / updateCat 会静默丢弃）', () => {
    expect(CAT_ALLOWED_FIELDS).toContain('adoptLevel');
    expect(CAT_NUMERIC_FIELDS).toContain('adoptLevel');
    expect(CAT_FIELD_LABELS.adoptLevel).toBe('好猫星级');
  });
});

/** 从录入页 wxml 提取好猫星级的可选项（bindtap="onAdoptLevel" 的 data-value） */
function collectAdminOptions() {
  const files = ['pages/admin/add-cat/add-cat.wxml', 'pages/admin/edit-cat/edit-cat.wxml'];
  const values = new Set();
  files.forEach(f => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /data-value="(\d+)"\s+bindtap="onAdoptLevel"/g;
    let m;
    while ((m = re.exec(src)) !== null) values.add(Number(m[1]));
  });
  return [...values].sort((a, b) => a - b);
}

describe('好猫星级 —— 前后端枚举一致', () => {
  test('录入页只提供「不评 + 3/4/5」，且每一项都被后端接受', () => {
    const options = collectAdminOptions();
    expect(options).toEqual([0, 3, 4, 5]);
    options.forEach(v => expect(isValidAdoptLevel(v)).toBe(true));
  });

  test('后端每个星级都被录入页提供（无凭空定义的档位）', () => {
    const options = collectAdminOptions();
    CAT_ADOPT_LEVEL_VALUES.forEach(v => expect(options).toContain(v));
  });

  test('首页卡片 / 详情页只在 >= 3 时渲染，未评级不占位', () => {
    const index = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8');
    expect(index).toContain('item.adoptLevel >= 3');
    const detail = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8');
    expect(detail).toContain('cat.adoptLevel >= 3');
    // 大小姐原话「标注一下好猫星级」：详情页必须出现该文案
    expect(detail).toContain('好猫星级');
  });

  test('详情页用五颗星展示（实心数 = 星级，剩余降透明当空位）', () => {
    const detail = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8');
    // 五颗星的槽位 + 实心/空位判定都要在模板里；星形用实心星（空心线星压白底会发白）
    expect(detail).toContain('starSlots');
    expect(detail).toContain('star-fill');
    expect(detail).toContain("'star-on' : 'star-off'");
    // 槽位数据源必须真的提供 5 个槽
    const detailJs = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.js'), 'utf8');
    expect(detailJs).toMatch(/starSlots:\s*\[1,\s*2,\s*3,\s*4,\s*5\]/);
    // 空位态样式必须有（否则 3/4 星会显示成 5 颗全亮）
    const detailWxss = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxss'), 'utf8');
    expect(detailWxss).toContain('.adopt-stars .star-off');
    // 实心星必须是金色语义色，不能被别处继承成白色
    const iconsWxss = fs.readFileSync(path.join(ROOT, 'styles/icons.wxss'), 'utf8');
    expect(iconsWxss).toMatch(/\.icon-name-star-fill[^{]*\{[^}]*var\(--icon-gold\)/s);
  });

  test('首页筛选面板提供 有星级 / 4星以上 / 5星，且都为白名单值', () => {
    const index = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8');
    const levels = [...index.matchAll(/bindtap="onAdoptFilter"[^>]*data-level="(\d*)"/g)].map(m => m[1]);
    // 第一项「全部」的回填值是空串，其余是 3/4/5
    expect(levels).toEqual(expect.arrayContaining(['', '3', '4', '5']));
    levels.filter(Boolean).forEach(v => expect(CAT_ADOPT_LEVEL_VALUES).toContain(Number(v)));
  });
});

describe('filterCats —— 好猫星级筛选', () => {
  /** 安装记录 where 条件的假 db，并返回捕获对象 */
  function installDb(mockCloud) {
    const captured = { gteCalls: [] };
    const query = {
      where: jest.fn(where => {
        captured.where = where;
        return query;
      }),
      orderBy: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query),
      count: jest.fn(() => Promise.resolve({ total: 0 })),
      get: jest.fn(() => Promise.resolve({ data: [] }))
    };
    mockCloud.database.mockReturnValue({
      collection: jest.fn(() => query),
      command: {
        in: jest.fn(v => v),
        neq: jest.fn(v => v),
        gte: jest.fn(v => {
          captured.gteCalls.push(v);
          return { $gte: v };
        })
      }
    });
    return captured;
  }

  /**
   * 每个用例独立装载 filterCats：db 实例在模块加载时固化，
   * 不重置模块就会一直用第一个用例的假 db，断言变成空转。
   */
  async function runFilter(filters) {
    jest.resetModules();
    const mockCloud = require('wx-server-sdk');
    if (mockCloud.__restoreDatabase) mockCloud.__restoreDatabase();
    const captured = installDb(mockCloud);
    const filterCats = require('../../cloudfunctions/filterCats/index');
    const res = await filterCats.main({ filters }, {});
    return { captured, res };
  }

  test('adoptLevelMin = 4 时下发 adoptLevel >= 4（含 4/5，不含未评级）', async () => {
    const { captured, res } = await runFilter({ adoptLevelMin: 4 });

    expect(res.success).toBe(true);
    expect(captured.gteCalls).toContain(4);
    expect(captured.where.adoptLevel).toEqual({ $gte: 4 });
  });

  test('数字字符串 "3" 同样按 >= 3 处理（前端 dataset 传参形态）', async () => {
    const { captured, res } = await runFilter({ adoptLevelMin: '3' });

    expect(res.success).toBe(true);
    expect(captured.where.adoptLevel).toEqual({ $gte: 3 });
  });

  test('白名单外的值（2 / "x" / 对象）被忽略，不污染查询', async () => {
    for (const bad of [2, 'x', {}, [], NaN]) {
      const { captured, res } = await runFilter({ adoptLevelMin: bad });

      expect(res.success).toBe(true);
      expect(captured.where.adoptLevel).toBeUndefined();
      expect(captured.gteCalls).toHaveLength(0);
    }
  });
});
