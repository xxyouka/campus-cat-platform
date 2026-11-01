// pages/help/help.js - 使用帮助（站内自助查询，离线可看）
const config = require('../../config');
const contactHelper = require('../../utils/contactHelper');
const obsHelper = require('../../utils/obsHelper');
const opsTrack = require('../../utils/opsTrack');
const guidance = require('../../utils/guidance');

const ENTRY_GROUP_ORDER = ['开始', '逛猫', '记录', '支持', '设置'];
const TAB_ROUTES = ['pages/index/index', 'pages/gallery/gallery', 'pages/profile/profile'];
// 需要猫咪上下文的页面，不在帮助页直接跳转（report 已支持无猫直达的「意见反馈」模式）
const CONTEXT_PAGES = ['pages/gallery/cat-album', 'pages/detail/detail'];
const HELP_PAGE = 'pages/help/help';

// 内容口径与 docs/微信AI知识库 保持一致；改功能时两处一起改。
const GUIDE_GROUPS = [
  {
    id: 'start',
    title: '第一次来',
    items: [
      {
        q: '这是什么地方？',
        a: '「校园猫猫」是一个校园猫咪信息平台。每只猫都有档案、照片和相遇记录，可以像翻图鉴一样认识它们。'
      },
      {
        q: '需要登录吗？',
        a: '不需要。浏览、搜索、看相册都不用登录；打卡和关注会用你的微信身份记录，不会获取头像和昵称。'
      },
      {
        q: '想找某个功能，在哪里看？',
        a: '进「我的 → 使用帮助 → 功能入口」，按分组找对应功能，能直达的点「去看看」。页面内不再自动弹分步引导；新版本会在首页弹一次更新卡。'
      },
      {
        q: '怎么找到某只猫？',
        a: '在首页搜索名字、花色或位置；也可以点「筛选」按性别、状态、花色、星级过滤，或切换到对应校区。'
      },
      {
        q: '怎么记录一次相遇？',
        a: '点开猫咪详情，点底部的「我遇到TA啦」，选一下相遇位置（可选），写一句话就可以保存。记录会进入你的相遇日历。地点的「地图选点」可以在校园底图上直接标出位置，比手写更准；不选具体位置则会记为「校园内」。'
      }
    ]
  },
  {
    id: 'features',
    title: '功能怎么用',
    items: [
      {
        q: '打卡有什么规则？',
        a: '同一只猫 1 小时内只能打卡一次，避免重复记录。打卡会计入你的相遇日历，也参与相遇排行榜。'
      },
      {
        q: '关注猫咪后会怎样？',
        a: '在详情页点「关注」，这只猫会出现在「我的 → 我的关注」里；TA 的动态会进入「我的 → 动态」。'
      },
      {
        q: '「好猫星级」是什么意思？',
        a: '3 星以上表示这只猫更适合家养，是给想领养的同学的参考。没打星只是还没评，不代表猫不好。'
      },
      {
        q: '校园地图怎么看？',
        a: '首页点「地图」进入。地图按校区展示猫咪常出没的位置，点标记可以直接进对应档案。打卡时也能用「地图选点」在底图上标出这次相遇的位置。'
      },
      {
        q: '怎么把猫咪分享给同学？',
        a: '在猫咪详情、相册或排行榜页，点右上角「···」→「转发」，也可以直接用页面里的分享入口。分享卡片会自动带猫名、照片和打开链接。'
      }
    ]
  },
  {
    id: 'faq',
    title: '常见问题',
    items: [
      {
        q: '为什么提示「1 小时内已打卡过这只猫」？',
        a: '这是防重复记录的冷却：同一只猫两次打卡之间要间隔 1 小时。换一只猫或过一会儿再来就好。'
      },
      {
        q: '换手机后关注和打卡还在吗？',
        a: '关注、打卡、相遇记录跟着你的微信账号走，换设备后仍在。'
      },
      {
        q: '照片可以自己上传吗？',
        a: '暂不开放。想补充照片请在「我的 → 关于我们」联系管理员；档案信息有误可直接在详情页点「信息有误或发现异常？点此反馈」。'
      },
      {
        q: '遇到受伤或生病的猫怎么办？',
        a: '先保持距离观察，不要强行抱走或喂药。及时联系管理员（「我的 → 关于我们」里有微信和邮箱），不要自行处理。'
      },
      {
        q: '发现信息有误怎么办？',
        a: '在猫咪详情页底部点「信息有误或发现异常？点此反馈」，选类型并描述问题即可。管理员处理后会在「我的 → 动态」回复你，不用重复提交。'
      }
    ]
  }
].map((group, groupIndex) => ({
  ...group,
  items: group.items.map((item, itemIndex) => ({
    ...item,
    id: `${groupIndex}-${itemIndex}`
  }))
}));

Page({
  data: {
    groups: GUIDE_GROUPS,
    openId: '',
    contact: contactHelper.normalizeContact({}),
    releases: [],
    entryGroups: [],
    version: config.version
  },

  onLoad() {
    const configured = config.guidance ? config.guidance.releases : null;
    const releases = (Array.isArray(configured) ? configured.slice() : [])
      .sort((a, b) => guidance.compareVersion(b.version, a.version))
      .map(release => ({
        ...release,
        items: (release.items || []).filter(item => item && item.text)
      }));
    this.setData({ releases });

    this._buildEntryGroups();
    this.loadContact();
    obsHelper.reportEvent(obsHelper.EVENT_NAMES.HELP_VIEW, {});
    opsTrack.entry('help');
  },

  _buildEntryGroups() {
    const features = guidance.getFeatureFlags();
    const entries = guidance.getEntryList(features)
      .filter(entry => entry.page !== HELP_PAGE)
      .map(entry => ({
        ...entry,
        linkable: !CONTEXT_PAGES.includes(entry.page)
      }));
    const groups = [];

    ENTRY_GROUP_ORDER.forEach(label => {
      const items = entries.filter(entry => entry.group === label);
      if (items.length) groups.push({ label, items });
    });
    const rest = entries.filter(entry => !ENTRY_GROUP_ORDER.includes(entry.group));
    if (rest.length) groups.push({ label: '其他', items: rest });

    this.setData({ entryGroups: groups });
  },

  onOpenEntry(e) {
    const page = e.currentTarget.dataset.page;
    if (!page) return;

    obsHelper.reportEvent(obsHelper.EVENT_NAMES.FEATURE_FIRST_USE, { feature: 'help_entry' });

    if (TAB_ROUTES.includes(page)) {
      wx.switchTab({ url: `/${page}` });
    } else {
      wx.navigateTo({ url: `/${page}` });
    }
  },

  async loadContact() {
    const contact = await contactHelper.loadContact();
    this.setData({ contact });
  },

  toggleItem(e) {
    const id = e.currentTarget.dataset.id;
    const openId = this.data.openId === id ? '' : id;
    this.setData({ openId });
    if (openId) {
      obsHelper.reportEvent(obsHelper.EVENT_NAMES.HELP_FAQ_EXPAND, { id });
    }
  }
});
