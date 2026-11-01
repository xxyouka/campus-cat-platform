/**
 * __tests__/utils/campusLandmark.test.js（被测模块位于 pages/admin/utils/）
 *
 * 聚集圈命名（uv 坐标 → 最近地物名）的回归：
 *   1. 地物中心命中自己的名字；
 *   2. bbox 内距离为 0，半径收到 0 也能命中；
 *   3. bbox 外但半径内仍命中最近的地物；
 *   4. 远离所有地物返回空串；
 *   5. 非法输入不抛错。
 *
 * 坐标从演示底图实时计算，替换底图后测试仍然成立。
 */
const { nearestFeatureName, DEFAULT_MAX_DISTANCE } = require('../../pages/admin/utils/campusLandmark');
const map = require('../../images/campus-map/campus-map');

const [W, H] = map.imageSize;
const uv = (x, y) => [x / W, y / H];

function bboxOf(item) {
  const xs = item.p.map(p => p[0]);
  const ys = item.p.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

describe('pages/admin/utils/campusLandmark', () => {
  const building = map.buildings.find(item => item.name === '图书馆');
  const box = bboxOf(building);
  const center = uv((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);

  test('地物中心的点 → 命中该地物名', () => {
    expect(nearestFeatureName(center[0], center[1])).toBe(building.name);
  });

  test('bbox 内的点距离为 0：把半径收到 0 也照样命中', () => {
    expect(nearestFeatureName(center[0], center[1], 0)).toBe(building.name);
  });

  test('包围盒外但在半径内 → 仍能报出地物；半径收到 0 则说不出来', () => {
    const [u, v] = uv((box.x0 + box.x1) / 2, box.y0 - 30);
    expect(nearestFeatureName(u, v, 5000)).not.toBe('');
    expect(nearestFeatureName(u, v, 0)).toBe('');
  });

  test('离所有地物都超过搜索半径 → 返回空串（页面显示「校园内某处」）', () => {
    const [u, v] = uv(5, 5);
    expect(nearestFeatureName(u, v)).toBe('');
    expect(nearestFeatureName(u, v, DEFAULT_MAX_DISTANCE)).toBe('');
  });

  test('非法坐标不抛错，返回空串', () => {
    expect(nearestFeatureName(NaN, 0.5)).toBe('');
    expect(nearestFeatureName(0.5, undefined)).toBe('');
    expect(nearestFeatureName(null, null)).toBe('');
    expect(nearestFeatureName('abc', 0.5)).toBe('');
  });
});