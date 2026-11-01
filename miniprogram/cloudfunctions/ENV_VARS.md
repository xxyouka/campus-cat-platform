# 云函数环境变量配置清单

在云开发控制台 → 云函数 → 环境变量中配置以下变量。

## 密码与认证

| 环境变量 | 用途 | 使用云函数 | 说明 |
|----------|------|-----------|------|
| `PASSWORD_SALT` | 密码哈希盐值 | adminLogin | 纯十六进制字符串，用于 scrypt/pbkdf2/sha256 多算法兼容 |
| `ADMIN_ACCOUNT` | 内置管理员账号 | adminLogin | 优先于数据库 admins 集合 |
| `ADMIN_PASSWORD` | 内置管理员密码（已哈希） | adminLogin | 支持 128 位（scrypt/pbkdf2）和 64 位（legacy sha256）格式 |
| `SUPER_ACCOUNT` | 创始人账号 | adminLogin、manageAdmin | 该账号登录时自动升格为 founder；未配置时退回所有超管对等 |
| `SUPER_PASSWORD` | 超级管理员密码（已哈希） | adminLogin | 格式同 ADMIN_PASSWORD |

> **部署陷阱**：`ADMIN_PASSWORD` / `SUPER_PASSWORD` 必须是**预哈希值**，不能填明文。
> 填成明文时函数不会报错，而是静默无法登录。函数启动时会对「已配置但不是 64/128 位十六进制」的情况打 `console.error`，到云函数日志里搜 `[adminLogin] ADMIN_PASSWORD 已配置` 即可确认。
>
> 生成方式（Node，需与 `PASSWORD_SALT` 同值）：
>
> ```js
> const crypto = require('crypto');
> const salt = process.env.PASSWORD_SALT;
> console.log(crypto.scryptSync('你的明文密码', salt, 64).toString('hex')); // → 128 位
> ```
>
> `PASSWORD_SALT` 与生成哈希时用的盐必须完全一致；盐改了、旧哈希即失效。

## 签名密钥

| 环境变量 | 用途 | 使用云函数 | 说明 |
|----------|------|-----------|------|
| `ADMIN_SIGNATURE_KEY` | HMAC-SHA256 签名密钥 | generateAdminSignature | 建议 64 位随机十六进制字符串，签名有效期 1 小时 |

## 应用配置

| 环境变量 | 用途 | 使用云函数 | 说明 |
|----------|------|-----------|------|
| `CONTACT_WECHAT` | 联系微信号 | getConfig | 下发给客户端展示 |
| `CONTACT_EMAIL` | 联系邮箱 | getConfig | 下发给客户端展示 |
| `APP_VERSION` | 应用版本号 | getConfig | 默认值 `3.11.3`（与 package.json 版本保持一致） |

## 订阅消息模板（可选）

> 需要微信订阅消息推送时，在微信公众平台 → 订阅消息 → 我的模板创建模板，把模板 ID 填到 `config.js` 与下列环境变量。留空时不弹订阅授权、不发送推送，站内消息不受影响。

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `subscribeTemplateId` | `config.js` | 状态变更提醒模板 |
| `subscribeMeetTemplateId` | `config.js` | 相遇打卡提醒模板 |
| `subscribeNewCatTemplateId` | `config.js` | 新猫登场提醒模板 |
| `SUBSCRIBE_STATUS_TEMPLATE_ID` | updateCat 云函数 | 未配置时自动跳过发送 |
| `SUBSCRIBE_MEET_TEMPLATE_ID` | recordMeet 云函数 | 未配置时自动跳过发送 |
| `SUBSCRIBE_NEW_CAT_TEMPLATE_ID` | addCat 云函数 | 未配置时自动跳过发送 |

> 前端 `config.js` 与云函数环境变量必须使用同一个模板 ID；不一致会导致推送发不出。

## 内容安全（图片异步检测开关）

| 环境变量 | 用途 | 使用云函数 | 说明 |
|----------|------|-----------|------|
| `MEDIA_CHECK_ASYNC` | 图片内容检测改走现役异步接口 | addPhoto / addCat / updateCat | 置 `1`：走 `mediaCheckAsync`（异步 + 回调复核）；未配置：走旧版同步 `imgSecCheck`（限流时降级放行）。异步链路不可用时自动退回同步，不阻断上传 |

> 回调处置逻辑见 `cloudfunctions/mediaCheckCallback/`，异常内容进入管理端「内容复核」队列。