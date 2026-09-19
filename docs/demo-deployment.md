# ShopMate AI Demo 部署流程

## 目标

提供不提交真实 Secret、可重复执行的 Demo 初始化、Migration、Seed、健康检查和回滚流程。

## 1. 环境变量

以仓库根目录 `.env.example` 为模板。

本地开发可复制：

    cp .env.example .env

真实密码、数据库凭据、Session Secret 和 AI Key 必须通过本地 `.env` 或部署平台 Secrets 注入，禁止提交 Git。

关键变量：

- `DATABASE_URL`：PostgreSQL 连接地址
- `PORT`：NestJS API 端口
- `API_BASE_URL`：Next.js 到 API 的服务端代理地址
- `DEMO_AUTH_*`：Demo 登录配置
- `DEMO_SESSION_SECRET`：服务端会话 Secret
- `DEMO_AUTH_SECURE_COOKIE`：会话 Cookie 安全开关；HTTPS/生产默认 `true`，仅临时 HTTP IP 演示可显式设为 `false`
- `DEEPSEEK_*`：AI Provider 配置
- `DEMO_WEB_URL`：部署后的 Web 健康检查地址
- `DEMO_API_URL`：部署后的 API 地址

## 2. 安装与构建

    pnpm install --frozen-lockfile
    pnpm build

## 3. 初始化数据库

    pnpm demo:init

初始化顺序固定为：

1. `prisma migrate deploy`
2. 商品 Demo Seed
3. 订单 Demo Seed

Migration 失败时不会继续执行 Seed，命令以非零状态退出。

Seed 使用固定 Demo 数据，可重复执行。

## 4. 启动服务

本地可执行：

    pnpm dev

部署平台应分别启动 Web 与 API，并正确配置 `API_BASE_URL`。

正式部署必须使用 HTTPS。若当前只是通过 HTTP IP 做临时演示，需要在 API 环境显式设置
`DEMO_AUTH_SECURE_COOKIE=false`，否则浏览器会拒绝发送生产环境的 Secure Cookie，登录后指标接口会返回 401。演示结束后应恢复为 `true` 并切换 HTTPS。

## 5. 健康检查

    pnpm demo:health

健康检查验证：

- Web 入口
- API `/api/v1/health`

无法连接、请求超时或返回非 2xx 均视为失败，并产生非零退出状态。

部署只有在健康检查通过后才应标记成功。

## 6. Secret 检查

提交或部署前执行：

    pnpm secret:scan

禁止提交：

- `.env`
- PostgreSQL 密码
- Demo Session Secret
- DeepSeek API Key
- GitHub Token
- 部署平台 Token

`.env.example` 只能包含示例值或占位值。

## 7. 回滚

如果新版本启动或健康检查失败：

1. 不把本次部署标记为成功。
2. 停止继续发布新实例。
3. 查看 Web、API 和健康检查日志。
4. 回滚应用到上一个已验证 Commit 或 Image。
5. 再次执行 `pnpm demo:health`。

### 数据库回滚原则

Prisma `migrate deploy` 不提供自动向下 Migration。

禁止在已有 Demo 数据环境通过 `prisma migrate reset` 作为生产式回滚方案。

如果 Migration 已应用：

- 优先新增向前修复 Migration。
- 如果数据库变更向后兼容，可以先回滚应用版本。
- 不兼容变更需要人工审核恢复 SQL，或从部署前数据库备份恢复。
- 数据库恢复后必须重新运行健康检查。
- 不删除 Migration 历史来伪造回滚。

## 8. 部署成功标准

以下命令必须全部通过：

    pnpm build
    pnpm demo:init
    pnpm demo:health
    pnpm secret:scan

其中任何一步失败，都不能把部署标记为成功。
