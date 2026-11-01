// jest.config.js - Jest 测试配置
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'utils/**/*.js',
    'services/**/*.js',
    'behaviors/**/*.js',
    'cloudfunctions/utils/**/*.js',
    // 云函数入口：业务逻辑、鉴权接线与写库分支都在这里，不能排除在统计之外
    'cloudfunctions/*/index.js',
    // 云函数公共目录（operationLogger 等 canonical 源）
    'cloudfunctions/common/**/*.js',
    'components/**/*.js',
    'pages/**/*.js',
    // 3.10.3 起寻猫地图下沉到 subpackages/map：只写 pages/ 会让它掉出统计，
    // 覆盖率棘轮形同虚设（文件不在 map 里，路径阈值恒放行）。分包一并纳入。
    'subpackages/**/*.js',
    'app.js',
    'config.js',
    '!**/node_modules/**',
    '!**/vendor/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html'],
  // 阈值一律按「实测值下浮若干个百分点」设定（棘轮：只许升不许降）。
  // 注意 jest 的两条规则：
  //   1. 每个文件只会归入「键顺序中首个匹配」的阈值组，故具体路径必须写在通配/聚合之前；
  //   2. 带 glob 的键是**逐文件**判定，目录前缀键是**聚合**判定。
  coverageThreshold: {
    // 全局：实测 statements 80.62% / lines 82.24% / branches 70.71% / functions 79.21%
    // （注：本轮有 2 个 pages 套件处于其他角色的在途改动导致的失败态，
    //  collectCoverage 相应少跑了若干函数，函数覆盖率由 79.39% 微降到 79.21%；
    //  全绿复测后应回到 79.39% 以上。阈值未动，棘轮方向仍是只许升不许降。）
    global: {
      branches: 65,
      functions: 74,
      lines: 77,
      statements: 76
    },
    // 输入清洗是用户输入的第一道闸门，单独卡高线
    // 实测 statements 86.66% / lines 87.05% / branches 85.93% / functions 81.81%
    './cloudfunctions/utils/sanitizer.js': {
      branches: 80,
      functions: 76,
      lines: 82,
      statements: 82
    },
    // 鉴权地基：checkAdmin 决定谁能写库，checkOwnership 决定谁能动别人的资源。
    // 此前从未被任何测试 require（8 个入口测试一律 jest.mock 掉它，requireActual 全库 0 次），
    // 现已由 __tests__/cloudfunctions/auth.test.js 直接加载 canonical 源并做变异验证（7/7 变异变红）。
    // 实测 statements 94.36% / lines 94.28% / branches 90.69% / functions 91.66%
    // 未覆盖的 137-140 是 cleanExpired()：全库无调用方（缓存已在读取时惰性过期），
    // 属既有死代码，不为其改动导出面，故阈值按当前实测下浮设定。
    './cloudfunctions/utils/auth.js': {
      branches: 85,
      functions: 86,
      lines: 90,
      statements: 90
    },
    // 内容安全闸门：不合格文本/图片必须拦住，异常必须失败关闭。
    // 同上，由 __tests__/cloudfunctions/contentSecurity.test.js 直接加载并变异验证（12/12 变异变红）。
    // 实测 statements 100% / lines 100% / branches 90.62% / functions 100%
    // （未覆盖分支为 warn 里 `err.message || err` 的兜底侧）
    './cloudfunctions/utils/contentSecurity.js': {
      branches: 85,
      functions: 95,
      lines: 95,
      statements: 95
    },
    // 云函数入口（业务逻辑 + 鉴权接线 + 写库分支）逐文件下限。
    //
    // 【能力边界，务必读】这组阈值**不能**保证「每个入口都被真实执行过」：
    // Jest 只对出现在 coverage map 里的文件套路径阈值，从未被 require 的文件
    // 根本不进 map，阈值对它恒为放行。曾经有 22 个入口（含 8 个写库路径）
    // 整个从统计里消失，而 exit code 仍是 0。
    // 「入口必须被测试加载过」这件事由
    // __tests__/cloudfunctions/entryCoverageGuard.test.js 直接清点 require 关系，
    // 并以债务上限棘轮防止新增函数漏补测试。
    // 这里保留阈值仍有意义：拦住「被加载了但覆盖率极低」的文件。
    // 实测最弱者 manageAdmin/index.js：lines 87.5% / branches 78.26%
    './cloudfunctions/*/index.js': {
      branches: 5,
      functions: 20,
      lines: 15,
      statements: 15
    }
  },
  // 注：以上具体路径键必须排在 './cloudfunctions/*/index.js' 之前 —— jest 对每个文件
  // 只采用「键顺序中首个匹配」的阈值组（见本文件顶部第 1 条规则）。
  moduleNameMapper: {
    '^../../utils/(.*)$': '<rootDir>/utils/$1',
    '^../../services/(.*)$': '<rootDir>/services/$1',
    '^../../behaviors/(.*)$': '<rootDir>/behaviors/$1',
    '^../../config$': '<rootDir>/config.js',
    // 主包 package.json（版本号「六处同步」的单一来源）：「根级」测试文件（__tests__/ 根下）
    // 的 '..' 已到仓库根，需要与上一行 config 同因的映射修正（版本断言用）。
    '^../../package.json$': '<rootDir>/package.json',
    // 只覆盖前端（services/、behaviors/、pages/、components/）对主包 utils/ 的相对引用。
    // 不能写成 '^../utils/(.*)$' 通配：云函数内部同样存在 require('../utils/xxx')
    // （cloudfunctions/common/operationLogger.js 及其 10 个副本 → '../utils/constants'），
    // 通配规则会把它们劫持到主包 utils/（且主包并无 constants.js），
    // 导致审计日志等模块无法通过 jest 模块系统加载、相关链路完全不可测。
    '^../utils/(adminAuth|avatarHelper|dateFormat|dbFields|errorHandler|imageLoader|imageRetryManager|logger|network|obsHelper|performanceMonitor|photoUtils)$': '<rootDir>/utils/$1',
    '^wx-server-sdk$': '<rootDir>/__tests__/__mocks__/wx-server-sdk.js'
  },
  setupFiles: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 10000
};
