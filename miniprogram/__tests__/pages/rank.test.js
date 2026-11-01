/**
 * pages/rank/rank.js —— 分享卡片
 *
 * 排行榜分享最容易出三类问题：
 *   1. 不带 type：接收方永远落在默认的云吸榜，和卡片文案说的榜不一致；
 *   2. 直接拿列表头像当分享图：微信按 5:4 裁完整张卡只剩一颗猫头（2026-10-22 反馈）；
 *   3. 头像还是 cloud:// 时干脆没图。
 * 现在封面统一用随机品牌卡，第一名只出现在标题里。
 */
const ShareHelper = require('../../utils/shareHelper');

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/rank/rank');
});

function createInstance(dataOverrides) {
  const overrides = dataOverrides || {};
  const inst = { data: { ...pageDef.data, ...overrides } };
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function') inst[key] = pageDef[key].bind(inst);
  }
  return inst;
}

describe('rank 页面 · 分享', () => {
  test('好友分享：带上当前榜单类型与第一名', () => {
    const inst = createInstance({
      currentType: 'fav',
      typeMeta: { title: '关注排行' },
      list: [{ catName: '小橘', avatar: 'https://img.example.com/cat.png', count: 9 }]
    });

    const result = inst.onShareAppMessage();
    expect(result.path).toBe('/pages/rank/rank?type=fav');
    expect(result.title).toMatch(/小橘|关注排行/);
    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
  });

  test('不再拿第一名的头像当封面（大头照回归）', () => {
    const inst = createInstance({
      currentType: 'fav',
      typeMeta: { title: '关注排行' },
      list: [{ catName: '小橘', avatar: 'https://img.example.com/cat.png' }]
    });

    expect(inst.onShareAppMessage().imageUrl).not.toBe('https://img.example.com/cat.png');
  });

  test('没有榜单数据时回落通用文案，不拼 undefined，也有品牌卡', () => {
    const inst = createInstance({
      currentType: 'meet',
      typeMeta: { title: '相遇排行' },
      list: []
    });

    const result = inst.onShareAppMessage();
    expect(result.title).toContain('相遇排行');
    expect(result.title).not.toContain('undefined');
    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
  });

  test('头像还是 cloud:// 时仍然有品牌卡（不再空白）', () => {
    const inst = createInstance({
      currentType: 'view',
      typeMeta: { title: '云吸排行' },
      list: [{ catName: '小橘', avatar: 'cloud://env/cats/a.jpg' }]
    });

    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(inst.onShareAppMessage().imageUrl);
  });

  test('朋友圈：query 带榜单类型，标题带第一名，封面品牌卡', () => {
    const inst = createInstance({
      currentType: 'meet',
      typeMeta: { title: '相遇排行' },
      list: [{ catName: '小黑', avatar: 'https://img.example.com/a.png' }]
    });

    const result = inst.onShareTimeline();
    expect(result.query).toBe('type=meet');
    expect(result.title).toContain('小黑');
    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(result.imageUrl);
  });
});
