/**
 * __tests__/utils/imageRetryManager.test.js
 * 覆盖头像重试链路：必须强制转链（force）并写回真正被渲染的 filteredCats
 */
jest.mock('../../utils/imageLoader', () => ({
  getTempUrls: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
  Logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), swallow: jest.fn() }
}));

const imageRetryManager = require('../../utils/imageRetryManager');
const imageLoader = require('../../utils/imageLoader');

const FRESH_URL = 'https://env.tcb.qcloud.la/a.jpg?sign=new&t=2';

function createPage(overrides = {}) {
  return {
    data: {
      cats: [{ _id: 'c1', avatar: 'https://env.tcb.qcloud.la/a.jpg?sign=old&t=1' }],
      filteredCats: [{ _id: 'c1', avatar: 'https://env.tcb.qcloud.la/a.jpg?sign=old&t=1' }],
      ...overrides
    },
    setData: jest.fn()
  };
}

describe('ImageRetryManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    imageRetryManager.cleanup();
  });

  afterEach(() => {
    imageRetryManager.cleanup();
    jest.useRealTimers();
  });

  test('重试必须带 force 强制转链（否则读穿缓存拿回同一条 URL，重试是空操作）', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page);
    await jest.advanceTimersByTimeAsync(1000);

    expect(imageLoader.getTempUrls).toHaveBeenCalledWith(['cloud://a'], {
      optimizeType: 'avatar',
      force: true
    });
  });

  // 首页大头照回归：档位不跟随调用方，重试成功会把已经清晰的头像
  // 换成 100x100 的糊图 —— 同屏出现「首屏图清晰、重试图糊」的两批不同清晰度。
  test('档位跟随调用方（首页 gallery），重试不会把清晰头像换成糊图', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page, 'gallery');
    await jest.advanceTimersByTimeAsync(10000);

    expect(imageLoader.getTempUrls).toHaveBeenCalledWith(['cloud://a'], {
      optimizeType: 'gallery',
      force: true
    });
  });

  // 多轮重试之间不能丢档位：第一次失败后递归调度时仍须带上同一档位
  test('多轮重试之间保持档位不丢失', async () => {
    imageLoader.getTempUrls
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce({ 'cloud://a': FRESH_URL });
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page, 'gallery');
    await jest.advanceTimersByTimeAsync(1000); // 第 1 次：失败
    await jest.advanceTimersByTimeAsync(10000); // 第 2 次：成功

    expect(imageLoader.getTempUrls).toHaveBeenLastCalledWith(['cloud://a'], {
      optimizeType: 'gallery',
      force: true
    });
  });

  test('重试成功后写入 cats 与 filteredCats（WXML 渲染的是后者）', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page);
    await jest.advanceTimersByTimeAsync(1000);
    expect(page.setData).toHaveBeenCalledWith(expect.objectContaining({
      'cats[0].avatar': FRESH_URL,
      'filteredCats[0].avatar': FRESH_URL
    }));
  });

  test('重试回调晚到、页面已卸载：走 safeSetData 被丢弃，不得裸 setData', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = createPage();
    // 页面自己的卸载保护（safeSetDataBehavior 的口径：已卸载则丢弃写入）
    page.safeSetData = jest.fn(updates => {
      if (page._isUnmounted) return;
      page.setData(updates);
    });

    imageRetryManager.handleError('c1', 'cloud://a', page);
    page._isUnmounted = true; // 转链在途时用户已返回上一页
    await jest.advanceTimersByTimeAsync(1000);

    expect(page.safeSetData).toHaveBeenCalled();
    expect(page.setData).not.toHaveBeenCalled();
  });

  test('不再写 _avatarVersion（全仓 WXML 无该绑定，属双重死逻辑）', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page);
    await jest.advanceTimersByTimeAsync(1000);

    const writtenKeys = page.setData.mock.calls.flatMap(call => Object.keys(call[0]));
    expect(writtenKeys.some(key => key.includes('_avatarVersion'))).toBe(false);
  });

  test('无 cats/filteredCats 的页面（详情页）不应抛错', async () => {
    imageLoader.getTempUrls.mockResolvedValue({ 'cloud://a': FRESH_URL });
    const page = { data: {}, setData: jest.fn() };

    imageRetryManager.handleError('c1', 'cloud://a', page);
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();
    expect(page.setData).not.toHaveBeenCalled();
  });

  test('转链失败时按最大次数重试后放弃', async () => {
    imageLoader.getTempUrls.mockResolvedValue({});
    const page = createPage();

    imageRetryManager.handleError('c1', 'cloud://a', page);
    await jest.advanceTimersByTimeAsync(10000);

    // MAX_RETRY_ATTEMPTS = 2
    expect(imageLoader.getTempUrls).toHaveBeenCalledTimes(2);
    expect(page.setData).not.toHaveBeenCalled();
  });
});
