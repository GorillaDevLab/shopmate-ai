import { expect, it } from "vitest";
import {
  AnonymousAuthSecurityEventSchema,
  TenantAuditEventSchema,
  type AnonymousAuthSecurityEvent,
  type TenantAuditEvent,
  type TenantAuditEntry,
} from "@shopmate/contracts";
import { hashAuditEntry } from "./audit-hash.js";
import {
  AuditAppendError,
  AuditAppendRepository,
  type AuditTransactionClient,
  type BoundTenantTransaction,
  type BoundAuthSecuritySink,
} from "./audit-append.repository.js";

const scope = { organizationId: "org-a", workspaceId: "workspace-a", storeId: "store-a" };
const actor = { actorId: "user-a", actorKind: "USER", identitySource: "SERVER" } as const;
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
function event() {
  return TenantAuditEventSchema.parse({
    scopeKind: "TENANT",
    scope: { ...scope },
    actor: { ...actor },
    resource: null,
    result: "SUCCESS",
    occurredAt: "2026-11-03T08:00:00.000Z",
    sourceOccurredAt: "2026-11-02T08:00:00Z",
    links: { ...links },
    event: {
      eventType: "EXECUTION",
      redactedMetadata: {
        actionKind: "PRICE",
        oldPriceMinor: 0,
        newPriceMinor: 1100,
        reasonCode: "COMPLETED",
      },
    },
  });
}
function entry(sequence = 1, prevHash: string | null = null, input = event()): TenantAuditEntry {
  const unsigned = { ...input, auditId: "audit-a", sequence, prevHash, hashVersion: 1 as const };
  return { ...unsigned, entryHash: hashAuditEntry(unsigned) };
}
function row(value = entry()): Record<string, unknown> {
  const { auditId, sequence, prevHash, entryHash, hashVersion, ...payload } = value;
  return {
    auditId,
    ...payload.scope,
    actorId: payload.actor.actorId,
    actorKind: payload.actor.actorKind,
    requestId: payload.links.requestId,
    occurrenceId: payload.links.occurrenceId,
    sequence: String(sequence),
    prevHash,
    entryHash,
    hashVersion,
    redactionVersion: 1,
    payload,
  };
}
function replayRow(value = entry()): Record<string, unknown> {
  return { ...row(value), actorAllowed: true };
}
type Reply = Awaited<ReturnType<AuditTransactionClient["query"]>>;
function result(rows: readonly Record<string, unknown>[], rowCount = rows.length): Reply {
  return { rows, rowCount };
}
class ScriptClient implements AuditTransactionClient {
  readonly calls: { sql: string; parameters: unknown[] }[] = [];
  constructor(readonly replies: (Reply | Error | ((parameters: unknown[]) => Reply))[]) {}
  async query(sql: string, parameters: unknown[] = []): Promise<Reply> {
    this.calls.push({ sql, parameters });
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("Unexpected query");
    return typeof reply === "function" ? reply(parameters) : reply;
  }
}
function transaction(client: AuditTransactionClient): BoundTenantTransaction {
  return { kind: "TENANT", client, scope: { ...scope }, actor: { ...actor }, isActive: () => true };
}
function fresh(value = entry(), head = { sequence: "0", entryHash: null as string | null }) {
  return new ScriptClient([result([head]), result([]), result([row(value)])]);
}
const repository = new AuditAppendRepository(() => "audit-a");

it("appends the exact validated event using only the caller client after locking its org head", async () => {
  const client = fresh();
  expect(await repository.appendTenant(transaction(client), event())).toEqual(entry());
  expect(client.calls).toHaveLength(3);
  expect(client.calls[0]).toEqual({
    sql: "SELECT * FROM public.audit_chain_head($1,$2,$3)",
    parameters: Object.values(scope),
  });
  expect(client.calls[1]?.sql).toMatch(/FROM public\.audit_logs/u);
  expect(client.calls[1]?.parameters).toEqual([
    ...Object.values(scope),
    "request-a",
    "occurrence-a",
  ]);
  expect(client.calls[2]?.sql).toMatch(/INSERT INTO public\.audit_logs/u);
  expect(client.calls.map(({ sql }) => sql).join(" ")).not.toMatch(/BEGIN|COMMIT|UPDATE|DELETE/u);
  expect(client.calls[2]?.parameters).toContain(JSON.stringify(event()));
});
it("uses the current organization head and preserves all nullable links and timestamp text", async () => {
  const previous = "a".repeat(64);
  const expected = entry(19, previous);
  const client = fresh(expected, { sequence: "18", entryHash: previous });
  expect(await repository.appendTenant(transaction(client), event())).toEqual(expected);
});
it("returns an unchanged occurrence after locking without inserting or generating another ID", async () => {
  const existing = entry();
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: existing.entryHash }]),
    result([replayRow()]),
  ]);
  const reordered = {
    ...event(),
    scope: {
      storeId: scope.storeId,
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
  };
  expect(await repository.appendTenant(transaction(client), reordered)).toEqual(existing);
  expect(client.calls).toHaveLength(2);
});
it("rejects changed semantics on the same occurrence rather than updating history", async () => {
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: entry().entryHash }]),
    result([replayRow()]),
  ]);
  const changed = TenantAuditEventSchema.parse({ ...event(), result: "FAILED" });
  await expect(repository.appendTenant(transaction(client), changed)).rejects.toMatchObject({
    code: "OCCURRENCE_CONFLICT",
  });
  expect(client.calls).toHaveLength(2);
});
it.each(["scope", "actor", "inactive", "domain"])(
  "rejects %s handle mismatch before SQL",
  async (mismatch) => {
    const client = fresh();
    const handle = transaction(client);
    const invalid = {
      ...handle,
      scope: mismatch === "scope" ? { ...scope, storeId: "other" } : handle.scope,
      actor: mismatch === "actor" ? { ...actor, actorId: "other" } : handle.actor,
      isActive: () => mismatch !== "inactive",
      kind: mismatch === "domain" ? "ANONYMOUS_AUTH_SECURITY" : "TENANT",
    } as BoundTenantTransaction;
    await expect(repository.appendTenant(invalid, event())).rejects.toBeInstanceOf(
      AuditAppendError,
    );
    expect(client.calls).toHaveLength(0);
  },
);
it.each(["9007199254740991", "9007199254740992", "1.5", "-1", "01"])(
  "fails closed on unusable head %s",
  async (sequence) => {
    const client = new ScriptClient([
      result([{ sequence, entryHash: "a".repeat(64) }]),
      result([]),
    ]);
    await expect(repository.appendTenant(transaction(client), event())).rejects.toBeInstanceOf(
      AuditAppendError,
    );
    expect(client.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
  },
);
it.each(["entryHash", "actorId", "redactionVersion", "sequence"])(
  "rejects corrupt persisted %s",
  async (field) => {
    const corrupt = { ...replayRow(), [field]: field === "redactionVersion" ? 2 : "corrupt" };
    const client = new ScriptClient([
      result([{ sequence: "1", entryHash: entry().entryHash }]),
      result([corrupt]),
    ]);
    await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
      code: "INVALID_STORAGE",
    });
  },
);
it("rejects a mismatched INSERT result", async () => {
  const client = fresh({ ...entry(), auditId: "other" });
  await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
    code: "INVALID_STORAGE",
  });
});
it("snapshots parsed input and bound metadata before waiting for the organization lock", async () => {
  const input = event();
  const metadata = { ...scope };
  const handle = { ...transaction(fresh()), scope: metadata };
  const client = fresh();
  client.replies[0] = () => {
    input.scope.storeId = "mutated";
    metadata.storeId = "mutated";
    return result([{ sequence: "0", entryHash: null }]);
  };
  expect(await repository.appendTenant({ ...handle, client }, input)).toEqual(entry());
});
it("rejects expired lifetime after a query and propagates a safe failure to the business owner", async () => {
  let active = true;
  const client = fresh();
  client.replies[0] = () => {
    active = false;
    return result([{ sequence: "0", entryHash: null }]);
  };
  const handle = { ...transaction(client), isActive: () => active };
  await expect(repository.appendTenant(handle, event())).rejects.toMatchObject({
    code: "INVALID_HANDLE",
  });
  expect(client.calls).toHaveLength(1);
});
it("replaces database errors with bounded payload-free domain errors", async () => {
  const client = new ScriptClient([new Error("password=secret arbitrary SQL detail")]);
  const failed = repository.appendTenant(transaction(client), event());
  await expect(failed).rejects.toMatchObject({
    code: "STORAGE_FAILED",
    message: "Audit append failed",
  });
  await expect(failed).rejects.not.toHaveProperty("cause");
});
it.each(["", "bad id", "x".repeat(129)])("validates generated audit ID %s", async (auditId) => {
  const client = fresh();
  await expect(
    new AuditAppendRepository(() => auditId).appendTenant(transaction(client), event()),
  ).rejects.toBeInstanceOf(AuditAppendError);
  expect(client.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});

function anonymous(): AnonymousAuthSecurityEvent {
  return AnonymousAuthSecurityEventSchema.parse({
    scopeKind: "ANONYMOUS_AUTH_SECURITY",
    scope: null,
    actor: null,
    requestId: "request-a",
    occurredAt: "2026-11-03T08:00:00Z",
    result: "REJECTED",
    reason: "UNKNOWN_IDENTITY",
    redactedMetadata: { attemptClass: "LOGIN", rateLimited: false },
  });
}
function sink(client: AuditTransactionClient): BoundAuthSecuritySink {
  return { kind: "ANONYMOUS_AUTH_SECURITY", client, isActive: () => true };
}
it("appends unknown login with explicit null identity using INSERT-only anonymous privileges", async () => {
  const client = new ScriptClient([result([], 1)]);
  expect(await repository.appendAnonymousSecurity(sink(client), anonymous())).toEqual({
    ...anonymous(),
    auditId: "audit-a",
  });
  expect(client.calls).toEqual([
    {
      sql: 'INSERT INTO public.auth_security_events ("auditId",payload) VALUES ($1,$2::jsonb)',
      parameters: ["audit-a", JSON.stringify(anonymous())],
    },
  ]);
  expect(client.calls[0]?.sql).not.toMatch(/SELECT|RETURNING|audit_logs|BEGIN|COMMIT/iu);
});
it.each([null, 0, 2])("rejects anonymous affected-row count %s", async (rowCount) => {
  const client = new ScriptClient([{ rows: [], rowCount }]);
  await expect(repository.appendAnonymousSecurity(sink(client), anonymous())).rejects.toMatchObject(
    { code: "INVALID_STORAGE" },
  );
});
it("rejects tenant input on the explicit anonymous method before any SQL", async () => {
  const client = new ScriptClient([]);
  await expect(
    repository.appendAnonymousSecurity(
      sink(client),
      event() as unknown as AnonymousAuthSecurityEvent,
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(client.calls).toHaveLength(0);
});
it("rejects anonymous input on the explicit tenant method before any SQL", async () => {
  const client = new ScriptClient([]);
  await expect(
    repository.appendTenant(transaction(client), anonymous() as unknown as TenantAuditEvent),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(client.calls).toHaveLength(0);
});
it.each(["inactive", "domain"])("rejects %s anonymous owner handle before SQL", async (kind) => {
  const client = new ScriptClient([]);
  const handle = {
    ...sink(client),
    isActive: () => kind !== "inactive",
    kind: kind === "domain" ? "TENANT" : "ANONYMOUS_AUTH_SECURITY",
  } as BoundAuthSecuritySink;
  await expect(repository.appendAnonymousSecurity(handle, anonymous())).rejects.toMatchObject({
    code: "INVALID_HANDLE",
  });
  expect(client.calls).toHaveLength(0);
});
it("validates anonymous generated IDs before insertion", async () => {
  const client = new ScriptClient([]);
  await expect(
    new AuditAppendRepository(() => "bad id").appendAnonymousSecurity(sink(client), anonymous()),
  ).rejects.toMatchObject({ code: "INVALID_ID" });
  expect(client.calls).toHaveLength(0);
});
it("propagates a bounded anonymous storage failure without a sensitive cause", async () => {
  const client = new ScriptClient([new Error("raw email password cookie secret")]);
  const pending = repository.appendAnonymousSecurity(sink(client), anonymous());
  await expect(pending).rejects.toMatchObject({
    code: "STORAGE_FAILED",
    message: "Audit append failed",
  });
  await expect(pending).rejects.not.toHaveProperty("cause");
});

it("does not trust even domain-shaped errors supplied by the client", async () => {
  const untrusted = Object.assign(new AuditAppendError("INVALID_INPUT"), {
    message: "private database detail",
    cause: "raw cookie",
  });
  const client = new ScriptClient([untrusted]);
  const pending = repository.appendTenant(transaction(client), event());
  await expect(pending).rejects.toMatchObject({
    code: "STORAGE_FAILED",
    message: "Audit append failed",
  });
  await expect(pending).rejects.not.toHaveProperty("cause");
});

function evidenceReference() {
  return {
    schemaVersion: 1,
    id: "evidence/alpha.1",
    version: "version/1",
    hash: "hash/1",
    binding: { ...scope, connectionId: "connection-a", externalStoreId: "external/a" },
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: "connection-a" },
    definitionVersion: "definition/1",
    baselineVersion: null,
  };
}
function lifecycle(): TenantAuditEvent {
  return TenantAuditEventSchema.parse({
    ...event(),
    sourceOccurredAt: null,
    resource: { type: "EVENT", id: "事件/'; DROP TABLE audit_logs;--" },
    event: {
      eventType: "EVENT_STATE_CHANGE",
      redactedMetadata: {
        fromState: "OPEN",
        toState: "ACKNOWLEDGED",
        reason: "ACKNOWLEDGED_BY_OPERATOR",
        expectedRevision: 1,
        revision: 2,
        evidenceReference: evidenceReference(),
      },
    },
  });
}
const security = [
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "AUTHORIZATION",
  "CREDENTIAL_CHANGE",
  "EXPORT",
  "DISCONNECT",
  "DELETE",
] as const;
const actions = [
  "PROPOSAL",
  "APPROVAL",
  "REJECTION",
  "EXECUTION",
  "VERIFICATION",
  "COMPENSATION",
] as const;
const notifications = [
  "NOTIFICATION_INTENT",
  "NOTIFICATION_DELIVERY",
  "NOTIFICATION_READ",
  "NOTIFICATION_PREFERENCE",
  "BRIEF",
] as const;
function familyDetails(): TenantAuditEvent["event"][] {
  return [
    ...security.map((eventType) => ({ eventType, redactedMetadata: { reasonCode: null } })),
    ...actions.map((eventType) => ({
      eventType,
      redactedMetadata: {
        actionKind: "PRICE" as const,
        oldPriceMinor: null,
        newPriceMinor: Number.MAX_SAFE_INTEGER,
        reasonCode: null,
      },
    })),
    ...notifications.map((eventType) => ({
      eventType,
      redactedMetadata: { channel: "IN_APP" as const, deliveryStatus: "DELIVERED" as const },
    })),
    { eventType: "ROLE_CHANGE", redactedMetadata: { previousRole: null, nextRole: "OPERATOR" } },
    { eventType: "AGENT_RUN", redactedMetadata: { runStatus: "COMPLETED" } },
  ];
}
it.each(familyDetails())(
  "preserves the strict $eventType family without widening metadata",
  async (detail) => {
    const input = TenantAuditEventSchema.parse({ ...event(), event: detail });
    const expected = entry(1, null, input);
    expect(await repository.appendTenant(transaction(fresh(expected)), input)).toEqual(expected);
  },
);
it("preserves lifecycle evidence and SQL-looking opaque IDs exclusively in parameter values", async () => {
  const input = lifecycle();
  const expected = entry(1, null, input);
  const client = fresh(expected);
  expect(await repository.appendTenant(transaction(client), input)).toEqual(expected);
  expect(client.calls[2]?.parameters).toContain(JSON.stringify(input));
  expect(client.calls.every(({ sql }) => !sql.includes("DROP TABLE"))).toBe(true);
  expect(input.event.eventType).toBe("EVENT_STATE_CHANGE");
});
it("preserves every populated audit link", async () => {
  const populated = {
    requestId: "request-a",
    occurrenceId: "occurrence-a",
    runId: "run-a",
    evidenceId: "evidence-a",
    actionId: "action-a",
    revisionId: "revision-a",
    approvalId: "approval-a",
    executionId: "execution-a",
  };
  const input = TenantAuditEventSchema.parse({ ...event(), links: populated });
  const expected = entry(1, null, input);
  expect(await repository.appendTenant(transaction(fresh(expected)), input)).toEqual(expected);
});
it.each(["SERVICE", "SYSTEM"] as const)(
  "binds %s actor to the server grant identity",
  async (actorKind) => {
    const boundActor = { ...actor, actorKind, actorId: "service-grant-a" };
    const input = TenantAuditEventSchema.parse({ ...event(), actor: boundActor });
    const expected = entry(1, null, input);
    const client = fresh(expected);
    expect(
      await repository.appendTenant({ ...transaction(client), actor: boundActor }, input),
    ).toEqual(expected);
    expect(client.calls[2]?.parameters.slice(4, 6)).toEqual(["service-grant-a", actorKind]);
  },
);
it("treats a changed bound actor on an existing occurrence as a semantic conflict", async () => {
  const boundActor = { ...actor, actorId: "user-b" };
  const input = TenantAuditEventSchema.parse({ ...event(), actor: boundActor });
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: entry().entryHash }]),
    result([replayRow()]),
  ]);
  await expect(
    repository.appendTenant({ ...transaction(client), actor: boundActor }, input),
  ).rejects.toMatchObject({ code: "OCCURRENCE_CONFLICT" });
  expect(client.calls).toHaveLength(2);
});
it.each([0, 0n])("decodes supported native PostgreSQL bigint parser head %s", async (sequence) => {
  const client = fresh();
  client.replies[0] = result([{ sequence, entryHash: null }]);
  expect(await repository.appendTenant(transaction(client), event())).toEqual(entry());
});
it.each([
  { sequence: "0", entryHash: "a".repeat(64) },
  { sequence: "1", entryHash: null },
  { sequence: "0", entryHash: null, unexpected: true },
])("rejects malformed or inconsistent head %#", async (head) => {
  const client = new ScriptClient([result([head])]);
  await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
    code: "INVALID_STORAGE",
  });
  expect(client.calls).toHaveLength(1);
});
it("verifies a syntactically valid but incorrect persisted hash", async () => {
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: entry().entryHash }]),
    result([{ ...replayRow(), entryHash: "a".repeat(64) }]),
  ]);
  await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
    code: "INVALID_STORAGE",
  });
});
it.each(["organizationId", "workspaceId", "storeId", "requestId", "occurrenceId"])(
  "verifies persisted %s header against payload",
  async (field) => {
    const client = new ScriptClient([
      result([{ sequence: "1", entryHash: entry().entryHash }]),
      result([{ ...replayRow(), [field]: "other" }]),
    ]);
    await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
      code: "INVALID_STORAGE",
    });
  },
);
it("rejects persisted occurrence beyond the locked head", async () => {
  const client = new ScriptClient([
    result([{ sequence: "0", entryHash: null }]),
    result([replayRow()]),
  ]);
  await expect(repository.appendTenant(transaction(client), event())).rejects.toMatchObject({
    code: "INVALID_STORAGE",
  });
});
it("replays a historical occurrence using the current head without creating a new entry", async () => {
  const client = new ScriptClient([
    result([{ sequence: "20", entryHash: "a".repeat(64) }]),
    result([replayRow()]),
  ]);
  const noNewId = new AuditAppendRepository(() => {
    throw new Error("Should not generate ID for replay");
  });
  expect(await noNewId.appendTenant(transaction(client), event())).toEqual(entry());
});
it("maps a hidden cross-store unique collision without reading or echoing its payload", async () => {
  const client = fresh();
  client.replies[2] = Object.assign(new Error("private scope and payload"), {
    code: "23505",
    detail: "other-store",
  });
  const pending = repository.appendTenant(transaction(client), event());
  await expect(pending).rejects.toMatchObject({
    code: "STORAGE_FAILED",
    message: "Audit append failed",
  });
  await expect(pending).rejects.not.toHaveProperty("detail");
  expect(client.calls[1]?.parameters.slice(0, 3)).toEqual(Object.values(scope));
});
it("propagates audit failure after the owner's business mutation on that exact client", async () => {
  const client = new ScriptClient([result([], 1), new Error("audit unavailable")]);
  let ownerReachedCommit = false;
  const owner = async () => {
    await client.query("UPDATE business_entity SET value=$1 WHERE id=$2", [1, "business-a"]);
    await repository.appendTenant(transaction(client), event());
    ownerReachedCommit = true;
  };
  await expect(owner()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  expect(ownerReachedCommit).toBe(false);
  expect(client.calls).toHaveLength(2);
});
it.each(["tenant", "anonymous"])(
  "rejects sensitive extra fields in %s input without echo or SQL",
  async (domain) => {
    const client = new ScriptClient([]);
    const sensitiveTenant = { ...event(), password: "private" };
    const sensitiveAnonymous = { ...anonymous(), cookie: "private" };
    const pending =
      domain === "tenant"
        ? repository.appendTenant(transaction(client), sensitiveTenant)
        : repository.appendAnonymousSecurity(sink(client), sensitiveAnonymous);
    await expect(pending).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Audit append failed",
    });
    await expect(pending).rejects.not.toHaveProperty("cause");
    expect(client.calls).toHaveLength(0);
  },
);
it("bounds oversized input and does not expose parser issues", async () => {
  const client = new ScriptClient([]);
  const input = { ...event(), raw: "x".repeat(40_000) };
  const pending = repository.appendTenant(transaction(client), input);
  await expect(pending).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(pending).rejects.not.toHaveProperty("issues");
  expect(client.calls).toHaveLength(0);
});
it("never evaluates untrusted audit accessors", async () => {
  let accessed = false;
  const input = Object.defineProperty({ ...event() }, "cookie", {
    enumerable: true,
    get: () => {
      accessed = true;
      throw new Error("private");
    },
  });
  const client = new ScriptClient([]);
  await expect(repository.appendTenant(transaction(client), input)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(accessed).toBe(false);
  expect(client.calls).toHaveLength(0);
});
it("snapshots anonymous input before awaiting insertion", async () => {
  const input = anonymous();
  const client = new ScriptClient([
    () => {
      input.redactedMetadata.rateLimited = true;
      return result([], 1);
    },
  ]);
  const saved = await repository.appendAnonymousSecurity(sink(client), input);
  expect(saved.redactedMetadata.rateLimited).toBe(false);
  expect(client.calls[0]?.parameters[1]).toBe(JSON.stringify(anonymous()));
});
it("checks anonymous owner lifetime after insertion", async () => {
  let active = true;
  const client = new ScriptClient([
    () => {
      active = false;
      return result([], 1);
    },
  ]);
  await expect(
    repository.appendAnonymousSecurity({ ...sink(client), isActive: () => active }, anonymous()),
  ).rejects.toMatchObject({ code: "INVALID_HANDLE" });
});
it("rejects anonymous response rows because its INSERT grants no read privileges", async () => {
  const client = new ScriptClient([result([{ private: "unexpected" }], 1)]);
  await expect(repository.appendAnonymousSecurity(sink(client), anonymous())).rejects.toMatchObject(
    { code: "INVALID_STORAGE" },
  );
});
it.each([false, null, undefined, "true"])(
  "rejects a rotated or unverifiable service actor on replay (%s)",
  async (actorAllowed) => {
    const service = { ...actor, actorKind: "SERVICE" as const, actorId: "service-a" };
    const input = TenantAuditEventSchema.parse({ ...event(), actor: service });
    const persisted = entry(1, null, input);
    const client = new ScriptClient([
      result([{ sequence: "1", entryHash: persisted.entryHash }]),
      result([actorAllowed === undefined ? row(persisted) : { ...row(persisted), actorAllowed }]),
    ]);
    await expect(
      repository.appendTenant({ ...transaction(client), actor: service }, input),
    ).rejects.toMatchObject({ code: "INVALID_HANDLE" });
    expect(client.calls[1]?.sql).toContain(
      'public.audit_actor_access(audit_row) AS "actorAllowed"',
    );
    expect(client.calls).toHaveLength(2);
  },
);
it("replays a service occurrence only after the current database actor check succeeds", async () => {
  const service = { ...actor, actorKind: "SERVICE" as const, actorId: "service-a" };
  const input = TenantAuditEventSchema.parse({ ...event(), actor: service });
  const persisted = entry(1, null, input);
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: persisted.entryHash }]),
    result([replayRow(persisted)]),
  ]);
  expect(await repository.appendTenant({ ...transaction(client), actor: service }, input)).toEqual(
    persisted,
  );
  expect(client.calls[1]?.sql).toContain('public.audit_actor_access(audit_row) AS "actorAllowed"');
  expect(client.calls).toHaveLength(2);
});

function insertedRow(parameters: unknown[]): Record<string, unknown> {
  const names = [
    "auditId",
    "organizationId",
    "workspaceId",
    "storeId",
    "actorId",
    "actorKind",
    "requestId",
    "occurrenceId",
    "sequence",
    "prevHash",
    "entryHash",
    "hashVersion",
    "redactionVersion",
  ];
  return {
    ...Object.fromEntries(names.map((name, index) => [name, parameters[index]])),
    payload: JSON.parse(String(parameters[13])) as unknown,
  };
}
function priceEvent(oldPriceMinor: number, newPriceMinor: number): TenantAuditEvent {
  return TenantAuditEventSchema.parse({
    ...event(),
    event: {
      eventType: "EXECUTION",
      redactedMetadata: {
        actionKind: "PRICE",
        oldPriceMinor,
        newPriceMinor,
        reasonCode: "COMPLETED",
      },
    },
  });
}
it("accepts signed-zero prices after the real INSERT JSON parameter round trip", async () => {
  const input = priceEvent(JSON.parse("-0") as number, JSON.parse("-0") as number);
  const client = new ScriptClient([
    result([{ sequence: "0", entryHash: null }]),
    result([]),
    (parameters) => result([insertedRow(parameters)]),
  ]);
  const stored = await repository.appendTenant(transaction(client), input);
  expect(stored).toEqual(entry(1, null, priceEvent(0, 0)));
  expect(stored.entryHash).toBe(entry(1, null, input).entryHash);
});
it("replays persisted positive-zero prices for an identical signed-zero request", async () => {
  const persisted = entry(1, null, priceEvent(0, 0));
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: persisted.entryHash }]),
    result([JSON.parse(JSON.stringify(replayRow(persisted))) as Record<string, unknown>]),
  ]);
  expect(await repository.appendTenant(transaction(client), priceEvent(-0, -0))).toEqual(persisted);
  expect(client.calls).toHaveLength(2);
});
it("still rejects real price changes against a JSON-persisted occurrence", async () => {
  const persisted = entry(1, null, priceEvent(0, 1));
  const client = new ScriptClient([
    result([{ sequence: "1", entryHash: persisted.entryHash }]),
    result([JSON.parse(JSON.stringify(replayRow(persisted))) as Record<string, unknown>]),
  ]);
  await expect(
    repository.appendTenant(transaction(client), priceEvent(-0, 2)),
  ).rejects.toMatchObject({
    code: "OCCURRENCE_CONFLICT",
  });
});
