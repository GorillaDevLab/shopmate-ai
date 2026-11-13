import { expect, it } from "vitest";
import {
  EventDecisionTransactionOwner,
  type RuntimeConnection,
} from "./event-decision-transaction.js";
import { TENANT_ROLE_PERMISSIONS, type TenantContext } from "@shopmate/contracts";

const actor: TenantContext = {
  userId: "human",
  merchantId: "merchant",
  organizationId: "org",
  workspaceId: "workspace",
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external",
};
const clock = { timeDomain: "SECURITY_UTC" as const, now: () => new Date().toISOString() };
function fixture(failCommit = false) {
  const calls: string[] = [];
  let discarded = false;
  const connection: RuntimeConnection = {
    query: async (sql) => {
      calls.push(sql);
      if (failCommit && sql === "COMMIT") throw new Error("private transport");
      return {
        rows: sql.includes("runtime:authority") ? [{ role: "OWNER", allowed: true }] : [],
        rowCount: 1,
      };
    },
    release: (discard) => {
      discarded = discard ?? false;
    },
    on: () => undefined,
    off: () => undefined,
  };
  const owner = new EventDecisionTransactionOwner({ connect: async () => connection }, clock);
  const authority = {
    actor,
    binding,
    generation: 0,
    revisions: ["revision"],
    recipientId: "human",
    writable: true,
    control: {
      timeDomain: "SECURITY_UTC" as const,
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      signal: new AbortController().signal,
    },
  };
  return { owner, authority, calls, discarded: () => discarded };
}
it("uses one client and one final authority snapshot before committing", async () => {
  const test = fixture();
  expect(
    await test.owner.run(test.authority, async (scope) => {
      await scope.client.query("SELECT 'work'");
      return "saved";
    }),
  ).toBe("saved");
  expect(test.calls.filter((sql) => sql.includes("runtime:authority"))).toHaveLength(3);
  expect(test.calls.at(-2)).toContain("runtime:authority");
  expect(test.calls.at(-1)).toBe("COMMIT");
  expect(test.discarded()).toBe(false);
});
it("rolls back typed denials and rejected work", async () => {
  for (const work of [
    async () => ({ ok: false, code: "FORBIDDEN" }),
    async () => {
      throw new Error("private");
    },
  ]) {
    const test = fixture();
    await expect(test.owner.run(test.authority, work)).rejects.toThrow();
    expect(test.calls.at(-1)).toBe("ROLLBACK");
    expect(test.calls).not.toContain("COMMIT");
  }
});
it("discards an uncertain COMMIT and never reports a known rollback", async () => {
  const test = fixture(true);
  await expect(test.owner.run(test.authority, async () => "saved")).rejects.toMatchObject({
    code: "COMMIT_INDETERMINATE",
  });
  expect(test.discarded()).toBe(true);
  expect(test.calls.at(-1)).toBe("COMMIT");
  expect(test.calls).not.toContain("ROLLBACK");
});
it("rolls back a read denial while preserving its typed not-found result", async () => {
  const test = fixture();
  const denial = { ok: false, error: { code: "NOT_FOUND", evidenceIds: [] } };
  const result = await test.owner.run({ ...test.authority, writable: false }, async () => denial);
  expect(result).toEqual(denial);
  expect(test.calls.at(-1)).toBe("ROLLBACK");
  expect(test.calls).not.toContain("COMMIT");
});
