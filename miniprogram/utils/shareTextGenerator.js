/**
 * utils/shareTextGenerator.js - 智能分享文案生成器
 *
 * 根据猫咪属性动态生成个性化分享文案
 * 提高分享转化率和用户参与度
 *
 * 口径：文案不含 emoji（图标统一 2026-10），语气靠措辞与标点承担。
 */

const ShareTextGenerator = {
  /**
   * 生成详情页分享文案
   * @param {Object} cat - 猫咪数据
   * @param {string} type - 'friend' | 'timeline'
   * @returns {string} 分享标题
   */
  generateDetailText(cat, type = 'friend') {
    if (!cat) return this._getRandomDefault(type);

    const name = cat.name || '神秘主子';
    const gender = cat.gender;
    const color = cat.color;
    const description = cat.description || '';
    const campus = cat.campus || '';

    // 根据性格特征选择文案模板
    let templates = this._getPersonalityTemplates(description, name);

    // 如果没有匹配到性格，使用通用模板
    if (!templates || templates.length === 0) {
      templates = this._getDefaultDetailTemplates(name, gender, color);
    }

    // 开学季混入季节模板（v3.2.0）
    if (this._isBackToSchoolSeason()) {
      templates = [...templates, ...this._getBackToSchoolDetailTemplates()];
    }

    // 随机选择一个模板
    const template = templates[Math.floor(Math.random() * templates.length)];

    // 替换占位符
    return template
      .replace('{name}', name)
      .replace('{gender}', gender === '公' ? '小哥哥' : gender === '母' ? '小姐姐' : '')
      .replace('{color}', color || '')
      .replace('{campus}', campus || '校园');
  },

  /**
   * 获取开学季专属猫咪分享文案
   * @returns {string[]}
   * @private
   */
  _getBackToSchoolDetailTemplates() {
    return [
      '新生看过来！校园猫咪「{name}」在{campus}等你',
      '开学第一天就被「{name}」圈粉了，太可爱了吧！',
      '新学期必备：一份校园撸猫指南，今日推荐「{name}」',
      '宿舍楼下偶遇「{name}」！新学期的小确幸',
      '新生报到！校园猫咪「{name}」向你发来好友申请',
      '校园开学季｜你一定要认识的校园猫咪「{name}」',
      '刚开学就遇到「{name}」，这学期运气肯定不会差',
      '大一新生收藏夹第一只猫咪：「{name}」',
      '学长学姐推荐：校园猫咪「{name}」据说是{color}系花',
      '新学期 flag：认识{campus}所有猫咪！先从「{name}」开始'
    ];
  },

  /**
   * 生成首页分享文案
   * @param {Object} stats - 统计数据 { totalCats, totalPhotos }
   * @param {string} type - 'friend' | 'timeline'
   * @returns {string}
   */
  generateHomeText(stats, type = 'friend') {
    const count = stats?.totalCats || '很多';

    // 开学季模板：仅在窗口期内混入（见 _isBackToSchoolSeason）
    const backToSchoolFriend = [
      `新生必看！校园有 ${count} 只猫咪等你来认识`,
      `开学季来认识校园里的毛孩子吧！${count}只猫咪超可爱`,
      `新学期新朋友！校园猫咪图鉴大公开，${count}只主子在线`,
      `刚来校园？收好这份猫咪图鉴，${count}只猫咪等你打卡`,
      `开学第一课：认识校园猫咪，已有 ${count} 只收录在册`,
      '发现校园最萌校宠！每一只都有专属档案'
    ];

    // 朋友圈季节模板：同样只随窗口出现，不进常青列表
    // （2026-10-12 文案统一：这两条原混在常青列表里，11 月后仍会出现）
    const backToSchoolTimeline = [
      '新生攻略 · 校园猫咪全图鉴',
      '开学季 | 校园猫咪打卡攻略'
    ];

    const standardFriend = [
      `校园有 ${count} 只可爱猫咪，快来认识它们`,
      `发现一个宝藏猫咪小程序！${count}只主子等你撸`,
      '校园猫猫图鉴 | 每一只都值得被记录',
      '校园里的毛孩子都在这里，快来看看你遇到过谁'
    ];

    const standardTimeline = [
      `校园有 ${count} 只可爱猫咪`,
      '校园猫猫图鉴 - 每一只都值得被爱',
      '校园猫咪大赏，看看你认识哪只？',
      '校园猫咪图鉴 · 每一只都有自己的故事',
      '校园偶遇指南 · 记录你遇到的猫咪'
    ];

    // 随机偏重开学季模板（60%概率）
    const isBackToSchoolSeason = this._isBackToSchoolSeason();
    const friendTemplates = isBackToSchoolSeason
      ? [...backToSchoolFriend, ...standardFriend]
      : standardFriend;

    const timelineTemplates = type === 'friend'
      ? friendTemplates
      : isBackToSchoolSeason
        ? [...backToSchoolTimeline, ...standardTimeline]
        : standardTimeline;

    return timelineTemplates[Math.floor(Math.random() * timelineTemplates.length)];
  },

  /**
   * 判断是否在开学季（8月下旬-10月 / 2月-3月）
   * @returns {boolean}
   * @private
   */
  _isBackToSchoolSeason() {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const date = now.getDate();
    // 秋学期: 8月20日 至 10月31日
    if (month === 8 && date >= 20) return true;
    if (month === 9 || month === 10) return true;
    // 春学期: 2月 至 3月
    if (month === 2 || month === 3) return true;
    return false;
  },

  /**
   * 生成相册页分享文案
   * @param {string} catName - 猫咪名字
   * @param {number} photoCount - 照片数量
   * @param {string} type - 'friend' | 'timeline'
   * @returns {string}
   */
  generateAlbumText(catName, photoCount, type = 'friend') {
    const name = catName || '猫咪';
    const count = photoCount || 0;

    const templates = type === 'friend'
      ? [
        `${name}的相册 | ${count}张治愈系美照`,
        `${name}的生活记录 · 校园猫猫相册`,
        `快来看${name}的${count}张萌照！`
      ]
      : [
        `${name}的相册 | 校园猫咪生活记录`,
        '校园猫猫相册 - 每一帧都是治愈',
        '用镜头记录温暖 - 校园猫咪相册'
      ];

    return templates[Math.floor(Math.random() * templates.length)];
  },

  /**
   * 根据性格描述获取对应文案模板
   * @private
   */
  _getPersonalityTemplates(description, name) {
    if (!description) return null;

    const desc = description.toLowerCase();

    if (desc.includes('粘人') || desc.includes('亲人')) {
      return [
        `「${name}」超粘人！见面就蹭腿求摸摸`,
        `${name}是只小粘人精~ 走到哪跟到哪`,
        `警告：${name}可能会赖上你不走！`
      ];
    }

    if (desc.includes('高冷') || desc.includes('独立')) {
      return [
        `「${name}」高冷主子，只可远观`,
        `${name}：凡人退下，勿扰本王清梦`,
        `高冷${name}在线，能被它青睐是你的荣幸`
      ];
    }

    if (desc.includes('活泼') || desc.includes('好动')) {
      return [
        `「${name}」活力满满，停不下来！`,
        `${name}是只运动健将，跑酷高手`,
        `多动症${name}上线！快来看它的表演`
      ];
    }

    if (desc.includes('温顺') || desc.includes('安静')) {
      return [
        `「${name}」温顺如水，治愈系担当`,
        `${name}安静地陪着你，岁月静好`,
        `温柔${name}，适合静静陪伴的时光`
      ];
    }

    if (desc.includes('贪吃') || desc.includes('吃货')) {
      return [
        `「${name}」资深吃货，看见吃的就走不动路`,
        `${name}：除了吃，别的事都不重要`,
        `投喂${name}的正确姿势（附教程）`
      ];
    }

    return null;
  },

  /**
   * 获取默认详情页文案模板
   * @private
   */
  _getDefaultDetailTemplates(name, gender, color) {
    const baseTemplates = [
      `「${name}」等你来撸！校园猫咪`,
      `发现一只超可爱的校园猫「${name}」`,
      `${name}在校园等你偶遇`,
      `快来看看${name}长什么样`
    ];

    // 根据性别添加特定模板
    if (gender === '公') {
      baseTemplates.push(`「${name}」帅气校草猫，迷倒万千少女`);
    } else if (gender === '母') {
      baseTemplates.push(`「${name}」温柔校花猫，气质绝佳`);
    }

    // 根据花色添加特定模板
    if (color?.includes('橘')) {
      baseTemplates.push(`「${name}」大橘为重，体重随缘`);
    } else if (color?.includes('黑') || color?.includes('白')) {
      baseTemplates.push(`「${name}」奶牛装/燕尾服，优雅永不过时`);
    } else if (color?.includes('三花') || color?.includes('玳瑁')) {
      baseTemplates.push(`「${name}」三花/玳瑁，每只都是独一无二的艺术品`);
    }

    return baseTemplates;
  },

  /**
   * 获取默认随机文案
   * @private
   */
  _getRandomDefault(type) {
    const defaults = type === 'friend'
      ? [
        '快来认识这只可爱的校园猫咪',
        '校园猫咪图鉴，每一只都值得被爱',
        '发现宝藏小程序！校园猫咪大赏'
      ]
      : [
        '校园猫咪图鉴',
        '每一只都值得被记录',
        '示例大学校园猫咪展示平台'
      ];

    return defaults[Math.floor(Math.random() * defaults.length)];
  }
};

module.exports = ShareTextGenerator;
