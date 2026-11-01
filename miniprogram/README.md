# 校园猫猫 · 校园猫咪信息管理平台

<p align="center">
  <img src="https://img.shields.io/badge/version-v3.11.3-brightgreen" alt="Version">
  <img src="https://img.shields.io/badge/platform-微信小程序-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-orange" alt="License">
</p>

<p align="center">
  <strong>给校园猫咪做一份能被长期维护的档案</strong>
</p>

一个面向校园场景的猫咪信息管理平台：微信小程序原生开发 + 腾讯云开发（CloudBase）。包含猫咪图鉴、档案详情、相册、相遇打卡、关注、排行榜、公告、寻猫地图和一套完整的管理后台。

> 本仓库是“核心档案版”：聚焦猫咪档案、相遇记录和日常运营，不包含支付、捐赠、第三方猫脸识别等可选模块。示例学校、校区和数据均为虚构，不包含任何真实学校、用户或猫咪数据。

## 功能

### 用户端

| 功能 | 说明 |
|------|------|
| 猫咪图鉴 | 卡片式列表，支持搜索、按区域/状态/花色/性别/星级筛选 |
| 猫咪详情 | 档案信息、照片、相遇动态、关注、分享 |
| 猫咪相册 | 瀑布流相册与单猫相册，支持保存和分享 |
| 相遇打卡 | 记录相遇时间、地点和一句话；同一只猫 1 小时内只记一次 |
| 我的关注 | 关注列表、动态、快速取消 |
| 相遇记录 | 相遇日历、连续天数、累计天数 |
| 排行榜 | 相遇榜、关注榜 |
| 公告 | 校园猫咪相关通知 |
| 站内消息 | 关注更新、反馈处理结果 |
| 寻猫地图 | 按校区展示猫咪出没位置，打卡时可在地图上选点 |
| 反馈与上报 | 档案纠错、受伤/异常、走失等反馈 |
| 隐私政策 / 使用帮助 | 站内可查，不依赖外部文档 |

### 管理端

- 猫咪管理：添加、编辑、删除、批量排序
- 照片管理：相册、上传、内容安全检测
- 公告管理、关系管理
- 管理员与入口权限管理
- 操作日志
- 相遇 / 关注排行
- 猫咪行动分析（只读）
- 内容复核队列
- 用户反馈处理
- 运营看板（新用户激活、首个打卡、关注后回访）

## 技术栈

```text
前端  微信小程序原生开发（WXML + WXSS + JS）
后端  微信云开发（云函数 + 云数据库 + 云存储）
测试  Jest 29
规范  ESLint + Stylelint
图标  Phosphor Icons（字体子集）
```

## 项目结构

```text
miniprogram/
├── pages/                      # 12个主包
│   ├── index/                  # 首页图鉴
│   ├── detail/                 # 猫咪详情
│   ├── gallery/                # 相册 + 单猫相册
│   ├── profile/                # 我的
│   ├── favorites/              # 我的关注
│   ├── meets/                  # 相遇记录
│   ├── rank/                   # 排行榜
│   ├── notice/                 # 公告
│   ├── notifications/          # 站内消息
│   ├── privacy/                # 隐私政策
│   ├── help/                   # 使用帮助
│   └── admin/                  # 18个管理子包
├── subpackages/
│   ├── map/                    # 地图分包 (1个页面)
│   └── feedback/               # 反馈分包 (1个页面)
├── components/                 # 自定义组件
├── behaviors/                  # 页面行为
├── services/                   # 业务服务层
├── utils/                      # 工具类 (34个)
├── cloudfunctions/             # 57个云函数
├── styles/                     # 全局样式
├── images/                     # 图标、演示地图、分享卡
├── assets/                     # 图标字体与声明
├── __tests__/                  # 测试
├── scripts/                    # 构建、校验、同步脚本
├── app.js / app.json / app.wxss
├── config.js                   # 应用配置（示例值）
├── project.config.json         # 微信开发者工具配置
└── cloudbaserc.json            # 云开发部署清单
```

## 快速开始

### 1. 准备环境

- 微信开发者工具（最新稳定版）
- 已注册的小程序 AppID
- 已开通微信云开发环境
- Node.js >= 18

### 2. 安装依赖

```bash
npm install
```

如果使用微信开发者工具的 npm 构建，请在工具里执行「工具 → 构建 npm」。

### 3. 配置 AppID 与云环境

1. 打开 `project.config.json`，把 `appid` 从 `touristappid` 改成你的 AppID。
2. 打开 `cloudbaserc.json`，把 `envId` 改成你的云开发环境 ID。
3. 打开 `config.js`，把 `school` 改成你的学校/组织名称；示例值为「示例大学 / 示例学院」。

> `project.config.json` 默认使用 `touristappid`，只用于在开发者工具里打开项目；云开发能力需要你自己的 AppID 和云环境。

### 4. 部署云函数与数据库

1. 在微信开发者工具中打开「云开发」，选择你的环境。
2. 右键 `cloudfunctions` 下的函数，选择「上传并部署：云端安装依赖」；也可以使用 `scripts/deploy-cloud.sh`。
3. 首次部署后运行 `initDatabase` 云函数初始化集合与索引（需要管理员身份或按函数内说明操作）。
4. 在云开发控制台按 `cloudfunctions/ENV_VARS.md` 配置管理员账号、密码盐值等环境变量。

### 5. 打开项目

用微信开发者工具导入本目录（`miniprogram/`），编译后即可浏览示例页面。没有数据时页面会显示空状态；添加猫咪需要先登录管理端。

## 配置说明

| 配置 | 位置 | 说明 |
|------|------|------|
| AppID | `project.config.json` | 改成自己的小程序 AppID |
| 云环境 | `cloudbaserc.json`、开发者工具 | 改成自己的 CloudBase 环境 ID |
| 学校名称 | `config.js` 的 `school` | 首页/我的/隐私页展示 |
| 校区 | `pages/index/index.js` 的 `campusOptions`、`utils/campusMapRegistry.js` | 与猫咪档案里的 `campus` 保持一致 |
| 地图数据 | `images/campus-map/` | 当前为虚构演示校区，可替换成自己的矢量地图 |
| 订阅消息 | `config.js` 的 `subscribe*TemplateId` | 留空即关闭微信订阅推送；填写后需同步云函数环境变量 |
| 管理员 | 云函数环境变量 | `ADMIN_ACCOUNT` / `ADMIN_PASSWORD` / `PASSWORD_SALT` / `SUPER_ACCOUNT` 等，详见 `cloudfunctions/ENV_VARS.md` |
| 联系方式 | 云函数 `getConfig` 的环境变量 | 不在代码里硬编码 |

云函数环境变量里的版本号示例：`APP_VERSION = 3.11.3`（由 `scripts/version.js` 统一维护）。

## 测试与质量门禁

```bash
npm test                 # Jest + 覆盖率
npm run lint             # ESLint
npm run stylelint        # Stylelint
npm run check:pack       # 主包/分包体积
npm run check:icons      # 图标门禁
npm run check:guidance   # 引导 selector 门禁
npm run build-cloud:verify       # 云函数公共模块一致性
npm run build-cloud:verify-sync  # 云函数 utils 副本一致性
npm run check            # 以上全部
```

当前质量基线：

| 指标 | 数值 |
|------|------|
| 主包 | 12个主包 |
| 管理子包 | 18个管理子包 |
| 地图分包 | 1个页面 |
| 工具类 | 34个 |
| 云函数 | 57个 |
| 测试套件 | 173 |
| 测试用例 | 3638 |
| 语句覆盖率 | 78.6% |
| 分支覆盖率 | 69.0% |

> 测试数字由 `__tests__/docsConsistencyGuard.test.js` 守卫：改了测试或页面数量，README 不同步会直接变红。

## 安全模型

- 管理员身份只认云函数里的 `cloud.getWXContext().OPENID`，不接受请求体传入的身份字段。
- 管理端入口按权限 key 授权；超级管理员/创始人拥有全量权限。
- 用户端浏览无需登录；打卡、关注只关联匿名 OpenID，不获取头像和昵称。
- 管理员密码使用加盐哈希，盐值与账号通过云函数环境变量配置，不入库、不入代码。
- 上传图片会走微信内容安全检测；检测不通过的媒体进入复核队列。
- 云存储只允许 `cats/`、`photos/` 等业务前缀，备份与导出目录不对外开放。

## 数据与隐私

- 仓库不包含真实用户数据、猫咪数据、云存储文件或任何密钥。
- 示例地图、分享卡和学校名称均为虚构/占位内容。
- 部署到生产环境前，请根据自己的学校/组织情况修改隐私政策、联系方式与数据保留策略。

## 许可证

本项目使用 [AGPL-3.0](../LICENSE) 许可证，版权归 `xxyouka` 所有。

- 你可以自由使用、修改、分发本项目；如果你把修改后的版本作为网络服务提供，需要公开对应源代码。
- 第三方依赖与图标遵循各自许可证，Phosphor Icons 的 MIT 声明见 `assets/icons/LICENSE-phosphor.txt`。

## 说明

本项目是一个通用校园猫咪信息管理平台的公开核心版，与任何学校没有隶属或合作关系。仓库中的学校名称、校区、地图、猫咪名称和数据均为示例，仅用于演示功能。