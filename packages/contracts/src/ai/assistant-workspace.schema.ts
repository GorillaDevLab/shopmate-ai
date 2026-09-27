import { z } from "zod";
import { AssistantReplySchema } from "./assistant-run.schema.js";
import { DashboardInsightQuerySchema } from "./dashboard-insight.schema.js";
import { DashboardChartViewSchema } from "./dashboard-insight.schema.js";
import { AgentActionOutcomeSchema, AgentActionTokenSchema } from "./agent-actions.schema.js";

export const AssistantIdentitySchema = z.strictObject({
  userId: z.string().min(1).max(200),
  merchantId: z.string().min(1).max(200),
});
export const WorkspaceMessageSchema = AssistantReplySchema.extend({
  id: z.string().min(1).max(128),
  role: z.enum(["user", "assistant"]),
  createdAt: z.string().datetime(),
  status: z.enum(["complete", "failed", "stopped"]),
  chartView: DashboardChartViewSchema.optional(),
  actionOutcomes: z.record(AgentActionTokenSchema, AgentActionOutcomeSchema).optional(),
});
export const WorkspaceSessionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(80),
  draft: z.string().max(2000),
  updatedAt: z.string().datetime(),
  messages: z.array(WorkspaceMessageSchema).max(100),
  query: DashboardInsightQuerySchema.optional(),
});
export const WorkspaceSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    sessions: z.array(WorkspaceSessionSchema).max(30),
    currentId: z.string().max(128),
  })
  .refine(
    (value) =>
      new Set(value.sessions.map((s) => s.id)).size === value.sessions.length &&
      (!value.currentId || value.sessions.some((s) => s.id === value.currentId)),
    "Invalid session references",
  );
export type WorkspaceMessage = z.infer<typeof WorkspaceMessageSchema>;
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export type AssistantIdentity = z.infer<typeof AssistantIdentitySchema>;
