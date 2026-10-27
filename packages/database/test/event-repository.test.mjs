import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventFingerprint, EventAppendEvidenceRequestSchema } from "@shopmate/contracts";
import { createEventRepository } from "../src/event.repository.ts";

const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const actor = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "OPERATOR",
  permissions: ["tenant:read"],
};
const start = "2026-10-01T00:00:00Z";
const end = "2026-10-02T00:00:00Z";
const later = "2026-10-02T00:15:00Z";
const period = { periodStart: start, periodEnd: end, timezone: "Asia/Shanghai", currency: "CNY" };

function evidenceValue(version, observedAt) {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    observedAt,
    sourceWatermark: end,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    issues: [],
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    definitionVersion: "definition-a",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [sourceReference(version)],
    facts: {
      lastSuccessAt: null,
      lagSeconds: null,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
    },
  };
}
function sourceReference(version) {
  return {
    kind: "NORMALIZED_AGGREGATE",
    id: "source-a",
    version,
    hash: `source-hash-${version}`,
    binding,
    definitionVersion: "definition-a",
    period,
    observedAt: end,
    measure: null,
  };
}
function appendRequest(version = "z-old", observedAt = end) {
  const evidence = evidenceValue(version, observedAt);
  const reference = {
    schemaVersion: 1,
    id: `evidence-${version}`,
    version,
    hash: `hash-${version}`,
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: evidence.definitionVersion,
    baselineVersion: null,
  };
  const candidate = {
    schemaVersion: 1,
    fingerprint: createEventFingerprint(evidence),
    severityFloor: "HIGH",
    rulePolicyVersion: "policy-a",
    evidence,
  };
  return EventAppendEvidenceRequestSchema.parse({
    actor,
    binding,
    candidate,
    reference,
    expectedRevision: null,
  });
}

function inserted(sql, params) {
  const columns = /\(([^)]+)\)\s*VALUES/u
    .exec(sql)[1]
    .split(",")
    .map((s) => s.trim().replaceAll('"', ""));
  return Object.fromEntries(
    columns.map((key, index) => [
      key,
      ["payload", "issues"].includes(key) ? JSON.parse(params[index]) : params[index],
    ]),
  );
}

function database() {
  const state = {
    events: [],
    evidence: [],
    allowed: true,
    calls: [],
    fail: null,
    saved: null,
    now: end,
  };
  const client = {
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      if (state.fail && sql.includes(state.fail))
        throw Object.assign(new Error("private detail"), { code: "08006" });
      return { rows: respond(state, sql, params) };
    },
  };
  return {
    state,
    client,
    repository: createEventRepository({ actor, client, now: () => state.now }),
  };
}

function selectedEvents(state, params) {
  return state.events
    .filter((row) =>
      Object.values(binding).every((value, i) => row[Object.keys(binding)[i]] === params[i]),
    )
    .map((row) => ({
      ...row,
      currentPayload: state.evidence.find((item) => item.id === row.currentEvidenceId)?.payload,
    }));
}

function respond(state, sql, p) {
  if (sql.includes("event_scope_access")) return [{ allowed: state.allowed }];
  if (sql.startsWith("SAVEPOINT"))
    state.saved = globalThis.structuredClone({ events: state.events, evidence: state.evidence });
  if (sql.startsWith("ROLLBACK TO")) Object.assign(state, state.saved);
  if (sql.includes("INSERT INTO public.events")) return storeEvent(state, sql, p);
  if (sql.includes("INSERT INTO public.event_evidence (")) {
    const row = inserted(sql, p);
    state.evidence.push(row);
    return [row];
  }
  if (sql.includes("event:active"))
    return selectedEvents(state, p).filter(
      (row) => row.fingerprint === p[5] && row.state !== "RESOLVED",
    );
  if (sql.includes("event:detail"))
    return selectedEvents(state, p).filter((row) => row.id === p[5]);
  if (sql.includes("event:current-evidence"))
    return state.evidence.filter((row) => row.id === p[5]);
  if (sql.includes("event:duplicates"))
    return state.evidence.filter(
      (row) =>
        row.eventId === p[5] && (row.id === p[6] || row.hash === p[7] || row.version === p[8]),
    );
  if (sql.includes("event:sources")) return sourceHistory(state, p);
  if (sql.includes("event:source-conflicts")) return sourceConflicts(state, p);
  if (sql.includes("event:touch")) return touch(state, p);
  if (sql.includes("event:advance")) return advance(state, p);
  if (sql.includes("event:transition")) return transition(state, p);
  if (sql.includes("event:history")) return historyRows(state, p);
  if (sql.includes("event:evidence"))
    return state.evidence.filter(
      (row) => row.eventId === p[5] && row.id === p[6] && row.version === p[7] && row.hash === p[8],
    );
  if (sql.includes("event:list")) return listRows(state, p);
  return [];
}

function storeEvent(state, sql, p) {
  const row = inserted(sql, p);
  if (
    state.events.some((item) => item.fingerprint === row.fingerprint && item.state !== "RESOLVED")
  )
    throw Object.assign(new Error("unique"), { code: "23505" });
  state.events.push(row);
  return [row];
}

function sourceHistory(state, p) {
  const refs = JSON.parse(p[6]);
  return state.evidence.filter(
    (row) =>
      row.eventId === p[5] &&
      refs.every((ref) =>
        row.payload.sourceReferences.some(
          (prior) =>
            prior.kind === ref.kind && prior.id === ref.id && prior.version === ref.version,
        ),
      ),
  );
}
function sourceConflicts(state, p) {
  const refs = JSON.parse(p[6]);
  return state.evidence
    .filter((row) => row.eventId === p[5])
    .flatMap((row) => row.payload.sourceReferences)
    .filter((prior) =>
      refs.some(
        (ref) => prior.kind === ref.kind && prior.id === ref.id && prior.version === ref.version,
      ),
    )
    .map((reference) => ({ reference }));
}

function touch(state, p) {
  const row = state.events.find((item) => item.id === p[5]);
  if (Date.parse(p[6]) > Date.parse(row.lastSeenAt)) row.lastSeenAt = p[6];
  return [row];
}

function advance(state, p) {
  const row = state.events.find((item) => item.id === p[5] && item.revision === p[6]);
  if (!row) return [];
  Object.assign(row, {
    revision: p[6] + 1,
    currentEvidenceId: p[7],
    currentEvidenceVersion: p[8],
    currentEvidenceHash: p[9],
    lastSeenAt: p[10],
  });
  return [row];
}

function transition(state, p) {
  const row = state.events.find(
    (item) => item.id === p[5] && item.revision === p[6] && item.state === p[7],
  );
  if (!row) return [];
  Object.assign(row, { revision: p[6] + 1, state: p[8] });
  return [row];
}

function historyRows(state, p) {
  return state.evidence
    .filter((row) => row.eventId === p[5] && (p[6] === null || row.evidenceRevision < p[6]))
    .sort((a, b) => b.evidenceRevision - a.evidenceRevision)
    .slice(0, p[7]);
}

function listRows(state, p) {
  return selectedEvents(state, p)
    .filter(
      (row) =>
        (!p[5].length || p[5].includes(row.eventType)) &&
        (!p[6].length || p[6].includes(row.state)),
    )
    .filter(
      (row) =>
        p[9] === null ||
        Date.parse(row.firstSeenAt) < Date.parse(p[9]) ||
        (Date.parse(row.firstSeenAt) === Date.parse(p[9]) && row.id < p[10]),
    )
    .sort(
      (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || b.id.localeCompare(a.id),
    )
    .slice(0, p[11]);
}

function listRequest(cursor = null) {
  return { actor, binding, eventTypes: [], states: [], entity: null, limit: 1, cursor };
}

async function recurrence(db, version, observedAt) {
  const event = await seed(db, appendRequest(version, observedAt));
  const result = await db.repository.stateTransition(transitionRequest(event, "RESOLVED"));
  assert.equal(result.ok, true);
  return event;
}

async function seed(db, request = appendRequest()) {
  if (Date.parse(request.candidate.evidence.observedAt) > Date.parse(db.state.now))
    db.state.now = request.candidate.evidence.observedAt;
  const result = await db.repository.appendEvidence(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function detailRequest(event) {
  return { actor, binding, eventId: event.id };
}
function currentRequest(request = appendRequest()) {
  const { eventType, entity, baselineVersion } = request.candidate.evidence;
  return { actor, binding, identity: { binding, eventType, entity, baselineVersion } };
}
function transitionRequest(event, toState = "ACKNOWLEDGED") {
  return {
    ...detailRequest(event),
    expectedRevision: event.revision,
    fromState: event.state,
    toState,
    reason: toState === "RESOLVED" ? "MANUALLY_RESOLVED" : "ACKNOWLEDGED_BY_OPERATOR",
    changedAt: later,
  };
}

test("append creates one scoped active event and immutable evidence", async () => {
  const db = database();
  const event = await seed(db);
  assert.equal(event.revision, 1);
  assert.deepEqual(event.currentEvidence, appendRequest().reference);
  assert.equal(db.state.events.length, 1);
  assert.equal(db.state.evidence.length, 1);
  assert.deepEqual((await db.repository.current(currentRequest())).value, event);
});

test("same hash reuses evidence, advances lastSeen monotonically and preserves original payload", async () => {
  const db = database();
  const event = await seed(db);
  db.state.now = later;
  const latest = await seed(db);
  assert.equal(latest.id, event.id);
  assert.equal(latest.revision, 1);
  assert.equal(Date.parse(latest.lastSeenAt), Date.parse(later));
  await seed(db);
  assert.equal(db.state.evidence.length, 1);
  assert.equal(db.state.evidence[0].payload.observedAt, end);
  assert.equal(Date.parse(db.state.events[0].lastSeenAt), Date.parse(later));
});

test("same hash cannot mask changed facts or immutable policy", async () => {
  const db = database();
  await seed(db);
  const changed = globalThis.structuredClone(appendRequest());
  changed.candidate.evidence.facts.typedErrorCode = "AUTH_EXPIRED";
  assert.equal((await db.repository.appendEvidence(changed)).error.code, "CONFLICT");
  const policy = globalThis.structuredClone(appendRequest());
  policy.candidate.rulePolicyVersion = "different";
  assert.equal((await db.repository.appendEvidence(policy)).error.code, "CONFLICT");
  assert.equal(db.state.evidence.length, 1);
});

test("opaque source versions append history and replay never replaces current", async () => {
  const db = database();
  const first = await seed(db);
  const second = await seed(db, {
    ...appendRequest("a-new", later),
    expectedRevision: first.revision,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.currentEvidence.version, "a-new");
  db.state.now = "2026-10-02T00:30:00Z";
  const replay = await seed(db, appendRequest("z-old"));
  assert.equal(replay.currentEvidence.version, "a-new");
  assert.equal(Date.parse(replay.lastSeenAt), Date.parse(second.lastSeenAt));
  assert.equal(db.state.evidence.length, 2);
  const page = await db.repository.history({ ...detailRequest(first), limit: 10, cursor: null });
  assert.deepEqual(
    page.value.items.map((item) => item.reference.version),
    ["a-new", "z-old"],
  );
});

test("older observations and reused source versions cannot overwrite current", async () => {
  const db = database();
  await seed(db, appendRequest("a-new", later));
  assert.equal(
    (await db.repository.appendEvidence(appendRequest("older"))).error.code,
    "VERSION_MISMATCH",
  );
  const replay = globalThis.structuredClone(appendRequest("a-new", "2026-10-02T00:30:00Z"));
  db.state.now = "2026-10-02T00:30:00Z";
  Object.assign(replay.reference, { id: "other", version: "other", hash: "other" });
  assert.equal((await db.repository.appendEvidence(replay)).error.code, "VERSION_MISMATCH");
  assert.equal(db.state.evidence.length, 1);
});

test("CAS rejects stale append and only one transition succeeds", async () => {
  const db = database();
  const event = await seed(db);
  const request = transitionRequest(event);
  const outcomes = await Promise.all([
    db.repository.stateTransition(request),
    db.repository.stateTransition(request),
  ]);
  assert.equal(outcomes.filter((item) => item.ok).length, 1);
  assert.equal(outcomes.find((item) => !item.ok).error.code, "CONFLICT");
  const stale = { ...appendRequest("a-new", later), expectedRevision: 1 };
  db.state.now = later;
  assert.equal((await db.repository.appendEvidence(stale)).error.code, "CONFLICT");
});

test("resolved recurrence creates a new event and keeps old evidence readable", async () => {
  const db = database();
  const first = await seed(db);
  assert.equal(
    (await db.repository.stateTransition(transitionRequest(first, "RESOLVED"))).ok,
    true,
  );
  const second = await seed(db, appendRequest("recurrence", later));
  assert.notEqual(second.id, first.id);
  const result = await db.repository.evidence({
    ...detailRequest(first),
    reference: first.currentEvidence,
  });
  assert.deepEqual(result.value.reference, first.currentEvidence);
});

test("trusted actor binding and fresh database authorization reject impersonation and revocation", async () => {
  const db = database();
  const forged = { ...currentRequest(), actor: { ...actor, userId: "attacker" } };
  assert.equal((await db.repository.current(forged)).error.code, "FORBIDDEN");
  db.state.allowed = false;
  assert.equal((await db.repository.appendEvidence(appendRequest())).error.code, "FORBIDDEN");
  assert.equal((await db.repository.current(currentRequest())).error.code, "NOT_FOUND");
  assert.equal(db.state.events.length, 0);
});

test("transaction ownership stays with host and a failed append rolls back its savepoint", async () => {
  const db = database();
  db.state.fail = "INSERT INTO public.event_evidence (";
  assert.equal(
    (await db.repository.appendEvidence(appendRequest())).error.code,
    "SOURCE_UNAVAILABLE",
  );
  assert.equal(db.state.events.length, 0);
  assert.equal(
    db.state.calls.some(({ sql }) => /^(?:BEGIN|COMMIT|ROLLBACK$)/u.test(sql)),
    false,
  );
  assert.ok(db.state.calls.some(({ sql }) => sql.startsWith("ROLLBACK TO SAVEPOINT")));
});

test("invalid inputs and malformed persisted output fail closed", async () => {
  const db = database();
  assert.equal(
    (await db.repository.current({ ...currentRequest(), extra: true })).error.code,
    "INVALID_INPUT",
  );
  const event = await seed(db);
  db.state.events[0].revision = "9007199254740992";
  assert.equal((await db.repository.detail(detailRequest(event))).error.code, "SOURCE_UNAVAILABLE");
});

test("list cursor uses immutable firstSeen/id and rejects changed actor scope or filters", async () => {
  const db = database();
  const first = await recurrence(db, "one", end);
  const second = await recurrence(db, "two", later);
  const latest = await seed(db, appendRequest("three", "2026-10-02T00:30:00Z"));
  const page = await db.repository.list(listRequest());
  assert.equal(page.value.items[0].id, latest.id);
  assert.ok(page.value.nextCursor.length <= 1024);
  db.state.now = "2026-10-02T00:45:00Z";
  await seed(db, appendRequest("three", "2026-10-02T00:30:00Z"));
  const next = await db.repository.list(listRequest(page.value.nextCursor));
  assert.equal(next.value.items[0].id, second.id);
  const last = await db.repository.list(listRequest(next.value.nextCursor));
  assert.equal(last.value.items[0].id, first.id);
  assert.equal(last.value.nextCursor, null);
  const changed = { ...listRequest(page.value.nextCursor), states: ["RESOLVED"] };
  assert.equal((await db.repository.list(changed)).error.code, "INVALID_INPUT");
  assert.equal((await db.repository.list(listRequest("malformed"))).error.code, "INVALID_INPUT");
});

test("history cursor preserves old evidence and binds the event and page filters", async () => {
  const db = database();
  const first = await seed(db);
  await seed(db, appendRequest("new", later));
  const query = { ...detailRequest(first), limit: 1, cursor: null };
  const page = await db.repository.history(query);
  assert.equal(page.value.items[0].reference.version, "new");
  const next = await db.repository.history({ ...query, cursor: page.value.nextCursor });
  assert.equal(next.value.items[0].reference.version, "z-old");
  assert.equal(next.value.nextCursor, null);
  const changed = { ...query, eventId: "other", cursor: page.value.nextCursor };
  assert.equal((await db.repository.history(changed)).error.code, "INVALID_INPUT");
});

test("full binding collision cannot overwrite an active fingerprint", async () => {
  const db = database();
  const original = await seed(db);
  const changed = globalThis.structuredClone(appendRequest("other", later));
  db.state.now = later;
  for (const scoped of [
    changed.binding,
    changed.reference.binding,
    changed.candidate.evidence.binding,
    changed.candidate.evidence.sourceReferences[0].binding,
  ])
    scoped.externalStoreId = "other-store";
  assert.equal(changed.candidate.fingerprint, original.fingerprint);
  assert.equal((await db.repository.appendEvidence(changed)).error.code, "CONFLICT");
  assert.equal(db.state.events.length, 1);
  assert.deepEqual((await db.repository.detail(detailRequest(original))).value, original);
  assert.equal(
    (await db.repository.detail({ ...detailRequest(original), binding: changed.binding })).error
      .code,
    "NOT_FOUND",
  );
});

test("metric references require the exact stored scoped version/hash and append normalized links", async () => {
  const db = database();
  const request = globalThis.structuredClone(appendRequest());
  Object.assign(request.candidate.evidence.sourceReferences[0], {
    kind: "METRIC_SNAPSHOT",
    id: "00000000-0000-4000-8000-000000000001",
    measure: { kind: "PAID_REVENUE", unit: "minorCNY" },
  });
  assert.equal((await db.repository.appendEvidence(request)).error.code, "VERSION_MISMATCH");
  assert.equal(db.state.events.length, 0);
});

test("SQL keeps hostile external IDs in bound parameters and sets all transaction-local RLS keys", async () => {
  const db = database();
  const request = globalThis.structuredClone(appendRequest());
  request.reference.id = "evidence'; DROP TABLE events;--";
  await seed(db, request);
  const insert = db.state.calls.find(({ sql }) =>
    sql.includes("INSERT INTO public.event_evidence ("),
  );
  assert.ok(insert.params.includes(request.reference.id));
  assert.equal(insert.sql.includes(request.reference.id), false);
  const context = db.state.calls.find(({ sql }) => sql.includes("set_config"));
  assert.deepEqual(context.params, [actor.userId, ...Object.values(binding), actor.merchantId]);
  assert.ok(
    db.state.calls.some(
      ({ sql, params }) =>
        sql.includes("pg_advisory_xact_lock") && params[0] === request.candidate.fingerprint,
    ),
  );
});

test("changed source hash cannot be hidden by adding another new source", async () => {
  const db = database();
  await seed(db);
  const changed = globalThis.structuredClone(appendRequest("new", later));
  db.state.now = later;
  const forged = sourceReference("z-old");
  forged.hash = "changed-immutable-source";
  changed.candidate.evidence.sourceReferences.push(forged);
  const result = await db.repository.appendEvidence(changed);
  assert.equal(result.ok, false, "An existing source version must retain its immutable hash");
  assert.equal(result.error.code, "VERSION_MISMATCH");
  assert.equal(db.state.evidence.length, 1);
});

test("immutable observation time remains hash bound while trusted host clock advances lastSeen", async () => {
  const db = database();
  const original = await seed(db);
  db.state.now = later;
  const changed = await db.repository.appendEvidence(appendRequest("z-old", later));
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "CONFLICT");
  db.state.now = later;
  const repeated = await seed(db);
  assert.equal(Date.parse(repeated.lastSeenAt), Date.parse(later));
  assert.deepEqual(repeated.currentEvidence, original.currentEvidence);
});

test("malformed stored reference scalar is rejected without coercion", async () => {
  const db = database();
  const event = await seed(db);
  db.state.events[0].currentEvidenceHash = 123;
  const result = await db.repository.detail(detailRequest(event));
  assert.equal(result.ok, false, "Persisted scalar types must retain their public contract");
  assert.equal(result.error.code, "SOURCE_UNAVAILABLE");
});

test("strict parser rejects uncloneable unknown fields with a typed result", async () => {
  const db = database();
  await assert.doesNotReject(async () => {
    const result = await db.repository.current({ ...currentRequest(), extra: () => undefined });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_INPUT");
  });
});

test("unavailable transaction fails closed before attempting membership or mutations", async () => {
  const db = database();
  db.state.fail = "SAVEPOINT";
  await assert.doesNotReject(async () => {
    const result = await db.repository.appendEvidence(appendRequest());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SOURCE_UNAVAILABLE");
  });
  assert.equal(db.state.calls.length, 1);
});

test("host clock is required, validated and monotonic without altering immutable evidence time", async () => {
  const db = database();
  assert.throws(() => createEventRepository({ actor, client: db.client }), TypeError);
  db.state.now = later;
  const first = await seed(db);
  assert.equal(Date.parse(first.firstSeenAt), Date.parse(later));
  db.state.now = end;
  const repeated = await seed(db);
  assert.equal(Date.parse(repeated.lastSeenAt), Date.parse(later));
  db.state.now = "2026-10-01T00:00:00Z";
  assert.equal((await db.repository.appendEvidence(appendRequest())).error.code, "INVALID_INPUT");
  db.state.now = "invalid";
  assert.equal(
    (await db.repository.appendEvidence(appendRequest())).error.code,
    "SOURCE_UNAVAILABLE",
  );
});
