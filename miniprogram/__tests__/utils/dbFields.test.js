/**
 * __tests__/utils/dbFields.test.js
 *
 * utils/dbFields.js 是「客户端直连读与云函数出口同语义」的唯一落点：
 * 首页列表、校区筛选、详情预取都经它叠加删除过滤与字段投影。
 *
 * 为什么每一条都要测：
 * 该模块的两种失效方式都不会报错，只会静静地把数据发出去 ——
 *   1. 投影对象里混进 `_id: false`，会把主键也剔掉（列表 key、跳转全废）；
 *   2. 投影退化成「全 true 白名单」，字段随业务增长而漏发；
 *   3. withCatVisibility 直接改写入参，会把调用方的 where 对象污染成带 _deleting 的版本，
 *      而 count 与 get 常共用同一个 where（filterService 就是如此），语义会悄悄漂移。
 */

const { CAT_LIST_FIELDS, PHOTO_LIST_FIELDS, withCatVisibility } = require('../../utils/dbFields');

describe('utils/dbFields', () => {
  const INTERNAL_FIELDS = ['_openid', '_deleting', '_deleteStartTime'];

  describe('字段投影', () => {
    test('CAT_LIST_FIELDS 以排除模式剔除三个内部字段', () => {
      INTERNAL_FIELDS.forEach((field) => {
        expect(CAT_LIST_FIELDS[field]).toBe(false);
      });
    });

    test('PHOTO_LIST_FIELDS 与 cats 口径一致（同样只排除，不白名单）', () => {
      INTERNAL_FIELDS.forEach((field) => {
        expect(PHOTO_LIST_FIELDS[field]).toBe(false);
      });
    });

    test('投影里不得出现 _id —— 显式排除主键会让列表 key 与跳转全部失效', () => {
      expect(CAT_LIST_FIELDS._id).toBeUndefined();
      expect(PHOTO_LIST_FIELDS._id).toBeUndefined();
    });

    test('投影不得出现任何 true 值 —— 一旦混入就整体切换成白名单模式', () => {
      // 云开发对 field() 的语义是「同一次调用内不得混用」：只要有一个 true，
      // 其余 false 的含义就变成「未列出的字段不下发」。这里把该退化钉死。
      const values = [...Object.values(CAT_LIST_FIELDS), ...Object.values(PHOTO_LIST_FIELDS)];
      expect(values.every((v) => v === false)).toBe(true);
    });

    test('两个投影互不共享引用（改动其一不得影响另一）', () => {
      expect(CAT_LIST_FIELDS).not.toBe(PHOTO_LIST_FIELDS);
    });
  });

  describe('withCatVisibility', () => {
    test('叠加 _deleting: neq(true)', () => {
      const where = withCatVisibility({});
      // 用 toEqual 而非 toBe：setup.js 的 command 桩是 `neq: jest.fn(v => v)`，
      // 断言的是「包装结果等于 neq(true) 的返回值」，不依赖桩的返回形态
      expect(where._deleting).toEqual(wx.cloud.database().command.neq(true));
    });

    test('用 neq(true) 而非 eq(false)：让从未写过 _deleting 的历史文档仍然可见', () => {
      // 云开发里 { _deleting: _.eq(false) } 匹配不到「字段不存在」的文档，
      // 那会让绝大多数存量猫咪从列表里消失。断言走的是 neq 分支。
      withCatVisibility({});
      expect(wx.cloud.database().command.neq).toHaveBeenCalledWith(true);
      expect(wx.cloud.database().command.eq).not.toHaveBeenCalled();
    });

    test('保留调用方原有条件', () => {
      const where = withCatVisibility({ campus: '本部', status: 'normal' });
      expect(where.campus).toBe('本部');
      expect(where.status).toBe('normal');
    });

    test('不改写入参（count 与 get 共用同一 where 时必须各自独立）', () => {
      const original = { campus: '本部' };
      const where = withCatVisibility(original);

      expect(original).toEqual({ campus: '本部' });
      expect(original._deleting).toBeUndefined();
      expect(where).not.toBe(original);
    });

    test('无参调用不抛错，仍返回带删除过滤的条件', () => {
      expect(() => withCatVisibility()).not.toThrow();
      expect(withCatVisibility()._deleting).toEqual(wx.cloud.database().command.neq(true));
    });

    test('在结果上追加条件不影响后续调用（每次调用产出独立对象）', () => {
      const first = withCatVisibility({});
      first.campus = '东区';

      const second = withCatVisibility({});
      expect(second.campus).toBeUndefined();
    });
  });
});
