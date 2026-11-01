const ShareTextGenerator = require('../../utils/shareTextGenerator');

describe('ShareTextGenerator', () => {
  describe('generateDetailText', () => {
    test('should return default text when cat is null', () => {
      const result = ShareTextGenerator.generateDetailText(null, 'friend');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    test('should return default text when cat is undefined', () => {
      const result = ShareTextGenerator.generateDetailText(undefined, 'timeline');
      expect(result).toBeTruthy();
    });

    test('should generate text with cat name', () => {
      const cat = { name: '小花', gender: '母', color: '橘' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('小花');
    });

    test('should use 神秘主子 when name is missing', () => {
      const cat = { gender: '公' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('神秘主子');
    });

    test('should replace gender placeholder for male', () => {
      const cat = { name: '大橘', gender: '公', description: '贪吃' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('大橘');
    });

    test('should replace gender placeholder for female', () => {
      const cat = { name: '小白', gender: '母', description: '温顺' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('小白');
    });

    test('should match 粘人 personality', () => {
      const cat = { name: '小粘', description: '很粘人' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('小粘');
    });

    test('should match 亲人 personality', () => {
      const cat = { name: '小亲', description: '亲人可爱' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('小亲');
    });

    test('should match 高冷 personality', () => {
      const cat = { name: '高冷猫', description: '高冷独立' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('高冷猫');
    });

    test('should match 活泼 personality', () => {
      const cat = { name: '活泼猫', description: '活泼好动' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('活泼猫');
    });

    test('should match 温顺 personality', () => {
      const cat = { name: '温顺猫', description: '温顺安静' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('温顺猫');
    });

    test('should match 贪吃 personality', () => {
      const cat = { name: '贪吃猫', description: '贪吃吃货' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('贪吃猫');
    });

    test('should use default templates when no personality match', () => {
      const cat = { name: '普通猫', gender: '公', color: '橘' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('普通猫');
    });

    test('should add male-specific template', () => {
      const cat = { name: '帅猫', gender: '公' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('帅猫');
    });

    test('should add female-specific template', () => {
      const cat = { name: '美猫', gender: '母' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('美猫');
    });

    test('should add 橘 color template', () => {
      const cat = { name: '橘猫', color: '橘色' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('橘猫');
    });

    test('should add 黑/白 color template', () => {
      const cat = { name: '黑白猫', color: '黑白' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('黑白猫');
    });

    test('should add 三花 color template', () => {
      const cat = { name: '三花猫', color: '三花' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('三花猫');
    });

    test('should include cat name in output', () => {
      const cat = { name: '校猫', campus: '北区' };
      const result = ShareTextGenerator.generateDetailText(cat, 'friend');
      expect(result).toContain('校猫');
    });
  });

  describe('generateHomeText', () => {
    test('should generate friend share text', () => {
      const result = ShareTextGenerator.generateHomeText({ totalCats: 10 }, 'friend');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    test('should generate timeline share text', () => {
      const result = ShareTextGenerator.generateHomeText({ totalCats: 10 }, 'timeline');
      expect(result).toBeTruthy();
    });

    test('should include cat count in friend text', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const result = ShareTextGenerator.generateHomeText({ totalCats: 15 }, 'friend');
      expect(result).toContain('15');
      jest.restoreAllMocks();
    });

    test('should handle missing stats', () => {
      const result = ShareTextGenerator.generateHomeText(null, 'friend');
      expect(result).toBeTruthy();
    });

    test('should handle missing totalCats', () => {
      const result = ShareTextGenerator.generateHomeText({}, 'friend');
      expect(result).toBeTruthy();
    });
  });

  describe('generateAlbumText', () => {
    test('should generate friend album text', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const result = ShareTextGenerator.generateAlbumText('小花', 20, 'friend');
      expect(result).toContain('小花');
      expect(result).toContain('20');
      jest.restoreAllMocks();
    });

    test('should generate timeline album text', () => {
      const result = ShareTextGenerator.generateAlbumText('小花', 20, 'timeline');
      expect(result).toBeTruthy();
    });

    test('should use default name when missing', () => {
      const result = ShareTextGenerator.generateAlbumText(null, 10, 'friend');
      expect(result).toContain('猫咪');
    });

    test('should handle zero photo count', () => {
      const result = ShareTextGenerator.generateAlbumText('小花', 0, 'friend');
      expect(result).toContain('小花');
    });
  });

  describe('_getPersonalityTemplates', () => {
    test('should return null for empty description', () => {
      expect(ShareTextGenerator._getPersonalityTemplates('', '猫')).toBeNull();
      expect(ShareTextGenerator._getPersonalityTemplates(null, '猫')).toBeNull();
    });

    test('should return null for unmatched description', () => {
      expect(ShareTextGenerator._getPersonalityTemplates('普通猫咪', '猫')).toBeNull();
    });

    test('should return templates for 粘人', () => {
      const templates = ShareTextGenerator._getPersonalityTemplates('很粘人', '猫');
      expect(templates).toBeTruthy();
      expect(templates.length).toBeGreaterThan(0);
    });
  });

  describe('_getDefaultDetailTemplates', () => {
    test('should return base templates', () => {
      const templates = ShareTextGenerator._getDefaultDetailTemplates('小花', null, null);
      expect(templates.length).toBeGreaterThanOrEqual(4);
    });

    test('should add male template', () => {
      const templates = ShareTextGenerator._getDefaultDetailTemplates('小花', '公', null);
      expect(templates.length).toBe(5);
    });

    test('should add female template', () => {
      const templates = ShareTextGenerator._getDefaultDetailTemplates('小花', '母', null);
      expect(templates.length).toBe(5);
    });

    test('should add 橘 color template', () => {
      const templates = ShareTextGenerator._getDefaultDetailTemplates('小花', null, '橘色');
      expect(templates.length).toBe(5);
    });
  });

  describe('_getRandomDefault', () => {
    test('should return friend default text', () => {
      const result = ShareTextGenerator._getRandomDefault('friend');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    test('should return timeline default text', () => {
      const result = ShareTextGenerator._getRandomDefault('timeline');
      expect(result).toBeTruthy();
    });
  });
});
