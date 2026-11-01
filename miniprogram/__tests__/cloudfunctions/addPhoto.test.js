/**
 * __tests__/cloudfunctions/addPhoto.test.js
 *
 * addPhoto（添加照片）此前零测试覆盖。本文件锁定：
 *   1. 契约：参数校验 → 鉴权 → 路径守卫 → 内容检测 → 回查真实猫名 → 写库 + 日志；
 *   2. 安全（2026-10-06）：url 必须是 photos/ 下的云存储文件 —— 否则
 *      「检测失败即删文件」会变成「传任意已知 fileID 触发服务端删除」的任意文件删除原语；
 *      https 外链同样拒绝（checkImage 对非云存储来源直接放行，等于跳过审核）；
 *   3. 删除中的猫（_deleting）拒绝挂照片；猫咪不存在时如实报错；
 *   4. 内容违规时回收已上传文件；业务失败不产生记录。
 */
jest.mock('wx-server-sdk');
jest.mock('../../cloudfunctions/addPhoto/utils/auth', () => ({ checkAdmin: jest.fn() }));
jest.mock('../../cloudfunctions/addPhoto/utils/contentSecurity', () => ({
  checkImage: jest.fn(),
  // 异步检测（mediaCheckAsync）落库后补绑 photoId 用；非异步路径下是空操作
  bindMediaCheckRef: jest.fn(() => Promise.resolve(false))
}));
jest.mock('../../cloudfunctions/addPhoto/common/operationLogger', () => ({
  logOperation: jest.fn(() => Promise.resolve())
}));

const VALID_CAT_ID = 'a'.repeat(24);
const PHOTO_URL = 'cloud://mock-env.bucket/photos/album/1.jpg';

function makeDb({ catData = { name: '小橘' }, catError = null } = {}) {
  const added = [];
  const db = {
    collection: jest.fn((name) => {
      if (name === 'photos') {
        return {
          add: jest.fn(({ data }) => {
            added.push(data);
            return Promise.resolve({ _id: 'photo-1' });
          })
        };
      }
      // cats
      return {
        doc: jest.fn(() => ({
          field: jest.fn(() => ({
            get: jest.fn(() => {
              if (catError) return Promise.reject(catError);
              return Promise.resolve({ data: catData });
            })
          }))
        }))
      };
    }),
    serverDate: jest.fn(() => 'SERVER_DATE')
  };
  return { db, added };
}

describe('addPhoto 云函数', () => {
  let cloud;
  let auth;
  let contentSecurity;
  let logger;
  let main;

  function setup({ isAdmin = true, imgCheck = { ok: true }, dbOptions = {} } = {}) {
    jest.resetModules();
    const fake = makeDb(dbOptions);
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    cloud.database.mockReturnValue(fake.db);
    cloud.getWXContext.mockReturnValue({ OPENID: 'admin-openid' });
    cloud.deleteFile = jest.fn(() => Promise.resolve({ fileList: [] }));

    auth = require('../../cloudfunctions/addPhoto/utils/auth');
    auth.checkAdmin.mockResolvedValue(
      isAdmin
        ? { isAdmin: true, adminInfo: { role: 'admin' } }
        : { isAdmin: false, error: '无权限执行此操作' }
    );
    contentSecurity = require('../../cloudfunctions/addPhoto/utils/contentSecurity');
    contentSecurity.checkImage.mockResolvedValue(imgCheck);
    logger = require('../../cloudfunctions/addPhoto/common/operationLogger');
    logger.logOperation.mockClear();

    main = require('../../cloudfunctions/addPhoto/index').main;
    return fake;
  }

  test('缺少必要参数 / 非法猫咪ID 均拒绝', async () => {
    setup();
    expect((await main({ catId: VALID_CAT_ID }, {})).success).toBe(false);
    const bad = await main({ catId: 'short', url: PHOTO_URL }, {});
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('无效的猫咪ID');
  });

  test('非管理员被拒绝', async () => {
    setup({ isAdmin: false });
    const res = await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
    expect(contentSecurity.checkImage).not.toHaveBeenCalled();
  });

  test('url 不在 photos/ 目录：拒绝且绝不触发下载/删除（任意文件删除原语已封死）', async () => {
    setup();
    const res = await main({
      catId: VALID_CAT_ID,
      url: 'cloud://mock-env.bucket/cats/avatar/1.jpg'
    }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('路径不合法');
    expect(contentSecurity.checkImage).not.toHaveBeenCalled();
    expect(cloud.deleteFile).not.toHaveBeenCalled();
  });

  test('https 外链同样被路径守卫拒绝（堵住 imgSecCheck 的跳过分支）', async () => {
    setup();
    const res = await main({ catId: VALID_CAT_ID, url: 'https://example.com/a.jpg' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('路径不合法');
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  test('内容违规：回收已上传文件并如实报错', async () => {
    setup({ imgCheck: { ok: false, error: '图片可能包含不当内容，请更换后再试' } });
    const res = await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('不当');
    expect(cloud.deleteFile).toHaveBeenCalledWith({ fileList: [PHOTO_URL] });
  });

  test('猫咪不存在 / 删除中的猫：拒绝且不写记录', async () => {
    const notFound = setup({ dbOptions: { catError: new Error('document with _id x does not exist') } });
    let res = await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('不存在');
    expect(notFound.added).toHaveLength(0);

    const deleting = setup({ dbOptions: { catData: { name: '小橘', _deleting: true } } });
    res = await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('不存在');
    expect(deleting.added).toHaveLength(0);
  });

  test('成功：写入真实猫名（忽略客户端传入的 catName）并记录操作日志', async () => {
    const fake = setup();
    const res = await main({
      catId: VALID_CAT_ID,
      catName: '客户端伪造的名字',
      url: PHOTO_URL
    }, {});
    expect(res.success).toBe(true);
    expect(res.data.id).toBe('photo-1');
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0].catName).toBe('小橘');
    expect(fake.added[0].url).toBe(PHOTO_URL);
    expect(fake.added[0].uploaderName).toBe('管理员');
    expect(fake.added[0]).not.toHaveProperty('_openid');
    expect(logger.logOperation).toHaveBeenCalled();
  });

  // 「上传了什么」的答案：张数 + 归属。
  // 刻意不落 fileID —— 那是 cloud:// 长串、前端不能直接渲染，
  // 管理员在日志里也读不出任何信息；要真的看图应该去相册管理。
  test('成功：日志记「张数 + 归属」，不把 fileID 写进摘要', async () => {
    setup();
    await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});

    const [, , info] = logger.logOperation.mock.calls[0];
    expect(info.summary).toBe('上传照片 1 张 → 小橘');
    expect(info.changes).toEqual([{ label: '新增照片', text: '1 张（归属：小橘）' }]);
    expect(JSON.stringify(info.summary) + JSON.stringify(info.changes))
      .not.toContain('cloud://');
  });

  // 相册页面对每个文件单独调一次 addPhoto，因此这里固定 1 张。
  // 传 5 张会落 5 条日志各记 1 张，与真实操作一一对应 —— 不能合并成一条 5 张。
  test('成功：单次调用固定记 1 张（多张上传由前端循环拆成多次调用）', async () => {
    setup();
    await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});

    const [, , info] = logger.logOperation.mock.calls[0];
    expect(info.changes[0].text).toContain('1 张');
    expect(info.changes[0].text).not.toContain('2 张');
  });

  // 审计层保持原样：摘要层是纯增量，不能顺手把 beforeData/afterData 也改掉
  test('成功：审计层 afterData 保持既有口径（摘要层不改写它）', async () => {
    setup();
    await main({ catId: VALID_CAT_ID, url: PHOTO_URL }, {});

    const [, , info] = logger.logOperation.mock.calls[0];
    expect(info.afterData).toEqual({ catName: '小橘', catId: VALID_CAT_ID });
  });
});
