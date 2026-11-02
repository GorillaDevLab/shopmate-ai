import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEventFingerprint,
  EvaluationContextSchema,
  DecisionCorrelationIdSchema,
} from "@shopmate/contracts";
import { createDecisionRunRepository } from "../src/decision-run.repository.ts";

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
const now = "2026-10-02T00:00:00.000Z";
const deadlineAt = "2026-10-02T00:01:00.000Z";
const correlationId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const claimId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const period = {
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: now,
  timezone: "Asia/Shanghai",
  currency: "CNY",
};
function context() {
  const evidence = evidenceValue();
  const reference = {
    schemaVersion: 1,
    id: "evidence-a",
    version: "Evidence-V1",
    hash: "Hash-A",
    binding,
    eventType: evidence.eventType,
    entity: evidence.entity,
    definitionVersion: "Definition-V1",
    baselineVersion: null,
  };
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor,
    requestId: "request-a",
    correlationId,
    evidence: { reference, evidence },
    event: {
      schemaVersion: 1,
      id: "event-a",
      binding,
      eventType: evidence.eventType,
      entity: evidence.entity,
      fingerprint: createEventFingerprint(evidence),
      severityFloor: "HIGH",
      rulePolicyVersion: "Policy-V1",
      state: "OPEN",
      revision: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      currentEvidence: reference,
    },
  });
}
function evidenceValue() {
  return {
    schemaVersion: 1,
    binding,
    ...period,
    observedAt: now,
    sourceWatermark: now,
    dataStatus: "VERIFIED",
    sampleSize: 1,
    coverageBasisPoints: 10000,
    issues: [],
    eventType: "SYNC_FAILURE",
    entity: { kind: "CONNECTION", connectionId: binding.connectionId },
    definitionVersion: "Definition-V1",
    baselineVersion: null,
    baselineAlignment: "MISSING",
    baseline: null,
    sourceReferences: [
      {
        kind: "NORMALIZED_AGGREGATE",
        id: "source-a",
        version: "Source-V1",
        hash: "Source-Hash",
        binding,
        definitionVersion: "Definition-V1",
        period,
        observedAt: now,
        measure: null,
      },
    ],
    facts: {
      lastSuccessAt: null,
      lagSeconds: null,
      typedErrorCode: "TIMEOUT",
      affectedResourceKind: "ORDERS",
    },
  };
}
function request(patch = {}) {
  return {
    context: context(),
    decisionKey: "stable-Key",
    control: {
      timeDomain: "SECURITY_UTC",
      deadlineAt,
      signal: new globalThis.AbortController().signal,
    },
    ...patch,
  };
}
function lease(patch = {}) {
  const c = context();
  return {
    id: claimId,
    ...binding,
    eventId: c.event.id,
    eventRevision: "1",
    fingerprint: c.event.fingerprint,
    evidenceId: c.evidence.reference.id,
    evidenceVersion: c.evidence.reference.version,
    evidenceHash: c.evidence.reference.hash,
    decisionKey: "stable-Key",
    claimToken: "persisted-token",
    createdAt: "2026-10-01T23:59:00.000Z",
    expiresAt: deadlineAt,
    winnerRunId: null,
    winnerMode: "PRIMARY",
    winnerStatus: "EVALUATED",
    ...patch,
  };
}
function fixture(patch = {}) {
  const state = {
    calls: [],
    lease: null,
    runs: [],
    projections: [],
    allowed: true,
    revision: "1",
    clock: now,
    fail: null,
    after: null,
    saved: [],
    ...patch,
  };
  const client = {
    async query(sql, parameters = []) {
      state.calls.push({ sql, parameters });
      if (state.fail && sql.includes(state.fail)) {
        if (state.failOnce) state.fail = null;
        throw Object.assign(new Error("private"), { code: "08006" });
      }
      const rows = respond(state, sql, parameters);
      if (state.after) await state.after(sql);
      return { rows };
    },
  };
  const repository = createDecisionRunRepository({
    actor,
    client,
    clock: { timeDomain: "SECURITY_UTC", now: () => state.clock },
    decisionKey: () => "stable-Key",
  });
  return { state, repository };
}
function respond(s, sql, p) {
  if (sql.startsWith("SAVEPOINT"))
    s.saved.push(
      globalThis.structuredClone({
        lease: s.lease,
        runs: s.runs,
        projections: s.projections,
      }),
    );
  if (sql.startsWith("ROLLBACK TO")) Object.assign(s, s.saved.at(-1));
  if (sql.startsWith("RELEASE SAVEPOINT")) s.saved.pop();
  if (sql.includes("event_scope_access")) return [{ allowed: s.allowed }];
  if (sql.includes("decision:event")) return [currentRow(s)];
  if (sql.includes("decision:lease")) return s.lease ? [s.lease] : [];
  if (sql.includes("public.decision_claim(")) {
    s.lease ??= lease({ claimToken: p[5], expiresAt: p[6] });
    return [s.lease];
  }
  if (sql.includes("decision:runs")) return selectedRuns(s, p);
  if (sql.includes("public.decision_commit(")) {
    const won = s.won !== false;
    if (won) s.lease.winnerRunId = p[2];
    return [{ won }];
  }
  return writeRows(s, sql, p);
}

test("claim validates exact port shape and trusted stable key before SQL", async () => {
  const { state, repository } = fixture();
  assert.deepEqual(await repository.claim(request({ decisionKey: "client-chosen" })), {
    ok: false,
    code: "INVALID_INPUT",
  });
  assert.deepEqual(await repository.claim({ ...request(), extra: true }), {
    ok: false,
    code: "INVALID_INPUT",
  });
  assert.equal(state.calls.length, 0);
});
test("claim uses current scope, parameterized SQL and the host transaction", async () => {
  const { state, repository } = fixture();
  const result = await repository.claim(request());
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "CLAIMED");
  assert.equal(result.value.commitToken, state.lease.claimToken);
  const call = state.calls.find((c) => c.sql.includes("public.decision_claim("));
  assert.deepEqual(call.parameters.slice(0, 5), [
    "event-a",
    "evidence-a",
    "Evidence-V1",
    "Hash-A",
    "stable-Key",
  ]);
  assert.equal(call.parameters[6], deadlineAt);
  assert.equal(
    state.calls.some((c) => /^(BEGIN|COMMIT|ROLLBACK$)/u.test(c.sql)),
    false,
  );
});
test("existing uncommitted and expired leases cannot be taken over", async () => {
  for (const expiresAt of [deadlineAt, now]) {
    const { repository, state } = fixture({ lease: lease({ expiresAt }) });
    assert.deepEqual(await repository.claim(request()), { ok: false, code: "CONFLICT" });
    assert.equal(state.lease.claimToken, "persisted-token");
    assert.equal(
      state.calls.some((c) => c.sql.startsWith("ROLLBACK TO")),
      true,
    );
  }
});
test("revoked membership and stale revision fail closed", async () => {
  const denied = fixture({ allowed: false });
  assert.deepEqual(await denied.repository.claim(request()), { ok: false, code: "FORBIDDEN" });
  const stale = fixture({ revision: "2" });
  assert.deepEqual(await stale.repository.claim(request()), {
    ok: false,
    code: "VERSION_MISMATCH",
  });
});

const labels = {
  severity: "HIGH",
  notificationRoute: "DAILY_BRIEF",
  llmEscalation: "NO_LLM_NEEDED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "HIGH_PRIORITY",
  reasonCodes: ["SYNC_FAILURE"],
};
function runValue(patch = {}) {
  return {
    schemaVersion: 1,
    id: "run-a",
    eventId: "event-a",
    decisionKey: "stable-Key",
    requestId: "request-a",
    evidence: context().evidence.reference,
    provider: { key: "rules", version: "Provider-V1", supportedInputVersions: [1] },
    rulesetVersion: "Rules-V1",
    fallbackOf: null,
    result: {
      schemaVersion: 1,
      correlationId,
      status: "EVALUATED",
      rulesetVersion: "Rules-V1",
      labels,
      confidenceMetadata: null,
    },
    latencyMs: 4,
    createdAt: now,
    mode: "PRIMARY",
    effective: labels,
    overrideReason: null,
    ...patch,
  };
}
function stored(run = runValue(), claim = lease()) {
  return {
    id: run.id,
    ...binding,
    claimId,
    claimToken: claim.claimToken,
    eventId: run.eventId,
    fingerprint: context().event.fingerprint,
    evidenceId: run.evidence.id,
    evidenceVersion: run.evidence.version,
    evidenceHash: run.evidence.hash,
    decisionKey: run.decisionKey,
    schemaVersion: 1,
    requestId: run.requestId,
    correlationId: run.result.correlationId.toLowerCase(),
    providerKey: run.provider.key,
    providerVersion: run.provider.version,
    supportedInputVersions: [1],
    rulesetVersion: run.rulesetVersion,
    mode: run.mode,
    fallbackOf: run.fallbackOf,
    fallbackMode: run.fallbackOf === null ? null : "PRIMARY",
    fallbackStatus: run.fallbackOf === null ? null : "UNAVAILABLE",
    resultStatus: run.result.status,
    result: run.result,
    effective: run.effective,
    overrideReason: run.overrideReason,
    latencyMs: String(run.latencyMs),
    createdAt: new Date(run.createdAt),
    evidencePayload: context().evidence.evidence,
    lease: claim,
  };
}
function readQuery(patch = {}) {
  return { actor, binding, eventId: "event-a", decisionId: null, ...patch };
}

test("committed retries reuse the original expired winner and its correlation metadata", async () => {
  const original = runValue();
  const claim = lease({ expiresAt: now, winnerRunId: original.id });
  const { repository } = fixture({ lease: claim, runs: [stored(original, claim)] });
  const retry = request();
  retry.context = {
    ...retry.context,
    requestId: "retry-request",
    correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  assert.deepEqual(await repository.claim(retry), {
    ok: true,
    value: { status: "COMMITTED", run: original },
  });
});
test("append preserves uppercase UUID JSON, opaque versions and SQL NULL projections", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const run = runValue({ mode: "SHADOW", effective: null });
  assert.deepEqual(await repository.append(context(), run), { ok: true, value: run });
  assert.equal(state.runs.length, 1);
  assert.equal(state.projections.length, 6);
  assert.equal(
    state.projections.every((p) => p.effective === null),
    true,
  );
  assert.equal(state.runs[0].result.confidenceMetadata, null);
  assert.equal(state.runs[0].result.correlationId, correlationId);
});
test("append rejects scope, hash, revision, fallback and effective SHADOW violations", async () => {
  const { repository, state } = fixture({ lease: lease() });
  assert.deepEqual(
    await repository.append(
      context(),
      runValue({ evidence: { ...context().evidence.reference, hash: "wrong" } }),
    ),
    { ok: false, code: "HASH_MISMATCH" },
  );
  assert.deepEqual(await repository.append(context(), runValue({ mode: "SHADOW" })), {
    ok: false,
    code: "INVALID_INPUT",
  });
  assert.deepEqual(await repository.append(context(), runValue({ fallbackOf: "missing" })), {
    ok: false,
    code: "VERSION_MISMATCH",
  });
  assert.equal(state.runs.length, 0);
});
test("history reauthorizes live scope and rejects corrupted stored result envelopes", async () => {
  const { repository, state } = fixture({ lease: lease(), runs: [stored()] });
  assert.deepEqual(await repository.read(readQuery()), { ok: true, value: [runValue()] });
  state.runs[0].result = { ...runValue().result, confidenceMetadata: 0.9 };
  assert.deepEqual(await repository.read(readQuery()), { ok: false, code: "UNAVAILABLE" });
  state.allowed = false;
  assert.deepEqual(await repository.read(readQuery()), { ok: false, code: "FORBIDDEN" });
});
function inserted(sql, parameters) {
  const columns = /\(([^)]+)\)\s*VALUES/u
    .exec(sql)[1]
    .split(",")
    .map((s) => s.trim().replaceAll('"', ""));
  return Object.fromEntries(
    columns.map((key, i) => [
      key,
      ["result", "effective", "supportedInputVersions", "suggested"].includes(key) &&
      parameters[i] !== null
        ? JSON.parse(parameters[i])
        : parameters[i],
    ]),
  );
}
function writeRows(s, sql, p) {
  if (sql.includes("INSERT INTO public.decision_runs")) {
    const row = inserted(sql, p);
    const result = {
      ...row,
      correlationId: row.correlationId.toLowerCase(),
      latencyMs: String(row.latencyMs),
      createdAt: new Date(row.createdAt),
      evidencePayload: context().evidence.evidence,
      lease: s.lease,
    };
    s.runs.push(result);
    return [row];
  }
  if (sql.includes("INSERT INTO public.decision_records")) {
    const row = inserted(sql, p);
    s.projections.push(row);
    return [row];
  }
  return [];
}
function commitRequest(runs = [runValue()], patch = {}) {
  return { ...request(), commitToken: "persisted-token", runs, ...patch };
}
function unavailableRun(id = "failure-a", fallbackOf = null) {
  return runValue({
    id,
    fallbackOf,
    effective: null,
    result: { schemaVersion: 1, correlationId, status: "UNAVAILABLE", code: "TIMEOUT" },
  });
}
const routed = async (run) => ({ ok: true, value: run });

test("commit routes one evaluated terminal and commits only the database winner", async () => {
  const { repository, state } = fixture({ lease: lease() });
  let calls = 0;
  const result = await repository.commit(commitRequest(), async (run) => {
    calls++;
    return routed(run);
  });
  assert.deepEqual(result, { ok: true, value: runValue() });
  assert.equal(calls, 1);
  assert.equal(state.lease.winnerRunId, "run-a");
  assert.equal(state.runs.length, 1);
  assert.equal(state.projections.length, 6);
  const retry = await repository.commit(commitRequest(), async () => {
    calls++;
    return { ok: false, code: "UNAVAILABLE" };
  });
  assert.deepEqual(retry, result);
  assert.equal(calls, 1);
});
test("commit retains the immutable failure and linked Rules fallback", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const fallback = runValue({ fallbackOf: "failure-a" });
  assert.deepEqual(await repository.commit(commitRequest([unavailableRun(), fallback]), routed), {
    ok: true,
    value: fallback,
  });
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[0].resultStatus, "UNAVAILABLE");
  assert.equal(state.runs[1].fallbackOf, "failure-a");
  assert.equal(state.lease.winnerRunId, "run-a");
});
test("an all-unavailable chain remains history and never invokes routing or winner SQL", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const terminal = unavailableRun("failure-b", "failure-a");
  assert.deepEqual(
    await repository.commit(commitRequest([unavailableRun(), terminal]), () =>
      assert.fail("must not route"),
    ),
    { ok: true, value: terminal },
  );
  assert.equal(state.runs.length, 2);
  assert.equal(state.lease.winnerRunId, null);
  assert.equal(
    state.calls.some((c) => c.sql.includes("public.decision_commit(")),
    false,
  );
});
test("typed routing failure rolls back prior failure history and every projection", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const result = await repository.commit(
    commitRequest([unavailableRun(), runValue({ fallbackOf: "failure-a" })]),
    async () => ({ ok: false, code: "UNAVAILABLE" }),
  );
  assert.deepEqual(result, { ok: false, code: "UNAVAILABLE" });
  assert.equal(state.runs.length, 0);
  assert.equal(state.projections.length, 0);
  assert.equal(state.lease.winnerRunId, null);
  assert.equal(
    state.calls.some((c) => c.sql.startsWith("ROLLBACK TO")),
    true,
  );
});
test("wrong token, expired control, aborted signal and SHADOW cannot route", async () => {
  for (const patch of [
    { commitToken: "wrong" },
    { runs: [runValue({ mode: "SHADOW", effective: null })] },
    { control: { ...request().control, deadlineAt: now } },
  ]) {
    const { repository, state } = fixture({ lease: lease() });
    assert.equal(
      (
        await repository.commit(commitRequest(undefined, patch), () =>
          assert.fail("must not route"),
        )
      ).ok,
      false,
    );
    assert.equal(state.runs.length, 0);
  }
  const controller = new globalThis.AbortController();
  controller.abort();
  const { repository } = fixture({ lease: lease() });
  assert.deepEqual(
    await repository.commit(
      commitRequest(undefined, { control: { ...request().control, signal: controller.signal } }),
      routed,
    ),
    { ok: false, code: "CONFLICT" },
  );
});
test("aborting during route or losing the native commit rolls the complete operation back", async () => {
  for (const abort of [true, false]) {
    const controller = new globalThis.AbortController();
    const { repository, state } = fixture({ lease: lease(), won: !abort });
    const result = await repository.commit(
      commitRequest(undefined, { control: { ...request().control, signal: controller.signal } }),
      async (run) => {
        if (abort) controller.abort();
        else state.won = false;
        return routed(run);
      },
    );
    assert.deepEqual(result, { ok: false, code: "CONFLICT" });
    assert.equal(state.runs.length, 0);
    assert.equal(state.lease.winnerRunId, null);
  }
});
test("routing can await a read on the same repository without deadlocking its transaction", async () => {
  const { repository } = fixture({ lease: lease() });
  const result = await Promise.race([
    repository.commit(commitRequest(), async (run) => {
      assert.deepEqual(await repository.read(readQuery()), { ok: true, value: [] });
      return routed(run);
    }),
    new Promise((resolve) =>
      globalThis.setTimeout(() => resolve({ ok: false, code: "DEADLOCK" }), 150),
    ),
  ]);
  assert.equal(result.ok, true);
});
test("append accepts equivalent timestamp spellings and preserves idempotent immutable identity", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const input = runValue({ createdAt: "2026-10-02T00:00:00Z" });
  assert.deepEqual(await repository.append(context(), input), { ok: true, value: runValue() });
  assert.deepEqual(await repository.append(context(), input), { ok: true, value: runValue() });
  assert.equal(state.runs.length, 1);
  assert.deepEqual(await repository.append(context(), { ...input, latencyMs: 5 }), {
    ok: false,
    code: "CONFLICT",
  });
});
test("commit drains a read started by routing before performing winner writes", async () => {
  const { repository, state } = fixture({ lease: lease() });
  let finished = false;
  let started;
  state.after = async (sql) => {
    if (sql.includes("decision:runs") && !finished) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 15));
      finished = true;
    }
  };
  const result = await repository.commit(commitRequest(), async (run) => {
    started = repository.read(readQuery());
    return routed(run);
  });
  assert.equal(result.ok, true);
  assert.equal((await started).ok, true);
  assert.equal(finished, true);
  assert.equal(state.saved.length, 0);
  const inserts = state.calls.findIndex((c) => c.sql.includes("INSERT INTO public.decision_runs"));
  const release = state.calls.findIndex((c) => c.sql.startsWith("RELEASE SAVEPOINT"));
  assert.equal(release < inserts, true);
});
test("a closed inherited routing context cannot start more repository work", async () => {
  const { repository, state } = fixture({ lease: lease() });
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  let stale;
  assert.equal(
    (
      await repository.commit(commitRequest(), async (run) => {
        stale = gate.then(() => repository.read(readQuery()));
        return routed(run);
      })
    ).ok,
    true,
  );
  const count = state.calls.length;
  resume();
  assert.deepEqual(await stale, { ok: false, code: "CONFLICT" });
  assert.equal(state.calls.length, count);
});
test("routing cannot enqueue nested writes or scope switches", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const result = await repository.commit(commitRequest(), async (run) => {
    assert.deepEqual(await repository.append(context(), run), { ok: false, code: "CONFLICT" });
    assert.deepEqual(
      await repository.read(readQuery({ binding: { ...binding, storeId: "store-b" } })),
      { ok: false, code: "CONFLICT" },
    );
    return routed(run);
  });
  assert.equal(result.ok, true);
  assert.equal(state.runs.length, 1);
});
test("detached routing work cannot start a read while the outer operation is finalizing", async () => {
  const { repository, state } = fixture({ lease: lease() });
  let resume;
  let delayed;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  state.after = async (sql) => {
    if (sql.includes("INSERT INTO public.decision_runs")) {
      resume();
      await delayed;
    }
  };
  const result = await repository.commit(commitRequest(), async (run) => {
    delayed = gate.then(() => repository.read(readQuery()));
    return routed(run);
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await delayed, { ok: false, code: "CONFLICT" });
});
test("history decodes PostgreSQL JSON claim timestamps with explicit UTC offsets", async () => {
  const claim = lease({
    createdAt: "2026-10-01T23:59:00+00:00",
    expiresAt: "2026-10-02T00:01:00+00:00",
  });
  const { repository } = fixture({ runs: [stored(runValue(), claim)] });
  assert.deepEqual(await repository.read(readQuery()), { ok: true, value: [runValue()] });
});
test("claim rejects fabricated facts even when the caller repeats the stored evidence hash", async () => {
  const { repository, state } = fixture();
  const input = request();
  input.context = globalThis.structuredClone(input.context);
  input.context.evidence.evidence.facts.typedErrorCode = "RATE_LIMIT";
  assert.deepEqual(await repository.claim(input), { ok: false, code: "HASH_MISMATCH" });
  assert.equal(state.lease, null);
});
function historyQuery(patch = {}) {
  return { actor, binding, eventId: "event-a", limit: 1, cursor: null, ...patch };
}
test("history uses a stable scoped keyset cursor across equal timestamps", async () => {
  const a = runValue({ id: "run-a" });
  const b = runValue({ id: "run-b" });
  const { repository, state } = fixture({ runs: [stored(a), stored(b)], revision: "2" });
  const first = await repository.history(historyQuery());
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.items, [b]);
  assert.equal(typeof first.value.nextCursor, "string");
  const second = await repository.history(historyQuery({ cursor: first.value.nextCursor }));
  assert.deepEqual(second, { ok: true, value: { items: [a], nextCursor: null } });
  const call = state.calls.find((c) => c.sql.includes("decision:runs"));
  assert.match(call.sql, /ORDER BY r\."createdAt" DESC,r\.id COLLATE "C" DESC/u);
  assert.equal(call.parameters[7], 2);
  assert.equal(
    state.calls.some((c) => c.sql.includes("decision:event")),
    false,
  );
});
test("history rejects malformed or cross-scope cursors before SQL", async () => {
  const { repository, state } = fixture({ runs: [stored(), stored(runValue({ id: "run-b" }))] });
  const first = await repository.history(historyQuery());
  const count = state.calls.length;
  assert.deepEqual(await repository.history(historyQuery({ cursor: "invalid" })), {
    ok: false,
    code: "INVALID_INPUT",
  });
  assert.deepEqual(
    await repository.history(
      historyQuery({ cursor: first.value.nextCursor, binding: { ...binding, storeId: "other" } }),
    ),
    { ok: false, code: "INVALID_INPUT" },
  );
  assert.equal(state.calls.length, count);
});

function selectedRuns(s, p) {
  return s.runs
    .filter(
      (r) =>
        (p[6] === null || r.id === p[6]) &&
        (p[8] === null ||
          Date.parse(r.createdAt) < Date.parse(p[8]) ||
          (Date.parse(r.createdAt) === Date.parse(p[8]) &&
            Buffer.compare(Buffer.from(r.id), Buffer.from(p[9])) < 0)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
    )
    .slice(0, p[7]);
}
test("projection exceptions restore the operation and rollback failure escapes to the transaction owner", async () => {
  const broken = fixture({ lease: lease(), fail: "INSERT INTO public.decision_records" });
  assert.deepEqual(await broken.repository.append(context(), runValue()), {
    ok: false,
    code: "UNAVAILABLE",
  });
  assert.equal(broken.state.runs.length, 0);
  assert.equal(broken.state.projections.length, 0);
  const unrecoverable = fixture({ lease: lease(), fail: "ROLLBACK TO SAVEPOINT" });
  await assert.rejects(
    unrecoverable.repository.commit(commitRequest(), async () => ({
      ok: false,
      code: "UNAVAILABLE",
    })),
    /private/u,
  );
});
test("a recovered nested read failure stays typed and allows the outer commit to finish", async () => {
  const { repository, state } = fixture({ lease: lease() });
  const result = await repository.commit(
    commitRequest([unavailableRun(), runValue({ fallbackOf: "failure-a" })]),
    async (run) => {
      state.allowed = false;
      assert.deepEqual(await repository.read(readQuery()), { ok: false, code: "FORBIDDEN" });
      assert.equal(state.saved.length, 1);
      assert.deepEqual(
        state.runs.map((attempt) => attempt.id),
        ["failure-a"],
      );
      state.allowed = true;
      return routed(run);
    },
  );
  assert.deepEqual(result, { ok: true, value: runValue({ fallbackOf: "failure-a" }) });
  assert.equal(state.runs.length, 2);
  assert.equal(state.lease.winnerRunId, "run-a");
  assert.equal(state.saved.length, 0);
});
test("caught nested rollback failure rejects commit without recovering the surviving inner savepoint", async () => {
  const { repository, state } = fixture({ lease: lease(), failOnce: true });
  let nestedError;
  const result = repository.commit(
    commitRequest([unavailableRun(), runValue({ fallbackOf: "failure-a" })]),
    async (run) => {
      state.allowed = false;
      state.fail = "ROLLBACK TO SAVEPOINT";
      try {
        await repository.read(readQuery());
      } catch (error) {
        nestedError = error;
      }
      return routed(run);
    },
  );
  await assert.rejects(result, (error) => error === nestedError && error.message === "private");
  assert.equal(state.fail, null);
  assert.deepEqual(
    state.runs.map((run) => run.id),
    ["failure-a"],
  );
  assert.equal(state.saved.length, 2);
  assert.deepEqual(
    state.calls.filter((call) => /^(ROLLBACK TO|RELEASE SAVEPOINT)/u.test(call.sql)),
    [{ sql: "ROLLBACK TO SAVEPOINT decision_repository_operation", parameters: [] }],
  );
  assert.equal(state.lease.winnerRunId, null);
});
test("live membership, real deadline and native signal are rechecked after asynchronous work", async () => {
  const revoked = fixture({ lease: lease() });
  assert.deepEqual(
    await revoked.repository.commit(commitRequest(), async (run) => {
      revoked.state.allowed = false;
      return routed(run);
    }),
    { ok: false, code: "FORBIDDEN" },
  );
  const expired = fixture({ lease: lease() });
  assert.deepEqual(
    await expired.repository.commit(commitRequest(), async (run) => {
      expired.state.clock = deadlineAt;
      return routed(run);
    }),
    { ok: false, code: "CONFLICT" },
  );
  const controller = new globalThis.AbortController();
  const aborted = fixture();
  aborted.state.after = async (sql) => {
    if (sql.includes("public.decision_claim(")) controller.abort();
  };
  assert.deepEqual(
    await aborted.repository.claim(
      request({ control: { ...request().control, signal: controller.signal } }),
    ),
    { ok: false, code: "CONFLICT" },
  );
  assert.equal(aborted.state.lease, null);
});
test("routing cannot change stored provider, result or request identity", async () => {
  const { repository, state } = fixture({ lease: lease() });
  assert.deepEqual(
    await repository.commit(commitRequest(), async (run) => ({
      ok: true,
      value: { ...run, requestId: "other-request" },
    })),
    { ok: false, code: "UNAVAILABLE" },
  );
  assert.equal(state.runs.length, 0);
  const effective = { ...labels, notificationRoute: "IGNORE" };
  const expected = runValue({ effective, overrideReason: "QUIET_HOURS" });
  assert.deepEqual(
    await repository.commit(commitRequest(), async (run) => ({
      ok: true,
      value: { ...run, effective, overrideReason: "QUIET_HOURS" },
    })),
    { ok: true, value: expected },
  );
});
test("commit retries reuse the expired winner with original request and correlation metadata", async () => {
  const original = runValue();
  const claim = lease({ expiresAt: now, winnerRunId: original.id });
  const { repository } = fixture({ lease: claim, runs: [stored(original, claim)] });
  const retryContext = {
    ...context(),
    requestId: "new-request",
    correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  const retryRun = runValue({
    requestId: retryContext.requestId,
    result: { ...original.result, correlationId: retryContext.correlationId },
  });
  assert.deepEqual(
    await repository.commit(commitRequest([retryRun], { context: retryContext }), () =>
      assert.fail("winner must not route twice"),
    ),
    { ok: true, value: original },
  );
});
test("maximum Unicode run IDs remain usable in bounded history cursors", async () => {
  const { repository } = fixture({ runs: [stored(runValue({ id: "决".repeat(256) })), stored()] });
  const first = await repository.history(historyQuery());
  assert.equal(first.ok, true);
  assert.equal(first.value.nextCursor.length <= 1024, true);
  assert.deepEqual(await repository.history(historyQuery({ cursor: first.value.nextCursor })), {
    ok: true,
    value: { items: [runValue()], nextCursor: null },
  });
});

test("stored correlation IDs retain the installed shared policy for ordinary, nil and max UUIDs", async () => {
  for (const id of [
    correlationId,
    "00000000-0000-0000-0000-000000000000",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
  ]) {
    const run = runValue({ result: { ...runValue().result, correlationId: id } });
    const { repository } = fixture({ runs: [stored(run)] });
    const expected = DecisionCorrelationIdSchema.safeParse(id).success
      ? { ok: true, value: [run] }
      : { ok: false, code: "UNAVAILABLE" };
    assert.deepEqual(await repository.read(readQuery()), expected);
  }
});
test("stored flattened identities, roles and typed results reject corrupted output", async () => {
  for (const patch of [
    { schemaVersion: 2 },
    { supportedInputVersions: [1, 2] },
    { resultStatus: "UNAVAILABLE" },
    { correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { fallbackStatus: "UNAVAILABLE" },
    { latencyMs: "1.5" },
    { claimToken: "wrong" },
    { evidenceHash: "Hash-B" },
    { result: { ...runValue().result, extraVendorPayload: {} } },
  ]) {
    const { repository } = fixture({ runs: [{ ...stored(), ...patch }] });
    assert.deepEqual(await repository.read(readQuery()), { ok: false, code: "UNAVAILABLE" });
  }
});
test("a business clock cannot construct the security authority", () => {
  assert.throws(
    () =>
      createDecisionRunRepository({
        actor,
        client: { query: async () => ({ rows: [] }) },
        clock: { timeDomain: "BUSINESS_UTC", now: () => now },
        decisionKey: () => "stable-Key",
      }),
    /security clock/u,
  );
});
test("claim binds the current event policy and state as well as evidence and revision", async () => {
  for (const patch of [
    { severityFloor: "LOW" },
    { rulePolicyVersion: "other-policy" },
    { state: "RESOLVED" },
  ]) {
    const { repository } = fixture();
    const input = request();
    input.context = { ...input.context, event: { ...input.context.event, ...patch } };
    assert.deepEqual(await repository.claim(input), { ok: false, code: "VERSION_MISMATCH" });
  }
});

function currentRow(state) {
  const event = context().event;
  return {
    ...event,
    ...binding,
    revision: state.revision,
    entityKind: "CONNECTION",
    entityId: binding.connectionId,
    currentEvidenceId: "evidence-a",
    currentEvidenceVersion: "Evidence-V1",
    currentEvidenceHash: "Hash-A",
    baselineVersion: null,
    evidencePayload: context().evidence.evidence,
  };
}
