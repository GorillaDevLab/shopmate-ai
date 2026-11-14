import { z } from "zod";
import {
  EventStateSchema,
  TenantAuditEventSchema,
  RoutedPrimaryDecisionRunSchema,
  ExternalIdSchema,
  type EventState,
  type TenantAuditEvent,
} from "@shopmate/contracts";
import type { DecisionReadPort } from "@shopmate/database";
import type { EventRuntimeTransaction } from "../events/event-decision-transaction.js";
import { runtimeBindingKeys } from "../events/event-runtime-authority.js";
import { runtimeUnavailable } from "../events/event-transaction-lifetime.js";
import type { DecisionRoutingSnapshot } from "./decision-routing.service.js";
import { runtimeRoutingEpoch } from "./decision-runtime-policy.js";

const integer = z.union([
  z.number().int().positive().safe(),
  z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .refine(Number.isSafeInteger),
]);
const winner = z.strictObject({
  eventId: ExternalIdSchema,
  winnerRunId: ExternalIdSchema,
  eventRevision: integer,
});
type Change = Extract<TenantAuditEvent["event"], { eventType: "EVENT_STATE_CHANGE" }>;
const scopeSql = runtimeBindingKeys.map((key, i) => `"${key}"=$${i + 1}`).join(" AND ");

async function eventState(
  scope: EventRuntimeTransaction,
  eventId: string,
  revision: number,
): Promise<EventState> {
  const parameters = [...runtimeBindingKeys.map((key) => scope.authority.binding[key]), eventId];
  const current = await scope.client.query(
    `SELECT state,revision FROM public.events WHERE ${scopeSql} AND id=$6`,
    parameters,
  );
  if (current.rows.length !== 1) throw runtimeUnavailable();
  const state = EventStateSchema.parse(current.rows[0]?.state);
  const latest = integer.parse(current.rows[0]?.revision);
  if (latest > 10000) throw runtimeUnavailable();
  const evidence = await scope.client.query(
    `SELECT "evidenceRevision" FROM public.event_evidence WHERE ${scopeSql} AND "eventId"=$6 LIMIT 10001`,
    parameters,
  );
  if (evidence.rows.length > 10000) throw runtimeUnavailable();
  const revisions = new Set(evidence.rows.map((row) => integer.parse(row.evidenceRevision)));
  const changes = await lifecycleChanges(scope, eventId);
  return stateAtRevision(state, latest, revisions, changes, revision);
}
async function lifecycleChanges(
  scope: EventRuntimeTransaction,
  eventId: string,
): Promise<Change[]> {
  const audits = await scope.client.query(
    `SELECT payload FROM public.audit_logs WHERE "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3
    AND payload->'resource'->>'id'=$4 AND payload->'event'->>'eventType'='EVENT_STATE_CHANGE' LIMIT 10001`,
    [...runtimeBindingKeys.slice(0, 3).map((key) => scope.authority.binding[key]), eventId],
  );
  if (audits.rows.length > 10000) throw runtimeUnavailable();
  return audits.rows
    .map((row) => {
      const event = TenantAuditEventSchema.parse(row.payload);
      if (event.resource?.type !== "EVENT") throw runtimeUnavailable();
      return event.event;
    })
    .filter((event): event is Change => event.eventType === "EVENT_STATE_CHANGE");
}
function stateAtRevision(
  state: EventState,
  latest: number,
  revisions: ReadonlySet<number>,
  changes: readonly Change[],
  revision: number,
): EventState {
  let selected: EventState | null = null;
  if (revision > latest || !revisions.has(1)) throw runtimeUnavailable();
  for (let version = latest; version >= 1; version--) {
    if (version === revision) selected = state;
    const mutations = changes.filter((change) => change.redactedMetadata.revision === version);
    if (Number(revisions.has(version)) + mutations.length !== 1) throw runtimeUnavailable();
    if (mutations.length === 0) continue;
    const change = mutations[0]!.redactedMetadata;
    if (change.toState !== state || change.expectedRevision !== version - 1)
      throw runtimeUnavailable();
    state = change.fromState;
  }
  // Verify creation and every intervening revision; missing lifecycle history cannot imply OPEN.
  if (selected === null || state !== "OPEN") throw runtimeUnavailable();
  return selected;
}
export async function runtimeAgentAudit(
  scope: EventRuntimeTransaction,
  runId: string,
): Promise<TenantAuditEvent | null> {
  const { binding } = scope.authority;
  const result = await scope.client.query(
    `SELECT payload FROM public.audit_logs WHERE "organizationId"=$1 AND "workspaceId"=$2 AND "storeId"=$3
    AND payload->'event'->>'eventType'='AGENT_RUN' AND payload->'links'->>'runId'=$4`,
    [binding.organizationId, binding.workspaceId, binding.storeId, runId],
  );
  if (result.rows.length > 1) throw runtimeUnavailable();
  return result.rows[0] ? TenantAuditEventSchema.parse(result.rows[0].payload) : null;
}
export async function loadRuntimeHistory(
  scope: EventRuntimeTransaction,
  decisions: DecisionReadPort,
): Promise<DecisionRoutingSnapshot["history"]> {
  const result = await scope.client.query(
    `SELECT "eventId","winnerRunId","eventRevision" FROM public.decision_claims
    WHERE ${scopeSql} AND "winnerRunId" IS NOT NULL ORDER BY "createdAt",id LIMIT 10001`,
    runtimeBindingKeys.map((key) => scope.authority.binding[key]),
  );
  if (result.rows.length > 10000) throw runtimeUnavailable();
  const history: DecisionRoutingSnapshot["history"][number][] = [];
  for (const value of result.rows) {
    history.push(await historyEntry(scope, decisions, winner.parse(value)));
  }
  return history;
}
async function historyEntry(
  scope: EventRuntimeTransaction,
  decisions: DecisionReadPort,
  row: z.infer<typeof winner>,
): Promise<DecisionRoutingSnapshot["history"][number]> {
  const runs = await decisions.read({
    actor: scope.authority.actor,
    binding: scope.authority.binding,
    eventId: row.eventId,
    decisionId: row.winnerRunId,
  });
  if (!runs.ok || runs.value.length !== 1) throw runtimeUnavailable();
  const run = runs.value[0]!;
  const policyVersion = runtimeRoutingEpoch(run.rulesetVersion);
  const audit = await runtimeAgentAudit(scope, run.id);
  if (
    policyVersion === null ||
    !audit ||
    audit.event.eventType !== "AGENT_RUN" ||
    audit.event.redactedMetadata.runStatus !== "COMPLETED" ||
    run.mode !== "PRIMARY" ||
    run.result.status !== "EVALUATED" ||
    run.effective === null ||
    audit.links.evidenceId !== run.evidence.id ||
    audit.resource?.id !== run.id ||
    audit.resource.type !== "RUN"
  )
    throw runtimeUnavailable();
  return {
    run: RoutedPrimaryDecisionRunSchema.parse(run),
    eventRevision: row.eventRevision,
    eventState: await eventState(scope, row.eventId, row.eventRevision),
    policyVersion,
    routedAt: audit.occurredAt,
  };
}
