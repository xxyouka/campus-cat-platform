/**
 * utils/shareHelper.js —— 分享卡片统一口径
 *
 * 锁四件事：
 *   1. 云存储 fileID 不能当分享图（微信不认，卡片空白）
 *   2. TCB 缩略档必须换成 800×640 分享档（2026-10-12 糊图回归）
 *   3. 数据没回来时不能拼出「undefined」/「0」这类标题
 *   4. 查询串必须编码，空值不留 `?`
 */
const ShareHelper = require('../../utils/shareHelper');

describe('shareHelper', () => {
  /** 品牌卡是随机抽的，只能断言「属于集合」，不能断言某一张 */
  function expectBrandImage(value) {
    expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(value);
  }

  describe('randomBrandImage', () => {
    test('返回品牌卡集合中的一张', () => {
      expect(ShareHelper.BRAND_SHARE_IMAGES.length).toBeGreaterThan(0);
      for (let i = 0; i < 20; i++) {
        expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(ShareHelper.randomBrandImage());
      }
    });

    test('按 Math.random 取下标（每次分享换一张）', () => {
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(ShareHelper.randomBrandImage()).toBe(ShareHelper.BRAND_SHARE_IMAGES[1]);
      spy.mockRestore();
    });

    test('每张卡都是代码包内的 5:4 分享卡路径', () => {
      ShareHelper.BRAND_SHARE_IMAGES.forEach((p) => {
        expect(p).toMatch(/^\/images\/share\/card-.+\.(png|jpg)$/);
      });
    });
  });

  describe('pickTitle', () => {
    test('从候选里抽一条', () => {
      const titles = ['A', 'B', 'C'];
      const picked = ShareHelper.pickTitle(titles);
      expect(titles).toContain(picked);
    });

    test('过滤空串 / 非字符串，全空返回空串', () => {
      expect(ShareHelper.pickTitle(['', '  ', null, 1])).toBe('');
      expect(ShareHelper.pickTitle([])).toBe('');
      expect(ShareHelper.pickTitle(null)).toBe('');
    });
  });

  describe('shareImage', () => {
    test('空值 / cloud:// 回退随机品牌卡', () => {
      expectBrandImage(ShareHelper.shareImage(''));
      expectBrandImage(ShareHelper.shareImage(null));
      expectBrandImage(ShareHelper.shareImage('cloud://env/cats/a.jpg'));
    });

    test('TCB 缩略档替换成 5:4 分享档（800×640）', () => {
      const url = 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/100x100>/format/webp/quality/85';
      const result = ShareHelper.shareImage(url);
      expect(result).toContain('thumbnail/800x640>');
      expect(result).not.toContain('100x100');
      expect(result).toContain('format/jpg');
    });

    test('第三方直链原样返回', () => {
      expect(ShareHelper.shareImage('https://img.example.com/a.png'))
        .toBe('https://img.example.com/a.png');
    });

    test('optionalShareImage 取不到图时返回空串（调用方据此省略 imageUrl）', () => {
      expect(ShareHelper.optionalShareImage('')).toBe('');
      expect(ShareHelper.optionalShareImage('cloud://env/a.jpg')).toBe('');
      expect(ShareHelper.optionalShareImage('https://img.example.com/a.png'))
        .toBe('https://img.example.com/a.png');
    });

    test('firstShareImage 跳过不可用项，取第一张能用的', () => {
      expect(ShareHelper.firstShareImage([
        'cloud://env/a.jpg',
        '',
        'https://img.example.com/b.png'
      ])).toBe('https://img.example.com/b.png');
      expect(ShareHelper.firstShareImage(['cloud://env/a.jpg'], '')).toBe('');
      expect(ShareHelper.firstShareImage(null, '/fallback.png')).toBe('/fallback.png');
    });
  });

  describe('buildQuery / buildPath', () => {
    test('编码中文并跳过空值', () => {
      expect(ShareHelper.buildQuery({ zone: '东区', type: '', page: null, id: 7 }))
        .toBe(`zone=${encodeURIComponent('东区')}&id=7`);
    });

    test('没有参数时不留孤零零的问号', () => {
      expect(ShareHelper.buildPath('/pages/index/index')).toBe('/pages/index/index');
      expect(ShareHelper.buildPath('/pages/index/index', {})).toBe('/pages/index/index');
      expect(ShareHelper.buildPath('/pages/index/index', { a: '' })).toBe('/pages/index/index');
    });

    test('有参数时拼成完整路径', () => {
      expect(ShareHelper.buildPath('/pages/rank/rank', { type: 'fav' }))
        .toBe('/pages/rank/rank?type=fav');
    });
  });

  describe('truncate', () => {
    test('压缩空白并按长度截断', () => {
      expect(ShareHelper.truncate('  你好   世界  ')).toBe('你好 世界');
      expect(ShareHelper.truncate('一二三四五六', 4)).toBe('一二三四…');
      expect(ShareHelper.truncate('', 4)).toBe('');
      expect(ShareHelper.truncate(null, 4)).toBe('');
    });
  });

  describe('品牌卡本地缓存', () => {
    test('启动预热只接受带协议的临时路径（相对路径忽略）', () => {
      const prev = wx.getImageInfo;
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
      try {
        wx.getImageInfo = jest.fn(({ src, success }) => {
          success({ path: 'http://tmp/' + src.split('/').pop() });
        });
        ShareHelper.warmBrandImages();
        expect(ShareHelper.randomBrandImage()).toContain('http://tmp/');

        ShareHelper._resetBrandImageCache();
        wx.getImageInfo = jest.fn(({ src, success }) => {
          success({ path: 'images/' + src.split('/').pop() });
        });
        ShareHelper.warmBrandImages();
        // 没有文件系统时回退包路径；关键是不能把相对路径当分享图
        expect(ShareHelper.randomBrandImage()).toBe(ShareHelper.BRAND_SHARE_IMAGES[0]);
      } finally {
        spy.mockRestore();
        ShareHelper._resetBrandImageCache();
        wx.getImageInfo = prev;
      }
    });

    test('优先转成本地临时文件（分享面板对 wxfile 路径更稳）', () => {
      const prevFs = wx.getFileSystemManager;
      const prevEnv = wx.env;
      const fs = { readFileSync: jest.fn(() => Buffer.from('x')), writeFileSync: jest.fn() };
      wx.getFileSystemManager = jest.fn(() => fs);
      wx.env = { USER_DATA_PATH: 'wxfile://usr' };
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const out = ShareHelper.randomBrandImage();
        expect(out).toContain('wxfile://usr');
        expect(out).toContain(ShareHelper.BRAND_SHARE_IMAGES[0].split('/').pop());
        expect(fs.writeFileSync).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        ShareHelper._resetBrandImageCache();
        wx.getFileSystemManager = prevFs;
        wx.env = prevEnv;
      }
    });

    test('文件系统不可用时退回代码包路径，不影响分享', () => {
      const prevFs = wx.getFileSystemManager;
      const prevEnv = wx.env;
      wx.getFileSystemManager = undefined;
      try {
        expect(ShareHelper.BRAND_SHARE_IMAGES).toContain(ShareHelper.randomBrandImage());
      } finally {
        wx.getFileSystemManager = prevFs;
        wx.env = prevEnv;
        ShareHelper._resetBrandImageCache();
      }
    });
  });
});
