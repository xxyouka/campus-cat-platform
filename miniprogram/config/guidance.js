/**
 * config/guidance.js —— 引导内容（版本更新卡 / 全功能就地导览）
 *
 * 为什么单独拆一个文件：
 * 引导内容会随每个版本增长（更新卡 + 每个页面的分步导览），塞进 config.js
 * 会把云环境、业务开关、性能参数全埋掉。这里只放「给用户看什么」，
 * 状态与选片逻辑仍在 utils/guidance.js。
 *
 * 两条硬约束（由 scripts/check-guidance.js 校验）：
 *   1. page 必须是 app.json 里真实存在的页面；
 *   2. step.selector 必须是该页 WXML 里真实的 id。
 *
 * 全功能引导的触达规则：
 * - 每个页面第一次进入时，按 steps 顺序讲一遍；讲完/跳过后该页不再出现。
 * - campaign.id 变化 = 新一轮全量引导。旧用户即使看过上一轮，
 *   也会因为 campaign 变了而重新看到（每页仍然只看一次）。
 * - 中途退出不记账，下次进入从当前这一步继续。
 *
 * 文案口径：
 * - 标题 <= 12 字，desc <= 36 字；
 * - 只讲「能做什么、怎么做」，不讲实现；
 * - 不承诺未上线能力，不用夸张词。
 */

module.exports = {
  // 页面内分步导览总开关。
  // 2026-10-23 按产品反馈关闭：页面内不再自动弹任何引导，
  // 只保留「欢迎屏 → 版本更新卡 → 使用帮助 → 功能入口」的页面外引导。
  // tours 仍保留为「功能入口」数据源（label/desc/page/group），
  // 后续若要恢复页面内导览，把这里改回 true 并接回页面的 initGuideTour 即可。
  enabled: false,

  // ========== 本轮全量引导 ==========
  // 页面内导览关闭后，campaign 仅用于未来重新开启时的分组；当前不展示。
  campaign: {
    id: 'guide-3.9.0',
    version: '3.9.0',
    title: '全功能引导',
    intro: '这一版给每个功能都加了首次引导；看过的功能不会重复打扰。'
  },

  // ========== 版本更新卡 ==========
  // 每次冷启动最多弹一张；版本号高于用户看过的版本时出现。
  // 新用户完成欢迎屏后从当前版本起算，不会补看历史更新卡。
  releases: [
    {
      id: 'release-public-3.11.3',
      version: '3.11.3',
      date: '2026-11-01',
      title: '欢迎使用校园猫猫',
      icon: 'sparkle',
      items: [
        { text: '校园猫咪图鉴：按名字、区域、状态和花色筛选', entry: '/pages/index/index' },
        { text: '相遇打卡、关注和相册，记录每一次遇见', entry: '/pages/meets/meets' },
        { text: '寻猫地图：按校区找猫，打卡时可以点选相遇位置', entry: '/subpackages/map/campus-map/campus-map' }
      ]
    }
  ],

  // ========== 全功能就地导览 ==========
  // group 只影响「使用帮助 → 功能导览」的分组顺序。
  // replayable=false：页面必须带猫 / 反馈上下文，导览中心不直接跳转。
  tours: [
    {
      id: 'tour-index',
      page: 'pages/index/index',
      label: '首页图鉴',
      desc: '搜索筛选、相遇打卡、寻猫地图',
      group: '开始',
      replayable: true,
      steps: [
        {
          id: 'index-search',
          selector: '#coach-index-search',
          title: '找猫，先搜一下',
          desc: '名字、花色、位置都能搜；「筛选」按性别、状态、星级细看。',
          placement: 'below'
        },
        {
          id: 'index-map',
          selector: '#coach-campus-map',
          title: '猫都在这张图上',
          desc: '按校区看猫；打卡时也能在底图上选相遇位置。',
          placement: 'above'
        }
      ]
    },
    {
      id: 'tour-gallery',
      page: 'pages/gallery/gallery',
      label: '猫咪相册',
      desc: '按猫看全部照片',
      group: '逛猫',
      replayable: true,
      steps: [
        {
          id: 'gallery-grid',
          selector: '#coach-gallery-grid',
          title: '一个相册，一只猫',
          desc: '点开看TA的全部照片，喜欢的长按保存。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-cat-album',
      page: 'pages/gallery/cat-album',
      label: '单猫相册',
      desc: '同一只猫的照片墙',
      group: '逛猫',
      replayable: false,
      steps: [
        {
          id: 'cat-album-grid',
          selector: '#coach-album-grid',
          title: '点照片看大图',
          desc: '左右滑动看更多；长按或右下角保存。',
          placement: 'below'
        }
      ]
    },
    {
      id: 'tour-detail',
      page: 'pages/detail/detail',
      label: '猫咪详情',
      desc: '照片、关注、相遇打卡、反馈',
      group: '逛猫',
      replayable: false,
      steps: [
        {
          id: 'detail-photos',
          selector: '#coach-detail-photos',
          title: '照片集',
          desc: '点开看大图，每张都能点赞。',
          placement: 'above',
          optional: true
        },
        {
          id: 'detail-fav',
          selector: '#coach-detail-fav',
          title: '喜欢就关注',
          desc: '关注后，TA 的动态会进「我的 → 动态」。',
          placement: 'above'
        },
        {
          id: 'detail-meet',
          selector: '#coach-detail-meet',
          title: '遇到TA，记一笔',
          desc: '选地点、写一句话；同一只猫 1 小时内只能打一次卡。',
          placement: 'above'
        },
        {
          id: 'detail-report',
          selector: '#coach-detail-report',
          title: '档案不对？直接说',
          desc: '信息有误、受伤或异常都能反馈，结果回到「我的 → 动态」。',
          placement: 'above',
          optional: true
        }
      ]
    },
    {
      id: 'tour-profile',
      page: 'pages/profile/profile',
      label: '我的',
      desc: '相遇日历、关注/相遇/动态、入口',
      group: '开始',
      replayable: true,
      steps: [
        {
          id: 'profile-calendar',
          selector: '#coach-profile-calendar',
          title: '你的相遇日历',
          desc: '有记录的日子会点亮；本月、连续、累计天数都在下面。',
          placement: 'below'
        },
        {
          id: 'profile-quick',
          selector: '#coach-profile-quick',
          title: '关注、相遇、动态',
          desc: '三格分别进关注列表、相遇记录和最新动态。',
          placement: 'below'
        },
        {
          id: 'profile-menu',
          selector: '#coach-profile-menu',
          title: '更多入口',
          desc: '排行榜、公告、反馈和使用帮助都在这里。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-campus-map',
      page: 'subpackages/map/campus-map/campus-map',
      label: '校园寻猫地图',
      desc: '按校区看猫、点猫针、按名字找猫',
      group: '逛猫',
      replayable: true,
      // 地图主体是 canvas，蒙层盖不住；用底部卡片讲，不遮地图
      presentation: 'card',
      steps: [
        {
          id: 'map-info',
          selector: '#coach-map-info',
          title: '先选校区，再看猫',
          desc: '上方切换校区；「全图」回到整个校园。',
          placement: 'below'
        },
        {
          id: 'map-list',
          selector: '#coach-map-list',
          title: '点名字，地图飞过去',
          desc: '底部列表按名字找猫；点猫针看TA最近在哪。',
          placement: 'above',
          optional: true
        }
      ]
    },
    {
      id: 'tour-rank',
      page: 'pages/rank/rank',
      label: '猫咪排行榜',
      desc: '云吸、关注、相遇三种榜单',
      group: '逛猫',
      replayable: true,
      steps: [
        {
          id: 'rank-tabs',
          selector: '#coach-rank-tabs',
          title: '三种榜单',
          desc: '云吸看浏览、关注看人气、相遇看谁最常被遇到。',
          placement: 'below'
        },
        {
          id: 'rank-list',
          selector: '#coach-rank-list',
          title: '点一只，进档案',
          desc: '榜单只统计公开数据，不展示个人信息。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-meets',
      page: 'pages/meets/meets',
      label: '相遇记录',
      desc: '相遇日历、连续天数、最近记录',
      group: '记录',
      replayable: true,
      steps: [
        {
          id: 'meets-calendar',
          selector: '#coach-meets-calendar',
          title: '哪一天遇见了谁',
          desc: '点日历上的日期，看当天记录。',
          placement: 'below'
        },
        {
          id: 'meets-stats',
          selector: '#coach-meets-stats',
          title: '记录会留下来',
          desc: '累计、连续和本月天数自动统计。',
          placement: 'below'
        },
        {
          id: 'meets-list',
          selector: '#coach-meets-list',
          title: '最近相遇',
          desc: '点一条回到猫咪档案。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-favorites',
      page: 'pages/favorites/favorites',
      label: '我的关注',
      desc: '关注的猫和快速取消',
      group: '记录',
      replayable: true,
      steps: [
        {
          id: 'favorites-stats',
          selector: '#coach-favorites-stats',
          title: '关注的人都在这里',
          desc: '点红心快速取消；新动态会进「我的 → 动态」。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-notifications',
      page: 'pages/notifications/notifications',
      label: '最新动态',
      desc: '关注更新与反馈处理结果',
      group: '记录',
      replayable: true,
      steps: [
        {
          id: 'notifications-list',
          selector: '#coach-notify-list',
          title: '动态和反馈回复',
          desc: '关注更新、反馈处理结果都在这里；未读有红点。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-notice',
      page: 'pages/notice/notice',
      label: '公告栏',
      desc: '校园猫咪相关通知',
      group: '记录',
      replayable: true,
      steps: [
        {
          id: 'notice-list',
          selector: '#coach-notice-list',
          title: '公告栏',
          desc: '点卡片展开全文；紧急和活动公告标在左上角。',
          placement: 'below',
          optional: true
        }
      ]
    },
    {
      id: 'tour-report',
      page: 'subpackages/feedback/report/report',
      label: '反馈与上报',
      desc: '档案纠错、受伤异常或小程序意见',
      group: '支持',
      replayable: false,
      steps: [
        {
          id: 'report-form',
          selector: '#coach-report-form',
          title: '说清楚，才好核实',
          desc: '选类型、写至少 5 个字；结果发到「我的 → 动态」。',
          placement: 'below'
        }
      ]
    }
  ]
};
