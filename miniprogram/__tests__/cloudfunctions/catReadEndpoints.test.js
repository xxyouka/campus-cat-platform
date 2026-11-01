/**
 * __tests__/cloudfunctions/catReadEndpoints.test.js
 *
 * cats 有三个「无鉴权、整文档下发」的读取出口：getCatDetail / getShareData / getCatsByIds。
 * 它们在返回前必须剔除 _openid。
 *
 * 为什么这是泄露而不是洁癖：
 *   - addCat 过去显式写入 `_openid: OPENID`，而 addCat 仅管理员可调 —— 写进去的是**管理员**的 openid；
 *   - cats 是所有人可读的公开集合，这三个接口又都不校验调用者身份；
 *   - 于是任何微信用户一次调用就能拿到管理员 openid（且因为是云函数，绕过数据库权限规则）；
 *   - 该字段全端零引用、无任何按 cats._openid 的查询，剔除无副作用。
 *
 * 这里每条断言都是双向的，缺一不可：
 *   喂进去的文档必须**确实带** _openid（否则断言是空的），
 *   返回值里的业务字段必须**照常存在**（否则「不含 _openid」可能只是返回值被掏空了）。
 */

const CAT_ID = 'a'.repeat(24); // 通过这些函数入口的 /^[a-fA-F0-9]{20,40}$/ 校验

/** 存量文档的真实形态：管理员 openid 就躺在里面 */
const makeCatDoc = () => ({
  _id: CAT_ID,
  name: '小橘',
  campus: '本部',
  photos: [],
  _openid: 'admin-openid-xxx',
  _deleting: false,
  _deleteStartTime: null
});

/**
 * 按三个出口用到的查询形态装配 db。
 * @param {object}   docData   .doc(id).get() 返回的单文档
 * @param {object[]} whereData .where(...).get() 返回的数组
 * @param {object[]} photos    photos 集合（getShareData 用）
 * @param {Error}    docError  让 .doc(id).get() 以此错误 reject（SDK 的 throwOnNotFound 形态）
 */
function installDb({ docData, whereData = [], photos = [], total = null, docError = null }) {
  const mockCloud = require('wx-server-sdk');

  const docGet = docError
    ? jest.fn(() => Promise.reject(docError))
    : jest.fn(() => Promise.resolve({ data: docData }));

  // 记录 cats 查询链上的 orderBy 参数：列表排序字段契约（listSort 降序）需要
  // 断言「查询真的下发了哪个字段」，只看返回值无法区分排序字段写的是哪个
  const catsOrderByCalls = [];

  const catsCollection = {
    doc: jest.fn(() => ({ get: docGet })),
    where: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ data: whereData })),
      count: jest.fn(() => Promise.resolve({ total: total === null ? whereData.length : total })),
      orderBy: jest.fn((field, dir) => {
        catsOrderByCalls.push({ field, dir });
        return {
          skip: jest.fn(() => ({
            limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: whereData })) }))
          }))
        };
      })
    }))
  };
  const photosCollection = {
    where: jest.fn(() => ({
      orderBy: jest.fn(() => ({
        limit: jest.fn(() => ({ get: jest.fn(() => Promise.resolve({ data: photos })) }))
      }))
    }))
  };

  mockCloud.database.mockReturnValue({
    collection: jest.fn(name => name === 'photos' ? photosCollection : catsCollection),
    command: { in: jest.fn(v => v), neq: jest.fn(v => v) }
  });

  return { catsCollection, photosCollection, catsOrderByCalls };
}

describe('cats 读取出口不得下发 _openid', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    // database 的覆盖是进程级缓存的，不还原会污染后续测试文件
    require('wx-server-sdk').__restoreDatabase();
  });

  describe('getCatDetail', () => {
    test('返回的 cat 不含 _openid，且业务字段照常返回', async () => {
      const doc = makeCatDoc();
      // 防空断言：喂进去的文档确实带 _openid，否则「不含」毫无意义
      expect(doc._openid).toBe('admin-openid-xxx');

      installDb({ docData: doc });

      const getCatDetail = require('../../cloudfunctions/getCatDetail/index');
      const res = await getCatDetail.main({ catId: CAT_ID }, {});

      expect(res.success).toBe(true);
      // 业务字段必须在：证明返回值没有被整个掏空
      expect(res.data.cat.name).toBe('小橘');
      expect(res.data.cat.campus).toBe('本部');
      expect(res.data.cat._id).toBe(CAT_ID);

      expect(res.data.cat).not.toHaveProperty('_openid');
      expect(Object.keys(res.data.cat)).not.toContain('_openid');
    });

    test('多步删除的内部标记同样被剔除（与 _openid 同一条出口）', async () => {
      const doc = { ...makeCatDoc(), _deleting: false, _deleteStartTime: 1700000000000 };
      installDb({ docData: doc });

      const getCatDetail = require('../../cloudfunctions/getCatDetail/index');
      const res = await getCatDetail.main({ catId: CAT_ID }, {});

      expect(res.data.cat).not.toHaveProperty('_deleting');
      expect(res.data.cat).not.toHaveProperty('_deleteStartTime');
      expect(res.data.cat).not.toHaveProperty('_openid');
    });

    test('删除中的猫咪仍视为不存在（_deleting 判定未受影响）', async () => {
      installDb({ docData: { ...makeCatDoc(), _deleting: true } });

      const getCatDetail = require('../../cloudfunctions/getCatDetail/index');
      const res = await getCatDetail.main({ catId: CAT_ID }, {});

      expect(res.success).toBe(false);
      expect(res.error).toContain('不存在');
    });
  });

  describe('getShareData', () => {
    test('返回的 cat 不含 _openid，照片与业务字段照常返回', async () => {
      const doc = makeCatDoc();
      expect(doc._openid).toBe('admin-openid-xxx'); // 防空

      installDb({
        docData: doc,
        photos: [{ _id: 'p1', catId: CAT_ID, cloudID: 'cloud://x/1.jpg' }]
      });

      const getShareData = require('../../cloudfunctions/getShareData/index');
      const res = await getShareData.main({ catId: CAT_ID }, {});

      expect(res.success).toBe(true);
      expect(res.data.cat.name).toBe('小橘');
      expect(res.data.photos).toHaveLength(1);

      expect(res.data.cat).not.toHaveProperty('_openid');
    });

    // BE-2（2026-10-11）：分享页此前既不过滤 _deleting、也不剔另两个内部字段，
    // 与 getCatDetail/filterCats 的可见性口径矛盾 —— 删除窗口内「列表看不到、分享能打开」。
    test('BE-2：删除中的猫视为不存在；未删除的猫三个内部字段都不下发', async () => {
      // ① 删除中的猫：分享链接必须打不开（对齐 getCatDetail 的 NOT_FOUND）
      installDb({ docData: { ...makeCatDoc(), _deleting: true } });
      const denied = await require('../../cloudfunctions/getShareData/index').main({ catId: CAT_ID }, {});
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('不存在');

      // ② 未删除的猫：三个内部字段一个都不能下发（防空：输入文档确实带这三个字段）
      jest.resetModules();
      require('wx-server-sdk').__restoreDatabase();
      const doc = { ...makeCatDoc(), _deleting: false, _deleteStartTime: 1700000000000 };
      expect(doc._openid).toBe('admin-openid-xxx');
      expect(doc._deleteStartTime).toBe(1700000000000);
      installDb({ docData: doc, photos: [{ _id: 'p1', catId: CAT_ID }] });

      const res = await require('../../cloudfunctions/getShareData/index').main({ catId: CAT_ID }, {});
      expect(res.success).toBe(true);
      // 业务字段照常返回，证明不是靠掏空返回值来「消除」内部字段
      expect(res.data.cat.name).toBe('小橘');
      expect(res.data.photos).toHaveLength(1);
      expect(res.data.cat).not.toHaveProperty('_openid');
      expect(res.data.cat).not.toHaveProperty('_deleting');
      expect(res.data.cat).not.toHaveProperty('_deleteStartTime');
    });

    // 覆盖率补齐 + 语义锁定：getShareData 里那段
    // 「doc().get() 在文档不存在时直接 reject（throwOnNotFound）→ 映射为 null → 统一 NOT_FOUND」
    // 的处理器此前从未被执行过 —— 全仓只有成功路径的 doc().get()，函数覆盖率卡在 50%。
    // 两条用例分别锁住它的两个分支：认得出的「不存在」要转 NOT_FOUND，
    // 认不出的错误必须原样上抛（不得把网络故障说成「猫咪不存在」）。
    test('SDK 以「文档不存在」reject 时映射为 NOT_FOUND（不是抛给用户看）', async () => {
      installDb({
        docError: new Error(`document with _id ${CAT_ID} does not exist`),
        photos: []
      });

      const res = await require('../../cloudfunctions/getShareData/index').main({ catId: CAT_ID }, {});

      expect(res.success).toBe(false);
      expect(res.error).toContain('不存在');
    });

    test('非「不存在」的读取错误走通用失败（不得冒充 NOT_FOUND）', async () => {
      installDb({ docError: new Error('connection timeout'), photos: [] });

      const res = await require('../../cloudfunctions/getShareData/index').main({ catId: CAT_ID }, {});

      expect(res.success).toBe(false);
      expect(res.error).toContain('获取分享数据失败');
      expect(res.error).not.toContain('不存在');
    });
  });

  describe('getCatsByIds', () => {
    test('批量返回的每只猫都不含 _openid，且数量与业务字段不变', async () => {
      const docs = [
        { ...makeCatDoc(), _id: 'a'.repeat(24) },
        { ...makeCatDoc(), _id: 'b'.repeat(24), name: '大橘', _openid: 'admin-openid-yyy' }
      ];
      // 防空断言：两条输入都确实带 _openid
      expect(docs.every(d => d._openid)).toBe(true);

      installDb({ docData: null, whereData: docs });

      const getCatsByIds = require('../../cloudfunctions/getCatsByIds/index');
      const res = await getCatsByIds.main({ ids: ['a'.repeat(24), 'b'.repeat(24)] }, {});

      expect(res.success).toBe(true);
      // 数量必须在：证明没有把文档整条丢掉来「消除」_openid
      expect(res.data.cats).toHaveLength(2);
      expect(res.data.cats[0].name).toBe('小橘');
      expect(res.data.cats[1].name).toBe('大橘');

      for (const cat of res.data.cats) {
        expect(cat).not.toHaveProperty('_openid');
        // BE-3（2026-10-11）：三个内部字段全剔，与 getCatDetail 同口径。
        // makeCatDoc 确实带 _deleting:false / _deleteStartTime:null，故断言非空转
        expect(cat).not.toHaveProperty('_deleting');
        expect(cat).not.toHaveProperty('_deleteStartTime');
      }
      expect(res.data.cats.map(c => c._id)).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    });
  });

  // filterCats 是这四个出口里唯一「客户端筛选路径直接调用」的（utils/filterService.js:179），
  // 也是最初被漏掉的一个：它不 require auth.js、无 checkAdmin、无 .field() 投影。
  describe('filterCats', () => {
    test('筛选结果里的每只猫都不含 _openid，总数照常返回', async () => {
      const docs = [
        { ...makeCatDoc(), _id: 'a'.repeat(24) },
        { ...makeCatDoc(), _id: 'b'.repeat(24), name: '大橘', _openid: 'admin-openid-yyy' }
      ];
      expect(docs.every(d => d._openid)).toBe(true); // 防空

      installDb({ docData: null, whereData: docs, total: 42 });

      const filterCats = require('../../cloudfunctions/filterCats/index');
      const res = await filterCats.main({ filters: {} }, {});

      expect(res.success).toBe(true);
      // 条数与总数必须在：证明没有靠丢掉文档来「消除」_openid
      expect(res.data.cats).toHaveLength(2);
      expect(res.data.total).toBe(42);
      expect(res.data.cats[0].name).toBe('小橘');
      expect(res.data.cats[1].name).toBe('大橘');

      for (const cat of res.data.cats) {
        expect(cat).not.toHaveProperty('_openid');
        // BE-3（2026-10-11）：同 getCatDetail/getCatsByIds，_deleting/_deleteStartTime 一并剔除
        expect(cat).not.toHaveProperty('_deleting');
        expect(cat).not.toHaveProperty('_deleteStartTime');
      }
    });

    test('列表查询按 listSort 降序（在校+走失 → 离世 → 领养垫底）', async () => {
      // 排序字段由服务端写库时维护（cloudfunctions/utils/listSort.js）。
      // 原先按 updateTime 降序：改状态/编辑会把猫顶到最前，与被领养「沉底」的口径相反。
      const { catsOrderByCalls } = installDb({ docData: null, whereData: [], total: 0 });

      const filterCats = require('../../cloudfunctions/filterCats/index');
      const res = await filterCats.main({ filters: {} }, {});

      expect(res.success).toBe(true);
      expect(catsOrderByCalls).toContainEqual({ field: 'listSort', dir: 'desc' });
    });
  });
});
