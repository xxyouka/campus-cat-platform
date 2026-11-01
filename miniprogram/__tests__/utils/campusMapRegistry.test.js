/**
 * __tests__/utils/campusMapRegistry.test.js
 *
 * 底图登记表是「一个校区一张图」之后唯一的校区→底图映射，
 * 错了不会报错、只会把猫画到别的校区去，所以口径必须锁死：
 *   1. 有底图的校区拿到的是**它自己**那张（不是本部）；
 *   2. 没底图的校区 getMap 返回 null —— 调用方据此不给入口/不画图，
 *      绝不能悄悄回退本部（那会产出一份永远显示不出来的坐标）；
 *   3. resolveZone 兜住脏值（空格、大小写无关的错名、空值）；
 *   4. availableZones 只列有底图的，顺序跟首页校区筛选一致。
 */
const registry = require('../../utils/campusMapRegistry');
const southMap = require('../../images/campus-map/campus-map.js');
const northMap = require('../../images/campus-map/campus-map-north.js');

describe('utils/campusMapRegistry', () => {
  describe('getMap / hasMap', () => {
    test('本部拿到本部底图，东区拿到东区底图（各是各的）', () => {
      expect(registry.getMap('本部')).toBe(southMap);
      expect(registry.getMap('东区')).toBe(northMap);
      expect(registry.getMap('本部')).not.toBe(northMap);
    });

    test('没画底图的校区返回 null，不回退本部', () => {
      expect(registry.getMap('西区')).toBeNull();
      expect(registry.getMap('南区')).toBeNull();
      expect(registry.hasMap('西区')).toBe(false);
      expect(registry.hasMap('南区')).toBe(false);
    });

    test('有底图的校区 hasMap 为 true', () => {
      expect(registry.hasMap('本部')).toBe(true);
      expect(registry.hasMap('东区')).toBe(true);
    });

    test('脏输入（空格 / undefined / null / 数字）一律拿不到图，也不抛错', () => {
      expect(registry.getMap(' 东区 ')).toBe(northMap);   // 去空白后认得
      expect(registry.getMap(undefined)).toBeNull();
      expect(registry.getMap(null)).toBeNull();
      expect(registry.getMap(123)).toBeNull();
      expect(() => registry.hasMap(undefined)).not.toThrow();
    });
  });

  describe('resolveZone', () => {
    test('认得的校区原样返回（含前后空格）', () => {
      expect(registry.resolveZone('本部')).toBe('本部');
      expect(registry.resolveZone('东区')).toBe('东区');
      expect(registry.resolveZone(' 东区 ')).toBe('东区');
    });

    test('不认得的一律退回本部（底图与猫数据都按本部取，至少不会错位）', () => {
      expect(registry.resolveZone('')).toBe('本部');
      expect(registry.resolveZone('   ')).toBe('本部');
      expect(registry.resolveZone(undefined)).toBe('本部');
      expect(registry.resolveZone(null)).toBe('本部');
      expect(registry.resolveZone('东区')).toBe('东区');
    });
  });

  describe('availableZones', () => {
    test('只列有底图的校区，顺序与首页校区筛选一致', () => {
      expect(registry.availableZones()).toEqual(['本部', '东区']);
    });

    test('返回新数组：调用方改了不会污染登记表', () => {
      const a = registry.availableZones();
      a.push('南区');
      expect(registry.availableZones()).toEqual(['本部', '东区']);
    });
  });

  describe('底图数据本身', () => {
    test('两张底图的 campusZone 与登记名一致（拿错图时这里会先红）', () => {
      expect(southMap.campusZone).toBe('本部');
      expect(northMap.campusZone).toBe('东区');
    });

    test('东区底图有边界、有建筑、坐标是底图像素', () => {
      expect(northMap.bounds.length).toBeGreaterThanOrEqual(3);
      expect(northMap.buildings.length).toBeGreaterThan(0);
      expect(northMap.imageSize[0]).toBeGreaterThan(0);
      expect(northMap.imageSize[1]).toBeGreaterThan(0);
      // 顶点必须落在底图范围内，否则归一化后会跑出画布
      const [W, H] = northMap.imageSize;
      for (const b of northMap.buildings) {
        for (const [x, y] of b.p) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(W);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(H);
        }
      }
    });
  });
});
