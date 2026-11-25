import { validScenario, canonicalScenario } from "./scenario-configuration.js";
import { createHash } from "node:crypto";
import { MockObservedGenerationConfigV3Schema } from "@shopmate/contracts";
import { SourceStorageError } from "./errors.js";
import { bindingKeys, exact, externalId, integer, object } from "./validation.js";
import type { SourceScope } from "./types.js";

const DAY = 86400000;
const MAX_DATE = Date.parse("9999-12-31T23:59:59.999Z");
const configKeys = [
  "binding",
  "seed",
  "profile",
  "historyStart",
  "days",
  "productCount",
  "variantsPerProduct",
  "dailyOrders",
  "growthBps",
  "refundBps",
  "adSpendMinor",
] as const;
const ranges = {
  seed: [0, 4294967295],
  days: [1, 365],
  productCount: [1, 100],
  variantsPerProduct: [1, 3],
  dailyOrders: [1, 300],
  growthBps: [0, 10000],
  refundBps: [0, 5000],
  adSpendMinor: [0, 100000000],
} as const;
export interface FrozenConfiguration {
  openingAt: string;
  baselineEnd: string;
}

function validStart(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T16:00:00\.000Z$/u.test(value)) return false;
  const at = Date.parse(value);
  return (
    at >= Date.parse("0001-01-01T00:00:00.000Z") &&
    at <= MAX_DATE &&
    new Date(at).toISOString() === value
  );
}
function jsonDigest(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
function canonicalHash(config: Record<string, unknown>): string {
  const binding = config.binding as Record<string, unknown>;
  // Approved v1 hashes schema-ordered JSON; JSONB discards that order at rest.
  const canonical = Object.fromEntries(
    (Object.hasOwn(config, "scenarioPlan") ? [...configKeys, "scenarioPlan"] : configKeys).map(
      (key) => [
        key,
        key === "binding"
          ? Object.fromEntries(bindingKeys.map((field) => [field, binding[field]]))
          : key === "scenarioPlan"
            ? canonicalScenario(config[key])
            : config[key],
      ],
    ),
  );
  return jsonDigest(canonical);
}
function validShape(
  config: unknown,
  scope: SourceScope,
  version: unknown,
): config is Record<string, unknown> {
  const keys = version === "mock-source-v2" ? [...configKeys, "scenarioPlan"] : configKeys;
  if (!exact(config, keys) || !exact(config.binding, bindingKeys)) return false;
  if (version === "mock-source-v2" && !validScenario(config)) return false;
  return (
    bindingKeys.every((key) => (config.binding as Record<string, unknown>)[key] === scope[key]) &&
    Object.entries(ranges).every(([key, [min, max]]) => integer(config[key], min, max)) &&
    typeof config.profile === "string" &&
    ["growing", "problematic", "mature", "new"].includes(config.profile) &&
    validStart(config.historyStart)
  );
}
function calendar(start: number, days: number, profile: unknown): FrozenConfiguration {
  const offset = profile === "new" ? Math.max(0, days - 14) : 0;
  return {
    openingAt: new Date(start + offset * DAY).toISOString(),
    baselineEnd: new Date(start + days * DAY).toISOString(),
  };
}
function frozenObservedConfiguration(
  config: unknown,
  configHash: unknown,
  generatorVersion: unknown,
  scope: SourceScope,
): FrozenConfiguration {
  const parsed = MockObservedGenerationConfigV3Schema.safeParse({
    generatorVersion,
    generation: scope.generation,
    configHash,
    config,
  });
  if (!parsed.success) throw new SourceStorageError("SOURCE_INTEGRITY");
  const { binding, historyStart, days, profile } = parsed.data.config;
  if (
    !externalId(binding.externalStoreId) ||
    !bindingKeys.every((key) => binding[key] === scope[key]) ||
    jsonDigest(parsed.data.config) !== parsed.data.configHash
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return calendar(Date.parse(historyStart), days, profile);
}
export function frozenConfiguration(
  config: unknown,
  hash: unknown,
  version: unknown,
  scope: SourceScope,
): FrozenConfiguration {
  if (version === MockObservedGenerationConfigV3Schema.unwrap().shape.generatorVersion.value)
    return frozenObservedConfiguration(config, hash, version, scope);
  if (
    !object(config) ||
    !validShape(config, scope, version) ||
    !["mock-source-v1", "mock-source-v2"].includes(version as string) ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(hash) ||
    canonicalHash(config) !== hash
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  const days = config.days as number;
  const start = Date.parse(config.historyStart as string);
  if (
    JSON.stringify(config).length > 1000000 ||
    days * Math.ceil((config.dailyOrders as number) * 1.35) > 150000 ||
    start + (days + 5) * DAY > MAX_DATE
  )
    throw new SourceStorageError("SOURCE_INTEGRITY");
  return calendar(start, days, config.profile);
}
