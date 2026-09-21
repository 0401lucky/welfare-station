# new-api 福利站

面向 LinuxDO 社区的 **new-api fork 增强签到 + 福利活动直充领取** 独立站点。后端 Go(gin+gorm)、前端 React(Vite+TS+Tailwind),单二进制交付,与 new-api 共用同一 MySQL 实例(独立 database `welfare_station`),一切数据交互走 HTTP API。

> 需求 / 设计 / 实施计划见 `.trellis/tasks/08-18-welfare-site/` 下的 `prd.md` / `design.md` / `implement.md`。**new-api 接口契约以 `design.md §4` 为准。**

## 功能

- **LinuxDO OAuth 一键登录**,按 `linux_do_id` 自动绑定 new-api 账号(未注册则进入引导页 `/bind`)。
- **增强签到**:连续签到加成(默认 3/7/30 天 +10%/+25%/+50%),签到即直充到账;连签徽章与「再签 N 天解锁 +X%」进度提示。
- **每日幸运翻牌**:一天一次,服务端摇幸运数字并按档位发奖,结果可生成分享图。
- **福利活动**:后台建活动(面值/份数/限领/信任等级/时间窗),用户点选即直充领取,并发不超发;卡片带倒计时与阶段标签。
- **好运榜**(`/` 首页):连签榜与本周小游戏高分榜各取前 20,匿名可看,登录后多一行自己的名次。
- **站长后台**:签到配置、站点公告、活动 CRUD(含复制)、发放流水(失败自动补发,也可一键手动重试,均幂等;支持按当前筛选导出 CSV)、手动发放、用户管理(分页/筛选/详情/备注)、仪表盘(今日预算告警 + 近 7 天趋势图)、操作日志(全部写操作的审计记录)。
- **小游戏花园** (`/game`):真实软体物理的「软软西瓜」与原有 2048 额度挑战。西瓜支持自由练习、登录挑战、自动存档和额度结算。
- **深色模式**:浅色 / 深色 / 跟随系统三态切换(全站色板由 CSS 变量驱动,首帧内联脚本防闪白)。
- **可安装 PWA**:manifest + 图标,手机可「添加到主屏幕」;**不注册 Service Worker**——额度与签到状态不能来自陈旧缓存。

### 软软西瓜与额度挑战

`/game/watermelon` 使用九种原创水果贴图,形变轮廓实际参与碰撞与堆叠。葡萄、樱桃、橘子随机出现,较大水果靠合成获得;练习重新开局使用新序列,暂停续玩保留原局。手机拖动瞄准、松手投放,键盘使用左右方向键与空格/回车。练习不计额度;登录并绑定 new-api 后,可在已启用的额度挑战中合成目标水果并结算。

默认永久额度奖励如下(按 `QUOTA_PER_UNIT=500000` 换算,后台可调整):

| 最高合成水果 | 单局奖励 |
|---|---|
| 桃子 | $0.02 |
| 柿子 | $0.05 |
| 蜜瓜 | $0.10 |
| 西瓜 | $0.20 |

每局只发最高一档,默认每天最多 3 次、每人西瓜奖励上限 $0.30、结算后冷却 60 秒;同时受共享小游戏/全站预算约束。额度不足时按剩余金额发放。游戏分数和合成结果由服务端根据投放记录复算,客户端不能直接指定奖励。重复提交不会重复发放,外部到账失败进入已有补发流程。

**已有站点升级后,新游戏默认关闭**。请在「后台 → 游戏设置 → 软软西瓜」检查档位和预算后启用。原有 2048 与共享预算设置会保留。新建站点使用完整默认配置。

水果、物理脚本和页面都随前端资源打包。原始生图和提示词见 [素材说明](output/imagegen/README.md),确定性回放/存档协议见 [西瓜引擎文档](service/gamewatermelon/README.md)。Go 与浏览器读取同一份粒子夹具验证一致性。

3D [风芽飞行](web/public/assets/games/flight/index.html)暂保留为可离线打开的独立 HTML,未接入站内导航或额度奖励。

## 目录结构

```
main.go            # 入口: 配置 → DB 迁移 → 路由 → 托管 web/dist
common/            # 统一响应 & 错误
config/            # 环境变量加载(缺必填启动即报错)
model/             # gorm 模型(表前缀 w_) + 迁移
service/           # new-api 客户端 / 发放器 / 签到 / 活动 / OAuth / 会话
middleware/        # JWT(RequireUser/RequireAdmin) + 限流
controller/        # gin 处理器
router/            # 路由注册
web/               # React + Vite + TS + Tailwind 前端
Dockerfile         # 多阶段: node 构建前端 → go 构建后端 → alpine 运行
docker-compose.yml
```

## 快速开始(本地开发,无 MySQL 也可跑)

```bash
# 后端
export DB_DRIVER=sqlite DB_DSN=welfare_dev.db      # 本地用 SQLite, 生产用 mysql
export NEWAPI_BASE_URL=http://localhost:3000 NEWAPI_ADMIN_PAT=xxx
export WELFARE_JWT_SECRET=<32+ chars> WELFARE_BASE_URL=http://localhost:8080
export LINUXDO_CLIENT_ID=x LINUXDO_CLIENT_SECRET=x MOCK_OAUTH=true
export WELFARE_ADMIN_LINUXDO_IDS=90001
go run .

# 前端(开发模式, 代理 /api → :8080)
cd web && npm install && npm run dev

# 测试
go test ./...
cd web && npm run build
```

推送 `main` 后,[GitHub Actions](.github/workflows/deploy.yml)依次执行前端测试与构建、Go 测试、镜像构建与 GHCR 推送,然后部署服务器并等待健康检查。测试不通过会阻止镜像发布与部署;纯文档改动沿用工作流的跳过规则。

`MOCK_OAUTH=1` 是**仅限本地开发**的开关:登录接口会自我回调,跳过 connect.linux.do;用 `?mock_id=90001` 可模拟白名单管理员。上线前必须关闭并真实联调一次。

## 上线步骤(design.md §12)

1. **应用 new-api fork 补丁并重启 new-api**:补丁代码与位置见 `design.md §5`(在 `controller/user.go` 末尾追加 `GetUserByLinuxDOId` 函数 + 在 `router/api-router.go` 管理员路由组注册 `GET /api/user/by_linuxdo`)。
   > 生效检查: `curl -H "Authorization: Bearer <PAT>" "http://<new-api>/api/user/by_linuxdo?linux_do_id=12345"` 返回 JSON 而非 404。
2. **建库、配 env、起容器**:
   - 在 MySQL 里创建独立库:`CREATE DATABASE welfare_station CHARACTER SET utf8mb4;`
   - 复制 `.env.example` 为 `.env` 并按注释填写(重点:`DB_DSN` 指向该库、`NEWAPI_BASE_URL` 指向 new-api、`QUOTA_PER_UNIT` 与 new-api 实例设置一致、`WELFARE_ADMIN_LINUXDO_IDS` 填站长 LinuxDO id)。
   - `docker compose up -d --build`(首次自动建表,迁移幂等)。
3. **在 https://connect.linux.do 注册 OAuth 应用**:调用地址 `https://<福利站域名>/api/oauth/linuxdo/callback`,拿到 `LINUXDO_CLIENT_ID/SECRET` 填入 env。
4. **new-api 建 `welfare-bot` 管理员账号并生成访问令牌(PAT)** 填入 `NEWAPI_ADMIN_PAT`(便于审计区分与随时吊销)。
5. **验证 AC1–AC8**(见 prd.md):登录→绑定→签到到账→活动领取→并发/重试→后台;核对 new-api 后台 `user.quota_add` 审计与钱包余额。
6. **关闭 new-api 内置签到**:在 new-api 系统设置里关闭 `/api/option/checkin`,避免双重奖励(设计决策 D1)。

## 环境变量清单

| 变量 | 必填 | 说明 |
|------|:---:|------|
| `PORT` | 否 | 监听端口,默认 8080 |
| `DB_DRIVER` | 否 | `mysql`(默认)/ `sqlite`(仅本地开发) |
| `DB_DSN` | 是(mysql) | MySQL DSN,指向独立库 `welfare_station` |
| `NEWAPI_BASE_URL` | 是 | new-api 根地址(内网) |
| `NEWAPI_PUBLIC_URL` | 否 | new-api 对外地址,仅用于站内「打开 new-api」跳转;留空则不显示该入口 |
| `WELFARE_SITE_NAME` | 否 | 站点名,默认「福利站」 |
| `NEWAPI_ADMIN_PAT` | 是 | new-api 管理员访问令牌(仅存环境变量,禁入库/日志) |
| `LINUXDO_CLIENT_ID` / `_SECRET` | 是 | LinuxDO OAuth 应用凭据 |
| `WELFARE_BASE_URL` | 是 | 站点公网地址(拼接 OAuth 回调;https 时自动启用 Cookie Secure) |
| `WELFARE_JWT_SECRET` | 是 | ≥32 字节随机串 |
| `WELFARE_ADMIN_LINUXDO_IDS` | 是 | 管理员 LinuxDO id,逗号分隔 |
| `QUOTA_PER_UNIT` | 否 | 额度换算系数,默认 500000(须与 new-api 一致) |
| `MAX_GRANT_QUOTA` | 否 | 单次手动发放上限,默认 5000000 |
| `AUTO_RETRY_ENABLED` | 否 | 失败发放自动重试开关,默认 `true` |
| `AUTO_RETRY_INTERVAL_SECONDS` | 否 | 自动重试扫描间隔(秒),默认 60,每轮最多 50 条 |
| `AUTO_RETRY_MAX_ATTEMPTS` | 否 | 单条流水自动重试次数上限,默认 5 |
| `MOCK_OAUTH` / `MOCK_LINUXDO_ID` / `MOCK_TRUST_LEVEL` | 否 | 仅本地开发 |

## 发放一致性说明

- 任何发放(签到/活动/手动)先落 `w_grants(status=pending)`,成功置 `success`、失败置 `failed`(含 new-api 返回信息)。
- 发放外呼放在本地事务**提交之后**:宁可"记录成功但额度暂未到"(可重试补发),绝不"额度到了但本地无记录"(避免双发)。
- 幂等根基:签到 `(user, checkin_date)` 唯一、活动 `(activity, user, seq)` 唯一、流水 `(type, ref_id)` 唯一;重试仅对 `failed` 且 CAS 保护。

### 失败流水的自动重试

- 后台任务每 `AUTO_RETRY_INTERVAL_SECONDS` 秒扫一轮,捞出「`failed` 且重试次数未用尽且已过退避时间」的流水(按 id 升序,每轮最多 50 条),复用与后台按钮同一套 CAS 重试逻辑。
- 退避表:第 1/2/3/4/5 次失败后分别等 1 分钟、5 分钟、15 分钟、1 小时、6 小时;达到 `AUTO_RETRY_MAX_ATTEMPTS` 后不再自动重试,后台列表标为**自动重试已用尽**,需站长排查 new-api 后手动重试(手动重试会把计数清零,重新获得完整自动重试预算)。
- **`pending` 状态永不自动重试**:重试会先把流水置 `pending` 再外呼,若进程恰在这中间被杀,无法判断 new-api 那笔是否已执行(`add_quota` / `temporary_quota` 都不是幂等接口,盲目重发会重复到账)。这类流水在后台列表停留超 10 分钟会标为**待人工确认**,请先到 new-api 核对该用户额度再决定是否补发。
- 进程收到 SIGINT/SIGTERM 时先停重试任务(当前这条补发跑完)、再关 HTTP 服务,避免容器重启把重试砍在半途。

## 常见问题

- **额度显示与 new-api 钱包不一致**:核对 `QUOTA_PER_UNIT` 是否与 new-api 系统设置一致(签到 1 次比对两侧显示)。
- **反查接口 404**:fork 补丁未生效,按 `design.md §5` 应用并重新编译部署 new-api。
- **重复签到/并发领取**:由数据库唯一约束兜底,同一业务动作只产生一条流水,不会双发。

## 主题与安装

主题存在浏览器 `localStorage['welfare-theme']`(`light` / `dark` / `system`),页头右侧按钮循环切换。深色模式的色板定义在 `web/src/index.css` 的 `.dark` 块,改色只需改变量;`node web/scripts/contrast-check.mjs` 可核对文字对比度(深色为硬门槛)。

PWA 图标由 `python web/scripts/make-icons.py` 从 favicon 造型导出,产物落在 `web/public/icons/`。`/manifest.webmanifest` 与 `/icons/*` 在 `main.go` 里显式注册——新增顶层静态资源必须照做,否则会被 SPA fallback 当成客户端路由返回 index.html。
