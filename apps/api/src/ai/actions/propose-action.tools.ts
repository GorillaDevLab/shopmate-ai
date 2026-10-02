import {
  AgentActionProposalSchema,
  DashboardInsightQuerySchema,
  MonitoringRuleCreateRequestSchema,
  type AgentActionProposal,
  type DashboardInsightQuery,
  type JsonObject,
  type MonitoringRuleCreateRequest,
} from "@shopmate/contracts";
import { z } from "zod";

import { AuthPermission } from "../../auth/contracts/auth-context.js";
import type { InventoryAlertUpdateRepository } from "../tools/inventory-alert-update.repository.js";
import type { ToolRegistration, ToolSchema } from "../tools/tool-registry.js";
import type { AgentActionStore } from "./agent-action-store.js";

export const PROPOSE_INVENTORY_THRESHOLD = "propose_inventory_threshold_change";
export const PROPOSE_MONITORING_RULE = "propose_monitoring_alert";
export const PROPOSE_SAVE_CHART = "propose_save_chart";
export const PROPOSE_ACTION_TOOL_NAMES = [
  PROPOSE_INVENTORY_THRESHOLD,
  PROPOSE_MONITORING_RULE,
  PROPOSE_SAVE_CHART,
] as const;

const CONFIRM_HINT = "已生成确认卡片，尚未执行；请告诉用户在下方卡片确认后才会生效。";

const ProposalOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    data: z.strictObject({ proposal: AgentActionProposalSchema, note: z.string() }),
  }),
  z.strictObject({
    status: z.literal("error"),
    error: z.strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  }),
]);
type ProposalOutput = z.infer<typeof ProposalOutputSchema>;

function schema<T>(value: z.ZodType<T>): ToolSchema<T> {
  return { jsonSchema: z.toJSONSchema(value) as JsonObject, parse: (input) => value.parse(input) };
}

function proposed(proposal: AgentActionProposal): ProposalOutput {
  return { status: "ok", data: { proposal, note: CONFIRM_HINT } };
}

const InventoryInput = z.strictObject({
  skuId: z.string().trim().min(1).max(128),
  targetAlertThreshold: z.number().int().min(0).max(1_000_000),
  reason: z.string().trim().min(1).max(120),
});

export function createProposeInventoryThresholdTool(
  store: AgentActionStore,
  repository: Pick<InventoryAlertUpdateRepository, "findSkuSnapshot">,
): ToolRegistration<z.infer<typeof InventoryInput>, ProposalOutput> {
  return {
    name: PROPOSE_INVENTORY_THRESHOLD,
    description:
      "提议修改某个 SKU 的库存预警阈值（低于该库存时预警）。只生成确认卡片，不会立即修改；用户确认后才执行。skuId 必须来自库存或商品工具结果。",
    requiredPermissions: [AuthPermission.InventoryWrite],
    input: schema(InventoryInput),
    output: schema(ProposalOutputSchema),
    handler: async (input, context) => {
      const snapshot = await repository.findSkuSnapshot(context.merchantId, input.skuId);
      if (!snapshot) {
        return {
          status: "error",
          error: { code: "NOT_FOUND", message: "找不到该 SKU。", retryable: false },
        };
      }
      const proposal = store.propose(
        context,
        {
          title: "修改库存预警阈值",
          summary: input.reason,
          details: [
            { label: "SKU", value: input.skuId },
            { label: "当前阈值", value: String(snapshot.alertThreshold) },
            { label: "调整为", value: String(input.targetAlertThreshold) },
          ],
        },
        {
          kind: "updateInventoryThreshold",
          skuId: snapshot.skuId,
          expectedAlertThreshold: snapshot.alertThreshold,
          expectedSkuUpdatedAt: snapshot.updatedAt,
          targetAlertThreshold: input.targetAlertThreshold,
        },
      );
      return proposed(proposal);
    },
  };
}

const ruleName = z.string().trim().min(1).max(60);
const frequency = z.enum(["daily", "weekly"]);
// 监听规则内部以“分”比较金额；模型按“元”填写，由工具换算，避免差 100 倍。
// 工具参数的 JSON Schema 顶层必须是 object（OpenAI 兼容接口不接受 oneOf），
// 所以用扁平结构 + 校验来表达“销售类 / 库存类”两种规则。
const MonitoringInput = z
  .strictObject({
    kind: z.enum(["salesThreshold", "inventoryThreshold"]),
    name: ruleName,
    metric: z.enum(["revenue", "orderCount", "unitsSold", "averageOrderValue"]).optional(),
    operator: z.enum(["above", "below"]).optional(),
    threshold: z.number().finite().nonnegative().max(1_000_000_000),
    window: z.enum(["7d", "30d", "90d"]).optional(),
    frequency,
  })
  .superRefine((input, context) => {
    if (input.kind === "salesThreshold" && (!input.metric || !input.operator || !input.window)) {
      context.addIssue({ code: "custom", message: "销售类监听需要 metric、operator 和 window" });
    }
    if (input.kind === "inventoryThreshold" && !Number.isInteger(input.threshold)) {
      context.addIssue({ code: "custom", message: "库存阈值必须是整数" });
    }
  });
type MonitoringInputValue = z.infer<typeof MonitoringInput>;
const MONEY_METRICS = new Set(["revenue", "averageOrderValue"]);

export function createProposeMonitoringRuleTool(
  store: AgentActionStore,
): ToolRegistration<MonitoringInputValue, ProposalOutput> {
  return {
    name: PROPOSE_MONITORING_RULE,
    description:
      "提议创建一条经营监听规则：销售额/订单数/销量/客单价在最近 7/30/90 天高于或低于阈值时提醒，或任一商品库存低于阈值时提醒。销售额、客单价的 threshold 以元为单位。只生成确认卡片，用户确认后才创建。",
    requiredPermissions: [AuthPermission.OrdersRead],
    input: schema(MonitoringInput),
    output: schema(ProposalOutputSchema),
    handler: (input, context) => {
      const rule = toRule(input);
      return proposed(
        store.propose(
          context,
          { title: "创建经营监听", summary: rule.name, details: describeRule(rule) },
          { kind: "createMonitoringRule", rule },
        ),
      );
    },
  };
}

export function toRule(input: MonitoringInputValue): MonitoringRuleCreateRequest {
  if (input.kind === "inventoryThreshold") {
    return MonitoringRuleCreateRequestSchema.parse({
      name: input.name,
      definition: {
        kind: "inventoryThreshold",
        metric: "inventory",
        operator: "below",
        threshold: input.threshold,
        scope: "allProducts",
        productIds: [],
        frequency: input.frequency,
      },
    });
  }
  const metric = input.metric ?? "revenue";
  const threshold = MONEY_METRICS.has(metric) ? Math.round(input.threshold * 100) : input.threshold;
  return MonitoringRuleCreateRequestSchema.parse({
    name: input.name,
    definition: {
      kind: "salesThreshold",
      metric,
      operator: input.operator,
      threshold,
      window: input.window,
      frequency: input.frequency,
    },
  });
}

const ChartInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  query: DashboardInsightQuerySchema,
});

export function createProposeSaveChartTool(
  store: AgentActionStore,
): ToolRegistration<z.infer<typeof ChartInput>, ProposalOutput> {
  return {
    name: PROPOSE_SAVE_CHART,
    description:
      "提议把一张图表保存到经营分析首页。query 使用与 create_business_chart 相同的结构；只生成确认卡片，用户确认后才保存。",
    requiredPermissions: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
    input: schema(ChartInput),
    output: schema(ProposalOutputSchema),
    handler: ({ title, query }, context) =>
      proposed(
        store.propose(
          context,
          { title: "保存图表到经营分析", summary: title, details: describeChart(query) },
          { kind: "saveChartToAnalytics", title, query },
        ),
      ),
  };
}

const METRIC_LABELS: Record<string, string> = {
  revenue: "销售额",
  orderCount: "订单数",
  unitsSold: "销量",
  averageOrderValue: "客单价",
  inventory: "库存",
  productCount: "商品数",
};
const GROUP_LABELS: Record<string, string> = {
  date: "按日期",
  product: "按商品",
  sku: "按 SKU",
  store: "按门店 / 店铺",
  platform: "按平台",
  orderStatus: "按订单状态",
  inventoryRisk: "按库存风险",
};
const WINDOW_LABELS: Record<string, string> = {
  "7d": "近 7 天",
  "30d": "近 30 天",
  "90d": "近 90 天",
};

function describeRule({ definition }: MonitoringRuleCreateRequest) {
  const direction = definition.operator === "above" ? "高于" : "低于";
  const condition =
    definition.kind === "salesThreshold"
      ? `${WINDOW_LABELS[definition.window]}${METRIC_LABELS[definition.metric]}${direction} ${formatThreshold(definition.metric, definition.threshold)}`
      : `任一商品库存${direction} ${definition.threshold} 件`;
  return [
    { label: "条件", value: condition },
    { label: "检查频率", value: definition.frequency === "daily" ? "每天" : "每周" },
  ];
}

function formatThreshold(metric: string, threshold: number): string {
  if (MONEY_METRICS.has(metric)) {
    return `¥${(threshold / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${threshold} ${metric === "orderCount" ? "单" : "件"}`;
}

function describeChart(query: DashboardInsightQuery) {
  return [
    { label: "指标", value: METRIC_LABELS[query.metric] ?? query.metric },
    {
      label: "分组",
      value: query.groupBy ? (GROUP_LABELS[query.groupBy] ?? query.groupBy) : "不分组",
    },
    { label: "时段", value: "跟随经营分析页选择的时段" },
  ];
}
