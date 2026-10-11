import { types } from "node:util";
import { MockConnectorError, type MockFailureRuleLoader } from "@shopmate/api/mock-commerce";
import { ReadOptionsSchema, type ReadOptions } from "@shopmate/contracts";
import type { SyncRuntimeBootstrap, SyncWorkerPorts } from "@shopmate/database/sync-host";
import { validReadSignal } from "./checkpoint-read.js";
import { commerceFailure } from "./commerce-read.js";

type FailureHost = Pick<SyncWorkerPorts, "runtimeBootstrap" | "runtimeFailureRules">;
function data(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new MockConnectorError("INVALID_INPUT");
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !field || !("value" in field) || !field.enumerable)
      throw new MockConnectorError("INVALID_INPUT");
    record[key] = field.value;
  }
  return record;
}
function readOptions(input: unknown): ReadOptions {
  const { signal, ...json } = data(input);
  const parsed = ReadOptionsSchema.safeParse(json);
  if (!parsed.success || (signal !== undefined && !validReadSignal(signal)))
    throw new MockConnectorError("INVALID_INPUT");
  return {
    ...parsed.data,
    ...(signal ? { signal } : {}),
    deadlineAt: new Date(
      Math.min(Date.parse(parsed.data.deadlineAt), Date.now() + 25000),
    ).toISOString(),
  };
}
function check(call: ReadOptions): void {
  if (call.signal?.aborted) throw new MockConnectorError("ABORTED");
  if (Date.now() >= Date.parse(call.deadlineAt)) throw new MockConnectorError("TIMEOUT");
}
function equalFields(actual: unknown, expected: Record<string, unknown>): boolean {
  const checked = data(actual);
  return (
    Object.keys(checked).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => checked[key] === value)
  );
}
/** SDK contexts are validated immutable values; mutable time/revision fields are deliberately excluded. */
export function requireSameRuntime(
  actual: SyncRuntimeBootstrap | null,
  pinned: SyncRuntimeBootstrap,
): SyncRuntimeBootstrap {
  const fields = [
    "grantId",
    "principalUserId",
    "merchantId",
    "provider",
    "initialSince",
    "configHash",
    "generatorVersion",
    "runtimeOpening",
  ] as const;
  if (
    !actual ||
    actual.state !== "READY" ||
    !actual.runtimeOpening ||
    actual.provider !== "MOCK" ||
    fields.some((key) => actual[key] !== pinned[key]) ||
    !equalFields(actual.scope, { ...pinned.scope }) ||
    JSON.stringify(actual.config) !== JSON.stringify(pinned.config)
  )
    throw new MockConnectorError("PERMISSION_DENIED");
  return actual;
}
async function fresh(
  host: FailureHost,
  pinned: SyncRuntimeBootstrap,
  call: ReadOptions,
): Promise<void> {
  check(call);
  const actual = await host.runtimeBootstrap();
  check(call);
  requireSameRuntime(actual, pinned);
}
export function createSyncFailureRuleLoader(
  host: FailureHost,
  pinned: SyncRuntimeBootstrap,
): MockFailureRuleLoader {
  return async (actor, scope, input) => {
    try {
      const call = readOptions(input);
      if (
        !equalFields(actor, { userId: pinned.principalUserId, merchantId: pinned.merchantId }) ||
        !equalFields(scope, { ...pinned.scope })
      )
        throw new MockConnectorError("PERMISSION_DENIED");
      await fresh(host, pinned, call);
      const view = await host.runtimeFailureRules();
      check(call);
      if (!view) throw new MockConnectorError("PERMISSION_DENIED");
      requireSameRuntime(view.context, pinned);
      await fresh(host, pinned, call);
      return view.rules;
    } catch (error) {
      throw commerceFailure(error);
    }
  };
}
