/**
 * 文档数字守卫（公开核心版）
 *
 * README 里的版本、页面数、工具类数、云函数数、测试套件数与覆盖率，
 * 必须和仓库实际状态一致。数字过期会直接误导第一次阅读仓库的人。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('文档数字守卫', () => {
  const pkg = JSON.parse(read('package.json'));
  const readme = read('README.md');
  const appJson = JSON.parse(read('app.json'));
  const cloudbaserc = JSON.parse(read('cloudbaserc.json'));
  const jestCfg = require('../jest.config');

  test('README 版本徽章与 package.json 一致', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readme).toContain(`version-v${pkg.version}-brightgreen`);
  });

  test('getConfig 的兜底版本与 package.json 一致', () => {
    const src = read('cloudfunctions/getConfig/index.js');
    expect(src).toContain(`'${pkg.version}'`);
  });

  test('README 的页面数与 app.json 一致', () => {
    const adminPkg = (appJson.subpackages || []).find(sp => sp.root === 'pages/admin');
    const mapPkg = (appJson.subpackages || []).find(sp => sp.root === 'subpackages/map');
    expect(adminPkg).toBeTruthy();
    expect(mapPkg).toBeTruthy();
    expect(readme).toContain(`${appJson.pages.length}个主包`);
    expect(readme).toContain(`${adminPkg.pages.length}个管理子包`);
    expect(readme).toContain(`地图分包 (${mapPkg.pages.length}个页面`);
  });

  test('README 的 utils 文件数与磁盘一致', () => {
    const count = fs.readdirSync(path.join(ROOT, 'utils')).filter(f => f.endsWith('.js')).length;
    expect(readme).toContain(`工具类 (${count}个)`);
  });

  test('README 的云函数数与 cloudbaserc.json 一致', () => {
    const fnCount = (cloudbaserc.functions || []).length;
    expect(readme).toContain(`${fnCount}个云函数`);
  });

  test('README 测试套件数与磁盘上的 .test.js 数量一致', () => {
    const countSuites = (dir) => {
      let n = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) n += countSuites(full);
        else if (/\.test\.js$/.test(entry.name)) n += 1;
      }
      return n;
    };
    const suites = countSuites(path.join(ROOT, '__tests__'));
    expect(readme).toContain(`| 测试套件 | ${suites} |`);
  });

  test('README 覆盖率不低于 jest 棘轮阈值', () => {
    const statements = readme.match(/\| 语句覆盖率 \| ([\d.]+)% \|/);
    const branches = readme.match(/\| 分支覆盖率 \| ([\d.]+)% \|/);
    expect(statements).not.toBeNull();
    expect(branches).not.toBeNull();
    expect(parseFloat(statements[1])).toBeGreaterThanOrEqual(jestCfg.coverageThreshold.global.statements);
    expect(parseFloat(branches[1])).toBeGreaterThanOrEqual(jestCfg.coverageThreshold.global.branches);
  });

  test('仓库根 README 指向 miniprogram/README.md，且不重复数量指标', () => {
    const repoReadme = fs.readFileSync(path.join(ROOT, '..', 'README.md'), 'utf8');
    expect(repoReadme).toContain('miniprogram/README.md');
    expect(repoReadme).not.toMatch(/\d+\s*个测试套件|\d+\s*个测试用例|\d+\s*套件\s*\/\s*\d+\s*用例/);
    expect(repoReadme).not.toMatch(/语句覆盖率|分支覆盖率/);
    expect(repoReadme).not.toMatch(/version-v\d+\.\d+\.\d+/);
  });
});