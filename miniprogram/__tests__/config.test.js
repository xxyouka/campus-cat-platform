jest.mock('../../project.config.json', () => ({
  setting: {
    envList: [{ env: 'test-cloud-env-id' }]
  }
}), { virtual: true });

const config = require('../../config');

describe('config', () => {
  describe('env', () => {
    test('should be a string', () => {
      expect(typeof config.env).toBe('string');
    });

    test('should be either development or production', () => {
      expect(['development', 'production']).toContain(config.env);
    });

    test('should be development in test environment', () => {
      expect(config.env).toBe('development');
    });
  });

  describe('cloudEnv', () => {
    test('should be a string or undefined', () => {
      expect(typeof config.cloudEnv === 'string' || config.cloudEnv === undefined).toBe(true);
    });
  });

  describe('version', () => {
    test('should be a string', () => {
      expect(typeof config.version).toBe('string');
    });

    test('should match semver format', () => {
      expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    // 2026-10-15：此前的硬编码期望在 3.6.1 → 3.6.2 发版时漏改，测试一度红着进仓。
    // 改为绑定 package.json（发版「六处同步」的单一来源之一），根治同类漂移。
    test('should match package.json version', () => {
      expect(config.version).toBe(require('../../package.json').version);
    });
  });

  describe('contact', () => {
    test('should be an object', () => {
      expect(typeof config.contact).toBe('object');
    });

    test('should have wechat property', () => {
      expect(config.contact).toHaveProperty('wechat');
    });

    test('should have email property', () => {
      expect(config.contact).toHaveProperty('email');
    });
  });

  describe('school', () => {
    test('should be an object', () => {
      expect(typeof config.school).toBe('object');
    });

    test('should have name property as string', () => {
      expect(typeof config.school.name).toBe('string');
      expect(config.school.name.length).toBeGreaterThan(0);
    });

    test('should have department property as string', () => {
      expect(typeof config.school.department).toBe('string');
      expect(config.school.department.length).toBeGreaterThan(0);
    });
  });

  describe('collections', () => {
    test('should be an object', () => {
      expect(typeof config.collections).toBe('object');
    });

    test('should have cats collection', () => {
      expect(config.collections.cats).toBe('cats');
    });

    test('should have photos collection', () => {
      expect(config.collections.photos).toBe('photos');
    });

    test('should have albums collection', () => {
      expect(config.collections.albums).toBe('albums');
    });

    test('should have admins collection', () => {
      expect(config.collections.admins).toBe('admins');
    });

    test('should have notices collection', () => {
      expect(config.collections.notices).toBe('notices');
    });

    test('should have recordMeet collection', () => {
      expect(config.collections.recordMeet).toBe('recordMeet');
    });

    test('should have login_attempts collection', () => {
      expect(config.collections.login_attempts).toBe('login_attempts');
    });

    test('should have health_records collection', () => {
      expect(config.collections.health_records).toBe('health_records');
    });

    
    test('should have userFavorites collection', () => {
      expect(config.collections.userFavorites).toBe('userFavorites');
    });

    test('should have notifications collection', () => {
      expect(config.collections.notifications).toBe('notifications');
    });

    test('should have userSubscriptions collection', () => {
      expect(config.collections.userSubscriptions).toBe('userSubscriptions');
    });

    test('should have subscribeQuota and mediaChecks collections', () => {
      expect(config.collections.subscribeQuota).toBe('subscribeQuota');
      expect(config.collections.mediaChecks).toBe('mediaChecks');
    });

    test('should have exactly 17 collections', () => {
      expect(Object.keys(config.collections)).toHaveLength(17);
    });

    test('should have userReports collection', () => {
      expect(config.collections.userReports).toBe('user_reports');
    });
  });

  describe('genderMap', () => {
    test('should be an object', () => {
      expect(typeof config.genderMap).toBe('object');
    });

    test('should map male to 公', () => {
      expect(config.genderMap.male).toBe('公');
    });

    test('should map female to 母', () => {
      expect(config.genderMap.female).toBe('母');
    });
  });

  describe('security', () => {
    test('should be an object', () => {
      expect(typeof config.security).toBe('object');
    });

    test('should have loginAttemptLimit as a number', () => {
      expect(typeof config.security.loginAttemptLimit).toBe('number');
      expect(config.security.loginAttemptLimit).toBe(5);
    });

    test('should have loginLockTime as a number', () => {
      expect(typeof config.security.loginLockTime).toBe('number');
      expect(config.security.loginLockTime).toBe(15 * 60 * 1000);
    });

    test('should have authSignatureExpiry as a number', () => {
      expect(typeof config.security.authSignatureExpiry).toBe('number');
      expect(config.security.authSignatureExpiry).toBe(1 * 60 * 60 * 1000);
    });

    test('should have maxNameLength as a number', () => {
      expect(typeof config.security.maxNameLength).toBe('number');
      expect(config.security.maxNameLength).toBe(50);
    });

    test('should have maxDescriptionLength as a number', () => {
      expect(typeof config.security.maxDescriptionLength).toBe('number');
      expect(config.security.maxDescriptionLength).toBe(500);
    });

    test('should have maxKeywordLength as a number', () => {
      expect(typeof config.security.maxKeywordLength).toBe('number');
      expect(config.security.maxKeywordLength).toBe(50);
    });

    test('should have objectIdPattern as a RegExp', () => {
      expect(config.security.objectIdPattern).toBeInstanceOf(RegExp);
    });

    test('should have objectIdPattern20to40 as a RegExp', () => {
      expect(config.security.objectIdPattern20to40).toBeInstanceOf(RegExp);
    });

    test('objectIdPattern should match 24-char hex strings', () => {
      expect(config.security.objectIdPattern.test('507f1f77bcf86cd799439011')).toBe(true);
    });

    test('objectIdPattern should not match invalid IDs', () => {
      expect(config.security.objectIdPattern.test('invalid')).toBe(false);
    });

    test('objectIdPattern20to40 should match 20-40 char hex strings', () => {
      expect(config.security.objectIdPattern20to40.test('a'.repeat(24))).toBe(true);
      expect(config.security.objectIdPattern20to40.test('a'.repeat(20))).toBe(true);
      expect(config.security.objectIdPattern20to40.test('a'.repeat(40))).toBe(true);
    });

    test('objectIdPattern20to40 should not match strings outside 20-40 range', () => {
      expect(config.security.objectIdPattern20to40.test('a'.repeat(19))).toBe(false);
      expect(config.security.objectIdPattern20to40.test('a'.repeat(41))).toBe(false);
    });
  });

  describe('performance', () => {
    test('should be an object', () => {
      expect(typeof config.performance).toBe('object');
    });

    test('should have imageRetryBaseDelay as a number', () => {
      expect(typeof config.performance.imageRetryBaseDelay).toBe('number');
    });

    test('should have imageRetryMaxAttempts as a number', () => {
      expect(typeof config.performance.imageRetryMaxAttempts).toBe('number');
    });

    test('should have imageConcurrentRetries as a number', () => {
      expect(typeof config.performance.imageConcurrentRetries).toBe('number');
    });

    test('should have setDataBatchSize as a number', () => {
      expect(typeof config.performance.setDataBatchSize).toBe('number');
    });

    test('should have prefetchAllBatchSize as a number', () => {
      expect(typeof config.performance.prefetchAllBatchSize).toBe('number');
    });

    test('should have queryTimeout as a number', () => {
      expect(typeof config.performance.queryTimeout).toBe('number');
      expect(config.performance.queryTimeout).toBe(5000);
    });

    test('should have cacheDuration object with short, medium, long', () => {
      expect(typeof config.performance.cacheDuration).toBe('object');
      expect(typeof config.performance.cacheDuration.short).toBe('number');
      expect(typeof config.performance.cacheDuration.medium).toBe('number');
      expect(typeof config.performance.cacheDuration.long).toBe('number');
    });

    test('should have cacheDuration values in ascending order', () => {
      const cd = config.performance.cacheDuration;
      expect(cd.short).toBeLessThan(cd.medium);
      expect(cd.medium).toBeLessThan(cd.long);
    });

    test('should have searchDebounceDelay as a number', () => {
      expect(typeof config.performance.searchDebounceDelay).toBe('number');
      expect(config.performance.searchDebounceDelay).toBe(300);
    });

    test('should have meetCheckDelay as a number', () => {
      expect(typeof config.performance.meetCheckDelay).toBe('number');
    });

    test('should have touchPreloadDelay as a number', () => {
      expect(typeof config.performance.touchPreloadDelay).toBe('number');
    });

    test('should have networkRecoveryToastDuration as a number', () => {
      expect(typeof config.performance.networkRecoveryToastDuration).toBe('number');
    });

    test('should have maxCatsLoadLimit as a number', () => {
      expect(typeof config.performance.maxCatsLoadLimit).toBe('number');
    });

    test('should have avatarCacheExpiry as a number', () => {
      expect(typeof config.performance.avatarCacheExpiry).toBe('number');
    });

    test('should have animation object with fadeIn, slideUp, pulse, staggerDelay', () => {
      expect(typeof config.performance.animation).toBe('object');
      expect(typeof config.performance.animation.fadeIn).toBe('number');
      expect(typeof config.performance.animation.slideUp).toBe('number');
      expect(typeof config.performance.animation.pulse).toBe('number');
      expect(typeof config.performance.animation.staggerDelay).toBe('number');
    });

    test('should have prefetchAllMaxBatches as a number', () => {
      expect(typeof config.performance.prefetchAllMaxBatches).toBe('number');
    });

    test('should have imageCacheExpireTime as a number', () => {
      expect(typeof config.performance.imageCacheExpireTime).toBe('number');
    });

    test('should have imageCacheMaxSize as a number', () => {
      expect(typeof config.performance.imageCacheMaxSize).toBe('number');
    });

    test('should have preloadQueueMaxSize as a number', () => {
      expect(typeof config.performance.preloadQueueMaxSize).toBe('number');
    });

    test('should have prefetchCacheExpiry as a number', () => {
      expect(typeof config.performance.prefetchCacheExpiry).toBe('number');
    });

    test('should have prefetchCacheCleanupInterval as a number', () => {
      expect(typeof config.performance.prefetchCacheCleanupInterval).toBe('number');
    });

    test('should have slowOperationThreshold as a number', () => {
      expect(typeof config.performance.slowOperationThreshold).toBe('number');
      expect(config.performance.slowOperationThreshold).toBe(1000);
    });
  });
});

/**
 * sitemap 与 app.json 的页面清单必须对得上。
 *
 * 背景（2026-10-21）：3.7/3.8 新增了 cat-activity 三个页面与 face-manage，
 * app.json 有 17 个 admin 页面，sitemap 只 disallow 了 13 个 —— 漏掉的 4 个
 * 会落到最后的 `allow *`，被微信搜索索引。管理页虽然后端有鉴权，但不该出现在
 * 搜索结果里；这类漏项靠人眼看两份 JSON 很难发现，故用测试钉住。
 */
describe('sitemap 管理端覆盖', () => {
  const appJson = require('../app.json');
  const sitemap = require('../sitemap.json');

  const mainPages = appJson.pages || [];
  const subPages = (appJson.subpackages || []).flatMap(pkg =>
    (pkg.pages || []).map(page => `${pkg.root}/${page}`)
  );
  const allPages = new Set([...mainPages, ...subPages]);
  const disallowed = new Set(
    (sitemap.rules || []).filter(rule => rule.action === 'disallow').map(rule => rule.page)
  );

  test('管理端分包内每个页面都必须 disallow', () => {
    const adminPkg = (appJson.subpackages || []).find(pkg => pkg.root === 'pages/admin');
    expect(adminPkg).toBeTruthy();
    const missing = adminPkg.pages
      .map(page => `pages/admin/${page}`)
      .filter(page => !disallowed.has(page));
    expect(missing).toEqual([]);
  });

  test('sitemap 的 disallow 页面都必须真实存在（防止删页后留下死规则）', () => {
    const stale = [...disallowed].filter(page => !allPages.has(page));
    expect(stale).toEqual([]);
  });
});
