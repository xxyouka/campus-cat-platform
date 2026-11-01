# 部署说明

## 前置条件

- 微信小程序账号与 AppID
- 已开通的微信云开发环境
- 微信开发者工具
- Node.js >= 18

## 1. 配置项目

```bash
cd miniprogram
npm install
```

修改：

- `project.config.json` 的 `appid`：改成你的小程序 AppID。
- `cloudbaserc.json` 的 `envId`：改成你的云开发环境 ID。
- `config.js` 的 `school`：改成你的学校/组织名称。
- `config.js` 的 `campusOptions`（在 `pages/index/index.js`）与 `utils/campusMapRegistry.js`：改成你的校区。
- `images/campus-map/`：当前是虚构演示校区，可替换成自己的矢量地图。

## 2. 部署云函数

在微信开发者工具中打开云开发，选择环境，然后：

- 右键 `cloudfunctions` 下的函数，选择「上传并部署：云端安装依赖」；或
- 使用 `scripts/deploy-cloud.sh`（按脚本注释配置环境变量）。

公共模块（`cloudfunctions/utils/`、`cloudfunctions/common/`）会由脚本分发到各函数目录；部署前先执行：

```bash
npm run build-cloud:copy
npm run build-cloud:sync-utils
npm run build-cloud:verify
npm run build-cloud:verify-sync
```

## 3. 初始化数据库

运行 `initDatabase` 云函数创建集合与索引。首次运行需要管理员身份或按函数内注释在云开发控制台手动执行。

## 4. 配置环境变量

按 `cloudfunctions/ENV_VARS.md` 在云开发控制台配置：

- `PASSWORD_SALT`：管理员密码盐值
- `ADMIN_ACCOUNT` / `ADMIN_PASSWORD`：内置管理员账号与预哈希密码
- `SUPER_ACCOUNT` / `SUPER_PASSWORD`：创始人账号（可选）
- `APP_VERSION`：云函数侧版本号
- 订阅消息模板 ID（可选）：`SUBSCRIBE_STATUS_TEMPLATE_ID`、`SUBSCRIBE_MEET_TEMPLATE_ID`、`SUBSCRIBE_NEW_CAT_TEMPLATE_ID`

密码必须是预哈希值，不能填明文；生成方式见 `ENV_VARS.md`。

## 5. 配置云存储

创建云存储目录并设置权限：

- `cats/`：猫咪头像
- `photos/`：猫咪照片

客户端只读取经过云函数校验的 fileID；备份与导出目录不对客户端开放。

## 6. 配置小程序后台

- 在微信公众平台配置隐私保护指引，指向 `pages/privacy/privacy`。
- 如需订阅消息推送，在「订阅消息 → 我的模板」创建模板，把模板 ID 填入 `config.js` 和云函数环境变量。
- 如使用地图选点，不需要 `wx.getLocation` 等隐私接口；地图是本地矢量底图。

## 7. 本地检查

```bash
npm run check
```

或分步执行：

```bash
npm run lint
npm run stylelint
npm test
npm run check:pack
npm run check:icons
npm run check:guidance
npm run build-cloud:verify
npm run build-cloud:verify-sync
```

## 8. 发布

用微信开发者工具上传版本，在公众平台提交审核。审核前确认：

- 隐私政策、联系方式、学校名称已替换；
- 没有真实用户数据或密钥；
- 管理端入口有权限保护；
- 图片内容安全检测已启用。