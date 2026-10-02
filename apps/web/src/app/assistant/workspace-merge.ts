import type { WorkspaceSession, WorkspaceSnapshot } from "@shopmate/contracts";

const MAX_SESSIONS = 30;

/**
 * 合并服务端与本机的对话记录：同一会话取更新时间较晚、消息较多的一份，
 * 其余会话取并集，按更新时间倒序保留最近 30 个。
 * 取舍：在一台设备删除、另一台仍保留的会话，合并后会重新出现——宁可多留，不丢对话。
 */
export function mergeWorkspaces(
  remote: WorkspaceSnapshot,
  local: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const byId = new Map<string, WorkspaceSession>();
  for (const session of [...remote.sessions, ...local.sessions]) {
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? newer(existing, session) : session);
  }
  const sessions = [...byId.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSIONS);
  const ids = new Set(sessions.map((session) => session.id));
  const currentId = ids.has(local.currentId)
    ? local.currentId
    : ids.has(remote.currentId)
      ? remote.currentId
      : (sessions[0]?.id ?? "");
  return { version: 1, sessions, currentId };
}

function newer(a: WorkspaceSession, b: WorkspaceSession): WorkspaceSession {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return b.messages.length > a.messages.length ? b : a;
}

export function sameWorkspace(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return JSON.stringify(a.sessions) === JSON.stringify(b.sessions);
}
