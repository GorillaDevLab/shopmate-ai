# Phase 11 — Goal Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p11-001"></a>

## P11-001：定义目标、约束与证据评估契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** GoalV1 / GoalConstraintV1 / GoalEvaluationV1 / GoalRepository / GoalPlanningPort

**输入：**

- I目标字段targetMetric/targetMinor/deadline/constraints；现有TenantContext
- P3 metric/evidence边界仅命名输入，无原始源oracle

**输出：**

- strict tenant/store-scoped版本目标、units/currency/deadline、支持指标allowlist
- 约束typed schema：预算/最低毛利/允许动作scope；evaluation保留evidence版本、quality/水印

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/goals/goal.schema.ts`
- `packages/contracts/src/goals/goal.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] 比例目标和money target单位不匹配、非CNY/unsafe target拒绝
- [ ] 未知constraint、approval/execute/permissionOverride字段拒绝
- [ ] deadline含timezone、revision缺失/跨scope evidence拒绝；目标绝不产生授权

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/goals/goal.schema.spec.ts

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 目标参数被当授权策略

**并行分组：** `p11-goal.schema`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。契约导出协调锁；产品未批准的目标类型不悄然加入。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-002"></a>

## P11-002：实现目标进度和质量评估纯函数

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** GoalEvaluator

**输入：**

- GoalV1与同store同period/window evidence snapshot
- metric definition version/coverage/status/watermark及business Clock

**输出：**

- 进度、deadline结果与evidence references
- 未知/不足/过期评估明确不可下确定结论

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goal-evaluator.ts`
- `apps/api/src/goals/goal-evaluator.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-001

**实际接线依赖：** P03-001

**验收：**

- [ ] 同口径目标进度可由fixture整数值复算
- [ ] STALE/INSUFFICIENT/UNAVAILABLE与缺成本不输出达成或精确0
- [ ] 跨store/不同窗口/定义版本拒绝比较，模拟deadline不影响security TTL

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goal-evaluator.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 不同时间指标被直接比较

**并行分组：** `p11-goal-evaluator`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-003"></a>

## P11-003：实现目标约束与动作候选校验

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** GoalConstraintGuard

**输入：**

- typed目标约束、服务计算的影响/evidence质量
- 动作候选与当前scope/permissions，不采信LLM影响数字

**输出：**

- 独立允许/拒绝候选结果reason codes
- 目标限制仅缩小scope；仍重新走ActionPolicy与人工审批

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goal-constraint-guard.ts`
- `apps/api/src/goals/goal-constraint-guard.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-001

**实际接线依赖：** P07-001, P07-003

**验收：**

- [ ] 预算/最低毛利/allowed action scope违反时拒绝
- [ ] 未知成本/无法测算影响不能判约束满足
- [ ] goal含宽权限不能提升role；event severity也不能绕过riskPolicy

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goal-constraint-guard.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 未知成本被算为零以通过约束

**并行分组：** `p11-goal-constraint-guard`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-004"></a>

## P11-004：新增目标和评估引用表

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P1

**契约：** GoalPersistenceV1

**输入：**

- tenant/store复合FK/RLS样例与GoalV1 revision
- evaluation仅存snapshot refs+摘要，不复制prompt/源oracle

**输出：**

- additive Goal/GoalEvaluation模型独立migration
- scoped revision唯一、deadline/target单位及证据引用索引

**独占文件（新路径为计划创建）：**

- `packages/database/src/goals/goal-model.ts`
- `packages/database/test/goals/goal-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005110100_goals/migration.sql`

**硬依赖：** P11-001

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store目标关联与缺scope RLS明确拒绝
- [ ] targetMinor安全整数、revision、deadline必填约束可审查
- [ ] 空库/升级迁移contract验证，缺证据评估不伪造达成

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/goals/goal-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 目标历史覆盖掉旧口径

**并行分组：** `p11-goal-model`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-005"></a>

## P11-005：实现目标CRUD与审计事务仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P1

**契约：** GoalRepository / GoalEvaluationRepository

**输入：**

- tenant事务client、GoalPersistenceV1、expectedRevision
- P09-004 mutation-time audit append

**输出：**

- create/read/revise/archive及evaluation append仓库
- 目标更新/archive CAS与audit同事务

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goal.repository.ts`
- `apps/api/src/goals/goal.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-004, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 同store目标可建改并保留旧revision/evidence
- [ ] 并发同revision编辑一个成功；跨组织读取/更新拒绝
- [ ] audit故障回滚目标变更；archive不取消已经独立批准的动作也不触发执行

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goal.repository.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 目标变更暗中改变已批准动作

**并行分组：** `p11-goal.repository`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-006"></a>

## P11-006：新增目标管理与评估HTTP入口

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** GoalHttpV1

**输入：**

- TenantScopeService.resolve + strict header/path scope/current auth + route-specific strict body；不使用拒绝body/query的context-read-only guard；当前role；目标管理要求actions:propose、读取tenant:read
- strict GoalV1 request与expectedRevision；GoalRepository/evaluator ports

**输出：**

- 拟新增scoped goals create/update/read/evaluate endpoints
- 稳定400/403/409错误与默认认证

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goal.controller.ts`
- `apps/api/src/goals/goal.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-001

**实际接线依赖：** P11-005, P11-002, P11-003

**验收：**

- [ ] 匿名/Viewer写/跨tenant/store请求拒绝
- [ ] 合法目标输入校验后保存；旧revision409
- [ ] body附带approve/execute/permissionOverride400；评估缺证据明确质量状态

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goal.controller.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 目标API成为权限侧门

**并行分组：** `p11-goal.controller`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-007"></a>

## P11-007：实现证据驱动的受限目标计划器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** GoalPlanningPort / GoalPlanV1

**输入：**

- GoalEvaluationV1+明确facts/correlations/hypotheses、工具预算
- read-only tool port及候选proposal port；无approval/execution工具

**输出：**

- 有证据引用的少量候选步骤/停止原因
- 过期或不足先取证；规则摘要显式标注非模型推理

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goal-planner.ts`
- `apps/api/src/goals/goal-planner.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-001

**实际接线依赖：** P11-002, P11-003, P06-001

**验收：**

- [ ] 同dataset非固定问题产生可复算证据引用计划
- [ ] 缺证据只补证据不虚构目标达成，取消/预算耗尽停止
- [ ] 恶意商品文本要求提权/执行不改变policy；每步scope不扩大

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goal-planner.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 目标优化进入无限Agent循环

**并行分组：** `p11-goal-planner`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-008"></a>

## P11-008：将目标计划接入安全Agent候选工具

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** GoalAgentToolAdapter

**输入：**

- 安全Agent ToolRegistry request/result与当前TenantContext
- goal planner及P7候选HTTP/service port；candidate output严格验证

**输出：**

- 只读取目标/evaluate/生成待审批候选的tool adapter
- 统一tool budget、evidence refs、auth/current goal revision检查

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/goals/goal-tools.ts`
- `apps/api/src/ai/goals/goal-tools.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-003, P11-007, P06-001

**实际接线依赖：** P07-010, P11-006, P06-001

**验收：**

- [ ] Analyzer可生成候选但没有approve/execute/token/SQL工具
- [ ] 读取目标后被archive/permission撤销时拒绝新候选
- [ ] 伪造goal权限/不可信文本/missing evidence拒绝；schema失败无持久动作

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/ai/goals/goal-tools.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 工具候选绕过proposalPolicy

**并行分组：** `p11-goal-tools`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。只完成tool adapter单元，AI root注册由P11-010负责。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-009"></a>

## P11-009：制作目标编辑和证据进度界面

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** GoalWorkspaceViewModel

**输入：**

- goal/current evaluation/readable permissions与注入CRUD client
- 现有表单/Card/evidence link；allowed constraint controls

**输出：**

- 375px/桌面目标form、进度、约束和候选链接UI
- loading/empty/error，archive破坏性二次确认

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/goals/goal-workspace.tsx`
- `apps/web/src/app/goals/goal-workspace.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P11-001

**实际接线依赖：** P11-006

**验收：**

- [ ] 单位/deadline/约束校验且不宣称目标自动执行
- [ ] 缺证据/过期显示未知进度；evidence点击定位版本
- [ ] 403/409可恢复；archive取消不发请求；375px无溢出

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/goals/goal-workspace.test.tsx

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 进度条掩盖指标质量

**并行分组：** `p11-goal-workspace`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-010"></a>

## P11-010：接入目标模块、Agent工具和工作区

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** GoalsModuleWiring

**输入：**

- 已实现metrics/evidence/tools/action candidate ports
- 既有auth/current tenant reader与goal contract exports

**输出：**

- Nest goal module、Agent只读/候选工具注册及Web route接桥
- 目标→证据→候选→已有P7审批runtime链

**独占文件（新路径为计划创建）：**

- `apps/api/src/goals/goals.module.ts`
- `apps/api/src/goals/goals.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `packages/contracts/src/index.ts`
- `apps/api/src/ai/ai.module.ts`
- `apps/web/src/app/page.tsx`

**硬依赖：** P11-005, P11-006, P11-007, P11-008, P11-009, P03-001, P06-001, P07-014, P09-004, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 真实依赖接线后目标查询/evaluate/候选创建可调用
- [ ] 目标不扩大tools/role；取消goal不执行任何platform write
- [ ] UI调用API展示质量与证据；无approve/execute工具或循环依赖

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/goals/goals.module.spec.ts --maxWorkers 1

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** root注册跨领域共享冲突

**并行分组：** `p11-goals.module`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。四个聚合文件分别持协调合并锁；只接桥完成组件。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p11-011"></a>

## P11-011：证明目标隔离、审计与无额外权限

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** GoalAuthorityProof

**输入：**

- isolated-postgres受限角色及真实本地goal HTTP
- 两组织/Viewer/Analyst/admin fixtures与malicious goal fields

**输出：**

- RLS/FK/CAS/audit rollback证明
- goal→candidate仍需真人approval，禁止权限提升的集成回归

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/goal-authority.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P11-004, P11-005, P11-010, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store FK/RLS及匿名/Viewer目标写被拒
- [ ] 并发修订只有一个生效；audit故障回滚CRUD
- [ ] 含execute/approve要求的目标或商品文本仅不可信数据；候选从未自动批准/dispatch

**测试：**

- pnpm test:tenant

**不包含：**

- 目标授予权限或自动审批执行
- 真实LLM/Connector网络调用
- 跨店自动资金转移/无限目标优化/部署线上迁移

**风险：** 单测goal安全但runtime工具提权

**并行分组：** `p11-goal-authority`

**执行边界：** 拟新增路径、独占本卡文件；命名端口+测试专用合成fixture可并行实现，runtime wiring满足integrationDependsOn；1–4小时包含验证/PR、独立commit/PR及最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。
