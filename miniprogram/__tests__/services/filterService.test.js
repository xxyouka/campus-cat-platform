/**
 * filterService.test.js - 猫咪筛选服务单元测试
 */

// Mock dependencies
jest.mock('../../utils/logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('../../utils/avatarHelper', () => ({
  resolveCatAvatars: jest.fn((cats) => Promise.resolve(cats.map(c => ({ ...c, avatar: 'resolved-url' }))))
}));

const mockOfflineCache = {
  getCats: jest.fn(() => null),
  saveCats: jest.fn()
};
jest.mock('../../utils/offlineCache', () => mockOfflineCache);

jest.mock('../../config', () => ({
  performance: {
    maxCatsLoadLimit: 500,
    queryTimeout: 5000
  }
}));

const FilterService = require('../../utils/filterService');

describe('FilterService', () => {
  let mockPageContext;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock page context
    mockPageContext = {
      _loadingAll: false,
      _photoCountsMap: {},
      _searchEngine: null,
      data: {
        searchKeyword: '',
        genderFilter: '',
        statusFilter: '',
        colorFilter: '',
        campusFilter: '',
        ageFilter: '',
        cats: [],
        filteredCats: [],
        filteredCatCount: 0,
        hasSearched: false
      },
      setData: jest.fn(),
      filterCats: jest.fn(),
      // 页面侧本地兜底筛选（index.js:_fallbackClientFilter），降级路径专用
      _fallbackClientFilter: jest.fn(),
      _buildSearchIndex: jest.fn(),
      _resolveAvatarsAsync: jest.fn(),
      _extractColorOptions: jest.fn(() => [])
    };
  });

  describe('filterFromServer', () => {
    it('should call cloud function with correct filters', async () => {
      const mockResult = {
        success: true,
        data: {
          cats: [{ _id: '1', name: '小白', campus: '东区' }],
          total: 1,
          hasMore: false
        }
      };

      wx.cloud.callFunction.mockResolvedValueOnce({ result: mockResult });

      mockPageContext.data.searchKeyword = '小白';
      mockPageContext.data.campusFilter = '东区';

      const result = await FilterService.filterFromServer(mockPageContext);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: {
          filters: {
            keyword: '小白',
            campus: '东区',
            page: 1,
            pageSize: 100
          }
        }
      });

      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
    });

    it('should fallback to loadAllAndFilter when cloud function fails', async () => {
      wx.cloud.callFunction.mockRejectedValueOnce(new Error('Cloud function error'));

      // Mock the database for loadAllAndFilter
      const mockDb = {
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: jest.fn(() => Promise.resolve({ data: [] }))
                }))
              }))
            }))
          }))
        }))
      };
      wx.cloud.database.mockReturnValueOnce(mockDb);

      await FilterService.filterFromServer(mockPageContext);

      expect(mockPageContext._loadingAll).toBe(false);
    });

    it('should terminate (no recursion) when cloud function keeps failing and local index has 0 hits', async () => {
      // F1 回归：服务端筛选持续失败 + 本地索引 0 命中时，降级路径曾以 fire-and-forget 方式
      // 重新进入 filterFromServer（loadAllAndFilter 里调用 pageContext.filterCats()），
      // 形成「失败 → 全量加载 → filterCats() → 再次失败 …」的无界异步递归。
      // 用 callFunction 计数直接证伪：递归存在时该计数会不受控增长。
      let callCount = 0;
      wx.cloud.callFunction.mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error('cloud function down'));
      });

      // 全量加载每轮都能拿到数据且永不抛错（递归若存在，每轮都会重新分页拉取），
      // 确保降级路径真的走到「应用筛选条件」这一步
      let fetchRound = 0;
      const mockGet = jest.fn(() => Promise.resolve({
        data: fetchRound++ === 0 ? [{ _id: '1', name: '小白', status: 'normal' }] : []
      }));

      // 注意用 mockReturnValue（非 Once）：递归复现需要无限次可用的 database()，
      // 因此这里给出完整 mock（含 command），避免影响后续用例的二次取用
      const mockDb = {
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({ get: mockGet }))
              }))
            }))
          }))
        })),
        command: { in: jest.fn(v => v), neq: jest.fn(v => v) }
      };
      wx.cloud.database.mockReturnValue(mockDb);

      // 本地搜索索引存在但 0 命中：降级不会被索引结果提前 return
      mockPageContext._searchEngine = { hasIndex: jest.fn(() => true) };
      mockPageContext._searchFromIndex = jest.fn(() => []);

      mockPageContext.data.searchKeyword = '小白';

      // 复刻页面 filterCats 的真实语义：重新发起服务端筛选（非 await 的 fire-and-forget）。
      // 上限 50 次只是防止测试自身失控；修复前会一路撞到上限。
      mockPageContext.filterCats = jest.fn(() => {
        if (mockPageContext.filterCats.mock.calls.length > 50) return undefined;
        return FilterService.filterFromServer(mockPageContext, '').catch(() => {});
      });

      // 直接对「降级全量加载」计数：比 callFunction 次数更贴近不变量。
      // 递归一旦存在（loadAllAndFilter 里回页面筛选入口），这里会 > 1，
      // 且即使递归只跑一轮（在第 2 层收敛）也照样变红——这是 callCount 上界给不出的保证。
      const loadAllSpy = jest.spyOn(FilterService, 'loadAllAndFilter');

      await FilterService.filterFromServer(mockPageContext, '');

      // 给嵌套调用若干轮事件循环机会：递归若存在，计数会持续增长
      await new Promise(resolve => setTimeout(resolve, 30));

      // 同一次筛选只允许触发一次降级全量加载
      expect(loadAllSpy).toHaveBeenCalledTimes(1);
      expect(callCount).toBe(1);
      // 降级产品行为保留：全量列表加载后把当前筛选条件应用到列表上
      expect(mockPageContext._fallbackClientFilter).toHaveBeenCalled();
    });

    it('discards the keyword response when a campus switch lands first (双向互斥)', async () => {
      // P1-1：关键词筛选在途时点校区 chip（loadCatsByCampus 自增 _filterSeq）。
      // 页面的 .then() 校验只能拦住页面自己发起的筛选，拦不住 filterFromServer 里的裸
      // setData —— 修复前关键词响应后到会覆盖校区视图，出现
      // 「校区 chip 高亮、列表是关键词结果」且无人纠正
      //
      // FE-1 之后校区加载本身也走 filterCats 云函数（与关键词同一条链路），
      // 所以这里按调用序区分两次请求：先挂起的是关键词，校区那次立即返回。
      let releaseKeyword;
      let calls = 0;
      wx.cloud.callFunction.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return new Promise(resolve => { releaseKeyword = resolve; });
        return Promise.resolve({
          result: { success: true, data: { cats: [{ _id: 'campusCat' }], total: 1, hasMore: false } }
        });
      });

      mockPageContext.data.searchKeyword = '小白';
      mockPageContext._filterSeq = 1; // 页面 filterCats() 已自增

      const keywordPromise = FilterService.filterFromServer(mockPageContext, '小白');
      await FilterService.loadCatsByCampus('东区', mockPageContext);

      releaseKeyword({
        result: { success: true, data: { cats: [{ _id: 'keywordCat' }], total: 1, hasMore: false } }
      });
      const result = await keywordPromise;

      expect(result).toBeNull();
      // 只落盘了校区视图，关键词结果整体丢弃
      const listWrites = mockPageContext.setData.mock.calls
        .map(c => c[0])
        .filter(u => u && u.filteredCats);
      expect(listWrites).toHaveLength(1);
      expect(listWrites[0].filteredCats[0]._id).toBe('campusCat');
    });

    it('does not degrade to a full reload when the failed request is already stale', async () => {
      // 过期请求的降级同样要丢弃：loadAllAndFilter 会整体覆写 cats/filteredCats
      //
      // FE-1 之后校区加载也走 filterCats（见上一条），因此这里同样是「两次云调用」：
      // 关键词那次挂起后失败，校区那次成功落盘。关键词的降级路径必须因为过期而被放弃，
      // 否则它会把校区视图冲成全量列表。
      let rejectKeyword;
      let calls = 0;
      wx.cloud.callFunction.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return new Promise((_, reject) => { rejectKeyword = reject; });
        return Promise.resolve({
          result: { success: true, data: { cats: [{ _id: 'campusCat' }], total: 1, hasMore: false } }
        });
      });

      mockPageContext._filterSeq = 1;
      const keywordPromise = FilterService.filterFromServer(mockPageContext, '小白');
      await FilterService.loadCatsByCampus('东区', mockPageContext);

      rejectKeyword(new Error('cloud function down'));
      const result = await keywordPromise;

      expect(result).toBeNull();
      // 只有校区视图落盘：关键词失败后的降级全量加载被 seq 判定为过期而丢弃
      const listWrites = mockPageContext.setData.mock.calls
        .map(c => c[0])
        .filter(u => u && u.filteredCats);
      expect(listWrites).toHaveLength(1);
      expect(listWrites[0].filteredCats[0]._id).toBe('campusCat');
      expect(wx.cloud.database).not.toHaveBeenCalled();
    });

    it('should still call when a previous load is in flight (page-level seq discards stale)', async () => {
      // 并发筛选不再静默早退：早退会让新筛选请求丢失、旧响应反而覆盖新筛选结果
      mockPageContext._loadingAll = true;

      await FilterService.filterFromServer(mockPageContext);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({ name: 'filterCats' }));
    });
  });

  describe('_executeFilterCall', () => {
    it('should map gender filter correctly', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 0 } }
      });

      mockPageContext.data.genderFilter = 'male';

      await FilterService._executeFilterCall(mockPageContext);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: {
          filters: {
            gender: '公',
            page: 1,
            pageSize: 100
          }
        }
      });
    });

    it('should map female gender filter correctly', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 0 } }
      });

      mockPageContext.data.genderFilter = 'female';

      await FilterService._executeFilterCall(mockPageContext);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: {
          filters: {
            gender: '母',
            page: 1,
            pageSize: 100
          }
        }
      });
    });

    it('should pass status filter through to cloud function', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 0 } }
      });

      mockPageContext.data.statusFilter = 'adopted';

      await FilterService._executeFilterCall(mockPageContext);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: {
          filters: {
            status: 'adopted',
            page: 1,
            pageSize: 100
          }
        }
      });
    });

    it('should throw error when cloud function returns failure', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: false, error: 'Query failed' }
      });

      await expect(FilterService._executeFilterCall(mockPageContext))
        .rejects.toThrow('Query failed');
    });

    it('should send explicit page number for pagination', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 0 } }
      });
      mockPageContext.data.searchKeyword = '小白';

      await FilterService._executeFilterCall(mockPageContext, '小白', 2);

      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: { filters: { keyword: '小白', page: 2, pageSize: 100 } }
      });
    });

    it('append 模式：第 2 页结果追加去重，落盘 hasMore=false', async () => {
      mockPageContext.data.searchKeyword = '小白';
      mockPageContext.data.filteredCats = [{ _id: '1', name: '小白' }];
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: {
          cats: [{ _id: '1', name: '小白' }, { _id: '2', name: '小小白' }],
          total: 2,
          hasMore: false
        } }
      });

      const result = await FilterService.filterFromServer(
        mockPageContext, '小白', { page: 2, append: true }
      );

      expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
        data: { filters: expect.objectContaining({ page: 2 }) }
      }));
      const write = mockPageContext.setData.mock.calls.find(c => c[0] && c[0].filteredCats)[0];
      expect(write.filteredCats.map(c => c._id)).toEqual(['1', '2']);
      expect(write.hasMore).toBe(false);
      expect(result.hasMore).toBe(false);
    });

    it('append 模式空页也必须关闭 hasMore（否则上拉反复请求同一页）', async () => {
      mockPageContext.data.searchKeyword = '小白';
      mockPageContext.data.filteredCats = [{ _id: '1', name: '小白' }];
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 1, hasMore: false } }
      });

      await FilterService.filterFromServer(
        mockPageContext, '小白', { page: 2, append: true }
      );

      const write = mockPageContext.setData.mock.calls.find(c => c[0] && c[0].filteredCats)[0];
      expect(write.filteredCats.map(c => c._id)).toEqual(['1']);
      expect(write.hasMore).toBe(false);
    });
  });

  describe('loadAllAndFilter', () => {
    it('should load cats in batches and apply filters', async () => {
      const mockCats = [
        { _id: '1', name: '小白', status: 'normal' },
        { _id: '2', name: '小黑', status: 'normal' }
      ];

      // Create a mock that returns cats on first call, empty on second
      const mockGet = jest.fn()
        .mockResolvedValueOnce({ data: mockCats })
        .mockResolvedValueOnce({ data: [] });

      const mockDb = {
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: mockGet
                }))
              }))
            }))
          }))
        }))
      };
      wx.cloud.database.mockReturnValueOnce(mockDb);

      await FilterService.loadAllAndFilter(mockPageContext);

      expect(mockPageContext._loadingAll).toBe(false);
    });

    it('降级全量加载按 listSort 降序（与首屏同一「领养垫底」口径）', async () => {
      // 排序字段由服务端维护（cloudfunctions/utils/listSort.js）：
      // 在校+走失 → 离世 → 被领养垫底。降级路径也必须下同一排序键，
      // 否则筛选失败降级后列表顺序会悄然变回「最近更新优先」。
      const orderByCalls = [];
      const mockGet = jest.fn()
        .mockResolvedValueOnce({ data: [{ _id: '1', name: '小白', status: 'normal' }] })
        .mockResolvedValue({ data: [] });

      const mockDb = {
        // mockReturnValueOnce 只够本项目第一次 wx.cloud.database() 取用（db 实例）；
        // withCatVisibility/getDbCmd 的两次取用会落到 setup.js 的默认桩（含共享 mockCommand）
        command: { in: jest.fn(v => v), neq: jest.fn(v => v) },
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn((field, dir) => {
              orderByCalls.push({ field, dir });
              return {
                skip: jest.fn(() => ({
                  limit: jest.fn(() => ({ get: mockGet }))
                }))
              };
            })
          }))
        }))
      };
      wx.cloud.database.mockReturnValueOnce(mockDb);

      await FilterService.loadAllAndFilter(mockPageContext);

      // 防盗空转：走的是成功路径（失败路径会弹「加载失败」而不是落盘缓存）
      expect(mockOfflineCache.saveCats).toHaveBeenCalled();
      expect(orderByCalls).toContainEqual({ field: 'listSort', dir: 'desc' });
    });

    it('should use offline cache when network fails', async () => {
      mockOfflineCache.getCats.mockReturnValueOnce([
        { _id: '1', name: '缓存猫咪' }
      ]);

      const mockDb = {
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: jest.fn(() => Promise.reject(new Error('Network error')))
                }))
              }))
            }))
          }))
        }))
      };
      wx.cloud.database.mockReturnValueOnce(mockDb);

      await FilterService.loadAllAndFilter(mockPageContext);

      expect(mockOfflineCache.getCats).toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
        title: '网络不佳，使用缓存数据'
      }));
    });

    it('should not load if already loading', async () => {
      mockPageContext._loadingAll = true;

      await FilterService.loadAllAndFilter(mockPageContext);

      expect(wx.cloud.database).not.toHaveBeenCalled();
    });
  });

  describe('_applyLocalFilter', () => {
    it('should set hasSearched when a keyword filter is active', () => {
      mockPageContext.data.searchKeyword = '不存在的主子';

      FilterService._applyLocalFilter(mockPageContext);

      expect(mockPageContext._fallbackClientFilter).toHaveBeenCalledWith('不存在的主子');
      // 与 index.js 的 filterCats() 同口径：只有存在筛选条件时才置位。
      // 「有关键词但 0 结果」时 index.wxml 的空态依赖 hasSearched
      expect(mockPageContext.setData).toHaveBeenCalledWith({ hasSearched: true });
    });

    it('should set hasSearched when only a non-keyword filter is active', () => {
      mockPageContext.data.genderFilter = 'female';

      FilterService._applyLocalFilter(mockPageContext);

      expect(mockPageContext._fallbackClientFilter).toHaveBeenCalledWith('');
      expect(mockPageContext.setData).toHaveBeenCalledWith({ hasSearched: true });
    });

    it('should not set hasSearched when no filter is active', () => {
      FilterService._applyLocalFilter(mockPageContext);

      expect(mockPageContext._fallbackClientFilter).toHaveBeenCalledWith('');
      expect(mockPageContext.setData).not.toHaveBeenCalledWith({ hasSearched: true });
    });

    it('should keep hasSearched for filters set via the fallback load path', async () => {
      // loadAllAndFilter 的分批加载 → _applyLocalFilter 降级链路
      const mockCats = [{ _id: '1', name: '小白', status: 'normal' }];
      const mockGet = jest.fn()
        .mockResolvedValueOnce({ data: mockCats })
        .mockResolvedValueOnce({ data: [] });

      const mockDb = {
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({ get: mockGet }))
              }))
            }))
          }))
        }))
      };
      wx.cloud.database.mockReturnValueOnce(mockDb);
      mockPageContext.data.searchKeyword = '小白';

      await FilterService.loadAllAndFilter(mockPageContext);

      expect(mockPageContext.setData).toHaveBeenCalledWith({ hasSearched: true });
    });
  });

  describe('loadCatsByCampus', () => {
    /**
     * FE-1（P1，2026-10-11 修）：校区筛选此前自己做「count + .limit(20)」的客户端直连查询，
     * 既不写 _filterPage 也不写 hasMore；而触底走 filterFromServer 是按 filters.page 递增的。
     * 两套分页契约混用 → 第 1 页交付第 1~20 条，第 2 页 skip=(2-1)*100=100 取第 101~200 条，
     * **第 21~100 条永远不会被交付**（用户看到「共 45 只」却只有 20 张卡）。
     *
     * 现在校区路径统一委托 filterFromServer，下面第一条就是防回潮的核心断言。
     */
    it('走服务端分页（filterCats），而不是客户端直连的固定 limit(20)', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: {
          success: true,
          data: {
            cats: [{ _id: 'campusCat', name: '本部猫', campus: '本部' }],
            total: 45,
            hasMore: true
          }
        }
      });

      await FilterService.loadCatsByCampus('本部', mockPageContext);

      // ① 分页契约统一：带 campus + page=1 + pageSize，并如实回写 hasMore/total
      expect(wx.cloud.callFunction).toHaveBeenCalledWith({
        name: 'filterCats',
        data: { filters: { campus: '本部', page: 1, pageSize: 100 } }
      });
      // ② 不再有任何客户端直连查询（那正是丢数据的来源）
      expect(wx.cloud.database).not.toHaveBeenCalled();

      // ③ hasMore 必须随结果落盘，否则触底不会翻页（旧的 .limit(20) 路径从不写它）
      const writes = mockPageContext.setData.mock.calls.map(c => c[0]);
      expect(writes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filteredCatCount: 45,
          hasMore: true,
          filteredCats: [expect.objectContaining({ _id: 'campusCat' })]
        })
      ]));
      expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({ hasSearched: true })]));
    });

    it('把选中的校区写回 data（filterFromServer 靠它组装 filters.campus）', async () => {
      wx.cloud.callFunction.mockResolvedValueOnce({
        result: { success: true, data: { cats: [], total: 0, hasMore: false } }
      });

      await FilterService.loadCatsByCampus('东区', mockPageContext);

      expect(mockPageContext.data.campusFilter).toBe('东区');
    });

    it('should discard the stale response when campus is switched quickly', async () => {
      // 快速点「本部」再点「东区」：两条请求并行，旧校区响应后到时必须丢弃，
      // 否则下拉显示「东区」而列表与计数仍是本部数据
      let release;
      const gate = new Promise(resolve => { release = resolve; });

      wx.cloud.callFunction.mockImplementation(({ data }) => gate.then(() => ({
        result: {
          success: true,
          data: {
            cats: data.filters.campus === '本部'
              ? [{ _id: 'staleCat', campus: '本部' }]
              : [{ _id: 'freshCat', campus: '东区' }],
            total: 1,
            hasMore: false
          }
        }
      })));

      const first = FilterService.loadCatsByCampus('本部', mockPageContext);
      const second = FilterService.loadCatsByCampus('东区', mockPageContext);
      release();
      await Promise.all([first, second]);

      // 只有第二次请求的列表能落盘；第一次的结果（含计数）必须被丢弃
      const listWrites = mockPageContext.setData.mock.calls
        .map(c => c[0])
        .filter(u => u && u.filteredCats);
      expect(listWrites).toHaveLength(1);
      expect(listWrites[0].filteredCats[0]._id).toBe('freshCat');
    });

    it('云函数失败时降级为客户端筛选', async () => {
      wx.cloud.callFunction.mockRejectedValueOnce(new Error('Cloud function error'));

      const mockDb = {
        command: { in: jest.fn(v => v), neq: jest.fn(v => v) },
        collection: jest.fn(() => ({
          where: jest.fn(() => ({
            field: jest.fn(function() { return this; }),
            orderBy: jest.fn(() => ({
              skip: jest.fn(() => ({
                limit: jest.fn(() => ({
                  get: jest.fn(() => Promise.resolve({ data: [] }))
                }))
              }))
            }))
          }))
        }))
      };
      wx.cloud.database.mockReturnValue(mockDb);

      await FilterService.loadCatsByCampus('本部', mockPageContext);

      // 降级为本地筛选，不再重入页面 filterCats（那会重新发起服务端筛选）
      expect(mockPageContext._fallbackClientFilter).toHaveBeenCalled();
    });
  });
});
