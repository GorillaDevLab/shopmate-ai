import { describe, it, expect } from "vitest";
import { readWorkspace, writeWorkspace, historyFor, workspaceKey } from "./model";
describe("workspace storage", () => {
  it("separates user and merchant identities", () => {
    expect(workspaceKey({ userId: "a", merchantId: "b" })).not.toBe(
      workspaceKey({ userId: "b", merchantId: "a" }),
    );
  });
  it("rejects corrupted and over-limit snapshots", () => {
    expect(() => readWorkspace('{"version":2}')).toThrow();
    expect(() => readWorkspace(" ".repeat(2 * 1024 * 1024 + 1))).toThrow();
    expect(writeWorkspace({ version: 1, sessions: [], currentId: "" })).toContain('"version":1');
  });
  it("never sends interrupted turns as history", () => {
    const base = { id: "x", createdAt: new Date().toISOString() };
    expect(
      historyFor([
        { ...base, role: "user", status: "complete", content: "第一问" },
        { ...base, role: "assistant", status: "failed", content: "失败" },
        { ...base, role: "user", status: "complete", content: "第二问" },
        { ...base, role: "assistant", status: "complete", content: "完成" },
      ]),
    ).toEqual([
      { role: "user", content: "第二问" },
      { role: "assistant", content: "完成" },
    ]);
  });
});
