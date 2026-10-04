# Phase 7 — Human Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p07-001"></a>

## P07-001：定义提案修订、审批绑定与人工身份契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ActionProposalV1 / ApprovalBindingV1 / HumanApprovalIdentity / CurrentAuthorityReader / ProposalRepository

**输入：**

- 现有TenantContext/CommerceConnector SetPriceCommand与CNY整数分语义
- J2不可变修订、哈希、安全TTL；HumanApprovalIdentity仅由服务端认证适配器建立

**输出：**

- strict提案/approval DTO；org/workspace/store/connection/generation、旧新值、sourceVersion、evidenceRefs、riskRuleVersion、revision/hash/expiry
- 明确actions:propose/approve及店铺products:write检查；近期重认证证明与撤销查询端口；审批body禁止actor/approvedBy

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/actions/proposal.schema.ts`
- `packages/contracts/src/actions/proposal.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] 未知字段approvedBy/权限/tenant覆盖被schema拒绝
- [ ] revision/hash/TTL、currency/sourceVersion缺失被拒绝
- [ ] AI候选不得产生HumanApprovalIdentity；critical首期禁止审批

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/actions/proposal.schema.spec.ts

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** Demo身份没有近期认证/吊销证明

**并行分组：** `p07-proposal.schema`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。契约导出由协调者持packages/contracts/src/index.ts合并锁；不把旧AuthContext升级为可信近期认证。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-002"></a>

## P07-002：实现不可变payload规范化与哈希

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** CanonicalProposalHash

**输入：**

- 已验证ProposalPayload；作用域/connection generation/sourceVersion/证据版本/有效期
- node:crypto SHA-256；禁止hash依赖未规范化任意JSON

**输出：**

- 稳定序列化及hash纯函数
- hash覆盖执行相关字段且不随展示字段变化

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/proposal-hash.ts`
- `apps/api/src/actions/proposal-hash.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** 无

**验收：**

- [ ] 对象键顺序变化不改变hash
- [ ] 旧新价/源版本/证据版本/店铺/TTL任一变更改变hash
- [ ] 非法金额及未知执行字段先校验拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/proposal-hash.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 未纳入哈希字段导致审批复用

**并行分组：** `p07-proposal-hash`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-003"></a>

## P07-003：实现单SKU价格风险与硬限制

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** PriceRiskPolicyV1

**输入：**

- 单SKU旧价/目标价CNY整数分；证据quality/freshness；capability snapshot
- 版本化阈值>10% HIGH、>30% CRITICAL；零旧价拒绝比例

**输出：**

- deterministic risk与reasonCodes
- 首期单SKU、CRITICAL禁用、所有风险仍需人工审批

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/price-risk-policy.ts`
- `apps/api/src/actions/price-risk-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** P03-001, P13-001

**验收：**

- [ ] 59→62得到可审批风险且保留ruleVersion
- [ ] 10%/30%边界、旧价0与unsafe integer可复算且拒绝/升级
- [ ] 批量、非CNY、过期/不足证据或无writePrice能力被拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/price-risk-policy.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 事件severity被误用为动作授权

**并行分组：** `p07-price-risk-policy`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-004"></a>

## P07-004：定义并验证提案审批状态转移

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProposalTransitionV1

**输入：**

- J2提案状态；带expectedRevision的命令
- real SecurityClock；拒绝/过期事件与immutable revision

**输出：**

- 纯转移表DRAFT/PROPOSED/PENDING_APPROVAL/APPROVED/REJECTED/EXPIRED
- 修订使旧approval无效的确定性结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/proposal-transition.ts`
- `apps/api/src/actions/proposal-transition.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** 无

**验收：**

- [ ] DRAFT→PROPOSED→PENDING_APPROVAL及人工拒绝合法
- [ ] APPROVED内容编辑创建新revision回待审批，旧approval不得沿用
- [ ] 越级EXECUTING/过期审批/旧revision拒绝且不改状态

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/proposal-transition.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 乐观状态并发误接受

**并行分组：** `p07-proposal-transition`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-005"></a>

## P07-005：新增提案和不可变修订表

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** ProposalPersistenceV1

**输入：**

- 现有tenant复合FK/RLS迁移样例
- ActionProposalV1与不可变revision/hash结构

**输出：**

- additive Prisma ActionProposal/ProposalRevision、同org/store复合FK及查询索引
- 独立migration与离线模型契约测试

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/proposal-model-contract.ts`
- `packages/database/test/actions/proposal-model-contract.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005070100_action_proposals/migration.sql`

**硬依赖：** P07-001

**实际接线依赖：** 无

**验收：**

- [ ] schema validate及空库/升级路径迁移SQL定义可审阅
- [ ] 跨组织/跨店外键、唯一revision及整数money约束明确存在
- [ ] RLS USING/WITH CHECK、无scope拒绝及受限角色权限列明

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/proposal-model-contract.test.mjs

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** Prisma聚合schema合并冲突

**并行分组：** `p07-proposal-model-contract`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。持Prisma/schema-migration序列合并锁；本卡不声称真实PostgreSQL隔离已证明，由P07-015验证。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-006"></a>

## P07-006：新增审批记录与修订引用约束

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** ApprovalPersistenceV1

**输入：**

- ProposalRevision tenant复合键
- 服务端human actor、auth event/ref、revision/hash/decision/real timestamp

**输出：**

- ActionApproval append-only模型及同租户revision引用
- 独立migration与重复决策策略约束

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/approval-model-contract.ts`
- `packages/database/test/actions/approval-model-contract.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005070200_action_approvals/migration.sql`

**硬依赖：** P07-001, P07-005

**实际接线依赖：** 无

**验收：**

- [ ] 审批只能关联同org/store已存在revision
- [ ] actor/authenticatedAt/revision/hash不可空且不存token
- [ ] 迁移契约拒绝跨店关联和无scope访问策略缺失

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/approval-model-contract.test.mjs

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 旧修订审批漂移

**并行分组：** `p07-approval-model-contract`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。继P07-005后持Prisma合并锁；真实DB约束交P07-015。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-007"></a>

## P07-007：实现提案保存、修订和审计事务仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ProposalRepository / TransactionAuditAppend

**输入：**

- tenant事务client；ProposalPersistenceV1
- P09-004同事务append writer；expectedRevision CAS

**输出：**

- scoped create/read/updateRevision仓库
- 每次候选/修订状态突变原子写audit；旧approval立即不可执行

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/proposal.repository.ts`
- `apps/api/src/actions/proposal.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-002, P07-004, P07-005, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 同scope创建/读取保留hash及revision
- [ ] 并发同revision编辑仅一个成功，其余409
- [ ] audit写失败回滚提案/修订；跨tenant读取无结果

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/proposal.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 审计异常产生无日志突变

**并行分组：** `p07-proposal.repository`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-008"></a>

## P07-008：实现人工批准与拒绝的原子服务

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ApproveProposal / RejectProposal / ApprovalRepository

**输入：**

- HumanApprovalIdentity由current-authority reader核验；expectedRevision/hash
- tenant transaction及security clock；策略规定risk权限和actor分离

**输出：**

- 批准/拒绝原子CAS、approval append及audit
- 内容变更/过期/撤销均拒绝且不会留下APPROVED

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/approval.service.ts`
- `apps/api/src/actions/approval.service.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-004, P07-006, P07-007, P07-009, P09-004, P07-019

**实际接线依赖：** 无

**验收：**

- [ ] 合法人工approve绑定org/store/action/revision/hash且无自动执行
- [ ] 同时批准/拒绝或双批准只有一个有效决策
- [ ] Viewer、body冒充actor、过期/重认证缺失/critical拒绝；audit失败全部回滚

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/approval.service.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 并发审批与权限撤销竞争

**并行分组：** `p07-approval.service`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-009"></a>

## P07-009：实现当前人工权限与近期认证守卫

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** CurrentAuthorityReader / ApprovalPolicy

**输入：**

- 受信服务端session/auth-event读取端口；当前membership/resource permission
- real security clock、可配置近期认证窗口、risk actor分离规则

**输出：**

- deny-by-default审批policy及错误code
- Demo适配无法证明authenticatedAt/revocation时明确拒绝需重认证

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/human-approval-policy.ts`
- `apps/api/src/actions/human-approval-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** 无

**验收：**

- [ ] actions:approve+store products:write且可信近期人工认证允许
- [ ] member撤销、session过期、无近期认证证明拒绝；模拟时间快进不延长TTL
- [ ] VIEWER/ANALYST、AI actor或高风险自批违反策略拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/human-approval-policy.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 旧Demo会话被误视生产身份

**并行分组：** `p07-human-approval-policy`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。生产identity/MFA系统建设另有发布门禁；测试fixture只模拟受信认证端口，不注册假认证生产实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-010"></a>

## P07-010：新增提案创建与修订HTTP入口

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProposalHttpV1

**输入：**

- TenantScopeService.resolve + strict header/path scope/current auth + route-specific strict body；不使用拒绝body/query的context-read-only guard；及server identity；ProposalRepository/PriceRiskPolicy端口
- strict body，actions:propose且拥有store范围

**输出：**

- 拟新增POST /v1/actions/proposals及修订入口
- 认证/授权默认拒绝、输入校验及409/410错误映射

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/proposal.controller.ts`
- `apps/api/src/actions/proposal.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** P07-003, P07-007, P07-009

**验收：**

- [ ] 匿名/Viewer/跨store/注入tenant请求拒绝
- [ ] 合法单SKU提案返回revision/hash/risk和待审批状态
- [ ] 无效金额/未知字段400，旧revision409，不包含approval secret

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/proposal.controller.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 绕Agent直调API绕过Policy

**并行分组：** `p07-proposal.controller`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-011"></a>

## P07-011：新增人工审批HTTP入口

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ApprovalHttpV1

**输入：**

- server-only HumanApprovalIdentity与ApprovalService端口
- strict expectedRevision/payloadHash/decision；现有cookie/CSRF约束

**输出：**

- 拟新增POST /v1/actions/:id/approval
- 批准/拒绝由真实登录actor派生；无AI tool注册

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/approval.controller.ts`
- `apps/api/src/actions/approval.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** P07-008, P07-009

**验收：**

- [ ] 伪造approvedBy/authenticatedAt及额外权限字段400
- [ ] 匿名/跨组织/未近期重认证403或明确AUTH_REQUIRED
- [ ] 合法批准与拒绝映射正确；hash/revision变更409、过期410

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/approval.controller.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** body伪造审批actor

**并行分组：** `p07-approval.controller`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-012"></a>

## P07-012：制作提案证据、风险与影响预览卡

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P0

**契约：** ProposalPreviewViewModel

**输入：**

- WHAT/WHY/EVIDENCE/OLD/NEW/SCOPE/RISK/IMPACT完整view-model
- 现有Card/证据链接/金额格式；不可用影响显示未知

**输出：**

- 独立预览组件与展示fixture
- 375px/桌面且loading/empty/error状态完整

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/actions/proposal-preview.tsx`
- `apps/web/src/app/actions/proposal-preview.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** P05-001

**验收：**

- [ ] 旧新价、作用域、风险版本、证据截至时间清晰显示
- [ ] 缺成本/影响未知不显示准确利润或0；不可信商品标题仅text呈现
- [ ] 375px无横向溢出；loading/empty/error可测

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/actions/proposal-preview.test.tsx

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 预览误导用户影响确定性

**并行分组：** `p07-proposal-preview`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-013"></a>

## P07-013：制作显式人工审批交互

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P0

**契约：** ApprovalFormV1

**输入：**

- 注入approve/reject client、current authorization view和preview组件
- 固定revision/hash/TTL；需重认证/二次确认策略

**输出：**

- 无默认勾选的审批/拒绝UI
- 权限不足、过期和内容更新强制刷新确认

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/actions/approval-form.tsx`
- `apps/web/src/app/actions/approval-form.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001

**实际接线依赖：** P07-011, P07-012

**验收：**

- [ ] 明确确认旧新值后发送当前revision/hash，不发送actor
- [ ] Viewer禁用且错误403可恢复；409/410撤销旧确认并刷新
- [ ] 二次确认可取消无请求；375px键盘可达与提交loading/错误态

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/actions/approval-form.test.tsx

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 用户确认了过期版本

**并行分组：** `p07-approval-form`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-014"></a>

## P07-014：接入提案审批模块及前端路由

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** ActionsModuleWiringV1

**输入：**

- 当前scope/connection/evidence实现与受信auth adapter
- 已完成提案API/UI组件；现有AI candidate不具审批权限
- P07-018本地可吊销session+近期认证适配器；P07-019真实身份证明
- 新Actions POST/filtered route用TenantScopeService.resolve+validated header/path scope，不直接套只读TenantContextGuard

**输出：**

- Nest模块/Actions route客户端与已批准单SKU映射
- 注册strict契约exports与当前身份适配；未支持近期认证时fail closed

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/actions.module.ts`
- `apps/api/src/actions/actions.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/app/page.tsx`

**硬依赖：** P07-003, P07-007, P07-008, P07-010, P07-011, P07-012, P07-013, P09-004, P2-GATE, P07-019

**实际接线依赖：** 无

**验收：**

- [ ] HTTP→repository→audit在同租户路径可调用
- [ ] 已有内部阈值确认原型不被冒充为平台审批；AI registry无approve/execute
- [ ] UI真实API拒绝身份缺证明和旧revision；模块加载无循环依赖

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/actions.module.spec.ts --maxWorkers 1

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 共享API根与旧AI动作入口冲突

**并行分组：** `p07-actions.module`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。聚合文件分别持API-registration/contracts-export/Web-root协调锁；本卡新文件可按app边界拆辅助仅属此卡，不新增认证系统。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-015"></a>

## P07-015：证明审批数据库隔离与并发回滚

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ApprovalAtomicityProof

**输入：**

- isolated-postgres helper创建可销毁数据库；受限app角色
- 合成两组织两店HumanApprovalIdentity；不访问线上DB

**输出：**

- 真实PostgreSQL FK/RLS/CAS/audit rollback证明
- 将新suite纳入强制隔离数据库runner且不可silent skip

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/action-approval.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P07-005, P07-006, P07-007, P07-008, P09-004, P07-019

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store审批关联与missing scope被DB拒绝
- [ ] 并行批准/拒绝、修订/批准只有一个有效状态；旧approval不生效
- [ ] audit故障回滚approval与proposal状态；空库/升级迁移验证且0 skipped

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台或LLM网络调用
- 部署或线上迁移
- AI审批/通用SQL/直接Connector执行工具

**风险：** 文本schema测试不能证明真实隔离

**并行分组：** `p07-action-approval`

**执行边界：** 路径为拟新增；独占本卡文件。1–4小时含实现、定向验证和PR准备；函数/测试回调<40行、无any；独立commit，feat/add/fix分支及PR审查+最新CI通过并合并才Done。组件仅依赖命名端口和测试专用合成fixture；集成依赖满足后才接真实实现。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-016"></a>

## P07-016：新增可吊销会话与近期认证事实表

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** HumanSessionPersistence / HumanAuthenticationEvent

**输入：**

- 现有UserAccount和Demo兼容身份；服务端subjectId
- 会话tokenHash、expiresAt/revokedAt/authenticatedAt和authMethod；禁止存raw token/密码

**输出：**

- 增量session及近期auth-event schema/受限查询权限
- 独立migration、仅服务端session mint权限
- session-scoped reauthAttemptCount/windowStartedAt typed metadata，供P07-020原子尝试预算

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/human-session-model.ts`
- `packages/database/test/actions/human-session-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005070300_human_sessions/migration.sql`

**硬依赖：** P07-001

**实际接线依赖：** 无

**验收：**

- [ ] tokenHash唯一且raw token不入库
- [ ] expired/revoked与auth-event subject绑定可查询，不使用模拟业务时钟
- [ ] 服务端历史cookie无持久session关联不能构造近期认证证明

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/human-session-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 外部身份Provider/MFA供应商接入
- 完整生产密码重置/身份上线验收
- 真实平台调用/部署/线上迁移

**风险：** 兼容Demo subject与UserAccount关联

**并行分组：** `p07-human-auth-16`

**执行边界：** 拟新增文件独占；共享auth/schema/runner需协调合并锁。估时包含定向验证、PR，独立commit；安全时钟真实时间。tenant授权仍从当前membership查，不从cookie权限赋权；真实DB迁移由P07-019验证。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-017"></a>

## P07-017：实现当前会话吊销与认证事实仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** HumanSessionRepository / CurrentAuthorityReader

**输入：**

- HumanSessionPersistence、当前user/membership读取端口
- P09-004同事务审计与真实SecurityClock

**输出：**

- session mint/read/revoke及auth-event读取仓库
- server CurrentAuthorityReader输出当前human actor与权限，不返回凭证
- session metadata原子attempt CAS端口；无跨实例内存授权/预算

**独占文件（新路径为计划创建）：**

- `apps/api/src/auth/human-session.repository.ts`
- `apps/api/src/auth/human-session.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-016, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 有效session映射subject并读取当前membership权限
- [ ] expired/revoked、account禁用、membership撤销立即拒绝
- [ ] revoke/auth-event突变audit失败全部回滚；token不出现在异常日志

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/auth/human-session.repository.spec.ts --maxWorkers 1

**不包含：**

- 外部身份Provider/MFA供应商接入
- 完整生产密码重置/身份上线验收
- 真实平台调用/部署/线上迁移

**风险：** 签名cookie无数据库吊销校验

**并行分组：** `p07-human-auth-17`

**执行边界：** 拟新增文件独占；共享auth/schema/runner需协调合并锁。估时包含定向验证、PR，独立commit；安全时钟真实时间。repo调用只收验证后subject，绝不由请求body设置actor/authenticatedAt。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-018"></a>

## P07-018：接入登录登出与显式近期重认证

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** HumanApprovalIdentityAdapter / ReauthenticateHttp

**输入：**

- 现有本地登录凭证校验与session cookie实现；不新增供应商/硬编码密钥
- server session repository、strict本地reauth body、现有sameSite=Lax cookie，仅此不足以证明CSRF/限流；需P07-020安全边界
- AuditAppendPort由P09-004提供；login/logout/reauth的session/auth-event及audit在同一数据库transaction提交

**输出：**

- 成功本地登录mint持久session关联；登出先revoke再clear cookie
- 显式reauth核验本地凭据后记录authenticatedAt/authMethod；guard建立server-only human identity
- 可信login/logout/reauth审计最小actor/session reference，不记密码/token/raw prompt；legacy synthetic登录兼容
- 成功与失败login、logout、reauth均通过AuditAppendPort记录脱敏结果；未知登录subject使用明确anonymous security event，绝不伪造tenant/actor，不存密码/cookie/token

**独占文件（新路径为计划创建）：**

- `apps/api/src/auth/human-approval-auth.service.ts`
- `apps/api/src/auth/human-approval-auth.controller.ts`
- `apps/api/src/auth/human-approval-auth.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/auth/demo-auth.module.ts`
- `apps/api/src/auth/demo-auth.service.ts`
- `apps/api/src/auth/demo-auth.controller.ts`
- `apps/api/src/auth/access/merchant-scope.guard.ts`
- `apps/api/src/auth/contracts/auth-context.ts`

**硬依赖：** P07-017, P07-009, P09-004, P07-020

**实际接线依赖：** 无

**验收：**

- [ ] 旧cookie读接口兼容但没有近期认证证明不得审批
- [ ] 登出复制cookie重放被拒绝；客户端伪造authenticatedAt不可生效
- [ ] reauth错误/限流/CSRF拒绝，成功绑定同subject与session且不刷新旧approval TTL
- [ ] audit append失败不mint/续证/吊销半提交；无可信身份的拒绝尝试采用脱敏安全事件记录
- [ ] 失败login/reauth有resultCode与requestId，audit无密码/cookie/token/完整email；匿名失败按P09契约安全事件记录，不冒充已认证actor

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/auth/human-approval-auth.spec.ts test/auth-login.e2e-spec.ts --maxWorkers 1

**不包含：**

- 外部身份Provider/MFA供应商接入
- 完整生产密码重置/身份上线验收
- 真实平台调用/部署/线上迁移

**风险：** auth共享文件与旧Demo兼容

**并行分组：** `p07-human-auth-18`

**执行边界：** 拟新增文件独占；共享auth/schema/runner需协调合并锁。估时包含定向验证、PR，独立commit；安全时钟真实时间。持auth-adapter协调锁，改动只做会话/近期认证接桥；CRITICAL仍禁用，需MFA策略若无MFA证明fail closed，不声称生产身份完整。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 P09 AuditAppendPort需支持未知subject的脱敏安全事件，若tenant未建立保持显式无scope security event；此能力与audit契约作者协调，不通过body提供tenant。

<a id="p07-019"></a>

## P07-019：证明近期认证和吊销阻断审批执行

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** HumanApprovalIdentityProof

**输入：**

- isolated-postgres与真实本地auth HTTP fixture
- 当前membership、real clock与持久session

**输出：**

- 必跑数据库+HTTP集成证明及runner注册
- expiry/revoke/member撤销/近期auth证明回归

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/human-approval-auth.test.mjs`
- `apps/api/test/human-approval-auth.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`

**硬依赖：** P07-016, P07-017, P07-018, P09-004, P07-020

**实际接线依赖：** 无

**验收：**

- [ ] 本地合法登录/reauth可建立真实human审批身份
- [ ] 复制cookie在logout后被拒；撤销member后approval与worker reader均拒
- [ ] 模拟时钟advance不延长session/approval；旧cookie/伪造body/AI candidate不得获得身份

**测试：**

- pnpm test:tenant

**不包含：**

- 外部身份Provider/MFA供应商接入
- 完整生产密码重置/身份上线验收
- 真实平台调用/部署/线上迁移

**风险：** 单测假身份掩盖吊销失败

**并行分组：** `p07-human-auth-19`

**执行边界：** 拟新增文件独占；共享auth/schema/runner需协调合并锁。估时包含定向验证、PR，独立commit；安全时钟真实时间。只隔离本地数据库；关联approval API最终安全验收在P07-015，必须先完成本卡。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p07-020"></a>

## P07-020：实现近期重认证的同源和尝试次数边界

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ReauthenticationSafetyBoundary / ReauthAttemptBudget

**输入：**

- P07-001 human auth契约；P07-017真实session reader与SecurityClock
- 已验证服务端部署origin配置，现有sameSite=Lax cookie不等于CSRF证明

**输出：**

- 近期重认证POST的strict Origin/CSRF check与session-scoped bounded尝试计数
- 原子持久attempt budget使用P07-016 session metadata；配置缺失默认拒绝，不信任客户端proxy header

**独占文件（新路径为计划创建）：**

- `apps/api/src/auth/reauth-safety.ts`
- `apps/api/src/auth/reauth-safety.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P07-001, P07-016, P07-017

**实际接线依赖：** 无

**验收：**

- [ ] 同源有效CSRF请求允许验证，foreign/missing-invalid origin/token按明确策略拒绝
- [ ] 同session连续失败触发429，真实时间窗口到期恢复；并发请求不能越过budget
- [ ] body伪造session/source ip/authenticatedAt拒绝；日志无密码/token，缺origin配置默认拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/auth/reauth-safety.spec.ts --maxWorkers 1

**不包含：**

- 完整跨实例登录WAF/密码重置/MFA生产身份系统
- 外部身份Provider/真实平台调用
- 部署/线上迁移

**风险：** 重认证endpoint因CSRF或无限尝试伪造近期身份

**并行分组：** `p07-reauth-safety`

**执行边界：** 拟新增独占文件；仅近期重认证安全边界，复用真实session store并以原子UPDATE完成session-scoped attempt budget，不另建广域限流服务。3小时包含实现/验证/PR；独立commit，最新CI/审查并合并才Done。函数/回调/SQL体<40行、无any；配置和secret仅env。
