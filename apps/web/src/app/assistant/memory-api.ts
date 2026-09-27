import {
  AssistantMemoryListResponseSchema,
  AssistantWorkspaceReadResponseSchema,
  AssistantWorkspaceSaveResponseSchema,
  type AssistantMemory,
  type AssistantWorkspaceReadResponse,
  type WorkspaceSnapshot,
} from "@shopmate/contracts";

import { AssistantTransportError } from "./transport";

export async function listMemories(): Promise<AssistantMemory[]> {
  const response = await request("/api/v1/ai/memories", "GET");
  const parsed = AssistantMemoryListResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new AssistantTransportError("记忆数据格式异常，请刷新后重试。");
  return parsed.data.items;
}

export async function deleteMemory(id: string): Promise<void> {
  await request(`/api/v1/ai/memories/${encodeURIComponent(id)}`, "DELETE");
}

export async function clearMemories(): Promise<void> {
  await request("/api/v1/ai/memories", "DELETE");
}

export class WorkspaceConflictError extends Error {}

/** 服务端对话记录的读写，供 AssistantStore 同步使用。 */
export const workspaceRemote = {
  async load(): Promise<AssistantWorkspaceReadResponse> {
    const response = await request("/api/v1/ai/workspace", "GET");
    const parsed = AssistantWorkspaceReadResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new AssistantTransportError("对话记录格式异常。");
    return parsed.data;
  },
  async save(snapshot: WorkspaceSnapshot, expectedRevision: number): Promise<number> {
    const response = await request("/api/v1/ai/workspace", "PUT", { snapshot, expectedRevision });
    const parsed = AssistantWorkspaceSaveResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new AssistantTransportError("对话同步结果格式异常。");
    return parsed.data.revision;
  },
  async delete(): Promise<void> {
    await request("/api/v1/ai/workspace", "DELETE");
  },
};
export type WorkspaceRemote = typeof workspaceRemote;

async function request(url: string, method: "GET" | "PUT" | "DELETE", body?: unknown) {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AssistantTransportError("无法连接服务，请检查网络。");
  }
  if (response.status === 409) throw new WorkspaceConflictError("对话记录已在其他设备更新。");
  if (!response.ok) {
    const message =
      response.status === 401
        ? "登录已失效，请重新登录。"
        : response.status === 413
          ? "对话记录超过 2 MiB，请删除不需要的会话。"
          : "服务暂时不可用，请稍后重试。";
    throw new AssistantTransportError(message, response.status);
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
