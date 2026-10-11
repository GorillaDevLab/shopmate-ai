import { frozenConfiguration } from "../mock-platform/configuration.js";
import { exact, integer, validateScope } from "../mock-platform/validation.js";
import type { SourceScope } from "../mock-platform/types.js";
import { workerId, workerTime } from "./input.js";

export interface SyncRuntimeBootstrap {
  readonly grantId: string;
  readonly principalUserId: string;
  readonly merchantId: string;
  readonly provider: "MOCK";
  readonly scope: Readonly<SourceScope>;
  readonly initialSince: string;
  readonly businessNow: string;
  readonly clockRevision: number;
  readonly sessionRevision: number;
  readonly config: unknown;
  readonly configHash: string;
  readonly generatorVersion: string;
  readonly runtimeOpening: string | null;
  readonly state: "WAITING_RUNTIME" | "READY";
}
const fields = [
  "grantId",
  "principalUserId",
  "merchantId",
  "provider",
  "scope",
  "initialSince",
  "businessNow",
  "clockRevision",
  "sessionRevision",
  "config",
  "configHash",
  "generatorVersion",
  "runtimeOpening",
  "state",
];
function freezeJson(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
export function readRuntimeBootstrap(value: unknown): SyncRuntimeBootstrap | null {
  if (value === null) return null;
  if (
    !exact(value, fields) ||
    value.provider !== "MOCK" ||
    !integer(value.clockRevision, 0, 2147483647) ||
    !integer(value.sessionRevision, 0, 2147483647)
  )
    throw new Error("SYNC_RESULT_INVALID");
  for (const field of ["grantId", "principalUserId", "merchantId"]) workerId(value[field]);
  workerTime(value.initialSince);
  workerTime(value.businessNow);
  validateScope(value.scope);
  const frozen = frozenConfiguration(
    value.config,
    value.configHash,
    value.generatorVersion,
    value.scope,
  );
  if (
    (value.state === "WAITING_RUNTIME" && value.runtimeOpening !== null) ||
    (value.state === "READY" && value.runtimeOpening !== frozen.openingAt) ||
    !["WAITING_RUNTIME", "READY"].includes(String(value.state))
  )
    throw new Error("SYNC_RESULT_INVALID");
  return Object.freeze({
    ...value,
    scope: Object.freeze({ ...value.scope }),
    config: freezeJson(value.config),
  }) as unknown as SyncRuntimeBootstrap;
}
