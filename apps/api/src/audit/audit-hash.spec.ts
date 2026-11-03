import { expect, it } from "vitest";
import { TenantAuditEntrySchema, type TenantAuditEntry } from "@shopmate/contracts";
import { AuditCanonicalBytes, AuditHashVerifier, hashAuditEntry } from "./audit-hash.js";

const scope = { organizationId: "org-a", workspaceId: "workspace-a", storeId: "store-a" };
function unsigned(sequence = 1, prevHash: string | null = null) {
  return {
    scopeKind: "TENANT" as const,
    scope,
    actor: { actorId: "user-a", actorKind: "USER" as const, identitySource: "SERVER" as const },
    resource: null,
    result: "SUCCESS" as const,
    occurredAt: "2026-11-03T00:00:00.000Z",
    sourceOccurredAt: null,
    links: {
      requestId: "request-a",
      occurrenceId: "occurrence-a",
      runId: null,
      evidenceId: null,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: {
      eventType: "EXECUTION" as const,
      redactedMetadata: {
        actionKind: "PRICE" as const,
        oldPriceMinor: 1000,
        newPriceMinor: 1100,
        reasonCode: null,
      },
    },
    auditId: `audit-${sequence}`,
    sequence,
    hashVersion: 1 as const,
    prevHash,
  };
}
function entry(sequence = 1, prevHash: string | null = null): TenantAuditEntry {
  const value = unsigned(sequence, prevHash);
  return TenantAuditEntrySchema.parse({ ...value, entryHash: hashAuditEntry(value) });
}
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reorder(item)]),
  );
}

it("canonicalizes every validated field independent of recursive insertion order", () => {
  const canonical = new AuditCanonicalBytes();
  expect(canonical.encode(reorder(unsigned()))).toEqual(canonical.encode(unsigned()));
  expect(hashAuditEntry(reorder(unsigned()))).toBe(hashAuditEntry(unsigned()));
});

it("excludes only entryHash and returns UTF-8 canonical JSON", () => {
  const text = Buffer.from(new AuditCanonicalBytes().encode(unsigned())).toString("utf8");
  expect(JSON.parse(text)).toEqual(unsigned());
  expect(text.startsWith('{"actor":')).toBe(true);
});

function verifier(checkpoint: unknown = { scope, sequence: 0, entryHash: null, hashVersion: 1 }) {
  return new AuditHashVerifier({ read: async () => checkpoint });
}
function request(entries: readonly unknown[], chainVisibility: "FULL" | "PARTIAL" = "FULL") {
  return { scope, entries, chainVisibility };
}
function chain() {
  const first = entry();
  const second = entry(2, first.entryHash);
  return [first, second, entry(3, second.entryHash)];
}

it("matches an independent fixed domain-separated SHA-256 vector", () => {
  // Independently computed with Python json.dumps(sort_keys=True, separators=(',', ':')) + hashlib.
  expect(hashAuditEntry(unsigned())).toBe(
    "1044a1b17941d4c848ceeffac8aed36cb7792a9dbc9f113ff4c72c9978719eb9",
  );
});

it("checks a full genesis chain as local integrity only", async () => {
  expect(await verifier().verify(request(chain()))).toEqual({
    status: "LOCAL_CONSISTENT",
    proof: "LOCAL_ONLY",
    checkedEntries: 3,
    startSequence: 1,
    endSequence: 3,
  });
});

it("checks an anchored full segment and passes only requested scope to the port", async () => {
  const entries = chain();
  const seen: unknown[] = [];
  const subject = new AuditHashVerifier({
    read: async (value) => {
      seen.push(value);
      return { scope, sequence: 1, entryHash: entries[0]!.entryHash, hashVersion: 1 };
    },
  });
  expect(await subject.verify(request(entries.slice(1)))).toMatchObject({
    status: "LOCAL_CONSISTENT",
  });
  expect(seen).toEqual([scope]);
});

const mutations = [
  { auditId: "audit-other" },
  { sequence: 2 },
  { prevHash: "a".repeat(64) },
  { actor: { actorId: "user-b", actorKind: "USER", identitySource: "SERVER" } },
  { occurredAt: "2026-11-03T00:00:01.000Z" },
  { sourceOccurredAt: "2026-11-02T00:00:00.000Z" },
  { links: { ...unsigned().links, executionId: "execution-b" } },
  { resource: { type: "SKU", id: "sku-b" } },
  { result: "FAILED" },
  {
    event: {
      ...unsigned().event,
      redactedMetadata: { ...unsigned().event.redactedMetadata, newPriceMinor: 1101 },
    },
  },
  { entryHash: "b".repeat(64) },
];
it.each(mutations)("detects persisted field mutation %#", async (mutation) => {
  expect(await verifier().verify(request([{ ...entry(), ...mutation }]))).toMatchObject({
    status: "ENTRY_HASH_MISMATCH",
    index: 0,
  });
});

it("binds entries to exact requested scope", async () => {
  const changed = { ...unsigned(), scope: { ...scope, storeId: "store-b" } };
  expect(
    await verifier().verify(request([{ ...changed, entryHash: hashAuditEntry(changed) }])),
  ).toMatchObject({ status: "MALFORMED_INPUT", reason: "SCOPE_MISMATCH" });
  expect(hashAuditEntry(changed)).not.toBe(hashAuditEntry(unsigned()));
});

it.each(["gap", "duplicate", "swapped"])("distinguishes full sequence %s", async (kind) => {
  const [first, second, third] = chain();
  const entries =
    kind === "gap" ? [first, third] : kind === "duplicate" ? [first, first] : [second, first];
  expect(await verifier().verify(request(entries))).toMatchObject({ status: "SEQUENCE_GAP" });
});

it("distinguishes a correctly rehashed wrong predecessor", async () => {
  expect(await verifier().verify(request([entry(), entry(2, "a".repeat(64))]))).toMatchObject({
    status: "PREDECESSOR_MISMATCH",
    index: 1,
  });
});

it.each([0, 2, 999])(
  "recognizes unsupported entry version %s before strict v1 parsing",
  async (hashVersion) => {
    expect(
      await verifier().verify(request([{ ...entry(), hashVersion, future: true }])),
    ).toMatchObject({ status: "UNSUPPORTED_VERSION", source: "ENTRY", index: 0, hashVersion });
  },
);

it.each(["ABC", null, 1])("rejects malformed entry hashes %s", async (entryHash) => {
  expect(await verifier().verify(request([{ ...entry(), entryHash }]))).toMatchObject({
    status: "MALFORMED_INPUT",
  });
});

it.each([{ entries: [] }, { entries: [entry(5, "a".repeat(64))] }])(
  "does not infer full history from empty/missing anchor",
  async ({ entries }) => {
    expect(await verifier(null).verify(request(entries))).toMatchObject({
      status: entries.length ? "CHECKPOINT_MISSING" : "INSUFFICIENT_VISIBILITY",
    });
  },
);

const badAnchors = [
  { scope: { ...scope, storeId: "store-b" }, sequence: 0, entryHash: null, hashVersion: 1 },
  { scope, sequence: 2, entryHash: "a".repeat(64), hashVersion: 1 },
  { scope, sequence: 0, entryHash: "a".repeat(64), hashVersion: 1 },
  { scope, sequence: -1, entryHash: null, hashVersion: 1 },
];
it.each(badAnchors)("rejects invalid scope, sequence or genesis checkpoint %#", async (anchor) => {
  expect(await verifier(anchor).verify(request([entry()]))).toMatchObject({
    status: "CHECKPOINT_MISMATCH",
  });
});

it("distinguishes unsupported checkpoints and changed anchor hashes", async () => {
  expect(await verifier({ hashVersion: 7 }).verify(request([entry()]))).toMatchObject({
    status: "UNSUPPORTED_VERSION",
    source: "CHECKPOINT",
    hashVersion: 7,
  });
  const anchor = { scope, sequence: 1, entryHash: "a".repeat(64), hashVersion: 1 };
  expect(await verifier(anchor).verify(request(chain().slice(1)))).toMatchObject({
    status: "CHECKPOINT_MISMATCH",
  });
});

it("never treats an unseen partial gap as tampering or complete verification", async () => {
  const entries = chain();
  expect(await verifier().verify(request([entries[0], entries[2]], "PARTIAL"))).toEqual({
    status: "INSUFFICIENT_VISIBILITY",
    reason: "PARTIAL",
    proof: "LOCAL_ONLY",
    checkedEntries: 2,
  });
});

it("still detects partial visible mutations and broken contiguous links", async () => {
  expect(
    await verifier().verify(request([{ ...entry(), entryHash: "a".repeat(64) }], "PARTIAL")),
  ).toMatchObject({ status: "ENTRY_HASH_MISMATCH" });
  expect(
    await verifier().verify(request([entry(), entry(2, "a".repeat(64))], "PARTIAL")),
  ).toMatchObject({ status: "PREDECESSOR_MISMATCH" });
});

it("does not let partial visibility conceal duplicate or reversed input order", async () => {
  const entries = chain();
  expect(await verifier().verify(request([entries[1], entries[0]], "PARTIAL"))).toMatchObject({
    status: "MALFORMED_INPUT",
    reason: "ENTRY_ORDER",
  });
});

it("handles checkpoint port failure with a fixed payload-free diagnostic", async () => {
  const subject = new AuditHashVerifier({
    read: async () => {
      throw new Error("secret-token");
    },
  });
  expect(await subject.verify(request([entry()]))).toEqual({
    status: "CHECKPOINT_UNAVAILABLE",
    proof: "LOCAL_ONLY",
  });
});

function lifecycle(resourceId = "事件/é.1") {
  const binding = { ...scope, connectionId: "connection-a", externalStoreId: "商店/é" };
  return {
    ...unsigned(),
    resource: { type: "EVENT", id: resourceId },
    event: {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: {
        fromState: "OPEN",
        toState: "ACKNOWLEDGED",
        reason: "ACKNOWLEDGED_BY_OPERATOR",
        expectedRevision: 1,
        revision: 2,
        evidenceReference: {
          schemaVersion: 1,
          id: "证据/é.1",
          version: "版本/1",
          hash: "摘要/1",
          binding,
          eventType: "SYNC_FAILURE",
          entity: { kind: "CONNECTION", connectionId: binding.connectionId },
          definitionVersion: "定义/1",
          baselineVersion: null,
        },
      },
    },
  };
}

it("preserves lifecycle payload and Unicode opaque ids without normalization", async () => {
  const value = lifecycle();
  const bytes = new AuditCanonicalBytes().encode(value);
  expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual(value);
  expect(hashAuditEntry(reorder(value))).toBe(hashAuditEntry(value));
  expect(hashAuditEntry(lifecycle("事件/e\u0301.1"))).not.toBe(hashAuditEntry(value));
  expect(
    await verifier().verify(request([{ ...value, entryHash: hashAuditEntry(value) }])),
  ).toMatchObject({ status: "LOCAL_CONSISTENT" });
});

function hostileInputs(): unknown[] {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: unknown = null;
  for (let depth = 0; depth < 30; depth++) deep = { deep };
  return [
    cyclic,
    deep,
    new Date(),
    NaN,
    undefined,
    1n,
    new Map(),
    { ...unsigned(), extra: "secret-token" },
    { ...unsigned(), entryHash: "a".repeat(64) },
    { ...unsigned(), extra: "x".repeat(2_097_153) },
    { ...unsigned(), extra: Array.from({ length: 24_001 }, () => null) },
    { ...unsigned(), extra: new Array(2) },
    { ...unsigned(), extra: { [Symbol("secret")]: true } },
    { scopeKind: "ANONYMOUS_AUTH_SECURITY", scope: null, actor: null },
  ];
}
it.each(hostileInputs())(
  "bounds and rejects hostile canonical input %# with safe errors",
  (input) => {
    expect(() => new AuditCanonicalBytes().encode(input)).toThrow("Invalid audit canonical input");
  },
);

it("never invokes accessors or attacker serialization", async () => {
  let calls = 0;
  const value = {
    ...unsigned(),
    get secret() {
      calls++;
      throw new Error("secret-token");
    },
  };
  expect(() => hashAuditEntry(value)).toThrow("Invalid audit canonical input");
  const diagnostic = await verifier().verify(request([value]));
  expect(diagnostic).toMatchObject({ status: "MALFORMED_INPUT" });
  expect(JSON.stringify(diagnostic)).not.toContain("secret-token");
  expect(calls).toBe(0);
});

it("bounds entry counts and rejects anonymous security records as tenant chain input", async () => {
  expect(
    await verifier().verify(request(Array.from({ length: 101 }, () => entry()))),
  ).toMatchObject({ status: "MALFORMED_INPUT" });
  expect(
    await verifier().verify(request([{ scopeKind: "ANONYMOUS_AUTH_SECURITY", scope: null }])),
  ).toMatchObject({ status: "MALFORMED_INPUT" });
});

it("does not classify anonymous security data as a future tenant chain version", async () => {
  const anonymous = { scopeKind: "ANONYMOUS_AUTH_SECURITY", scope: null, hashVersion: 2 };
  expect(await verifier().verify(request([anonymous]))).toMatchObject({
    status: "MALFORMED_INPUT",
  });
});
