# 数据模型

## 集合一览

| 集合 | 用途 |
|------|------|
| `cats` | 猫咪档案：名字、花色、性别、状态、校区、头像、星级、相遇点位等 |
| `photos` | 猫咪照片：fileID、所属猫咪、点赞数、审核状态 |
| `albums` | 相册聚合信息 |
| `admins` | 管理员：账号、密码哈希、角色、入口权限、openid 绑定 |
| `notices` | 公告 |
| `recordMeet` | 相遇打卡记录：匿名 openid、猫咪、时间、地点、点位 |
| `userFavorites` | 用户关注关系 |
| `notifications` | 站内消息：关注更新、反馈处理结果等 |
| `userSubscriptions` | 订阅授权记录（可选推送能力） |
| `subscribeQuota` | 订阅消息剩余次数账本（可选推送能力） |
| `catRelations` | 猫咪关系：父子/伴侣/同伴等 |
| `operationLogs` | 管理端操作日志 |
| `mediaChecks` | 多媒体内容安全检测队列 |
| `repairLogs` | 修复/对账日志 |
| `userReports` | 用户反馈：信息有误、受伤、走失、其他 |
| `ops_users` | 运营看板：匿名用户首见/活跃 |
| `ops_days` | 运营看板：匿名日活明细 |
| `ops_entry_usage` | 运营看板：页面入口使用 |

> 具体集合名称以 `config.js` 的 `collections` 与 `cloudfunctions/utils/constants.js` 为准。

## 猫咪档案

核心字段（以 `cats` 集合为准）：

- `name`：名字
- `campus`：校区
- `color` / `gender` / `status`：花色、性别、状态
- `adoptLevel`：好猫星级（0 = 未评级，3/4/5 为推荐家养）
- `avatar`：云存储 fileID
- `description`：简介
- `lastMeetPoint`：最近一次相遇点位（`u`/`v` 归一化坐标）
- `listSort`：列表排序值（在校/走失 → 离世 → 领养）
- `updateTime` / `createTime`

## 相遇记录

- `_openid`：匿名用户标识，仅服务端使用
- `catId` / `catName`：猫咪
- `meetTime`：相遇时间（用于 1 小时冷却与日历统计）
- `location`：文字地点
- `u` / `v`：地图点位（可选）
- `statusTag`：状态标签快照

## 权限与隐私

- 用户端不读取 `admins`、`operationLogs` 等管理集合。
- `recordMeet` 与 `userFavorites` 只通过云函数读写，客户端不直连。
- 运营集合只存匿名键（sha256(openid)）与入口名，不存原始 openid 或内容。
- 管理员密码只存加盐哈希，盐值与账号在云函数环境变量中。
- 照片/头像 fileID 必须落在 `cats/`、`photos/` 业务前缀内。

## 索引

`cloudfunctions/initDatabase/index.js` 维护集合与索引清单。部署后请按文件中的说明在云开发控制台创建索引；索引缺失会影响列表、排行与运营看板的查询性能。