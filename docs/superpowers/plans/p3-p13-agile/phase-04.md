# Phase 4 — Event / Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p04-001"></a>

## P04-001：定义事件、证据、基线及查询端口

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** EventEvidenceV1 / EventCandidate / BaselinePort / EventDetector / EventRepository / EventQueryPort

**输入：**

- P03-001 MetricSnapshotV1与scope、定义版本、quality/evidence语义
- H场景类型、OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED状态；Decision设计公共证据字段与允许聚合facts

**输出：**

- strict discriminated EventEvidenceV1：stockout/refund/revenue-profit/conversion/marketing/sync，以及H中inventory-stagnation/breakout/discount/cancellation所需最小聚合facts；schemaVersion=1、UTC窗口/timezone/observedAt/watermark/dataStatus/sampleSize/coverage/definitionVersion/baselineVersion/alignment
- 类型化EventCandidate与确定性severityFloor、org/workspace/store/type/entity/baselineVersion fingerprint；仓储appendEvidence/current/stateTransition、baseline、detector及cursor查询端口
- 所有rate单位/范围、安全有符号minor、nullable缺失、period/rate/分母一致性校验；version化不可变证据引用
- EventRulePolicyV1配置输入接口及detector统一detect(request): candidate+quality结果端口；type-specific leaf计算共享明确units/null/quality边界

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/events/event.schema.ts`
- `packages/contracts/src/events/event-evidence.schema.ts`
- `packages/contracts/src/events/event-ports.ts`
- `packages/contracts/src/events/event.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 未知字段、姓名/地址/订单原文/token/任意JSON被strict拒绝
- [ ] 开始结束/分母与basisPoints不一致、watermark未来时间或unsupported schema被拒绝
- [ ] 不同org/store或baselineVersion fingerprint不同；机会事件允许INFO/LOW且不是操作授权

**测试：**

- pnpm --filter @shopmate/contracts test src/events/event.schema.spec.ts
- pnpm --filter @shopmate/contracts typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** H扩展事件需要明确证据union，禁止沿用任意JSON

**并行分组：** `event-decision-001`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 shared:contracts-index协调锁；只定义baseline/query端口，不实现策略或接数据库。

<a id="p04-002"></a>

## P04-002：定义厂商无关决策、路由与记录契约

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** DecisionProvider / SanitizedDecisionInput / DecisionResult / RoutingPort / DecisionRunRepository / ShadowComparisonPort

**输入：**

- P04-001 EventEvidenceV1；EventSeverity独立于现有ActionRisk
- Decision设计的枚举、server-controlled descriptor、真实SecurityClock/deadline/AbortSignal、版本/hash关联规则

**输出：**

- readonly DecisionProvider evaluate签名及strict EVALUATED/UNAVAILABLE union；severity/notificationRoute/llmEscalation/evidenceSufficiency/attentionPriority固定域枚举与reasonCodes
- 内部EvaluationContext含scope/event/evidence/requestId，sanitize后仅opaque correlationId+白名单聚合facts；无DB/Vault/Connector/Approval/Executor authority
- provider建议/effective route/overrideReason、decision key与PRIMARY/SHADOW/fallbackOf记录、nullable typed confidence metadata、same-scope/hash比较及audit/outbox端口
- test-only离线PRIMARY/SHADOW比较夹具与same-scope/hash契约断言；SHADOW不能产effective值或产品副作用
- DecisionRulesetV1、InventoryRefundRuleEvaluator、HostEvidenceHash、DecisionHardGate与RoutingPort叶接口；只有contract schema/签名，无运行时策略实现

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/decisions/decision.schema.ts`
- `packages/contracts/src/decisions/decision-provider.ts`
- `packages/contracts/src/decisions/decision-ports.ts`
- `packages/contracts/src/decisions/decision.schema.spec.ts`
- `packages/contracts/src/decisions/decision-shadow.fixture.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P04-001

**实际接线依赖：** 无

**验收：**

- [ ] 未知结果字段/approval/execute/secret/自由指令reason被拒绝
- [ ] EventSeverity与ActionRisk分别声明，CRITICAL label不会满足任何审批权限类型
- [ ] 未定义vendor confidence概率；unknown semantics metadata只能null；SHADOW结果无effective authority
- [ ] 离线fake SHADOW高严重度只供同hash差异记录；PRIMARY路由/预算/approval权限完全不变

**测试：**

- pnpm --filter @shopmate/contracts test src/decisions/decision.schema.spec.ts
- pnpm --filter @shopmate/contracts typecheck
- pnpm --filter @shopmate/contracts test src/decisions/decision-shadow.fixture.spec.ts

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 厂商未核验协议不能污染领域枚举与confidence语义

**并行分组：** `event-decision-002`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 shared:contracts-index协调锁。仅offline fake provider与shadow端口，不增加JevSDK/endpoint/env key。 shadow本轮仅契约与test-only fixture，不增加生产shadow runner。

<a id="p04-003"></a>

## P04-003：实现同星期同小时稳健基线

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** BaselinePort / RobustBaselineV1

**输入：**

- P04-001基线请求含当前截止/定义版本/基线版本；P03窗口端口合同
- 已观测历史MetricSnapshotV1序列；仅同星期同小时可比窗口

**输出：**

- median/稳健离差(MAD)基线及aligned/sampleSize/coverage/可用性
- 版本化候选选择与当前baseline证据引用；零基线与低量保留独立状态

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/robust-baseline.ts`
- `apps/api/src/events/robust-baseline.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-004, P03-015

**验收：**

- [ ] 当前14时只采历史同weekday同14时观测窗口，完整昨天被排除
- [ ] 单个异常历史点不把median基线扭曲为异常均值
- [ ] 历史不足/定义错版/陈旧或零基线返回不足或nullable倍数，禁止强填正常

**测试：**

- pnpm --filter @shopmate/api test src/events/robust-baseline.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 候选历史窗口错配比检测阈值更易制造假阳性

**并行分组：** `event-decision-003`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-004"></a>

## P04-004：注册版本化事件与Rules阈值配置

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** EventRulePolicyV1 / DecisionRulesetV1

**输入：**

- P04-001/002域类型；H最小样本、baseline/coverage/freshness与可解释阈值要求
- 产品已给stockout<6h、inventory>90days、refund≥2倍、conversion35%案例；其余默认阈值明确产品策略标签

**输出：**

- strict server-owned不可变配置注册表，baselineVersion/rulesetVersion/每事件样本与coverage/freshness/容忍带
- 同阈值计算规则与配置版本传递，不从merchant自由JSON或Provider descriptor扩权

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/event-rule-policy.ts`
- `apps/api/src/decisions/decision-ruleset.ts`
- `apps/api/src/events/event-rule-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001, P04-002

**实际接线依赖：** 无

**验收：**

- [ ] 负freshness/coverage>10000/空version或未知配置字段拒绝
- [ ] 6h/90days/2倍的包含边界显式且同版本读取一致
- [ ] 配置更新生成新version，旧证据/decision可继续引用原版本

**测试：**

- pnpm --filter @shopmate/api test src/events/event-rule-policy.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 阈值是产品规则，不是统计置信度或厂商confidence

**并行分组：** `event-decision-004`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 本卡仅配置叶模块；共享默认registry由各模块构造注入，禁止散落硬编码。

<a id="p04-005"></a>

## P04-005：实现临近售罄与供应延期检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** StockoutDetector

**输入：**

- EventDetector/MetricSnapshotV1/typed stockout evidence契约，fresh available/sales velocity/leadTime/inboundETA
- 同P04-004配置接口；本卡fixture只含可观测库存和供应事实

**输出：**

- STOCKOUT_RISK候选与available/salesWindow/hoursRemaining/leadTime/ETA/freshness证据
- 独立可靠售罄事实与依赖forecast的风险分开；supplier delay只作为观测线索

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/stockout.detector.ts`
- `apps/api/src/events/detectors/stockout.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-009, P04-004

**验收：**

- [ ] 库存覆盖4小时产生候选，充足库存SKU无候选
- [ ] ETA晚于库存覆盖可检测供应延期；采购提案不增加库存
- [ ] stale库存/零销量/缺leadTime抑制相应预测；确定已售罄可保留事实

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/stockout.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** supplier真实延误信息不得由scenario隐藏真因直接注入

**并行分组：** `event-decision-005`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-006"></a>

## P04-006：实现滞销库存检测与新品排除

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** InventoryStagnationDetector

**输入：**

- EventDetector/库存覆盖与上市可见时间/库存持有日/成本占用聚合契约
- 版本化>90日需求与最小销量样本策略

**输出：**

- INVENTORY_STAGNATION候选及库存/销量窗口/持有日/成本coverage证据
- 新上市或低量不足状态，不强行归入滞销

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/inventory-stagnation.detector.ts`
- `apps/api/src/events/detectors/inventory-stagnation.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-009, P04-004

**验收：**

- [ ] 成熟SKU库存超过90日有效需求产生候选，恰90日边界按策略排除
- [ ] 刚上市只有1单的SKU报告不足且无滞销候选
- [ ] 零销量或缺成本不除零/推精确成本占用；陈旧库存不得确定性报警

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/inventory-stagnation.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 历史长度与新品身份必须有来源，不能从低销量反推

**并行分组：** `event-decision-006`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-007"></a>

## P04-007：实现cohort退款集中检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** RefundSpikeDetector

**输入：**

- EventDetector/RefundMetricCalculator与BaselinePort输出；可观测SKU聚合reason enum计数
- 版本化cohort成熟度/样本阈值及同定义退款率；隐藏batch真因不在输入

**输出：**

- REFUND_SPIKE候选与paidCohortOrders/refundedOrders/current/baseline bp、SKU集中度及允许原因计数
- baseline0单独标新出现数量证据，来源冲突/低样本保留不足状态

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/refund-spike.detector.ts`
- `apps/api/src/events/detectors/refund-spike.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-006, P04-003, P04-004

**验收：**

- [ ] 充分样本3倍退款基线生成候选，Day3观测前不泄露未来Day5异常
- [ ] SKU集中与全店共同上升证据不同，不声称已知道坏批次
- [ ] baseline0不产生Infinity倍数；未成熟/低量/缺原因不捏造因果

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/refund-spike.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 检测证据足够不等于能够确认商品批次因果

**并行分组：** `event-decision-007`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-008"></a>

## P04-008：实现取消订单骤增检测

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** CancelledOrderSpikeDetector

**输入：**

- EventDetector/可见order payment state、取消时间及允许取消原因聚合；同窗订单基线
- P04-004 cancellation样本/相对与绝对阈值合同

**输出：**

- CANCELLED_ORDER_SPIKE候选、paid与pending取消数量分列、baseline和样本证据
- 取消率只在指定可比订单cohort内计算，不并入已结算退款

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/cancelled-order-spike.detector.ts`
- `apps/api/src/events/detectors/cancelled-order-spike.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P04-003, P04-004

**验收：**

- [ ] 充分样本取消骤增生成候选并保留付款状态分解
- [ ] PENDING取消增加取消计数但不增加paid退款或降低已付营收
- [ ] 低量/零分母/取消时间未知只给不足状态，不生成高置信异常

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/cancelled-order-spike.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 订单状态取消不一定代表发生实收退款

**并行分组：** `event-decision-008`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-009"></a>

## P04-009：实现利润率下降及贡献证据检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProfitMarginDropDetector

**输入：**

- EventDetector/同窗paid/net/grossProfit/contribution及ProfitDeltaAttributionV1证据
- BaselinePort可比baseline、成本/费用coverage与版本化阈值

**输出：**

- PROFIT_MARGIN_DROP候选与确定性discount/spend/SKU-mix delta贡献引用
- 营收上升但利润下降的可解释证据，任何因果描述仅采用已计算聚合贡献

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/profit-margin-drop.detector.ts`
- `apps/api/src/events/detectors/profit-margin-drop.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-011, P04-003, P04-004

**验收：**

- [ ] 同窗收入升/利润降充分输入生成候选且贡献之和可复算
- [ ] 缺COGS/广告归因无法判断时保留ESTIMATED/不足，不宣称精确毛利恶化
- [ ] 跨definitionVersion或partial/full-day错配不产生确定性异常

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/profit-margin-drop.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 利润质量不能因收入证据完整而被升级为VERIFIED

**并行分组：** `event-decision-009`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-010"></a>

## P04-010：实现异常折扣检测与只扣一次证明

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** UnusualDiscountDetector

**输入：**

- EventDetector/折扣前paid商品原价、折扣minor及有效促销窗口/同窗baseline
- P04-004 discount thresholds与P03-001收入口径

**输出：**

- UNUSUAL_DISCOUNT候选和discountBp/current/baseline/毛利质量证据
- 折扣对收入的影响只引用P3结果，不重新扣利润

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/unusual-discount.detector.ts`
- `apps/api/src/events/detectors/unusual-discount.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-005, P03-008, P04-003, P04-004

**验收：**

- [ ] 大折扣达到策略阈值生成候选，折扣金额证据等于源聚合
- [ ] 同一订单收入已扣折扣，检测不会再减一次contribution
- [ ] 0原价/缺促销生效窗口/低样本抑制明确异常断言

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/unusual-discount.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 检测解释不得重新定义折扣会计方向

**并行分组：** `event-decision-010`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-011"></a>

## P04-011：实现ROAS下降与广告花费突增检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MarketingDetector

**输入：**

- EventDetector/同窗spend、attributedRevenue/impressions/clicks/orders/attributionCoverage
- BaselinePort和P04-004营销策略；缺归因typed状态

**输出：**

- campaign作用域ROAS_DROP/AD_SPEND_SPIKE候选与共享营销证据
- ROAS判断与确定已花费事实按依赖独立门禁，结果不包含关广告指令

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/marketing.detector.ts`
- `apps/api/src/events/detectors/marketing.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-010, P04-003, P04-004

**验收：**

- [ ] spend升且归因收入降可输出两个有证据候选，不重复计算费用
- [ ] 缺归因抑制确定ROAS下降，但可靠spend突增可单独保留
- [ ] 零spend无Infinity；跨窗口/陈旧归因不生成明确经营断言

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/marketing.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 归因覆盖不足不能被LLM补成实际广告效果

**并行分组：** `event-decision-011`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-012"></a>

## P04-012：实现涨价后的转换下降线索检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ConversionDropDetector

**输入：**

- EventDetector/同窗visitors/cart/checkout/paidOrders、price effectiveAt/changeBp、variantAvailability
- 可比BaselinePort及最小流量/样本阈值；价格生效前后可见数据

**输出：**

- CONVERSION_DROP候选、35%相对下降证据与价格时序关联
- 明确correlation only标记，缺漏斗/不可售variant影响作为独立证据限制

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/conversion-drop.detector.ts`
- `apps/api/src/events/detectors/conversion-drop.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-010, P04-003, P04-004

**验收：**

- [ ] 流量稳定且涨价后conversion相对降35%的充分例生成候选
- [ ] 涨价前时间窗口不声称价格已影响转换
- [ ] 缺visitors/0分母/低量或时序不符不报告价格因果

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/conversion-drop.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 时间关联不得包装成随机实验因果

**并行分组：** `event-decision-012`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-013"></a>

## P04-013：实现新品爆款机会检测

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProductBreakoutDetector

**输入：**

- EventDetector/sku销售速度、conversion、margin quality与可见新品上市时刻
- 版本化机会最小样本/增长门槛合同；不足baseline有明确处理

**输出：**

- PRODUCT_BREAKOUT低严重度机会候选及样本/速度/转换/毛利证据
- 机会与危险异常分开，不直接创建提案或授执行权

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/product-breakout.detector.ts`
- `apps/api/src/events/detectors/product-breakout.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-009, P03-010, P04-003, P04-004

**验收：**

- [ ] 达到样本/增长/有效质量门槛的新品产生LOW/INFO机会
- [ ] 只有1至2单的新店不宣称爆款
- [ ] 缺成本披露margin不足，机会候选不能产生CRITICAL或执行授权

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/product-breakout.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 机会阈值不能用测试答案或少量随机订单制造爆款

**并行分组：** `event-decision-013`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-014"></a>

## P04-014：实现同步故障与经营断言抑制

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** SyncQualityDetector

**输入：**

- EventDetector/同步lastSuccessAt/lagSeconds/typedErrorCode/affectedResource/sourceWatermark端口
- MetricSnapshot质量及观察截止，错误字段必须枚举并脱敏

**输出：**

- SYNC_FAILURE候选与数据质量阻断集合；缺基线/低量的INSUFFICIENT_EVIDENCE结果状态
- 只抑制依赖坏来源的经营结论，保留独立可靠库存事实

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/sync-quality.detector.ts`
- `apps/api/src/events/detectors/sync-quality.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P2-GATE, P03-012, P04-004

**验收：**

- [ ] 同步中断产生SYNC_FAILURE，陈旧sales不会产生REVENUE_DROP
- [ ] raw exception/token不进入证据或HTTP错误
- [ ] 低量无baseline返回INSUFFICIENT_EVIDENCE；不隐藏独立确定已售罄事实

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/sync-quality.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** sync错误与营业额下降必须分别建模

**并行分组：** `event-decision-014`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-015"></a>

## P04-015：实现可注入事件评估编排

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** EventEvaluationService / EventDetectorRegistry

**输入：**

- P04-001 MetricReadPort/BaselinePort/EventDetector/EventRepository端口；readonly当前TenantContext
- 固定当前metric revision/watermark、detector whitelist与quality阻断集合；端口fixtures

**输出：**

- 同一可见证据快照多detector评估、candidate strict验证与稳定fingerprint
- 候选排序稳定、无候选也保留质量评估；不读取scenario manifests/expected字段

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/event-evaluation.service.ts`
- `apps/api/src/events/event-evaluation.service.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-018, P04-003, P04-004, P04-005, P04-006, P04-007, P04-008, P04-009, P04-010, P04-011, P04-012, P04-013, P04-014, P04-017, P04-028

**验收：**

- [ ] 一个低库存+利润下降输入产生两个候选且共用确定版本证据
- [ ] 缺/stale输入只抑制依赖的规则，不能静默返回正常
- [ ] 改变测试expectedEvents不改变运行时输出；readonly input保持不变

**测试：**

- pnpm --filter @shopmate/api test src/events/event-evaluation.service.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 组件注册允许fixture并行，但真实detector/repo接线必须后续门禁

**并行分组：** `event-decision-015`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-016"></a>

## P04-016：增加事件与不可变证据存储约束

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** EventRow / EventEvidenceRow / active fingerprint uniqueness

**输入：**

- P04-001事件/证据字段，P03-014 metricSnapshot FK与现有tenant/store复合ownership/RLS
- 活动状态OPEN/ACKNOWLEDGED/SUPPRESSED及RESOLVED历史保留；证据schema/definition/baseline/hash版本

**输出：**

- 拟新增events/event_evidence迁移，活动fingerprint partial unique与evidenceRevision/event唯一
- 跨scope metric/evidence关联FK拒绝、历史证据append-only与默认deny RLS/受限角色授权
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/event-storage.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004100000_events_evidence/migration.sql`
- `packages/database/test/integration/event-storage.test.mjs`
- `docs/architecture/p04-event-storage.md`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `scripts/test-tenant-database.mjs`

**硬依赖：** P04-001, P03-014

**实际接线依赖：** 无

**验收：**

- [ ] 两个并发同fingerprint活动事件最多1条；RESOLVED后允许新发生事件
- [ ] 跨org/store metricSnapshot关联及缺scope读写被DB拒绝
- [ ] evidence revision可追加但禁止UPDATE/DELETE旧版本；全新/升级库迁移可验证
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/database prisma:validate
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 活动唯一键必须数据库partial unique，不能只靠find-then-create

**并行分组：** `event-decision-016`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 shared:prisma与shared:tenant-runner协调锁；仅本地isolatedPostgres迁移验证。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p04-017"></a>

## P04-017：实现事件去重与证据追加仓储

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P0

**契约：** EventRepository

**输入：**

- P04-001 scoped candidate/fingerprint/expectedRevision端口；P04-016生成event/evidence表
- 同fingerprint稳定锁键、metric/evidence version/hash引用；参数化事务client

**输出：**

- 同活动fingerprint更新lastSeen并追加新证据revision，同hash复用证据
- 按scope读取current/history、CAS状态更新与稳定cursor；RESOLVED后再发生创建新event

**独占文件（新路径为计划创建）：**

- `packages/database/src/event.repository.ts`
- `packages/database/test/event-repository.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P04-001, P04-016

**实际接线依赖：** 无

**验收：**

- [ ] 每15分钟相同观察只保留1活动事件/同hash证据，lastSeen推进
- [ ] 新sourceRevision保留旧证据且生成新revision；旧revision不能覆盖新记录
- [ ] 跨scope关联拒绝，同expectedRevision并发状态更新最多一个成功

**测试：**

- pnpm --filter @shopmate/database test（目标test/event-repository.test.mjs）
- pnpm --filter @shopmate/database typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 事件更新不能让证据历史变成可覆盖JSON

**并行分组：** `event-decision-017`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 使用client合同fixture完成仓储单元；实际并发与RLS由P04-030证明，shared:database-index协调锁。

<a id="p04-018"></a>

## P04-018：实现事件状态变更与即时审计组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** EventLifecycleService / EventMutationPort / AuditAppendPort

**输入：**

- P04-001状态transition/CAS端口与P09-001事务审计契约；真实认证TenantContext
- 当前membership及服务端OWNER/ADMIN/OPERATOR事件管理角色规则；不新增平台执行权限

**输出：**

- acknowledge/resolve/suppress组件，body strict+expectedRevision及必需typed reason
- 事件state更新和audit append在同unit-of-work；viewer/analyst只读，审计失败回滚

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/event-lifecycle.service.ts`
- `apps/api/src/events/event-lifecycle.controller.ts`
- `apps/api/src/events/event-lifecycle.service.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001, P09-001

**实际接线依赖：** P04-017, P09-004

**验收：**

- [ ] 允许角色可按当前revision完成合法状态transition并留下actor/request/evidence引用审计
- [ ] 未认证/只读role/跨store/成员撤销拒绝；非法状态及旧revision409
- [ ] audit fixture抛错导致状态不提交；SUPPRESSED不删除事件或隐去SYNC_FAILURE

**测试：**

- pnpm --filter @shopmate/api test src/events/event-lifecycle.service.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 必要审计要在本次状态事务内，不能等Phase9 UI补写

**并行分组：** `event-decision-018`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 此卡用repository/unit-of-work/audit fixture；真正controller注册和事务writer接线由P04-029完成。 POST沿用AuthGuard+TenantScopeService.resolve与strict header/path scope，再独立strict body校验；当前TenantContextGuard拒绝body，不能直接复用。

<a id="p04-019"></a>

## P04-019：实现授权事件与证据查询组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** EventQueryPort / GET store events/evidence

**输入：**

- P04-001 scoped EventQueryPort；P04-002 decision suggested/effective read model
- 现有AuthGuard+TenantScopeService.resolve、strict header/path scope及独立filters校验、store ownership，允许的type/state/cursor/limit白名单

**输出：**

- EventsController/query service：事件列表、详情、历史证据和版本化decision summaries
- 稳定分页及空/不可用/错误响应；不因severity扩大读权限

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/events.controller.ts`
- `apps/api/src/events/event-query.service.ts`
- `apps/api/src/events/events.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001, P04-002

**实际接线依赖：** P04-017, P04-027

**验收：**

- [ ] 未登录401、跨租户/店铺404、缺业务证据读permission403
- [ ] 合法空列表显式empty；同步失败事件仍可见，不因IGNORE隐藏
- [ ] 非法cursor/type/limit或未知query400，源证据和decision旧版本均可按id查看

**测试：**

- pnpm --filter @shopmate/api test src/events/events.controller.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 读模型不能把provider labels直接覆写Event原始事实

**并行分组：** `event-decision-019`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 fixture可并行；消费的read model仅聚合本store证据，真实仓储注册由P04-029完成。 当前TenantContextGuard拒绝query/body，filtered GET不用该guard；不得为接受filters放宽tenant scope解析。

<a id="p04-020"></a>

## P04-020：实现库存与退款Rules候选判断

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** InventoryRefundRuleEvaluator

**输入：**

- P04-002 SanitizedDecisionInput与P04-004 DecisionRulesetV1端口
- P04-001结构化stockout/refund evidence；只读聚合数值，无source/scenario oracle

**输出：**

- 纯stockout/refund candidate labels及固定reason codes；不执行/通知/访问DB
- <6h imminent、<leadTime至少HIGH、样本充分refund≥2倍规则；基线0与独立已售罄分支

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/inventory-refund-rules.ts`
- `apps/api/src/decisions/inventory-refund-rules.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-002

**实际接线依赖：** P04-004

**验收：**

- [ ] 5.99h给CRITICAL/NOTIFY_NOW/URGENT，exactly6h不触发该条，但可按交期触发HIGH
- [ ] current=2倍baseline且样本充分触发HIGH；baseline0走绝对计数分支而非倍数
- [ ] 低量退款不请求深推理；fresh已售罄不因预测样本不足被丢弃

**测试：**

- pnpm --filter @shopmate/api test src/decisions/inventory-refund-rules.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 6小时边界、zero baseline与事实售罄必须显式区分

**并行分组：** `event-decision-020`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-021"></a>

## P04-021：组装确定性RulesProvider与证据门槛

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** RulesDecisionProvider

**输入：**

- P04-002 DecisionProvider签名/descriptor/结果枚举与evidenceHash端口；P04-020候选计算端口
- P04-004版本化每event默认标签与quality/baseline规则，P04-001只读证据

**输出：**

- 无网络RulesDecisionProvider：整包severity/route/llm/sufficiency/priority/reasons/policyVersion
- 统一insufficient/stale/ambiguous/normalSeasonality/noMaterialChange gate；充分复合利润才建议DEEP，其他解释复用版本化类型策略

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/rules-decision.provider.ts`
- `apps/api/src/decisions/rules-evidence-gate.ts`
- `apps/api/src/decisions/rules-decision.provider.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-002

**实际接线依赖：** P04-004, P04-020, P04-022

**验收：**

- [ ] 同输入/版本给同decision bundle且不修改readonly输入
- [ ] stale营收与正常weekday/hour波动不无依据升级；低量=>INSUFFICIENT_DATA/NO_LLM_NEEDED，冲突=>AMBIGUOUS
- [ ] 充分复合利润可请求DEEP；缺成本/低样本不能用LLM填事实；机会标签INFO/LOW不授执行权

**测试：**

- pnpm --filter @shopmate/api test src/decisions/rules-decision.provider.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 质量优先规则仍要保留独立可靠售罄事实

**并行分组：** `event-decision-021`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 fixture注入special-rule和hasher端口；本卡不接真实DB/notify/Agent。各event缺省映射为受控config，不写自然语言prompt。

<a id="p04-022"></a>

## P04-022：净化决策输入并严格关联输出

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** DecisionInputSanitizer / DecisionResultValidator / HostEvidenceHash

**输入：**

- P04-001内部scope/event/evidence与P04-002 sanitized provider/结果契约
- 内部服务器受控descriptor与schema version白名单；固定canonical事实序列化

**输出：**

- 只发送opaque correlationId和必要白名单聚合facts的readonly结构，内部ID/原始文本不入payload
- 输出strict Zod及enum/reason/绑定evidenceHash/policyVersion一致性验证；未知/非法结果转换INVALID_RESULT

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/decision-input-sanitizer.ts`
- `apps/api/src/decisions/decision-result-validator.ts`
- `apps/api/src/decisions/decision-boundary.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001, P04-002

**实际接线依赖：** 无

**验收：**

- [ ] 恶意订单/退款文本、credential、tenantId扩展字段不能出现在sanitized payload
- [ ] 额外approval字段/未知reason/错hash/错version/超rate bounds被拒绝
- [ ] 相同事实序列产生稳定hash；schema不支持=>UNSUPPORTED_SCHEMA且不调用provider

**测试：**

- pnpm --filter @shopmate/api test src/decisions/decision-boundary.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** strict类型校验之外仍需校验结果确实绑定本次输入

**并行分组：** `event-decision-022`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-023"></a>

## P04-023：实现决策硬门禁与override记录

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** DecisionHardGate

**输入：**

- P04-002 validated labels、EvaluationContext与P04-001确定性severityFloor/quality facts
- 服务端current scope/authorization与最小样本/freshness/baseline门禁；纯read-only控制结果

**输出：**

- effective severity保持deterministic floor、LLM不足/预算前置block与typed overrideReason
- 安全scope冲突受控拒绝；Decision signal没有批准/执行/凭证能力

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/decision-hard-gate.ts`
- `apps/api/src/decisions/decision-hard-gate.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-002

**实际接线依赖：** P04-004

**验收：**

- [ ] 恶意LOW标签不能降确定性HIGH/CRITICAL floor，记录明确overrideReason
- [ ] DEEP标签遇缺样本/陈旧/冲突数据被阻断；scope不符拒绝全部effective routes
- [ ] CRITICAL event label不能满足actions:approve或price-risk豁免；门禁不调用executor

**测试：**

- pnpm --filter @shopmate/api test src/decisions/decision-hard-gate.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主
- 不实现Phase7 RiskEngine/人工审批或Phase8动作执行

**风险：** EventSeverity floor与ActionRisk必须保持独立

**并行分组：** `event-decision-023`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-024"></a>

## P04-024：实现通知与LLM最终路由组件

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** RoutingPort / EffectiveRouteIntent

**输入：**

- P04-002 suggested labels与P04-023 hard-gate结果合同；nullable server-loaded user prefs/quiet hours/cooldown/budget
- 稳定decision key/evidence hash、上次route证据与版本化升级/恢复break-cooldown规则；端口fixture

**输出：**

- effective notification/attention/LLM route、overrideReason及delivery intent；IGNORE保留事件与decision
- quiet-hour/preferences/预算限制和批量聚合上限；ESCALATE只生成应用内人工待办意图

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/decision-routing.service.ts`
- `apps/api/src/decisions/decision-routing.service.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-002

**实际接线依赖：** P04-004, P04-023

**验收：**

- [ ] 重复decision key与未变严重度在cooldown内不重复NOTIFY/DEEP
- [ ] 严重度升级/恢复可按固定规则打破cooldown；同store多事件遵守batch上限
- [ ] quiet hour/偏好/预算不足有effective overrideReason，IGNORE不删SYNC_FAILURE，ESCALATE不发送外部联系人

**测试：**

- pnpm --filter @shopmate/api test src/decisions/decision-routing.service.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 路由只产intent；实际发送必须Phase10事务outbox接线

**并行分组：** `event-decision-024`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 组件采用本卡本地typed prefs/history/budget fixture；不消费通知provider，不产生LLM费用。

<a id="p04-025"></a>

## P04-025：实现截止取消与Rules fallback宿主

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** DecisionEvaluationHost / DecisionControl / FallbackRunLink

**输入：**

- P04-002受控provider registry/decision记录端口及SecurityClock；P04-022 strict boundary、P04-021 Rules端口合同
- 只注入offline fake provider与Rules；真实deadline/AbortSignal，不用mock BusinessClock决定安全超时

**输出：**

- 输入→provider→strict validation→HardGate/route的可注入宿主；TIMEOUT/FAILURE/INVALID_RESULT/UNSUPPORTED回退Rules
- 失败run与fallbackOf关联、稳定decision key与迟到结果作废；Rules亦不可用时返回受控需人工检查

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/decision-evaluation.host.ts`
- `apps/api/src/decisions/decision-evaluation.host.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-002

**实际接线依赖：** P04-021, P04-022, P04-023, P04-024, P04-027

**验收：**

- [ ] fake timeout/throw/illegal output分别保存失败run并关联Rules fallback
- [ ] primary迟到结果不能覆盖已提交fallback或再次触发route
- [ ] Rules也失败返回UNAVAILABLE人工检查，不伪造正常；BusinessClock快进不能绕真实deadline
- [ ] server registry拒绝SHADOW provider获得PRIMARY authority；离线shadow fixture不改变effective route/LLM预算或审批

**测试：**

- pnpm --filter @shopmate/api test src/decisions/decision-evaluation.host.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** abort只是取消信号，必须再以稳定commit token拒绝迟到结果

**并行分组：** `event-decision-025`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 各端口用隔离fixture验证，可先于真实组件；宿主默认Rules PRIMARY，无任何厂商网络provider注册。

<a id="p04-026"></a>

## P04-026：增加版本化决策记录与比较存储约束

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** DecisionRunRow / DecisionRecordRow / DecisionComparisonRow

**输入：**

- P04-002 PRIMARY/SHADOW/result/fallback/effective字段、nullable typed confidence元数据
- P04-016 scoped Event/evidence FK；run/type唯一、provider/ruleset/evidence版本、稳定decision key

**输出：**

- 拟新增decision_runs/records/comparisons迁移与RLS，fallbackOf/primary/shadow复合scope FK
- 同run/decisionType唯一、普通用户不可改历史结果，same-scope/hash比较校验约束与claim/commit幂等键
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/decision-storage.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004110000_decision_records/migration.sql`
- `packages/database/test/integration/decision-storage.test.mjs`
- `docs/architecture/p04-decision-storage.md`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `scripts/test-tenant-database.mjs`

**硬依赖：** P04-002, P04-016

**实际接线依赖：** 无

**验收：**

- [ ] 同run/type重复拒绝，跨tenant fallbackOf或comparison关联拒绝
- [ ] 不同evidenceHash不能建立comparison；PRIMARY/SHADOW字段保持区分
- [ ] 未认证scope读写默认deny，旧记录UPDATE/DELETE拒绝；未知confidence语义不得伪存概率
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/database prisma:validate
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 比较复合约束与同hash校验必须可执行，不能仅表说明

**并行分组：** `event-decision-026`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 shared:prisma、shared:tenant-runner协调锁；迁移仅本地隔离库验证，不新增供应商payload表。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p04-027"></a>

## P04-027：实现决策记录、幂等claim与查询仓储

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P0

**契约：** DecisionRunRepository / DecisionReadPort

**输入：**

- P04-002 record append/claim/read端口与P04-026生成表；scope/event/evidenceHash/version绑定
- 同unit-of-work事务client与稳定decision key；fallback run链和immutable results

**输出：**

- 参数化claim/append/result/effective/readhistory仓储；重复key复用已提交结果
- 保存provider/version/ruleset/mode/status/latency/fallbackOf及typed override/confidence，不存raw vendor payload

**独占文件（新路径为计划创建）：**

- `packages/database/src/decision-run.repository.ts`
- `packages/database/test/decision-run.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P04-002, P04-026

**实际接线依赖：** 无

**验收：**

- [ ] 同decision key再次claim返回已有结果，不能重复创建有效route记录
- [ ] 保存primary failure+fallbackOf链，当前evidenceHash必须与event evidence匹配
- [ ] 跨scope read/fallback拒绝；SHADOW只写比较数据不能写effective字段

**测试：**

- pnpm --filter @shopmate/database test（目标test/decision-run.test.mjs）
- pnpm --filter @shopmate/database typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 幂等claim必须数据库原子键，不能仅进程内Map

**并行分组：** `event-decision-027`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 本卡client fixture验证typed repo行为；真实跨连接幂等证明由P04-030，shared:database-index协调锁。

<a id="p04-028"></a>

## P04-028：实现可比营收下降的正负控制检测

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** RevenueDropDetector

**输入：**

- P04-001 EventDetector/同definitionVersion同截止paid/net revenue及BaselinePort输出
- 当前与同weekday/hour历史窗口、版本化最小样本/freshness/容忍带；不以昨天整日比较半日

**输出：**

- REVENUE_DROP候选与current/baseline/signed delta/threshold/sample/版本证据
- 正常季节性负例、陈旧/缺基线数据抑制，真实同窗material下降正例

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/detectors/revenue-drop.detector.ts`
- `apps/api/src/events/detectors/revenue-drop.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P04-001

**实际接线依赖：** P03-005, P03-006, P04-003, P04-004

**验收：**

- [ ] 充分样本同weekday/hour营收真实跌破策略带产生REVENUE_DROP正例，不能以永不报警通过负例
- [ ] 比昨天低但同星期/同小时正常不生成下降候选
- [ ] STALE/UNAVAILABLE/低量/旧定义基线抑制确定性下降，保留数据质量原因

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/revenue-drop.detector.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 季节性负例必须同时配真实下降正例，避免无检测能力的假通过

**并行分组：** `event-decision-028`

**执行边界：** 新路径均为拟新增；消费baseline/config/metric端口的最小test-only fixture，可并行开发。工时包含实现、聚焦验证及PR准备；函数/测试回调<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p04-029"></a>

## P04-029：接线指标、事件、决策与事务审计路由

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** EventsModule / DecisionsModule / EventDecisionUnitOfWork

**输入：**

- P03-018真实授权指标源；P04-003..025 detector/host/rules/gate/routing/controller与P04-017/027仓储
- P09-004同事务audit append、P10-003同事务enqueue；P2-GATE真实可见source/watermark；无厂商网络provider

**输出：**

- 模块注册与真实依赖注入，Metric→Event→Rules PRIMARY→validated effective route→持久决策链
- 一个事务commit events/evidence/decision records/audit/notification delivery intent；当前membership重新校验，失败整体rollback
- 受保护查询/状态controller可调用，默认Rule注册表不含Jev/LLM；历史证据与决策可查询
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/event-decisions.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/events.module.ts`
- `apps/api/src/decisions/decisions.module.ts`
- `apps/api/src/events/event-decision-unit-of-work.ts`
- `apps/api/test/event-decisions.e2e-spec.ts`
- `apps/api/src/decisions/decision-runtime-history.ts`
- `apps/api/src/decisions/decision-runtime-host.ts`
- `apps/api/src/decisions/decision-runtime-policy.ts`
- `apps/api/src/events/event-decision-runtime.service.ts`
- `apps/api/src/events/event-decision-transaction.spec.ts`
- `apps/api/src/events/event-decision-transaction.ts`
- `apps/api/src/events/event-lifecycle-runtime.ts`
- `apps/api/src/events/event-runtime-authority.ts`
- `apps/api/src/events/event-runtime-effects.ts`
- `apps/api/src/events/event-runtime-persistence.ts`
- `apps/api/src/events/event-runtime-registry.spec.ts`
- `apps/api/src/events/event-runtime-registry.ts`
- `apps/api/src/events/event-runtime-source.ts`
- `apps/api/src/events/event-runtime.environment.spec.ts`
- `apps/api/src/events/event-runtime.environment.ts`
- `apps/api/src/events/event-transaction-lifetime.spec.ts`
- `apps/api/src/events/event-transaction-lifetime.ts`
- `packages/database/src/event-decision-pool.ts`
- `packages/database/test/helpers/event-decisions-api-fixture.d.mts`
- `packages/database/test/helpers/event-decisions-api-fixture.mjs`
- `apps/api/src/events/event-runtime-pool.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/api/vitest.tenant.config.ts`
- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.config.ts`
- `packages/database/src/decision-run.repository.ts`
- `packages/database/src/index.ts`
- `apps/api/src/decisions/decision-evaluation.host.ts`
- `apps/api/src/decisions/decision-evaluation.host.spec.ts`
- `packages/database/test/integration/decision-storage.test.mjs`
- `packages/database/test/helpers/tenant-api-fixture.mjs`
- `packages/database/test/helpers/tenant-api-fixture.d.mts`
- `apps/api/src/decisions/decision-hard-gate.ts`
- `apps/api/src/decisions/decision-hard-gate.spec.ts`

**硬依赖：** P2-GATE, P03-018, P04-003, P04-004, P04-005, P04-006, P04-007, P04-008, P04-009, P04-010, P04-011, P04-012, P04-013, P04-014, P04-015, P04-016, P04-017, P04-018, P04-019, P04-020, P04-021, P04-022, P04-023, P04-024, P04-025, P04-026, P04-027, P09-004, P10-003, P04-028

**实际接线依赖：** 无

**验收：**

- [ ] 真实同scope快照触发event+Rules+effective route，查询保留所有版本与overrideReason
- [ ] audit/outbox写入失败让事件/evidence/decision全部回滚，不留下已生效但未入队通知
- [ ] 当前membership撤销或跨scope请求拒绝；只offline Rules运行，不产生任何Jev/抖店/LLM egress
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/api test src/events src/decisions
- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 此卡严格dependency-gated，不能在P2或audit/outbox未合并时声称真实闭环

**并行分组：** `event-decision-029`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 shared:app-module及shared:tenant-vitest协调锁；只负责DI与事务适配，所有叶实现/表由前卡提供；本地isolatedPostgres验证。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。 本卡仅完成现有授权指标源到事件、Rules、winner、audit/outbox的DI与原子事务接线；以真实同subject、同窗口、同cutoff的已观测零库存正例及健康/未知负例证明闭环。未知预测扩展保持typed unavailable；不伪造流量、成本、上架、ETA或失败事实。完整观测家族由P04-033..044提供；不增加这些卡为029硬依赖，不声称030并发证明或031/032全场景验收。


<a id="p04-030"></a>

## P04-030：证明并发事件去重与原子路由

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** EventDecisionConcurrencyProof / AuditOutboxAtomicity

**输入：**

- P04-029真实模块与P04-016/026数据库约束；P09-004 append-only审计及P10-003事务outbox
- 两个独立受限DB连接、同fingerprint/decision key、版本乱序和故障注入测试

**输出：**

- 数据库/API并发证明：一条活动event、唯一有效decision、唯一delivery intent以及对应audit
- 故障回滚/升级恢复打破cooldown/旧版本拒绝与late-fallback winner证据
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/event-decision-concurrency.test.mjs, apps/api/test/event-route-atomicity.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/event-decision-concurrency.test.mjs`
- `apps/api/test/event-route-atomicity.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`

**硬依赖：** P04-029

**实际接线依赖：** 无

**验收：**

- [ ] 同事件十次/并发评估只有一条活动事实与一次即时通知intent，无重复DEEP授权
- [ ] 旧source/evidence revision晚到不能覆盖新证据；升级可产生新合法route而不重复旧key
- [ ] outbox或audit故障无半提交；真实SecurityClock超时后late result不能再提交effective decision
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** SQLite/内存测试无法证明PostgreSQL partial unique与事务竞争

**并行分组：** `event-decision-030`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 测试卡无生产改动；shared:tenant-runner/shared:tenant-vitest协调锁。0skipped强制本地隔离PostgreSQL，发现问题返回对应实现卡修复。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p04-031"></a>

## P04-031：回归场景001至008的检测与规则标签

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ScenarioDetectionBenchmarkV1 / expectedEvents+expectedDecisions QA-only

**输入：**

- P2-GATE已批准的001..008因果source fixture/观测时点；P03-018/P04-029统一运行链
- H事件/证据与Decision设计允许/禁止标签集合，oracleVersion/labelVersion只在测试侧
- scenario-observation-v2真实因果观测与P04-044受限完整家族接线证明；所有expected/forbidden/oracle仅QA持有。

**输出：**

- 仅QA夹具001..008 expected/forbiddenEvents、expectedEvidence、allowed/forbiddenDecisionLabels与baseline/label版本
- 通过真实metric/event/rules链收集same-evidenceHash结果并生成差异断言；不往运行provider传答案
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/scenarios/event-detection-001-008.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/test/scenarios/event-detection-001-008.e2e-spec.ts`
- `apps/api/test/fixtures/events/scenario-001-008.expectations.ts`
- `apps/api/test/helpers/event-scenario-benchmark.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/vitest.tenant.config.ts`
- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.config.ts`

**硬依赖：** P2-GATE, P03-018, P04-029, P04-033, P04-044

**实际接线依赖：** 无

**验收：**

- [ ] 001售罄优先即时通知、002退款SKU集中、003利润贡献复算、004ROAS/花费、005转换、006滞销、007延期、008机会逐一匹配可接受集合
- [ ] 充足库存、新上市1-2单、缺归因/成本、涨价前窗口等forbidden事件/高置信决策均不出现
- [ ] Day3/Day5只使用各观察点可见事实；隐藏batch真因不在输入；provider看不到expected/forbidden/oracle字段
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败
- [ ] 001..008各正例与控制完整保留；008按已批准Choice A必须检出真实早期新品LOW/ESTIMATED机会，基线null/MISSING，INSUFFICIENT_DATA、NO_LLM_NEEDED、LOW_PRIORITY，建议DAILY_BRIEF且可被既有路由降为IGNORE；禁止HIGH/DEEP/SUFFICIENT/NOTIFY_NOW/ESCALATE或确认增长。授权证据视图与合格intent使用“早期新品机会，基线未成熟”。Day3/Day5与四周历史均使用原观察点封存事实；不删除008正例，不以未成熟基线制造比较增长。

**测试：**

- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** synthetic labels是产品评审标注，不代表真实商家ground truth

**并行分组：** `event-decision-031`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 本卡复用已完成源与模块，不新增generator/业务检测；helper仅test目录，8个场景共享同一固定capture/assert机制，避免重复手写实现。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。


<a id="p04-032"></a>

## P04-032：回归场景009至015与答案隔离负例

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ScenarioNegativeControlBenchmarkV1 / oracle-isolation proof

**输入：**

- P2-GATE已批准009..015因果fixture与预期清单；P04-029/030真实event/decision/outbox链
- P04-031 test-only benchmark helper，same-weekday/hour baseline与版本化允许/禁止标签
- P04-044真实受限接线及scenario-observation-v2封存时序；P04-031仅提供QA helper。

**输出：**

- QA-only009..015预期/禁止集合及baseline/label/oracle版本
- 同步故障、十次重复乱序、大折扣、取消、季节性、低量、多问题聚合负例报告；运行代码依赖图无test oracle
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/scenarios/event-detection-009-015.e2e-spec.ts, apps/api/test/event-oracle-isolation.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/test/scenarios/event-detection-009-015.e2e-spec.ts`
- `apps/api/test/fixtures/events/scenario-009-015.expectations.ts`
- `apps/api/test/event-oracle-isolation.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/vitest.tenant.config.ts`
- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.config.ts`

**硬依赖：** P2-GATE, P04-029, P04-030, P04-031, P04-044

**实际接线依赖：** 无

**验收：**

- [ ] 009只有SYNC_FAILURE不能用stale sales报REVENUE_DROP；010十次只有一条事实且旧版不覆盖；011折扣只扣一次；012pending取消不是退款
- [ ] 013同weekday/hour正常波动禁止无依据HIGH/REVENUE_DROP；014低量禁止SUFFICIENT与DEEP填数据；配套真实同窗营收下降正例必须检出，证明负例不是恒不报警
- [ ] 015同一窗口多问题排序稳定并满足通知聚合限额，重复推进不重复intent；修改/删除expected答案不改生产provider输入或输出
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败
- [ ] 完整保留009..015正例/控制、真实营收下降twin与修改/删除expected不改变provider输入输出的隔离证明。009为真实D3中断失败且D5已成功恢复；010通过十次真实saved-page投递及新旧版本乱序。015库存售罄、异常折扣、实际5倍花费三帧必须同Day5 W=[T-24h,T)、visibleAt、generation与joined revision，三者均eligible且该同窗至少两个不同won candidates；验证cap、rank、唯一合格intent及重放幂等。另单独断言成熟退款C=[T0,T0+24h)、96h lag，不计入上述同窗winner数量。

**测试：**

- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** oracle泄露会让15场景回归失去真实检测意义

**并行分组：** `event-decision-032`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 仅QA expected数据，不实现Jev benchmark网络调用；本卡不新增Phase7提案功能，015仅证明事件与delivery-intent幂等，提案幂等由后续阶段负责。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p04-033"></a>

## P04-033：冻结因果观测窗口与捕获助手

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** scenario-observation-v2 causal manifest only

**输入：**

- P03-030
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Day3 hash replay after Day5, no hidden future refund/notice/listing, actual cohort/sample/aged inventory preconditions checked without writing metric/event answers.
- Check actual measured, complete same-W frame prerequisites for all three 015 issues, paired seasonal/twin windows, genuine launch absence before T0, and original observation watermarks for mature refund baselines.
- Explicitly register required restricted DB/API target(s) under shared runner/config locks: apps/api/test/observed-scenario-cutoff.e2e-spec.ts. API targets enter tenant include and default exclude; runner explicitly selects DB targets. Every registered target executes positive assertion counts with zero skipped/todo/pending; use only isolatedPostgres runner credentials, never inherited development DATABASE_URL.

**独占文件（新路径为计划创建）：**

- `apps/api/test/fixtures/events/scenario-observation-v2.ts`
- `apps/api/test/helpers/observed-scenario-capture.ts`
- `apps/api/test/observed-scenario-cutoff.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`
- `scripts/test-tenant-database.mjs`

**硬依赖：** P03-030, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Freeze T0, Day3+72h/Day5+120h, per-family exact periods, genuine 120-day warmup/remaining old lots and four weekly same-weekday/hour baseline captures.
- [ ] Freeze weekly comparisons by shifting both cohort and visibleAt by 7/14/21/28d. For C=[T0,T0+24h), Day3/5 end lags are 48h/96h. Stage historical captures in wall-independent chronological business-clock order before advancement. 015 counts same exact Day5 W stockout/discount/spend, with mature C refunds independently required.
- [ ] Helper advances real causal source/commits/captures only, with immutable version pins; expected/forbidden answers remain in later 031/032.
- [ ] 009 interruption includes the actual D3 try during [T0+48h,T0+72h], then ends before a successful retry by D5. The 010 policy requires ten real deliveries by D5 and distinct old/new versions.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.
- [ ] T0 is midnight Asia/Shanghai at intervention/real launch; Day3=T0+72h, Day5=T0+120h. At each T capture and compute before advancing. W=[T-24h,T), C=[T0,T0+24h); campaigns use full local days. Historical weekly period AND visibleAt shift by 7/14/21/28d; historical freshness is assessed at original observation and then age <=35d. Warmup starts T0-120d; 008 SKU does not exist before T0.
- [ ] 001/007: W, lag 0, observed stockout and announced supplier-delay positives by D5 with healthy controls. 002: C with D3=48h and D5=96h end lag and weekly REFUND_COHORT_ORDER_RATE at identical lag. 003: W/0h, weekly CONTRIBUTION and actual median-matching comparator. 004: full local day W/0h, weekly ROAS and AD_SPEND, both D5 signals. 005: W/0h weekly CONVERSION_RATE with separately captured pre-price negative.
- [ ] 006: genuine surviving >=90d lots, listed >=30d, >=20 units, >90d demand cover; exactly 90d cover is negative. 008: required D5 qualified LOW opportunity and D3 age/volume/coverage branches with absent prelaunch baseline. 009: real D3 failed job during [T0+48h,T0+72h], actual successful recovery before D5. 010: ten actual saved-page delivery attempts and old/new reordering by D5.
- [ ] 011 discount and 012 paid/pending cancellation use W/0h, with weekly CANCELLED_ORDER_RATE and pending-not-refund control. 013 uses weekly PAID_REVENUE for normal weekday/hour seasonal negative AND true revenue-decline twin. 014 retains six-order/day new-store/unknown controls, only real available history, no SUFFICIENT/DEEP/fabricated baseline.
- [ ] 015: same exact D5 W, visibleAt, binding/generation and joined revision for observed stockout, unusual discount and measured actual 5x spend spike; all three eligible frames and >=2 distinct won candidates in this one W, stable ordering/cap/intents/replay. Separately require mature C refunds with exact 96h lag; exclude refunds from the same-window count.

**测试：**

- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- Expected labels, final scenario acceptance, production detector or generator changes

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-033`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/qa-foundation.

<a id="p04-034"></a>

## P04-034：按固定策略检测早期新品机会

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** EarlyLaunchEvidenceV1 strict subset / LaunchOpportunityPolicyV1 / event-policy-observed-v2

**输入：**

- P03-019
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Valid measured Day3/5-shaped launch, 1-2 orders, unknown traffic, prelisting window, missing baseline, mature branch and old-policy regression; enforce event candidate LOW and data quality ESTIMATED.

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/events/early-launch.schema.ts`
- `apps/api/src/events/early-launch-policy.ts`
- `apps/api/src/events/detectors/early-launch.detector.ts`
- `apps/api/src/events/detectors/early-launch.detector.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** P03-019

**实际接线依赖：** 无

**验收：**

- [ ] Named typed branch uses existing real fields and null/MISSING baseline, pinned separate mode manifest; no fake four-week history or undeclared v1 evidence fields.
- [ ] Age 24..120h, complete postlisting 24h, >=20 units/paid orders, >=100 visitors, >=10% conversion and complete coverage. LOW/ESTIMATED, INSUFFICIENT_DATA, no DEEP/HIGH, qualified early-opportunity text.
- [ ] Delegate mature comparisons to unchanged four-week ProductBreakoutDetector. Persist event rulePolicyVersion through existing envelope. Decision enforcement and formatting are owned by P04-042/043.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.
- [ ] Approved Choice A only: existing PRODUCT_BREAKOUT type is compatibility detail, never confirmed-growth wording. EarlyLaunchEvidenceV1 has real listedAt, complete post-listing 24h window, listing age 24..120h, >=20 paid orders AND units, >=100 measured visitors, conversion >=1000bps, coverage 10000bps, observation age <=1h, honestly null/MISSING baseline. Exact qualified read wording is “早期新品机会，基线未成熟”. Optional missing margin remains explicit; no fabricated RobustBaselineV1 or undeclared v1 fields.

**测试：**

- pnpm --filter @shopmate/api test src/events/detectors/early-launch.detector.spec.ts
- pnpm --filter @shopmate/contracts typecheck
- pnpm --filter @shopmate/api typecheck

**不包含：**

- New schemaVersion2 storage, fabricated baselines, UI redesign, final 008 acceptance

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-034`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/policy.

<a id="p04-035"></a>

## P04-035：组装不可变财务比较事件帧

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ObservedProfitEventFrameBuilder

**输入：**

- P03-030
- P03-033
- P03-034
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Exact period/subject/definition/revision match, component sum+residual, missing cost, late return and incompatible comparison rejected.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-profit-frame.ts`
- `apps/api/src/events/observed-profit-frame.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-030, P03-033, P03-034, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Build PROFIT_MARGIN_DROP evidence from current/baseline G4 metrics and persisted decomposition; source references point to exact joined revision with reachable raw receipts.
- [ ] Retain cost coverage/null reasons, buyer shipping and component residual reconciliation; missing data cannot yield high-confidence profitable/negative claims.
- [ ] Read P03-033 immutable companion by scalar snapshot/hash, check current contribution minus actual robust median equals companion delta, and require real matching baseline capture. A median between observed periods produces typed unavailable attribution.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-profit-frame.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Detector formula changes, event persistence, decision or outbox effects

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-035`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/adapter.

<a id="p04-036"></a>

## P04-036：组装实测营销与转换事件帧

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ObservedMarketingFrameBuilder / ObservedConversionFrameBuilder

**输入：**

- P03-030
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Exact campaign/SKU context, complete daily versus partial coverage, pre-price negative, absent visitors, zero denominators and missing attribution.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-marketing-frame.ts`
- `apps/api/src/events/observed-conversion-frame.ts`
- `apps/api/src/events/observed-marketing-frame.spec.ts`
- `apps/api/src/events/observed-conversion-frame.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-030, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Campaign entity ROAS/spend frames use actual full-day measured attribution and aligned baseline; SKU conversion uses exact selected visitors/paid orders.
- [ ] Price correlation references observed price edge, never hidden intervention; pre-effective windows and unknown attribution remain unavailable/insufficient.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-marketing-frame.spec.ts
- pnpm --filter @shopmate/api test src/events/observed-conversion-frame.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Changing attribution or conversion thresholds, causal claims about price, runtime effects

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-036`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/adapter.

<a id="p04-037"></a>

## P04-037：组装库存、滞销与新品事件帧

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ObservedInventoryFrameBuilder / ObservedLaunchFrameBuilder

**输入：**

- P03-030
- P04-034
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Zero/sufficient/unknown inventory, delayed versus healthy known ETA, missing notice, genuine 90-day lots versus new receipt, early listing and wrong-subject metrics.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-inventory-frame.ts`
- `apps/api/src/events/observed-launch-frame.ts`
- `apps/api/src/events/observed-inventory-frame.spec.ts`
- `apps/api/src/events/observed-launch-frame.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-030, P04-034, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Forecast stockout uses current available, exact SKU sales and announced supplier notice; delay is not inferred from future receipt.
- [ ] Stagnation uses conserved remaining-lot age and actual listing age; launch consumes authentic listing/SKU sales/conversion with explicitly selected early/mature policy.
- [ ] Observed zero-stock remains independently usable when forecast extensions are unknown.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-inventory-frame.spec.ts
- pnpm --filter @shopmate/api test src/events/observed-launch-frame.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Supply model generation, changing mature detector thresholds, event persistence

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-037`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/adapter.

<a id="p04-038"></a>

## P04-038：组装退款、取消、折扣与营收事件帧

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ObservedCommerceFrameBuilder and normalized aggregate baseline references

**输入：**

- P03-030
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Mature/immature refund cohort, pending cancellation without refund, same-SKU concentration, paid/discount identity, normal seasonal and true decline observations.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-commerce-frame.ts`
- `apps/api/src/events/observed-commerce-observations.ts`
- `apps/api/src/events/observed-commerce-frame.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-030, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Exact persisted order/refund payment state yields cohort concentration, cancellation and discount aggregates; unknown reasons remain UNKNOWN.
- [ ] Revenue uses authentic aligned snapshot history; normalized aggregates retain joined revision/time/evidence provenance accepted by BaselinePort.
- [ ] Separate runs for distinct cohort/observation windows, with no store-to-SKU relabel or discount double deduction.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-commerce-frame.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Generator changes, new detector thresholds, notification routing

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-038`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/adapter.

<a id="p04-039"></a>

## P04-039：无成功数据包时评估真实同步失败

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ObservedSyncFrameBuilder / AuthorizedEmptyMetricRead

**输入：**

- P03-026
- P03-030
- P04-041
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Failed initial job with absent four streams, stale sales suppression, subsequent recovery/replay, revoked reader and forbidden fake failure-rule input.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-sync-frame.ts`
- `apps/api/src/events/observed-sync-frame.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/events/event-evaluation.service.ts`

**硬依赖：** P03-026, P03-030, P04-041

**实际接线依赖：** 无

**验收：**

- [ ] Build CONNECTION SYNC_FAILURE evidence only from sealed job-observation history; measures=[] still revalidates current membership/full binding/generation.
- [ ] Empty authorized metric read can succeed without a commerce bundle; nonempty read failures never become empty successful results.
- [ ] Source-quality blocking suppresses stale-sales REVENUE_DROP and recovery uses only facts visible at its own cutoff.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-sync-frame.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Global read bypass, synthetic stale metric snapshots, notification delivery

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-039`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/adapter.

<a id="p04-040"></a>

## P04-040：接线完整观测事件注册表

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** ObservedEventFrameRegistry / pinned policy and source selection to existing evaluation UoW

**输入：**

- P04-029
- P04-033
- P04-034
- P04-035
- P04-036
- P04-037
- P04-038
- P04-039
- P04-042
- P04-043
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Composition test: each family registers exactly once with exact policy/version; source-health runs first, missing capability fails safely, same trusted UoW is invoked. Restricted cross-family smoke and effects belong to P04-044.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-event-frame-registry.ts`
- `apps/api/src/events/observed-event-frame-registry.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/events/events.module.ts`
- `apps/api/src/decisions/decisions.module.ts`
- `apps/api/src/app.module.ts`

**硬依赖：** P04-029, P04-033, P04-034, P04-035, P04-036, P04-037, P04-038, P04-039, P04-042, P04-043

**实际接线依赖：** 无

**验收：**

- [ ] Opt-in versioned registry assembles already-tested frames, captures and computes exact metric jobs, then calls existing EventEvaluationService and P04-029 transaction/winner/audit/outbox.
- [ ] Source health precedes affected business signals. Invoke P04-042 assurance/rules gates and expose P04-043 authenticated read formatter for qualified early launches.
- [ ] No expected/oracle fields reach providers, no test-only policy override, no effect outside actual won decision; absent observed capability safely unavailable.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-event-frame-registry.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- New causal sources/calculators, rewrites of 029 atomicity, 030 contention suite, claiming 031/032 acceptance

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-040`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/integration.

<a id="p04-041"></a>

## P04-041：冻结历史选择与稳健基线注册

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** robust-baseline-observed-v2 / selectObservedBaselineHistory

**输入：**

- P03-030
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Four full periods yield 100% slot coverage; missing or mismatched lag, stale original data, >35d age, wrong pin and old-policy regression.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/observed-baseline-policy.ts`
- `apps/api/src/events/observed-baseline-history.ts`
- `apps/api/src/events/observed-baseline-history.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/events/event-rule-policy.ts`
- `apps/api/src/events/robust-baseline.ts`

**硬依赖：** P03-030

**实际接线依赖：** 无

**验收：**

- [ ] Register a sibling BaselinePort using minimumSamples=4, lookbackWeeks=4, maximumAgeSeconds=3024000, while current freshness <=3600 seconds. Keep event-policy-v1 and robust-baseline-v1 identical.
- [ ] Require four original authorized captures at offsets 7/14/21/28d. Shift both period and observation instant by same offset. Validate original freshness, then current historical age. Serialize pinned measure/subject/proofs.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/events/observed-baseline-history.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Rewriting robust median algorithm or supplying prelaunch history

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-041`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/baseline.

<a id="p04-042"></a>

## P04-042：执行可信早期新品决策门槛

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** Verified early-launch event/evidence plus immutable policy assurance

**输入：**

- P04-034
- P04-029
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Mature weekly path unchanged; forged sanitized pin, stale/wrong evidence or cross-tenant rejects; stage-wise labels and replay verified.

**独占文件（新路径为计划创建）：**

- `apps/api/src/decisions/early-launch-decision-policy.ts`
- `apps/api/src/decisions/early-launch-decision-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/decisions/rules-evidence-gate.ts`
- `apps/api/src/decisions/rules-decision.provider.ts`
- `apps/api/src/decisions/decision-ruleset.ts`
- `apps/api/src/decisions/decision-hard-gate.ts`
- `apps/api/src/decisions/decision-input-sanitizer.ts`
- `apps/api/src/decisions/decisions.module.ts`

**硬依赖：** P04-034, P04-029

**实际接线依赖：** 无

**验收：**

- [ ] Select branch from trusted persisted event rulePolicyVersion + ruleset + exact current evidence and per-call assurance. Sanitizer equality alone cannot elect a policy. Restrict comparative count-gate bypass to that verified early branch.
- [ ] Persist normal decision labels: LOW severity/LOW_PRIORITY, INSUFFICIENT_DATA, NO_LLM_NEEDED, suggested DAILY_BRIEF. Existing routing may demote to IGNORE. Block HIGH/CRITICAL, NOTIFY_NOW, ESCALATE, DEEP and SUFFICIENT.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api test src/decisions/early-launch-decision-policy.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- Stored summary text, new evidence payload or route effects

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-042`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/decisions.

<a id="p04-043"></a>

## P04-043：授权展示历史证据的新品限定文案

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** Authenticated deterministic policy-aware observation display

**输入：**

- P04-042
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Authorized current/historical reads display the early qualification, mature v1 retains existing text, unrecognized/mixed provenance cannot display early/confirmed growth, denied tenant has no content.

**独占文件（新路径为计划创建）：**

- `apps/api/src/events/early-launch-display.ts`
- `apps/api/src/events/early-launch-display.spec.ts`
- `packages/contracts/src/events/event-assessment-view.schema.ts`
- `apps/api/src/events/event-assessment.controller.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/events/event-query.service.ts`
- `packages/contracts/src/events/event.schema.ts`
- `apps/api/src/events/events.module.ts`
- `apps/api/src/events/event-decision-unit-of-work.ts`
- `packages/contracts/src/index.ts`

**硬依赖：** P04-042

**实际接线依赖：** 无

**验收：**

- [ ] Provide a versioned authenticated read-view formatter using stored event rulePolicyVersion, exact linked immutable evidence and persisted decision ruleset. Return the approved qualified wording on the response view. Do not add a persisted summary string.
- [ ] Expose strict EventAssessmentViewV1 {mode, displayLabel, evidenceReference, rulePolicyVersion} through authenticated GET on both store-route aliases at /events/:eventId/evidence/:evidenceId/assessment, using exact version/hash/definition query and existing ownership checks. Render only a mode verified against the pinned historical decision/ruleset/evidence. The same deterministic formatter prepares the summary for an eligible IN_APP winner; existing event/decision envelopes remain untouched.
- [ ] EARLY_LAUNCH displayLabel is the exact approved qualified text in the written spec. For obsolete/unknown policy provenance return typed unavailable; no guessed display mode.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.
- [ ] EARLY_LAUNCH displayLabel must equal “早期新品机会，基线未成熟”. Preserve PRODUCT_BREAKOUT compatibility without presenting its internal name as confirmed growth; no persisted summary column.

**测试：**

- pnpm --filter @shopmate/api test src/events/early-launch-display.spec.ts
- pnpm --filter @shopmate/contracts typecheck
- pnpm --filter @shopmate/api typecheck

**不包含：**

- P7/P8/UI redesign or storing generated text

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-043`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/read.

<a id="p04-044"></a>

## P04-044：证明观测事件进入真实受限事务

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** Observed runtime DI and effect linkage smoke

**输入：**

- P04-040
- P04-033
- P04-043
- Frozen written observed-fact design and contract-owned producer/reader ports; actual authorized immutable source facts, scoped grants and publication/page receipts; no runtime metric answer injection.

**输出：**

- Targeted tenant E2E with explicit positive counts and no skips; 031/032 retain full Day3/5 positives/controls, contention remains 030.
- Explicitly register required restricted DB/API target(s) under shared runner/config locks: apps/api/test/observed-event-adapters.e2e-spec.ts. API targets enter tenant include and default exclude; runner explicitly selects DB targets. Every registered target executes positive assertion counts with zero skipped/todo/pending; use only isolatedPostgres runner credentials, never inherited development DATABASE_URL.

**独占文件（新路径为计划创建）：**

- `apps/api/test/observed-event-adapters.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`
- `scripts/test-tenant-database.mjs`

**硬依赖：** P04-040, P04-033, P04-043

**实际接线依赖：** 无

**验收：**

- [ ] Use real restricted source publication/receipts, defined metrics, actor-bound store and existing event decision UoW; cover each adapter family and initial sync failure through DI.
- [ ] Verify exact event/evidence/snapshot binding, qualified launch labels/read display, winner and eligible intent replay. No QA answers enter provider.
- [ ] Preserve existing version semantics and history; additive changes only, migrations use actual fresh creation timestamps.
- [ ] Strict typed inputs, safe integer arithmetic, parameterized SQL, no PII/oracle fields or secrets; functions/test callbacks/SQL bodies <40 lines, TS no any without approved rationale.
- [ ] Critical paths have focused meaningful tests; source facts use authentic restricted writes with scoped service grants, publication/page receipts and authorized reads, never metric answer injection.
- [ ] DB proof only isolatedPostgres runner-issued credentials, explicit target registration under locks, nonzero assertion counts and zero skipped/todo/pending.
- [ ] One commit per independently verified change and one card PR. Independent review, latest-head CI and actual main merge precede Done. Existing authorized automatic deployment continues after reviewed green merges. Exclude manual production operations, credentials/grants changes, manual online migrations, real platform/LLM calls and external P07/P08 work.
- [ ] Use DB SECURITY_UTC clock_timestamp() for grants, expiry, leases and deadlines; business time selects source visibility only. Under READ COMMITTED, lock generation, grant and membership in fixed order, repeat authority/expiry checks at the final write or capture, then commit. Revocation/reset obtains conflicting locks. Test both orderings and expiry during lock wait on two connections.
- [ ] Observed facts retain full ConnectorBinding/generation/domain/subject, immutable source/producer versions, sequence/priorVersion, UTC millisecond occurredAt/observedAt, payloadHash and DB-recordedAt/receipt linkage. Windows are half-open, Asia/Shanghai/CNY; money is safe integer minor CNY, ratios integer basis points, nullable unknown has a quality reason and complete measured zero requires receipt proof. No customer/session identifiers, raw provider text, scenario IDs, hidden batch causes, expected/forbidden labels or failure-rule configuration enter runtime observations/providers.
- [ ] Publication authority is server-certified model/config/hash, scoped live grant, binding/generation/domain, business clock and contiguous receipt coverage; worker claims cannot certify completeness. First capture uses authoritative current business clock; historic replay requires a sealed capture and its original receipt set. Future or late facts cannot rewrite earlier visibility. SECURITY_UTC remains independent of adjustable business time.
- [ ] Retain typed failures: OVERFLOW, INVALID_INPUT, CONFLICT, VERSION_MISMATCH, NOT_FOUND/FORBIDDEN and SOURCE_UNAVAILABLE; bounded errors expose no SQL, payload or secrets. Current authorization includes membership and connection/full binding/generation; GUCs alone confer no authority.

**测试：**

- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- Implementation changes or claiming final scenario acceptance

**风险：** Receipt/authority/quality errors must fail closed; missing observations cannot become verified zero or invented history. Four-hour ceiling requires split before claim if exceeded.

**并行分组：** `event-decision-044`

**执行边界：** Approved written Choice A on 2026-11-11 is release evidence outside the dependency graph; no USER_* gate. Four hours is a planning ceiling including proof and PR preparation, not observed duration; split before claim if the seam cannot fit. The frozen written design and JSON at docs/superpowers/specs/2026-11-11-observed-fact-prerequisites-design.md and 2026-11-11-observed-fact-prerequisite-cards.json remain normative. Preserve p2-normalized-v1, metrics-g4-v1, mock-source-v1/v2, event-policy-v1 and robust-baseline-v1 meaning/history; additive observed-facts-v1, p2-observed-v1:<sha256>, metrics-g4-observed-v2, mock-business-observed-v1 and mock-source-v3 only. New version selection is explicitly provisioned opt-in; rollback disables new selection while retaining immutable history. Missing capabilities/configuration fail safely unavailable. Native Issue sole assignee hannnnnnnny records reservation only; no catalog owner/status fields and no active claim. 触及这些共享路径必须先取得锁（仅条件性全局规则，不表示本卡计划编辑或预占）：packages/contracts/src/index.ts, packages/database/src/index.ts, apps/api/vitest.tenant.config.ts, apps/api/vitest.config.ts, scripts/test-tenant-database.mjs。保留所有既有runner/config目标。 Original planning track: P4/integration-proof.
