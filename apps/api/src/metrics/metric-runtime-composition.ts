import {
  MetricTimestampSchema,
  MetricValueSchema,
  TenantContextSchema,
  type MetricKind,
  type MetricResult,
  type TenantContext,
  type MetricSourceQuery,
  type MetricSnapshotV1,
} from "@shopmate/contracts";
import { z } from "zod";
import {
  createMetricSnapshotRepository,
  type MetricRuntimePool,
  type NormalizedMetricSourceBundle,
  type RuntimeMetricDefinition,
} from "@shopmate/database";
import { createMetricDefinitionRegistry } from "./metric-definition-registry.js";
import { createMetricEvidenceHasher } from "./metric-evidence-hash.js";
import {
  createMetricRuntimeCalculator,
  METRIC_RUNTIME_DEFINITION_VERSION,
  METRIC_RUNTIME_DEFINITION_HASH,
} from "./metric-runtime-calculator.js";
import { normalizedSourceQuerySchema } from "./normalized-metric-source.validation.js";
import type { MetricComputationService } from "./metric-computation.service.js";

export const runtimeRequestSchema = z
  .strictObject({
    actor: TenantContextSchema,
    query: z
      .strictObject({
        ...normalizedSourceQuerySchema.shape,
        inputRevision: normalizedSourceQuerySchema.shape.inputRevision.nullable(),
      })
      .refine((query) => Date.parse(query.window.periodEnd) <= Date.parse(query.visibleAt)),
    computedAt: MetricTimestampSchema,
  })
  .refine(({ query, computedAt }) => Date.parse(computedAt) >= Date.parse(query.visibleAt))
  .refine(({ computedAt }) => !/[1-9]/u.test((/\.(\d+)/u.exec(computedAt)?.[1] ?? "").slice(3)));
export function runtimeFailure<T = never>(
  code: "INVALID_INPUT" | "SOURCE_UNAVAILABLE" | "NOT_FOUND" | "VERSION_MISMATCH",
): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
export function runtimeDefinitions(
  kinds?: readonly MetricKind[],
): readonly RuntimeMetricDefinition[] {
  return MetricValueSchema.options.flatMap((option) => {
    const shape = option.unwrap().shape;
    return shape.kind.options
      .filter((kind) => !kinds || kinds.includes(kind))
      .map((kind) => ({
        kind,
        unit: shape.unit.value,
        definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
        definitionHash: METRIC_RUNTIME_DEFINITION_HASH,
      }));
  });
}
export function runtimeRegistry(bundle?: NormalizedMetricSourceBundle) {
  const clock = {
    snapshot: () => {
      // Persisted reads need the exact-version hasher, but have no authority to calculate.
      if (!bundle) throw new Error("Captured metric business clock required");
      return { now: bundle.businessNow, revision: bundle.clockRevision };
    },
  };
  return createMetricDefinitionRegistry([
    {
      definitionVersion: METRIC_RUNTIME_DEFINITION_VERSION,
      calculator: createMetricRuntimeCalculator({ clock }),
    },
  ]);
}
export function runtimeStore(
  pool: MetricRuntimePool,
  actor: TenantContext,
  registry = runtimeRegistry(),
) {
  return createMetricSnapshotRepository({
    pool,
    actor,
    hasher: createMetricEvidenceHasher(registry),
  });
}
export async function computeRuntimeMetrics(
  service: MetricComputationService,
  query: MetricSourceQuery,
  computedAt: string,
): Promise<MetricResult<readonly MetricSnapshotV1[]>> {
  const snapshots: MetricSnapshotV1[] = [];
  // P13 hashes all input coverage, while P15 identity is per kind/subject. Singleton
  // inputs keep the same metric hash stable across batch and subset requests.
  for (const coverage of query.coverageRequests) {
    const result = await service.compute({
      query: { ...query, coverageRequests: [coverage] },
      computedAt,
    });
    if (!result.ok) return result;
    snapshots.push(...result.value);
  }
  return { ok: true, value: snapshots };
}
