/**
 * utils/dbFields.js - 客户端直连数据库时的可见性过滤与字段投影
 *
 * 为什么需要这个模块：
 * 项目有两条读取 cats 的通道 —— 云函数出口与客户端直连。两者必须给出同一份语义，
 * 否则用户看到的内容取决于「这条数据走了哪条路」。
 *
 * 云函数侧早已做全（getCatDetail / getCatsByIds / filterCats 都是既过滤、
 * 又投影），而客户端直连原先整文档下发，于是出现两个可观测缺陷：
 *
 *   1. 泄露内部字段。cats 是所有人可读的公开集合，存量文档里躺着管理员建档时的
 *      `_openid`（addCat 已停止写入，但存量仍在；getCatDetail 为此专门 delete 该字段，
 *      测试 __tests__/cloudfunctions/catReadEndpoints.test.js 把这一形态固定了下来）。
 *      整文档直连等于把管理员 openid 下发给每个用户 —— addCat 的注释
 *      「客户端 .field() 投影用量为 0」记的正是这个缺口。
 *
 *   2. 删除中的猫咪仍然可见。deleteData 用 `_deleting` 标记后分多步删除，
 *      filterCats 的注释写明「删除中的猫咪对列表不可见（中断时不残留可见数据）」。
 *      客户端不过滤时：管理员删掉猫咪，它仍出现在首页列表、仍能被点进详情。
 *
 * 用法（客户端侧读 cats 的三处统一采用）：
 *   db.collection('cats')
 *     .where(withCatVisibility({ status: ... }))   // 叠加「未在删除中」
 *     .field(CAT_LIST_FIELDS)                      // 剔除内部字段
 */

/**
 * 剔除 cats / photos 文档的内部字段。
 *
 * 排除模式（全部为 false）而非白名单：白名单漏掉任一字段就会让界面少渲染一块，
 * 而排除模式只可能「多下发一个字段」，出错方向是安全的。
 * `_id` 不受影响，始终下发；该写法在本项目已有先例（getNotifications 的
 * `.field({ visitorOpenid: false })`）。
 */
const CAT_LIST_FIELDS = {
  _openid: false,
  _deleting: false,
  _deleteStartTime: false
};

const PHOTO_LIST_FIELDS = {
  _openid: false,
  _deleting: false,
  _deleteStartTime: false
};

/**
 * 把「未在删除中」并进 where 条件。
 *
 * `_deleting: _.neq(true)` 与云函数 filterCats 的写法逐字一致：
 * 用 neq(true) 而不是 eq(false)，是为了让从未写入该字段的历史文档也被视为可见。
 *
 * @param {object} where - 原始查询条件（不会被修改）
 * @returns {object} 叠加删除过滤后的新条件
 */
function withCatVisibility(where) {
  const cmd = wx.cloud.database().command;
  return {
    ...where || {},
    _deleting: cmd.neq(true)
  };
}

module.exports = {
  CAT_LIST_FIELDS,
  PHOTO_LIST_FIELDS,
  withCatVisibility
};
