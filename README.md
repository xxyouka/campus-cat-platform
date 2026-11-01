# 校园猫猫

**校园猫咪信息管理平台 · 微信小程序 + 云开发**

一个可以长期维护的校园猫咪档案系统：猫咪图鉴、档案详情、相册、相遇打卡、关注、排行榜、公告、寻猫地图和完整的管理后台。

> 本仓库是“核心档案版”：聚焦猫咪档案与相遇记录，不包含支付、捐赠、第三方猫脸识别等可选模块。示例学校、校区和数据均为虚构，不包含任何真实学校、用户或猫咪数据。

## 项目入口

- **技术文档、功能清单、部署步骤、测试说明**：[`miniprogram/README.md`](./miniprogram/README.md)
- 小程序源码：[`miniprogram/`](./miniprogram)
- 校园地图编辑器：[`tools/campus-map-editor/`](./tools/campus-map-editor)
- 架构与部署文档：[`docs/`](./docs)
- 许可证：[AGPL-3.0](./LICENSE)

## 仓库结构

| 路径 | 说明 |
|------|------|
| [`miniprogram/`](./miniprogram) | 小程序主体：页面、组件、云函数、测试 |
| [`tools/campus-map-editor/`](./tools/campus-map-editor) | 单文件校园矢量地图编辑器 |
| [`docs/`](./docs) | 架构、部署、数据模型与安全说明 |
| [`.github/`](./.github) | CI 配置 |

## 快速开始

```bash
cd miniprogram
npm install
```

1. 用微信开发者工具导入 `miniprogram/`。
2. 把 `project.config.json` 的 `appid` 改成你自己的 AppID。
3. 把 `cloudbaserc.json` 的 `envId` 改成你的云开发环境 ID。
4. 在云开发控制台部署云函数、初始化数据库，并按 `cloudfunctions/ENV_VARS.md` 配置环境变量。
5. 在 `config.js` 里把学校名称和校区改成你自己的。

详细步骤见 [`miniprogram/README.md`](./miniprogram/README.md)。

## 说明

- 示例学校、校区、地图、分享卡和猫咪数据均为虚构内容，仅用于演示。
- 本项目与任何学校没有隶属或合作关系。
- 生产部署前请修改隐私政策、联系方式和数据保留策略。

## 许可证

本项目使用 [AGPL-3.0](./LICENSE) 许可证，版权归 `xxyouka` 所有。

<div align="center">
用代码守护校园里的每一只猫
</div>