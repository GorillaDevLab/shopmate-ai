import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import {
  EventEvidenceV1Schema,
  type DecisionPortResult,
  type EventEvidenceV1,
  type HostEvidenceHash,
} from "@shopmate/contracts";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";

const instant = "2026-10-25T01:00:00Z";
const period = {
  periodStart: "2026-10-25T00:00:00Z",
  periodEnd: instant,
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const source = {
  kind: "NORMALIZED_AGGREGATE",
  id: "source-a",
  version: "source-v1",
  hash: "source-hash",
  binding,
  definitionVersion: "metrics-v1",
  period,
  observedAt: instant,
  measure: null,
} as const;
const hasher = new CanonicalHostEvidenceHash();

function evidenceFixture(patch: object = {}): EventEvidenceV1 {
  return EventEvidenceV1Schema.parse({
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: instant,
    sourceWatermark: instant,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    issues: [],
    definitionVersion: "metrics-v1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [source],
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    facts: {
      lastSuccessAt: instant,
      lagSeconds: 0,
      typedErrorCode: "TEMPORARY",
      affectedResourceKind: "INVENTORY",
    },
    ...patch,
  });
}

function value<T>(result: DecisionPortResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected boundary failure: ${result.code}`);
  return result.value;
}

function reverseKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(reverseKeys);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  );
}

it("implements the public host hash port with a domain-separated SHA256", () => {
  expectTypeOf<CanonicalHostEvidenceHash>().toExtend<HostEvidenceHash>();
  const evidence = evidenceFixture();
  const hash = value(hasher.hash(evidence));
  expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const plain = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  expect(hash).not.toBe(`sha256:${plain}`);
});

it("hashes equivalent object ordering and timestamp representations identically", () => {
  const evidence = evidenceFixture();
  const equivalent = evidenceFixture({
    observedAt: "2026-10-25T01:00:00.0000Z",
    sourceWatermark: "2026-10-25T01:00:00.000Z",
    sourceReferences: [{ ...source, observedAt: "2026-10-25T01:00:00.000Z" }],
  });
  expect(value(hasher.hash(reverseKeys(equivalent)))).toBe(value(hasher.hash(evidence)));
});

it.each(["id", "version", "hash"] as const)("preserves opaque date-like source %s", (key) => {
  const first = evidenceFixture({ sourceReferences: [{ ...source, [key]: instant }] });
  const second = evidenceFixture({
    sourceReferences: [{ ...source, [key]: "2026-10-25T01:00:00.000Z" }],
  });
  expect(value(hasher.hash(first))).not.toBe(value(hasher.hash(second)));
});

it.each(["organizationId", "workspaceId", "storeId", "externalStoreId"] as const)(
  "binds trusted %s scope into the hash",
  (key) => {
    const scoped = { ...binding, [key]: "other-scope" };
    const evidence = evidenceFixture({
      binding: scoped,
      sourceReferences: [{ ...source, binding: scoped }],
    });
    expect(value(hasher.hash(evidence))).not.toBe(value(hasher.hash(evidenceFixture())));
  },
);

it("binds connection/entity, facts, observation cutoff and definition version", () => {
  const original = evidenceFixture();
  const changed = [
    evidenceFixture({
      binding: { ...binding, connectionId: "connection-b" },
      entity: { kind: "CONNECTION", connectionId: "connection-b" },
      sourceReferences: [{ ...source, binding: { ...binding, connectionId: "connection-b" } }],
    }),
    evidenceFixture({ facts: { ...original.facts, typedErrorCode: "TIMEOUT" } }),
    evidenceFixture({
      observedAt: "2026-10-25T01:00:01Z",
      facts: { ...original.facts, lagSeconds: 1 },
    }),
    evidenceFixture({
      definitionVersion: "metrics-v2",
      sourceReferences: [{ ...source, definitionVersion: "metrics-v2" }],
    }),
  ];
  for (const evidence of changed)
    expect(value(hasher.hash(evidence))).not.toBe(value(hasher.hash(original)));
});

it("preserves source sequence order instead of silently sorting arrays", () => {
  const sources = [source, { ...source, id: "source-b" }];
  const first = evidenceFixture({ sourceReferences: sources });
  const second = evidenceFixture({ sourceReferences: [...sources].reverse() });
  expect(value(hasher.hash(first))).not.toBe(value(hasher.hash(second)));
});

it.each([null, {}, { schemaVersion: 2 }, { binding: null }])(
  "returns a typed invalid input for malformed evidence %j",
  (evidence) => expect(hasher.hash(evidence)).toEqual({ ok: false, code: "INVALID_INPUT" }),
);

it("fails closed on thrown upstream arithmetic refinements and leaves raw evidence untouched", () => {
  const evidence = structuredClone(evidenceFixture());
  const before = JSON.stringify(evidence);
  value(hasher.hash(evidence));
  expect(JSON.stringify(evidence)).toBe(before);
  expect(Object.isFrozen(evidence)).toBe(false);
  const invalid = {
    ...evidence,
    eventType: "REFUND_SPIKE",
    entity: { kind: "STORE" },
    facts: { currentRate: { numerator: 1.1, denominator: 10, valueBasisPoints: 1100, period } },
  };
  expect(() => hasher.hash(invalid)).not.toThrow();
  expect(hasher.hash(invalid)).toEqual({ ok: false, code: "INVALID_INPUT" });
});
