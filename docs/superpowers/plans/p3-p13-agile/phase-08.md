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

- 同tenant/store approval revision FK；执行记录不复用通知独立动作job模型
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

**硬依赖：** P08-001, P07-006

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

## P08-003：原子保留执行并写独立动作job审计

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ExecutionRepository.reserveApproved / ActionJobEnqueuePort

**输入：**

- 已批准immutable revision/hash和当前authority recheck
- tenant transaction、稳定execution key、typed ACTION_DISPATCH与P08-021入队；不使用通知recipient key
- P08-055关联port：PRICE_SET补偿正常reserve同tx bind独立child，persistent parent/candidate/revision/hash/approval逐字段匹配后才预约

**输出：**

- CAS APPROVED→EXECUTING、execution insert、独立动作job job和audit同事务
- 重复请求读取原execution而不生成第二job

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution.repository.ts`
- `apps/api/src/actions/execution.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-002, P07-008, P09-004, P08-021, P08-022, P08-055

**实际接线依赖：** 无

**验收：**

- [ ] 两个相同key竞争只一条execution/job/audit有效转移
- [ ] 新revision/hash、过期approval或撤销权限拒绝
- [ ] 独立动作job或audit异常使APPROVED状态及执行记录全部回滚
- [ ] 补偿reserve绑定独立child/new key/new approval与persistent candidate同tx；错parent/hash或重复复用原execution拒绝，association/audit/job异常全rollback

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

**硬依赖：** P08-001, P07-001, P08-051

**实际接线依赖：** 无

**验收：**

- [ ] 59→62产出5900→6200且携带当前expectedVersion
- [ ] 跨SKU/币种/hash/revision/sourceVersion变化拒绝
- [ ] inventory +100/批量/未知动作不构建命令；同execution重建完全一致
- [ ] 合法typed compensation PRICE_SET经strict schema后构建普通absolute SetPriceCommand；metadata留在signed proposal/execution binding，不注入Connector未知字段，篡改parent binding拒绝

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
- connection/current authority reader；ActionJobEnqueuePort/ACTION_VERIFY与durable fenced audit-update tx

**输出：**

- 仅read-back retry的持久verify job
- deadline到达标UNKNOWN/需人工核实并停止自动写重试

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/verification-scheduler.ts`
- `apps/api/src/actions/verification-scheduler.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P08-007

**实际接线依赖：** P08-009, P09-004, P08-021, P08-022, P2-GATE

**验收：**

- [ ] 短暂PENDING按retryAfter受上限安排readback
- [ ] 超deadline停止调度、UI状态待核实、无write调用
- [ ] connection撤销/权限变化立即停止；独立动作job/audit异常回滚状态与next check

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
- P09-004 audit append、P08-021 ACTION_VERIFY enqueue与P08-022 claim/fence；同tenant transaction

**输出：**

- claim/renew/complete受token约束
- 过期worker不能完成新owner记录
- fenced receipt/verification outcome commit与audit+后继verify job原子写入，供P08-006/008调用

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-lease.repository.ts`
- `apps/api/src/actions/execution-lease.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-002, P09-004, P08-021, P08-022

**实际接线依赖：** 无

**验收：**

- [ ] 并行claim仅一个取得有效lease
- [ ] 过期lease新worker可接管且token增长
- [ ] 旧worker提交receipt/状态被拒；missing tenant scope失败
- [ ] receipt/verification状态更新的audit或独立动作job失败全部回滚，旧token不能写成功结果

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
- 只产PRICE_SET+PriceSetCompensationMetadataV1；所有parent/candidate/restore/version字段进入新payload/hash；关联port来自P08-051，持久实现来自P08-055

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/price-compensation.ts`
- `apps/api/src/actions/price-compensation.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001, P08-051

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
- P08-019..022独立动作任务实际实现；dispatchIntent一次派发/UNKNOWN只回读，通知独立动作job不用于执行
- P08-032完成的default-deny registry/shared authority facade，仅注册PRICE_SET；其他kind直到专属runtime gate仍UNSUPPORTED
- P08-049单独完成source publisher host注册/启动恢复；P08-046/047普通read/cursor/sync真实request扩展，本卡只执行API与action worker DI

**输出：**

- 拟新增POST /v1/actions/:id/execute authenticated入口及持久worker注册
- 启动/取消/恢复host wiring；AI registry仍无execute工具

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution.module.ts`
- `apps/api/src/actions/execution.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `packages/contracts/src/index.ts`

**硬依赖：** P08-003, P08-004, P08-005, P08-006, P08-007, P08-008, P08-009, P08-010, P07-014, P07-019, P09-004, P2-GATE, P08-018, P08-021, P08-022, P08-029, P08-032, P08-049, P08-046, P08-047

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

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。API registration/contracts export锁；API入口+worker wiring限定已有组件，不重新实现状态机。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p08-014"></a>

## P08-014：证明执行抢占、独立动作job和审计原子性

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ExecutionAtomicityProof

**输入：**

- isolated-postgres受限角色与两组织fixtures
- 并发claim/reserve、故障注入audit/独立动作job/commit

**输出：**

- 真实DB同key唯一、fencing及rollback证明
- 强制isolated runner注册且0 skipped
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/action-execution.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/action-execution.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-002, P08-003, P08-009, P09-004, P08-021, P08-022

**实际接线依赖：** 无

**验收：**

- [ ] 同key20个并发reserve仅一execution/job有效
- [ ] 旧lease持有人无法更新新token记录，跨tenant FK/RLS拒绝
- [ ] 独立动作job/audit失败proposal不入EXECUTING；空库/升级migration均可跑
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 并发fixture未用受限真实DB

**并行分组：** `p08-action-execution`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

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
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/single-sku-execution.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/test/single-sku-execution.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`

**硬依赖：** P08-013, P08-014, P08-012, P2-GATE, P08-017, P08-018, P08-025

**实际接线依赖：** 无

**验收：**

- [ ] 正常流程人工批准→一次write→独立VERIFIED成功；租户B不可见
- [ ] timeout-after-write/延迟visibility保持EXECUTING，restart不重复write
- [ ] disconnect/授权撤销/源版本漂移阻断；未回读不得改经营DB伪成功
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台调用/生产部署/线上迁移
- 库存相对增量及批量执行
- UNKNOWN后自动重新写入或自动补偿

**风险：** 测试从规范DB伪造平台回读

**并行分组：** `p08-single-sku-execution.e2e`

**执行边界：** 拟新增路径独占；估时含实现、定向验证和PR；测试fixture仅合成，组件注入端口，满足integrationDependsOn后才runtime wiring；每卡独立commit/PR、最新CI与审查并合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p08-016"></a>

## P08-016：新增Mock命令回执与延迟可见记录

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** MockCommandReceipt / MockPendingVisibility

**输入：**

- P2 source scoped generation/version contract与独立受限source角色
- stable executionId/key、immutable command hash、visibleAfter
- command receipt后续P08-034 additive extension加入requestRevision引用，Runtime/历史source immutable；本卡不假设P2可写

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

- P08-036公共SourceCommandRequestStore/P08-038独立request-pinned readback，P08-039同clock真实发布proof；P2-GATE只提供immutable read publication基础，不假设提供writers
- SetPriceCommand strict DTO；immutable key+hash及expectedVersion

**输出：**

- 单SKU映射调用P08-036：stable key/hash原receipt优先，当前published version CAS且durable resource pending占位原子检查，append request+receipt；P08-037经新certificate发布，禁止直接UPDATE immutable entity
- 相同command重复返回原receipt，不产生第二source mutation
- 在同PR经database-index共享锁从现有@shopmate/database root发布typed store/resolver公共导出；不新增未拥有的subpath
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/mock-price-write.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/set-price.ts`
- `packages/database/test/integration/mock-price-write.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `packages/database/src/index.ts`

**硬依赖：** P08-016, P2-GATE, P08-036, P08-038, P08-039, P08-056

**实际接线依赖：** 无

**验收：**

- [ ] 5900→6200只为指定sourceSKU append请求，requestRevision推进一次；source发布certificate追上后独立读见6200才验证成功
- [ ] 同key同hash重复无二次变更；不同hash或旧sourceVersion拒绝
- [ ] timeout-after-write fixture显示源已写；reset/disconnect竞争在锁后重查并拒绝，rollback无部分回执
- [ ] consumer只从@shopmate/database root import；数据库build和API typecheck验证公共类型，禁止私有src路径import
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败
- [ ] 不同key同SKU/旧expectedVersion在pending时RESOURCE_PENDING且无第二请求；first publication后使用fresh sourceVersion同clock可accepted，不能仅比较未变published version

**测试：**

- pnpm --filter @shopmate/database build
- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- 真实平台调用/部署/线上迁移
- 相对库存变更/采购到货模拟
- UNKNOWN自动再次写

**风险：** 源价格写与reset/disconnect竞争

**并行分组：** `p08-mock-price-source-17`

**执行边界：** 拟新增文件独占；复用P2 handoff已获批source/control事务锁和受限身份，不读取scenario oracle；4小时内含验证/PR。独立commit/PR、最新CI+审查合并才Done。只单SKUsource transaction；故障信号来自已批准P2端口。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。 源命令前置P08-033..039覆盖requestRevision/receipt-backed same-tick chronology/固定prefix/publication/readback；本卡仅单动作映射+request事务，不实现通用source publication扩展。

<a id="p08-018"></a>

## P08-018：接入Mock调价与独立回读适配器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** MockPriceActionAdapter / CommerceConnector.updatePrice+verifyAction

**输入：**

- MockPriceCommandStore与read-only source current/visibility DTO
- 当前connection/generation reader、trusted binding、deadline/AbortSignal
- store/resolver通过已合并@shopmate/database root公共导出；当前package只有root与mock-platform，不使用mock-actions私有路径
- P08-038 public CommandPublicationReadPort以certificate.requestRevision>=command receipt gate独立source read；publication前PENDING，currentMock其余writes显式UNSUPPORTED

**输出：**

- Mock connector价格capability+updatePrice和verifyAction代理
- 独立source读验证，与规范DB读路径分离；其余write保持UNSUPPORTED

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/mock-price-actions.ts`
- `apps/api/src/integrations/mock/mock-price-actions.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/integrations/mock/mock-commerce-connector.ts`
- `apps/api/src/integrations/mock/mock-connector-factory.ts`

**硬依赖：** P08-017, P08-007, P2-GATE, P08-038, P08-039, P08-046

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

**执行边界：** 拟新增文件独占；复用P2 handoff已获批source/control事务锁和受限身份，不读取scenario oracle；4小时内含验证/PR。独立commit/PR、最新CI+审查合并才Done。持mock-connector wiring锁；只有此卡修改既有adapter/factory价格write wiring。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p08-019"></a>

## P08-019：定义独立动作派发与回读任务契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ActionJobV1 / ActionJobEnqueuePort / ActionJobClaimPort / BoundTenantTransaction

**输入：**

- ExecutionV1 scope/executionId/action revision/hash；可信SecurityClock
- 通知IN_APP收件人键仅用于通知，动作任务单独安全域

**输出：**

- strict ACTION_DISPATCH{executionId,revision,hash}与ACTION_VERIFY{executionId,verificationAttempt} union；禁止任意JSON或recipient字段
- 派发key=scope/executionId/DISPATCH唯一；回读key=scope/executionId/VERIFY/attempt唯一；bounded attempt/deadline、leaseUntil、递增fence、dispatchIntent

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/actions/action-job.schema.ts`
- `packages/contracts/src/actions/action-job.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P08-001

**实际接线依赖：** 无

**验收：**

- [ ] 错误kind、recipient、未知payload字段或scope缺失拒绝
- [ ] dispatch attempt只能0且同execution唯一；verify attempt安全整数有上限与真实deadline
- [ ] claim/outcome必须带fence；UNKNOWN仅能enqueue VERIFY，不能产生新DISPATCH

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/actions/action-job.schema.spec.ts

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 通知dedup无法表示执行和回读

**并行分组：** `p08-019-action-job`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-020"></a>

## P08-020：建立动作任务租约与派发意图约束

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** ActionJobPersistenceV1

**输入：**

- P08-019 typed jobs与P08-002 execution tenant复合键
- 同租户RLS/FK；ACTION_DISPATCH与ACTION_VERIFY独立于NotificationOutbox

**输出：**

- 独立ActionJob模型/migration，kind-specific唯一键与typed列CHECK
- attempt/deadline/lease/fence/dispatchIntent持久化及受限角色约束

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/action-job-model.ts`
- `packages/database/test/actions/action-job-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080300_action_jobs/migration.sql`

**硬依赖：** P08-019, P08-002

**实际接线依赖：** 无

**验收：**

- [ ] 同execution只一个dispatch；同verify attempt去重，下一attempt可独立排入
- [ ] 跨tenant/execution FK、wrong-kind字段及负attempt被约束拒绝
- [ ] fence单调、派发意图不可清空；空库/升级DDL可静态验证

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/action-job-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 派发重复与通知模型污染

**并行分组：** `p08-020-action-job-model`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-021"></a>

## P08-021：实现同事务动作派发和回读入队

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ActionJobEnqueuePort / BoundTenantTransaction

**输入：**

- P08-019/020 typed job；调用者传已有tenant tx，不另开事务
- P09-004 audit writer；reservation/outcome由调用方在同tx更新

**输出：**

- 独立action-job enqueue repository；稳定dispatch/verify key重复返回原任务
- UNKNOWN或dispatchIntent已存在仅接受readback；bounded retry deadline检查

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/action-job-enqueue.repository.ts`
- `apps/api/src/actions/action-job-enqueue.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-020, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] reservation+dispatch job+audit任一失败整个tx回滚
- [ ] fenced outcome+下一verify job+audit同tx；同attempt只一任务
- [ ] wrong-kind/recipient/UNKNOWN重新dispatch、超attempt/deadline均拒绝且不改状态

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/action-job-enqueue.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 状态和动作任务分离提交

**并行分组：** `p08-021-action-job-enqueue`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-022"></a>

## P08-022：实现动作任务抢占和一次派发标记

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ActionJobClaimPort / FencedDispatchIntent

**输入：**

- ActionJobPersistenceV1、参数化tenant tx；SecurityClock lease与deadline
- P09-004 audit append；UNKNOWN丢包/重启只有验证任务允许继续

**输出：**

- 原子claim/renew/fenced complete；派发前先持久dispatchIntent再出tx调用connector
- lease失效后不重新dispatch，转readback-only；verify有限attempt/backoff

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/action-job-claim.repository.ts`
- `apps/api/src/actions/action-job-claim.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-020, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 并行claim仅一个owner且fence递增，旧token写结果拒绝
- [ ] 标记dispatchIntent后崩溃/lease转移不会再次dispatch；UNKNOWN仅回读
- [ ] deadline/attempt上限停止自动工作；intent或audit写失败整体rollback，不调用vendor

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/action-job-claim.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 崩溃窗口造成重复平台写

**并行分组：** `p08-022-action-job-claim`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-023"></a>

## P08-023：证明独立动作任务去重与租约隔离

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ActionJobIsolationProof

**输入：**

- P08-020/021/022真实PostgreSQL受限身份与两组织fixture
- isolatedPostgres disposable lifecycle；仅runner生成测试连接串

**输出：**

- typed kind CHECK/RLS/FK、派发唯一、verify attempt、lease/fence与rollback的真实DB证明
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/action-jobs.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/action-jobs.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-021, P08-022

**实际接线依赖：** 无

**验收：**

- [ ] 20并发dispatch enqueue/claim仅一owner；相同verify attempt仅一job而下一attempt可用
- [ ] wrong-kind/跨tenant/旧fence拒绝；tenant notification recipient key未被动作任务使用
- [ ] reservation/outcome/job/audit失败rollback；dispatchIntent丢receipt重启只读，0 skipped
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 静态DDL测试未证明真实并发

**并行分组：** `p08-023-action-jobs`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p08-024"></a>

## P08-024：实现可信执行状态读取端点

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ExecutionStatusReadPort / GET /v1/executions/:executionId

**输入：**

- P08-001 receipt/verification/deadline及可信tenant scope；注入execution read port
- server current identity/actions:read；scope header/path strict，不直接挂只读body/query guard

**输出：**

- strict状态read DTO与认证GET controller；original/compensation execution关联id和可见audit refs
- UNKNOWN/PENDING/MISMATCH保持真实状态，无缓存命令target当readback

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-status.controller.ts`
- `apps/api/src/actions/execution-status.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001

**实际接线依赖：** P08-003, P08-009, P07-019, P08-041

**验收：**

- [ ] 匿名401、cross tenant不泄露、缺read权限拒绝，未知id返回404
- [ ] ACCEPTED/PENDING绝不SUCCEEDED；deadline UNKNOWN附停止自动写说明
- [ ] VERIFIED带source readback/version；错误schema/超时映射明确错误而非empty

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-status.controller.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** UI无法读取真实UNKNOWN状态

**并行分组：** `p08-024-execution-status`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-025"></a>

## P08-025：绑定执行状态客户端和详情页面

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** ExecutionStatusClient / ExecutionDetailRoute

**输入：**

- P08-024 GET controller + P08-041真实状态repository注册与P08-012状态组件；现有认证fetch/tenant切店模式
- P08-013 execution repo/worker、P07-014审批路由；cancel bounded polling

**输出：**

- status client+详情route/page绑定；加载/空/错误、UNKNOWN/冲突、readback成功真实呈现
- 注册GET到execution module；不在本卡实现补偿API或策略

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/actions/execution-status-api.ts`
- `apps/web/src/app/actions/execution-status-api.test.ts`
- `apps/web/src/app/actions/executions/[executionId]/page.tsx`
- `apps/web/src/app/actions/execution-detail.test.tsx`

**共享文件锁（协调集成修改）：**

- `apps/api/src/actions/execution.module.ts`
- `apps/web/src/app/page.tsx`

**硬依赖：** P08-024, P08-012, P08-013, P07-014, P07-019, P08-041

**实际接线依赖：** 无

**验收：**

- [ ] 页面真实GET显示UNKNOWN、MISMATCH及VERIFIED；HTTP200/ACCEPTED不算成功
- [ ] 切店/abort丢弃迟到结果；401/403/404/500不显示空成功
- [ ] 375px/桌面loading/empty/error及键盘可用；两次轮询有上限且不能触发write

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/actions/execution-status-api.test.ts src/app/actions/execution-detail.test.tsx
- pnpm --filter @shopmate/api typecheck
- pnpm --filter @shopmate/web typecheck

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 状态endpoint和props组件没有真实绑定

**并行分组：** `p08-025-execution-status-api`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p08-026"></a>

## P08-026：实现补偿候选认证接口

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** POST /v1/executions/:id/compensation-candidate / CompensationProposalBuilder

**输入：**

- P08-011 builder、strict原executionId与expected sourceVersion；注入source read/proposal writer
- 当前server human/actions:propose+products:write、fresh source readback/evidence

**输出：**

- 只建立PRICE_SET proposal+P08-051 strict compensation metadata（完整parent/candidate/恢复值/verified source version）；新revision/hash、approval TTL、execution key由正常链生成
- 候选创建/audit同tx，原execution只记录ROLLBACK_PENDING关联，不批准不执行
- 同controller拥有拟新增POST /v1/executions/:id/compensation-candidate/:candidateId/cancel认证入口，仅委托typed cancelCandidate port；child已经accepted则409，reject沿正常审批服务

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/compensation.controller.ts`
- `apps/api/src/actions/compensation.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-011, P07-001, P08-051

**实际接线依赖：** P07-007, P07-002, P07-003, P09-004, P08-018, P07-019, P08-041, P08-055

**验收：**

- [ ] 当前价格仍为原target且fresh version可生成恢复旧值候选；不调用write
- [ ] UNKNOWN未核实/商家后改价/跨tenant/旧version拒绝；重复request返回相同候选
- [ ] 旧approval/hash/key不能复用，新候选HIGH/CRITICAL重评；必须新的显式human审批，不要求新增双人审批策略

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/compensation.controller.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 补偿误复用已批准的历史命令

**并行分组：** `p08-026-compensation`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-027"></a>

## P08-027：注册补偿候选与新审批执行链

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** CompensationRuntimeBindings / NewApprovalBinding

**输入：**

- P08-026候选controller、P08-011 builder；P08-018真实source read/current version
- P07-014真实proposal/hash/risk/approval与P08-013 execution；P08-029关联outcome
- P08-051 PRICE_SET metadata strict/export与P08-054/055 actual association，P07-008批准拒绝/P08-003 reserve已拥有关联hook，candidate cancel hook只绑定完成仓库

**输出：**

- compensation API DI registration与price proposal branch绑定；新的approval/key必经正常执行路径
- 已验证原execution关联pending compensation；当前有效human重新明确审批后才可执行
- register CompensationAssociationPort/read/outcome并绑定正常PRICE_SET branch与取消候选认证入口；只调用已完成cancelCandidate，reject沿正常审批路径，禁止新kind/fallback

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/compensation.module.ts`
- `apps/api/src/actions/compensation.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/actions/execution.module.ts`
- `apps/api/src/actions/actions.module.ts`

**硬依赖：** P08-026, P08-011, P08-018, P07-014, P07-019, P08-013, P08-029, P09-004, P08-041, P08-051, P08-054, P08-055

**实际接线依赖：** 无

**验收：**

- [ ] 真实read→新proposal→新hash/revision链可调用，原approval/key拒绝
- [ ] 原approval不能替代新补偿human审批；当前身份/权限/近期证明缺失或过期拒绝，既有actor separation规则保持
- [ ] 仅新compensation readback VERIFIED才把原execution标ROLLED_BACK；UNKNOWN留pending
- [ ] 取消尚未执行candidate或normal reject持久终止关联，parent保持真实验证状态；已accepted child UNKNOWN不能cancel，一律无成功回滚声明

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/compensation.module.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 候选与正常审批executor脱节

**并行分组：** `p08-027-compensation`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p08-028"></a>

## P08-028：连接补偿预览与重新审批界面

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** integration · **优先级：** P0

**契约：** CompensationClient / ApprovalPreviewRouteBinding

**输入：**

- P08-027真实候选API、P08-025状态page/client与P07-014审批route
- P08-012 compensation callback；新的proposal id/revision/hash/expiry和parentExecutionId

**输出：**

- 补偿client及按钮/预览binding，展示恢复值和最新源版本；需重新明确人工批准
- 取消/拒绝不执行；新approval→新execution状态链接并刷新原execution read状态

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/actions/compensation-api.ts`
- `apps/web/src/app/actions/compensation-api.test.ts`
- `apps/web/src/app/actions/compensation-binding.tsx`
- `apps/web/src/app/actions/compensation-binding.test.tsx`

**共享文件锁（协调集成修改）：**

- `apps/web/src/app/actions/executions/[executionId]/page.tsx`

**硬依赖：** P08-027, P08-025, P07-014, P07-012

**实际接线依赖：** 无

**验收：**

- [ ] UNKNOWN/无权限不能发补偿；conflict409显示重新取证而非重试write
- [ ] 补偿二次确认显示新hash/key/审批人要求；没有自动批准或直接execute
- [ ] 375px/键盘loading/empty/error，新的human批准后导航新execution，VERIFIED才呈现ROLLED_BACK
- [ ] 取消调用认证candidate cancel端口，拒绝走normal reject；重新读取CANCELLED/REJECTED relation，原execution不显示ROLLED_BACK，unknown child不能取消

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/actions/compensation-api.test.ts src/app/actions/compensation-binding.test.tsx

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 用户误认为回滚不需要新授权

**并行分组：** `p08-028-compensation-api`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p08-029"></a>

## P08-029：实现验证后补偿结果关联

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** CompensationOutcomePort / ParentExecutionTransition

**输入：**

- typed compensation parentExecutionId、distinct revision/hash/key、fresh approval
- 真实子execution验证outcome、同scope fenced tenant tx和audit append端口
- P08-051 public CompensationAssociationPort；P08-055实际parameterized repository实现，P08-054持久relation/status约束

**输出：**

- 仅子补偿VERIFIED后原execution ROLLBACK_PENDING→ROLLED_BACK；同tx持久关联与audit
- UNKNOWN/PENDING保持pending；MISMATCH显示补偿冲突，不伪造原成功
- bindParentCompensationCandidate同tx关联独立候选并置ROLLBACK_PENDING；后续新approval/key子execution经真实VERIFIED才完成，audit异常rollback
- bind candidate通过P08-055保存原parent Action status并置ROLLBACK_PENDING；cancel/reject由同repo原子恢复已验证prior状态，child已accepted则不可取消；只child真实VERIFIED后parent Action ROLLED_BACK

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/compensation-outcome.ts`
- `apps/api/src/actions/compensation-outcome.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P07-001, P08-051

**实际接线依赖：** P08-009, P09-004, P08-055

**验收：**

- [ ] 真实VERIFIED与父子scope/hash绑定才ROLLED_BACK，同outcome重复幂等
- [ ] ACCEPTED/UNKNOWN/PENDING不完成回滚；错parent/旧fence拒绝
- [ ] 原状态与子结果及audit任一异常全部rollback；不能复用原approval或key
- [ ] cancel/reject尚未执行candidate仅终止association并释放active pending，保留parent原VERIFIED状态，不能ROLLED_BACK；CHILD_PENDING/UNKNOWN不得通过cancel抹除未知结果

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/compensation-outcome.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 回滚成功来自receipt而非readback

**并行分组：** `p08-029-compensation-outcome`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-030"></a>

## P08-030：证明真实状态展示和另行审批补偿

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** J2 StatusAndCompensationProof

**输入：**

- P08-025/027/028真实HTTP+web binding；认证human、本地Mock/isolated DB，tenant B负例
- 原59→62、UNKNOWN恢复、商家改价冲突及新的补偿revision/hash/key
- P08-042同一disposable DB/API/Web存活生命周期；只用受控合成种子/P2故障规则，不拦截runtime API response伪造结果

**输出：**

- 聚焦status read/UI与补偿审批/readback集成证明，复用已有execution故障fixture
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/execution-compensation.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/test/execution-compensation.e2e-spec.ts`
- `tests/e2e/execution-compensation.spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`

**硬依赖：** P08-028, P08-015, P08-023, P07-019, P08-042

**实际接线依赖：** 无

**验收：**

- [ ] UNKNOWN/PENDING状态API与375px UI一致且无retry write；readback后才成功
- [ ] 新hash/key/approval且human重新明确批准后恢复59，独立readback VERIFIED才ROLLED_BACK
- [ ] 商家改价/原approval重放/无近期human proof/跨tenant拒绝，补偿outcome/audit故障rollback，0 skipped
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败
- [ ] 指定browser target选择/执行>0、0 skipped；零选择/零执行/skip失败，本次runner finally停止所有拥有server；禁止默认playwright.config.ts/.env/开发DATABASE_URL或复用server
- [ ] 实际DB从candidate create读回完整parent/candidate/revision/hash，再normal approve→strict PRICE_SET registry→new child reserve读回FK关联；错parent/旧approval/key拒绝且无孤儿关系
- [ ] 分别cancel/reject尚未执行候选后持久CANCELLED/REJECTED并无child mutation，parent保留原已验证状态；UNKNOWN child禁止cancel；真实child VERIFIED才VERIFIED_ROLLBACK/ROLLED_BACK
- [ ] candidate cancel/reject后读回parent已恢复prior SUCCEEDED、association CANCELLED/REJECTED、source仍6200且child为空；原VERIFIED事实不变，无假ROLLBACK_PENDING/ROLLED_BACK

**测试：**

- pnpm test:browser:isolated -- tests/e2e/execution-compensation.spec.ts
- pnpm test:tenant

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿
- 不把test-only route fixture结果当作实际auth/source/approval/execution runtime证明

**风险：** J2遗漏可见状态或补偿运行链

**并行分组：** `p08-030-execution-compensation`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p08-031"></a>

## P08-031：定义动作策略扩展与共享授权边界

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ActionStrategyV1 / SharedExecutionAuthorityPolicy / DenyByDefaultStrategyRegistry

**输入：**

- P07-001/P08-001现有price批准/执行契约；CommerceConnector DTO
- 共享current session/role/reauth/TTL/store/feature/connection generation/hash检查

**输出：**

- typed按kind的preflight/build/dispatch/verify策略端口与registry注册规则
- 共享授权策略不可被kind插件绕过；PRICE_SET与PRODUCT_PUBLISH payload各自strict，未知kind默认拒绝

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/actions/action-strategy.schema.ts`
- `packages/contracts/src/actions/action-strategy.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P07-001, P08-001, P08-051

**实际接线依赖：** 无

**验收：**

- [ ] 未知kind或错payload schema拒绝；registry重复kind拒绝
- [ ] 任何策略都必须先得到当前共享authority proof，AI/失效approval不能造proof
- [ ] price保留absolute SetPriceCommand；publish CreateProductCommand不能调用updatePrice分支
- [ ] 精确PRICE_SET compensation metadata走同strict union和共享authority；不注册新PRICE_COMPENSATION kind，不允许额外字段fallback

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/actions/action-strategy.schema.spec.ts

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 价调executor被误当通用发布器

**并行分组：** `p08-031-action-strategy`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-032"></a>

## P08-032：封装价格策略与默认拒绝注册器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** PriceExecutionStrategy / SharedExecutionAuthorityPolicy / ActionStrategyRegistry

**输入：**

- P08-031端口、P08-004当前authority与P08-005/006/007价格叶子端口
- 策略名称allowlist，构造共享proof后kind-specific检查；不假设已有registry

**输出：**

- 拟新增策略registry、共享authority facade与价格adapter，保留现有price叶子逻辑
- 公开typed注册接口，缺kind/重复kind拒绝；runtime登记留给P08-013

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/action-strategy-registry.ts`
- `apps/api/src/actions/action-strategy-registry.spec.ts`
- `apps/api/src/actions/price-execution-strategy.ts`
- `apps/api/src/actions/price-execution-strategy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-031, P08-004, P08-005, P08-006, P08-007, P08-051

**实际接线依赖：** P08-003, P08-009, P08-018, P07-019

**验收：**

- [ ] 59→62依旧只构建一次absolute价命令；receipt/UNKNOWN/readback行为不变
- [ ] proof缺失/revoked/TTL/generation漂移先拒绝，kind adapter无机会dispatch
- [ ] registry只默认price，未注册publish/unknown拒绝；接口可接typed fixture publish策略但不runtime注册
- [ ] 带P08-051完整compensation metadata的PRICE_SET仍经正常schema/registry/shared authority与独立approval/key，错parent/hash或旧approval拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/action-strategy-registry.spec.ts src/actions/price-execution-strategy.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 扩展发布策略意外改变价格安全性

**并行分组：** `p08-032-action-strategy-registry`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p08-033"></a>

## P08-033：定义同业务时刻源命令发布协议

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** SourceCommandRequestV1 / RequestPinnedPublication / CommandReceiptRequestRevision / DurablePendingRequestReader / RequestPinnedPublicReadPort

**输入：**

- P2-GATE公共publication/CONTROL，P2 publication-plan lines170–180明确clock-only BUILD不支持command writes
- P08-016 durable command receipt与strict PRICE_SET/PRODUCT_PUBLISH批准payload

**输出：**

- requestRevision独立于clockRevision，CONTROL下accepted mutation/clock request递增并同tx durable receipt；新的SourceCommandRequest typed记录
- jobs冻结targetRequestRevision与business clock；chronology=(occurredAt,requestRevision,phaseRank,entityKey,ordinal)，receipt-backed同tick例外；certificate/read要求requestRevision>=receipt且pinned旧证书不变
- typed read-only pending head/open-job enumeration与CLOCK请求codec/allocator签名供宿主；普通public read/scan/cursor与sync pin按full scope+generation+publication/request/certificate绑定，v1只读兼容
- 明确pending mutation admission政策：full scope/generation/resource tuple尚有accepted未published请求时拒绝第二distinct key/hash为RESOURCE_PENDING；相同key/hash返回原receipt，发布后fresh version允许下一请求

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-command-types.ts`
- `packages/database/test/mock-actions/source-command-types.test.mjs`
- `docs/architecture/p08-source-command-publication.md`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P2-GATE, P08-016

**实际接线依赖：** 无

**验收：**

- [ ] 两次同clock accepted price命令requestRevision严格递增，无1ms advance/Runtime rewrite
- [ ] v1原>base frontier规则只对有效receipt-backed更高request same-tick例外；任意更早time拒绝
- [ ] 合同区分ACCEPTED/待发布和VERIFIED；public source reader必须等receipt要求的certificate，不承诺同步规范DB已更新
- [ ] 两distinct keys同expectedVersion在第一publication前竞争只可接受一个；allocator串行本身不是CAS证明；资源占位持久化及publish/reset原子清除/隔离归P08-052/053

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-command-types.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-033-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-034"></a>

## P08-034：新增请求修订分配与冻结发布前缀约束

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** SourceRequestRevisionPersistence / RequestPrefixBuildJob

**输入：**

- P08-033 protocol与P2 immutability/one-open-job/fence/control schema
- 独立mutable request-head+immutable typed requests；不新增contracts包运行依赖

**输出：**

- additive requestRevision allocator/head+SourceCommandRequest schema、receipt绑定、targetRequestRevision certificate列
- 唯一/idleness由requestRevision代替clock-only targetClockRevision；clockRevision仍metadata，open job冻结前缀，旧certificate版本兼容明确
- CLOCK typed request与COMMAND共用allocator/head；pending index支持有限scope batch读取，不能只靠进程内wake；actual clock hook归P08-043

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-request-model.ts`
- `packages/database/test/mock-actions/source-request-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080400_source_request_revisions/migration.sql`

**硬依赖：** P08-033

**实际接线依赖：** 无

**验收：**

- [ ] 同CONTROL request allocator唯一递增，与accepted receipt同tx；rollback不留下有效请求/receipt
- [ ] 同clock可有更高request job，仍一个open job/no abandonment；target clock/request一旦冻结不可变
- [ ] schema/RLS/column grants拒绝跨scope/generation、Runtime UPDATE与旧certificate改写；旧published rows保持原版本而新版本带request pin

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-request-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-034-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-035"></a>

## P08-035：扩展带命令回执的同刻事件顺序守卫

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** ReceiptBackedSameTickChronologyGuard

**输入：**

- P08-034 request-pinned jobs；P2 INVOKER statement/row/deferred freshness与event/version codec
- receipt full scope/hash/requestRevision，DB-derived ordinal/seq/version不由caller分配

**输出：**

- 独立migration扩展event/checkpoint/certificate version和chronology guards，只允许更高request且receipt-backed same-tick
- 保持一event一version、dense range、physical publication/deferred exact count与旧版本读兼容

**独占文件（新路径为计划创建）：**

- `packages/database/test/mock-actions/source-command-guard-contract.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/migrations/20261005080500_source_command_chronology/migration.sql`

**硬依赖：** P08-034

**实际接线依赖：** 无

**验收：**

- [ ] 前证书target相同time，合法更高request可append/publish新版本；旧pin仍排除新事件
- [ ] 无receipt/错hash/request/generation或任意更早time拒绝，旧SourceEvent/EntityVersion/PUBLISHED更新仍拒绝
- [ ] fresh separate-command CONTROL/auth/fence检查及deferred event/version/job count约束保留；bounded100 events/2MiB不能被多statement绕过

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-command-guard-contract.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-035-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-036"></a>

## P08-036：实现受限源命令请求与回执事务端口

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** SourceCommandRequestStore / CommandReceiptRequestRevision

**输入：**

- P08-033 typed PRICE_SET/PRODUCT_PUBLISH已验证after数据；P08-034请求表/receipt，P08-035 guards
- P2 source actual-login事务+CONTROL/fresh access；不传pool/sql/principal override

**输出：**

- 参数化acceptCommandRequest先stable key/hash receipt查重，再同CONTROL/tenant tx调用P08-053 durable resource占位+published expectedVersion CAS；request/receipt/head/reservation原子提交，RESOURCE_PENDING不分配新请求
- 公共root导出typed request store，price/listing业务store调用此口，暂未publish返回ACCEPTED
- public DurablePendingRequestReader有限scope枚举request head/open job供P08-044 startup/poll，只读不触发publisher；已accepted请求持久可在重启后拾取

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-command-requests.ts`
- `packages/database/test/mock-actions/source-command-requests.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P08-035, P08-053

**实际接线依赖：** 无

**验收：**

- [ ] 同key/hash重试返回原request/receipt，无第二requestRevision；changed hash/旧version拒绝
- [ ] receipt+request+head任一失败全部rollback；reset/disconnect锁后fresh check拒绝
- [ ] 仅批准typed command且不写immutable entity行；source限制actual-login保持，公共root import/build可验证
- [ ] 两distinct keys同resource/同expectedVersion在publication前至多一accept，其余RESOURCE_PENDING；same key/hash在pending期间仍返回原receipt；restart不能丢占位

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-command-requests.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-036-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-037"></a>

## P08-037：实现冻结命令前缀的增量源发布适配器

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** SourceCommandPublicationAdapter / RequestPinnedCertificate

**输入：**

- P08-036 durable command request/receipt和P2 reviewed public claim/append/publish operations
- P08-035新codec/time guards；只有限typed price/product命令prefix，不做一般generator
- P08-040已完成公开request-aware worker方法；原v1 claim/append/publish不能假定接受requestRevision，修改归属明确由P08-040负责
- P08-053公开publish同tx资源clearance：fence/scope/frozen prefix约束，失败/restart不能提前释放；publisher不再次accept业务命令

**输出：**

- 冻结request prefix转bounded immutable snapshot events与one-to-one versions，经已有fenced publication协议增量发布
- 命令certificate关联receipt要求requestRevision，后续request排下一个job；源变化仅在新published projection可见

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-command-publication.ts`
- `packages/database/test/mock-actions/source-command-publication.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P08-036, P08-040

**实际接线依赖：** 无

**验收：**

- [ ] 相同clock先62完成publication/占位clearance，再以fresh sourceVersion accepted63形成更高request/publication；pending第二distinct旧version请求必须拒绝，无Runtime/旧certificate rewrite
- [ ] open job中后来accepted请求不混进冻结prefix；finish后新job，无放弃revision/同步全量history
- [ ] 崩溃/丢ack沿用最新receipt/fence恢复，不重新accept command；未sealed/published不声称visible source success

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-command-publication.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-037-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-038"></a>

## P08-038：实现命令请求修订驱动的独立源回读

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** CommandPublicationReadPort / RequestRevisionReadbackGate

**输入：**

- P08-037真实published certificate与P08-036 trusted receipt requestRevision
- P2公共read-only source读取，full scope/execution/key/generation；不读取规范DB/目标命令当真值

**输出：**

- 公共root导出独立reader：certificate.requestRevision>=receipt.requestRevision且own certificate/source actual read通过才返回可验证snapshot
- certificate未达、source未可见PENDING/UNKNOWN；本卡只action独立回读，普通read/cursor由P08-045/046、sync持久pin/adapter由P08-048/047拥有

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-command-readback.ts`
- `packages/database/test/mock-actions/source-command-readback.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P08-037

**实际接线依赖：** 无

**验收：**

- [ ] 同clock新命令certificate落后时PENDING，追上且独立读到实际完整source snapshot才可VERIFIED
- [ ] 先前pinned certificate数据/hash不变，不混入后来的same-tick请求；错scope/request/execution/generation拒绝
- [ ] 延迟publication/read失败不猜值，no source success不更新规范DB；只返回真实certificate/source ref，normal sync依P08-045..048消费request pin收敛

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-command-readback.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-038-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-039"></a>

## P08-039：证明同刻命令发布与固定证书隔离

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** SameClockSourceCommandPublicationProof

**输入：**

- P08-034..038真实受限source/control login，两tenant/disposable isolatedPostgres
- typed price/product command request fixtures，不依赖P08-017/P12-011业务store避免互相锁死

**输出：**

- 真实DB同clock sequential fresh-version mutations、frozen prefix、immutable old certificate与独立readback；pending two-key admission/reset/restart竞争由P08-056独立证明
- 必跑runner注册，source角色无额外Runtime/control更新权限；reset/disconnect/revoke锁后检查
- 本卡持runner共享锁显式注册必跑目标：packages/database/test/integration/source-command-publication.test.mjs；nested目标显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/source-command-publication.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-038

**实际接线依赖：** 无

**验收：**

- [ ] business clock不变：key A expected v1→62先accepted并published/clearance后，key B fresh v2→63方可accepted；revision递增，旧pin/hash/content不变
- [ ] open prefix外新请求留后继job；receipt-backed same-tick允许，旧时刻/未绑定receipt/跨tenant/旧fence拒绝
- [ ] 0 skipped；命令/receipt/request/发布失败不部分commit；source reader不能写、source worker不能改Runtime/旧source rows，规范DB仅sync后可见
- [ ] pnpm test:tenant仅isolatedPostgres新建/stop disposable数据库，清除继承开发DATABASE_URL，仅runner注入TEST_DATABASE_URL/runtime DATABASE_URL；注册集非空，每目标执行>0且0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** published inclusive frontier关闭同tick写入

**并行分组：** `p08-039-source-request`

**执行边界：** 拟新增文件；复用P2合并后的公共SourceScope/CONTROL/publication端口，不虚构P2未来导出名；1–4h含聚焦验证/PR，单卡独立commit/分支/PR、review/latest CI/main合并后Done。strict输入/SQL参数化/函数与SQL体<40行/无any/密钥env。Runtime/SourceEvent/EntityVersion/PUBLISHED旧certificate保持immutable；不直接UPDATE历史源实体、不绕过restricted actual-login权限。

<a id="p08-040"></a>

## P08-040：扩展公共源worker请求修订端口

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** RequestAwareSourceWorkerPort / RequestPinnedPublication

**输入：**

- P08-033 requestRevision/receipt-backed chronology契约与P08-034/035 schema/guard实现
- P2 reviewed public claim/append/publish/findPublication与原lease/fresh CONTROL协议

**输出：**

- 当前mock-platform公共worker typed端口扩展request-aware claim/append/publish：冻结前缀与同clock更高request可启动next job
- 新certificate输出targetRequestRevision；旧codec/version只读兼容，runtime/历史证书不变

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-worker-request-adapter.ts`
- `packages/database/test/mock-actions/source-worker-request-adapter.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/mock-platform/jobs.ts`
- `packages/database/src/mock-platform/journal.ts`
- `packages/database/src/mock-platform/publication.ts`
- `packages/database/src/mock-platform/types.ts`
- `packages/database/src/mock-platform/index.ts`

**硬依赖：** P08-035, P08-033

**实际接线依赖：** 无

**验收：**

- [ ] same clock更高request可claim新job，open job仍BUSY并冻结旧prefix；clockRevision保持metadata
- [ ] append带当前request pin/receipt并维持exact latest-ack retry，错pin/旧fence/旧base拒绝
- [ ] public @shopmate/database/mock-platform import/build验证request-aware typed方法；旧readonly certificate/ref行为兼容，无private import或pool/sql泄露

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-worker-request-adapter.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 业务price/listing命令映射与一般generator
- 直接改immutable Runtime/source/history、假造clock推进
- 真实网络/部署/线上迁移

**风险：** SQL请求协议和公开worker方法不同步

**并行分组：** `p08-source-worker-request-40`

**执行边界：** 拟新增路径；只做已有worker公共边界request-aware扩展与精确port验证，不实现schema/guard或业务publisher。共享mock-platform-worker锁在同PR短时串行合并；4h包含聚焦验证/PR；函数/回调<40行、TS无any、输入strict/SQL参数化/env密钥，独立commit/PR review/latest CI/main后Done。

<a id="p08-041"></a>

## P08-041：实现租户内执行状态和关联只读仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** ExecutionStatusReadPort / ExecutionParentChildReadPort

**输入：**

- P08-001 strict status DTO、P08-002持久execution/receipt/verification/deadline模型
- trusted完整tenant tx与server actions:read context；参数化executionId查询，audit refs只给可见片段
- P08-054 durable relation与P08-055 scoped CompensationReadPort；原execution verification和association terminal状态分别读取

**输出：**

- parameterized status read repository：实际receipt/readback state/deadline/fence/publication refs，不从command target合成结果
- 原execution/补偿parent-child关联read；无记录null，未有source proof不映射SUCCEEDED/ROLLED_BACK

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/execution-status.repository.ts`
- `apps/api/src/actions/execution-status.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-001, P08-002, P09-001, P08-054, P08-055

**实际接线依赖：** 无

**验收：**

- [ ] same-scope execution返回当前持久UNKNOWN/PENDING/MISMATCH/VERIFIED及真实source ref，ACCEPTED不success
- [ ] 跨tenant/store或恶意id只作参数且拒绝读取；受限tenant事务未scope默认拒绝
- [ ] parent/child关联只读取同scope；timeout/error不转换empty，缺readback未生成source target snapshot
- [ ] cancel/reject后关联终止且parent Action恢复保存的真实原状态，original receipt/verification未变；展示明确“补偿已取消/拒绝，未恢复旧价”，不能留虚假ROLLBACK_PENDING

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/execution-status.repository.spec.ts --maxWorkers 1

**不包含：**

- 派发/状态mutation/补偿审批、vendor/network/live migration
- 从规范DB或命令payload伪造平台readback

**风险：** status endpoint只有fixture read port没有真实查询实现

**并行分组：** `p08-status-read-repository-41`

**执行边界：** 拟新增路径，3h含参数化read adapter、定向验证/PR；函数/回调<40行、TS无any、strict输入/完整scope/env密钥；独立commit/PR review/latest CI/main后Done。真实RLS/API读取由P08-030隔离证明，本卡不重做execute reserve/lease仓库。

<a id="p08-042"></a>

## P08-042：建立一次性数据库与API浏览器生命周期

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** component · **优先级：** P0

**契约：** IsolatedBrowserHarness / test:browser:isolated

**输入：**

- 现有isolated-postgres.mjs/tenant-api-fixture.mjs提供disposable DB与受限runtime URL；不复用pnpm test:tenant结束后的生命周期
- 现有Playwright/Next/Nest启动方式；三个精确目标safe-agent-answer.spec.ts、execution-compensation.spec.ts、daily-brief-notifications.spec.ts

**输出：**

- 拟新增playwright.isolated.config.ts与pnpm test:browser:isolated脚本；harness自己新建/准备DB，再注入唯一受限runtime DATABASE_URL至API，Web只拿本次API_BASE_URL，operator URL仅留准备进程
- 拥有API+Web+DB同一生命周期；清除继承DATABASE_URL/TEST_DATABASE_URL、vendor keys和服务URL，不加载任何.env；本次随机空闲端口/不复用已启动server，测试认证凭据与session secret仅本次合成env注入
- JSON reporter逐指定目标检查选择>0/执行>0/0 skipped，未知目标或目标缺失失败；所有异常/信号在finally停止API/Web子进程树及server.stop()

**独占文件（新路径为计划创建）：**

- `scripts/test-browser-isolated.mjs`
- `playwright.isolated.config.ts`
- `tests/browser-isolated-harness.test.mjs`

**共享文件锁（协调集成修改）：**

- `package.json`

**硬依赖：** P08-001

**实际接线依赖：** 无

**验收：**

- [ ] 污染继承开发DATABASE_URL、现有3000/3001服务或packages/database/.env均不能被读取/复用；API仅收到runner生成受限runtime URL
- [ ] DB准备失败、API/Web启动失败、Playwright失败、零选择/零执行/skip均非零退出并finally stop全部本次server/DB
- [ ] pnpm test:browser:isolated -- tests/e2e/execution-compensation.spec.ts在同一存活disposable DB+真实API/Web中执行；合成数据只经受控DB种子/现有P2故障规则，runtime API响应不可route替换
- [ ] 运行目标allowlist精确覆盖三张runtime浏览器卡；test-only process doubles证明cleanup/report守卫，不冒充真实浏览器证明

**测试：**

- node --test tests/browser-isolated-harness.test.mjs
- pnpm typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 浏览器进程脱离tenant runner后意外连接开发库

**并行分组：** `p08-042-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 4h复用现有DB准备helpers，只新增生命周期封装/独立config/报告守卫及PR；实际目标验证由消费卡完成，不能把这些未实现测试宣称已运行。

<a id="p08-043"></a>

## P08-043：扩展已批准时钟推进的请求修订分配

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** AcceptedClockRequestAllocator / SourceRequestRevisionPersistence

**输入：**

- P08-033/034分配器与P2-GATE最终公开CONTROL advance/create/reset协议；现有demo-commerce.mutations.ts是适配入口
- clockRevision仍int32业务metadata；requestRevision为单调UInt字符串，CLOCK请求与typed命令共用同一head

**输出：**

- 现有授权ADVANCE事务同CONTROL锁更新clock并追加CLOCK请求+requestRevision，记录真实clockRevision/generation；拒绝/无变化重试不重复分配
- 初始化/重置新generation按P2基础协议建立首个CLOCK请求；只补请求allocator hook，不再实现P2 clock/runtime/generator

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-clock-requests.ts`
- `packages/database/test/mock-actions/source-clock-requests.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/demo-commerce.mutations.ts`
- `packages/database/src/index.ts`

**硬依赖：** P08-034, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 只有clock advance无业务命令也提高request head，request-aware worker下一轮不误IDLE；clock事实和请求任一失败全回滚
- [ ] 同clock已发布后先接受命令再真实clock advance，冻结旧prefix可完成，下轮消费更高clock/request；无+1ms或Runtime rewrite
- [ ] advance/reset/disconnect竞争在CONTROL后fresh check；旧generation请求不可复用，overflow fail closed

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-clock-requests.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** idleness改用requestRevision后纯时钟进度失效

**并行分组：** `p08-043-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 P2-GATE完成后核对最终public advance owner，同PR更新确切handoff路径；只增加请求分配同tx hook，3h不重建P2 control基础。

<a id="p08-044"></a>

## P08-044：实现持久源请求发布宿主与重启拾取

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** SourcePublicationHost / DurablePendingRequestReader / SourceCommandPublicationAdapter

**输入：**

- P08-033公开pending request/clock prefix与P08-037有界publisher端口；完整source scope及实际worker身份
- 与action dispatch/verification jobs分离；实时bounded poll/启动恢复读取持久head/open job，不以进程内队列为唯一触发

**输出：**

- 拟新增host在启动及bounded poll扫描受限pending request/open job并驱动已有publisher；接受写入后的可选wake仅加速，丢wake仍能进展
- 旧open job沿lease/fence/checkpoint/latest-ack恢复；关停取消本次loop，publisher failure保留durable pending及诊断，禁止重新accept/dispatch业务命令

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/source-publication.host.ts`
- `apps/api/src/integrations/mock/source-publication.host.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-033

**实际接线依赖：** P08-037, P08-043, P08-040, P2-GATE

**验收：**

- [ ] 不发送wake时启动/poll仍拾取已接受未发布请求；假端口测试有界批次和backoff，不伪称runtime已注册
- [ ] process recreation只沿持久request/open job续发；acceptCommand/updatePrice/createProduct计数保持不增
- [ ] 两host竞争服从DB lease/fence，旧host不发布；stop/abort无悬挂loop，读端口不会触发写入

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/mock/source-publication.host.spec.ts --maxWorkers 1

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 没有宿主驱动时accepted请求永久PENDING

**并行分组：** `p08-044-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 3h只实现调度loop与生命周期组件，可按已合并契约注入测试端口；DB pending扫描由P08-036、真实注册由P08-049，不重做publisher。

<a id="p08-045"></a>

## P08-045：扩展普通源读取和游标的请求证书边界

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** RequestPinnedPublicReadPort / RequestPinnedScanCursor

**输入：**

- P2-GATE最终公开source read/scan/pagination契约与P08-033/034 request certificate；P2 clock-only v1不能假定已有request字段
- P08-040公开certificate/request typed边界；read actor与worker身份分离

**输出：**

- 拟新增public read wrapper把scope/generation/publicationRevision/requestRevision/certificateHash完整绑定至新scan和opaque cursor；旧v1 pins只读兼容
- 同clock新scan选择最新已发布request pin；续页只读原certificate及其eventSeq范围，不隐式调用claim/append/publish；root公共导出在同PR完成
- 本卡shared source-read.ts/source-cursor.ts（明确拟定P2 handoff路径）扩展公开读取参数/证书返回及cursor codec验证；source request reader wrapper不假设v1自动支持新pin

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-request-read.ts`
- `packages/database/test/mock-actions/source-request-read.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/mock-platform/types.ts`
- `packages/database/src/mock-platform/index.ts`
- `packages/database/src/index.ts`
- `packages/database/src/mock-platform/source-read.ts`
- `packages/database/src/mock-platform/source-cursor.ts`

**硬依赖：** P08-034, P08-040, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 旧scan续页在同clock更高request发布后仍保持原内容/hash/排序；新scan读更高request，未发布请求不可见
- [ ] 伪造cursor、错scope/query/generation/certificate或未published ref拒绝；request UInt不Number转换
- [ ] 普通point/read/list均保留certificate/sourceVersion，read进程无worker grant且写调用计数0；public root import/build验证

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-request-read.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 新请求只被action回读看见而普通扫描仍停旧clock

**并行分组：** `p08-045-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 source-read.ts/source-cursor.ts为明确拟定P2-GATE公共point/scan/cursor适配文件，已登记shared锁；最终handoff命名不同则领取前同PR更名卡上路径。3h只给已完成P2 SQL read/scan增加request certificate pin与continuation验证，不重做P2扫描/生成。

<a id="p08-046"></a>

## P08-046：传播Mock普通读取和分页的请求固定证书

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** RequestPinnedMockReadAdapter / CommerceConnectorReadCursor

**输入：**

- P08-045实际普通read/scan port与P2-GATE最终Mock SQL读适配器；现有mock-page/mock-cursor-store/connector/factory/host是读取边界
- 只扩P2 merged read adapter支持request pin，复用当前scope/auth/deadline，普通read不驱动publisher

**输出：**

- 拟新增Mock read bridge让getProduct/listProducts及其余source reads携带public certificate/request pin；续页继续旧pin，新scan读取最新published pin
- 同PR把bridge绑定至Mock connector/factory/host与pagination/cursor owners；已有P2 SQL read实现保持，禁止读未发布source/场景oracle

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/source-request-read.adapter.ts`
- `apps/api/src/integrations/mock/source-request-read.adapter.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/integrations/mock/mock-page.ts`
- `apps/api/src/integrations/mock/mock-cursor-store.ts`
- `apps/api/src/integrations/mock/mock-commerce-connector.ts`
- `apps/api/src/integrations/mock/mock-connector-factory.ts`
- `apps/api/src/demo-commerce/demo-commerce-connector.host.ts`

**硬依赖：** P08-045, P08-038, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 同business clock source publication更新后getProduct与新list scan见最新version，原cursor续页内容/hash仍不变
- [ ] cursor跨tenant/generation/query或cert失败fail closed；PENDING/read timeout不能变成功/空零值
- [ ] read-only factory/host调用不accept/dispatch/publish；existing Mock read回归与public @shopmate/database root import/typecheck通过

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/mock/source-request-read.adapter.spec.ts src/integrations/mock/mock-commerce-connector.spec.ts --maxWorkers 1
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 分页隐式升级证书而混入后来的same-tick事实

**并行分组：** `p08-046-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 4h只适配已合并P2 read/scan的request字段与connector绑定，非重新开发SQL reader；P2-GATE核对实际路径并更新同锁，不把此行为塞进价格writer wiring。

<a id="p08-047"></a>

## P08-047：接入请求固定读取到正常同步路径

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** RequestPinnedSyncAdapter / NormalSyncTrigger

**输入：**

- P08-046普通Mock read/cursor与P08-048真实facts/cursor/pin事务；P2-GATE已合并普通sync入口
- 同clock新scan/旧scan续页和source version正常归一化；沿现有正常sync调度，不从action outcome直接写facts

**输出：**

- 拟新增request-aware sync adapter并绑定现有正常sync调用点，增量判定消费publication/request pin而不只比较clockWatermark
- 归一化仅消费真实source snapshot；每页facts/cursor/pin同tx，旧scan完成后新scan收敛higher request

**独占文件（新路径为计划创建）：**

- `apps/api/src/sync/request-pinned-sync.adapter.ts`
- `apps/api/src/sync/request-pinned-sync.adapter.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/sync/sync.service.ts`
- `apps/api/src/sync/sync.module.ts`

**硬依赖：** P08-046, P08-048, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 真实normal sync触发同clock新扫描更新规范价及sourceVersion，未发布请求绝不提前写入
- [ ] 途中新publication不改变旧scan页；完成后下一scan见新request，restart沿durable cursor/pin恢复
- [ ] sync失败/错tenant/ref/过期generation回滚facts+cursor，api read/publisher/action verification不写规范facts

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/sync/request-pinned-sync.adapter.spec.ts --maxWorkers 1
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 动作回读成功但普通同步永远跳过相同clock

**并行分组：** `p08-047-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 sync.service/module为明确拟定P2 handoff接线文件，当前未存在；P2-GATE核对后同PR更新卡到实际路径，3h仅新增request-pin传播，不重做P2 normalizer/scheduler。

<a id="p08-048"></a>

## P08-048：持久化正常同步的请求固定扫描状态

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** RequestPinnedSyncState / NormalizedFactsCursorCommit

**输入：**

- P2-GATE最终normalized sync state/cursor事务端口与P08-045 request-pinned public read contract
- 同tenant/store/connection/generation的扫描状态；同clock仍以request/publication区分新事实

**输出：**

- 拟新增request sync state扩展及独立migration，保存publicationRevision/requestRevision/certificateHash与cursor，旧v1状态按codec只读兼容
- 在现有normalized facts+cursor同tx端口增加pin写入/CAS；仅sync角色可提交，writer/publisher/readback均无规范库写权限；root导出明确
- shared sync-state.repository.ts（明确拟定P2 handoff路径）拥有现有facts/cursor事务口新增request pin原子参数/CAS，不让API接线卡补数据库存储逻辑

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/request-sync-state.ts`
- `packages/database/test/mock-actions/request-sync-state.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080800_request_sync_state/migration.sql`
- `packages/database/src/index.ts`
- `packages/database/src/sync/sync-state.repository.ts`

**硬依赖：** P08-045, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 规范facts/cursor/pin任一写失败整体rollback；请求pin倒退或跨scope/generation拒绝
- [ ] 同clock更高已发布request允许下一轮同步，旧进行中的scan只按旧pin提交；restart恢复原pin/cursor而不混页
- [ ] 旧clock-only sync状态不伪造新request cert；数据更新必须走P2同步事务，SQL参数化/RLS默认拒绝

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/request-sync-state.test.mjs
- pnpm --filter @shopmate/database prisma:validate
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 游标只按时钟去重遗漏同刻源变化

**并行分组：** `p08-048-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 只新增pin状态与现有事务端口适配；sync-state.repository.ts为明确拟定P2 normalized state owner且已登记shared锁，最终handoff命名不同则领取前同PR更名卡上路径，不复制P2同步存储实现。

<a id="p08-049"></a>

## P08-049：注册源发布宿主及其启动恢复触发

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** SourcePublicationRuntimeRegistration

**输入：**

- P08-044 host、P08-036持久pending扫描、P08-037真实publisher、P08-043 clock allocator均已完成
- P2 source实际worker grant/config与现有DemoCommerceModule启动/关停；普通reads/sync有独立owners

**输出：**

- 拟新增SourcePublicationModule在API正常bootstrap注册host启动/poll/restart和shutdown；worker作用域由受限配置/当前授权解析，不伪造管理员
- 只DI绑定已有pending reader/publisher/clock hooks；业务write只accept请求，read没有发布副作用

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/source-publication.module.ts`
- `apps/api/src/integrations/mock/source-publication.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/api/src/demo-commerce/demo-commerce.module.ts`

**硬依赖：** P08-044, P08-036, P08-037, P08-040, P08-043, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 正常API启动注册host且已有未发布请求自行推进；不调用测试手动publisher方法
- [ ] API重建沿持久lease/checkpoint恢复且accept/dispatch计数不增加；shutdown停止有界loop
- [ ] 禁用demo/缺worker资格/connection撤销失败明确；root/module无循环依赖，scope不由HTTP caller覆盖

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/mock/source-publication.module.spec.ts --maxWorkers 1
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 数据库publisher有实现但API根模块未启动

**并行分组：** `p08-049-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 2h只宿主DI注册与生命周期smoke，不实现scheduler/reader/publisher或command策略。

<a id="p08-050"></a>

## P08-050：证明正常审批执行到源发布与同步收敛

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ApprovedHttpToPublishedReadAndSyncProof

**输入：**

- P08-013真实已批准执行API、P08-049正常启动host、P08-046普通read/cursor及P08-047 normal sync
- isolated DB/真实human login，两tenant，受控已有P2故障规则；没有手动驱动publisher

**输出：**

- 聚焦公开路径证明：approve→execute HTTP→durable accepted→host publication→independent read→normal sync，仅测试setup用operator种子
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/source-publication-runtime.e2e-spec.ts；API目标tenant config include且default config exclude

**独占文件（新路径为计划创建）：**

- `apps/api/test/source-publication-runtime.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`

**硬依赖：** P08-013, P08-049, P08-046, P08-047, P07-019, P2-GATE, P08-056

**实际接线依赖：** 无

**验收：**

- [ ] 正常execute HTTP返回ACCEPTED后本次host自动发布，独立point read见6200/sourceVersion；只有normal sync后规范库从5900变6200，test从不直接调用publisher/claim/append/publish
- [ ] 接受后publication前重建API进程，恢复未发布prefix且updatePrice/accept计数不增；旧pinned cursor/hash内容不变，新scan在同clock见higher request，0 skipped
- [ ] 首次published后新proposal批准fresh version→6300可在同clock执行；纯clock advance也通过allocator被普通host拾取，规范cursor/pin与facts原子收敛
- [ ] 错tenant/generation/revoked/read lag与sync tx failure不伪造VERIFIED/规范事实；pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库；清除继承开发DATABASE_URL，不读.env，仅runner生成TEST_DATABASE_URL/runtime DATABASE_URL；注册集非空，每目标执行>0、0 skipped，零选择或skip失败，finally stop

**测试：**

- pnpm test:tenant

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 底层proof手动发布掩盖正常运行PENDING

**并行分组：** `p08-050-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 4h只此公路由集成证明及PR；复用已完成源DB低层/审批/并发fixtures，不另写浏览器全故事；poll等待观察事实，有界deadline，无sleep替代锁证据。

<a id="p08-051"></a>

## P08-051：定义绑定审批哈希的价格补偿元数据契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** PriceSetCompensationMetadataV1 / CompensationAssociationPort / CompensationReadPort

**输入：**

- P07-001 proposal/approval与P08-001 execution基础strict契约；补偿复用PRICE_SET绝对价分支
- P08-011只补偿已核实原PRICE_SET execution，新的candidate id/revision/hash/key/approval

**输出：**

- 选定PRICE_SET payload带strict compensation:{parentExecutionId,parentProposalId,parentRevision,parentPayloadHash,candidateId,verifiedSourceVersion,restorePriceMinor}；全部执行相关元数据进入不可变payload canonicalHash并被新human approval绑定，非展示字段
- public typed association/read ports：bindCandidate/cancelCandidate/rejectCandidate/bindChild/commitVerifiedOutcome；状态CANDIDATE_PENDING/CANCELLED/REJECTED/CHILD_PENDING/CONFLICT/VERIFIED_ROLLBACK；无未拥有PRICE_COMPENSATION kind
- 同PR持contracts-index锁root导出schema/ports，并在proposal/execution strict schemas挂PRICE_SET可选补偿分支与status关联DTO；普通PRICE_SET没有metadata也保持兼容
- candidate关联时锁定parent Action状态并保存parentPriorActionStatus（已独立验证SUCCEEDED）与原verification引用；cancel/reject只在本active candidate且child未accepted时恢复该真实原状态，绝不写ROLLED_BACK或改原receipt/readback

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/actions/price-compensation.schema.ts`
- `packages/contracts/src/actions/price-compensation.schema.spec.ts`
- `packages/contracts/src/actions/compensation-association.ports.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`
- `packages/contracts/src/actions/proposal.schema.ts`
- `packages/contracts/src/actions/execution.schema.ts`

**硬依赖：** P07-001, P08-001

**实际接线依赖：** 无

**验收：**

- [ ] 精确补偿payload通过正常strict PRICE_SET schema；未知metadata/key/kind、unsafe money或缺完整parent binding拒绝
- [ ] metadata修改必改变审批绑定hash；parent/candidate/child同scope、不同proposal revision/approval/execution key；旧approval不能授权
- [ ] cancel/reject仅终止尚未执行候选关联，清除active pending并保留原execution真实验证结果；CHILD_PENDING/UNKNOWN不能取消来掩盖未知写，也不称ROLLED_BACK

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/actions/price-compensation.schema.spec.ts src/actions/proposal.schema.spec.ts src/actions/execution.schema.spec.ts
- pnpm --filter @shopmate/contracts typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** builder产生策略registry未注册的动作kind

**并行分组：** `p08-051-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 3h只选定metadata/ports与existing strict schema挂接；签名含义为可信human对不可变revision/hash审批绑定，不引入新加密密钥或新动作kind。

<a id="p08-052"></a>

## P08-052：新增持久资源待发布变更占位约束

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** PendingSourceResourceMutation / ResourceReservationPersistence

**输入：**

- P08-033 request protocol与P08-034 scoped immutable requests/receipts；资源key为规范tuple(kind,externalResourceId)
- 选定策略：同resource accepted unpublished期间拒绝第二distinct key/hash；同key/hash重试返回原receipt

**输出：**

- 拟新增PendingSourceResourceMutation模型/独立migration，full scope+generation+resource tuple唯一active reservation，绑定request/receipt/expectedVersion/command hash
- composite FK、RLS/column grants与状态约束保护accepted请求身份；发布清除只由同scope有效publish fence触发，不准进程内锁替代DB占位

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-resource-reservation-model.ts`
- `packages/database/test/mock-actions/source-resource-reservation-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080600_pending_source_mutations/migration.sql`

**硬依赖：** P08-034, P08-033

**实际接线依赖：** 无

**验收：**

- [ ] 数据库唯一active reservation阻止两个distinct key同resource pending；资源tuple不使用易碰撞字符串拼接
- [ ] scope/generation/request/receipt/hash FK错误及未授权clear失败，rollback不留下孤儿占位
- [ ] reset/disconnect按CONTROL原子隔离old generation占位；旧请求/receipt不可在新generation复活，restart仍保留active占位

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-resource-reservation-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** published version未改变时接受两个旧版本命令

**并行分组：** `p08-052-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 3h仅持久占位模型/约束/权限；实际admission与原子publication clearance由P08-053/036，真实two-client证明由P08-056，不扩大P08-034已有4h基础。

<a id="p08-053"></a>

## P08-053：实现资源占位与发布原子释放端口

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** SourceResourceReservationPort / FencedPublicationReservationClearance

**输入：**

- P08-052实际占位模型与P08-040公开request-aware worker/publish；P08-033 admitted mutation policy
- P2 CONTROL/fresh source access和publication事务边界，immutable receipt/request不得删除

**输出：**

- typed reserve/check/clear helpers：stable key/hash receipt查重先于pending拒绝；对distinct命令以资源占位+published expectedVersion一次原子检查，返回RESOURCE_PENDING conflict且不分配receipt/request
- existing publish事务在certificate完整提交时依fence+scope+request prefix原子清除其已发布资源占位；失败/ack loss/restart仍阻止第二旧version写，publish retry幂等
- reset/disconnect原事务使旧generation占位无效并保留历史receipt/request；公开root导出且pending request不会被读查询释放

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/source-resource-reservations.ts`
- `packages/database/test/mock-actions/source-resource-reservations.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/mock-platform/publication.ts`
- `packages/database/src/demo-commerce.mutations.ts`
- `packages/database/src/index.ts`
- `packages/database/prisma/migrations/20261005080700_source_mutation_reservations/migration.sql`

**硬依赖：** P08-052, P08-040, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] same key/hash pending重试仍原receipt；distinct key同resource pending返回RESOURCE_PENDING且请求/allocator/receipt均不变
- [ ] publication完成+资源clearance同tx；旧fence/错prefix/失败不能提前释放，process recreation占位仍在
- [ ] 发布后只允许fresh sourceVersion新命令，同clock可续下一request；reset旧scope/current access必须锁后重查

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/mock-actions/source-resource-reservations.test.mjs
- pnpm --filter @shopmate/database build

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** host崩溃或旧fence错误释放accepted占位

**并行分组：** `p08-053-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 publication.ts为已知P2拟定公开publisher owner，P2-GATE核对最终路径。3h只实现占位helper+publish/reset hooks，P08-036只调用此port，不把F4行为藏进connector或重写P2 publication。

<a id="p08-054"></a>

## P08-054：新增补偿父候选子执行持久关系约束

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** CompensationAssociationPersistenceV1

**输入：**

- P08-051 typed PRICE_SET metadata/association states，P08-002 execution及P07-005/006 proposal/approval模型
- parent是已独立验证原PRICE_SET，candidate不可变新提案，child是新的执行与approval，完整同scope

**输出：**

- 拟新增CompensationAssociation Prisma model及独立migration：parentExecutionId/candidateProposalId+revision/hash/childExecutionId+approvalId/associationStatus；保存parentPriorActionStatus与originalVerifiedRef供未执行cancel/reject原子恢复，原execution verification事实不变
- composite scope FK、candidate唯一、child唯一、parent最多一个active pending association；child不得等parent，candidate/approval/key不得复用原值；CHECK states和nullable-child组合，取消拒绝保留关联历史

**独占文件（新路径为计划创建）：**

- `packages/database/src/actions/compensation-association-model.ts`
- `packages/database/test/actions/compensation-association-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005080900_compensation_associations/migration.sql`

**硬依赖：** P08-051, P08-002, P07-005, P07-006

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store/generation parent/candidate/child/approval FK与同execution/key/revision复用拒绝
- [ ] 同时bind同parent active candidate最多一条；CANCELLED/REJECTED child=null可终止候选，CHILD_PENDING/VERIFIED必须有合法child
- [ ] migration/model契约可独立验证，真实persisted association与constraints由P08-030隔离API证明；未知结果不能记VERIFIED_ROLLBACK

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/actions/compensation-association-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 补偿controller只在内存记录parent而无数据库约束

**并行分组：** `p08-054-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 3h仅关系schema/约束契约；执行结果仍保留原record与association分开读取，SQL/仓库状态mutation归P08-055/029。

<a id="p08-055"></a>

## P08-055：实现补偿候选与子执行关联事务仓库

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P0

**契约：** CompensationAssociationPort / CompensationReadPort implementation

**输入：**

- P08-051 public typed ports与P08-054实际模型；现有trusted tenant tx、P09-004 audit、proposal/approval/execution读写端口
- P08-029只reduce真实child outcome；normal PRICE_SET批准及reserve通过本仓库关联child

**输出：**

- parameterized repository实现bindCandidate/cancelCandidate/rejectCandidate/bindChild/commitVerifiedOutcome及scoped reads；不实现新的approval policy/执行策略
- candidate create/关联/audit同tx；normal approve/reject/cancel与execution reserve按typed关联port原子更新child/association，immutable metadata比对persistent parent/candidate；取消拒绝仅在锁定本active candidate且child未accepted时恢复保存的parentPriorActionStatus（原SUCCEEDED），不称回滚成功、不改原execution receipt/readback

**独占文件（新路径为计划创建）：**

- `apps/api/src/actions/compensation-association.repository.ts`
- `apps/api/src/actions/compensation-association.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P08-054, P08-051, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] persist/read完整parent→candidate→approval→child关联roundtrip；同binding重试幂等，错parent/hash/revision/old approval/key/fence拒绝
- [ ] candidate未执行cancel或normal reject后状态CANCELLED/REJECTED、active pending释放，parent原真实VERIFIED结果保留且不称ROLLED_BACK；已dispatch UNKNOWN不能cancel
- [ ] audit/关联/child任一失败全rollback；only真实child VERIFIED可完成关联，跨scope读默认拒绝
- [ ] parent Action进入ROLLBACK_PENDING和prior状态保存同关联/audit事务；cancel/reject同tx恢复prior SUCCEEDED并释放active association，错active候选/旧fence不能恢复或覆盖较新状态，原source仍执行后价

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/actions/compensation-association.repository.spec.ts --maxWorkers 1
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 真实vendor/LLM调用、部署、线上迁移或身份供应商上线
- 不重做P2基础实现，不修改immutable Runtime/旧source/history/certificate，不假造时间推进

**风险：** 关系修改游离正常审批和execution reserve事务

**并行分组：** `p08-055-boundary`

**执行边界：** 拟新增路径；人工工时包含实现、定向验证和PR准备，超过4h先拆独立卡；每个独立改动单独commit/分支/PR，经review、latest CI及main合并后Done。函数/回调/SQL体<40行，TS无any；严格输入/sanitize、参数化SQL、完整可信scope、密钥仅env。fixture仅测试目录合成，不能替代runtime证明。 4h只仓库/关联事务实现与聚焦端口验证及PR；P08-027注册，P07-008/P08-003调用已经完成的typed port，P08-030负责真实DB roundtrip。

<a id="p08-056"></a>

## P08-056：证明待发布资源占位的双键并发安全

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** PendingSourceMutationTwoKeyProof

**输入：**

- P08-036/037/053真实admission/publish clearance与P08-052占位schema；P2-GATE actual source/control logins
- isolatedPostgres两真实client、barrier/pg_locks；仅低层协议，不依赖业务connector避免循环

**输出：**

- 真实DB确定性交错证明两个distinct keys同resource/同expectedVersion在publication前最多一mutation；exact-key receipt retry保持幂等
- 本卡持runner共享锁显式注册必跑目标：packages/database/test/integration/source-resource-reservations.test.mjs；nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/source-resource-reservations.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P08-037, P08-053, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 两真实client用barrier/pg_locks确定交错：distinct key A/B同resource/同expected v1、A未published时B进入；至多一个accepted并最终mutation=1，B RESOURCE_PENDING无receipt/request；identical key/hash仍原receipt
- [ ] 在accepted未published间重建store/worker，持久占位仍阻止distinct stale命令；旧fence/发布失败不clear，成功certificate/clear同tx；reset/disconnect锁后旧scope请求不能复活，fresh v2在sameclock允许下一请求
- [ ] 不同resource不被误拒；RESOURCE_PENDING不分配request/receipt/head，changed hash同key冲突；actual-login reader无release能力且worker不能改Runtime/immutable旧行
- [ ] pnpm test:tenant仅isolatedPostgres新建/stop disposable数据库，清除继承开发DATABASE_URL，仅runner注入TEST_DATABASE_URL/runtime DATABASE_URL；注册集非空，每目标执行>0且0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实vendor/LLM、部署/线上迁移
- 修改immutable P2历史、Runtime或伪造时间推进1ms
- 一般场景生成器、全量同步重放、扩大source权限

**风险：** 同CONTROL分配request仍未约束accepted旧版本竞争

**并行分组：** `p08-056-source-resource-race`

**执行边界：** 拟新增路径；3h仅上述资源admission/clearance/restart/reset真实DB证明，复用P08-039 setup/fixtures。函数/测试回调/SQL体<40行、TS无any、strict输入/参数化SQL/完整scope/env密钥；独立commit/PR review/latest CI/main后Done。0 skipped，测试以锁/barrier观察证明交错，不以sleep或process-local lock冒充DB safety。
