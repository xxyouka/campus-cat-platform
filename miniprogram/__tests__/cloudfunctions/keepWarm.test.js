/**
 * 回归：keepWarm 只允许定时触发器调用。
 *
 * 背景：keepWarm 原先没有任何调用方鉴权 —— 任意小程序用户都可以用
 * wx.cloud.callFunction 反复触发它，每次连锁调用 7 个云函数（配额消耗型滥用）。
 * keepWarm 没有 HTTP 路由、也没有任何客户端调用方，唯一合法入口是
 * cloudbaserc.json 中的 keepWarmTrigger 定时器（无 OPENID）。
 *
 * 修复口径：客户端调用一定携带 OPENID，定时触发一定没有；
 * 命中 OPENID 即拒绝，且不得连锁调用任何云函数。
 */
jest.mock('wx-server-sdk');

describe('keepWarm 云函数', () => {
  let cloud;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    main = require('../../cloudfunctions/keepWarm/index').main;
  });

  test('客户端调用（携带 OPENID）被拒绝，且不连锁调用任何云函数', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'test-openid' });
    cloud.callFunction.mockClear();

    const res = await main({}, {});

    expect(res.success).toBe(false);
    expect(cloud.callFunction).not.toHaveBeenCalled();
  });

  test('定时触发调用（无 OPENID）正常预热全部函数', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    const res = await main({ Type: 'Timer', TriggerName: 'keepWarmTrigger' }, {});

    expect(res.success).toBe(true);
    // 2026-10-23 新增 getRescueLogs / manageRescueLogs，名单从 21 增至 23
    expect(cloud.callFunction).toHaveBeenCalledTimes(20);
    // 逐条上报不能因为分批并发而丢项
    expect(res.data.results).toHaveLength(20);
    expect(res.data.results.every(r => r.status === 'ok')).toBe(true);
  });

  // 性能回归（2026-10-14）：管理端入口 pages/admin/admin 的页面切换耗时均值 3758ms，
  // 显著高于站内其他页面（90~200ms）。该页 onLoad 串行 await「云端鉴权 → 统计」两个
  // 低频云函数，此前都不在预热名单里 → 每次进后台都要各付一次冷启动。
  test('管理端两个入口函数在预热名单里（防回归：曾被漏掉导致进后台必冷启动）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name);
    expect(warmed).toEqual(expect.arrayContaining(['checkAdminStatus', 'getAdminStats']));
  });

  // 第二批扩容（2026-10-15）：低频但「点进去就等」的页面入口。
  test('第二批低频页面入口在预热名单里（报告页 / 相遇日历 / 榜单 / 管理端子页）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name);
    expect(warmed).toEqual(expect.arrayContaining([
      'getMeetCalendar', 'getMyMeets', 'getCatRank',
      'getMeetRank', 'getFavRank', 'getOperationLogs', 'manageAdmin'
    ]));
  });

  // 第三批（2026-10-18 云函数慢日志复盘）：前两批补的都是低频入口，反而把
  // 「用户每次打开都要等」的主路径函数漏在名单外。线上证据：getCatDetail 2475ms
  // （函数内只有一次 doc().get()，热态 20~80ms，只能是冷启动）、getPhotosByCat 1107ms。
  test('详情页/相册页主路径函数在预热名单里（防回归：名单曾只覆盖低频入口）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name);
    expect(warmed).toEqual(expect.arrayContaining([
      'getCatDetail', 'getPhotosByCat', 'getAlbumsWithInfo'
    ]));
  });

  // 反向约束：recordView 有写库副作用，无 OPENID 的预热调用会写入空 openid 的浏览记录。
  // 这条断言是为了挡住「顺手把主路径上的函数都加进去」这种改法。
  test('recordView 不得进入预热名单（预热调用无 OPENID，会写入脏浏览记录）', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name);
    expect(warmed).not.toContain('recordView');
  });

  // 2026-10-18：猫咪行动分析（超管专属）。打开即全扫、只在管理端低频出现，
  // 是最典型的「点进去就等」入口；预热调用无 OPENID，在 checkAdmin 处立即返回。
  test('猫咪行动分析入口在预热名单里', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name);
    expect(warmed).toContain('getCatActivity');
  });

  // 分批并发不能把「名单里的函数」漏掉或重复（名单长度与并发度不整除时最容易出错）
  test('预热项与名单一一对应，无遗漏无重复', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' });
    cloud.callFunction.mockClear();
    cloud.callFunction.mockResolvedValue({ result: { success: true } });

    const res = await main({}, {});

    const warmed = cloud.callFunction.mock.calls.map(call => call[0].name).sort();
    const reported = res.data.results.map(r => r.name).sort();
    expect(warmed).toEqual(reported);
    expect(new Set(warmed).size).toBe(warmed.length);   // 无重复
  });
});
