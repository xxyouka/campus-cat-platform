// ESLint 配置文件
// 用于统一团队代码规范（加强版）

module.exports = {
  root: true,
  extends: [
    'eslint:recommended'
  ],
  
  // 环境配置
  env: {
    browser: true,
    node: true,
    es2021: true,
    jest: true
  },
  
  // 解析器选项
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module'
  },

  overrides: [
    {
      files: ['**/__tests__/**/*.js', '**/*.test.js'],
      env: {
        jest: true
      },
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
        'max-len': 'off',
        'no-console': 'off'
      }
    },
    {
      // 构建/工具脚本使用 console 输出是正常行为
      files: ['scripts/**/*.js'],
      rules: {
        'no-console': 'off'
      }
    },
    {
      // 云函数使用 console.log 进行 CloudBase 日志输出（标准做法）
      files: ['cloudfunctions/**/*.js'],
      rules: {
        'no-console': 'off'
      }
    },
    {
      // logger 模块本身就需要调用 console
      files: ['utils/logger.js'],
      rules: {
        'no-console': 'off'
      }
    },
    {
      // 校园底图由 campus-map-editor 自动导出为 JS（小程序不能 require JSON）；
      // 保留其 JSON 双引号数据格式，不把工具生成内容列入单引号风格告警。
      files: ['images/campus-map/campus-map.js', 'images/campus-map/campus-map-north.js'],
      rules: {
        'quotes': ['warn', 'double', { 'avoidEscape': true }]
      }
    },
    {
      // filePathGuard 的字符白名单**故意**用控制字符区间 [\u0000-\u001f] 来
      // 拒绝畸形 cloudPath。这是防御性校验的核心手段，不是误写：
      // 一旦改成\"列举安全字符\"，中文文件名（捐赠 Excel）就会被拦下。
      // no-control-regex 在此处必须豁免，否则只能靠改坏安全逻辑来消警告。
      files: ['**/filePathGuard.js'],
      rules: {
        'no-control-regex': 'off'
      }
    }
  ],
  
  rules: {
    // ==================== 错误级别（必须修复）====================
    
    // 禁止未使用的变量（允许以_开头的变量）
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_', 
      varsIgnorePattern: '^_' 
    }],
    
    // 强制使用 === 和 !==（禁止 == 和 !=）
    'eqeqeq': ['error', 'always'],
    
    // 禁止使用alert/confirm（小程序环境不支持）
    'no-alert': 'error',
    
    // 禁止抛出字面量错误（必须抛出Error对象）
    'no-throw-literal': 'error',
    
    // 禁止在finally块中使用控制流语句
    'no-unsafe-finally': 'error',
    
    // 要求return/throw/continue/break后必须有代码不可达
    'no-unreachable': 'error',
    
    // ==================== 警告级别（建议修复）====================

    // 禁止变量遮蔽（no-shadow）
    // 加这条的直接原因：pages/admin/admin.js 的 loadStats() 里
    //   const stats = ddata.stats || {}   // 遮蔽了外层 let stats
    // 导致超管捐赠统计读到的始终是新声明的空对象，金额/人数恒为 0 且无任何报错。
    // 这类 bug 极难靠读代码发现（不报错、能跑、只是数值一直不对），必须靠 lint 兜住。
    'no-shadow': 'warn',

    // 强制使用const（优先）/ let
    'prefer-const': 'warn',
    
    // 禁止不必要的括号
    'no-extra-parens': 'warn',
    
    // console使用限制（生产环境应移除）
    'no-console': ['warn', { 
      allow: ['warn', 'error', 'info']  // 允许警告和错误日志
    }],
    
    // 调试器语句（debugger）
    'no-debugger': 'warn',
    
    // 空函数体（保留注释的空函数）
    'no-empty-function': ['warn', { 
      allow: ['arrowFunctions', 'functions', 'methods'] 
    }],
    
    // ==================== 风格建议（可选）====================
    
    // 缩进风格（2空格）
    'indent': ['warn', 2, { 'SwitchCase': 1 }],

    'quotes': ['warn', 'single', { 'avoidEscape': true }],
    
    // 分号（必须）
    'semi': ['error', 'always'],
    
    // 最大行长度（120字符）
    'max-len': ['warn', { 
      code: 120,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true
    }],
    
    // 函数最大行数（100行）
    'max-lines-per-function': ['warn', { 
      max: 100,
      skipBlankLines: true,
      skipComments: true
    }],
    
    // 圈复杂度（最多20）
    'complexity': ['warn', { max: 20 }],
    
    // 文件最大行数（500行）
    'max-lines': ['warn', { 
      max: 500, 
      skipComments: true 
    }]
  },
  
  globals: {
    // 微信小程序全局对象
    wx: 'readonly',
    getApp: 'readonly',
    App: 'readonly',
    Page: 'readonly',
    Component: 'readonly',
    getCurrentPages: 'readonly',
    Behavior: 'readonly',
    require: 'readonly',
    module: 'readonly',
    console: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    Promise: 'readonly',
    Date: 'readonly',
    JSON: 'readonly',
    Math: 'readonly',
    Object: 'readonly',
    Array: 'readonly',
    String: 'readonly',
    Number: 'readonly',
    Boolean: 'readonly',
    Error: 'readonly',
    Map: 'readonly',
    Set: 'readonly',
    RegExp: 'readonly',
    // __tests__/setup.js 挂到 global 的桩工厂（resetWxStubs、mockCommand）
    mockCommand: 'readonly',
    resetWxStubs: 'readonly'
  },
  
  // 忽略特定文件/目录
  ignorePatterns: [
    'node_modules/',
    'miniprogram_npm/',
    '**/miniprogram_npm/**',
    '*.min.js',
    '*.config.js'   // 配置文件通常需要特殊语法
  ]
};
