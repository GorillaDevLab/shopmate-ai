# Phase 5 — Overview UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p05-001"></a>

## P05-001：冻结概览与证据页视图模型契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** OverviewViewModel / EvidenceDetailView / OverviewReadPort

**输入：**

- P03-001 metric quality/evidence及P04-001事件查询契约；登录scope=org/workspace/store
- 现有dashboard cards/range/navigation的呈现边界

**输出：**

- strict schema：少量KPI、重要event refs、pending proposal refs、source watermark、period/comparison和版本
- 可注入read port及加载/空/错误判别联合，CNY minor整数

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/overview/overview-view.schema.ts`
- `packages/contracts/src/overview/overview-view.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P03-001, P04-001

**实际接线依赖：** 无

**验收：**

- [ ] 未知status/无scope/非整数money被拒
- [ ] 五种quality保留并能表达null未知值
- [ ] comparison必须同窗同watermark；缺证据不显示已验证

**测试：**

- pnpm --filter @shopmate/contracts test -- src/overview/overview-view.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 早期UI契约可能误绑定尚未完成proposal数据

**并行分组：** `overview-001`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-002"></a>

## P05-002：实现概览指标与质量展示映射

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** MetricSnapshot → OverviewMetricPresentation

**输入：**

- P05-001视图契约；注入P03合成快照
- 复用现有dashboard number/date样式

**输出：**

- 纯函数minor-CNY格式、unknown/freshness/quality标签与同窗比较状态

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/overview/metric-presentation.ts`
- `apps/web/src/app/overview/metric-presentation.test.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P03-001

**验收：**

- [ ] 12345minor显示123.45元且不回写float
- [ ] 缺cost导致INSUFFICIENT，不显示0利润
- [ ] 不同window或watermark禁百分比比较

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/metric-presentation.test.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 金额与质量标签容易造成精确性误导

**并行分组：** `overview-002`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-003"></a>

## P05-003：实现重要事件概览列表组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** OverviewEventListProps / EventEvidenceLink

**输入：**

- P05-001重要事件refs及已计算priority顺序
- 复用dashboard-insight-presentation现有visual tokens

**输出：**

- 注入props的事件列表组件及模块内样式

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/overview/important-events.tsx`
- `apps/web/src/app/overview/important-events.test.tsx`
- `apps/web/src/app/overview/important-events.css`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P04-001

**验收：**

- [ ] 按effective urgency显示并区分EventSeverity与ActionRisk
- [ ] loading/empty/error可读且retry只触发注入回调
- [ ] 375px文本换行且键盘能进入证据链接

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/important-events.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** UI重排可能覆盖routing hard floor

**并行分组：** `overview-003`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-004"></a>

## P05-004：实现待决策摘要组件

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** OverviewPendingDecisionProps（只读proposal reference）

**输入：**

- P05-001 proposal ref/status/deadline脱敏摘要
- 无actor/body approval字段；点击仅导航既有审批flow

**输出：**

- 只读待决策计数/状态/详情入口，不内嵌执行按钮

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/overview/pending-decisions.tsx`
- `apps/web/src/app/overview/pending-decisions.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P07-001, P07-014

**验收：**

- [ ] 空列表显示无待处理而非0风险
- [ ] expired/unknown状态不展示已批准绿标
- [ ] 375px/loading/error/键盘入口均可用

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/pending-decisions.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** proposal摘要不得成为审批授权

**并行分组：** `overview-004`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-005"></a>

## P05-005：实现同步时间与范围条组件

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** OverviewScopeFreshnessProps

**输入：**

- P05-001 store selection、period、watermark和quality
- 复用dashboard-range日期交互

**输出：**

- 可注入店铺/日期切换的scope条及截止同步时刻提示

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/overview/scope-freshness.tsx`
- `apps/web/src/app/overview/scope-freshness.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P2-GATE

**验收：**

- [ ] 缺watermark显示尚未同步而非当前时间
- [ ] 未来/反向日期受控拒绝；切店清除旧范围状态
- [ ] 375px以及loading/empty/error各有可读标签

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/scope-freshness.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 源业务时间与真实安全时钟不得混用

**并行分组：** `overview-005`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-006"></a>

## P05-006：实现证据详情主体组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** EvidenceDetailView / EvidenceDetailProps

**输入：**

- P05-001 evidence definition/version/window/source/time/quality/facts
- 只展示授权scope可见且经过脱敏的facts

**输出：**

- 可复用证据详情panel及独立样式

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/evidence/evidence-detail.tsx`
- `apps/web/src/app/evidence/evidence-detail.test.tsx`
- `apps/web/src/app/evidence/evidence-detail.css`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P03-001

**验收：**

- [ ] 显示定义版本、window、watermark和读取时间
- [ ] STALE/ESTIMATED/INSUFFICIENT不称已验证事实
- [ ] 恶意商品文本当纯文本；375px/loading/empty/error与键盘均可操作

**测试：**

- pnpm --filter @shopmate/web test -- src/app/evidence/evidence-detail.test.tsx

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 证据摘要不能暴露订单客户PII

**并行分组：** `overview-006`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-007"></a>

## P05-007：实现证据请求去重与切店取消适配器

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** OverviewReadPort / ScopedEvidenceRequest

**输入：**

- P05-001注入transport，既有web API session错误处理
- scope和evidenceId由校验过的导航状态提供

**输出：**

- overview与evidence读取适配器、AbortSignal及旧response丢弃

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/overview/overview-transport.ts`
- `apps/web/src/app/overview/overview-transport.test.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** 无

**验收：**

- [ ] 未登录映射AUTH_REQUIRED不返回空数据
- [ ] 切店后迟到响应不能覆盖新店证据
- [ ] 500/schema非法返回可重试error且保留requestId

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/overview-transport.test.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 异步响应竞态可能泄漏跨店内容

**并行分组：** `overview-007`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-008"></a>

## P05-008：实现概览聚合读取与鉴权端点

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** OverviewReadService / OverviewReadController（MetricReadPort/EventReadPort/ProposalSummaryPort）

**输入：**

- P05-001及三个注入只读port；认证scope由服务调用context给出
- 测试fixture覆盖partial unavailable，不构造生产mock答案

**输出：**

- 授权过滤后的overview DTO及部分失败质量声明
- GET overview薄控制器：现有认证+TenantScopeService.resolve、strict允许日期/filter及同scope DTO

**独占文件（新路径为计划创建）：**

- `apps/api/src/overview/overview-read.service.ts`
- `apps/api/src/overview/overview-read.service.spec.ts`
- `apps/api/src/overview/overview-read.controller.ts`
- `apps/api/src/overview/overview-read.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P03-001, P04-001, P07-001, P2-GATE, P03-018, P04-029, P07-014

**验收：**

- [ ] 跨org/workspace/store读在调用port前拒绝
- [ ] metric服务缺数据保留UNAVAILABLE而非补零
- [ ] 同period/watermark聚合；任一port超时返回明确partial状态
- [ ] 未认证401/非法range400，不直接套拒绝所有query/body的现有TenantContextGuard

**测试：**

- pnpm --filter @shopmate/api test -- src/overview/overview-read.service.spec.ts
- pnpm --filter @shopmate/api test -- src/overview/overview-read.controller.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 聚合层不可重新计算已审定的metric公式

**并行分组：** `overview-008`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 仅聚合三个既有read port和薄controller，不实现metric/event/proposal查询或公式。

<a id="p05-009"></a>

## P05-009：实现证据只读授权端点

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** EvidenceReadController / EvidenceReadPort

**输入：**

- P05-001及现有MerchantScopeGuard/context，注入EvidenceReadPort
- evidenceId与分页/日期strict参数验证
- 查询/filter端点复用TenantScopeService.resolve；独立strict验证query，不直接挂现有TenantContextGuard

**输出：**

- GET evidence details控制器，默认鉴权且返回脱敏DTO

**独占文件（新路径为计划创建）：**

- `apps/api/src/evidence/evidence-read.controller.ts`
- `apps/api/src/evidence/evidence-read.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-001

**实际接线依赖：** P03-001, P2-GATE, P03-018

**验收：**

- [ ] 无session401；跨租户/店铺拒绝且不暴露存在性
- [ ] 非法ID/window返回400而不调用port
- [ ] 合法返回定义/period/version/source/quality；超时返回明确error

**测试：**

- pnpm --filter @shopmate/api test -- src/evidence/evidence-read.controller.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** opaque evidenceId不等于访问授权

**并行分组：** `overview-009`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-010"></a>

## P05-010：接入现有首页概览与证据路由

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** OverviewReadPort runtime binding / EvidenceRoute

**输入：**

- P05-002..009组件和控制器；P03/P04真实read implementations
- P07只读summary实现及P2源gate已合入

**输出：**

- 首页复用现有dashboard骨架，注册overview API module和evidence页面

**独占文件（新路径为计划创建）：**

- `apps/api/src/overview/overview.module.ts`
- `apps/web/src/app/overview/overview-page.tsx`
- `apps/web/src/app/evidence/[evidenceId]/page.tsx`
- `apps/web/src/app/overview/overview-page.test.tsx`

**共享文件锁（协调集成修改）：**

- `apps/web/src/app/page.tsx`
- `apps/api/src/app.module.ts`

**硬依赖：** P05-002, P05-003, P05-004, P05-005, P05-006, P05-007, P05-008, P05-009, P03-001, P04-001, P07-001, P2-GATE, P03-018, P04-029, P07-014, P07-019

**实际接线依赖：** 无

**验收：**

- [ ] 真实授权port wiring不引用测试fixture/oracle
- [ ] 首页重要事件/待决策/少量KPI可进入同scope证据
- [ ] source gate未就绪时部署disabled；三态、375px及桌面可访问

**测试：**

- pnpm --filter @shopmate/web test -- src/app/overview/overview-page.test.tsx
- pnpm --filter @shopmate/api typecheck
- pnpm --filter @shopmate/web typecheck
- pnpm --filter @shopmate/web build

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 跨团队shared page/module合并必须加锁

**并行分组：** `overview-010`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。 所有consumes中的实际runtime实现必须已合入；contract ID只锁接口，不代表实现可用，协调者需补全提供方integration卡硬依赖。

<a id="p05-011"></a>

## P05-011：验证概览证据响应式与可访问性

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** OverviewUI acceptance matrix

**输入：**

- P05-010本地路由和fixture-mode transport
- 375px/桌面、五种quality、键盘和三态测试用例

**输出：**

- 定向Playwright截图/可访问性断言与验收记录

**独占文件（新路径为计划创建）：**

- `tests/e2e/overview-evidence.spec.ts`
- `docs/qa/overview-evidence-ui.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-010

**实际接线依赖：** 无

**验收：**

- [ ] 375px无横向溢出且证据入口可聚焦
- [ ] loading/empty/error截屏对比现有tokens并检查retry
- [ ] 屏幕读出watermark/period/status；跨店后旧证据不可见

**测试：**

- pnpm exec playwright test tests/e2e/overview-evidence.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 截图证据只能证明测试viewport

**并行分组：** `overview-011`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。

<a id="p05-012"></a>

## P05-012：验证概览与源证据数值一致性

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** Overview/Evidence same snapshot trace

**输入：**

- P05-010真实read binding及受控P2 handoff local fixture
- P03 metric契约版本与P04 event evidenceHash

**输出：**

- overview API与evidence API一致性定向集成测试

**独占文件（新路径为计划创建）：**

- `apps/api/test/overview-evidence.integration.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P05-010

**实际接线依赖：** 无

**验收：**

- [ ] 同window/definition/watermark的money与证据一一对应
- [ ] 缺cost/stale样本不产生verified profit或虚假比较
- [ ] 伪造tenant和未知evidenceId不能获取他店快照

**测试：**

- pnpm --filter @shopmate/api test -- test/overview-evidence.integration.spec.ts

**不包含：**

- 不进行真实供应商/LLM/Jev网络调用、部署或live迁移
- 不改整站设计或未列出的共享文件

**风险：** 验证不能读取oracle绕过真实read路径

**并行分组：** `overview-012`

**执行边界：** 工时含实现、定向验证及PR准备；每卡独立commit/分支/PR，经review、latest CI并合入main才Done。新增路径均为planned；组件仅用测试目录合成fixture/注入port，禁止runtime读取场景oracle。函数/回调/测试体<40行、TS无any、密钥仅环境变量。
