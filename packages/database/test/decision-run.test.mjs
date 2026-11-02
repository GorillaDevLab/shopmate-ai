import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventFingerprint, EvaluationContextSchema } from "@shopmate/contracts";
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
    saved: null,
    ...patch,
  };
  const client = {
    async query(sql, parameters = []) {
      state.calls.push({ sql, parameters });
      if (state.fail && sql.includes(state.fail))
        throw Object.assign(new Error("private"), { code: "08006" });
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
    s.saved = globalThis.structuredClone({
      lease: s.lease,
      runs: s.runs,
      projections: s.projections,
    });
  if (sql.startsWith("ROLLBACK TO")) Object.assign(s, s.saved);
  if (sql.includes("event_scope_access")) return [{ allowed: s.allowed }];
  if (sql.includes("decision:event"))
    return [
      {
        ...binding,
        id: "event-a",
        revision: s.revision,
        fingerprint: context().event.fingerprint,
        currentEvidenceId: "evidence-a",
        currentEvidenceVersion: "Evidence-V1",
        currentEvidenceHash: "Hash-A",
      },
    ];
  if (sql.includes("decision:lease")) return s.lease ? [s.lease] : [];
  if (sql.includes("public.decision_claim(")) {
    s.lease ??= lease({ claimToken: p[5], expiresAt: p[6] });
    return [s.lease];
  }
  if (sql.includes("decision:runs")) return s.runs.filter((r) => p[6] === null || r.id === p[6]);
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
