import type { WorkspaceSession, WorkspaceSnapshot } from "@shopmate/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceConflictError } from "./memory-api";
import { AssistantStore } from "./store";
import { mergeWorkspaces } from "./workspace-merge";

const identity = { userId: "u", merchantId: "m" };

function session(id: string, updatedAt: string, messages = 0): WorkspaceSession {
  return {
    id,
    title: id,
    draft: "",
    updatedAt,
    messages: Array.from({ length: messages }, (_, i) => ({
      id: `${id}-${i}`,
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      content: "x",
      status: "complete" as const,
      createdAt: updatedAt,
    })),
  };
}
const snapshot = (
  sessions: WorkspaceSession[],
  currentId = sessions[0]?.id ?? "",
): WorkspaceSnapshot => ({
  version: 1,
  sessions,
  currentId,
});

describe("mergeWorkspaces", () => {
  it("keeps sessions from both devices and the newer copy of shared ones", () => {
    const remote = snapshot([
      session("a", "2026-09-28T01:00:00.000Z", 2),
      session("b", "2026-09-28T00:00:00.000Z"),
    ]);
    const local = snapshot(
      [session("a", "2026-09-28T02:00:00.000Z", 4), session("c", "2026-09-28T03:00:00.000Z")],
      "a",
    );
    const merged = mergeWorkspaces(remote, local);
    expect(merged.sessions.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(merged.sessions.find((s) => s.id === "a")?.messages).toHaveLength(4);
    expect(merged.currentId).toBe("a");
  });

  it("keeps at most 30 sessions, newest first", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session(`s${i}`, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()),
    );
    const merged = mergeWorkspaces(snapshot(many.slice(0, 20)), snapshot(many.slice(20)));
    expect(merged.sessions).toHaveLength(30);
    expect(merged.sessions[0]?.id).toBe("s39");
  });
});

describe("AssistantStore account sync", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function remote(initial: WorkspaceSnapshot | null, revision = 0) {
    return {
      load: vi.fn(async () => ({ snapshot: initial, revision })),
      save: vi.fn(async (_snapshot: WorkspaceSnapshot, expected: number) => expected + 1),
      delete: vi.fn(async () => undefined),
    };
  }

  it("shows conversations saved in the account on a new device", async () => {
    const server = remote(snapshot([session("from-phone", "2026-09-28T01:00:00.000Z", 2)]), 3);
    const store = new AssistantStore(localStorage, undefined, server);
    store.activate(identity);
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessions.map((s) => s.id)).toEqual(["from-phone"]),
    );
  });

  it("uploads local changes against the account revision", async () => {
    const server = remote(null, 0);
    const store = new AssistantStore(localStorage, undefined, server);
    store.activate(identity);
    await vi.waitFor(() => expect(server.load).toHaveBeenCalled());
    store.create();
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(server.save.mock.calls[0]?.[1]).toBe(0);
    store.rename(store.getSnapshot().currentId, "改名");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.save.mock.calls[1]?.[1]).toBe(1);
  });

  it("merges and retries once when another device saved first", async () => {
    const server = remote(null, 0);
    const store = new AssistantStore(localStorage, undefined, server);
    store.activate(identity);
    await vi.waitFor(() => expect(server.load).toHaveBeenCalled());
    server.save.mockRejectedValueOnce(new WorkspaceConflictError("conflict"));
    server.load.mockResolvedValueOnce({
      snapshot: snapshot([session("other-device", "2026-09-28T05:00:00.000Z")]),
      revision: 7,
    });
    store.create();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(server.save).toHaveBeenCalledTimes(2));
    expect(server.save.mock.calls[1]?.[1]).toBe(7);
    expect(store.getSnapshot().sessions.map((s) => s.id)).toContain("other-device");
  });

  it("keeps the account history on logout but can delete it on purpose", async () => {
    const server = remote(snapshot([session("a", "2026-09-28T01:00:00.000Z")]), 2);
    const store = new AssistantStore(localStorage, undefined, server);
    store.activate(identity);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.clear();
    expect(server.delete).not.toHaveBeenCalled();
    store.activate(identity);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    await store.deleteAllHistory();
    expect(server.delete).toHaveBeenCalledOnce();
    expect(store.getSnapshot().sessions).toEqual([]);
  });
});
