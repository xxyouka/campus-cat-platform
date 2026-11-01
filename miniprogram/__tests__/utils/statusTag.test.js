// __tests__/utils/statusTag.test.js - 相遇状态标签「文本 图标」口径
const { parseStatusTag, normalizeStatusTag, decorateMeet, TAG_ICONS } = require('../../utils/statusTag');

describe('utils/statusTag', () => {
  describe('parseStatusTag', () => {
    test('六选一纯文本映射到对应图标', () => {
      expect(parseStatusTag('相遇了')).toEqual({ icon: 'cat-happy', text: '相遇了' });
      expect(parseStatusTag('在睡觉')).toEqual({ icon: 'moon', text: '在睡觉' });
      expect(parseStatusTag('在吃饭')).toEqual({ icon: 'utensils', text: '在吃饭' });
      expect(parseStatusTag('在玩耍')).toEqual({ icon: 'gamepad', text: '在玩耍' });
      expect(parseStatusTag('在散步')).toEqual({ icon: 'paw', text: '在散步' });
      expect(parseStatusTag('求摸摸')).toEqual({ icon: 'heart-handshake', text: '求摸摸' });
    });

    test('历史 emoji 前缀被剥离并映射图标', () => {
      expect(parseStatusTag('😺 相遇了')).toEqual({ icon: 'cat-happy', text: '相遇了' });
      expect(parseStatusTag('😴 在睡觉')).toEqual({ icon: 'moon', text: '在睡觉' });
      expect(parseStatusTag('🍽️ 在吃饭')).toEqual({ icon: 'utensils', text: '在吃饭' });
      expect(parseStatusTag('🎮 在玩耍')).toEqual({ icon: 'gamepad', text: '在玩耍' });
      expect(parseStatusTag('🐾 在散步')).toEqual({ icon: 'paw', text: '在散步' });
      expect(parseStatusTag('🤗 求摸摸')).toEqual({ icon: 'heart-handshake', text: '求摸摸' });
      expect(parseStatusTag('✏️ 在开会')).toEqual({ icon: 'edit', text: '在开会' });
    });

    test('旧版默认措辞「遇见了」语义等同「相遇了」', () => {
      expect(parseStatusTag('遇见了').icon).toBe('cat-happy');
    });

    test('自定义短语 → edit 图标，文本原样', () => {
      expect(parseStatusTag('在开会')).toEqual({ icon: 'edit', text: '在开会' });
      expect(parseStatusTag('晒太阳中')).toEqual({ icon: 'edit', text: '晒太阳中' });
    });

    test('空值 / null / undefined', () => {
      expect(parseStatusTag('')).toEqual({ icon: '', text: '' });
      expect(parseStatusTag('   ')).toEqual({ icon: '', text: '' });
      expect(parseStatusTag(null)).toEqual({ icon: '', text: '' });
      expect(parseStatusTag(undefined)).toEqual({ icon: '', text: '' });
    });

    test('非字符串输入不抛异常', () => {
      expect(parseStatusTag(123).text).toBe('123');
      expect(parseStatusTag({}).text).toBe('[object Object]');
    });
  });

  describe('normalizeStatusTag', () => {
    test('剥离历史 emoji 前缀，只留纯文本', () => {
      expect(normalizeStatusTag('😺 相遇了')).toBe('相遇了');
      expect(normalizeStatusTag('✏️ 在开会')).toBe('在开会');
      expect(normalizeStatusTag('相遇了')).toBe('相遇了');
    });
  });

  describe('decorateMeet', () => {
    test('输出 statusIcon / statusText 显示字段', () => {
      expect(decorateMeet({ statusTag: '😴 在睡觉' })).toEqual({ statusIcon: 'moon', statusText: '在睡觉' });
      expect(decorateMeet({ statusTag: '' })).toEqual({ statusIcon: '', statusText: '' });
      expect(decorateMeet(null)).toEqual({ statusIcon: '', statusText: '' });
    });
  });

  test('TAG_ICONS 恰好覆盖六选一', () => {
    expect(Object.keys(TAG_ICONS)).toEqual(['相遇了', '在睡觉', '在吃饭', '在玩耍', '在散步', '求摸摸']);
  });
});
