import {
  WorkspaceSnapshotSchema,
  type AssistantIdentity,
  type WorkspaceMessage,
  type WorkspaceSnapshot,
} from "@shopmate/contracts";

export const STORAGE_PREFIX = "shopmate.assistant.v1:";
export const EMPTY_WORKSPACE: WorkspaceSnapshot = { version: 1, sessions: [], currentId: "" };
export function workspaceKey(identity: AssistantIdentity) {
  return STORAGE_PREFIX + JSON.stringify([identity.merchantId, identity.userId]);
}
export function readWorkspace(raw: string | null): WorkspaceSnapshot {
  if (!raw) return EMPTY_WORKSPACE;
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024)
    throw new Error("会话历史超过存储上限。");
  return WorkspaceSnapshotSchema.parse(JSON.parse(raw));
}
export function writeWorkspace(value: WorkspaceSnapshot): string {
  const raw = JSON.stringify(WorkspaceSnapshotSchema.parse(value));
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024)
    throw new Error("会话历史超过 2 MiB，请删除不需要的会话。");
  return raw;
}
export function newId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function historyFor(messages: readonly WorkspaceMessage[]) {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (let index = 0; index < messages.length - 1; index++) {
    const user = messages[index]!,
      assistant = messages[index + 1]!;
    if (user.role === "user" && assistant.role === "assistant" && assistant.status === "complete") {
      turns.push(
        { role: "user", content: user.content },
        { role: "assistant", content: assistant.content },
      );
      index++;
    }
  }
  const bounded = turns.slice(-12);
  while (bounded.reduce((sum, m) => sum + m.content.length, 0) > 24000) bounded.splice(0, 2);
  return bounded;
}
