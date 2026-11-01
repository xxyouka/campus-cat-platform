/**
 * 回归：getCatsByIds —— 「我的关注」列表的数据来源
 *
 * 该云函数是收藏页唯一的数据通路：detail 页关注后只写本地 storage +
 * syncFavorites 云端；收藏页展示时必须靠本函数把 catId 换回完整猫咪对象。
 * 一旦它返回空，关注数会显示正常（读本地 storage）但**列表全空** ——
 * 正是「消息通知里能看到已关注的猫被相遇，但关注列表看不到」的现象。
 */
jest.mock('wx-server-sdk');

const CAT_ID_A = 'a'.repeat(24);


function createFakeDb(cats) {
  const makeQuery = () => {
    const q = {
      where: jest.fn(() => q),
      field: jest.fn(() => q),
      get: jest.fn(() => Promise.resolve({ data: cats }))
    };
    return q;
  };
  return {
    collection: jest.fn(() => makeQuery()),
    command: {
      in: jest.fn(v => ({ __in: v })),
      neq: jest.fn(v => ({ __neq: v }))
    }
  };
}

describe('getCatsByIds 云函数', () => {
  let cloud;
  let main;

  beforeEach(() => {
    jest.resetModules();
    cloud = require('wx-server-sdk');
    if (cloud.__restoreDatabase) cloud.__restoreDatabase();
    const auth = require('../../cloudfunctions/getCatsByIds/utils/auth');
    auth.checkAdmin = jest.fn();
  });

  test('按 ID 返回猫咪，剔除 _openid 防止泄露建档人', async () => {
    cloud.database.mockReturnValue(createFakeDb([
      { _id: CAT_ID_A, name: '小Y', avatar: 'cloud://x', _openid: 'someone-private' }
    ]));
    main = require('../../cloudfunctions/getCatsByIds/index').main;

    const res = await main({ ids: [CAT_ID_A] });
    expect(res.success).toBe(true);
    expect(res.data.cats).toHaveLength(1);
    expect(res.data.cats[0].name).toBe('小Y');
    // 关键：_openid 必须被剔除
    expect(res.data.cats[0]._openid).toBeUndefined();
  });

  test('过滤非十六进制格式的 ID（非法 ID 不应拖垮整批查询）', async () => {
    cloud.database.mockReturnValue(createFakeDb([]));
    main = require('../../cloudfunctions/getCatsByIds/index').main;

    const res = await main({ ids: ['not-a-valid-id', CAT_ID_A] });
    expect(res.success).toBe(true);
    // 仍然应只查合法 ID
    expect(res.data.cats).toEqual([]);
  });

  test('ids 为空时报错而不是静默返回空', async () => {
    cloud.database.mockReturnValue(createFakeDb([]));
    main = require('../../cloudfunctions/getCatsByIds/index').main;

    const res = await main({ ids: [] });
    expect(res.success).toBe(false);
  });

  test('拒绝超过单次请求上限的 ID，避免无界数据库批次', async () => {
    const db = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCatsByIds/index').main;

    const res = await main({ ids: Array(501).fill(CAT_ID_A) });

    expect(res.success).toBe(false);
    expect(res.error).toContain('最多查询 500');
    expect(db.collection).not.toHaveBeenCalled();
  });

  test('ids 全非法时返回空数组且不查库', async () => {
    const db = createFakeDb([]);
    cloud.database.mockReturnValue(db);
    main = require('../../cloudfunctions/getCatsByIds/index').main;

    const res = await main({ ids: ['xxx', 'yyy'] });
    expect(res.success).toBe(true);
    expect(res.data.cats).toEqual([]);
    expect(db.collection).not.toHaveBeenCalled();
  });
});
