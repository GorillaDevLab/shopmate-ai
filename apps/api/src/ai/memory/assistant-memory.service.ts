import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  ASSISTANT_MEMORY_LIMIT,
  ASSISTANT_WORKSPACE_MAX_BYTES,
  AssistantMemoryContentSchema,
  AssistantMemoryListResponseSchema,
  AssistantWorkspaceReadResponseSchema,
  AssistantWorkspaceSaveRequestSchema,
  WorkspaceSnapshotSchema,
  type AssistantMemoryListResponse,
  type AssistantWorkspaceReadResponse,
} from "@shopmate/contracts";

import type { AuthContext } from "../../auth/contracts/index.js";
import type { AssistantMemoryRepository } from "./assistant-memory.repository.js";
import type { AssistantWorkspaceRepository } from "./assistant-workspace.repository.js";

export type RememberResult =
  | { readonly kind: "saved" | "exists"; readonly content: string }
  | { readonly kind: "full" }
  | { readonly kind: "invalid" };

export class AssistantMemoryService {
  private readonly logger = new Logger(AssistantMemoryService.name);

  constructor(private readonly memories: AssistantMemoryRepository) {}

  async list(context: AuthContext): Promise<AssistantMemoryListResponse> {
    const records = await this.memories.list(context);
    return AssistantMemoryListResponseSchema.parse({
      items: records.map((record) => ({
        id: record.id,
        content: record.content,
        createdAt: record.createdAt.toISOString(),
      })),
    });
  }

  async remember(context: AuthContext, rawContent: unknown): Promise<RememberResult> {
    const content = AssistantMemoryContentSchema.safeParse(rawContent);
    if (!content.success) return { kind: "invalid" };
    if ((await this.memories.count(context)) >= ASSISTANT_MEMORY_LIMIT) return { kind: "full" };
    const created = await this.memories.create(context, content.data);
    return { kind: created ? "saved" : "exists", content: content.data };
  }

  /** 读取失败不应让对话失败：没有偏好上下文时 AI 仍能正常回答。 */
  async promptContext(context: AuthContext): Promise<string[]> {
    try {
      return (await this.memories.list(context)).map((record) => record.content);
    } catch (error: unknown) {
      this.logger.warn(
        `读取偏好失败，本轮不带偏好：${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  async delete(context: AuthContext, id: string): Promise<void> {
    if (!(await this.memories.delete(context, id)))
      throw new NotFoundException({ code: "MEMORY_NOT_FOUND" });
  }

  clear(context: AuthContext): Promise<void> {
    return this.memories.clear(context);
  }
}

export class AssistantWorkspaceService {
  constructor(private readonly workspaces: AssistantWorkspaceRepository) {}

  async get(context: AuthContext): Promise<AssistantWorkspaceReadResponse> {
    const record = await this.workspaces.find(context);
    if (!record) return { snapshot: null, revision: 0 };
    // 存量记录校验失败（如格式升级）时视为空，客户端会用本地缓存重新上传。
    const snapshot = WorkspaceSnapshotSchema.safeParse(record.snapshot);
    return AssistantWorkspaceReadResponseSchema.parse({
      snapshot: snapshot.success ? snapshot.data : null,
      revision: record.revision,
    });
  }

  async save(context: AuthContext, rawBody: unknown): Promise<{ revision: number }> {
    const request = AssistantWorkspaceSaveRequestSchema.safeParse(rawBody);
    if (!request.success) throw new BadRequestException({ code: "INVALID_WORKSPACE" });
    const bytes = Buffer.byteLength(JSON.stringify(request.data.snapshot), "utf8");
    if (bytes > ASSISTANT_WORKSPACE_MAX_BYTES) {
      throw new HttpException(
        { code: "WORKSPACE_TOO_LARGE", message: "对话记录超过 2 MiB，请删除不需要的会话。" },
        413,
      );
    }
    const result = await this.workspaces.save(
      context,
      request.data.snapshot,
      request.data.expectedRevision,
    );
    if (result.kind === "conflict") throw new ConflictException({ code: "WORKSPACE_CONFLICT" });
    return { revision: result.revision };
  }

  delete(context: AuthContext): Promise<void> {
    return this.workspaces.delete(context);
  }
}
