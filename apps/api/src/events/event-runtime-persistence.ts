import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  EventEvidenceReferenceSchema,
  EvaluationContextSchema,
  type EventCandidate,
  type EvaluationContext,
  type EventRecord,
  type TenantContext,
} from "@shopmate/contracts";
import type { EventDecisionUnitOfWork } from "./event-decision-unit-of-work.js";
import type { EventRuntimeTransaction } from "./event-decision-transaction.js";
import { CanonicalHostEvidenceHash } from "../decisions/decision-input-sanitizer.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";

function candidateReference(candidate: EventCandidate) {
  const digest = new CanonicalHostEvidenceHash().hash(candidate.evidence);
  if (!digest.ok) throw runtimeUnavailable();
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        candidate.fingerprint,
        digest.value,
        candidate.rulePolicyVersion,
        candidate.evidence.observedAt,
        candidate.evidence.sourceReferences,
      ]),
    )
    .digest("hex");
  return EventEvidenceReferenceSchema.parse({
    schemaVersion: 1,
    id: `evidence:${identity}`,
    version: `observed:${identity}`,
    hash: digest.value,
    binding: candidate.evidence.binding,
    eventType: candidate.evidence.eventType,
    entity: candidate.evidence.entity,
    definitionVersion: candidate.evidence.definitionVersion,
    baselineVersion: candidate.evidence.baselineVersion,
  });
}
async function appendCandidate(
  uow: EventDecisionUnitOfWork,
  scope: EventRuntimeTransaction,
  candidate: EventCandidate,
): Promise<EventRecord> {
  await scope.reauthorize();
  const events = uow.events(scope);
  const actor: TenantContext = scope.authority.actor;
  const binding = scope.authority.binding;
  const identity = {
    binding,
    eventType: candidate.evidence.eventType,
    entity: candidate.evidence.entity,
    baselineVersion: candidate.evidence.baselineVersion,
  };
  const prior = await events.current({ actor, binding, identity });
  if (!prior.ok) throw runtimeUnavailable();
  const reference = candidateReference(candidate);
  const appended = await events.appendEvidence({
    actor,
    binding,
    candidate,
    reference,
    expectedRevision: prior.value?.revision ?? null,
  });
  if (!appended.ok) throw runtimeUnavailable();
  const event: EventRecord = appended.value;
  if (!isDeepStrictEqual(event.currentEvidence, reference)) throw runtimeUnavailable();
  return event;
}
export async function persistRuntimeCandidate(
  uow: EventDecisionUnitOfWork,
  scope: EventRuntimeTransaction,
  candidate: EventCandidate,
  requestId: string,
  correlationId: string,
): Promise<EvaluationContext> {
  const event = await appendCandidate(uow, scope, candidate);
  const actor = scope.authority.actor,
    binding = scope.authority.binding;
  const events = uow.events(scope);
  const evidence = await events.evidence({
    actor,
    binding,
    eventId: event.id,
    reference: event.currentEvidence,
  });
  if (!evidence.ok || !isDeepStrictEqual(evidence.value.evidence, candidate.evidence))
    throw runtimeUnavailable();
  return EvaluationContextSchema.parse({
    schemaVersion: 1,
    actor,
    event,
    evidence: evidence.value,
    requestId,
    correlationId,
  });
}
