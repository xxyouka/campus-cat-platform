// pages/admin/components/cat-picker/cat-picker.js - 猫咪选择器（搜索 + 浏览全部档案）
/**
 * 收敛「选猫」这一个动作里原先散在页面上的三处可用性缺陷：
 *
 *   1. 只能盲搜：原 add 面板必须输入关键词才出候选（云函数 searchCats 空关键词
 *      直接返回空数组，见 cloudfunctions/catRelation/index.js:310），且只匹配
 *      name / color —— 只记得"是哪只猫"、记不清名字时无从下手。本组件补一条
 *      「浏览全部」通道（复用 filterCats，关键词可空、支持分页、返回含 avatar，
 *      无需新增云函数）。
 *
 *   2. 选中无从确认：原实现选完只回显名字，两只都是名字时很容易选错且当场发现不了。
 *      本组件选中态带头像 + 花色，未选中的「另一端已选」项置灰。
 *
 *   3. A / B 交叉编辑互相打断：原实现两端共用一份 catOptions 与同一个防抖 timer
 *      （relation-manage.js:249-252），在 A 里搜完再去 B 输入，A 的候选就没了。
 *      本组件实例化即隔离：每个实例持有自己的 keyword / options / timer / 请求序号。
 */
const { Logger } = require('../../../../utils/logger');
const imageLoader = require('../../../../utils/imageLoader');

const SEARCH_DEBOUNCE = 300;
// 浏览条数与云端 searchCats 的上限一致（10）。候选不再自带滚动区（见 cat-picker.wxss），
// 条数必须收敛，否则一屏 20 条会把「确认添加」按钮顶到面板外。
const BROWSE_PAGE_SIZE = 10;

Component({
  properties: {
    // 已选中的猫：{ _id, name, avatar, color, initialName }
    value: { type: Object, value: null },
    // 对端已选的猫 id：点它直接拦下，避免「同一只猫和自己建关系」
    excludeId: { type: String, value: '' },
    placeholder: { type: String, value: '搜索猫咪名称 / 花色' },
    /** 聚焦令牌：父组件自增即可让本组件聚焦输入框。
     *  页面拿不到子组件内部 input 的实例，跨组件聚焦只能靠 property 传一个「事件序号」；
     *  用令牌（而不是 Boolean）是必须的：Boolean 只能 true 一次，第二次点击就没反应，
     *  而「点预览条里的名字反复聚焦」正是这里的核心交互。 */
    focusToken: { type: Number, value: 0 }
  },

  data: {
    keyword: '',
    options: [],
    loading: false,
    browsing: false,
    inputFocus: false
  },

  lifetimes: {
    attached() {
      this._seq = 0;
    },
    detached() {
      this._clearTimer();
    }
  },

  observers: {
    // 令牌变化 → 聚焦。先置 true，聚焦完成后必须回置 false：
    // input 的 focus 是「置位触发」型，停在 true 上第二次就不再生效。
    focusToken(val) {
      if (!val) return;
      this.setData({ inputFocus: true });
      setTimeout(() => this.setData({ inputFocus: false }), 300);
    }
  },

  methods: {
    _clearTimer() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    },

    onInput(e) {
      const keyword = e.detail.value;
      this.setData({ keyword, browsing: false });
      this._clearTimer();
      if (!keyword) {
        // 输入清空：作废在途请求（seq 自增），否则慢响应回来会把候选又填回来
        this._seq += 1;
        this.setData({ options: [], loading: false });
        return;
      }
      // 防抖：每次输入都直发会撞云端限流（30 次/分钟），候选会静默消失
      this._timer = setTimeout(() => this._search(keyword), SEARCH_DEBOUNCE);
    },

    onClearKeyword() {
      this._clearTimer();
      this._seq += 1;
      this.setData({ keyword: '', options: [], loading: false, browsing: false });
    },

    /** 关键词搜索：走 catRelation.searchCats，保留云端频率限制 */
    async _search(keyword) {
      const seq = ++this._seq;
      this.setData({ loading: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'catRelation',
          data: { action: 'searchCats', keyword }
        });
        if (seq !== this._seq) return;
        if (!res.result || !res.result.success) {
          this.setData({ options: [], loading: false });
          wx.showToast({ title: res.result && res.result.error || '搜索失败，请重试', icon: 'none' });
          return;
        }
        const data = res.result.data || res.result;
        const cats = data.cats || data || [];
        const options = await this._normalize(cats);
        if (seq !== this._seq) return;
        this.setData({ options, loading: false });
      } catch (err) {
        if (seq !== this._seq) return;
        Logger.warn('cat-picker', '搜索猫咪失败', { error: err.message });
        this.setData({ options: [], loading: false });
        wx.showToast({ title: '搜索失败，请重试', icon: 'none' });
      }
    },

    /** 浏览全部档案：复用 filterCats（关键词可空、支持分页、整文档含 avatar） */
    async _browse() {
      const seq = ++this._seq;
      this.setData({ loading: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'filterCats',
          data: { filters: { page: 1, pageSize: BROWSE_PAGE_SIZE } }
        });
        if (seq !== this._seq) return;
        if (!res.result || !res.result.success) {
          this.setData({ loading: false });
          wx.showToast({ title: res.result && res.result.error || '加载失败，请重试', icon: 'none' });
          return;
        }
        const data = res.result.data || {};
        const options = await this._normalize(data.cats || []);
        if (seq !== this._seq) return;
        this.setData({ options, loading: false });
      } catch (err) {
        if (seq !== this._seq) return;
        Logger.warn('cat-picker', '浏览猫咪档案失败', { error: err.message });
        this.setData({ options: [], loading: false });
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      }
    },

    onToggleBrowse() {
      if (this.data.browsing) {
        this.onClearKeyword();
        return;
      }
      this._clearTimer();
      this.setData({ browsing: true, keyword: '' });
      this._browse();
    },

    onPick(e) {
      const id = e.currentTarget.dataset.id;
      const cat = this.data.options.find(o => o._id === id);
      if (!cat) return;
      if (id && id === this.data.excludeId) {
        wx.showToast({ title: '不能选择同一只猫咪', icon: 'none' });
        return;
      }
      this._clearTimer();
      this.setData({ keyword: '', options: [], loading: false, browsing: false });
      this.triggerEvent('change', { cat });
    },

    onClear() {
      this.triggerEvent('clear');
    },

    /**
     * 统一候选字段 + 头像转链。
     * 云端返回的 avatar 是裸 cloud:// fileID，直接绑 <image src> 会加载全尺寸原图
     * （绕过档位），故渲染前按 avatar 档位批量转临时链接。
     */
    async _normalize(cats) {
      const list = (cats || []).map(c => ({
        _id: c._id,
        name: c.name || '未知',
        color: c.color || '',
        avatar: c.avatar || '',
        initialName: (c.name || '').charAt(0)
      }));
      const ids = list.filter(x => x.avatar.indexOf('cloud://') === 0).map(x => x.avatar);
      if (ids.length === 0) return list;
      try {
        const urlMap = await imageLoader.getTempUrls(ids, { optimizeType: 'avatar' });
        return list.map(x => urlMap[x.avatar] ? { ...x, avatar: urlMap[x.avatar] } : x);
      } catch (err) {
        // 转链失败退回裸 fileID：头像挂掉不影响选猫本身
        return list;
      }
    }
  }
});