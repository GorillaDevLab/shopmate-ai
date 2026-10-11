import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeFailureRules } from "../dist/src/sync-host/failure-rules.js";
import { configFor, hashConfig, scopeFor } from "./helpers/mock-platform-fixture.mjs";

function view() {
  const scope = scopeFor(),
    config = configFor(scope);
  return {
    context: {
      grantId: "failure-a",
      principalUserId: "source-worker",
      merchantId: "source-merchant-a",
      provider: "MOCK",
      scope,
      initialSince: config.historyStart,
      businessNow: config.historyStart,
      clockRevision: 0,
      sessionRevision: 0,
      config,
      configHash: hashConfig(config),
      generatorVersion: "mock-source-v1",
      runtimeOpening: null,
      state: "WAITING_RUNTIME",
    },
    rules: [
      {
        id: "rule-a",
        priority: 1,
        startsAt: config.historyStart,
        endsAt: "2026-01-01T16:00:00.000Z",
        methods: ["listOrders"],
        effect: { kind: "DELAY", delayMs: 1 },
      },
    ],
  };
}

test("failure metadata retains checked context and deeply readonly validated rules", () => {
  const result = readRuntimeFailureRules(view());
  assert.equal(result.context.grantId, "failure-a");
  for (const value of [
    result,
    result.context.scope,
    result.rules,
    result.rules[0],
    result.rules[0].methods,
    result.rules[0].effect,
  ])
    assert.ok(Object.isFrozen(value));
  assert.equal(readRuntimeFailureRules(null), null);
});

test("failure metadata rejects malformed, duplicate, oversized and unbound rule views", () => {
  const input = view();
  for (const changed of [
    { extra: true },
    { context: null },
    { rules: [null] },
    { rules: [...input.rules, ...input.rules] },
    {
      rules: Array.from({ length: 33 }, (_, index) => ({ ...input.rules[0], id: `rule-${index}` })),
    },
    {
      rules: [
        { ...input.rules[0], effect: { kind: "FAIL", code: "RATE_LIMIT", retryAfterMs: null } },
      ],
    },
  ])
    assert.throws(() => readRuntimeFailureRules({ ...input, ...changed }));
});

test("failure metadata rejects hostile descriptors and nested rule proxies without executing traps", () => {
  let invoked = false;
  const getter = {
    ...view().rules[0],
    get priority() {
      invoked = true;
      return 9;
    },
  };
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        invoked = true;
        return Object.prototype;
      },
    },
  );
  for (const value of [
    proxy,
    { ...view(), rules: [getter] },
    { ...view(), rules: [proxy] },
    {
      ...view(),
      get rules() {
        invoked = true;
        return [];
      },
    },
  ])
    assert.throws(() => readRuntimeFailureRules(value), /SYNC_RESULT_INVALID/u);
  assert.equal(invoked, false);
});

test("failure metadata rejects hostile bootstrap context before evaluating its fields", () => {
  let invoked = false;
  const input = view();
  const proxy = new Proxy(input.context, {
    ownKeys() {
      invoked = true;
      return Reflect.ownKeys(input.context);
    },
    get() {
      invoked = true;
      return undefined;
    },
  });
  const getter = {
    ...input.context,
    get provider() {
      invoked = true;
      return "MOCK";
    },
  };
  const scope = {
    ...input.context.scope,
    get generation() {
      invoked = true;
      return 0;
    },
  };
  const config = {
    ...input.context.config,
    get historyStart() {
      invoked = true;
      return "2026-01-01T00:00:00.000Z";
    },
  };
  for (const context of [
    proxy,
    getter,
    { ...input.context, scope },
    { ...input.context, config },
  ]) {
    assert.throws(() => readRuntimeFailureRules({ ...input, context }), /SYNC_RESULT_INVALID/u);
    assert.equal(invoked, false);
  }
});
