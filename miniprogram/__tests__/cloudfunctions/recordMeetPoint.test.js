/**
 * recordMeet 地图坐标（point）行为测试
 *
 * 覆盖三件事：
 *   1. 合法坐标 → 写进 recordMeet.point，并刷新 cats.lastMeetPoint
 *   2. 非法/缺失坐标 → 记录照常写入，但**不动** lastMeetPoint（猫不能凭空消失）
 *   3. campusZone 取自猫档案，客户端传的一律不信；去空白后为空则整个点作废
 */
const { sanitizePoint } = require('../../cloudfunctions/utils/mapPoint');

/** 构造一套最小可用的 db mock，返回被调用痕迹 */
function setup(overrides = {}) {
  const calls = { recordAdds: [], catUpdates: [] };
  const catProfile = Object.assign(
    { name: '小橘', avatar: 'a.jpg', status: 'normal', campus: '本部' },
    overrides.catProfile || {}
  );

  const mockAdd = jest.fn(({ data }) => {
    calls.recordAdds.push(data);
    return Promise.resolve({ _id: 'm1' });
  });
  const mockCatUpdate = jest.fn(({ data }) => {
    calls.catUpdates.push(data);
    return Promise.resolve({});
  });
  const mockCatGet = jest.fn(() => Promise.resolve({ data: catProfile }));
  const mockDoc = jest.fn(() => ({ get: mockCatGet, update: mockCatUpdate }));
  const mockCount = jest.fn(() => Promise.resolve({ total: 0 }));
  const systemState = new Map();
  const mockSystemState = {
    where: jest.fn((condition) => ({
      limit: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({
          data: systemState.has(condition._id) ? [{ ...systemState.get(condition._id) }] : []
        }))
      })),
      update: jest.fn(({ data }) => {
        const current = systemState.get(condition._id);
        if (!current || Object.entries(condition).some(([key, value]) => current[key] !== value)) {
          return Promise.resolve({ stats: { updated: 0 } });
        }
        systemState.set(condition._id, { ...current, ...data });
        return Promise.resolve({ stats: { updated: 1 } });
      }),
      remove: jest.fn(() => {
        const current = systemState.get(condition._id);
        if (!current || Object.entries(condition).some(([key, value]) => current[key] !== value)) {
          return Promise.resolve({ stats: { removed: 0 } });
        }
        systemState.delete(condition._id);
        return Promise.resolve({ stats: { removed: 1 } });
      })
    })),
    add: jest.fn(({ data }) => {
      if (systemState.has(data._id)) {
        const error = new Error('duplicate key');
        error.errCode = -502001;
        return Promise.reject(error);
      }
      systemState.set(data._id, { ...data });
      return Promise.resolve({ _id: data._id });
    })
  };

  const makeChain = (data) => {
    const getFn = () => Promise.resolve({ data });
    const limitObj = () => ({ get: jest.fn(getFn) });
    const fieldObj = () => ({ limit: jest.fn(limitObj) });
    const orderByObj = () => ({ limit: jest.fn(limitObj), field: jest.fn(fieldObj) });
    return {
      where: jest.fn(() => ({
        get: jest.fn(getFn),
        count: jest.fn(() => Promise.resolve({ total: 0 })),
        limit: jest.fn(limitObj),
        orderBy: jest.fn(orderByObj),
        field: jest.fn(fieldObj)
      })),
      add: mockAdd,
      doc: mockDoc
    };
  };

  const mockCloud = require('wx-server-sdk');
  mockCloud.database.mockReturnValue({
    collection: jest.fn((name) => {
      if (name === 'cats') return { doc: mockDoc, count: mockCount, add: jest.fn() };
      if (name === 'system_state') return mockSystemState;
      return makeChain(overrides.meets || []);
    }),
    serverDate: jest.fn(() => new Date()),
    command: {
      gte: jest.fn(v => v), neq: jest.fn(v => v),
      inc: jest.fn(v => v), exists: jest.fn(v => v)
    },
    startTransaction: jest.fn(() => Promise.reject(new Error('事务不可用')))
  });
  mockCloud.openapi = { security: { msgSecCheck: jest.fn(() => Promise.resolve({})) } };

  return { calls, mockCloud };
}

describe('recordMeet 地图坐标 point', () => {
  beforeEach(() => { jest.resetModules(); });

  describe('sanitizePoint', () => {
    test('合法坐标被规整到 4 位小数', () => {
      expect(sanitizePoint({ u: 0.123456789, v: 0.987654321 }, '本部'))
        .toEqual({ campusZone: '本部', u: 0.1235, v: 0.9877 });
    });

    test('边界值 0 和 1 合法', () => {
      expect(sanitizePoint({ u: 0, v: 1 }, '本部')).toEqual({ campusZone: '本部', u: 0, v: 1 });
      expect(sanitizePoint({ u: 1, v: 0 }, '本部')).toEqual({ campusZone: '本部', u: 1, v: 0 });
    });

    test('越界 / 非有限 / 非对象 一律 null', () => {
      expect(sanitizePoint({ u: -0.01, v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: 1.01, v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: 0.5, v: -1 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: NaN, v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: Infinity, v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({}, '本部')).toBeNull();
      expect(sanitizePoint(null, '本部')).toBeNull();
      expect(sanitizePoint(undefined, '本部')).toBeNull();
      expect(sanitizePoint('0.5,0.5', '本部')).toBeNull();
      expect(sanitizePoint([0.5, 0.5], '本部')).toBeNull();
    });

    /**
     * Number(null) === 0，若直接 Number(x) 会把缺失坐标当成地图左上角 (0,0)。
     * 这条断言锁死这个坑。
     */
    test('null / 空串 / 布尔 不会被当成 0', () => {
      expect(sanitizePoint({ u: null, v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: 0.5, v: null }, '本部')).toBeNull();
      expect(sanitizePoint({ u: '', v: 0.5 }, '本部')).toBeNull();
      expect(sanitizePoint({ u: true, v: 0.5 }, '本部')).toBeNull();
    });

    test('数字字符串接受，但 campusZone 由外部决定', () => {
      expect(sanitizePoint({ u: '0.25', v: '0.75' }, '东区'))
        .toEqual({ campusZone: '东区', u: 0.25, v: 0.75 });
    });

    test('campusZone 截断到 20 字（与 cats.campus 字段上限一致）', () => {
      const long = 'A'.repeat(50);
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, long).campusZone).toHaveLength(20);
    });

    test('campusZone 非字符串 / 空白 → 整个点作废（空校区会成为地图查不到的「隐形点」）', () => {
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, 123)).toBeNull();
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, undefined)).toBeNull();
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, '')).toBeNull();
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, '   ')).toBeNull();
    });

    test('campusZone 带空白先去再存（读侧查询用去空白值，存原样永远查不到）', () => {
      expect(sanitizePoint({ u: 0.5, v: 0.5 }, ' 东区 ').campusZone).toBe('东区');
    });
  });

  test('合法坐标：写入 recordMeet.point 并刷新 cats.lastMeetPoint', async () => {
    const { calls } = setup({ catProfile: { campus: '本部' } });
    const recordMeet = require('../../cloudfunctions/recordMeet/index');

    const res = await recordMeet.main(
      { catId: 'abcdef1234567890abcd', point: { u: 0.42, v: 0.67 } },
      {}
    );
    expect(res.success).toBe(true);

    expect(calls.recordAdds).toHaveLength(1);
    expect(calls.recordAdds[0].point).toEqual({ campusZone: '本部', u: 0.42, v: 0.67 });

    expect(calls.catUpdates).toHaveLength(1);
    expect(calls.catUpdates[0].lastMeetPoint).toMatchObject({
      campusZone: '本部', u: 0.42, v: 0.67
    });
    expect(typeof calls.catUpdates[0].lastMeetPoint.at).toBe('number');
  });

  test('非法坐标：记录照写，但不碰 lastMeetPoint（猫不能从地图上消失）', async () => {
    const { calls } = setup();
    const recordMeet = require('../../cloudfunctions/recordMeet/index');

    const res = await recordMeet.main(
      { catId: 'abcdef1234567890abcd', point: { u: 5, v: 5 } },
      {}
    );
    expect(res.success).toBe(true);

    expect(calls.recordAdds[0].point).toBeUndefined();
    expect('point' in calls.recordAdds[0]).toBe(false);

    // 关键：字段「不存在」而不是「被写成 null」
    expect('lastMeetPoint' in calls.catUpdates[0]).toBe(false);
    expect(calls.catUpdates[0].lastMeetPoint).toBeUndefined();
    expect(calls.catUpdates[0].meetCount).toBeDefined();
  });

  test('完全不传 point：与非法坐标同样处理', async () => {
    const { calls } = setup();
    const recordMeet = require('../../cloudfunctions/recordMeet/index');

    await recordMeet.main({ catId: 'abcdef1234567890abcd' }, {});

    expect(calls.recordAdds[0].point).toBeUndefined();
    expect('lastMeetPoint' in calls.catUpdates[0]).toBe(false);
  });

  test('campusZone 取自猫档案，忽略客户端传值', async () => {
    const { calls } = setup({ catProfile: { campus: '南院' } });
    const recordMeet = require('../../cloudfunctions/recordMeet/index');

    await recordMeet.main(
      { catId: 'abcdef1234567890abcd', point: { u: 0.5, v: 0.5, campusZone: '伪造校区' } },
      {}
    );

    expect(calls.recordAdds[0].point.campusZone).toBe('南院');
    expect(calls.catUpdates[0].lastMeetPoint.campusZone).toBe('南院');
  });

  test('猫档案没有 campus（查询失败兜底空串）：点作废，lastMeetPoint 不被覆盖（覆盖成隐形点会把猫从地图上踢下去）', async () => {
    const { calls } = setup({ catProfile: { campus: '' } });
    const recordMeet = require('../../cloudfunctions/recordMeet/index');

    await recordMeet.main(
      { catId: 'abcdef1234567890abcd', point: { u: 0.3, v: 0.4 } },
      {}
    );

    expect(calls.recordAdds[0].point).toBeUndefined();
    expect('lastMeetPoint' in calls.catUpdates[0]).toBe(false);
  });
});
