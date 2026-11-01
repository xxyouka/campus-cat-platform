/**
 * __tests__/cloudfunctions/getCatActivity.test.js
 *
 * 猫咪行动分析（管理端 · 仅超级管理员）的入口回归。锁五件事：
 *   1. 双层鉴权：非管理员 / 普通管理员一律拒绝，且**不触发任何扫描**；
 *   2. 扫描口径：第二页的游标条件必须与 catId / meetTime 窗口**合并进同一个 where**
 *      —— wx-server-sdk 的 where 是整体替换，第二页丢条件会把全站打卡并进这只猫；
 *      扫描截断要如实上报 truncated，不能静默当全量；
 *   3. 聚合契约：totals / blocks / weekdays / locations / tags / points / recent /
 *      lastPoint 的关键字段（页面与轨迹图都直接吃这些字段）；
 *   4. 预热与缓存：_keepWarm 早退不打库；同一 (catId, rangeDays) 60 秒内不重复扫描，
 *      换一只猫要重新扫；
 *   5. 总轨迹（scope='all'）：按猫分组与逐猫点位上限、**倒序**扫描（截断时保住
 *      最近一段）、猫档案分片补齐并剔除已删除、与单猫模式缓存键互不干扰。
 */
jest.mock('wx-server-sdk');

// node-cache 只装在云函数自己的 node_modules 里（根仓库没有），
// 这里用同接口的内存缓存桩替换：既能验证「同键不重复扫描」，
// 又不用把 TTL 行为（node-cache 自己的职责）拉进本文件。
const mockCacheStore = new Map();
jest.mock('../../cloudfunctions/getCatActivity/utils/cache', () => ({
  getOrSet: jest.fn(async (key, loader) => {
    if (mockCacheStore.has(key)) return mockCacheStore.get(key);
    const value = await loader();
    mockCacheStore.set(key, value);
    return value;
  })
}));

/** 24 位十六进制，符合入口的 CAT_ID_PATTERN */
const CAT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_CAT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** 北京时间某天某时 → 时间戳（容器时区不确定，测试里显式用 UTC+8 构造） */
function beijingTs(y, m, d, h, min = 0) {
  return Date.UTC(y, m - 1, d, h - 8, min);
}

/** 造一条相遇记录（默认「校园内」+ 默认标签，语义等同没填） */
function makeMeet(id, meetTime, extra = {}) {
  return { _id: id, meetTime, location: '校园内', statusTag: '相遇了', ...extra };
}

/** 补零的十六进制 _id：游标比较是字符串序，必须等长 */
function meetId(n) {
  return `f${String(n).padStart(8, '0')}`;
}

/**
 * 装配 db 桩并加载入口。
 * @param {object} opts
 * @param {object|null} opts.adminDoc  admins 查到的文档（null = 不是管理员）
 * @param {object|null} opts.catDoc    cats doc().get() 返回（null = 文档不存在）
 * @param {Array}  opts.meets           recordMeet 全量记录（按 _id 升序给）
 * @param {boolean} opts.meetQueryError 扫描直接抛错（模拟数据库异常）
 */
function setup(opts = {}) {
  jest.resetModules();
  mockCacheStore.clear();
  const cloud = require('wx-server-sdk');
  if (cloud.__restoreDatabase) cloud.__restoreDatabase();

  const state = {
    // 默认超管：最常见的路径
    adminDoc: 'adminDoc' in opts ? opts.adminDoc : { role: 'superadmin', openid: 'test-openid' },
    catDoc: 'catDoc' in opts ? opts.catDoc : { name: '大橘', avatar: '', status: 'normal', campus: '本部' },
    // 总轨迹模式的猫档案表（_.in 分片查询用）；默认含一只猫
    catDocs: opts.catDocs || [{ _id: CAT_ID, name: '大橘', avatar: '', status: 'normal' }],
    meets: opts.meets || [],
    meetConditions: [],
    profileConditions: [],
    queriedCollections: []
  };

  /**
   * 游标分页桩：页大小由调用方 limit 决定，$gt（正序）/$lt（倒序）里带上一次的末条。
   * 倒序时先整体反转再切片 —— 与真实数据库 orderBy desc 的语义一致，
   * 这样「截断时保住的是最近一段」才有可断言的依据。
   */
  const pageOf = (cond, n, dir) => {
    const cur = cond._id || {};
    let rows = state.meets.filter((m) =>
      (cur.$gt === undefined || m._id > cur.$gt) &&
      (cur.$lt === undefined || m._id < cur.$lt));
    if (dir === 'desc') rows = rows.slice().reverse();
    return Promise.resolve({ data: rows.slice(0, n) });
  };

  const db = {
    command: {
      eq: (v) => ({ $eq: v }),
      gt: (v) => ({ $gt: v }),
      gte: (v) => ({ $gte: v }),
      lt: (v) => ({ $lt: v }),
      lte: (v) => ({ $lte: v }),
      in: (arr) => ({ $in: arr })
    },
    collection: jest.fn((name) => {
      state.queriedCollections.push(name);

      if (name === 'admins') {
        return {
          where: () => ({
            limit: () => ({
              get: () => Promise.resolve({ data: state.adminDoc ? [state.adminDoc] : [] })
            })
          })
        };
      }

      if (name === 'cats') {
        return {
          doc: () => ({
            get: () => {
              if (!state.catDoc) return Promise.reject(new Error('document does not exist'));
              return Promise.resolve({ data: state.catDoc });
            }
          }),
          // 总轨迹模式的档案补齐：按 _id.$in 过滤 + 链式 field/limit
          where: (cond) => {
            state.profileConditions.push(cond);
            const inList = cond._id && cond._id.$in;
            const ids = inList || [];
            const chain = {
              field: () => chain,
              limit: () => chain,
              get: () => Promise.resolve({ data: state.catDocs.filter((c) => ids.includes(c._id)) })
            };
            return chain;
          }
        };
      }

      if (name === 'recordMeet') {
        return {
          where: (cond) => {
            state.meetConditions.push(cond);
            const chain = {
              field: () => chain,
              orderBy: (field, dir) => { chain.__dir = dir; return chain; },
              limit: (n) => ({
                get: () => {
                  if (opts.meetQueryError) return Promise.reject(new Error('database unavailable'));
                  return pageOf(cond, n, chain.__dir);
                }
              })
            };
            return chain;
          }
        };
      }

      throw new Error(`未预期的集合：${name}`);
    })
  };

  cloud.database.mockImplementation(() => db);
  const fn = require('../../cloudfunctions/getCatActivity/index.js');
  return { fn, cloud, state };
}

describe('getCatActivity 入口', () => {
  test('_keepWarm 预热早退：直接成功返回，不鉴权也不打库', async () => {
    const { fn, state } = setup();
    const res = await fn.main({ _keepWarm: true }, {});
    expect(res).toEqual({ success: true, data: { _keepWarm: true }, message: '' });
    expect(state.queriedCollections).toEqual([]);
  });

  test('非管理员被拒，且不触发扫描', async () => {
    const { fn, state } = setup({ adminDoc: null });
    const res = await fn.main({ catId: CAT_ID }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无权限');
    expect(state.queriedCollections).toEqual(['admins']);
  });

  test('普通管理员未开通权限时被拒：服务端硬闸不依赖前端隐藏', async () => {
    const { fn, state } = setup({ adminDoc: { role: 'admin', openid: 'test-openid' } });
    const res = await fn.main({ catId: CAT_ID }, {});
    expect(res.success).toBe(false);
    expect(res.error).toBe('该账号未开通「查看猫咪行动分析」权限，请联系超级管理员开启');
    // 硬闸必须在扫描之前：普通管理员连一次 recordMeet 查询都不该产生
    expect(state.meetConditions).toHaveLength(0);
  });

  test('普通管理员被显式开通 catActivity 后放行', async () => {
    const { fn, state } = setup({
      adminDoc: { role: 'admin', openid: 'test-openid', permissions: ['catActivity'] }
    });
    const res = await fn.main({ catId: CAT_ID }, {});
    expect(res.success).toBe(true);
    expect(state.meetConditions.length).toBeGreaterThan(0);
  });

  test('catId 非法：参数无效，不打库', async () => {
    const { fn, state } = setup();
    const res = await fn.main({ catId: 'javascript:alert(1)' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toBe('参数无效');
    expect(state.meetConditions).toHaveLength(0);
  });

  test('猫咪不存在 / 已删除 → 明确文案（页面据此走「返回」而不是「重试」）', async () => {
    const gone = setup({ catDoc: null });
    const res1 = await gone.fn.main({ catId: CAT_ID }, {});
    expect(res1.success).toBe(false);
    expect(res1.error).toBe('猫咪不存在或已删除');

    const deleting = setup({ catDoc: { name: '大橘', _deleting: true } });
    const res2 = await deleting.fn.main({ catId: CAT_ID }, {});
    expect(res2.success).toBe(false);
    expect(res2.error).toBe('猫咪不存在或已删除');
  });

  test('游标翻页：第二页仍带 catId 与时间窗，且记录不重不漏', async () => {
    const meets = Array.from({ length: 1500 }, (_, i) => makeMeet(meetId(i), beijingTs(2026, 6, 1, 9) + i * 60000));
    const { fn, state } = setup({ meets });

    const res = await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    expect(res.success).toBe(true);
    expect(res.data.totals.meets).toBe(1500);
    expect(res.data.range.scanned).toBe(1500);
    expect(res.data.range.truncated).toBe(false);

    // 1000 + 500 两页；第二页把游标**合并**进原条件，而不是覆盖
    expect(state.meetConditions).toHaveLength(2);
    const second = state.meetConditions[1];
    expect(second.catId).toBe(CAT_ID);
    expect(second.meetTime.$gte).toBeGreaterThan(0);
    expect(second._id.$gt).toBe(meets[999]._id);
    // 每页都必须带上 catId（丢条件会把全站打卡并进来）
    expect(state.meetConditions[0].catId).toBe(CAT_ID);
  });

  test('时间窗：30 天带下界、全部不带、非法值回落 90 天', async () => {
    const meets = [makeMeet(meetId(1), Date.now() - 3600000)];
    const { fn, state } = setup({ meets });

    await fn.main({ catId: CAT_ID, rangeDays: 30 }, {});
    expect(state.meetConditions[0].meetTime.$gte).toBeGreaterThan(Date.now() - 31 * 86400000);

    await fn.main({ catId: CAT_ID, rangeDays: 0 }, {});
    expect(state.meetConditions[1].meetTime).toBeUndefined();

    await fn.main({ catId: CAT_ID, rangeDays: 7 }, {});
    const days7 = state.meetConditions[2];
    expect(days7.meetTime.$gte).toBeLessThan(Date.now() - 89 * 86400000);
  });

  test('扫描截断：超过硬顶时明示 truncated，不假装是全量', async () => {
    const meets = Array.from({ length: 5600 }, (_, i) => makeMeet(meetId(i), beijingTs(2026, 6, 1, 9) + i * 1000));
    const { fn } = setup({ meets });

    const res = await fn.main({ catId: CAT_ID, rangeDays: 0 }, {});
    expect(res.success).toBe(true);
    expect(res.data.range.truncated).toBe(true);
    expect(res.data.range.scanned).toBe(5000);
    expect(res.data.range.maxScan).toBe(5000);
    expect(res.data.totals.meets).toBe(5000);
  });

  test('聚合契约：时段 / 星期 / 标签 / 地点 / 点位 / 最近一次 / recent', async () => {
    const t1 = beijingTs(2026, 6, 1, 9);   // 周一 上午
    const t2 = beijingTs(2026, 6, 1, 18);  // 周一 傍晚
    const t3 = beijingTs(2026, 6, 2, 2);   // 周二 深夜
    const meets = [
      // 标签用码位转义写：历史数据里带 emoji 前缀（✨/✏️ 这类），页面要能剥掉；
      // 直接写字面 emoji 会被 scripts/check-ui-emoji.js 拦下（源码里不许出现 emoji）
      makeMeet(meetId(1), t1, { statusTag: '\u{1F63A} 相遇了', point: { u: 0.5, v: 0.5 } }),
      makeMeet(meetId(2), t2, { location: '食堂旁', statusTag: '', point: { u: 0.51, v: 0.5 } }),
      makeMeet(meetId(3), t3, { location: '食堂旁', statusTag: '\u270F\uFE0F 在开会', point: { u: 0.49, v: 0.51 } })
    ];
    const { fn } = setup({ meets });

    const res = await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    const data = res.data;

    // 猫档案与窗口
    expect(data.cat).toMatchObject({ id: CAT_ID, name: '大橘', campus: '本部' });
    expect(data.range).toMatchObject({ days: 90, scanned: 3, truncated: false });

    // 样本量：默认「校园内」不算具体地点，但要计入 defaultLocation
    expect(data.totals).toMatchObject({
      meets: 3,
      withLocation: 2,
      withPoint: 3,
      withTag: 2,
      defaultLocation: 1,
      activeDays: 2,
      firstTime: t1,
      lastTime: t3
    });

    // 时段：固定六段，值是北京时间折算
    const block = (key) => data.blocks.find((b) => b.key === key);
    expect(data.blocks.map((b) => b.key)).toEqual(['dawn', 'morning', 'afternoon', 'dusk', 'evening', 'night']);
    expect(block('morning').count).toBe(1);
    expect(block('dusk').count).toBe(1);
    expect(block('night').count).toBe(1);
    expect(block('dawn').count).toBe(0);

    // 星期：固定 7 项（周一 → 周日）
    expect(data.weekdays).toHaveLength(7);
    expect(data.weekdays[0]).toEqual({ d: 1, count: 2 });
    expect(data.weekdays[1]).toEqual({ d: 2, count: 1 });

    // 标签：历史 emoji 前缀被剥掉，同一含义不拆行
    expect(data.tags.map((t) => t.text)).toEqual(['相遇了', '在开会']);

    // 地点榜：只有填了具体地点的进榜，默认值不进
    expect(data.locations).toEqual([{ text: '食堂旁', count: 2, ratio: 0.667 }]);

    // 点位：时间升序，最后一个是「最近一次」
    expect(data.points.total).toBe(3);
    expect(data.points.sampled).toBe(false);
    expect(data.points.items.map((p) => p.t)).toEqual([t1, t2, t3]);
    expect(data.lastPoint).toEqual({ u: 0.49, v: 0.51, t: t3 });

    // 三个点聚在一起 → 一个聚集圈
    expect(data.clusters).toHaveLength(1);
    expect(data.clusters[0].count).toBe(3);

    // 离散度：三个点都算得出重心
    expect(data.spread.p90).toBeGreaterThan(0);

    // 时间线：最近在前，且带上点位（页面据此高亮地图）
    expect(data.recent).toHaveLength(3);
    expect(data.recent[0]).toMatchObject({ t: t3, location: '食堂旁', tag: '在开会', u: 0.49, v: 0.51 });
    expect(data.recent[2]).toMatchObject({ t: t1, u: 0.5, v: 0.5 });
  });

  test('历史默认值「校园里」也归为没填，不会冒充地点进榜', async () => {
    const t = beijingTs(2026, 6, 1, 9);
    const { fn } = setup({ meets: [makeMeet(meetId(1), t, { location: '校园里' })] });

    const res = await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    const data = res.data;

    expect(data.totals.withLocation).toBe(0);
    expect(data.totals.defaultLocation).toBe(1);
    expect(data.locations).toEqual([]);
  });

  test('同一 (猫, 窗口) 60 秒内命中缓存；换一只猫要重新扫', async () => {
    const meets = [makeMeet(meetId(1), beijingTs(2026, 6, 1, 9))];
    const { fn, state } = setup({ meets });

    await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    expect(state.meetConditions).toHaveLength(1);

    await fn.main({ catId: OTHER_CAT_ID, rangeDays: 90 }, {});
    expect(state.meetConditions).toHaveLength(2);
  });

  test('HTTP 触发器入参（body 字符串）同样生效', async () => {
    const { fn, state } = setup({ meets: [makeMeet(meetId(1), beijingTs(2026, 6, 1, 9))] });

    const res = await fn.main({ body: JSON.stringify({ catId: CAT_ID, rangeDays: 30 }) }, {});
    expect(res.success).toBe(true);
    expect(state.meetConditions[0].catId).toBe(CAT_ID);
    expect(state.meetConditions[0].meetTime.$gte).toBeGreaterThan(0);
  });

  test('扫描异常 → 统一失败文案，不把数据库细节抛给前端', async () => {
    const { fn } = setup({ meetQueryError: true });
    const res = await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
    expect(res.success).toBe(false);
    expect(res.error).toBe('获取猫咪行动分析失败，请稍后重试');
  });

  describe('总轨迹（scope=all）', () => {
    const GONE_ID = '111111111111111111111111';
    const GHOST_ID = '222222222222222222222222';
    const SILENT_ID = 'cccccccccccccccccccccccc';

    /** 造一条带地图点位的相遇记录 */
    function trailMeet(id, catId, meetTime, u, v) {
      return makeMeet(id, meetTime, { catId, point: { u, v } });
    }

    test('按猫分组：没有点位的猫不上图，猫档案从 cats 分片补齐', async () => {
      const t1 = beijingTs(2026, 6, 1, 9);
      const t2 = beijingTs(2026, 6, 1, 12);
      const t3 = beijingTs(2026, 6, 2, 9);
      const meets = [
        trailMeet(meetId(1), CAT_ID, t1, 0.2, 0.2),
        trailMeet(meetId(2), OTHER_CAT_ID, t2, 0.5, 0.5),
        // 有打卡但从没选过地图位置 → 画不上图，不是本图的对象
        makeMeet(meetId(3), t2, { catId: SILENT_ID }),
        trailMeet(meetId(4), CAT_ID, t3, 0.3, 0.25)
      ];
      const catDocs = [
        { _id: CAT_ID, name: '大橘', avatar: 'cloud://a.jpg', status: 'normal' },
        { _id: OTHER_CAT_ID, name: '小白', avatar: '', status: 'lost' },
        { _id: SILENT_ID, name: '三花', avatar: '', status: 'normal' }
      ];
      const { fn, state } = setup({ meets, catDocs });

      const res = await fn.main({ scope: 'all', rangeDays: 90 }, {});
      expect(res.success).toBe(true);
      const data = res.data;

      expect(data.scope).toBe('all');
      // 最近活跃的在前：大橘最后出现在 6-02，小白在 6-01
      expect(data.cats.map((c) => c.id)).toEqual([CAT_ID, OTHER_CAT_ID]);
      expect(data.cats[0]).toMatchObject({
        name: '大橘', avatar: 'cloud://a.jpg', status: 'normal', meets: 2, pointTotal: 2, sampled: false
      });
      // 点位时间升序（扫描是倒序来的，聚合层要重新排序）
      expect(data.cats[0].points.map((p) => p.t)).toEqual([t1, t3]);
      expect(data.cats[1]).toMatchObject({ name: '小白', meets: 1, pointTotal: 1 });

      // totals 如实汇报：meets 含没点位的记录（4 条），cats 只算有轨迹的
      expect(data.totals).toMatchObject({ meets: 4, cats: 2, points: 3, catsTruncated: false, returned: 2 });
      expect(data.range).toMatchObject({ days: 90, scanned: 4, truncated: false, maxScan: 10000, maxTrailPoints: 200 });
      // 档案查询只带图上这些猫，且是分片 $in
      expect(state.profileConditions[0]._id.$in).toEqual([CAT_ID, OTHER_CAT_ID]);
    });

    test('已删除 / 档案缺失的猫不上图（与单猫详情同口径）', async () => {
      const base = beijingTs(2026, 6, 1, 9);
      const meets = [
        trailMeet(meetId(1), CAT_ID, base, 0.2, 0.2),
        trailMeet(meetId(2), GONE_ID, base + 60000, 0.3, 0.3),
        trailMeet(meetId(3), GHOST_ID, base + 120000, 0.4, 0.4)
      ];
      const catDocs = [
        { _id: CAT_ID, name: '大橘', avatar: '', status: 'normal' },
        { _id: GONE_ID, name: '已删', avatar: '', status: 'normal', _deleting: true }
        // GHOST_ID 查不到档案
      ];
      const { fn } = setup({ meets, catDocs });

      const res = await fn.main({ scope: 'all', rangeDays: 90 }, {});
      expect(res.data.cats.map((c) => c.id)).toEqual([CAT_ID]);
      // 「实有几只」与「图上几只」分开报，脚注据此说明
      expect(res.data.totals).toMatchObject({ cats: 3, returned: 1 });
    });

    test('倒序扫描：截断时保住最近一段；每只猫最多 200 点且 sampled 如实标记', async () => {
      const base = beijingTs(2026, 6, 1, 0);
      const meets = Array.from({ length: 10150 }, (_, i) =>
        trailMeet(meetId(i), CAT_ID, base + i * 60000, 0.2, 0.2));
      const { fn, state } = setup({ meets });

      const res = await fn.main({ scope: 'all', rangeDays: 0 }, {});
      expect(res.data.range).toMatchObject({ truncated: true, scanned: 10000, maxScan: 10000 });
      // 第一页没有游标；第二页是 _id 下界（倒序游标），不是正序的 $gt
      expect(state.meetConditions[0]._id).toBeUndefined();
      expect(state.meetConditions[1]._id.$lt).toBe(meets[9150]._id);

      const cat = res.data.cats[0];
      expect(cat.pointTotal).toBe(10000);   // 扫到的 10000 条都带点位
      expect(cat.points).toHaveLength(200); // 画图上限
      expect(cat.sampled).toBe(true);
      // 保留的是**最近**的 200 个点：从第 9950 条（0-based）起
      expect(cat.points[0].t).toBe(base + 9950 * 60000);
      expect(cat.points[199].t).toBe(base + 10149 * 60000);
    });

    test('猫数上限 60：超出按最近活跃取前 60，catsTruncated 明示', async () => {
      const base = beijingTs(2026, 6, 1, 9);
      const ids = Array.from({ length: 65 }, (_, i) => String(i).padStart(24, '0'));
      const meets = ids.map((id, i) => trailMeet(meetId(i), id, base + i * 60000, 0.4, 0.4));
      const catDocs = ids.map((id, i) => ({ _id: id, name: `猫${i}`, avatar: '', status: 'normal' }));
      const { fn } = setup({ meets, catDocs });

      const res = await fn.main({ scope: 'all', rangeDays: 90 }, {});
      expect(res.data.totals).toMatchObject({ cats: 65, catsTruncated: true, returned: 60 });
      expect(res.data.cats).toHaveLength(60);
      // 最近出现的 60 只：猫64 … 猫5，猫4 及更早被截掉
      expect(res.data.cats[0].id).toBe(ids[64]);
      expect(res.data.cats[59].id).toBe(ids[5]);
      expect(res.data.cats.some((c) => c.id === ids[4])).toBe(false);
    });

    test('缓存：同一窗口第二次命中；与单猫模式的缓存键互不干扰', async () => {
      const meets = [trailMeet(meetId(1), CAT_ID, beijingTs(2026, 6, 1, 9), 0.2, 0.2)];
      const { fn, state } = setup({ meets });

      await fn.main({ scope: 'all', rangeDays: 90 }, {});
      await fn.main({ scope: 'all', rangeDays: 90 }, {});
      expect(state.meetConditions).toHaveLength(1);

      // 同一个 60s 窗口内单猫模式仍要自己扫一遍（缓存键含 catId）
      await fn.main({ catId: CAT_ID, rangeDays: 90 }, {});
      expect(state.meetConditions).toHaveLength(2);
    });

    test('时间窗：30 天带下界，白名单外的值回落 90 天', async () => {
      const meets = [trailMeet(meetId(1), CAT_ID, Date.now() - 3600000, 0.2, 0.2)];
      const { fn, state } = setup({ meets });

      await fn.main({ scope: 'all', rangeDays: 30 }, {});
      expect(state.meetConditions[0].meetTime.$gte).toBeGreaterThan(Date.now() - 31 * 86400000);
      expect(state.meetConditions[0].meetTime.$gte).toBeLessThan(Date.now() - 29 * 86400000);

      await fn.main({ scope: 'all', rangeDays: 7 }, {});
      expect(state.meetConditions[1].meetTime.$gte).toBeLessThan(Date.now() - 89 * 86400000);
    });

    test('普通管理员对 all 模式同样被硬闸拦下，且在扫描之前', async () => {
      const { fn, state } = setup({ adminDoc: { role: 'admin', openid: 'test-openid' } });

      const res = await fn.main({ scope: 'all', rangeDays: 90 }, {});
      expect(res.success).toBe(false);
      expect(res.error).toBe('该账号未开通「查看猫咪行动分析」权限，请联系超级管理员开启');
      expect(state.meetConditions).toHaveLength(0);
    });
  });
});
