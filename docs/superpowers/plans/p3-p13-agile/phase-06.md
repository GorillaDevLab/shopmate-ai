# Phase 6 — Ask Your Store Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p06-001"></a>

## P06-001：冻结安全工具与结构化答案契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** SafeAgentToolRequest/Result / AgentAnswer / DataEnvelope / AgentRunMetadata

**输入：**

- P03-001/P04-001证据与事件contract；J1 safe tool范围
- org/workspace/store/server actor scope及只读history/proposal candidate port边界

**输出：**

- 工具strict输入输出、facts/correlations/hypotheses、evidence refs及quality/period/version
- provider/offline标识、token/cost/latency/promptVersion元数据contract
- 声明编排可注入ports：SafeToolInvoker/MetricRead/InventoryRiskRead/RefundRead/ProductRead/EventRead/HistoryRead/ProposalCandidate/Provider/ClaimVerifier/RunRepository/BudgetReservationLedger/Clock/Transport；各port方法scope明确，允许test-only fake

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/ai/safe-agent.schema.ts`
- `packages/contracts/src/ai/safe-agent.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P03-001, P04-001

**实际接线依赖：** 无

**验收：**

- [ ] 未知tool/scope注入/超长message拒绝
- [ ] claims必须标明事实/相关性/待验证假设并绑定evidence
- [ ] 未知cost为null、CNY整数费用且无授权action字段

**测试：**

- pnpm --filter @shopmate/contracts test -- src/ai/safe-agent.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 旧chat字符串响应需要显式兼容层

**并行分组：** `ask-agent-1`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-002"></a>

## P06-002：实现租户权限工具调用包装器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** SafeToolInvoker / ServerTenantScopePort

**输入：**

- P06-001及现有ToolRegistry/TenantScopeService；server context注入
- 工具requiredPermissions与store membership resolver port

**输出：**

- 完整scope只读invoke wrapper及default-deny权限结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/safe-tool-invoker.ts`
- `apps/api/src/ai/agent/safe-tool-invoker.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] 客户body的org/store/actor不覆盖server context
- [ ] 权限撤销后同run下一次tool被拒；跨店读不可见
- [ ] 未登记工具/execute_sql/approve/write即使模型请求也拒绝

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/safe-tool-invoker.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 旧merchant上下文不能默认为完整tenant权限

**并行分组：** `ask-agent-2`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-003"></a>

## P06-003：封装经营摘要与指标证据读取工具

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** StoreSummaryTool / MetricReadTool → SafeAgentToolResult

**输入：**

- P06-001及注入MetricReadPort；复用business-overview tool登记格式
- 服务已计算money/ratios、metricDefinitionVersion/window/watermark

**输出：**

- store-summary与metrics两个薄tool adapters

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/tools/store-evidence.tools.ts`
- `apps/api/src/ai/tools/store-evidence.tools.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** P03-001, P2-GATE, P03-018

**验收：**

- [ ] 同window结果保留minor CNY与evidence refs
- [ ] 缺成本不从订单金额猜profit，保留INSUFFICIENT
- [ ] 非法日期/跨scope在service调用前拒绝

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/tools/store-evidence.tools.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 旧overview元单位输出不能混入minor contract

**并行分组：** `ask-agent-3`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-004"></a>

## P06-004：封装库存风险与退款异常证据工具

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** InventoryRiskTool / RefundAnomalyTool

**输入：**

- P06-001及注入inventory/refund evidence query ports
- 退款paid-window与settlement/cohort口径分开

**输出：**

- 两个只读工具及无数据/STALE/partial结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/tools/risk-evidence.tools.ts`
- `apps/api/src/ai/tools/risk-evidence.tools.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** P03-001, P04-001, P2-GATE, P03-018, P04-029

**验收：**

- [ ] 库存risk不把在途数量当可售库存
- [ ] 不同退款窗口标明口径，不拼成同窗增长
- [ ] 未知stock/cost/freshness明确UNAVAILABLE而非0；非法scope拒绝

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/tools/risk-evidence.tools.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 库存与退款看似相似数字却有不同时间口径

**并行分组：** `ask-agent-4`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-005"></a>

## P06-005：封装商品事件与动作历史读取工具

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ProductPerformanceTool / EventsTool / ActionHistoryTool

**输入：**

- P06-001及三只读port，adapter仅验证转发不实现业务查询
- 注入P04事件及P07 action history脱敏摘要

**输出：**

- 三个窄read registrations及统一evidence envelope

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/tools/context-evidence.tools.ts`
- `apps/api/src/ai/tools/context-evidence.tools.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** P03-001, P04-001, P07-001, P2-GATE, P03-018, P04-029, P07-014

**验收：**

- [ ] 商品搜索参数长度/limit校验且非法输入不调用port
- [ ] history只显示已授权scope且剔除actor PII/token
- [ ] events保留事实与effective decision版本，未知action不假称success

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/tools/context-evidence.tools.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 仅薄adapters；查询实现由各领域任务提供

**并行分组：** `ask-agent-5`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-006"></a>

## P06-006：封装单SKU价格候选提案工具

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** PriceProposalCandidateTool / ProposalCandidatePort

**输入：**

- P06-001及P07-001 immutable candidate contract
- 已认证scope、old/new minor价、evidence、version、TTL；注入candidate port

**输出：**

- 仅创建单SKU候选的工具registration及非授权结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/tools/price-candidate.tool.ts`
- `apps/api/src/ai/tools/price-candidate.tool.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001, P07-001

**实际接线依赖：** P09-004, P07-014

**验收：**

- [ ] 候选返回proposal/revision ref，不返回APPROVED/EXECUTING
- [ ] approvedBy/execution fields/批量越界payload被拒
- [ ] 缺fresh evidence或expectedVersion拒绝；记录request/run/evidence链

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/tools/price-candidate.tool.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不提供库存/商品写候选或任何approve/execute/SQL工具

**风险：** 写候选也是mutation必须带同事务审计

**并行分组：** `ask-agent-6`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-007"></a>

## P06-007：构造净化后的不可信DATA信封

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** DataEnvelopeBuilder / UntrustedText

**输入：**

- P06-001工具facts及用户/商品/平台备注不可信文本
- 允许字段白名单、文本/token长度上限、脱敏规则

**输出：**

- 独立DATA序列化器，trusted policy仅来自版本化代码

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/data-envelope.ts`
- `apps/api/src/ai/agent/data-envelope.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] 商品含ignore previous instructions仍只在DATA字段
- [ ] token/手机号/客户姓名/raw prompt不进入外发facts
- [ ] 超长嵌套/非法schema拒绝且错误不回显PII

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/data-envelope.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 字符串sanitize不能替代policy与tool隔离

**并行分组：** `ask-agent-7`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-008"></a>

## P06-008：实现结构化claims与证据核对器

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AgentClaimVerifier / GroundedAnswerResult

**输入：**

- P06-001structured claims、tool结果同snapshot evidence refs
- 复用numeric-grounding思想，仅域服务提供数值分解

**输出：**

- sku/date/metric/unit/value/version逐项核对与拒绝原因

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/evidence-claims.ts`
- `apps/api/src/ai/agent/evidence-claims.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] 捏造数字/商品/日期/evidenceId拒绝
- [ ] 同值但单位/定义version/window错误拒绝
- [ ] 事实、相关性、假设标签分开；相关性不可称因果

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/evidence-claims.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 语言相似不等于正确证据关联

**并行分组：** `ask-agent-8`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-009"></a>

## P06-009：实现明确标注的离线规则摘要

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** OfflineRuleSummaryProvider（仅ApprovedTools port）

**输入：**

- P06-001及注入safe tools/evidence；无网络transport
- 同用户任意合法问题范围，非固定FAQ答案

**输出：**

- mode=OFFLINE_RULE_SUMMARY的结构化摘要及原因

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/offline-rule-summary.ts`
- `apps/api/src/ai/agent/offline-rule-summary.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] 同tool数据生成period/quality/evidence refs而非硬编码数字
- [ ] 无证据返回不足，明确规则摘要不称模型推理
- [ ] 库存/退款/任意范围询问通过safe tools取证且无客户PII

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/offline-rule-summary.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 离线模式必须保留能力边界而不伪装深推理

**并行分组：** `ask-agent-9`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-010"></a>

## P06-010：实现显式Provider策略配置校验

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProviderPolicyConfig / ProviderEligibilityResult

**输入：**

- P06-001及P04-002provider boundary；已核验region/retention/trainingUse/crossBorder配置
- 环境secret引用，不凭key存在自动切换provider

**输出：**

- strict配置校验及默认OFFLINE选择决策

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/policy/provider-policy.ts`
- `apps/api/src/ai/policy/provider-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001, P04-002

**实际接线依赖：** 无

**验收：**

- [ ] 未核验地区/保留期/训练用途策略拒绝远端资格
- [ ] 仅有API key不触发provider切换
- [ ] 非法配置fail-closed且不打印secret；合法offline不需要key

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/policy/provider-policy.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 供应商属性未核验时必须保持离线

**并行分组：** `ask-agent-10`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-011"></a>

## P06-011：实现默认拒绝的出站网关

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AgentEgressGateway / ApprovedDestination / TransportPort

**输入：**

- P06-010eligibility结果及P06-007净化payload
- 注入测试transport；登记destination/region、redirect与超时policy

**输出：**

- 无真实fetch的gateway wrapper及目的地/redirect检查

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/policy/egress-gateway.ts`
- `apps/api/src/ai/policy/egress-gateway.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001, P06-007, P06-010

**实际接线依赖：** 无

**验收：**

- [ ] 未登记host/IP/private目的地/redirect拒绝且transport零调用
- [ ] 已登记目的地仍必须符合region policy与净化信封
- [ ] abort/deadline后迟到结果不入run；错误无secret回显

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/policy/egress-gateway.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** wrapper不能冒充已批准的真实供应商接入

**并行分组：** `ask-agent-11`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-012"></a>

## P06-012：实现Agent预算预约与成本结算

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AgentBudgetLedgerPort / BudgetReservation / UsageSettlement

**输入：**

- P06-001usage/cost contract及注入ledger/Clock
- 显式每run/tenant预算、已核验价表版本，token usage允许未知
- 已核验rateTable version及整数CNY minor保守向上舍入，未知usage不转0且quota不低估

**输出：**

- reserve/settle/release算法与超额停止、未知费用状态

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/policy/agent-budget.ts`
- `apps/api/src/ai/policy/agent-budget.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] 两run争同余额只有一个reservation成功（port CAS）
- [ ] 缺价表/usage不显示0成本或免费；远端禁止资格
- [ ] timeout/cancel按reservation id最多结算一次且超预算停后续tool
- [ ] 亚分单次费用按契约向上预留/结算；不同价表version不静默重算旧run

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/policy/agent-budget.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 预算组件依赖持久ledger接线才有跨进程保障

**并行分组：** `ask-agent-12`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-013"></a>

## P06-013：定义AgentRun与预算账本持久约束

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P1

**契约：** AgentRun/ToolCall/BudgetLedger persistence schema

**输入：**

- P06-001 run metadata；P09-004审计writer及现有tenant transaction接口
- run id/request id唯一、currency/cost unknown、promptVersion；预算reserve CAS

**输出：**

- planned AgentRun/ToolCall/budget ledger表、scope复合约束、request/reservation唯一键及RLS；不保存prompt全文

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004060100_agent_run_ledger/migration.sql`
- `packages/database/test/agent-run-ledger.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`

**硬依赖：** P06-001

**实际接线依赖：** 无

**验收：**

- [ ] migration静态检查scope复合FK及RLS default-deny
- [ ] run/request与budget reservation唯一、usage/cost允许null
- [ ] schema白名单无token/PII/raw prompt列，价表版本必填

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/agent-run-ledger.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** schema集成只由持锁协调者合并，不在本卡运行live迁移

**并行分组：** `ask-agent-13`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 仅提交DDL/schema与本地隔离/静态验证，不执行live migrate；共享Prisma schema由协调者merge lock处理。

<a id="p06-014"></a>

## P06-014：接入安全问答请求与取消流程

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AskYourStoreService / AskYourStoreController

**输入：**

- P06-001与现有assistant-run NDJSON、authenticated tenant context
- 注入SafeToolInvoker/ProviderPort/ClaimVerifier/RunRepository/BudgetPort，测试fake ports

**输出：**

- 安全问答service和控制器兼容stream事件，清楚区分rejected/offline/completed

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/ask-store.service.ts`
- `apps/api/src/ai/agent/ask-store.controller.ts`
- `apps/api/src/ai/agent/ask-store.service.spec.ts`
- `apps/api/src/ai/agent/ask-store.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001

**实际接线依赖：** P06-002, P06-008, P06-009, P06-011, P06-012, P06-013, P06-019

**验收：**

- [ ] 未认证/跨scope/超长问题拒绝不启动run
- [ ] cancel/timeout只发一个终态，迟到claims不覆盖fallback
- [ ] tool预算超额停止且记录脱敏reason，不自动重复创建候选

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/ask-store.service.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 只实现依赖编排；不同时实现provider/tools/ledger

**并行分组：** `ask-agent-14`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-015"></a>

## P06-015：展示问答证据质量与离线模式

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** GroundedAnswerProps / AgentRunPresentation

**输入：**

- P06-001AgentAnswer与run状态；P05-001 evidence navigation refs
- 复用assistant/conversation、assistant-markdown和现有tokens

**输出：**

- 独立问答evidence/period/quality/offline标注组件与cost未知显示

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/assistant/grounded-answer.tsx`
- `apps/web/src/app/assistant/grounded-answer.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-001, P05-001

**实际接线依赖：** P05-010

**验收：**

- [ ] OFFLINE_RULE_SUMMARY清晰显示规则摘要；未知cost不显示0
- [ ] 事实/相关性/假设分栏标签并链接授权scope证据
- [ ] 375px/loading/empty/error及拒绝回答可读；恶意Markdown无执行脚本

**测试：**

- pnpm --filter @shopmate/web test -- src/app/assistant/grounded-answer.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 复用markdown渲染也必须限制危险链接

**并行分组：** `ask-agent-15`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-016"></a>

## P06-016：装配安全工具与离线问答运行路径

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** SafeAgentModule runtime bindings

**输入：**

- P06全部组件及P03/P04/P07真实ports、P2 source gate
- 已完成P09审计writer；默认provider=offline无外网

**输出：**

- DI module/allowlist注册、已有assistant endpoint兼容和grounded answer嵌入

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/safe-agent.module.ts`
- `apps/api/test/safe-agent-wiring.integration.spec.ts`
- `apps/web/src/app/assistant/grounded-answer-integration.test.tsx`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/web/src/app/assistant/conversation.tsx`

**硬依赖：** P06-002, P06-003, P06-004, P06-005, P06-006, P06-007, P06-008, P06-009, P06-010, P06-011, P06-012, P06-013, P06-014, P06-015, P03-001, P04-001, P07-001, P09-004, P2-GATE, P06-019, P03-018, P04-029, P07-014, P07-019, P05-010

**实际接线依赖：** 无

**验收：**

- [ ] 注册名单无SQL/Connector write/approve/execute/token工具
- [ ] 默认离线的全部数据来自真实同scope read ports，网络transport零调用
- [ ] 既有assistant请求保留取消/error事件，候选mutation有audit

**测试：**

- pnpm --filter @shopmate/api test -- test/safe-agent-wiring.integration.spec.ts
- pnpm --filter @shopmate/web test -- src/app/assistant/grounded-answer-integration.test.tsx
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 统一wiring只在全部integration gate达成后开始

**并行分组：** `ask-agent-16`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 所有consumes中的实际runtime实现必须已合入；contract ID只锁接口，不代表实现可用，协调者需补全提供方integration卡硬依赖。

<a id="p06-017"></a>

## P06-017：验证提示注入与越权安全边界

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** SafeAgent security regression corpus

**输入：**

- P06-016本地离线runtime；受控恶意用户/商品/平台备注fixture
- 包括scope替换、SQL/approval工具要求、secret外发请求

**输出：**

- 端到端安全回归集，统计tool/transport零未授权调用

**独占文件（新路径为计划创建）：**

- `apps/api/test/safe-agent-security.integration.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-016

**实际接线依赖：** 无

**验收：**

- [ ] ignore-policy注入不能改变trusted policy或调用未登记tool
- [ ] 不同org/workspace/store/evidence scope请求全部拒绝
- [ ] 手机号/token/prompt全文不进入metadata/response/egress

**测试：**

- pnpm --filter @shopmate/api test -- test/safe-agent-security.integration.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 样例注入回归不代表所有语言攻击已覆盖

**并行分组：** `ask-agent-17`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-018"></a>

## P06-018：验证非固定问题的数值证据与界面

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** AskYourStore grounded response acceptance

**输入：**

- P06-016真实read runtime和P05 evidence page
- 三类不同问法/范围及无cost、stale、取消fixture

**输出：**

- 数值/period/quality/claims API回归与375px UI截图

**独占文件（新路径为计划创建）：**

- `apps/api/test/safe-agent-grounding.integration.spec.ts`
- `tests/e2e/safe-agent-answer.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-016, P05-010

**实际接线依赖：** 无

**验收：**

- [ ] 销量涨利润降问题从同数据discount/spend/mix服务取证；不写死百分比
- [ ] 退款与库存自由问法仍调用tools并呈现口径/unknown
- [ ] 375px离线、loading/empty/error、evidence导航可见；timeout不假成功

**测试：**

- pnpm --filter @shopmate/api test -- test/safe-agent-grounding.integration.spec.ts
- pnpm exec playwright test tests/e2e/safe-agent-answer.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 因果分解服务不可由模型心算代替

**并行分组：** `ask-agent-18`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p06-019"></a>

## P06-019：实现AgentRun与预算预约事务仓库

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** AgentRunRepository / BudgetLedgerPort

**输入：**

- P06-013 schema与P06-001 metadata，既有tenant transaction API
- P09-004 audit append writer；ledger CAS与request唯一约束

**输出：**

- 参数化run/ToolCall元数据与budget reserve/settle仓库，所有mutation同事务写audit

**独占文件（新路径为计划创建）：**

- `apps/api/src/ai/agent/agent-run.repository.ts`
- `apps/api/src/ai/agent/agent-run.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P06-013, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] run/reservation/audit失败任一发生都整体回滚
- [ ] 受限身份跨scope拒绝；未知token/cost维持null
- [ ] 并发相同request仅一个run/reservation，取消最多settle一次

**测试：**

- pnpm --filter @shopmate/api test -- src/ai/agent/agent-run.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不暴露SQL、token、Connector write、approve/execute tools

**风险：** 真实并发保证必须用隔离本地PostgreSQL验证

**并行分组：** `ask-agent-19`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。
