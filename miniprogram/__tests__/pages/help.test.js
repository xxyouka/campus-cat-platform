const mockContact = { wechat: 'cat_admin', email: 'cat@example.com' };
const mockObs = { reportEvent: jest.fn(), EVENT_NAMES: { HELP_VIEW: 'help_view', HELP_FAQ_EXPAND: 'help_faq_expand', FEATURE_FIRST_USE: 'feature_first_use' } };

jest.mock('../../utils/contactHelper', () => ({
  normalizeContact: jest.fn(contact => ({
    wechat: contact && contact.wechat ? contact.wechat : '暂未配置',
    email: contact && contact.email ? contact.email : '暂未配置'
  })),
  loadContact: jest.fn(() => Promise.resolve(mockContact))
}));
jest.mock('../../utils/obsHelper', () => mockObs);

let pageDef;

beforeAll(() => {
  global.Page = jest.fn(obj => { pageDef = obj; return obj; });
  require('../../pages/help/help');
});

beforeEach(() => {
  jest.clearAllMocks();
});

function createInstance(dataOverrides) {
  const inst = {
    data: { ...JSON.parse(JSON.stringify(pageDef.data)), ...dataOverrides },
    setData: jest.fn(function(updates) {
      Object.keys(updates).forEach(key => {
        if (key.includes('.')) {
          const [outer, inner] = key.split('.');
          const current = this.data[outer] || {};
          this.data[outer] = { ...current, [inner]: updates[key] };
        } else {
          this.data[key] = updates[key];
        }
      });
    }),
  };
  Object.keys(pageDef).forEach(key => {
    if (typeof pageDef[key] === 'function' && !inst[key]) inst[key] = pageDef[key].bind(inst);
  });
  return inst;
}

describe('help page', () => {
  test('内容分三组：第一次来 / 功能怎么用 / 常见问题', () => {
    expect(pageDef.data.groups.map(group => group.title)).toEqual(['第一次来', '功能怎么用', '常见问题']);
    pageDef.data.groups.forEach(group => {
      expect(group.items.length).toBeGreaterThan(0);
      group.items.forEach(item => {
        expect(item.id).toBeTruthy();
        expect(item.q).toBeTruthy();
        expect(item.a).toBeTruthy();
      });
    });
  });

  test('onLoad 按版本倒序整理新功能，并上报打开帮助', () => {
    const inst = createInstance();
    inst.onLoad();

    expect(inst.data.releases.length).toBeGreaterThan(0);
    expect(inst.data.releases[0].version).toBe('3.11.3');
    expect(mockObs.reportEvent).toHaveBeenCalledWith('help_view', {});
  });

  test('onLoad 会加载联系方式', async () => {
    const inst = createInstance();
    inst.onLoad();
    await Promise.resolve();
    await Promise.resolve();
    expect(inst.data.contact).toEqual(mockContact);
  });

  test('toggleItem 展开 / 收起，只在展开时上报', () => {
    const inst = createInstance();
    const id = inst.data.groups[0].items[0].id;

    inst.toggleItem({ currentTarget: { dataset: { id } } });
    expect(inst.data.openId).toBe(id);
    expect(mockObs.reportEvent).toHaveBeenCalledWith('help_faq_expand', { id });

    mockObs.reportEvent.mockClear();
    inst.toggleItem({ currentTarget: { dataset: { id } } });
    expect(inst.data.openId).toBe('');
    expect(mockObs.reportEvent).not.toHaveBeenCalled();
  });

  test('新功能条目会过滤掉空文案', () => {
    const inst = createInstance();
    inst.onLoad();
    inst.data.releases.forEach(release => {
      release.items.forEach(item => expect(item.text).toBeTruthy());
    });
  });

  test('功能入口按分组列出全部可直接进入的功能', () => {
    const inst = createInstance();
    inst.onLoad();
    const labels = inst.data.entryGroups.map(group => group.label);
    expect(labels).toContain('开始');
    expect(labels).toContain('逛猫');
    expect(labels).toContain('记录');
    expect(labels).toContain('支持');
    const pages = inst.data.entryGroups.reduce((acc, group) => acc.concat(group.items.map(item => item.page)), []);
    expect(pages).toContain('pages/index/index');
    expect(pages).toContain('subpackages/map/campus-map/campus-map');
    // 帮助页自身不列进入口
    expect(pages).not.toContain('pages/help/help');
    // 需要猫咪上下文的页面保留说明，但不给直达按钮
    const detail = inst.data.entryGroups
      .reduce((acc, group) => acc.concat(group.items), [])
      .find(item => item.page === 'pages/detail/detail');
    expect(detail.linkable).toBe(false);
  });

  test('点「去看看」跳到对应页面：Tab 用 switchTab，其余用 navigateTo', () => {
    const inst = createInstance();
    inst.onLoad();

    inst.onOpenEntry({ currentTarget: { dataset: { page: 'pages/rank/rank' } } });
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/rank/rank' });

    inst.onOpenEntry({ currentTarget: { dataset: { page: 'pages/index/index' } } });
    expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/index/index' });
    expect(mockObs.reportEvent).toHaveBeenCalledWith('feature_first_use', { feature: 'help_entry' });
  });
});
