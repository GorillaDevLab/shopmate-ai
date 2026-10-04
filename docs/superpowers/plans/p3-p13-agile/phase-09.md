# Phase 9 — Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p09-001"></a>

## P09-001：冻结审计追加脱敏与查询契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** AuditAppendPort / AuditEntry / AuditQueryPage / AuditTraceView / AnonymousAuthSecurityEvent

**输入：**

- J4生命周期event families与P1 tenant transaction scope
- request/run/evidence/action/revision/approval/execution关联id，source time和真实occurredAt分开

**输出：**

- 严格事件union、actor/resource/result/occurredAt/redactedMetadata与稳定游标schema
- 事务bound append接口，分页/query/filter限制及查询权限manifest
- 查询chainVisibility=FULL/PARTIAL与integrity=PENDING/CONSISTENT/MISMATCH/UNSUPPORTED；不把权限过滤缺口当篡改
- scope discriminated union：TENANT事件必须完整org/workspace/store及server actor；ANONYMOUS_AUTH_SECURITY允许scope/actor显式null，仅requestId/occurredAt/result/reason/最小安全metadata，写隔离append-only sink，不制造tenant

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/audit/audit.schema.ts`
- `packages/contracts/src/audit/audit.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] 覆盖登录/登出/授权/提案/审批/拒绝/执行/验证/补偿/role/credential/export/disconnect/delete及AGENT_RUN/NOTIFICATION_INTENT/DELIVERY/READ/PREFERENCE/BRIEF事件
- [ ] 未知metadata/PII/prompt字段拒绝且query limit/date范围有上限
- [ ] TENANT scope必需；未知login主体只可ANONYMOUS_AUTH_SECURITY且不能伪造scope/actor；source time不能代security occurredAt，hash不宣称不可抵赖

**测试：**

- pnpm --filter @shopmate/contracts test -- src/audit/audit.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 基础contract phase编号不能被误读为晚期才交付

**并行分组：** `audit-1`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 审计基础先行lane：必须在P7/P8及其他mutation上线前交付，不随Phase9 UI延期。

<a id="p09-002"></a>

## P09-002：实现审计字段白名单脱敏器

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AuditRedactor / RedactionVersion

**输入：**

- P09-001各event family允许字段白名单
- actor必要内部id，值before/after仅保留审核需要的非PII字段

**输出：**

- 纯函数allowlist redactor及版本化脱敏结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit-redactor.ts`
- `apps/api/src/audit/audit-redactor.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001

**实际接线依赖：** 无

**验收：**

- [ ] token/手机号/姓名/raw prompt/嵌套secret均剔除或拒绝
- [ ] action old/new price和必要link ids保留
- [ ] 非法/超大metadata拒绝，error不回显原始payload

**测试：**

- pnpm --filter @shopmate/api test -- src/audit/audit-redactor.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 黑名单不足，必须每event family白名单

**并行分组：** `audit-2`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 审计基础先行lane：必须在P7/P8及其他mutation上线前交付，不随Phase9 UI延期。

<a id="p09-003"></a>

## P09-003：建立append-only审计表与访问权限

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P0

**契约：** AuditEntry persistence / TenantScopedAuditRole

**输入：**

- P09-001schema、现有organization/workspace/store membership/RLS机制
- 每org序列/prevHash/entryHash与request occurrence唯一约束

**输出：**

- planned audit_logs/checkpoints表、tenant RLS及受限app INSERT/SELECT权限
- 独立auth_security_events append-only sink；匿名请求身份无tenant字段假值，仅安全writer role可INSERT，不进入租户查询

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004090100_audit_append_foundation/migration.sql`
- `packages/database/test/audit-migration.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`

**硬依赖：** P09-001

**实际接线依赖：** 无

**验收：**

- [ ] migration检查app role无UPDATE/DELETE且scope FK正确
- [ ] query RLS默认拒跨org/workspace/store与未授权actor
- [ ] 序列/occurrence唯一键、hash/checkpoint版本列满足append契约
- [ ] TENANT/ANONYMOUS事件隔离CHECK/FK/role权限；tenant app SELECT无法读匿名安全事件，普通auth请求无UPDATE/DELETE

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/audit-migration.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** DDL权限验收需要隔离DB不可仅看模型

**并行分组：** `audit-3`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 审计基础先行lane：必须在P7/P8及其他mutation上线前交付，不随Phase9 UI延期。 仅提交DDL/schema与本地隔离/静态验证，不执行live migrate；共享Prisma schema由协调者merge lock处理。

<a id="p09-004"></a>

## P09-004：实现同事务审计追加写入器

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AuditAppendPort / BoundTenantTransaction

**输入：**

- P09-001事件contract、P09-002白名单、P09-003表与P09-005 canonical hash
- 现有tenant tx句柄，显式transaction参数禁止内部另开事务
- 匿名AUTH_SECURITY事件走server选择的独立auth安全sink事务/权限；tenant事件仍只接受tenant-bound tx

**输出：**

- 参数化append writer、按org串行sequence/hash及request occurrence去重
- auth安全sink append分支只存最小reason/requestId和explicit null subject，不以body可选scope改变安全域

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit-append.repository.ts`
- `apps/api/src/audit/audit-append.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001, P09-002, P09-003, P09-005

**实际接线依赖：** 无

**验收：**

- [ ] business mutation与audit任一失败时整体rollback
- [ ] 并发同org追加连续seq，无fork；不同org互不串锁
- [ ] 重复occurrence不重复写，权限丢失/非法scope拒绝；元数据脱敏
- [ ] 未知login主体记录anonymous事件不伪造org/actor；tenant query不可查询该sink且失败事件无密码/cookie/raw email

**测试：**

- pnpm --filter @shopmate/api test -- src/audit/audit-append.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 所有前置mutation运行接线需硬依赖此基础锚点

**并行分组：** `audit-4`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 审计基础先行lane：必须在P7/P8及其他mutation上线前交付，不随Phase9 UI延期。

<a id="p09-005"></a>

## P09-005：实现审计序列规范化与hash检查

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** AuditCanonicalBytes / AuditHashVerifier

**输入：**

- P09-001redacted entry字段、prevHash和version
- 无独立signer/外部immutable anchor；checkpoint来自只读port

**输出：**

- 稳定key序规范化、hash计算和gap/mismatch/unsupported结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit-hash.ts`
- `apps/api/src/audit/audit-hash.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001

**实际接线依赖：** 无

**验收：**

- [ ] 相同字段不同key顺序hash相等，改变metadata/hash则mismatch
- [ ] FULL链缺sequence/错prevHash/未知version返回可辨原因；PARTIAL授权切片只显示可见性不足，不误报篡改
- [ ] 未有external signed checkpoint只称本地完整性检查，不能verified nonrepudiation

**测试：**

- pnpm --filter @shopmate/api test -- src/audit/audit-hash.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 数据库管理员可改整条链，hash不能证明不可抵赖

**并行分组：** `audit-5`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 审计基础先行lane：必须在P7/P8及其他mutation上线前交付，不随Phase9 UI延期。

<a id="p09-006"></a>

## P09-006：实现审计游标过滤查询仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** AuditQueryPort / AuditTraceReadPort

**输入：**

- P09-001严格filter/cursor，P09-003审计模型
- 注入受限tenant DB transaction；occurredAt+sequence稳定排序

**输出：**

- 参数化分页/actor/action/resource/time/run/action/execution链查询

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit-query.repository.ts`
- `apps/api/src/audit/audit-query.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001, P09-003

**实际接线依赖：** P09-004

**验收：**

- [ ] 恶意SQLfilter只作参数且不改变query结构
- [ ] 不同scope游标拒绝；同时间多entry不跳漏/重复
- [ ] limit/date上限、未知cursor和无结果返回明确状态

**测试：**

- pnpm --filter @shopmate/api test -- src/audit/audit-query.repository.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 查询不能通过串联trace ids绕过tenant RLS

**并行分组：** `audit-6`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p09-007"></a>

## P09-007：实现默认鉴权审计查询端点

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** AuditQueryController / AuditQueryPort

**输入：**

- P09-001与现有认证及TenantScopeService.resolve（严格header/path scope），注入query port
- 审计read权限由server membership resolver判定，不接受body角色

**输出：**

- GET audit list/trace控制器及脱敏错误码

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit-query.controller.ts`
- `apps/api/src/audit/audit-query.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001

**实际接线依赖：** P09-006

**验收：**

- [ ] 无session401、缺read授权403、跨scope禁止
- [ ] 非法filter/cursor400且不调用port
- [ ] 合法分页响应strict schema；超时非empty；无raw metadata导出

**测试：**

- pnpm --filter @shopmate/api test -- src/audit/audit-query.controller.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 生产身份完善仍为既有上线门槛

**并行分组：** `audit-7`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 现有TenantContextGuard拒绝任何query/body；本端点复用TenantScopeService.resolve与server认证，不直接挂该guard。允许filter/body在controller strict schema独立校验；scope从验证header/path+server membership解析。

<a id="p09-008"></a>

## P09-008：实现审计查询前端transport

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** AuditQueryClient / AuditRouteState

**输入：**

- P09-001 schema，注入fetch；复用现有web session API错误映射
- query scope、filter和cursor strict编码

**输出：**

- 审计transport、AbortSignal、按scope隔离的分页state

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/audit/audit-api.ts`
- `apps/web/src/app/audit/audit-api.test.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001

**实际接线依赖：** 无

**验收：**

- [ ] 401/403不转换为空审计列表
- [ ] 切店后迟到分页结果被丢弃
- [ ] 非法server schema/error保留可重试code，日志不打印entry全文

**测试：**

- pnpm --filter @shopmate/web test -- src/app/audit/audit-api.test.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 缓存scope错配会泄漏敏感操作历史

**并行分组：** `audit-8`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p09-009"></a>

## P09-009：实现审计列表过滤组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** AuditListProps / AuditFilterState

**输入：**

- P09-001items及注入query/retry回调
- 复用现有dashboard range、tokens和键盘交互

**输出：**

- 审计列表、时间/action/result过滤与模块内样式

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/audit/audit-list.tsx`
- `apps/web/src/app/audit/audit-list.test.tsx`
- `apps/web/src/app/audit/audit-list.css`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001

**实际接线依赖：** 无

**验收：**

- [ ] 375px折行/分页可聚焦无横向溢出
- [ ] loading/empty/error可区分且filter范围校验
- [ ] actor/resource脱敏呈现，恶意metadata纯文本，无删除审计按钮

**测试：**

- pnpm --filter @shopmate/web test -- src/app/audit/audit-list.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 操作历史不应默认展示多余actor PII

**并行分组：** `audit-9`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p09-010"></a>

## P09-010：实现操作证据链详情组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** AuditTraceProps / AuditIntegrityPresentation

**输入：**

- P09-001 trace view与P05-001 evidence refs
- run→proposal revision→approval→execution→readback关联状态

**输出：**

- 完整链时间线、missing link提示及hash检查限界展示

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/audit/audit-trace.tsx`
- `apps/web/src/app/audit/audit-trace.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-001, P05-001

**实际接线依赖：** 无

**验收：**

- [ ] UNKNOWN verification显待核实，不因HTTP200称成功
- [ ] 缺approval/evidence link显缺失而非自动补造
- [ ] 375px/loading/empty/error和键盘证据入口可用；未独立签名不称不可抵赖
- [ ] 权限过滤的PARTIAL链不判tampered或完整一致；只显示可见片段与检查边界

**测试：**

- pnpm --filter @shopmate/web test -- src/app/audit/audit-trace.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** 审计展示不能反向授权或发起执行

**并行分组：** `audit-10`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p09-011"></a>

## P09-011：接入审计查询路由与链详情

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** AuditModule / AuditRoute runtime

**输入：**

- P09-006..010及真实append writer；现有authenticated app shell
- P05证据route已接线

**输出：**

- API query module和审计page绑定，复用现有导航

**独占文件（新路径为计划创建）：**

- `apps/api/src/audit/audit.module.ts`
- `apps/web/src/app/audit/page.tsx`
- `apps/web/src/app/audit/audit-page.test.tsx`
- `apps/api/test/audit-query.integration.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/web/src/app/dashboard-navigation.tsx`

**硬依赖：** P09-004, P09-006, P09-007, P09-008, P09-009, P09-010, P05-010, P07-019

**实际接线依赖：** 无

**验收：**

- [ ] read权限存在时可查询同scope链，缺权限无菜单/端点拒绝
- [ ] 无数据/500/partial链分别显示empty/error/missing
- [ ] 真实router不会注册测试fixture或未授权导出入口
- [ ] 实际受限query port分页/RLS及PARTIAL trace只展示已授权片段，缺link明确可见性不足

**测试：**

- pnpm --filter @shopmate/web test -- src/app/audit/audit-page.test.tsx
- pnpm --filter @shopmate/api typecheck
- pnpm --filter @shopmate/web typecheck
- pnpm --filter @shopmate/api test -- test/audit-query.integration.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不声称hash链等于独立签名或不可抵赖；不新增远端signer

**风险：** module/nav修改协调者持共享lease

**并行分组：** `audit-11`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 所有consumes中的实际runtime实现必须已合入；contract ID只锁接口，不代表实现可用，协调者需补全提供方integration卡硬依赖。

<a id="p09-012"></a>

## P09-012：验证前置动作事务审计与查询权限

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** Audit mutation coverage / Auth+Proposal+Execution trace proof

**输入：**

- P09-004/P09-011、P07-018/P07-019真实身份审计桥接、P07-014及P08-013/P08-015审批执行路径
- 每个已实现event family mutation入口owner清单，P06 run与P2 disconnect/generation gate
- P07-020 reauth同源/CSRF/per-session预算与P09-001 anonymous auth-security union

**输出：**

- 复用前置各domain失败fixture的审计查询/关联回归，聚焦chain完整性与脱敏，不重复执行整套状态机测试
- 审计event family→实际入口owner→本地测试映射coverage matrix

**独占文件（新路径为计划创建）：**

- `apps/api/test/audit-chain.integration.spec.ts`
- `docs/qa/audit-mutation-coverage.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P09-011, P06-016, P07-018, P07-019, P07-014, P08-013, P08-015, P2-GATE, P07-020

**实际接线依赖：** 无

**验收：**

- [ ] 提案/审批/拒绝/执行/readback失败fixture查询不存在孤立audit；成功链关联同revision/hash/request
- [ ] 实际login/logout/re-auth授权桥接及已实现role/credential/export/disconnect/delete入口都有domain同事务审计；尚未实现入口明确不适用
- [ ] 受限app身份禁止UPDATE/DELETE/跨scope SELECT；查询脱敏且PARTIAL授权片段不假称全链完整
- [ ] 未知login主体失败事件写隔离安全sink，tenant audit UI不曝光跨域失败尝试，不含token/密码/raw email

**测试：**

- pnpm --filter @shopmate/api test -- test/audit-chain.integration.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件
- 不重复P7/P8整套身份与执行故障测试；复用它们的receipt/audit fixture
- 不声称hash链等于独立签名或不可抵赖

**风险：** 必须等待实际domain runtime与身份桥接合入，contract anchor不能替代

**并行分组：** `audit-coverage-proof`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 仅核对前置mutation产生的audit可查询关联与脱敏；域内状态机/重启/撤销正确性复用既有P7/P8验证。
