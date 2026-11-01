# 架构说明

## 总览

```text
微信小程序（原生）
  ├─ pages/            用户主路径（首页、详情、相册、我的、相遇、排行、公告…）
  ├─ subpackages/      地图与反馈分包，按需加载
  ├─ components/       通用组件（导航、弹窗、懒加载、图标…）
  ├─ services/         猫咪、照片、相遇等业务服务
  └─ utils/            缓存、筛选、分享、埋点、引导等工具
          │
          │ wx.cloud.callFunction / 云数据库 / 云存储
          ▼
微信云开发 CloudBase
  ├─ cloudfunctions/   57 个云函数（读写接口、管理接口、定时任务）
  ├─ 云数据库          猫咪、照片、相遇、关注、公告、管理员等集合
  └─ 云存储            cats/、photos/ 等业务目录
```

## 前端分层

- **页面层**：每个页面只处理渲染与交互，业务请求下沉到 `services/` 与 `utils/`。
- **服务层**：`catService`、`photoService`、`meetService` 等封装分页、缓存与错误处理。
- **行为层**：`behaviors/` 复用缓存、网络监听、滚动保护、引导等逻辑。
- **组件层**：导航栏、弹窗、空状态、懒加载图片、图标等。
- **分包**：地图与反馈放入分包，首页/详情通过 `preloadRule` 在 Wi-Fi 下预下载。

## 云函数分层

- **公共模块**：`cloudfunctions/utils/` 下的 auth、sanitizer、response、constants、listSort、statusNotify 等是规范源，由 `scripts/sync-utils.js` 分发到各函数目录。
- **读接口**：猫咪列表、详情、相册、排行、公告、地图点位等，只读、无副作用。
- **写接口**：添加/编辑猫咪、上传照片、打卡、关注、反馈等，先鉴权/校验再写库。
- **管理接口**：管理员登录、权限管理、内容复核、操作日志、导出、备份等。
- **定时任务**：保活、备份、对账、走失扫描等，只接受平台定时触发，拒绝客户端伪造。

## 鉴权

管理员身份只来自云函数内的 `cloud.getWXContext().OPENID`。管理端权限按入口 key 白名单校验，未知 key 不生效；超级管理员与创始人拥有全量权限。客户端传入的任何身份字段都不参与鉴权。

## 地图坐标

猫咪点位以归一化 `u/v`（0~1）入库，渲染时按底图像素尺寸换算。底图按校区登记在 `utils/campusMapRegistry.js`，一个校区一张图；没有底图的校区不会回退到本部，避免坐标错位。

## 测试与门禁

- Jest 单元/契约测试覆盖页面、云函数、工具与行为。
- `scripts/check-*.js` 负责包体积、图标、引导 selector、设计 token 等静态门禁。
- `scripts/build-cloud.js` 与 `scripts/sync-utils.js` 保证云函数公共模块副本与规范源一致。
- `.github/workflows/ci.yml` 在 push / PR 时执行上述检查。