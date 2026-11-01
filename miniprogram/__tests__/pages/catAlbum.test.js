/**
 * pages/gallery/cat-album.js —— 分享卡片
 *
 * 单猫相册的分享承诺最具体（「这只猫的 N 张照片」），因此：
 *   - 标题要带猫名和张数；
 *   - 图片优先第一张照片，没有照片才退回头像；
 *   - 朋友圈进入要能还原同一只猫（catId + catName）。
 */
let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/gallery/cat-album');
});

function createInstance(dataOverrides, extra) {
  const overrides = dataOverrides || {};
  const inst = Object.assign({
    data: { ...pageDef.data, ...overrides },
    _catId: 'a'.repeat(24)
  }, extra || {});
  // ?? behaviors ??????????????????????????????
  inst.initGuideTour = jest.fn();
  inst.pauseGuideTour = jest.fn();
  inst.destroyGuideTour = jest.fn();
  for (const key of Object.keys(pageDef)) {
    if (typeof pageDef[key] === 'function') inst[key] = pageDef[key].bind(inst);
  }
  return inst;
}

describe('cat-album 页面 · 分享', () => {
  test('下一页失败保留照片与页码，停止触底重试并允许手动重试', async () => {
    const inst = createInstance({ photos: [{ _id: 'p1' }], photoPage: 1, hasMore: true, loading: false });
    inst.setData = jest.fn(updates => Object.assign(inst.data, updates));
    inst.safeSetData = inst.setData;
    wx.cloud.callFunction.mockRejectedValueOnce(new Error('network'));
    await inst.loadPhotos(inst._catId, false);
    expect(inst.data.photos).toEqual([{ _id: 'p1' }]);
    expect(inst.data.photoPage).toBe(1);
    expect(inst.data.loadMoreError).toBe(true);
    inst.loadPhotos = jest.fn();
    inst.onScrollToLower();
    expect(inst.loadPhotos).not.toHaveBeenCalled();
    inst.onLoadMore();
    expect(inst.loadPhotos).toHaveBeenCalledWith(inst._catId, false);
  });

  test('标题带猫名和照片数，路径参数编码', () => {
    const inst = createInstance({
      catInfo: { name: '小橘', photoCount: 12, avatarUrl: '' }
    });

    const result = inst.onShareAppMessage();
    expect(result.title).toContain('小橘');
    expect(result.title).toContain('12 张');
    expect(result.path).toContain(`catId=${'a'.repeat(24)}`);
    expect(result.path).toContain(`catName=${encodeURIComponent('小橘')}`);
  });

  test('分享图优先第一张照片，并换成 5:4 分享档', () => {
    const inst = createInstance({
      catInfo: { name: '小橘', photoCount: 1, avatarUrl: 'https://img.example.com/avatar.png' },
      photos: [{
        displayUrl: 'https://x.tcb.qcloud.la/p.jpg?sign=s&imageMogr2/thumbnail/400x400>/format/webp/quality/85'
      }]
    });

    const result = inst.onShareAppMessage();
    expect(result.imageUrl).toContain('thumbnail/800x640>');
    expect(result.imageUrl).not.toContain('400x400');
  });

  test('没有照片时退回头像', () => {
    const inst = createInstance({
      catInfo: { name: '小橘', photoCount: 0, avatarUrl: 'https://img.example.com/avatar.png' },
      photos: []
    });

    expect(inst.onShareAppMessage().imageUrl).toBe('https://img.example.com/avatar.png');
  });

  test('照片/头像都不可用时不传 imageUrl', () => {
    const inst = createInstance({
      catInfo: { name: '小橘', photoCount: 0, avatarUrl: 'cloud://env/a.jpg' },
      photos: []
    });

    expect(inst.onShareAppMessage().imageUrl).toBeUndefined();
  });

  test('朋友圈：query 能还原同一只猫', () => {
    const inst = createInstance({ catInfo: { name: '小橘', photoCount: 3 } });

    const result = inst.onShareTimeline();
    expect(result.query).toBe(`catId=${'a'.repeat(24)}&catName=${encodeURIComponent('小橘')}`);
    expect(result.title).toContain('小橘');
  });

  test('参数非法（没有 _catId）时分享回相册列表，不产出一个打不开的链接', () => {
    const inst = createInstance({ catInfo: null }, { _catId: '' });

    const share = inst.onShareAppMessage();
    expect(share.path).toBe('/pages/gallery/gallery');
    expect(share.path).not.toContain('undefined');

    const timeline = inst.onShareTimeline();
    expect(timeline.query).toBe('');
  });
});
