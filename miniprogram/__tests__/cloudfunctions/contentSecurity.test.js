/**
 * __tests__/cloudfunctions/contentSecurity.test.js
 *
 * 直接 require **canonical** 的 cloudfunctions/utils/contentSecurity.js。
 *
 * 与 auth.js 同属 jest.config.js 注释里点名的两个零覆盖高风险文件：各云函数用例
 * 加载的是各自 utils/ 下的副本，canonical 源从未进过覆盖率表。这个模块是内容安全的
 * 闸门（不合格文本/图片必须拦住），失败必须**关闭**而不是放过。
 *
 * 重点覆盖边界与失败方向：
 *   - 长度边界：trim 后恰好 500 字放行、501 字拦截；且判定基于 trim 后的长度
 *   - 图片大小边界：恰好 1M 放行、超 1M 拦截（判定是 ">"）
 *   - 跳过语义：无图 / 非云存储直链直接放行（调用方没图可检，不该误拦）
 *   - 失败关闭：下载失败、检测异常一律不放行
 */
const cloud = require('wx-server-sdk');
const { checkText, checkImage, checkImageAsync, bindMediaCheckRef, isAsyncMediaCheckEnabled } = require('../../cloudfunctions/utils/contentSecurity');

const ONE_MB = 1024 * 1024;
const FILE_ID = 'cloud://mock-env.bucket/photos/a.jpg';

beforeEach(() => {
  jest.clearAllMocks();
  // 默认关闭异步开关，保证下面既有用例继续走旧版 imgSecCheck 口径
  delete process.env.MEDIA_CHECK_ASYNC;
});

describe('checkText —— 入参与长度校验', () => {
  test('缺少内容时拒绝', async () => {
    expect((await checkText()).ok).toBe(false);
    expect((await checkText(null)).error).toBe('缺少待检测内容');
    expect((await checkText(123)).error).toBe('缺少待检测内容');
    expect(cloud.openapi.security.msgSecCheck).not.toHaveBeenCalled();
  });

  test('纯空白内容拒绝（不会当成有效内容送检）', async () => {
    const res = await checkText('   \n\t  ');
    expect(res).toEqual({ ok: false, error: '内容不能为空' });
    expect(cloud.openapi.security.msgSecCheck).not.toHaveBeenCalled();
  });

  test('恰好 500 字放行（边界内含）', async () => {
    const res = await checkText('啊'.repeat(500));
    expect(res.ok).toBe(true);
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledTimes(1);
  });

  test('501 字拦截', async () => {
    const res = await checkText('啊'.repeat(501));
    expect(res).toEqual({ ok: false, error: '内容长度不能超过500字' });
    expect(cloud.openapi.security.msgSecCheck).not.toHaveBeenCalled();
  });

  test('长度按 trim 后计算：500 字加首尾空白仍放行', async () => {
    const res = await checkText(`  ${'啊'.repeat(500)}  `);
    expect(res.ok).toBe(true);
  });

  test('先判空后判长：600 个空格报「内容不能为空」而非超长', async () => {
    const res = await checkText(' '.repeat(600));
    expect(res.error).toBe('内容不能为空');
  });

  test('送检的是 trim 后的内容', async () => {
    await checkText('  猫咪很可爱  ');
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledWith(
      expect.objectContaining({ content: '猫咪很可爱' })
    );
  });
});

describe('checkText —— 请求参数与失败关闭', () => {
  test('默认 scene=2、openid 空串、version 2', async () => {
    await checkText('正常内容');
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledWith({
      content: '正常内容',
      version: 2,
      scene: 2,
      openid: ''
    });
  });

  test('scene 与 openid 透传', async () => {
    await checkText('正常内容', { scene: 4, openid: 'o-1' });
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledWith(
      expect.objectContaining({ scene: 4, openid: 'o-1' })
    );
  });

  test('检测接口抛错时关闭（不放行）', async () => {
    cloud.openapi.security.msgSecCheck.mockRejectedValueOnce(new Error('risky content'));
    const res = await checkText('某些内容');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('内容可能包含不当词语，请修改后再试');
  });
});

describe('checkImage —— 跳过语义', () => {
  test('未传图直接放行（调用方没图可检，不该误拦）', async () => {
    expect(await checkImage()).toEqual({ ok: true });
    expect(await checkImage('')).toEqual({ ok: true });
    expect(await checkImage(null)).toEqual({ ok: true });
    expect(await checkImage(12345)).toEqual({ ok: true });
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  test('非云存储来源（https 直链）跳过：服务端无法取图', async () => {
    const res = await checkImage('https://example.com/a.jpg');
    expect(res).toEqual({ ok: true });
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });
});

describe('checkImage —— 大小与失败关闭', () => {
  test('下载失败时关闭', async () => {
    cloud.downloadFile.mockRejectedValueOnce(new Error('network'));
    const res = await checkImage('cloud://env/x.jpg');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片下载失败，请稍后重试');
  });

  test('空图片数据时关闭', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.alloc(0) });
    const res = await checkImage('cloud://env/x.jpg');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片数据为空');
  });

  test('恰好 1M 放行（判定是 > 1M）', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.alloc(ONE_MB) });
    const res = await checkImage('cloud://env/x.jpg');
    expect(res.ok).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledTimes(1);
  });

  test('超 1M 拦截', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.alloc(ONE_MB + 1) });
    const res = await checkImage('cloud://env/x.jpg');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片超过1M限制，请压缩后重试');
    expect(cloud.openapi.security.imgSecCheck).not.toHaveBeenCalled();
  });

  test('检测接口抛错时关闭', async () => {
    cloud.openapi.security.imgSecCheck.mockRejectedValueOnce(new Error('risky image'));
    const res = await checkImage('cloud://env/x.jpg');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片可能包含不当内容，请更换后再试');
  });

  test('瞬时故障（限流/抖动）重试一次：成功则放行', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.from('img') });
    cloud.openapi.security.imgSecCheck
      .mockRejectedValueOnce(new Error('45009 reach max api daily quota limit'))
      .mockResolvedValueOnce({ errCode: 0 });

    const res = await checkImage('cloud://env/x.jpg');

    expect(res.ok).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledTimes(2);
  });

  test('瞬时故障持续：两次都失败时按放行处理（degraded 标记），不误报为「内容不当」', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.from('img') });
    cloud.openapi.security.imgSecCheck
      .mockRejectedValueOnce(new Error('45009 reach max api daily quota limit'))
      .mockRejectedValueOnce(new Error('45009 reach max api daily quota limit'));

    const res = await checkImage('cloud://env/x.jpg');

    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledTimes(2);
  });

  test('先限流后违规：重试命中违规仍按违规拒绝', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.from('img') });
    const violation = new Error('imgSecCheck failed');
    violation.errCode = 87014;
    cloud.openapi.security.imgSecCheck
      .mockRejectedValueOnce(new Error('45009 reach max api daily quota limit'))
      .mockRejectedValueOnce(violation);

    const res = await checkImage('cloud://env/x.jpg');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片可能包含不当内容，请更换后再试');
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledTimes(2);
  });

  test('违规类错误（87014 / risky）不重试，直接按违规拒绝', async () => {
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: Buffer.from('img') });
    const violation = new Error('imgSecCheck failed');
    violation.errCode = 87014;
    cloud.openapi.security.imgSecCheck.mockRejectedValueOnce(violation);

    const res = await checkImage('cloud://env/x.jpg');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('图片可能包含不当内容，请更换后再试');
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledTimes(1);
  });

  test('送检的是下载到的 buffer，且带上 scene/openid/version', async () => {
    const buf = Buffer.from('real-image-bytes');
    cloud.downloadFile.mockResolvedValueOnce({ fileContent: buf });

    await checkImage('cloud://env/x.jpg', { scene: 3, openid: 'o-2' });

    expect(cloud.downloadFile).toHaveBeenCalledWith({ fileID: 'cloud://env/x.jpg' });
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalledWith({
      media: buf,
      version: 2,
      scene: 3,
      openid: 'o-2'
    });
  });
});

describe('checkImageAsync —— mediaCheckAsync（官方现役接口）', () => {
  /** 打开异步开关，并返回一个可控的 collection 链 */
  function enableAsync(setupChain) {
    process.env.MEDIA_CHECK_ASYNC = '1';
    const chain = setupChain ? setupChain() : null;
    cloud.database.mockReturnValue({
      collection: jest.fn(() => chain || {
        add: jest.fn(() => Promise.resolve({ _id: 'mc-1' })),
        where: jest.fn(() => ({
          limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
        }))
      }),
      serverDate: jest.fn(() => 'SERVER_DATE'),
      command: { in: jest.fn(v => v), gt: jest.fn(v => v), neq: jest.fn(v => v), inc: jest.fn(v => v), exists: jest.fn(v => v) }
    });
    return chain;
  }

  test('开关默认关闭（未配置 MEDIA_CHECK_ASYNC 时不启用异步链路）', () => {
    expect(isAsyncMediaCheckEnabled()).toBe(false);
  });

  test('开关置 1 后：取临时链接 → 提交检测 → 落待检记录 → 返回 trace_id', async () => {
    const added = [];
    const chain = enableAsync(() => ({
      add: jest.fn(({ data }) => { added.push(data); return Promise.resolve({ _id: 'mc-1' }); }),
      where: jest.fn(() => ({
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
      }))
    }));

    const res = await checkImage(FILE_ID, { scene: 2, openid: 'o-1', target: 'avatar', refId: 'cat-1' });

    expect(res.ok).toBe(true);
    expect(res.async).toBe(true);
    expect(res.traceId).toBe('mock-trace-id');
    expect(cloud.getTempFileURL).toHaveBeenCalledWith({ fileList: [FILE_ID] });
    expect(cloud.openapi.security.mediaCheckAsync).toHaveBeenCalledWith(expect.objectContaining({
      media_url: 'https://mock-cdn.example/mock-image.jpg',
      media_type: 1,
      version: 2,
      openid: 'o-1'
    }));
    // 旧版同步接口不再被调用（异步路径不下载文件）
    expect(cloud.downloadFile).not.toHaveBeenCalled();
    expect(cloud.openapi.security.imgSecCheck).not.toHaveBeenCalled();

    // 待检记录必须带上处置对象，否则回调无法定位
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual(expect.objectContaining({
      traceId: 'mock-trace-id',
      fileID: FILE_ID,
      target: 'avatar',
      refId: 'cat-1',
      status: 'pending'
    }));
    expect(chain).not.toBeNull();
  });

  test('取不到临时链接 → 退回旧版接口（fallback），不阻断上传', async () => {
    enableAsync();
    cloud.getTempFileURL.mockResolvedValueOnce({ fileList: [{ tempFileURL: '' }] });

    const res = await checkImage(FILE_ID, { openid: 'o-1' });

    expect(res.ok).toBe(true);
    // fallback 会被 checkImage 转译为「走旧版」，因此旧接口确实被调用了
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalled();
    expect(cloud.openapi.security.mediaCheckAsync).not.toHaveBeenCalled();
  });

  test('接口不可用（40001 / 41005）→ 退回旧版接口', async () => {
    enableAsync();
    const err = new Error('invalid media_url');
    err.errCode = 41005;
    cloud.openapi.security.mediaCheckAsync.mockRejectedValueOnce(err);

    const res = await checkImage(FILE_ID, { openid: 'o-1' });

    expect(res.ok).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).toHaveBeenCalled();
  });

  test('接口异常但非不可用（如下载错误）→ 放行并告警（degraded），不退回旧版', async () => {
    enableAsync();
    cloud.openapi.security.mediaCheckAsync.mockRejectedValueOnce(new Error('下载错误，请检查媒体链接是否有效'));

    const res = await checkImage(FILE_ID, { openid: 'o-1' });

    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
    expect(cloud.openapi.security.imgSecCheck).not.toHaveBeenCalled();
  });

  test('未返回 trace_id → 放行并告警（degraded）', async () => {
    enableAsync();
    cloud.openapi.security.mediaCheckAsync.mockResolvedValueOnce({ errcode: 0 });

    const res = await checkImage(FILE_ID, { openid: 'o-1' });

    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(true);
  });

  test('待检记录落库失败不阻断上传（合规兜底不反过来卡业务）', async () => {
    enableAsync(() => ({
      add: jest.fn(() => Promise.reject(new Error('collection not exists'))),
      where: jest.fn(() => ({
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: [] })) }))
      }))
    }));

    const res = await checkImage(FILE_ID, { openid: 'o-1', target: 'photo' });

    expect(res.ok).toBe(true);
    expect(res.async).toBe(true);
  });

  test('开关关闭时完全不碰异步链路', async () => {
    const res = await checkImage(FILE_ID, { openid: 'o-1' });
    expect(res.ok).toBe(true);
    expect(cloud.openapi.security.mediaCheckAsync).not.toHaveBeenCalled();
    expect(cloud.getTempFileURL).not.toHaveBeenCalled();
  });

  test('直接调 checkImageAsync 时开关不参与判断（供单元测试与将来复用）', async () => {
    delete process.env.MEDIA_CHECK_ASYNC;
    const res = await checkImageAsync(FILE_ID, { openid: 'o-1' });
    expect(res.async).toBe(true);
  });
});

describe('bindMediaCheckRef —— 落库后补绑处置对象', () => {
  function stubCollection(pendingRows) {
    const update = jest.fn(() => Promise.resolve({ stats: { updated: 1 } }));
    const chain = {
      where: jest.fn(() => ({
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: pendingRows })) }))
      })),
      doc: jest.fn(() => ({ update }))
    };
    cloud.database.mockReturnValue({ collection: jest.fn(() => chain), serverDate: jest.fn(() => 'SERVER_DATE') });
    return { chain, update };
  }

  test('缺 traceId 或 refId 时直接跳过（不写库）', async () => {
    const { update } = stubCollection([{ _id: 'mc-1' }]);
    expect(await bindMediaCheckRef('', 'cat-1')).toBe(false);
    expect(await bindMediaCheckRef('trace-1', '')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  test('命中 pending 记录则补写 refId', async () => {
    const { chain, update } = stubCollection([{ _id: 'mc-1', status: 'pending' }]);
    const bound = await bindMediaCheckRef('trace-1', 'cat-abc');
    expect(bound).toBe(true);
    expect(chain.doc).toHaveBeenCalledWith('mc-1');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ refId: 'cat-abc' })
    }));
  });

  test('记录已不在 pending（回调已处理）→ 不重复绑定', async () => {
    const { update } = stubCollection([]);
    expect(await bindMediaCheckRef('trace-1', 'cat-abc')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  test('查询异常也不抛出（调用方是主流程，不能因此失败）', async () => {
    cloud.database.mockReturnValue({
      collection: jest.fn(() => ({ where: jest.fn(() => { throw new Error('db down'); }) })),
      serverDate: jest.fn(() => 'SERVER_DATE')
    });
    await expect(bindMediaCheckRef('trace-1', 'cat-abc')).resolves.toBe(false);
  });
});
