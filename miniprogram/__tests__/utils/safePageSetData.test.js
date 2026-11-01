/**
 * __tests__/utils/safePageSetData.test.js
 *
 * 回归：utils/safePageSetData 的转发与兜底语义。
 *
 * 背景：`safeSetDataBehavior` 的 `lifetimes`/`pageLifetimes` 钩子只在
 * **自定义组件**上生效，挂Page 时不执行 —— 页面必须自己在 onUnload 置位
 * `_isUnmounted`（见 behaviors/safeSetDataBehavior.js 文件头）。
 * 于是「页面是否已卸载」只有页面自己知道，services/ 与 utils/ 只能通过
 * 调用方（页面实例）转发判断。
 *
 * 这些调用点大量位于 `await`（云函数调用、头像转链）之后 —— 用户此时可能
 * 已返回上一页，裸 setData 会在已销毁 Page 上执行并抛错。
 */
const { safePageSetData } = require('../../utils/safePageSetData');

describe('utils/safePageSetData', () => {
  test('页面接了 safeSetData 时优先走它（由页面自己的卸载标记决定）', () => {
    const page = {
      _isUnmounted: true,
      setData: jest.fn(),
      safeSetData: jest.fn()
    };
    const data = { loading: false };
    const r = safePageSetData(page, data);

    expect(r).toBe(true);
    expect(page.safeSetData).toHaveBeenCalledWith(data);
    // 关键：不得同时调裸 setData
    expect(page.setData).not.toHaveBeenCalled();
  });

  test('页面未接 behavior 时退回裸 setData', () => {
    const page = { setData: jest.fn() };
    const data = { loading: false };

    expect(safePageSetData(page, data)).toBe(true);
    expect(page.setData).toHaveBeenCalledWith(data);
  });

  test('页面已销毁导致 setData 抛错时静默返回 false，不向上抛', () => {
    const page = {
      setData: jest.fn(() => { throw new Error('setData 页面已销毁'); })
    };
    // 不应抛出 —— 业务流程不能被卸载打断
    expect(() => safePageSetData(page, { a: 1 })).not.toThrow();
    expect(safePageSetData(page, { a: 1 })).toBe(false);
  });

  test('safeSetData 自身抛错也被吞掉', () => {
    const page = {
      safeSetData: jest.fn(() => { throw new Error('boom'); }),
      setData: jest.fn()
    };
    expect(safePageSetData(page, { a: 1 })).toBe(false);
  });

  test('page 为空/undefined 时安全返回 false', () => {
    expect(safePageSetData(null, { a: 1 })).toBe(false);
    expect(safePageSetData(undefined, { a: 1 })).toBe(false);
  });
});
