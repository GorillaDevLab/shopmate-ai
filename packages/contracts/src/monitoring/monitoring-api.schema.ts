import { z } from "zod";

import {
  MonitoringResourceTypeSchema,
  MonitoringRuleDefinitionSchema,
  MonitoringRuleStatusSchema,
  MonitoringSeveritySchema,
} from "./monitoring-rule.schema.js";

const idSchema = z.string().trim().min(1).max(128);
const nameSchema = z.string().trim().min(1).max(80);
const safeTextSchema = z.string().trim().min(1).max(500);
const timestampSchema = z.iso.datetime({ offset: true });

export const MonitoringMatchSchema = z.strictObject({
  resourceType: MonitoringResourceTypeSchema,
  resourceId: idSchema,
  title: z.string().trim().min(1).max(120),
  message: safeTextSchema,
  severity: MonitoringSeveritySchema,
});
export type MonitoringMatch = z.infer<typeof MonitoringMatchSchema>;

export const MonitoringEvaluationSchema = z.strictObject({
  matched: z.boolean(),
  periodStart: timestampSchema,
  periodEnd: timestampSchema,
  matches: z.array(MonitoringMatchSchema).max(20),
});
export type MonitoringEvaluation = z.infer<typeof MonitoringEvaluationSchema>;

export const MonitoringRulePreviewRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
});
export type MonitoringRulePreviewRequest = z.infer<typeof MonitoringRulePreviewRequestSchema>;

export const MonitoringRulePreviewResponseSchema = z.strictObject({
  suggestedName: nameSchema,
  definition: MonitoringRuleDefinitionSchema,
  evaluation: MonitoringEvaluationSchema,
});
export type MonitoringRulePreviewResponse = z.infer<typeof MonitoringRulePreviewResponseSchema>;

export const MonitoringRuleCreateRequestSchema = z.strictObject({
  name: nameSchema,
  definition: MonitoringRuleDefinitionSchema,
});
export type MonitoringRuleCreateRequest = z.infer<typeof MonitoringRuleCreateRequestSchema>;

export const MonitoringRuleStatusRequestSchema = z.strictObject({
  status: MonitoringRuleStatusSchema,
});
export type MonitoringRuleStatusRequest = z.infer<typeof MonitoringRuleStatusRequestSchema>;

export const MonitoringRuleViewSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  definition: MonitoringRuleDefinitionSchema,
  status: MonitoringRuleStatusSchema,
  lastRunAt: timestampSchema.nullable(),
  nextRunAt: timestampSchema,
  lastErrorCode: z.string().trim().min(1).max(80).nullable(),
  lastErrorMessage: safeTextSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type MonitoringRuleView = z.infer<typeof MonitoringRuleViewSchema>;

export const MonitoringRuleResponseSchema = z.strictObject({ rule: MonitoringRuleViewSchema });
export const MonitoringRuleListResponseSchema = z.strictObject({
  items: z.array(MonitoringRuleViewSchema).max(50),
});
export const MonitoringRuleRunResponseSchema = z.strictObject({
  rule: MonitoringRuleViewSchema,
  evaluation: MonitoringEvaluationSchema,
  createdNotifications: z.number().int().min(0).max(20),
});
export const MonitoringSyncResponseSchema = z.strictObject({
  evaluatedRules: z.number().int().min(0).max(10),
  createdNotifications: z.number().int().min(0).max(200),
  failedRules: z.number().int().min(0).max(10),
});

export const MonitoringNotificationViewSchema = z.strictObject({
  id: idSchema,
  ruleId: idSchema,
  ruleName: nameSchema,
  title: z.string().trim().min(1).max(120),
  message: safeTextSchema,
  severity: MonitoringSeveritySchema,
  resourceType: MonitoringResourceTypeSchema,
  resourceId: idSchema,
  periodStart: timestampSchema,
  periodEnd: timestampSchema,
  readAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type MonitoringNotificationView = z.infer<typeof MonitoringNotificationViewSchema>;

export const MonitoringNotificationListResponseSchema = z.strictObject({
  items: z.array(MonitoringNotificationViewSchema).max(50),
});
export const MonitoringUnreadCountResponseSchema = z.strictObject({
  count: z.number().int().min(0),
});
export const MonitoringReadResponseSchema = z.strictObject({
  notification: MonitoringNotificationViewSchema,
});
export const MonitoringReadAllResponseSchema = z.strictObject({
  updated: z.number().int().min(0),
});

export type MonitoringRuleResponse = z.infer<typeof MonitoringRuleResponseSchema>;
export type MonitoringRuleListResponse = z.infer<typeof MonitoringRuleListResponseSchema>;
export type MonitoringRuleRunResponse = z.infer<typeof MonitoringRuleRunResponseSchema>;
export type MonitoringSyncResponse = z.infer<typeof MonitoringSyncResponseSchema>;
export type MonitoringNotificationListResponse = z.infer<
  typeof MonitoringNotificationListResponseSchema
>;
export type MonitoringUnreadCountResponse = z.infer<typeof MonitoringUnreadCountResponseSchema>;
export type MonitoringReadResponse = z.infer<typeof MonitoringReadResponseSchema>;
export type MonitoringReadAllResponse = z.infer<typeof MonitoringReadAllResponseSchema>;
