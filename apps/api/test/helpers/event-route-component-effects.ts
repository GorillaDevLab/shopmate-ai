import { randomUUID } from "node:crypto";
import {
  createNotificationIntentKey,
  NotificationIntentSchema,
  RoutedPrimaryDecisionRunSchema,
  TenantAuditEventSchema,
  type EvaluationContext,
  type PrimaryDecisionRun,
} from "@shopmate/contracts";
import { AuditAppendRepository } from "../../src/audit/audit-append.repository.js";
import { NotificationEnqueueRepository } from "../../src/notifications/notification-enqueue.repository.js";
import { EVENT_SECURITY_CLOCK } from "../../src/events/event-decision-unit-of-work.js";
import type { EventRuntimeTransaction } from "../../src/events/event-decision-transaction.js";

function agentAudit(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
) {
  return TenantAuditEventSchema.parse({
    scopeKind: "TENANT",
    scope: scope.handle.scope,
    actor: scope.handle.actor,
    resource: { type: "RUN", id: run.id },
    result: "SUCCESS",
    occurredAt: EVENT_SECURITY_CLOCK.now(),
    sourceOccurredAt: null,
    links: {
      requestId: scope.handle.auditRequestId,
      occurrenceId: `run:${run.id}`,
      runId: run.id,
      evidenceId: context.evidence.reference.id,
      actionId: null,
      revisionId: null,
      approvalId: null,
      executionId: null,
    },
    event: { eventType: "AGENT_RUN", redactedMetadata: { runStatus: "COMPLETED" } },
  });
}
function intentFor(context: EvaluationContext, run: PrimaryDecisionRun) {
  const identity = {
    recipient: { binding: context.event.binding, userId: "event-runtime-recipient" },
    eventId: context.event.id,
    eventState: context.event.state,
    eventRevision: context.event.revision,
    channel: "IN_APP" as const,
  };
  return NotificationIntentSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    ...identity,
    evidence: run.evidence,
    decisionRunId: run.id,
    route: run.effective?.notificationRoute,
    createdAt: run.createdAt,
    notBefore: run.createdAt,
    dedupKey: createNotificationIntentKey(identity),
    summary: { eventType: context.event.eventType, severity: run.effective?.severity },
  });
}
export async function customEffects(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
  decisionKey: (context: EvaluationContext) => string,
  replay: boolean,
) {
  if (replay) return;
  await new AuditAppendRepository().appendTenant(scope.handle, agentAudit(scope, context, run));
  const result = await new NotificationEnqueueRepository({ decisionKey }).enqueue(
    scope.handle,
    {
      intent: intentFor(context, run),
      decision: {
        context,
        run: RoutedPrimaryDecisionRunSchema.parse(run),
        control: scope.authority.control,
      },
    },
    EVENT_SECURITY_CLOCK,
  );
  if (!result.ok) throw new Error(`Typed enqueue failure: ${result.code}`);
}
