# Phase 8 — Mock Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p08-001"></a>

## P08-001：定义执行、租约、回执和验证契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ActionExecutionV1 / ExecutionRepository / ExecutionAuthorityReader / VerificationScheduler

**输入：**

- 现有CommerceConnector WriteReceipt/VerificationResult/SetPriceCommand
- J2 proposal状态与execution子状态；real TTL/lease clock

**输出：**

- stable executionId/tenant idempotencyKey、approval绑定/connection generation、lease/fencing token、attempt与deadline
- ACCEPTED/UNKNOWN收据与PENDING/UNKNOWN/VERIFIED/MISMATCH验证；验证完成前proposal保留EXECUTING

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/actions/execution.schema.ts`
- `packages/contracts/src/actions/execution.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] ACCEPTED/UNKNOWN均不能直接标SUCCEEDED
- [ ] execution/receipt/verify correlation或scope缺失拒绝
- [ ] unsupported相对写/无approval/unsafe money/过期deadline被schema拒绝

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/actions/execution.schema.spec.ts

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 将HTTP200视成功

**并行分组：** `p08-execution.schema`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。contract export协调锁；暂不注册执行为Agent tool。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-002"></a>

## P08-002：新增执行表、幂等键及租约字段

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** ExecutionPersistenceV1

**输入：**

- 同tenant/store approval revision FK及outbox模型
- tenant+idempotency key唯一；stable executionId/fencing/leaseUntil

**输出：**

- incremental ActionExecution Prisma model/migration
- 持久receipt/verification/deadline字段与RLS/索引约束

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/execution-model.ts`
- `packages/database/test/actions/execution-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080100_action_executions/migration.sql`

**硬依赖：** P08-001, P07-006, P10-002

**实际接线依赖：** 无

**验收：**

- [ ] 同tenant key重复创建被唯一约束拒绝
- [ ] 跨store approval FK和缺scope RLS明确拒绝
- [ ] lease/attempt安全整数及receipt不含token；空库/升级离线契约可跑

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/execution-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** schema与job底座集成漂移

**并行分组：** `p08-execution-model`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-003"></a>

## P08-003：原子保留执行并写outbox审计

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ExecutionRepository.reserveApproved / TransactionOutboxEnqueue

**输入：**

- 已批准immutable revision/hash和当前authority recheck
- tenant transaction，稳定idempotencyKey及job payload

**输出：**

- CAS APPROVED→EXECUTING、execution insert、outbox job和audit同事务
- 重复请求读取原execution而不生成第二job

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution.repository.ts`
- `apps/api/src/actions/execution.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-002, P07-008, P09-004, P10-003

**实际接线依赖：** 无

**验收：**

- [ ] 两个相同key竞争只一条execution/job/audit有效转移
- [ ] 新revision/hash、过期approval或撤销权限拒绝
- [ ] outbox或audit异常使APPROVED状态及执行记录全部回滚

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 状态已变但任务未入队

**并行分组：** `p08-execution.repository`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-004"></a>

## P08-004：实现执行前当前授权和源版本守卫

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ExecutionAuthorityReader / ExecutionPreflight

**输入：**

- 当前session/membership/role、store status/feature flag、connection generation/capability
- 源read current oldPrice/version及已批准hash/expiry；不是队列内旧权限snapshot

**输出：**

- 默认拒绝的preflight decision与明确停止原因
- 原生CAS或READ_THEN_WRITE限制scope后漂移重审批

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-preflight.ts`
- `apps/api/src/actions/execution-preflight.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001

**实际接线依赖：** P07-019, P2-GATE

**验收：**

- [ ] session过期/revoke、店铺删除/disconnect/generation变化任一阻断dispatch
- [ ] 同价但源版本已变仍冲突，不覆盖商家手动更新
- [ ] 仅现有单SKU价格且writePrice及capability有效允许；critical/无proof拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-preflight.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 等待lease期间授权改变

**并行分组：** `p08-execution-preflight`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-005"></a>

## P08-005：构建绝对单SKU价格命令

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ApprovedPriceCommandBuilder

**输入：**

- 通过preflight的immutable proposal+approval+execution绑定
- SetPriceCommand现有DTO与expectedVersion/oldPrice/newPrice/CNY

**输出：**

- strict SetPriceCommand builder
- command executionId/key与approved revision/hash完全相关

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/price-command-builder.ts`
- `apps/api/src/actions/price-command-builder.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001

**实际接线依赖：** 无

**验收：**

- [ ] 59→62产出5900→6200且携带当前expectedVersion
- [ ] 跨SKU/币种/hash/revision/sourceVersion变化拒绝
- [ ] inventory +100/批量/未知动作不构建命令；同execution重建完全一致

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/price-command-builder.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 绝对价格覆盖手动新价

**并行分组：** `p08-price-command-builder`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-006"></a>

## P08-006：分离dispatch回执与成功状态

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ConnectorDispatchPort / ReceiptReducer

**输入：**

- 绑定当前connection的CommerceConnector.updatePrice；AbortSignal/deadline
- ExecutionRepository持久receipt端口与fencing token

**输出：**

- 一次dispatch及receipt reducer；ACCEPTED/UNKNOWN转验证job
- 明确REJECTED可记录失败，transport timeout保留UNKNOWN

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/price-dispatch.ts`
- `apps/api/src/actions/price-dispatch.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P08-005

**实际接线依赖：** P08-004, P08-003, P2-GATE, P08-009

**验收：**

- [ ] ACCEPTED不标成功，安排验证
- [ ] timeout-after-write不重新调用updatePrice；UNKNOWN也安排验证
- [ ] 错误executionId/非法receipt拒绝并UNKNOWN；审计持久化失败不伪造成功

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/price-dispatch.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 超时后写被重复执行

**并行分组：** `p08-price-dispatch`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-007"></a>

## P08-007：校验回读归属并映射验证状态

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** VerificationResultReducer

**输入：**

- 现有parseConnectorVerification trusted binding+原始query
- receipt不是真相；单SKU价格expected state与readback

**输出：**

- correlation/snapshot检查及execution验证转移纯函数
- VERIFIED→SUCCEEDED；MISMATCH明确冲突；PENDING/UNAVAILABLE→未核实

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-verification.ts`
- `apps/api/src/actions/execution-verification.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001

**实际接线依赖：** 无

**验收：**

- [ ] 正确sku/store/currency/value的独立回读才成功
- [ ] 错误store/executionId/SKU或provider伪称VERIFIED被拒
- [ ] PENDING/UNAVAILABLE及deadline前后均不伪造success；mismatch停止写重试

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-verification.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 信任provider自称VERIFIED

**并行分组：** `p08-execution-verification`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-008"></a>

## P08-008：实现验证调度和待核实deadline

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** VerificationScheduler / ReadbackJob

**输入：**

- 验证read-only端口、real security deadline与bounded backoff/jitter
- connection/current authority reader；durable enqueue/audit update事务端口

**输出：**

- 仅read-back retry的持久verify job
- deadline到达标UNKNOWN/需人工核实并停止自动写重试

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/verification-scheduler.ts`
- `apps/api/src/actions/verification-scheduler.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P08-007

**实际接线依赖：** P08-009, P09-004, P10-003, P2-GATE

**验收：**

- [ ] 短暂PENDING按retryAfter受上限安排readback
- [ ] 超deadline停止调度、UI状态待核实、无write调用
- [ ] connection撤销/权限变化立即停止；outbox/audit异常回滚状态与next check

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/verification-scheduler.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 无限回读或模拟时钟绕TTL

**并行分组：** `p08-verification-scheduler`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-009"></a>

## P08-009：实现执行租约和fencing存储

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ExecutionLeaseRepository / CommitExecutionOutcome

**输入：**

- 受限tenant事务client与ExecutionPersistenceV1
- real leaseUntil、monotonic fencing token、原子claim
- P09-004 audit append与P10-003 outbox enqueue，沿用同一tenant transaction

**输出：**

- claim/renew/complete受token约束
- 过期worker不能完成新owner记录
- fenced receipt/verification outcome commit与audit+后继verify job原子写入，供P08-006/008调用

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-lease.repository.ts`
- `apps/api/src/actions/execution-lease.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-002, P09-004, P10-003

**实际接线依赖：** 无

**验收：**

- [ ] 并行claim仅一个取得有效lease
- [ ] 过期lease新worker可接管且token增长
- [ ] 旧worker提交receipt/状态被拒；missing tenant scope失败
- [ ] receipt/verification状态更新的audit或outbox失败全部回滚，旧token不能写成功结果

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-lease.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 租约过期双worker写

**并行分组：** `p08-execution-lease.repository`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-010"></a>

## P08-010：恢复未知执行并避免再次dispatch

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ExecutionRecoveryPort

**输入：**

- 持久execution/receipt/dispatchIntent以及lease状态
- recovery只核实已有command，不能生成新idempotencyKey

**输出：**

- 重启/lease失效后恢复到readback job
- dispatchIntent已持久化但receipt丢失按UNKNOWN处理

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-recovery.ts`
- `apps/api/src/actions/execution-recovery.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001

**实际接线依赖：** P08-009, P08-008, P08-006

**验收：**

- [ ] 写后崩溃/receipt丢失重启只verify且write计数不增
- [ ] 过期lease使用新fencing token；旧worker结果不覆盖
- [ ] deadline后UNKNOWN停自动写，人工提示不称FAILED/SUCCEEDED

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-recovery.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 崩溃窗口receipt缺失被误认为未写

**并行分组：** `p08-execution-recovery`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-011"></a>

## P08-011：生成需重新审批的价格补偿候选

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** CompensationProposalBuilder

**输入：**

- 原action历史旧价+已验证当前源价/版本
- 关联executionId与当前evidence、same tenant/store

**输出：**

- 新revision独立候选ROLLBACK_PENDING引用
- 重新风险评估/人工审批及current-version检查；verify后才ROLLED_BACK

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/price-compensation.ts`
- `apps/api/src/actions/price-compensation.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001

**实际接线依赖：** P07-003, P07-007, P08-007

**验收：**

- [ ] 当前仍为原目标可生成恢复旧价候选且不执行
- [ ] 商家后续改价/无新鲜源版本拒绝补偿候选
- [ ] 旧approval/key不能复用于补偿；补偿仍CRITICAL禁止或人工审批

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/price-compensation.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 自动恢复覆盖后续合法更改

**并行分组：** `p08-price-compensation`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-012"></a>

## P08-012：展示执行进度、冲突和待核实

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P0

**契约：** ExecutionStatusViewModel

**输入：**

- receipt、verification、deadline、权限及审计引用model
- 不可直接依据HTTP200显示成功

**输出：**

- 响应式执行详情状态与补偿候选按钮port
- loading/empty/error、UNKNOWN人工说明、禁止自动写retry按钮

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/actions/execution-status.tsx`
- `apps/web/src/app/actions/execution-status.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001

**实际接线依赖：** P07-012

**验收：**

- [ ] ACCEPTED/PENDING显示EXECUTING，独立VERIFIED才成功
- [ ] deadline UNKNOWN显示平台状态待核实已停止自动写重试
- [ ] MISMATCH冲突、权限不足、375px/键盘可达；补偿打开新审批预览

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/actions/execution-status.test.tsx

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** UI把已接受回执写成已成功

**并行分组：** `p08-execution-status`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-013"></a>

## P08-013：接入单SKU执行API与worker宿主

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** ExecutionModuleWiring / ExecuteApprovedHttp

**输入：**

- 全部端口真实实现、当前auth adapter、Mock connector binding
- 首期单SKU价格policy；strict execution HTTP body只引用已审批id/hash/revision
- TenantScopeService.resolve与strict scope header/path+route DTO，不复用拒绝body/query的只读guard

**输出：**

- 拟新增POST /v1/actions/:id/execute authenticated入口及持久worker注册
- 启动/取消/恢复host wiring；AI registry仍无execute工具

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution.module.ts`
- `apps/api/src/actions/execution.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `packages/contracts/src/index.ts`

**硬依赖：** P08-003, P08-004, P08-005, P08-006, P08-007, P08-008, P08-009, P08-010, P07-014, P07-019, P09-004, P10-003, P2-GATE, P08-018

**实际接线依赖：** 无

**验收：**

- [ ] 匿名/未批准/跨tenant/revoked拒绝执行
- [ ] 正常approved价格触发一次command后等待独立readback
- [ ] 重复key返回原execution，worker停止/恢复无二次写；模块无循环依赖

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution.module.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 后台job伪装管理员权限

**并行分组：** `p08-execution.module`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。API registration/contracts export锁；API入口+worker wiring限定已有组件，不重新实现状态机。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-014"></a>

## P08-014：证明执行抢占、outbox和审计原子性

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ExecutionAtomicityProof

**输入：**

- isolated-postgres受限角色与两组织fixtures
- 并发claim/reserve、故障注入audit/outbox/commit

**输出：**

- 真实DB同key唯一、fencing及rollback证明
- 强制isolated runner注册且0 skipped

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/action-execution.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-002, P08-003, P08-009, P09-004, P10-003

**实际接线依赖：** 无

**验收：**

- [ ] 同key20个并发reserve仅一execution/job有效
- [ ] 旧lease持有人无法更新新token记录，跨tenant FK/RLS拒绝
- [ ] outbox/audit失败proposal不入EXECUTING；空库/升级migration均可跑

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 并发fixture未用受限真实DB

**并行分组：** `p08-action-execution`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-015"></a>

## P08-015：验证Mock调价写后丢包与延迟回读

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** SingleSkuMockExecutionProof

**输入：**

- P2获批handoff Mock source DTO/fault adapter+sync ports
- 本地真实HTTP身份/approve API；test-only合成SKU源价

**输出：**

- 59→62单SKU成功及UNKNOWN恢复HTTP/connector证明
- 经营DB仅通过同步收敛；完整action/approval/execution/audit链

**独占文件（新路径为计划创建）：**

- `apps/api/test/single-sku-execution.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-013, P08-014, P08-012, P2-GATE, P08-017, P08-018

**实际接线依赖：** 无

**验收：**

- [ ] 正常流程人工批准→一次write→独立VERIFIED成功；租户B不可见
- [ ] timeout-after-write/延迟visibility保持EXECUTING，restart不重复write
- [ ] disconnect/授权撤销/源版本漂移阻断；未回读不得改经营DB伪成功

**测试：**

- pnpm --filter @shopmate/api exec vitest run test/single-sku-execution.e2e-spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 测试从规范DB伪造平台回读

**并行分组：** `p08-single-sku-execution.e2e`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-016"></a>

## P08-016：新增Mock命令回执与延迟可见记录

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** MockCommandReceipt / MockPendingVisibility

**输入：**

- P2 source scoped generation/version contract与独立受限source角色
- stable executionId/key、immutable command hash、visibleAfter

**输出：**

- 演示专用回执/待可见模型独立migration
- scope+key唯一、source generation FK、受限source读写grant
- 可选typed externalResourceRef(kind=PRODUCT,id)字段供P12可信创建结果关联；不是猜测vendor端点或返回格式

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/command-model.ts`
- `packages/database/test/mock-actions/command-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080200_mock_action_receipts/migration.sql`

**硬依赖：** P08-001, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] tenant/connection/generation+key唯一且不同payload复用key冲突
- [ ] 跨scope/source generation关联与非法app直写权限拒绝
- [ ] 延迟可见和写已发生事实分离；schema不把receipt当经营事实

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/command-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实平台调用/部署/线上迁移
- 相对库存变更/采购到货模拟
- UNKNOWN自动再次写

**风险：** 回执与经营规范库混写

**并行分组：** `p08-mock-price-source-16`

**执行边界：** 拟新增文件独占；复用P2 handoff已获批source/control事务锁和受限身份，不读取scenario oracle；4小时内含验证/PR。独立commit/PR、最新CI+审查合并才Done。与P08-002持同Prisma协调锁；真实源事务证明归P08-015。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-017"></a>

## P08-017：实现Mock绝对价格CAS源事务

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** MockPriceCommandStore

**输入：**

- P2当前源entity/version与control锁；source受限transaction identity
- SetPriceCommand strict DTO；immutable key+hash及expectedVersion

**输出：**

- 同source/control事务检查代次与权限、更新绝对价/版本、写回执/可见记录
- 相同command重复返回原receipt，不产生第二source mutation

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/set-price.ts`
- `packages/database/test/integration/mock-price-write.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-016, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 5900→6200只变指定sourceSKU且版本推进一次
- [ ] 同key同hash重复无二次变更；不同hash或旧sourceVersion拒绝
- [ ] timeout-after-write fixture显示源已写；reset/disconnect竞争在锁后重查并拒绝，rollback无部分回执

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台调用/部署/线上迁移
- 相对库存变更/采购到货模拟
- UNKNOWN自动再次写

**风险：** 源价格写与reset/disconnect竞争

**并行分组：** `p08-mock-price-source-17`

**执行边界：** 拟新增文件独占；复用P2 handoff已获批source/control事务锁和受限身份，不读取scenario oracle；4小时内含验证/PR。独立commit/PR、最新CI+审查合并才Done。只单SKUsource transaction；故障信号来自已批准P2端口。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p08-018"></a>

## P08-018：接入Mock调价与独立回读适配器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** MockPriceActionAdapter / CommerceConnector.updatePrice+verifyAction

**输入：**

- MockPriceCommandStore与read-only source current/visibility DTO
- 当前connection/generation reader、trusted binding、deadline/AbortSignal

**输出：**

- Mock connector价格capability+updatePrice和verifyAction代理
- 独立source读验证，与规范DB读路径分离；其余write保持UNSUPPORTED

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/mock-price-actions.ts`
- `apps/api/src/integrations/mock/mock-price-actions.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/integrations/mock/mock-commerce-connector.ts`
- `apps/api/src/integrations/mock/mock-connector-factory.ts`

**硬依赖：** P08-017, P08-007, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 正常sourceprice readback带correct binding/execution/SKU/version
- [ ] 延迟visibility返回PENDING；丢包UNKNOWN不伪造目标snapshot
- [ ] auth撤销/generation变化/timeout/corrupt输出fail closed；无底层read成功不得VERIFIED

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/mock/mock-price-actions.spec.ts src/integrations/mock/mock-commerce-connector.spec.ts --maxWorkers 1

**不包含：**

- 真实平台调用/部署/线上迁移
- 相对库存变更/采购到货模拟
- UNKNOWN自动再次写

**风险：** 用command旧target伪造回读

**并行分组：** `p08-mock-price-source-18`

**执行边界：** 拟新增文件独占；复用P2 handoff已获批source/control事务锁和受限身份，不读取scenario oracle；4小时内含验证/PR。独立commit/PR、最新CI+审查合并才Done。持mock-connector wiring锁；只有此卡修改既有adapter/factory价格write wiring。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。
