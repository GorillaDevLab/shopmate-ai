import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createNotificationIntentKey,
  NotificationIntentSchema,
  TenantAuditEventSchema,
  RoutedPrimaryDecisionRunSchema,
  type EvaluationContext,
  type PrimaryDecisionRun,
  type SecurityClock,
} from "@shopmate/contracts";
import { AuditAppendRepository } from "../audit/audit-append.repository.js";
import { NotificationEnqueueRepository } from "../notifications/notification-enqueue.repository.js";
import { runtimeDecisionKey } from "../decisions/decision-runtime-policy.js";
import { runtimeAgentAudit } from "../decisions/decision-runtime-history.js";
import type { EventRuntimeTransaction } from "./event-decision-transaction.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";
import { runtimeBindingKeys } from "./event-runtime-authority.js";

export async function priorRuntimeWinner(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
): Promise<string | null> {
  const query = runtimeBindingKeys.map((key, i) => `"${key}"=$${i + 1}`).join(" AND ");
  const result = await scope.client.query(
    `SELECT "winnerRunId" FROM public.decision_claims WHERE ${query}
    AND "eventId"=$6 AND "evidenceId"=$7 AND "decisionKey"=$8`,
    [
      ...runtimeBindingKeys.map((key) => context.event.binding[key]),
      context.event.id,
      context.evidence.reference.id,
      runtimeDecisionKey(context),
    ],
  );
  if (result.rows.length > 1) throw runtimeUnavailable();
  const id = result.rows[0]?.winnerRunId;
  if (id !== null && id !== undefined && typeof id !== "string") throw runtimeUnavailable();
  return id ?? null;
}
function intentFor(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
) {
  if (run.effective === null || run.effective.notificationRoute === "IGNORE") return null;
  const identity = {
    recipient: {
      binding: context.event.binding,
      userId: scope.authority.recipientId ?? context.actor.userId,
    },
    eventId: context.event.id,
    eventState: context.event.state,
    eventRevision: context.event.revision,
    channel: "IN_APP" as const,
  };
  const createdAt = run.createdAt;
  const notBefore =
    run.effective.notificationRoute === "DAILY_BRIEF"
      ? new Date((Math.floor(Date.parse(createdAt) / 86400000) + 1) * 86400000).toISOString()
      : createdAt;
  return NotificationIntentSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    ...identity,
    evidence: run.evidence,
    decisionRunId: run.id,
    route: run.effective.notificationRoute,
    createdAt,
    notBefore,
    dedupKey: createNotificationIntentKey(identity),
    summary: { eventType: context.event.eventType, severity: run.effective.severity },
  });
}
async function verifyReplay(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
): Promise<void> {
  await verifyAgent(scope, run);
  const result = await replayIntents(scope, context, run);
  const expected = run.effective?.notificationRoute !== "IGNORE" ? 1 : 0;
  if (result.rows.length !== expected) throw runtimeUnavailable();
  const row = result.rows[0];
  if (
    row &&
    (row.audits !== 1 ||
      row.recipientUserId !== scope.authority.recipientId ||
      row.route !== run.effective?.notificationRoute ||
      !isDeepStrictEqual(
        [row.evidenceId, row.evidenceVersion, row.evidenceHash],
        [run.evidence.id, run.evidence.version, run.evidence.hash],
      ))
  )
    throw runtimeUnavailable();
}
async function verifyAgent(scope: EventRuntimeTransaction, run: PrimaryDecisionRun): Promise<void> {
  const audit = await runtimeAgentAudit(scope, run.id);
  if (
    !audit ||
    audit.links.evidenceId !== run.evidence.id ||
    audit.resource?.id !== run.id ||
    audit.resource.type !== "RUN" ||
    audit.event.eventType !== "AGENT_RUN" ||
    audit.event.redactedMetadata.runStatus !== "COMPLETED"
  )
    throw runtimeUnavailable();
}
function replayIntents(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
) {
  return scope.client.query(
    `SELECT o."rowId",o."evidenceId",o."evidenceVersion",o."evidenceHash",o."recipientUserId",o.route,
    (SELECT count(*)::int FROM public.audit_logs a WHERE a."organizationId"=$1 AND a."workspaceId"=$2 AND a."storeId"=$3
      AND a.payload->'event'->>'eventType'='NOTIFICATION_INTENT' AND a.payload->'resource'->>'id'=o."rowId"::text) AS audits
    FROM public.notification_outbox o WHERE o."organizationId"=$1 AND o."workspaceId"=$2 AND o."storeId"=$3 AND o."decisionRunId"=$4`,
    [
      context.event.binding.organizationId,
      context.event.binding.workspaceId,
      context.event.binding.storeId,
      run.id,
    ],
  );
}
async function appendAgent(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
  clock: SecurityClock,
): Promise<void> {
  const event = TenantAuditEventSchema.parse({
    scopeKind: "TENANT",
    scope: scope.handle.scope,
    actor: scope.handle.actor,
    resource: { type: "RUN", id: run.id },
    result: "SUCCESS",
    occurredAt: clock.now(),
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
  await new AuditAppendRepository().appendTenant(scope.handle, event);
}
export async function applyRuntimeEffects(
  scope: EventRuntimeTransaction,
  context: EvaluationContext,
  run: PrimaryDecisionRun,
  priorWinner: string | null,
  clock: SecurityClock,
): Promise<void> {
  if (run.result.status !== "EVALUATED" || run.effective === null) return;
  await scope.reauthorize();
  const persisted = await priorRuntimeWinner(scope, context);
  if (persisted !== run.id || (priorWinner !== null && priorWinner !== run.id))
    throw runtimeUnavailable();
  const original = {
    ...context,
    requestId: run.requestId,
    correlationId: run.result.correlationId,
  };
  if (priorWinner !== null) await verifyReplay(scope, original, run);
  else {
    if (await runtimeAgentAudit(scope, run.id)) throw runtimeUnavailable();
    await appendAgent(scope, original, run, clock);
  }
  const intent = intentFor(scope, original, run);
  if (intent === null) return;
  await enqueue(scope, original, run, intent, priorWinner !== null, clock);
}
async function enqueue(
  scope: EventRuntimeTransaction,
  original: EvaluationContext,
  run: PrimaryDecisionRun,
  intent: ReturnType<typeof NotificationIntentSchema.parse>,
  replay: boolean,
  clock: SecurityClock,
): Promise<void> {
  const result = await new NotificationEnqueueRepository({
    decisionKey: runtimeDecisionKey,
  }).enqueue(
    scope.handle,
    {
      intent,
      decision: {
        context: original,
        run: RoutedPrimaryDecisionRunSchema.parse(run),
        control: scope.authority.control,
      },
    },
    clock,
  );
  if (!result.ok || result.value.outcome !== (replay ? "DEDUPLICATED" : "ENQUEUED"))
    throw runtimeUnavailable();
}
