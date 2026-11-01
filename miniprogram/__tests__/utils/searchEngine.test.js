const SearchEngine = require('../../utils/searchEngine');

describe('SearchEngine', () => {
  let engine;

  const mockItems = [
    { name: '橘猫', campus: '本部' },
    { name: '小白', campus: '东区' },
    { name: '大橘为重', campus: '本部' }
  ];

  const keywordExtractor = (item) => [item.name, item.campus];

  beforeEach(() => {
    engine = new SearchEngine();
  });

  test('buildIndex空数组清空索引', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    expect(engine.hasIndex()).toBe(true);

    engine.buildIndex([], keywordExtractor);
    expect(engine.hasIndex()).toBe(false);
  });

  test('buildIndex创建有效索引', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    expect(engine.hasIndex()).toBe(true);
  });

  test('buildIndex空值不创建索引', () => {
    engine.buildIndex(null, keywordExtractor);
    expect(engine.hasIndex()).toBe(false);

    engine.buildIndex(undefined, keywordExtractor);
    expect(engine.hasIndex()).toBe(false);
  });

  test('search返回匹配结果', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    const results = engine.search([{ type: 'fuzzy', value: '橘猫' }]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.name === '橘猫')).toBe(true);
  });

  test('search精确匹配', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    const results = engine.search([{ type: 'exact', value: '本部' }]);
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => {
      expect(r.campus).toBe('本部');
    });
  });

  test('search无匹配返回空数组', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    const results = engine.search([{ type: 'fuzzy', value: '不存在的猫' }]);
    expect(results).toEqual([]);
  });

  test('search无索引返回空数组', () => {
    const results = engine.search([{ type: 'fuzzy', value: '橘' }]);
    expect(results).toEqual([]);
  });

  test('search空条件返回全部数据', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    const results = engine.search([]);
    expect(results).toEqual(mockItems);
  });

  test('clear重置索引', () => {
    engine.buildIndex(mockItems, keywordExtractor);
    expect(engine.hasIndex()).toBe(true);

    engine.clear();
    expect(engine.hasIndex()).toBe(false);

    const results = engine.search([{ type: 'fuzzy', value: '橘' }]);
    expect(results).toEqual([]);
  });

  describe('highlightSegments', () => {
    test('高亮匹配的关键词', () => {
      const segments = SearchEngine.highlightSegments('橘猫小白', '橘猫');
      expect(segments).toEqual([
        { key: 'seg-0', text: '橘猫', highlight: true },
        { key: 'seg-1', text: '小白', highlight: false }
      ]);
    });

    test('无关键词返回整段不高亮', () => {
      const segments = SearchEngine.highlightSegments('橘猫', '');
      expect(segments).toEqual([{ key: 'seg-0', text: '橘猫', highlight: false }]);
    });

    test('空文本返回空段', () => {
      const segments = SearchEngine.highlightSegments('', '橘');
      expect(segments).toEqual([{ key: 'seg-0', text: '', highlight: false }]);
    });

    test('多次匹配全部高亮', () => {
      const segments = SearchEngine.highlightSegments('橘猫和橘猫', '橘猫');
      expect(segments).toEqual([
        { key: 'seg-0', text: '橘猫', highlight: true },
        { key: 'seg-1', text: '和', highlight: false },
        { key: 'seg-2', text: '橘猫', highlight: true }
      ]);
    });

    test('大小写不敏感', () => {
      const segments = SearchEngine.highlightSegments('Hello World', 'hello');
      expect(segments[0]).toEqual({ key: 'seg-0', text: 'Hello', highlight: true });
    });

    test('重复文本的分段 key 仍唯一（wxml 的 wx:key 依赖）', () => {
      // name「咪咪」+ keyword「咪」→ 两段 { text: '咪' }，旧实现 wx:key="text" 会重复
      const segments = SearchEngine.highlightSegments('咪咪', '咪');
      expect(segments.map(s => s.text)).toEqual(['咪', '咪']);
      expect(new Set(segments.map(s => s.key)).size).toBe(segments.length);
    });
  });

  describe('_extractNgrams', () => {
    test('single character keyword produces at least one gram', () => {
      const grams = engine._extractNgrams('a', 2, 3);
      expect(grams.length).toBeGreaterThan(0);
      expect(grams).toContain('a');
    });

    test('empty string produces no grams', () => {
      const grams = engine._extractNgrams('', 2, 3);
      expect(grams).toEqual([]);
    });

    test('two character string produces 2-gram', () => {
      const grams = engine._extractNgrams('ab', 2, 3);
      expect(grams).toContain('ab');
    });
  });

  describe('search with multiple conditions', () => {
    const multiItems = [
      { name: '橘猫', campus: '本部', color: '橘色' },
      { name: '橘猫小白', campus: '东区', color: '白色' },
      { name: '大橘为重', campus: '本部', color: '橘色' }
    ];

    const multiExtractor = (item) => [item.name, item.campus, item.color];

    test('multiple conditions produce intersection', () => {
      engine.buildIndex(multiItems, multiExtractor);
      const results = engine.search([
        { type: 'fuzzy', value: '橘猫' },
        { type: 'fuzzy', value: '本部' }
      ]);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.campus).toBe('本部');
      });
    });

    test('second condition with empty matches yields empty results', () => {
      engine.buildIndex(multiItems, multiExtractor);
      const results = engine.search([
        { type: 'fuzzy', value: '橘猫' },
        { type: 'fuzzy', value: '不存在的校区' }
      ]);
      expect(results).toEqual([]);
    });

    test('three conditions narrow results further', () => {
      engine.buildIndex(multiItems, multiExtractor);
      const results = engine.search([
        { type: 'fuzzy', value: '橘猫' },
        { type: 'fuzzy', value: '本部' },
        { type: 'fuzzy', value: '橘色' }
      ]);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.campus).toBe('本部');
        expect(r.color).toBe('橘色');
      });
    });
  });

  describe('_matchCondition with empty ngram intersection', () => {
    const gramItems = [
      { name: '橘猫', campus: '本部' },
      { name: '黑猫', campus: '东区' }
    ];

    const gramExtractor = (item) => [item.name, item.campus];

    test('fuzzy match with empty intersection falls back to exact match', () => {
      engine.buildIndex(gramItems, gramExtractor);
      engine._index.set('橘猫黑猫', new Set([0]));
      const result = engine._matchCondition({ type: 'fuzzy', value: '橘猫黑猫' });
      expect(result.size).toBeGreaterThan(0);
    });

    test('fuzzy match with empty intersection and no exact match returns empty', () => {
      engine.buildIndex(gramItems, gramExtractor);
      const result = engine._matchCondition({ type: 'fuzzy', value: '完全不匹配的关键词' });
      expect(result.size).toBe(0);
    });

    test('empty value returns empty set', () => {
      engine.buildIndex(gramItems, gramExtractor);
      const result = engine._matchCondition({ type: 'fuzzy', value: '' });
      expect(result.size).toBe(0);
    });
  });
});
