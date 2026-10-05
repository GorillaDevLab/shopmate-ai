# Phase 3 — Metric Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p03-001"></a>

## P03-001：定义版本化指标输入、快照与质量证据契约

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** MetricInputV1 / MetricSnapshotV1 / MetricSourceReader / MetricCalculator / MetricSnapshotRepository / MetricReadPort

**输入：**

- 消费现有ConnectorBinding/Order/Refund/Inventory/CampaignMetric DTO；完整organization/workspace/store/connection scope
- G4财务口径、半开UTC窗口与Asia/Shanghai营业时区；缺少冻结成本/费用/流量/ETA时使用带来源的nullable扩展事实

**输出：**

- strict Zod输入及按指标kind区分的值/单位：minor CNY安全整数、有符号利润、basisPoints、units、hours
- 快照包含definitionVersion/periodStart/end/timezone/currency/sourceWatermark/computedAt/sampleSize/coverageBasisPoints/status/evidenceIds/inputRevision；状态仅VERIFIED/ESTIMATED/INSUFFICIENT/STALE/UNAVAILABLE
- 固定MetricSourceReader读取已归一化、截止时间可见事实；MetricCalculator、仓储append/read与授权只读端口的readonly签名，禁止隐式源oracle
- 叶端口ExactMinorMath、MetricWindowResolver、Payment/Refund/FrozenCost/Contribution/Inventory/FunnelMarketing/ProfitDelta calculators与MetricQualityReducer/QualityPolicy的输入输出形状；组件可注入test-only实现，真实函数接线后置

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/metrics/metric.schema.ts`
- `packages/contracts/src/metrics/metric-ports.ts`
- `packages/contracts/src/metrics/metric.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] 未知字段/跨scope来源/非CNY/不安全整数被拒绝
- [ ] 未同步输入保留null和UNAVAILABLE，不能解析成VERIFIED零销售
- [ ] 开始>=结束、watermark晚于可见截止、缺证据或版本被拒绝

**测试：**

- pnpm --filter @shopmate/contracts test src/metrics/metric.schema.spec.ts
- pnpm --filter @shopmate/contracts typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 现有Connector DTO没有冻结费用与漏斗字段，扩展叶接口不能冒充P2已交付

**并行分组：** `metric-001`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 契约协调锁shared:contracts-index；此卡只定义输入边界，当前DTO缺字段一律nullable并保留来源。

<a id="p03-002"></a>

## P03-002：编写G4金额与窗口黄金夹具

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** FinanceGoldenFixtureV1（仅测试输入与预期）

**输入：**

- 消费P03-001指标字段和G4公式；不得从Scenario expected字段生成运行时数据
- 固定paid/cohort/settlement窗口，fixture只放测试目录

**输出：**

- 可复算金额夹具：GMV12000、折扣2000、买家运费500、商品退款2000、冻结COGS6000 => paid10500/net8500/grossProfit2000；履约700/平台300/支付100/广告800 => contribution600；其他费用200 => estimatedNet400
- 独立缺成本、退货冲回、跨日退款及未付取消夹具；订单退款率与金额退款率分开

**独占文件（新路径为计划创建）：**

- `apps/api/test/fixtures/metrics/finance-golden.fixture.ts`
- `docs/analytics/p03-finance-golden-cases.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 夹具的收支每步可手算且折扣只扣一次
- [ ] 次日退款仅降低次日settlement net，原日paid事实保持10500
- [ ] 缺COGS/未配置费用夹具预期包含状态与覆盖率，不把缺值写成0

**测试：**

- pnpm --filter @shopmate/api typecheck
- 人工复核docs/analytics/p03-finance-golden-cases.md的金额守恒与cohort/settlement表

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** G4提供公式而未提供数字样例；上述数值是明确标注的本地回归例

**并行分组：** `metric-002`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 仅测试黄金例与口径说明，其他组件可用各自同契约最小夹具独立开工。

<a id="p03-003"></a>

## P03-003：实现精确minor金额及比例运算

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ExactMinorMath / BasisPointRatio

**输入：**

- MetricInputV1定义的安全整数CNY与显式舍入策略；允许有符号利润
- 测试专用合成整数及0分母，不依赖源宿主

**输出：**

- checked add/subtract/multiply及整数比例工具；0分母返回nullable typed result
- 固定basisPoints/展示舍入策略与overflow错误，不中间浮点累计金额

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/exact-math.ts`
- `apps/api/src/metrics/exact-math.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 0.1元+0.2元对应10+20=30minor
- [ ] 累加/数量乘积超过安全范围返回明确错误而非舍入
- [ ] 负利润合法，rate分母0返回null并保留reason

**测试：**

- pnpm --filter @shopmate/api test src/metrics/exact-math.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 比例舍入与金额溢出必须固定版本，避免表面精确

**并行分组：** `metric-003`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-004"></a>

## P03-004：实现营业窗口与同截止比较

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MetricWindowResolver / AlignedComparisonWindow

**输入：**

- P03-001 UTC半开窗口、BusinessClock注入、营业时区Asia/Shanghai
- 给定当前观察时间及同星期候选日，不读取未来订单

**输出：**

- 营业日UTC边界与当前partial-day窗口
- 同星期/同小时/同已过时长比较窗口；有效aligned标记供P4 baseline消费

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/metric-window.ts`
- `apps/api/src/metrics/metric-window.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 上海零点转换正确，恰在periodEnd的支付不计入当前窗口
- [ ] 14时窗口只比较历史相同截止14时而非整天
- [ ] 未知timezone/倒序窗口/超观察时间输入被拒绝

**测试：**

- pnpm --filter @shopmate/api test src/metrics/metric-window.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 时区和partial-day比较错配会制造下降事件

**并行分组：** `metric-004`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-005"></a>

## P03-005：实现GMV与实收支付指标

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** PaymentMetricCalculator

**输入：**

- MetricInputV1中已观测的paymentFacts与订单商品原价/折扣/买家运费
- 依赖ExactMinorMath和MetricWindowResolver接口；可用契约测试替身

**输出：**

- 仅已付商品原价GMV、商品折后额+买家运费paidRevenue、订单数/单位数/AOV
- 后续退款不改原paid事实；可疑付款状态返回质量原因

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/payment-metrics.ts`
- `apps/api/src/metrics/payment-metrics.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-004

**验收：**

- [ ] GMV12000/折扣2000/运费500产生paid10500
- [ ] PENDING取消订单不进入GMV/paid，已支付后取消仍保留付款事实
- [ ] 缺paidAt/paidMinor返回不足或不可用，不把payable当实收

**测试：**

- pnpm --filter @shopmate/api test src/metrics/payment-metrics.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 未知源字段必须显式缺失，不能以零补齐

**并行分组：** `metric-005`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-006"></a>

## P03-006：实现退款结算与支付cohort指标

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** RefundMetricCalculator / CohortMaturity

**输入：**

- MetricInputV1中SUCCEEDED退款、原支付事实、指定cohort与观察截止
- ExactMinorMath/窗口端口；本卡合成跨日、多次部分退款夹具

**输出：**

- 按settledAt净实收及按paidAt cohort发生退款订单数/金额率两套明确命名指标
- 同订单多次退款去重后的订单分子与cohort成熟度/样本数

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/refund-metrics.ts`
- `apps/api/src/metrics/refund-metrics.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-004

**验收：**

- [ ] 次日退款2000仅减少次日settlement净实收，不改变原日paid10500
- [ ] 同一订单两次部分退款只算1个退款订单，REQUESTED不算已结算
- [ ] 0paid分母、退款大于支付或异币种返回null/typed质量错误

**测试：**

- pnpm --filter @shopmate/api test src/metrics/refund-metrics.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 退款订单率、金额率与结算收入窗口不能互换

**并行分组：** `metric-006`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-007"></a>

## P03-007：实现冻结成本与退货冲回口径

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** FrozenCostCalculator / ReturnCostPolicyV1

**输入：**

- MetricInputV1中成交时冻结skuCostVersion、已确认/预计成本、商品退款分摊、returnReceipt
- ReturnCostPolicyV1规定已验收可重新出售退货才冲回冻结成本；只退款未回收商品不冲回；缺事实显式披露

**输出：**

- 净商品收入与已知COGS/grossProfit、成本coverage和ESTIMATED标签
- 版本化成本冲回证据引用，复算不读取当前SKU价格

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/frozen-cost.ts`
- `apps/api/src/metrics/frozen-cost.spec.ts`
- `docs/analytics/p03-return-cost-policy.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-006

**验收：**

- [ ] 净商品8000-冻结COGS6000得到grossProfit2000
- [ ] SKU后续改成本不改变旧期COGS；只有合规returnReceipt触发规定冲回
- [ ] 缺成本报告coverage及ESTIMATED，不能返回精确完整毛利

**测试：**

- pnpm --filter @shopmate/api test src/metrics/frozen-cost.spec.ts
- 人工复核docs/analytics/p03-return-cost-policy.md的退款与实物回收分离

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 成本冲回属于明确产品口径，不能把退款自动等同可售退货

**并行分组：** `metric-007`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-008"></a>

## P03-008：实现贡献利润与费用披露

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ContributionCalculator / EstimatedNetProfit

**输入：**

- P03-001 grossProfit/net买家运费/履约/平台/支付/广告促销分摊/其他经营费用带coverage输入
- 消费FrozenCostCalculator输出接口，测试可注入黄金毛利结果

**输出：**

- contribution与estimatedNetProfit确定性结果；缺费用项清单/coverage
- 折扣已在收入扣除，不在费用重复扣减；未知固定费用显示未包含

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/contribution-metrics.ts`
- `apps/api/src/metrics/contribution-metrics.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-007

**验收：**

- [ ] 毛利2000+运费500-700-300-100-800=contribution600；费用200=>400
- [ ] 重复传入收入已扣折扣不再次扣2000
- [ ] 未知广告/平台费标记ESTIMATED或UNAVAILABLE并披露，不能默认为0

**测试：**

- pnpm --filter @shopmate/api test src/metrics/contribution-metrics.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 估算经营利润不能被命名为真实净利润

**并行分组：** `metric-008`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-009"></a>

## P03-009：实现库存覆盖与交期派生指标

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** InventoryCoverageCalculator

**输入：**

- MetricInputV1中available/onHand/reserved/quarantine/asOf、可见已售units、salesWindowHours、nullable交期/ETA
- 版本化最小样本与freshness配置，BusinessClock注入

**输出：**

- 销售速度、hoursRemaining/daysRemaining nullable、交期/safetyBuffer比较及库存质量
- 库存日数证据保留分母和窗口，不把采购提案当available

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/inventory-metrics.ts`
- `apps/api/src/metrics/inventory-metrics.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-004

**验收：**

- [ ] 库存12/每小时3售出得到4小时覆盖；inbound不直接增加available
- [ ] 销量0=>UNAVAILABLE/null；低量=>INSUFFICIENT；已售罄事实单独保留0available
- [ ] 陈旧库存=>STALE，缺交期/ETA保持null且不推断供应商交期

**测试：**

- pnpm --filter @shopmate/api test src/metrics/inventory-metrics.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 无需求与已售罄事实不能被同一零除分支混淆

**并行分组：** `metric-009`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-010"></a>

## P03-010：实现漏斗与广告归因比例指标

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** FunnelMarketingCalculator

**输入：**

- MetricInputV1中visitors/cart/checkout/paidOrders与campaign spend/impressions/clicks/attributedOrders/revenue
- 缺流量/归因字段使用nullable extended facts，禁止从orders反造访客

**输出：**

- 转换率/ROAS及其分子分母/归因coverage；spend与attributedRevenue同窗
- 0分母、缺归因分别记录nullable值与质量reason

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/funnel-marketing-metrics.ts`
- `apps/api/src/metrics/funnel-marketing-metrics.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-004

**验收：**

- [ ] 1000visitors/100paid得到1000bp，spend10000/revenue30000得到3倍ROAS
- [ ] spend0与visitors0没有Infinity/伪0有效指标
- [ ] 归因/漏斗未同步=>UNAVAILABLE或ESTIMATED并保留覆盖率

**测试：**

- pnpm --filter @shopmate/api test src/metrics/funnel-marketing-metrics.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 现有DTO并非完整漏斗与归因真相，缺字段要显式拒绝精确结论

**并行分组：** `metric-010`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-011"></a>

## P03-011：实现利润变化的确定性贡献分解

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProfitDeltaAttributionV1

**输入：**

- P03-001同口径同截止current/baseline的SKU聚合收入/数量/成本/折扣/spend
- 固定分解顺序和rounding residual规则，输入全部为结构化数值

**输出：**

- 销量/价格折扣/SKU mix/COGS/广告费用的利润差异贡献及残差
- 分解methodVersion与evidence引用，缺字段只输出已知部分/不可用项

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/profit-attribution.ts`
- `apps/api/src/metrics/profit-attribution.spec.ts`
- `docs/analytics/p03-profit-attribution-method.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-003, P03-007, P03-008

**验收：**

- [ ] Scenario003风格营收升利润降样例的各贡献+残差严格等于利润delta
- [ ] 折扣只出现在规定价格折扣贡献一次
- [ ] 窗口/成本版本错配拒绝完整分解，缺mix/费用不得捏造原因

**测试：**

- pnpm --filter @shopmate/api test src/metrics/profit-attribution.spec.ts
- 人工复核docs/analytics/p03-profit-attribution-method.md的固定顺序和残差

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 分解顺序影响归因解释；必须固定版本，不声称实验因果

**并行分组：** `metric-011`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-012"></a>

## P03-012：统一质量状态与覆盖率传播

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MetricQualityReducer / DataQualityIssueV1

**输入：**

- P03-001来源质量、分母样本、freshness、成本/归因coverage；注入版本化QualityPolicy
- 矛盾来源、未同步、低量和部分估算样例；不消费任何场景答案

**输出：**

- 状态优先规则UNAVAILABLE>STALE>INSUFFICIENT>ESTIMATED>VERIFIED及保留的多原因列表
- 各指标对其依赖字段独立评估coverage；真实完全观测空窗可以VERIFIED零值

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/metric-quality.ts`
- `apps/api/src/metrics/metric-quality.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 未同步空数组返回UNAVAILABLE而非VERIFIED零销售
- [ ] 成本缺失只影响利润/成本coverage，不把已确认paidRevenue降为未知
- [ ] stale+缺成本保留两原因，SOURCE_INCONSISTENT不能算VERIFIED

**测试：**

- pnpm --filter @shopmate/api test src/metrics/metric-quality.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 单一状态不能吞掉并存缺陷，需保留原因与字段coverage

**并行分组：** `metric-012`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-013"></a>

## P03-013：注册指标定义与证据重放标识

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MetricDefinitionRegistry / MetricEvidenceHasher

**输入：**

- P03-001 definitionVersion/MetricInputV1/inputRevision/sourceWatermark与纯calculator端口
- 同金额、来源版本和观察截止的确定性序列化，不引入原始PII

**输出：**

- server-owned不可变指标定义注册表及版本查找
- scope绑定inputHash/evidence IDs、重放descriptor；原版本复算保留旧definitionVersion

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/metric-definition-registry.ts`
- `apps/api/src/metrics/metric-evidence-hash.ts`
- `apps/api/src/metrics/metric-definition-registry.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** 无

**验收：**

- [ ] 同逻辑输入的对象/集合排序不改变hash，来源revision变化改变hash
- [ ] 旧定义复算按旧版本，不静默升级历史快照
- [ ] 未知definitionVersion/越scope证据引用返回typed错误

**测试：**

- pnpm --filter @shopmate/api test src/metrics/metric-definition-registry.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 证据hash须含定义与来源版本，避免同值不同口径被误去重

**并行分组：** `metric-013`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-014"></a>

## P03-014：增加指标定义与不可变快照存储约束

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** MetricSnapshotRow / MetricDefinitionRow

**输入：**

- P03-001 snapshot字段及现有Tenant复合ownership/RLS模型
- P03-013定义与hash语义作为schema约束输入，不依赖P2运行源

**输出：**

- 拟新增metric_definitions/metric_snapshots迁移，org/store/key/definitionVersion/period/inputRevision唯一与安全money/status约束
- RLS默认deny、tenant/store复合FK与受限角色授权；旧数据迁移路径说明
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/metric-storage.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/prisma/migrations/20261004090000_metric_snapshots/migration.sql`
- `packages/database/test/integration/metric-storage.test.mjs`
- `docs/architecture/p03-metric-storage.md`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `scripts/test-tenant-database.mjs`

**硬依赖：** P03-001, P03-013

**实际接线依赖：** 无

**验收：**

- [ ] pnpm test:tenant强制运行新表越租户/缺scope拒绝案例，0skipped
- [ ] 同revision重复插入拒绝；新revision允许追加，历史值不可覆盖
- [ ] 全新库与已有tenant库应用迁移成功，负利润允许但unsafe integer拒绝
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/database prisma:validate
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** schema/迁移由shared:prisma锁串行合并，绝不在线执行

**并行分组：** `metric-014`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 本卡只拥有新迁移与存储测试，shared:prisma及shared:tenant-runner需协调锁；测试复用本地isolatedPostgres。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p03-015"></a>

## P03-015：实现租户作用域指标快照仓储

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** component · **优先级：** P0

**契约：** MetricSnapshotRepository

**输入：**

- P03-001 append/read端口；P03-014生成Prisma表；TenantContext当前membership
- scope、definitionVersion、period、inputRevision/hash作为读写键

**输出：**

- 参数化且事务内scope绑定的append/read/history仓储
- 重复相同输入返回同快照，不允许相同唯一键改变payload；查询稳定cursor

**独占文件（新路径为计划创建）：**

- `packages/database/src/metric-snapshot.repository.ts`
- `packages/database/test/metric-snapshot.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/src/index.ts`

**硬依赖：** P03-001, P03-014

**实际接线依赖：** 无

**验收：**

- [ ] 同scope/hash重复append返回同id而不覆盖旧证据
- [ ] tenantA按id/cursor读取B返回无资源，不泄漏存在性
- [ ] 同key异hash冲突明确报错，DB失败不伪造成功结果

**测试：**

- pnpm --filter @shopmate/database test（目标test/metric-snapshot.test.mjs）
- pnpm --filter @shopmate/database typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** append幂等与修订追加不可混用更新

**并行分组：** `metric-015`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 仓储测试可用参数化client测试替身；实际RLS证明由P03-014负责，shared:database-index协调锁。

<a id="p03-016"></a>

## P03-016：实现可注入指标计算编排

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MetricComputationService

**输入：**

- P03-001 MetricSourceReader/MetricCalculator/MetricSnapshotRepository端口与授权TenantContext
- fixtures实现固定截止可见事实、失败/缺字段，不直接调用Mock源

**输出：**

- 按输入快照revision冻结事实的compute(scope,window,definitionVersion)编排
- 解析输入、保持scope/quality/evidence、调用calculator并追加快照；失败返回typed不完整原因

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/metric-computation.service.ts`
- `apps/api/src/metrics/metric-computation.service.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P2-GATE, P03-003, P03-004, P03-005, P03-006, P03-007, P03-008, P03-009, P03-010, P03-011, P03-012, P03-013, P03-015

**验收：**

- [ ] 多calculator消费相同sourceWatermark/inputRevision，不混合读取时点
- [ ] 源失败不写VERIFIED零值快照，unknown source字段被strict拒绝
- [ ] 重复compute由端口幂等键复用快照，readonly输入不被修改

**测试：**

- pnpm --filter @shopmate/api test src/metrics/metric-computation.service.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 组件可fixture实现，但真实source/watermark必须P2-GATE后接线

**并行分组：** `metric-016`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。

<a id="p03-017"></a>

## P03-017：实现授权指标查询接口组件

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** MetricReadPort / GET store metrics/history

**输入：**

- P03-001只读MetricReadPort与现有AuthGuard+TenantScopeService.resolve；strict header/path scope与独立query校验
- 严格store/metricKey/definitionVersion/window/cursor参数及服务端store ownership解析

**输出：**

- 拟新增MetricsController与查询service适配，返回版本化快照/空结果/typed错误
- 只从已持久指标读取，read路径不触发实时Connector/LLM计算

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/metrics.controller.ts`
- `apps/api/src/metrics/metrics-query.service.ts`
- `apps/api/src/metrics/metrics.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P03-001

**实际接线依赖：** P03-015

**验收：**

- [ ] 未认证401、无read permission403、跨店/跨租户404
- [ ] 已验证空窗可返回零值快照；没有同步快照则明确empty/unavailable
- [ ] 未知query/倒序period/非法cursor400；仓储故障503无敏感异常

**测试：**

- pnpm --filter @shopmate/api test src/metrics/metrics.controller.spec.ts
- pnpm --filter @shopmate/api typecheck

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 现有merchant analytics旧接口不能被误当新store授权路径

**并行分组：** `metric-017`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 Nest测试module注入MetricReadPort fixture，路由注册及真实repo只由P03-018完成。 当前TenantContextGuard拒绝全部query/body，本filtered route不得直接复用该guard；单独严格解析filters并解析当前tenant/store membership。

<a id="p03-018"></a>

## P03-018：接线归一化源与指标模块并证明复算

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** NormalizedMetricSourceAdapter / MetricsModule runtime

**输入：**

- P2-GATE固定源公共契约、因果fixture与同步schema已合并；P03公式、quality/registry/repository/controller组件
- P2交付事实的当前source版本/watermark，缺冻结COGS/fees/traffic扩展字段显式nullable

**输出：**

- MetricSourceReader真实normalized只读adapter及MetricsModule依赖注入/受保护路由
- source->metric->persist->GET闭环，历史定义/version可重放；不新增P2事实推断
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/metrics-database.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/src/metrics/normalized-metric-source.adapter.ts`
- `apps/api/src/metrics/metrics.module.ts`
- `apps/api/test/metrics-database.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/api/vitest.tenant.config.ts`
- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.config.ts`

**硬依赖：** P2-GATE, P03-002, P03-003, P03-004, P03-005, P03-006, P03-007, P03-008, P03-009, P03-010, P03-011, P03-012, P03-013, P03-014, P03-015, P03-016, P03-017

**实际接线依赖：** 无

**验收：**

- [ ] 已支付/次日退款/缺成本因果fixture通过真实adapter得到G4同一结果及状态
- [ ] 晚到事实产生新inputRevision与证据，旧快照可按旧定义复算
- [ ] current membership撤销后拒绝读取，advance前不暴露未来数据，源失败不会返回正常0
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/api test src/metrics
- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- 不调用真实Jev/抖店/LLM，不部署或迁移线上数据库
- 不重做P2源生成、webhook去重或同步宿主

**风险：** 真实P2 schema尚未定稿，此卡不可提前标为ready

**并行分组：** `metric-018`

**执行边界：** 新路径均为拟新增；工时包含实现、聚焦验证及PR准备。函数/测试回调/SQL体<40行，TS禁any；独立commit与feat/add/fix分支，PR审查、最新CI及main合并后Done。 真正接线必须所有dependsOn合并；shared:app-module与shared:tenant-vitest协调锁。测试仅本地隔离数据库，不执行线上migration。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。
