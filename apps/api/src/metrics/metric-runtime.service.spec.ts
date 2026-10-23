import "reflect-metadata";
import { Test } from "@nestjs/testing";
import * as database from "@shopmate/database";
import { afterEach, expect, it, vi } from "vitest";
import { MetricRuntimeService } from "./metric-runtime.service.js";
import { MetricsModule } from "./metrics.module.js";
import { METRIC_READ_PORT, METRIC_STORE_OWNERSHIP_RESOLVER } from "./metrics-query.service.js";
import {
  TENANT_ROLE_PERMISSIONS,
  type MetricReadPort,
  type MetricSourceQuery,
  type TenantContext,
} from "@shopmate/contracts";
const binding = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  connectionId: "connection",
  externalStoreId: "external",
};
const actor: TenantContext = {
  userId: "human",
  merchantId: "merchant",
  organizationId: "org",
  workspaceId: "workspace",
  role: "OWNER",
  permissions: TENANT_ROLE_PERMISSIONS.OWNER,
};
const query: MetricSourceQuery = {
  binding,
  window: {
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-01-02T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    currency: "CNY",
  },
  visibleAt: "2026-01-02T00:00:00.000Z",
  definitionVersion: "metrics-g4-v1",
  inputRevision: null,
  coverageRequests: [{ kind: "PAID_REVENUE", subject: { kind: "STORE" } }],
};
function configured() {
  vi.stubEnv("METRIC_DATABASE_URL", "postgresql://runtime@localhost/metrics");
  vi.stubEnv("METRIC_DEFINITION_DATABASE_URL", "");
  vi.stubEnv("METRIC_CURSOR_SECRET", "x".repeat(32));
  return new MetricRuntimeService();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("boots the module without metric configuration or eager pools", async () => {
  vi.stubEnv("METRIC_DATABASE_URL", "");
  vi.stubEnv("METRIC_CURSOR_SECRET", "");
  const pool = vi.spyOn(database, "createMetricRuntimePool");
  const module = await Test.createTestingModule({ imports: [MetricsModule] }).compile();
  expect(pool).not.toHaveBeenCalled();
  const reads = module.get<MetricReadPort>(METRIC_READ_PORT);
  expect(await reads.read({} as Parameters<MetricReadPort["read"]>[0])).toMatchObject({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE" },
  });
  await expect(module.get(METRIC_STORE_OWNERSHIP_RESOLVER).resolve({}, "store")).rejects.toThrow(
    "Metric runtime unavailable",
  );
  await module.close();
});
it("returns unavailable from server compute without a production fallback", async () => {
  vi.stubEnv("METRIC_DATABASE_URL", "");
  const service = new MetricRuntimeService();
  expect(await service.compute({} as Parameters<MetricRuntimeService["compute"]>[0])).toMatchObject(
    { ok: false, error: { code: "SOURCE_UNAVAILABLE" } },
  );
  await service.onModuleDestroy();
});
it("rejects invalid query and unknown definitions before any source checkout", async () => {
  const pool = vi.spyOn(database, "createMetricRuntimePool");
  const service = configured();
  expect(
    await service.compute({
      actor,
      query: { ...query, coverageRequests: [] },
      computedAt: query.visibleAt,
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    await service.compute({
      actor,
      query: { ...query, definitionVersion: "unknown" },
      computedAt: query.visibleAt,
    }),
  ).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
  expect(pool).not.toHaveBeenCalled();
  await service.onModuleDestroy();
});
it("checks fresh ownership before source capture and fails RPC without append", async () => {
  const denied = { ok: false, error: { code: "SOURCE_UNAVAILABLE", evidenceIds: [] } } as const;
  const capture = vi.fn().mockResolvedValue(denied);
  const resolve = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { ...binding, externalStoreId: "changed" } });
  vi.spyOn(database, "createMetricSourceBundleRepository").mockReturnValue({
    resolve,
    capture,
    read: vi.fn().mockResolvedValue(denied),
  });
  vi.spyOn(database, "ensureMetricDefinitions").mockResolvedValue({ ok: true, value: true });
  const snapshots = vi.spyOn(database, "createMetricSnapshotRepository");
  const service = configured();
  const request = { actor, query, computedAt: query.visibleAt };
  expect(await service.compute(request)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(capture).not.toHaveBeenCalled();
  resolve.mockResolvedValue({ ok: true, value: binding });
  expect(await service.compute(request)).toEqual(denied);
  expect(capture).toHaveBeenCalledOnce();
  expect(snapshots).not.toHaveBeenCalled();
  await service.onModuleDestroy();
});
