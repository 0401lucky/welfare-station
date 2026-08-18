# new-api 福利站

面向 LinuxDO 社区的 **new-api fork 增强签到 + 福利活动直充领取** 独立站点。后端 Go(gin+gorm)、前端 React(Vite+TS+Tailwind),单二进制交付,与 new-api 共用同一 MySQL 实例(独立 database `welfare_station`),一切数据交互走 HTTP API。

> 需求 / 设计 / 实施计划见 `.trellis/tasks/08-18-welfare-site/` 下的 `prd.md` / `design.md` / `implement.md`。**new-api 接口契约以 `design.md §4` 为准。**

## 功能

- **LinuxDO OAuth 一键登录**,按 `linux_do_id` 自动绑定 new-api 账号(未注册则进入引导页 `/bind`)。
- **增强签到**:连续签到加成(默认 3/7/30 天 +10%/+25%/+50%),签到即直充到账。
- **福利活动**:后台建活动(面值/份数/限领/信任等级/时间窗),用户点选即直充领取,并发不超发。
- **站长后台**:签到配置、活动 CRUD、发放流水(失败可一键重试,幂等)、手动发放、用户管理、仪表盘。

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
| `NEWAPI_ADMIN_PAT` | 是 | new-api 管理员访问令牌(仅存环境变量,禁入库/日志) |
| `LINUXDO_CLIENT_ID` / `_SECRET` | 是 | LinuxDO OAuth 应用凭据 |
| `WELFARE_BASE_URL` | 是 | 站点公网地址(拼接 OAuth 回调;https 时自动启用 Cookie Secure) |
| `WELFARE_JWT_SECRET` | 是 | ≥32 字节随机串 |
| `WELFARE_ADMIN_LINUXDO_IDS` | 是 | 管理员 LinuxDO id,逗号分隔 |
| `QUOTA_PER_UNIT` | 否 | 额度换算系数,默认 500000(须与 new-api 一致) |
| `MAX_GRANT_QUOTA` | 否 | 单次手动发放上限,默认 5000000 |
| `MOCK_OAUTH` / `MOCK_LINUXDO_ID` / `MOCK_TRUST_LEVEL` | 否 | 仅本地开发 |

## 发放一致性说明

- 任何发放(签到/活动/手动)先落 `w_grants(status=pending)`,成功置 `success`、失败置 `failed`(含 new-api 返回信息)。
- 发放外呼放在本地事务**提交之后**:宁可"记录成功但额度暂未到"(可重试补发),绝不"额度到了但本地无记录"(避免双发)。
- 幂等根基:签到 `(user, checkin_date)` 唯一、活动 `(activity, user, seq)` 唯一、流水 `(type, ref_id)` 唯一;重试仅对 `failed` 且 CAS 保护。

## 常见问题

- **额度显示与 new-api 钱包不一致**:核对 `QUOTA_PER_UNIT` 是否与 new-api 系统设置一致(签到 1 次比对两侧显示)。
- **反查接口 404**:fork 补丁未生效,按 `design.md §5` 应用并重新编译部署 new-api。
- **重复签到/并发领取**:由数据库唯一约束兜底,同一业务动作只产生一条流水,不会双发。