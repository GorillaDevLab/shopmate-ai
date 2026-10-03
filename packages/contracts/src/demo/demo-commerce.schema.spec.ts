import { describe, expect, it } from "vitest";
import * as contracts from "../index.js";

const settings = {
  profile: "growing",
  seed: 42,
  historyStart: "2026-01-01T00:00:00+08:00",
};
const create = { settings, observedAt: "2026-01-01T00:00:00+08:00" };
const reset = { ...create, expectedRevision: 0, confirmSessionId: "session-a" };
const advance = { expectedRevision: 0, durationMs: 1 };
const disconnect = { expectedRevision: 0, confirmSessionId: "session-a" };
const view = {
  id: "session-a",
  storeId: "store-a",
  connectionId: "connection-a",
  profile: "growing",
  seed: 42,
  generatorVersion: "mock-source-v1",
  configHash: "a".repeat(64),
  clockNow: "2026-01-01T00:00:00+08:00",
  clockRevision: 0,
  revision: 0,
  generation: 0,
  status: "ACTIVE",
};

function acceptsSettings(input: unknown): boolean {
  return contracts.DemoSourceSettingsSchema.safeParse(input).success;
}

describe("demo source settings", () => {
  it("exports the settings schema and applies only catalog defaults", () => {
    expect(contracts.DemoSourceSettingsSchema.parse(settings)).toEqual({
      ...settings,
      historyStart: "2025-12-31T16:00:00.000Z",
      days: 180,
      productCount: 60,
      variantsPerProduct: 3,
    });
  });
  it.each(["growing", "problematic", "mature", "new"])("accepts profile %s", (profile) => {
    expect(acceptsSettings({ ...settings, profile })).toBe(true);
  });
  it.each([
    {
      seed: 0,
      days: 1,
      productCount: 1,
      variantsPerProduct: 1,
      dailyOrders: 1,
      growthBps: 0,
      refundBps: 0,
      adSpendMinor: 0,
    },
    {
      seed: 0xffff_ffff,
      days: 365,
      productCount: 100,
      variantsPerProduct: 3,
      dailyOrders: 300,
      growthBps: 10_000,
      refundBps: 5000,
      adSpendMinor: 100_000_000,
    },
  ])("accepts the bounded generation settings %j", (change) => {
    expect(acceptsSettings({ ...settings, ...change })).toBe(true);
  });
  it.each([
    ["seed", -1],
    ["seed", 0x1_0000_0000],
    ["seed", 0.5],
    ["seed", "42"],
    ["days", 0],
    ["days", 366],
    ["days", 1.5],
    ["productCount", 0],
    ["productCount", 101],
    ["productCount", 1.5],
    ["variantsPerProduct", 0],
    ["variantsPerProduct", 4],
    ["variantsPerProduct", 1.5],
    ["dailyOrders", 0],
    ["dailyOrders", 301],
    ["dailyOrders", 1.5],
    ["growthBps", -1],
    ["growthBps", 10_001],
    ["growthBps", 0.5],
    ["refundBps", -1],
    ["refundBps", 5001],
    ["refundBps", 0.5],
    ["adSpendMinor", -1],
    ["adSpendMinor", 100_000_001],
    ["adSpendMinor", 0.5],
    ["profile", "unknown"],
    ["seed", Infinity],
    ["seed", NaN],
  ])("rejects out-of-range %s=%s", (field, value) => {
    expect(acceptsSettings({ ...settings, [field]: value })).toBe(false);
  });
  it.each(["binding", "tenantId", "organizationId", "storeId", "generation", "token"])(
    "rejects injected settings field %s",
    (field) => {
      expect(acceptsSettings({ ...settings, [field]: "injected" })).toBe(false);
    },
  );
  it.each([
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.001+08:00",
    "2026-02-30T00:00:00+08:00",
    "0000-01-01T00:00:00+08:00",
    "0000-12-31T16:00:00Z",
    "0001-01-01T00:00:00+08:00",
    "9999-12-30T00:00:00+08:00",
    "not-a-date",
  ])("rejects invalid midnight or calendar horizon %s", (historyStart) => {
    expect(acceptsSettings({ ...settings, historyStart })).toBe(false);
  });
  it("accepts the last history day with room for five settlement days", () => {
    expect(
      acceptsSettings({ ...settings, days: 1, historyStart: "9999-12-26T00:00:00+08:00" }),
    ).toBe(true);
    expect(
      acceptsSettings({ ...settings, days: 1, historyStart: "9999-12-27T00:00:00+08:00" }),
    ).toBe(false);
  });
  it("accepts the earliest UTC year supported by persisted sessions", () => {
    expect(acceptsSettings({ ...settings, historyStart: "0001-01-01T16:00:00Z" })).toBe(true);
  });
  it("normalizes equivalent UTC midnight spelling", () => {
    expect(
      contracts.DemoSourceSettingsSchema.parse({
        ...settings,
        historyStart: "2025-12-31T16:00:00Z",
      }),
    ).toEqual(contracts.DemoSourceSettingsSchema.parse(settings));
  });
});

describe("demo session commands", () => {
  const commands = [
    ["create", contracts.DemoSessionCreateSchema, create],
    ["advance", contracts.DemoSessionAdvanceSchema, advance],
    ["reset", contracts.DemoSessionResetSchema, reset],
    ["disconnect", contracts.DemoSessionDisconnectSchema, disconnect],
  ] as const;
  it.each(commands)("exports and accepts %s", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(true);
  });
  it.each(commands)("requires every command field on %s", (_name, schema, input) => {
    for (const field of Object.keys(input)) {
      const incomplete: Record<string, unknown> = { ...input };
      delete incomplete[field];
      expect(schema.safeParse(incomplete).success).toBe(false);
    }
  });
  it.each(commands)("rejects authority overrides on %s", (_name, schema, input) => {
    for (const field of ["tenantId", "binding", "generation", "storeId", "connectionId"]) {
      expect(schema.safeParse({ ...input, [field]: "foreign" }).success).toBe(false);
    }
  });
  it.each([
    "2025-12-31T15:59:59.999Z",
    "2026-02-30T00:00:00Z",
    "0000-01-01T00:00:00+08:00",
    "9999-12-31T23:59:59-01:00",
  ])("rejects invalid or pre-history observed time %s", (observedAt) => {
    for (const [schema, input] of [
      [contracts.DemoSessionCreateSchema, create],
      [contracts.DemoSessionResetSchema, reset],
    ] as const) {
      expect(schema.safeParse({ ...input, observedAt }).success).toBe(false);
    }
  });
  it("normalizes the observed clock while comparing instants", () => {
    expect(contracts.DemoSessionCreateSchema.parse(create).observedAt).toBe(
      "2025-12-31T16:00:00.000Z",
    );
    expect(
      contracts.DemoSessionResetSchema.safeParse({ ...reset, observedAt: "2025-12-31T16:00:00Z" })
        .success,
    ).toBe(true);
  });
  it.each([-1, 0.5, 2_147_483_647, "0"])(
    "rejects invalid expected revision %s",
    (expectedRevision) => {
      for (const [schema, input] of [
        [contracts.DemoSessionAdvanceSchema, advance],
        [contracts.DemoSessionResetSchema, reset],
        [contracts.DemoSessionDisconnectSchema, disconnect],
      ] as const) {
        expect(schema.safeParse({ ...input, expectedRevision }).success).toBe(false);
      }
    },
  );
  it("accepts the largest revision that can still be incremented", () => {
    for (const [schema, input] of [
      [contracts.DemoSessionAdvanceSchema, advance],
      [contracts.DemoSessionResetSchema, reset],
      [contracts.DemoSessionDisconnectSchema, disconnect],
    ] as const) {
      expect(schema.safeParse({ ...input, expectedRevision: 2_147_483_646 }).success).toBe(true);
    }
  });
  it.each([0, -1, 0.5, 2_592_000_001, "1"])("rejects invalid advance duration %s", (durationMs) => {
    expect(contracts.DemoSessionAdvanceSchema.safeParse({ ...advance, durationMs }).success).toBe(
      false,
    );
  });
  it("accepts a thirty-day advance", () => {
    expect(
      contracts.DemoSessionAdvanceSchema.safeParse({ ...advance, durationMs: 2_592_000_000 })
        .success,
    ).toBe(true);
  });
  it.each([undefined, "", "../session", " session-a", "a".repeat(129)])(
    "requires a safe destructive-action confirmation %s",
    (confirmSessionId) => {
      expect(
        contracts.DemoSessionResetSchema.safeParse({ ...reset, confirmSessionId }).success ?? false,
      ).toBe(false);
      expect(
        contracts.DemoSessionDisconnectSchema.safeParse({ ...disconnect, confirmSessionId })
          .success,
      ).toBe(false);
    },
  );
});

describe("demo session view", () => {
  it("exposes a bounded canonical clock and metadata", () => {
    expect(contracts.DemoSessionViewSchema.parse(view)).toEqual({
      ...view,
      clockNow: "2025-12-31T16:00:00.000Z",
    });
  });
  it("accepts disconnected metadata and the final int32 counters", () => {
    expect(
      contracts.DemoSessionViewSchema.safeParse({
        ...view,
        status: "DISCONNECTED",
        clockRevision: 2_147_483_647,
        revision: 2_147_483_647,
        generation: 2_147_483_647,
        seed: 0xffff_ffff,
      }).success,
    ).toBe(true);
  });
  it.each(["config", "settings", "token", "orders", "organizationId"])(
    "rejects private view field %s",
    (field) => {
      expect(
        contracts.DemoSessionViewSchema.safeParse({ ...view, [field]: "private" }).success ?? false,
      ).toBe(false);
    },
  );
  it.each([
    ["id", ""],
    ["storeId", "../store"],
    ["connectionId", " foreign"],
    ["profile", "unknown"],
    ["status", "DELETED"],
    ["seed", -1],
    ["seed", 0x1_0000_0000],
    ["generatorVersion", ""],
    ["generatorVersion", " version"],
    ["generatorVersion", "version\n"],
    ["generatorVersion", "a".repeat(257)],
    ["configHash", "a".repeat(63)],
    ["configHash", "g".repeat(64)],
    ["clockRevision", -1],
    ["revision", 2_147_483_648],
    ["generation", 0.5],
    ["clockNow", "0000-01-01T00:00:00+08:00"],
    ["clockNow", "0000-12-31T16:00:00Z"],
    ["clockNow", "0001-01-01T00:00:00+08:00"],
    ["clockNow", "9999-12-31T23:59:59-01:00"],
  ])("rejects invalid metadata %s=%s", (field, value) => {
    expect(contracts.DemoSessionViewSchema.safeParse({ ...view, [field]: value }).success).toBe(
      false,
    );
  });
});
