import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeBootstrap } from "../dist/src/sync-host/bootstrap.js";
import { SyncWorkerPorts } from "../dist/src/sync-host/index.js";
import { configFor, hashConfig, scopeFor } from "./helpers/mock-platform-fixture.mjs";

function descriptor() {
  const scope = scopeFor(),
    config = configFor(scope);
  return {
    grantId: "bootstrap-a",
    principalUserId: "source-worker",
    merchantId: "source-merchant-a",
    provider: "MOCK",
    scope,
    initialSince: "2026-01-01T00:00:00.000Z",
    businessNow: config.historyStart,
    clockRevision: 0,
    sessionRevision: 0,
    config,
    configHash: hashConfig(config),
    generatorVersion: "mock-source-v1",
    runtimeOpening: config.historyStart,
    state: "READY",
  };
}
test("bootstrap validates a configured state and freezes both scope and nested source settings", () => {
  const input = descriptor(),
    context = readRuntimeBootstrap(input);
  assert.equal(context.runtimeOpening, input.config.historyStart);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.scope));
  assert.ok(Object.isFrozen(context.config.binding));
  input.scope.generation = 1;
  assert.equal(context.scope.generation, 0);
  assert.throws(() => {
    context.config.binding.storeId = "foreign";
  }, TypeError);
  assert.equal(readRuntimeBootstrap(null), null);
  assert.equal(
    readRuntimeBootstrap({ ...descriptor(), state: "WAITING_RUNTIME", runtimeOpening: null }).state,
    "WAITING_RUNTIME",
  );
});
test("bootstrap rejects malformed server bindings, clocks and inconsistent runtime readiness", () => {
  for (const changed of [
    { extra: true },
    { provider: "OTHER" },
    { principalUserId: "' OR true" },
    { clockRevision: -1 },
    { businessNow: "2026-02-30T00:00:00.000Z" },
    { runtimeOpening: "2026-01-01T00:00:00.000Z" },
    { state: "WAITING_RUNTIME" },
    { state: "UNKNOWN" },
  ])
    assert.throws(() => readRuntimeBootstrap({ ...descriptor(), ...changed }));
});
test("source configuration must retain its exact owned binding, canonical hash and generator version", () => {
  for (const changed of [
    { configHash: "f".repeat(64) },
    { generatorVersion: "unknown" },
    { scope: { ...scopeFor(), storeId: "foreign" } },
    { config: { ...configFor(scopeFor()), seed: 43 } },
  ])
    assert.throws(() => readRuntimeBootstrap({ ...descriptor(), ...changed }), {
      code: "SOURCE_INTEGRITY",
    });
});
test("grant-only connection rejects hostile identifiers before reading credentials or starting I/O", async () => {
  let invoked = false;
  const hostile = {
    toString() {
      invoked = true;
      return "bootstrap-a";
    },
  };
  for (const id of ["", "a".repeat(129), "bootstrap-a' OR true --", hostile, null])
    await assert.rejects(SyncWorkerPorts.connectGrant(id), /SYNC_INPUT_INVALID/u);
  assert.equal(invoked, false);
});
