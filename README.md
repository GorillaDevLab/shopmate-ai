# ShopMate AI

面向中国大陆中小型电商商家的 AI 经营助手。项目目标是将电商经营数据、数据分析、自动化与 AI Agent 结合起来，帮助商家查询经营情况、生成内容并在确认后执行操作。

## 项目结构

```text
shopmate-ai/
├─ apps/                  # 可独立运行和部署的应用
├─ packages/              # 跨应用复用的模块与配置
├─ docs/                  # 正式项目文档
├─ .github/               # GitHub 配置与后续 CI 工作流
├─ tests/                 # Monorepo 根工程测试
├─ package.json           # 根命令与运行环境约束
└─ pnpm-workspace.yaml    # pnpm 工作区配置
```

后续任务将在 `apps/` 中初始化 Web 和 API，在 `packages/` 中逐步加入共享类型、配置、数据库、AI 与分析模块。

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

当前 A1 只建立 Monorepo 根骨架，尚未初始化具体应用。
