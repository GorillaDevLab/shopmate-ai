import { z } from "zod";

export const MonitoringFrequencySchema = z.enum(["daily", "weekly"]);
export type MonitoringFrequency = z.infer<typeof MonitoringFrequencySchema>;

export const SalesThresholdRuleSchema = z.strictObject({
  kind: z.literal("salesThreshold"),
  metric: z.enum(["revenue", "orderCount", "unitsSold", "averageOrderValue"]),
  operator: z.enum(["above", "below"]),
  threshold: z.number().finite().nonnegative(),
  window: z.enum(["7d", "30d", "90d"]),
  frequency: MonitoringFrequencySchema,
});

export const InventoryThresholdRuleSchema = z.strictObject({
  kind: z.literal("inventoryThreshold"),
  metric: z.literal("inventory"),
  operator: z.literal("below"),
  threshold: z.number().int().min(0).max(1_000_000),
  scope: z.literal("allProducts"),
  productIds: z.array(z.string().trim().min(1).max(128)).max(20),
  frequency: MonitoringFrequencySchema,
});

export const MonitoringRuleDefinitionSchema = z.discriminatedUnion("kind", [
  SalesThresholdRuleSchema,
  InventoryThresholdRuleSchema,
]);
export type MonitoringRuleDefinition = z.infer<typeof MonitoringRuleDefinitionSchema>;

export const MonitoringRuleStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type MonitoringRuleStatus = z.infer<typeof MonitoringRuleStatusSchema>;

export const MonitoringSeveritySchema = z.enum(["INFO", "WARNING", "CRITICAL"]);
export type MonitoringSeverity = z.infer<typeof MonitoringSeveritySchema>;

export const MonitoringResourceTypeSchema = z.enum(["MERCHANT", "SKU"]);
export type MonitoringResourceType = z.infer<typeof MonitoringResourceTypeSchema>;
