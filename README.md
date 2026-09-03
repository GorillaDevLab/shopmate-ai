# ShopMate AI

> 面向中国大陆中小型电商商家的 AI 经营助手 Demo

[![CI](https://github.com/hannnnnnnny/shopmate-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/hannnnnnnny/shopmate-ai/actions/workflows/ci.yml)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22.x-339933?logo=node.js&logoColor=white)
![pnpm 11.24](https://img.shields.io/badge/pnpm-11.24-F69220?logo=pnpm&logoColor=white)
![TypeScript 6](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-private-lightgrey)

ShopMate AI 将商品、库存和经营数据整理成易读的中文界面，帮助商家更快看懂经营情况、比较选择，并为后续 AI Agent 能力提供可靠的 Web、API 与数据层基础。

## 当前能力

- 中文 Dashboard：移动端优先的经营信息骨架、加载态和错误态。
- Demo 登录：服务端会话、登录输入校验和 Merchant Scope 上下文。
- 商品 API：当前 Merchant 隔离的商品分页列表、状态筛选和 SKU 详情。
- 健康检查：版本化 API 端点 `GET /api/v1/health`。
- 工程质量：pnpm workspace、共享 TypeScript 契约、自动化测试和 GitHub Actions 质量门禁。
- AI 配置入口：支持通过环境变量配置 DeepSeek；未配置密钥时 Demo 仍可启动。

## 技术栈

| 层级   | 技术                                                    |
| ------ | ------------------------------------------------------- |
| Web    | Next.js 16、React 19、TypeScript、Tailwind CSS 4        |
| API    | NestJS 12、Express、TypeScript、Zod、class-validator    |
| 数据   | PostgreSQL、Prisma 7、`@prisma/adapter-pg`              |
| 工作区 | pnpm 11、pnpm workspace、共享 `@shopmate/contracts` 包  |
| 测试   | Vitest、Node.js Test Runner、Supertest、Testing Library |
| 工程化 | ESLint、Prettier、TypeScript strict、GitHub Actions     |
| AI     | DeepSeek API 配置（通过环境变量注入）                   |

## 项目结构

```text
shopmate-ai/
├─ apps/
│  ├─ web/                  # Next.js 中文 Web 应用
│  └─ api/                  # NestJS 版本化 API
├─ packages/
│  ├─ contracts/            # Web/API 共享 Zod Schema 与 Mock
│  └─ database/             # Prisma Schema、迁移、Seed 与客户端
├─ docs/                    # 项目文档
├─ tests/                   # 根工程结构、冒烟、CI 与 Secret 测试
├─ scripts/                 # 本地冒烟测试与 Secret 扫描脚本
├─ .github/workflows/ci.yml # PR 与 main 分支质量门禁
├─ package.json             # 根命令与运行环境约束
└─ pnpm-workspace.yaml      # pnpm 工作区配置
```

## 环境要求

- Node.js `>=22.0.0`
- pnpm `11.24.0`
- PostgreSQL（运行真实数据库读写和 Seed 时需要）

推荐使用 Corepack 启用仓库声明的 pnpm 版本：

```bash
corepack enable
pnpm install
```

## 快速开始

### 1. 配置环境变量

复制模板并按需修改：

```powershell
Copy-Item .env.example .env
```

`.env` 仅用于本地开发，禁止提交。常用配置包括：

- `DATABASE_URL`：PostgreSQL 连接地址。
- `DEMO_AUTH_EMAIL`、`DEMO_AUTH_PASSWORD`：Demo 登录凭据。
- `DEMO_SESSION_SECRET`：至少 32 个字符的服务端会话密钥。
- `DEEPSEEK_API_KEY`：实际调用 DeepSeek AI 时配置；当前 Demo 不配置也能启动。

### 2. 初始化 Demo 数据库

```bash
pnpm demo:init
```

该命令按固定顺序执行 Prisma Migration、商品 Seed 和订单 Seed。

完整的环境变量、部署、健康检查和回滚流程见 `docs/demo-deployment.md`。

### 3. 启动 Web 与 API

```bash
pnpm dev
```

首次启动会先构建共享契约和数据库客户端。启动后访问：

- Web：<http://localhost:3000>
- API 健康检查：<http://localhost:3001/api/v1/health>

也可以分别启动单个应用：

```bash
pnpm --filter @shopmate/web dev
pnpm --filter @shopmate/api dev
```

## 常用命令

```bash
pnpm dev          # 并行启动 Web 与 API
pnpm build        # 构建全部工作区
pnpm test         # 运行根工程与工作区测试
pnpm lint         # ESLint 检查
pnpm typecheck    # TypeScript 类型检查
pnpm smoke        # 检查本地 Web 与 API 是否可用
pnpm secret:scan  # 扫描疑似密钥和 Token
pnpm format:check # 检查 Prettier 格式
```

## API 示例

商品接口使用登录后的 Merchant Scope，只返回当前商家的数据：

```text
GET /api/v1/products?page=1&pageSize=20&status=ACTIVE
GET /api/v1/products/:productId
```

错误响应保持统一结构；无权限或跨 Merchant 访问不会泄露资源是否存在。

## 开发约定

- 分支使用 `feat/<主题>`、`fix/<主题>` 等命名，不使用 `codex/` 前缀。
- 所有密钥只通过环境变量注入，真实 `.env` 不进入仓库。
- 提交 PR 前运行 `pnpm secret:scan`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。
- 新功能应同时补充对应的单元测试或集成测试，并保持 Controller、Service、Repository 分层。

## 项目状态

这是一个持续迭代中的 Demo。当前重点是建立稳定的中文 Web/API 基础、认证上下文、商品领域接口和可重复的工程质量流程，后续再接入真实 AI Agent 工作流与更多电商数据源。
