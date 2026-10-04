# Phase 10 — Daily Brief / Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p10-001"></a>

## P10-001：冻结简报与站内配送契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** DailyBrief / NotificationIntent / TransactionalEnqueuePort / NotificationPreferences / DeliveryReceipt

**输入：**

- P03-001/P04-001 metric/evidence/event和P04-002effective routing
- org/workspace/store/user recipient scope、businessDate/timezone和真实delivery clock

**输出：**

- brief按日/version、evidence refs/watermark/quality及strict notification schema
- outbox states/attempt/lease/dedup/cooldown/quiet-hours、read/prefs query ports

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/notifications/delivery.schema.ts`
- `packages/contracts/src/notifications/delivery.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P03-001, P04-001, P04-002

**实际接线依赖：** 无

**验收：**

- [ ] 非法recipient/scope/timezone/oversize通知拒绝
- [ ] 唯一意图由event-state-version+recipient+channel生成，UNKNOWN不当delivered
- [ ] daily brief版本绑定evidenceHash，未知profit不能写0；EventSeverity不授权action

**测试：**

- pnpm --filter @shopmate/contracts test -- src/notifications/delivery.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 事件稳定身份不得用标题文本fingerprint替代

**并行分组：** `brief-notifications-1`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 outbox/配送基础可先行，前置领域mutation运行接线须consume事务enqueue port。

<a id="p10-002"></a>

## P10-002：建立站内outbox与收件记录约束

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P0

**契约：** NotificationOutbox / RecipientInbox persistence

**输入：**

- P10-001状态/intent唯一键和既有tenant recipient membership模型
- 单渠道IN_APP与SecurityClock nextAttemptAt；payload仅ref及脱敏摘要

**输出：**

- planned outbox/inbox schema、recipient复合scope/RLS/唯一delivery key

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004100100_notification_outbox/migration.sql`
- `packages/database/test/notification-outbox-migration.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`

**硬依赖：** P10-001

**实际接线依赖：** 无

**验收：**

- [ ] event-version/user/channel唯一键阻止重复意图与收件记录
- [ ] recipient跨org/workspace/store插入/查询默认拒绝
- [ ] leaseUntil/attempt/nextAttemptAt字段齐全；未读为空而非猜值

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/notification-outbox-migration.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** worker更新权限不得扩大普通用户跨scope权限

**并行分组：** `brief-notifications-2`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 outbox/配送基础可先行，前置领域mutation运行接线须consume事务enqueue port。 仅提交DDL/schema与本地隔离/静态验证，不执行live migrate；共享Prisma schema由协调者merge lock处理。

<a id="p10-003"></a>

## P10-003：实现事件事务内通知入队端口

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** TransactionalEnqueuePort / BoundTenantTransaction

**输入：**

- P10-001/P10-002及P09-004 audit append；前置event mutation tx句柄
- validated effective routing结果，不接受provider直接授权

**输出：**

- 参数化enqueue repository与稳定intent重复返回

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/notification-enqueue.repository.ts`
- `apps/api/src/notifications/notification-enqueue.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001, P10-002, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] event状态和outbox任一失败整体回滚不出现漏通知
- [ ] 重复同event version/recipient只一intent，严重度升级可新intent
- [ ] 未授权recipient/非法routing禁止入队且metadata脱敏

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/notification-enqueue.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 所有前置event mutation接线必须hard依赖此锚点

**并行分组：** `brief-notifications-3`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 outbox/配送基础可先行，前置领域mutation运行接线须consume事务enqueue port。

<a id="p10-004"></a>

## P10-004：实现到期outbox领取租约与恢复

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** NotificationLeasePort / DeliveryJobClaim

**输入：**

- P10-001/P10-002 schema与注入clock/受限worker tenant resolver
- claim SQL参数化，lease token与generation/scope

**输出：**

- SKIP LOCKED claim/renew/reclaim repository和并发回归

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/notification-lease.repository.ts`
- `apps/api/src/notifications/notification-lease.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001, P10-002

**实际接线依赖：** P10-003

**验收：**

- [ ] 两个worker同job只能一持lease；不同job可并发
- [ ] 进程退出后过期lease可重领，旧token不能ack
- [ ] 领取与dispatch前都重验recipient/store连接可见性；撤销后取消

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/notification-lease.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** lease保证单持有者仍需投递idempotency

**并行分组：** `brief-notifications-4`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 outbox/配送基础可先行，前置领域mutation运行接线须consume事务enqueue port。

<a id="p10-005"></a>

## P10-005：实现单通知幂等站内配送与重试

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** InAppDeliveryWorker / DeliveryStatePort

**输入：**

- P10-001及注入lease/inbox persistence/clock/scheduler ports
- P09-004 writer和指数退避+jitter/retry limit配置
- 本卡补齐DeliveryStatePort真实事务adapter；schedule/claim由P10-004/P10-013负责

**输出：**

- 单claimed-job站内dispatch worker与事务delivery adapter：inbox upsert+receipt+outbox ack，失败仅计划下一次retry/DLQ

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/in-app-delivery.worker.ts`
- `apps/api/src/notifications/in-app-delivery.worker.spec.ts`
- `apps/api/src/notifications/in-app-delivery.repository.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001

**实际接线依赖：** P10-003, P10-004, P09-004

**验收：**

- [ ] inbox upsert与outbox delivered同事务，crash后重复不会多一通知
- [ ] 临时失败指数退避/jitter有上限，耗尽进入DLQ不无限重试
- [ ] 取消/权限撤销后不投递；worker无页面访问仍执行到期任务

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/in-app-delivery.worker.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 测试注入scheduler不等于runtime后台生命周期已接线

**并行分组：** `brief-notifications-5`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 outbox/配送基础可先行，前置领域mutation运行接线须consume事务enqueue port。 此卡仅处理一个已领job，retry公式为小纯函数；后台启动/循环由P10-013接线。

<a id="p10-006"></a>

## P10-006：实现状态去重冷却与合并规则

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** NotificationEligibility / CooldownStatePort / MergeBucket

**输入：**

- P10-001 effective routing及状态version、recipient prefs
- 注入cooldown CAS port；same evidenceHash/request key避免重复深LLM

**输出：**

- 确定性首次/升级/恢复/需人工介入规则与有界合并bucket

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/notification-eligibility.ts`
- `apps/api/src/notifications/notification-eligibility.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001

**实际接线依赖：** P10-007

**验收：**

- [ ] unchanged事件在cooldown内不再发送或重复申请深LLM
- [ ] 严重度显著升级/恢复按policy打破冷却并保留因果ref
- [ ] 多事件有界合并不全升urgent；并发CAS只允许一有效发送

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/notification-eligibility.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 优先级硬floor仍来自routing服务，不可由cooldown降级

**并行分组：** `brief-notifications-6`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-007"></a>

## P10-007：持久化通知偏好与冷却状态

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** NotificationPreferencePort / CooldownStatePort

**输入：**

- P10-001 prefs/quiet-hours schema及server scope，P09-004 writer
- 真实UTC时钟与用户timezone换算；冷却state/version CAS

**输出：**

- planned preference/cooldown表和参数化read/update/CAS repository

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004100200_notification_preferences/migration.sql`
- `apps/api/src/notifications/notification-preference.repository.ts`
- `apps/api/src/notifications/notification-preference.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`

**硬依赖：** P10-001, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 偏好strict校验timezone/quiet interval/cooldown上限，非法不写
- [ ] 跨用户/tenant读写拒绝，更新与audit同事务
- [ ] 跨午夜quiet-hours与DST边界正确，重启后cooldown CAS仍去重

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/notification-preference.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 偏好变化不应吞掉必须人工介入的硬门槛通知

**并行分组：** `brief-notifications-7`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-008"></a>

## P10-008：实现带证据的每日简报组装器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** DailyBriefBuilder / MetricEventSummaryPorts

**输入：**

- P10-001及注入metric/event/proposal summary ports
- 同businessDate/window/watermark版本快照，无外部LLM

**输出：**

- 简短重要变化/风险/机会/待决策列表与as-of/quality/evidence refs

**独占文件（新路径为计划创建）：**

- `apps/api/src/daily-brief/daily-brief-builder.ts`
- `apps/api/src/daily-brief/daily-brief-builder.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001

**实际接线依赖：** P03-001, P04-001, P07-001, P2-GATE, P03-018, P04-029, P07-014

**验收：**

- [ ] 来自当次证据而非固定+12%/17小时通用句
- [ ] missing cost/stale/insufficient明示质量不生成精确利润
- [ ] 无变化给简短no-change摘要；无数据给empty且每claim有evidence

**测试：**

- pnpm --filter @shopmate/api test -- src/daily-brief/daily-brief-builder.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** brief不重复计算metric或把建议变为授权

**并行分组：** `brief-notifications-8`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-009"></a>

## P10-009：持久化简报按日版本与生成锁

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** DailyBriefRepository / BriefGenerationLease

**输入：**

- P10-001/P10-008输入及P09-004 audit/transaction ports
- org/store/businessDate/evidenceHash/version唯一，注入clock

**输出：**

- planned daily_briefs schema与参数化保存/按日查询/生成CAS

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004100300_daily_briefs/migration.sql`
- `apps/api/src/daily-brief/daily-brief.repository.ts`
- `apps/api/src/daily-brief/daily-brief.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`

**硬依赖：** P10-001, P09-004

**实际接线依赖：** P10-008, P2-GATE

**验收：**

- [ ] 重复同日同evidenceHash只一版本；新证据生成新version
- [ ] 并发worker只有一个生成claim；重启过期lease可恢复
- [ ] 跨scope拒绝，brief与audit保存原子，旧版evidence refs保留

**测试：**

- pnpm --filter @shopmate/api test -- src/daily-brief/daily-brief.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** businessDate由店铺zone算而不是server本地日期

**并行分组：** `brief-notifications-9`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-010"></a>

## P10-010：实现简报与收件箱鉴权查询端点

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** BriefReadPort / InboxReadPort / InboxMarkReadPort

**输入：**

- P10-001 contract及现有认证及TenantScopeService.resolve，注入各read/mutation port
- server recipient userId与strict pagination/businessDate/notificationId

**输出：**

- 只读brief/inbox/count控制器和幂等mark-read端点

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/inbox-read.controller.ts`
- `apps/api/src/notifications/inbox-read.controller.spec.ts`
- `apps/api/src/daily-brief/daily-brief.controller.ts`
- `apps/api/src/daily-brief/daily-brief.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001

**实际接线依赖：** P10-002, P10-009, P09-004

**验收：**

- [ ] 无session401，其他recipient/scope通知拒绝
- [ ] 非法date/cursor/id返回400；无brief与服务失败分别empty/error
- [ ] 重复mark read不负计数，任一mutation走注入事务port并audit

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/inbox-read.controller.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 本卡控制器不实现inbox DB查询与mark-read仓库

**并行分组：** `brief-notifications-10`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 现有TenantContextGuard拒绝任何query/body；本端点复用TenantScopeService.resolve与server认证，不直接挂该guard。允许filter/body在controller strict schema独立校验；scope从验证header/path+server membership解析。

<a id="p10-011"></a>

## P10-011：实现DailyBrief证据与状态界面

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** DailyBriefProps / BriefReadTransport

**输入：**

- P10-001brief和注入transport；P05-001证据导航
- 复用dashboard report card和现有设计tokens

**输出：**

- 每日brief卡片、版本/as-of/quality/证据入口及transport校验

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/daily-brief/daily-brief-card.tsx`
- `apps/web/src/app/daily-brief/daily-brief-card.test.tsx`
- `apps/web/src/app/daily-brief/daily-brief-api.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001, P05-001

**实际接线依赖：** P10-009, P05-010

**验收：**

- [ ] 375px关键变化/风险/待决策可读且证据入口可聚焦
- [ ] loading/empty/error明确且retry不重复创建brief
- [ ] stale/unknown显示质量、version/as-of而非当前时间；不显示未验证利润

**测试：**

- pnpm --filter @shopmate/web test -- src/app/daily-brief/daily-brief-card.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** brief页不能偷偷触发供应商生成或同步

**并行分组：** `brief-notifications-11`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-012"></a>

## P10-012：适配现有通知中心为注入收件箱组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** InboxViewPort / ScopedInboxClient

**输入：**

- P10-001与既有notification-center visual/keyboard patterns
- 读取count/list和mark-read注入port，页面打开不负责监控sync

**输出：**

- 新delivery inbox组件与transport；加载/错误/read mutation状态

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/notifications/delivery-inbox.tsx`
- `apps/web/src/app/notifications/delivery-inbox.test.tsx`
- `apps/web/src/app/notifications/inbox-api.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001

**实际接线依赖：** P10-010

**验收：**

- [ ] 375px/loading/empty/error与键盘关闭/聚焦恢复均有效
- [ ] read失败不假减unread；重复点击只发一次pending mutation
- [ ] 切店取消旧请求，打开面板无sync/worker side effect

**测试：**

- pnpm --filter @shopmate/web test -- src/app/notifications/delivery-inbox.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 迁移现有notification-center挂载需后续共享wiring

**并行分组：** `brief-notifications-12`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-013"></a>

## P10-013：接入后台配送简报与现有通知入口

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** NotificationsModule / DailyBriefModule runtime lifecycle

**输入：**

- P10-003..012/P10-017组件与P03/P04/P07真实ports，P2 gate
- backend启动/停止scheduler、受限tenant workers，不依赖页面访问

**输出：**

- 模块DI、生命周期定时worker、brief生成调度和通知中心入口接线

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/notifications.module.ts`
- `apps/api/src/daily-brief/daily-brief.module.ts`
- `apps/api/test/notification-wiring.integration.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/web/src/app/notification-center.tsx`
- `apps/web/src/app/overview/overview-page.tsx`

**硬依赖：** P10-003, P10-004, P10-005, P10-006, P10-007, P10-008, P10-009, P10-010, P10-011, P10-012, P10-017, P03-001, P04-001, P07-001, P09-004, P2-GATE, P03-018, P04-029, P07-014, P07-019, P05-010

**实际接线依赖：** 无

**验收：**

- [ ] 无打开页面时due events仍持久配送且brief按日生成
- [ ] 停启worker恢复lease/outbox且shutdown停止新claim
- [ ] scope gate未齐保持disabled，模块不含test-only oracle或外发transport

**测试：**

- pnpm --filter @shopmate/api test -- test/notification-wiring.integration.spec.ts
- pnpm --filter @shopmate/api typecheck
- pnpm --filter @shopmate/web typecheck

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 只接线已交付ports；不在4h内补建上游实现

**并行分组：** `brief-notifications-13`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 所有consumes中的实际runtime实现必须已合入；contract ID只锁接口，不代表实现可用，协调者需补全提供方integration卡硬依赖。

<a id="p10-014"></a>

## P10-014：验证通知重启并发与冷却投递

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** ReliableInAppDelivery failure matrix

**输入：**

- P10-013真实后台binding与隔离本地DB fixtures
- crash前后outbox/inbox/receipt、两worker与security clock

**输出：**

- 真实事务+并发+进程重启可靠配送定向集成测试

**独占文件（新路径为计划创建）：**

- `apps/api/test/notification-delivery.integration.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-013

**实际接线依赖：** 无

**验收：**

- [ ] event tx rollback无孤立outbox；receipt写后crash重启不重复inbox
- [ ] 两worker race/旧lease ack拒绝；temporary fail重试到DLQ可观测
- [ ] first/upgrade/recovery能发，unchanged冷却内不发；quiet-hours/DST正确

**测试：**

- pnpm --filter @shopmate/api test -- test/notification-delivery.integration.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 使用真实受限DB身份证明，而不只mock lease

**并行分组：** `brief-notifications-14`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-015"></a>

## P10-015：编写五分钟经营闭环演示脚本

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** research · **类型：** research · **优先级：** P1

**契约：** DemoNarrative / EvidenceTraceChecklist

**输入：**

- 已批准J demo story与P05/P06/P07/P08/P09/P10本地runtime
- 现有受控demo advance/fault controls，数字来自当前dataset

**输出：**

- 五分钟步骤/时间分配、数据refs、失败注入与预期界面验收脚本

**独占文件（新路径为计划创建）：**

- `docs/demo/five-minute-operating-loop.md`
- `docs/demo/five-minute-operating-loop-checklist.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** 无

**实际接线依赖：** P05-010, P06-016, P07-001, P08-001, P09-011, P10-013, P2-GATE, P03-018, P04-029, P07-015, P08-015

**验收：**

- [ ] 脚本先取本次period/evidence再讲销量涨利润降，不固定数字
- [ ] 补货推荐不伪增可售库存；单SKU价候选→人工审批→独立回读→audit
- [ ] 写成功回包丢失示UNKNOWN/停盲重试，最后brief/inbox去重可观察

**测试：**

- 手动：依据docs/demo/five-minute-operating-loop-checklist.md在本地fixture模式逐步计时；运行接线未齐时仅验脚本文字，不标演练通过

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 脚本可先撰写，完成演练不能仅靠contract anchor

**并行分组：** `brief-notifications-15`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-016"></a>

## P10-016：验证简报通知375px与完整演示故事

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** BriefInboxUX / LocalDemo acceptance

**输入：**

- P10-013及P10-015脚本，P05/P06/P07/P08/P09本地路线
- 375px/desktop和正常/unknown/write-response-loss fixture

**输出：**

- Playwright定向UI截图和本地五分钟演练证据

**独占文件（新路径为计划创建）：**

- `tests/e2e/daily-brief-notifications.spec.ts`
- `docs/qa/five-minute-demo-rehearsal.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-013, P10-014, P10-015, P05-010, P06-016, P09-011, P07-001, P08-001, P07-015, P08-015

**实际接线依赖：** 无

**验收：**

- [ ] 375px/桌面brief/inbox loading/empty/error无横向溢出，生效quiet/cooldown策略可观察
- [ ] 脚本可在5分钟内完成并所有数字追到evidence；权限不足审批不可执行
- [ ] write-response-loss只一execution，无假成功；重开页面通知不重复

**测试：**

- pnpm exec playwright test tests/e2e/daily-brief-notifications.spec.ts
- 手动：本地按docs/demo/five-minute-operating-loop-checklist.md计时并记录evidence/run/action/execution IDs

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 演练必须另gate实际approval/execution runtime集成卡

**并行分组：** `brief-notifications-16`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p10-017"></a>

## P10-017：实现收件箱仓库与通知偏好设置

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** InboxReadPort / InboxMarkReadPort / NotificationPreferencesAPI

**输入：**

- P10-001/P10-002收件表及P10-007偏好port，P09-004事务审计
- server recipient范围，计数/list/单条mark-read和设置strict参数

**输出：**

- 参数化inbox仓库和偏好controller；不实现UI设置页

**独占文件（新路径为计划创建）：**

- `apps/api/src/notifications/inbox.repository.ts`
- `apps/api/src/notifications/inbox.repository.spec.ts`
- `apps/api/src/notifications/notification-preference.controller.ts`
- `apps/api/src/notifications/notification-preference.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P10-001, P10-002, P09-004

**实际接线依赖：** P10-007

**验收：**

- [ ] 只有同scope本人能读/list/count/mark-read；读态audit同事务
- [ ] 分页稳定、重复mark-read保持同readAt且unread不负
- [ ] quiet/cooldown设置非法400、无session401、跨user403，不改变硬floor

**测试：**

- pnpm --filter @shopmate/api test -- src/notifications/inbox.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 首期只站内配送；不发email/SMS/平台消息

**风险：** 偏好UI不在本卡；现有UI可只呈现生效策略

**并行分组：** `brief-notifications-17`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 只提供偏好读写API和收件箱仓库；偏好可配置验收走API，不新增设置页。 现有TenantContextGuard拒绝任何query/body；本端点复用TenantScopeService.resolve与server认证，不直接挂该guard。允许filter/body在controller strict schema独立校验；scope从验证header/path+server membership解析。
