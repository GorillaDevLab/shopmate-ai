import { z } from "zod";

import { WorkspaceSnapshotSchema } from "./assistant-workspace.schema.js";

export const ASSISTANT_MEMORY_LIMIT = 30;
export const ASSISTANT_MEMORY_MAX_LENGTH = 200;
/** 与本地缓存一致的上限，避免同步把超大历史写进数据库。 */
export const ASSISTANT_WORKSPACE_MAX_BYTES = 2 * 1024 * 1024;

const POSTGRESQL_INT_MAX = 2_147_483_647;

export const AssistantMemoryContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(ASSISTANT_MEMORY_MAX_LENGTH)
  // 偏好是单行短句；去掉换行，避免被拼进提示词时伪装成新的段落或指令。
  .transform((value) => value.replace(/\s+/gu, " "));

export const AssistantMemorySchema = z.strictObject({
  id: z.string().min(1).max(64),
  content: z.string().min(1).max(ASSISTANT_MEMORY_MAX_LENGTH),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AssistantMemory = z.infer<typeof AssistantMemorySchema>;

export const AssistantMemoryListResponseSchema = z.strictObject({
  items: z.array(AssistantMemorySchema).max(ASSISTANT_MEMORY_LIMIT),
});
export type AssistantMemoryListResponse = z.infer<typeof AssistantMemoryListResponseSchema>;

const revisionSchema = z.number().int().min(0).max(POSTGRESQL_INT_MAX);

export const AssistantWorkspaceReadResponseSchema = z.strictObject({
  snapshot: WorkspaceSnapshotSchema.nullable(),
  revision: revisionSchema,
});
export type AssistantWorkspaceReadResponse = z.infer<typeof AssistantWorkspaceReadResponseSchema>;

export const AssistantWorkspaceSaveRequestSchema = z.strictObject({
  snapshot: WorkspaceSnapshotSchema,
  expectedRevision: revisionSchema,
});
export type AssistantWorkspaceSaveRequest = z.infer<typeof AssistantWorkspaceSaveRequestSchema>;

export const AssistantWorkspaceSaveResponseSchema = z.strictObject({ revision: revisionSchema });
