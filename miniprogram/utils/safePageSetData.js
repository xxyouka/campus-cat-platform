/**
 * utils/safePageSetData.js - 页面数据安全写入（供 services/ 与 utils/ 复用）
 *
 * 为什么需要这个模块：
 *   小程序的 `safeSetDataBehavior` 只在被**自定义组件**使用时才触发
 *   `lifetimes` / `pageLifetimes`；挂在 Page 上时这两个钩子不执行，
 *   `_isUnmounted` 必须由页面自己在 onUnload 里置位（见 behaviors/safeSetDataBehavior.js
 *   文件头的完整说明）。因此「页面已卸载」这件事，只有页面自己知道。
 *
 *   services/ 与 utils/ 里的方法大量在 `await`（云函数调用、头像转链）之后才 setData，
 *   此时用户可能已返回上一页 → 在已销毁 Page 上 setData，部分基础库会抛
 *   「setData 页面已销毁」。这些文件不是页面，拿不到自己的 _isUnmounted，
 *   只能通过调用方（页面实例）转发。
 *
 * 口径与 services/imageService.js 的既有写法一致：优先用页面的 safeSetData
 * （由页面自己的标记决定），没接 behavior 时退回裸 setData + try/catch 兜底。
 *
 * 不用 getCurrentPages() 判断：单测里该全局默认返回空数组，
 * 会把测试环境的全部 setData 误判为已卸载，造成大面积假失败。
 */

/**
 * 安全地写入页面数据
 * @param {object} page 页面实例（this）
 * @param {object} data 待写入的数据
 * @returns {boolean} 是否真的执行了写入（false 表示页面已卸载或写入抛错）
 */
function safePageSetData(page, data) {
  if (!page) return false;
  try {
    if (typeof page.safeSetData === 'function') {
      page.safeSetData(data);
    } else {
      page.setData(data);
    }
    return true;
  } catch (e) {
    // 页面已销毁/卸载，静默丢弃——此处不应打断业务流程
    return false;
  }
}

module.exports = { safePageSetData };
