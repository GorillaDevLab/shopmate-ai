# ShopMate AI

面向中国大陆中小型电商商家的 AI 经营助手。项目目标是将电商经营数据、数据分析、自动化与 AI Agent 结合起来，帮助商家查询经营情况、生成内容并在确认后执行操作。

## 项目结构

```text
shopmate-ai/
├─ apps/web/              # 中文 Next.js Web 应用
├─ packages/              # 跨应用复用的模块与配置
├─ docs/                  # 正式项目文档
├─ .github/               # GitHub 配置与后续 CI 工作流
├─ tests/                 # Monorepo 根工程测试
├─ package.json           # 根命令与运行环境约束
└─ pnpm-workspace.yaml    # pnpm 工作区配置
```

后续任务将在 `apps/` 中继续加入 API，在 `packages/` 中逐步加入共享类型、配置、数据库、AI 与分析模块。

## 环境要求

- Node.js 22 或更高版本
- pnpm 11.24.0

推荐使用 Corepack 启用仓库声明的 pnpm 版本：

```bash
corepack enable
pnpm install
```

## 根命令

```bash
pnpm dev        # 并行启动提供 dev 命令的工作区
pnpm build      # 构建提供 build 命令的工作区
pnpm test       # 验证根工程并运行工作区测试
pnpm lint       # 检查提供 lint 命令的工作区
pnpm typecheck  # 检查提供 typecheck 命令的工作区
```

## Web 应用

从仓库根目录启动中文 Web 应用：

```bash
pnpm --filter @shopmate/web dev
```

启动后访问 <http://localhost:3000>。Web 应用使用 Next.js App Router、TypeScript 与 Tailwind CSS，当前提供中文根布局、移动端基础界面和全局错误页。
