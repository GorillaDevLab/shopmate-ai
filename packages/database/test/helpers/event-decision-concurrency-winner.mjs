import { randomUUID } from "node:crypto";
import { EvaluationContextSchema, PrimaryDecisionRunSchema } from "@shopmate/contracts";
import { createDecisionRunRepository } from "../../dist/src/index.js";
import { actor, appendRequest, unwrap } from "./event-decision-concurrency-fixture.mjs";

const clock = { timeDomain: "SECURITY_UTC", now: () => new Date().toISOString() };
export function evaluationContext(event) {
  const request = appendRequest();
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor,
    event,
    evidence: { reference: event.currentEvidence, evidence: request.candidate.evidence },
    requestId: randomUUID(),
    correlationId: randomUUID(),
  });
}
const labels = {
  severity: "HIGH",
  notificationRoute: "NOTIFY_NOW",
  llmEscalation: "DEEP_REASONING_REQUIRED",
  evidenceSufficiency: "SUFFICIENT",
  attentionPriority: "HIGH_PRIORITY",
  reasonCodes: ["SYNC_FAILURE"],
};
function evaluated(context) {
  return {
    schemaVersion: 1,
    status: "EVALUATED",
    correlationId: context.correlationId,
    rulesetVersion: "decision-rules-v1",
    labels,
    confidenceMetadata: null,
  };
}
function runFor(context) {
  return PrimaryDecisionRunSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    eventId: context.event.id,
    decisionKey: "test-only-concurrent-key",
    requestId: context.requestId,
    evidence: context.evidence.reference,
    provider: { key: "rules", version: "test-v1", supportedInputVersions: [1] },
    rulesetVersion: "decision-rules-v1",
    fallbackOf: null,
    mode: "PRIMARY",
    result: evaluated(context),
    effective: labels,
    overrideReason: null,
    latencyMs: 0,
    createdAt: clock.now(),
  });
}
export async function decide(client, context, route) {
  const repository = createDecisionRunRepository({
    actor,
    client,
    clock,
    decisionKey: () => "test-only-concurrent-key",
  });
  const request = {
    context,
    decisionKey: "test-only-concurrent-key",
    control: {
      timeDomain: "SECURITY_UTC",
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      signal: new globalThis.AbortController().signal,
    },
  };
  const claim = unwrap(await repository.claim(request));
  if (claim.status === "COMMITTED") return claim.run;
  return unwrap(
    await repository.commit(
      { ...request, commitToken: claim.commitToken, runs: [runFor(context)] },
      route,
    ),
  );
}
