import { expect, it } from "vitest";
import { AuditRedactor } from "./audit-redactor.js";

const scope = { organizationId: "org-a", workspaceId: "workspace-a", storeId: "store-a" };
const links = {
  requestId: "request-a",
  occurrenceId: "occurrence-a",
  runId: null,
  evidenceId: null,
  actionId: null,
  revisionId: null,
  approvalId: null,
  executionId: null,
};
function execution() {
  return {
    scopeKind: "TENANT",
    scope,
    actor: { actorId: "user-a", actorKind: "USER", identitySource: "SERVER" },
    resource: { type: "SKU", id: "sku-a" },
    result: "SUCCESS",
    occurredAt: "2026-11-03T08:00:00Z",
    sourceOccurredAt: "2026-11-02T08:00:00Z",
    links,
    event: {
      eventType: "EXECUTION",
      redactedMetadata: {
        actionKind: "PRICE",
        oldPriceMinor: 1000,
        newPriceMinor: 1100,
        reasonCode: "COMPLETED",
      },
    },
  };
}
function anonymous() {
  return {
    scopeKind: "ANONYMOUS_AUTH_SECURITY",
    scope: null,
    actor: null,
    requestId: "request-a",
    occurredAt: "2026-11-03T08:00:00Z",
    result: "REJECTED",
    reason: "UNKNOWN_IDENTITY",
    redactedMetadata: { attemptClass: "LOGIN", rateLimited: false },
  };
}
function lifecycle() {
  return {
    ...execution(),
    sourceOccurredAt: null,
    resource: { type: "EVENT", id: "事件/alpha.1" },
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
          id: "evidence/alpha.1",
          version: "version/1",
          hash: "hash/1",
          binding: { ...scope, connectionId: "connection-a", externalStoreId: "external/a" },
          eventType: "SYNC_FAILURE",
          entity: { kind: "CONNECTION", connectionId: "connection-a" },
          definitionVersion: "definition/1",
          baselineVersion: null,
        },
      },
    },
  };
}
it("preserves prices and every populated internal link alongside version one", () => {
  const input = {
    ...execution(),
    links: {
      ...links,
      runId: "run-a",
      evidenceId: "evidence-a",
      actionId: "action-a",
      revisionId: "revision-a",
      approvalId: "approval-a",
      executionId: "execution-a",
    },
  };
  expect(new AuditRedactor().redact(input)).toEqual({ redactionVersion: 1, event: input });
});
it("preserves nullable links without persisting the redaction version", () => {
  const result = new AuditRedactor().redact(execution());
  expect(result.event).toEqual(execution());
  expect(result.event).not.toHaveProperty("redactionVersion");
});
it("retains anonymous authentication isolation", () => {
  expect(new AuditRedactor().redact(anonymous()).event).toEqual(anonymous());
});
it("preserves valid lifecycle metadata and opaque Unicode identifiers", () => {
  expect(new AuditRedactor().redact(lifecycle()).event).toEqual(lifecycle());
});

const redactor = new AuditRedactor();
const secret = "synthetic-private-payload-09";
function rejects(input: unknown) {
  let caught: unknown;
  try {
    redactor.redact(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ name: "AuditRedactionError", message: "Invalid audit input" });
  if (!(caught instanceof Error)) throw new Error("Expected safe error");
  const properties = Object.fromEntries(
    Object.getOwnPropertyNames(caught).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(caught, key)?.value as unknown,
    ]),
  );
  expect(String(caught)).not.toContain(secret);
  expect(JSON.stringify(properties)).not.toContain(secret);
  expect(caught).not.toHaveProperty("cause");
}
function metadata(eventType: string): Record<string, unknown> {
  if (eventType === "EVENT_STATE_CHANGE") return lifecycle().event.redactedMetadata;
  if (eventType === "ROLE_CHANGE") return { previousRole: "VIEWER", nextRole: "OPERATOR" };
  if (eventType === "AGENT_RUN") return { runStatus: "COMPLETED" };
  if (eventType === "BRIEF" || eventType.startsWith("NOTIFICATION_"))
    return { channel: "IN_APP", deliveryStatus: "DELIVERED" };
  if (
    ["PROPOSAL", "APPROVAL", "REJECTION", "EXECUTION", "VERIFICATION", "COMPENSATION"].includes(
      eventType,
    )
  )
    return execution().event.redactedMetadata;
  return { reasonCode: "COMPLETED" };
}
const families = [
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "AUTHORIZATION",
  "PROPOSAL",
  "APPROVAL",
  "REJECTION",
  "EXECUTION",
  "VERIFICATION",
  "COMPENSATION",
  "ROLE_CHANGE",
  "CREDENTIAL_CHANGE",
  "EXPORT",
  "DISCONNECT",
  "DELETE",
  "AGENT_RUN",
  "NOTIFICATION_INTENT",
  "NOTIFICATION_DELIVERY",
  "NOTIFICATION_READ",
  "NOTIFICATION_PREFERENCE",
  "BRIEF",
  "EVENT_STATE_CHANGE",
];
function tenant(eventType: string) {
  if (eventType === "EVENT_STATE_CHANGE") return lifecycle();
  return { ...execution(), event: { eventType, redactedMetadata: metadata(eventType) } };
}
it.each(families)("preserves family %s with its exact metadata allowlist", (family) => {
  expect(redactor.redact(tenant(family)).event).toEqual(tenant(family));
});
it.each(families)("rejects metadata extensions in family %s", (family) => {
  const input = tenant(family);
  rejects({
    ...input,
    event: {
      ...input.event,
      redactedMetadata: {
        ...input.event.redactedMetadata,
        nestedSecret: { token: secret },
      },
    },
  });
});
it.each(["token", "phone", "name", "rawPrompt", "accessToken", "privateKey", "nestedSecret"])(
  "rejects forbidden metadata field %s without disclosing its value",
  (field) => {
    const input = execution();
    rejects({
      ...input,
      event: {
        ...input.event,
        redactedMetadata: {
          ...input.event.redactedMetadata,
          [field]: secret,
        },
      },
    });
  },
);
it("rejects extensions at every tenant envelope level", () => {
  const input = execution();
  for (const field of ["scope", "actor", "resource", "links", "event"] as const)
    rejects({ ...input, [field]: { ...input[field], privateValue: secret } });
  rejects({ ...input, [secret]: true });
  rejects({ ...input, redactionVersion: 1 });
});
it("rejects extensions at every lifecycle metadata level", () => {
  const input = lifecycle();
  const meta = input.event.redactedMetadata;
  const ref = meta.evidenceReference;
  for (const field of ["binding", "entity"] as const) {
    const evidenceReference = { ...ref, [field]: { ...ref[field], rawPrompt: secret } };
    rejects({
      ...input,
      event: { ...input.event, redactedMetadata: { ...meta, evidenceReference } },
    });
  }
  rejects({
    ...input,
    event: {
      ...input.event,
      redactedMetadata: {
        ...meta,
        evidenceReference: { ...ref, token: secret },
      },
    },
  });
});
it("rejects identity injection and arbitrary anonymous metadata", () => {
  const input = anonymous();
  for (const changes of [
    { scope },
    { actor: execution().actor },
    { organizationId: secret },
    { links },
    { sourceOccurredAt: execution().occurredAt },
    { reason: secret },
    { redactedMetadata: { ...input.redactedMetadata, phone: secret } },
  ])
    rejects({ ...input, ...changes });
});
it("rejects lifecycle envelope and revision mismatches", () => {
  const input = lifecycle();
  for (const changes of [
    { result: "FAILED" },
    { actor: { ...input.actor, actorKind: "SYSTEM" } },
    { sourceOccurredAt: input.occurredAt },
    { resource: null },
    { links: { ...links, actionId: "action-a" } },
    { scope: { ...scope, storeId: "other" } },
    {
      event: { ...input.event, redactedMetadata: { ...input.event.redactedMetadata, revision: 3 } },
    },
  ])
    rejects({ ...input, ...changes });
});
it.each([0, Number.MAX_SAFE_INTEGER, 13800138000])(
  "preserves legal numeric minor amount %s",
  (price) => {
    const input = execution();
    const event = {
      ...input.event,
      redactedMetadata: {
        ...input.event.redactedMetadata,
        oldPriceMinor: price,
        newPriceMinor: price,
      },
    };
    expect(redactor.redact({ ...input, event }).event).toEqual({ ...input, event });
  },
);
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
  "rejects invalid price %s",
  (price) => {
    const input = execution();
    rejects({
      ...input,
      event: {
        ...input.event,
        redactedMetadata: {
          ...input.event.redactedMetadata,
          newPriceMinor: price,
        },
      },
    });
  },
);
it("returns independent fresh data", () => {
  const input = execution();
  const result = redactor.redact(input);
  input.event.redactedMetadata.oldPriceMinor = 42;
  expect(result.event).toEqual(execution());
  expect(result.event).not.toBe(input);
  expect(Object.isFrozen(result)).toBe(true);
});
it("accepts plain JSON data with a null prototype", () => {
  const input: unknown = Object.assign(Object.create(null) as object, execution());
  expect(redactor.redact(input).event).toEqual(execution());
});
it.each([null, undefined, true, 1, "string", 1n, Symbol("invalid"), () => secret])(
  "rejects non-envelope input %s",
  (value) => {
    rejects(value);
  },
);
it("rejects cyclic, deeply nested and excessive node inputs", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejects({ ...execution(), extra: cycle });
  let deep: unknown = secret;
  for (let index = 0; index < 100; index++) deep = { child: deep };
  rejects({ ...execution(), extra: deep });
  const broad = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [index, { ...links }]));
  rejects({ ...execution(), extra: broad });
});
it("rejects oversized strings, key counts and key lengths", () => {
  rejects({ ...execution(), extra: secret.repeat(2000) });
  rejects({ ...execution(), extra: { [secret.repeat(2000)]: true } });
  const keys = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [index, secret]));
  rejects({ ...execution(), extra: keys });
});
it.each([new Date(), new Map(), new Set(), [], /secret/u, new String(secret)])(
  "rejects nonplain metadata %s",
  (value) => {
    rejects({ ...execution(), extra: value });
  },
);
it("never invokes data getters at envelope or nested levels", () => {
  let calls = 0;
  const getter = {
    enumerable: true,
    get() {
      calls++;
      throw new Error(secret);
    },
  };
  const input = execution();
  rejects(Object.defineProperty({ ...input }, "event", getter));
  rejects({
    ...input,
    event: Object.defineProperty({ ...input.event }, "redactedMetadata", getter),
  });
  rejects({ ...input, extra: Object.defineProperty({}, "token", getter) });
  expect(calls).toBe(0);
});
it("never invokes user serialization, hidden getters or inherited properties", () => {
  let calls = 0;
  const toJSON = () => {
    calls++;
    throw new Error(secret);
  };
  rejects({ ...execution(), toJSON });
  rejects(Object.defineProperty({ ...execution() }, "toJSON", { get: toJSON }));
  rejects(
    Object.assign(
      Object.create({
        get token() {
          return toJSON();
        },
      }) as object,
      execution(),
    ),
  );
  expect(calls).toBe(0);
});
it("rejects hidden, symbolic and prototype pollution fields", () => {
  rejects(Object.defineProperty({ ...execution() }, "token", { value: secret }));
  rejects({ ...execution(), [Symbol(secret)]: secret });
  const input: unknown = JSON.parse(
    JSON.stringify({ ...execution(), extra: secret }).replace('"extra":', '"__proto__":'),
  );
  rejects(input);
  expect(Object.prototype).not.toHaveProperty("extra");
});
it("converts throwing reflection failures into the fixed safe error", () => {
  const fail = () => {
    throw new Error(secret);
  };
  rejects(new Proxy({}, { getPrototypeOf: fail }));
  rejects(new Proxy({}, { ownKeys: fail }));
  rejects(new Proxy({ token: secret }, { getOwnPropertyDescriptor: fail }));
});
it("rejects family confusion and invalid actor identity sources", () => {
  const input = execution();
  rejects({
    ...input,
    event: { eventType: "AUTH_LOGIN", redactedMetadata: input.event.redactedMetadata },
  });
  rejects({ ...input, event: { ...input.event, eventType: secret } });
  rejects({ ...input, actor: { ...input.actor, identitySource: "CLIENT" } });
});
