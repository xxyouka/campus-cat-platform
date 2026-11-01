/**
 * __tests__/utils/avatarHelper.test.js
 *
 * 头像档位解析的仓库原生回归测试。
 *
 * 背景：曾有一整类缺陷 —— 把裸 cloud:// fileID 直接塞进 <image src>，绕过尺寸档位
 * 加载全尺寸原图（流量与首屏成本）。修复铺在多个文件、多条代码路径上
 * （fav-rank、meet-rank、relation-manage、detail、map 等），
 * 但此前只有临时 harness 验证过，会话一结束就没有防护。
 *
 * 这里钉住的是 resolveCatAvatars 这个统一出口的真实行为：
 *   - 头像档位必须被套上，且临时链接用 "&" 追加（自带 ?sign=&t= 的场景）
 *   - 批量失败要降级到 wx.cloud.getTempFileURL，且降级路径产出的 URL 形态与主路径一致
 *   - 两条路都失败时回退为裸 fileID —— 这是**已知行为**，显式钉住，
 *     将来若要改成占位图，必须是有意识地改这条断言，而不是悄悄漂移
 *   - 非 cloud:// 头像不触发任何云调用
 */
jest.mock('../../utils/imageLoader', () => ({
  getTempUrls: jest.fn()
}));

const imageLoader = require('../../utils/imageLoader');
const MediaHelper = require('../../utils/avatarHelper');

const CLOUD_A = 'cloud://env.bucket/photos/a.jpg';
const CLOUD_B = 'cloud://env.bucket/photos/b.jpg';
// 云存储临时链接自带 ?sign=&t=，是 "分隔符必须是 &" 这条规则的现实来源
const TEMP_A = 'https://env.tcb.qcloud.la/photos/a.jpg?sign=abc&t=123';
const TEMP_B = 'https://env.tcb.qcloud.la/photos/b.jpg?sign=def&t=456';

/** 头像档位的期望参数（与 ImageOptimizer.getAvatarUrl 一致：100x100 > webp q85） */
const AVATAR_PARAMS = 'imageMogr2/thumbnail/100x100>/format/webp/quality/85';

beforeEach(() => {
  jest.clearAllMocks();
  global.wx.cloud.getTempFileURL.mockReset();
  global.wx.cloud.getTempFileURL.mockResolvedValue({ fileList: [] });
});

describe('resolveCatAvatars —— 档位与分隔符', () => {
  test('cloud:// 头像解析后套上头像档位，且用 & 追加参数', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: CLOUD_A }]);

    expect(res[0].avatar).toBe(`${TEMP_A}&${AVATAR_PARAMS}`);
    // 决定性细节：临时链接已带 ?sign=&t=，再拼 "?" 会让 imageMogr2 落进上一个参数的值里
    expect(res[0].avatar).toContain('&imageMogr2/');
    expect(res[0].avatar).not.toContain('?imageMogr2/');
  });

  test('按 avatar 档位请求（不是 thumbnail/gallery）', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: CLOUD_A }]);

    expect(imageLoader.getTempUrls).toHaveBeenCalledWith([CLOUD_A], { optimizeType: 'avatar' });
  });

  test('无 avatar 字段时取 images[0] 并同样过档位', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', images: [CLOUD_A] }]);

    expect(res[0].avatar).toBe(`${TEMP_A}&${AVATAR_PARAMS}`);
  });

  test('记录原始 fileID 到 _cloudFileID', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: CLOUD_A }]);

    expect(res[0]._cloudFileID).toBe(CLOUD_A);
  });

  test('多个 cloud:// 头像一次批量解析', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A, [CLOUD_B]: TEMP_B });

    const res = await MediaHelper.resolveCatAvatars([
      { _id: 'c1', avatar: CLOUD_A },
      { _id: 'c2', avatar: CLOUD_B }
    ]);

    expect(imageLoader.getTempUrls).toHaveBeenCalledTimes(1);
    expect(res[0].avatar).toBe(`${TEMP_A}&${AVATAR_PARAMS}`);
    expect(res[1].avatar).toBe(`${TEMP_B}&${AVATAR_PARAMS}`);
  });
});

describe('resolveCatAvatars —— 非 cloud:// 与空输入', () => {
  test('https 头像原样保留，不触发任何云调用', async () => {
    const https = 'https://example.com/cat.jpg';

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: https }]);

    expect(res[0].avatar).toBe(https);
    expect(imageLoader.getTempUrls).not.toHaveBeenCalled();
    expect(global.wx.cloud.getTempFileURL).not.toHaveBeenCalled();
  });

  test('无头像的猫咪不触发云调用（avatar 为 null）', async () => {
    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1' }]);

    expect(res[0].avatar).toBeNull();
    expect(imageLoader.getTempUrls).not.toHaveBeenCalled();
  });

  test('空数组原样返回', async () => {
    expect(await MediaHelper.resolveCatAvatars([])).toEqual([]);
    expect(imageLoader.getTempUrls).not.toHaveBeenCalled();
  });
});

describe('resolveCatAvatars —— 降级与失败回退', () => {
  test('批量失败时降级到 wx.cloud.getTempFileURL，且产出同一档位形态', async () => {
    imageLoader.getTempUrls.mockRejectedValue(new Error('batch failed'));
    global.wx.cloud.getTempFileURL.mockResolvedValue({
      fileList: [{ fileID: CLOUD_A, status: 0, tempFileURL: TEMP_A }]
    });

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: CLOUD_A }]);

    // 降级路径也必须套档位：两条路产出的形态必须一致，否则同一张头像会因失败与否而不同
    expect(res[0].avatar).toBe(`${TEMP_A}&${AVATAR_PARAMS}`);
    expect(global.wx.cloud.getTempFileURL).toHaveBeenCalledWith({ fileList: [CLOUD_A] });
  });

  test('降级中单条 status !== 0 被跳过，且不影响同批其他项', async () => {
    imageLoader.getTempUrls.mockRejectedValue(new Error('batch failed'));
    // 关键：失败项**故意带上可用的 tempFileURL** —— 若实现只看 tempFileURL 而忽略 status，
    // 它会被当成成功项用上，断言随即失败。少写这个字段，本用例对 status 判据零约束力
    // （实测把 mediaHelper 的 `status === 0` 删掉仍全绿，因为 fixture 缺 URL 那条先把它挡住了）。
    // 降级是逐个 fileID 调用，所以必须按请求内容分别应答，单条失败才与单条成功可区分。
    global.wx.cloud.getTempFileURL.mockImplementation(({ fileList }) =>
      Promise.resolve({
        fileList: fileList[0] === CLOUD_A
          ? [{ fileID: CLOUD_A, status: -1, tempFileURL: TEMP_A }]
          : [{ fileID: CLOUD_B, status: 0, tempFileURL: TEMP_B }]
      })
    );

    const res = await MediaHelper.resolveCatAvatars([
      { _id: 'c1', avatar: CLOUD_A },
      { _id: 'c2', avatar: CLOUD_B }
    ]);

    // 失败项回退为裸 fileID —— 这是**已知行为**，显式钉住：
    // 若将来改成占位图，必须是有意识地改这条断言，而不是悄悄漂移
    expect(res[0].avatar).toBe(CLOUD_A);
    expect(res[0]._cloudFileID).toBe(CLOUD_A);
    // 同批的成功项照常套档位 —— 单条失败不得影响其他
    expect(res[1].avatar).toBe(`${TEMP_B}&${AVATAR_PARAMS}`);
  });

  test('降级里抛错被吞掉（不冒泡到调用方）', async () => {
    imageLoader.getTempUrls.mockRejectedValue(new Error('batch failed'));
    global.wx.cloud.getTempFileURL.mockRejectedValue(new Error('also failed'));

    const res = await MediaHelper.resolveCatAvatars([{ _id: 'c1', avatar: CLOUD_A }]);

    expect(res[0].avatar).toBe(CLOUD_A);
  });
});

describe('resolveCatAvatars —— 注入字段与加载态', () => {
  test('注入 photoCount（默认 0）与格式化后的 updateTime', async () => {
    const res = await MediaHelper.resolveCatAvatars(
      [
        { _id: 'c1', avatar: 'https://example.com/a.jpg', updateTime: new Date() },
        { _id: 'c2', avatar: 'https://example.com/b.jpg' }
      ],
      [],
      { photoCountsMap: { c1: 7 } }
    );

    expect(res[0].photoCount).toBe(7);
    expect(res[1].photoCount).toBe(0);
    expect(res[0].updateTime).toMatch(/^\d{2}-\d{2}$/); // 今年内不显示年份
    expect(res[1].updateTime).toBe('');
  });

  test('avatarLoaded 沿用 existingCats 中同 _id 的值', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    const res = await MediaHelper.resolveCatAvatars(
      [{ _id: 'c1', avatar: CLOUD_A }, { _id: 'c2', avatar: CLOUD_A }],
      [{ _id: 'c1', avatarLoaded: true }]
    );

    expect(res[0].avatarLoaded).toBe(true);
    expect(res[1].avatarLoaded).toBe(false);
  });

  test('不修改传入的原对象（返回新对象）', async () => {
    const original = { _id: 'c1', avatar: CLOUD_A };
    imageLoader.getTempUrls.mockResolvedValue({ [CLOUD_A]: TEMP_A });

    await MediaHelper.resolveCatAvatars([original]);

    expect(original.avatar).toBe(CLOUD_A); // 原对象未被就地改写
  });
});

describe('selectAvatar', () => {
  test('avatar 优先于 images[0]', () => {
    expect(MediaHelper.selectAvatar({ avatar: 'a.jpg', images: ['b.jpg'] })).toBe('a.jpg');
  });

  test('无 avatar 时取 images[0]', () => {
    expect(MediaHelper.selectAvatar({ images: ['b.jpg'] })).toBe('b.jpg');
  });

  test('都没有时返回 null（不抛错）', () => {
    expect(MediaHelper.selectAvatar({})).toBeNull();
    expect(MediaHelper.selectAvatar(null)).toBeNull();
  });
});
