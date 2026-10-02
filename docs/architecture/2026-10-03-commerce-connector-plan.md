# Phase 1.2 CommerceConnector Contract Implementation Plan

状态：已完成（2026-10-03）。用户已批准架构审查 E/F 的 Connector 设计，并在 Phase 1.1 交付后指示继续；最终安全修复通过独立只读复审。

**Goal:** 将获批的平台无关 CommerceConnector 草案落成可执行的严格 schema、TypeScript port 与安全解析函数。

**Architecture:** 复用 `@shopmate/contracts` 与现有 TenantId，新增 `src/commerce/`。Connector 实例绑定单一组织/工作区/店铺/连接；query/command 不接受 tenant override。JSON DTO 与调用取消信号分离，所有读取结果经过 schema 和 externalStoreId 校验；失败只返回标准 code。写操作使用绝对目标与明确的执行结果，执行与授权仍属于服务端后续模块。

**Tech Stack:** TypeScript、Zod 4、Vitest；无新依赖、数据库 migration 或平台网络请求。

工作目录：`C:/Users/harry/.codex/worktrees/tenant-foundation/aiShopASAS`；分支 `feat/commerce-connector`。

## Boundaries and design choices

- 沿用已批准的 13 个读取/写入/回读方法；所有 list/query 的 `ReadOptions` 独立作为参数，避免把 AbortSignal 当 JSON 字段。`requestId/deadlineAt` 为必须，`signal` 为运行时可选。
- 选择共享 strict DTO + port + 纯解析函数。只写 interface 无法验证平台输出；立即加入 Mock 状态/同步/执行模块会越过本阶段范围。
- 原草案的读取 Promise DTO 使用 `ConnectorResult<T>` 显式区分正常结果与标准 failure；不支持、失败不能伪装为空页。写入始终返回 ACCEPTED / REJECTED / UNKNOWN receipt，UNKNOWN 需要独立 verify。
- scope 绑定只有标识，不含 token/secretRef；未来 Factory 必须从可信 TenantContext 验证真实 Store/Connection ownership，不能靠本契约证明授权。
- 金额为 CNY 的安全整数分；金额、成本和库存未知时用 null，禁止用零伪装缺数据。校验已知行金额、订单 payable 与退款/支付关系；允许部分来源数据但明确质量问题。
- 外部 ID 保持字符串，限制长度与控制字符；不作为内部主键，也不拼接 SQL/URL。文本去边缘空白、拒绝控制字符，按普通数据处理；后续 UI 转义、LLM data envelope 与 provider URL 编码仍须执行。
- 列表 limit 1–200；cursor 有界且不得重复原 cursor；source watermark 不超过请求 until。调用 deadline 使用真实安全时钟，后续 Mock 数据时钟独立。
- 写 command 有 executionId/idempotencyKey、expectedVersion 和旧值；库存是 targetAvailable，禁止相对 increment。声明 idempotency/precondition 能力不等于批准写操作或保证网络失败可重试。
- 无真实 Douyin/Jev/LLM、Mock generator、Agent/ActionEngine、public HTTP endpoint、UI 或 schema 变更。
- 每个独立可验证部分单独提交；生产函数少于 40 行，无 any；关键路径先红后绿。

## Task 1: Primitive, scope, capability and read query contracts

Create `packages/contracts/src/commerce/connector-common.schema.ts` and `.spec.ts`。

Produces: CurrencySchema、MinorAmountSchema、QuantitySchema、ExternalIdSchema、SourceVersionSchema、CommerceTextSchema、ConnectorTimestampSchema、ConnectorBindingSchema、ConnectorCapabilitiesSchema、ConnectorFailureCodeSchema、ConnectorFailureSchema、ReadOptionsSchema、SyncPageQuerySchema、InventoryQuerySchema、MarketingQuerySchema、ExternalProductRefSchema、ExternalOrderRefSchema、ConnectorPageSchema<T>、ConnectorResultSchema<T>。

字段：Binding={organizationId,workspaceId,storeId,connectionId,externalStoreId}；capabilities={readProducts,readOrders,readRefunds,readInventory,readMarketing,writePrice,writeInventory,publishProduct,webhookMode,idempotencyMode,preconditionMode}。
Failure={code,retryAfterMs:null|positive integer}；ReadOptions={requestId,deadlineAt}；SyncPage={cursor?,since?,until,limit}；Inventory={cursor?,until,limit,externalSkuIds?:1–200 unique IDs}；Marketing={cursor?,since,until,limit}。

- [x] 写 ID/整数精度、strict unknown fields、时间顺序、重复 SKU、capability/failure/页形状测试。
- [x] 红灯命令：`pnpm --filter @shopmate/contracts exec vitest run src/commerce/connector-common.schema.spec.ts`。
- [x] 实现 z.strictObject 与有界 primitives；scope 使用既有 TenantIdSchema，时间使用 offset-aware ISO schema 并比较实际 instant。

```ts
export const MinorAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ReadOptionsSchema = z.strictObject({
  requestId: TenantIdSchema,
  deadlineAt: ConnectorTimestampSchema,
});
export function ConnectorPageSchema<T extends z.ZodType>(item: T) {
  return z
    .strictObject({
      items: z.array(item).max(200).readonly(),
      nextCursor: CursorSchema.nullable(),
      observedAt: ConnectorTimestampSchema,
      sourceWatermark: ConnectorTimestampSchema.nullable(),
    })
    .readonly();
}
```

- [x] 绿灯并提交 `feat(contracts): define connector scope and read protocols`。

## Task 2: PII-free source commerce DTOs

Create `connector-data.schema.ts` and `.spec.ts`，消费 Task1 primitives。

Produces: ConnectorSourceSchema、ConnectorStoreSchema、ConnectorSkuSchema、ConnectorProductSchema、ConnectorOrderItemSchema、ConnectorOrderSchema、ConnectorRefundSchema、ConnectorInventorySchema、ConnectorCampaignMetricSchema。

所有实体有 externalStoreId；source={version:null|string,updatedAt:null|ISO,quality:{state:COMPLETE|PARTIAL,issues:unique enum[]}}。
Store={externalStoreId,name,category:null|string,currency,timeZone,source}。
Sku={externalSkuId,externalProductId,attributes:name/value[],salePriceMinor,costPriceMinor:null|minor,originalPriceMinor:null|minor,status}。
Product={externalStoreId,externalProductId,title,description:null|string,category:null|string,brand:null|string,status,skus:1–500,source}。
OrderItem={externalLineId,externalProductId,externalSkuId,quantity,unitPriceMinor,grossMinor,discountMinor,netMinor}。
Order={externalStoreId,externalOrderId,status,orderedAt,paidAt:null|ISO,currency,items:1–500,grossMinor,discountMinor,shippingMinor,payableMinor,paidMinor:null|minor,refundedMinor:null|minor,source}。
Refund={externalStoreId,externalRefundId,externalOrderId,externalSkuId:null|string,status,requestedMinor,succeededMinor:null|minor,requestedAt,succeededAt:null|ISO,currency,source}。
Inventory={externalStoreId,externalSkuId,externalLocationId,available:null|quantity,reserved:null|quantity,onHand:null|quantity,safetyStock:null|quantity,leadTimeDays:null|0–365 integer,source}。
Campaign={externalStoreId,externalCampaignId,date:ISO date,impressions:null|quantity,clicks:null|quantity,attributedOrders:null|quantity,spendMinor:null|minor,attributedRevenueMinor:null|minor,currency,source}。

- [x] 写合法商品/订单/退款/库存/营销与未知值、金额守恒、关系 ID、重复 line/SKU、消费者 PII/凭据额外字段拒绝测试。
- [x] 红灯命令：`pnpm --filter @shopmate/contracts exec vitest run src/commerce/connector-data.schema.spec.ts`。
- [x] 实现以上完整字段及跨字段 refine；已知金额计算仍检查安全整数；未知金额不参与虚构计算。

```ts
// 已知订单必须可复算；不推导未提供的支付/成本字段。
const expectedPayable = order.grossMinor - order.discountMinor + order.shippingMinor;
Number.isSafeInteger(expectedPayable) && expectedPayable === order.payableMinor;
```

- [x] 绿灯并提交 `feat(contracts): validate normalized commerce source data`。

## Task 3: Absolute write commands, receipt and independent verification

Create `connector-action.schema.ts` and `.spec.ts`，消费 Task1 primitives。

Produces: SetPriceCommandSchema、SetInventoryCommandSchema、ListingInputSchema、CreateProductCommandSchema、UpdateProductCommandSchema、WriteReceiptSchema、VerifiedActionSnapshotSchema、VerifyActionQuerySchema、VerificationResultSchema。

共同 command={executionId,idempotencyKey}；price={externalSkuId,expectedVersion,oldPriceMinor,newPriceMinor,currency}；inventory={externalSkuId,externalLocationId,expectedVersion,oldAvailable,targetAvailable}。
Listing={title,description,category,brand:null|string,skus:1–500 each{sellerSkuCode,attributes,salePriceMinor,currency}}。
Create={executionId,idempotencyKey,listing}；Update 同 create 加 externalProductId/expectedVersion。
Receipt={executionId,platformRequestId:null|string,receivedAt,outcome,failureCode}；ACCEPTED failureCode=null，REJECTED/UNKNOWN 必须标准 failure code。
Snapshot union：PRICE / INVENTORY 包含定位、expected/actual absolute value、version、observedAt；PRODUCT 包含 externalProductId、expected/actual listing 与 version/observedAt。
VerifyQuery={executionId,expected:PRICE|INVENTORY|PRODUCT expected-value union}。
Result={VERIFIED|MISMATCH,snapshot} 或 {PENDING,retryAfterMs} 或 {UNAVAILABLE,reason}；VERIFIED 必须 actual===expected、MISMATCH 必须存在差异。

- [x] 写命令精度/relative increments/tenant override/重复 SKU/UNKNOWN/假 VERIFIED/空 PENDING 等失败测试。
- [x] 红灯命令：`pnpm --filter @shopmate/contracts exec vitest run src/commerce/connector-action.schema.spec.ts`。
- [x] 用 discriminatedUnion 实现结果，不把 ACCEPTED 解释为 VERIFIED。

```ts
z.strictObject({
  outcome: z.literal("ACCEPTED"),
  executionId: TenantIdSchema,
  platformRequestId: ExternalIdSchema.nullable(),
  receivedAt: ConnectorTimestampSchema,
  failureCode: z.null(),
});
```

- [x] 绿灯并提交 `feat(contracts): define safe connector writes and verification`。

## Task 4: Port, scoped parsers and public exports

Create `commerce-connector.ts`、`connector-validation.ts`、`connector-validation.spec.ts`；modify `src/index.ts`。

Produces: CommerceConnector、ReadOptions（schema 类型 + readonly signal?:AbortSignal）、ConnectorResult<T>；
`parseConnectorRead<T extends {externalStoreId:string}>(schema, externalStoreId:unknown, payload:unknown)` 和
`parseConnectorPage<T extends {externalStoreId:string}>(schema, externalStoreId:unknown, query:unknown, payload:unknown)`。
它们失败返回标准 INVALID_INPUT/INVALID_RESPONSE，不返回原值/Zod issue/平台 message。页校验 limit、cursor 前进、水位 cutoff、店铺一致。

```ts
export interface CommerceConnector {
  readonly binding: ConnectorBinding;
  readonly capabilities: ConnectorCapabilities;
  getStore(options: ReadOptions): Promise<ConnectorResult<ConnectorStore>>;
  listProducts(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorProduct>>>;
  getProduct(
    ref: ExternalProductRef,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorProduct>>;
  listOrders(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorOrder>>>;
  getOrder(ref: ExternalOrderRef, options: ReadOptions): Promise<ConnectorResult<ConnectorOrder>>;
  listRefunds(
    query: SyncPageQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorRefund>>>;
  getInventory(
    query: InventoryQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorInventory>>>;
  getMarketingMetrics(
    query: MarketingQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<ConnectorPage<ConnectorCampaignMetric>>>;
  updatePrice(command: SetPriceCommand, options: ReadOptions): Promise<WriteReceipt>;
  updateInventory(command: SetInventoryCommand, options: ReadOptions): Promise<WriteReceipt>;
  createProduct(command: CreateProductCommand, options: ReadOptions): Promise<WriteReceipt>;
  updateProduct(command: UpdateProductCommand, options: ReadOptions): Promise<WriteReceipt>;
  verifyAction(
    query: VerifyActionQuery,
    options: ReadOptions,
  ): Promise<ConnectorResult<VerificationResult>>;
}
```

- [x] schema/validator 红灯，覆盖跨店铺、非法 payload 的敏感字段不回传、cursor stall、over-limit、future watermark、offset 等价时刻。
- [x] 实现纯函数、公共 exports 和 port；source data/parser 不接受 credential 参数。
- [x] 绿灯；contracts test/lint/typecheck、API/Web typecheck/build、格式、secret scan、独立只读 review。
- [x] 提交 `feat(contracts): expose validated commerce connector boundary`。

## Delivery

- [x] 检查仅本阶段 diff，更新每个 task 状态、红绿灯及实际测试数字。
- [x] 编写 12 项交付说明，明确契约可执行但未接入实际 Mock/平台、未做 Factories/审批/执行。
- [x] 保留当前 worktree 与独立 feat branch，不自动 merge/push/deploy。

## Final execution record

交付说明：[CommerceConnector Contract Delivery](./2026-10-03-commerce-connector-delivery.md)。代码从 `f4ab8c9` 开始，最终生产修复提交 `9c917b8`；`2b6d290` 扩大测试类型门禁，`29fca18` 独立提交交付文档。

| Task           | 红灯证据                          | 当前绿灯证据                                    | 功能提交  |
| -------------- | --------------------------------- | ----------------------------------------------- | --------- |
| 1 common       | 先测试，缺 schema module 失败     | 30 tests                                        | `661f5d1` |
| 2 source data  | 先测试，缺 schema module 失败     | 31 tests                                        | `f356e56` |
| 3 actions      | 先测试，缺 schema module 失败     | 16 tests                                        | `3b64480` |
| 4 port/parsers | 先测试，缺 validation module 失败 | 35 tests（port 2 / pages 23 / verification 10） | `a290995` |

新增总计 112 tests；contracts 当前 348 passed。完整全仓 `pnpm test` 1,124 passed、9 项既有 opt-in API 测试 skipped；lint/typecheck/build/format/secret scan/diff check 通过。无数据库/API/UI source 变更，无截图验收、平台请求、合并、推送或部署。

实施后的安全增强仍在本阶段纯契约范围：

- 支付金额未知时，已知退款仍不能超过已知应付金额；回读 query 的嵌套预期值冻结。
- 拒绝 C1 控制字符；文本 CRLF/CR 归一 LF 后做长度与字符检查。
- listing 比较使用确定性的 code-unit 排序，处理 locale collation 等价的外部 ID。
- 订单支付/退款缺失分别使用 PAYMENT_UNKNOWN / REFUND_UNKNOWN。
- 状态与金额矛盾只能带 PARTIAL + SOURCE_INCONSISTENT；已支付但缺时间另需 PAYMENT_UNKNOWN，保留可辨认的来源异常。
- 分页 source.updatedAt 与 watermark 的已知值均不能超出 min(until,observedAt)。泛型页 parser 明确需要 source metadata；下界、营销业务日期与 SKU 过滤由 adapter 实施。
- 新增 parseConnectorVerification，核对可信店铺、executionId、kind、资源 ID 与原请求 expected state。验证结果的四种状态都必须带 executionId，单纯 VerificationResultSchema 不证明请求关联。

每项修复先加入可复现失败的回归测试，再实现并分别提交。独立 reviewer 于 `918b0b5` 提出四项 Important、两项 Minor，于 `9c917b8` 复审关闭全部六项；16 个独立运行时探针通过，无剩余 Critical/Important。

最初增加仅检查新 commerce 测试的 config，最终升级为 contracts 全测试文件 typecheck。扩大的扫描发现既有 dashboard-insight fixture 的 readonly filters 在六处调用不兼容；改为 satisfies DashboardInsightQuery 后，其 20 项测试与全部测试类型检查通过。该测试门禁调整独立提交，旧生产行为未改变。

保留 worktree/feat branch；下一阶段为 Mock 源状态与确定性时钟，不将本契约交付等同于已实现平台 adapter 或执行授权。
