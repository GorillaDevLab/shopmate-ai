import { z } from "zod";
import {
  ConnectorTimestampSchema,
  ExternalIdSchema,
  MinorAmountSchema,
} from "../commerce/connector-common.schema.js";
import { TenantIdSchema, TenantRoleSchema } from "../tenant/tenant.schema.js";
import {
  EventEvidenceReferenceSchema,
  EventStateSchema,
  EventTransitionReasonSchema,
} from "../events/event.schema.js";
import { EventTimestampSchema } from "../events/event-evidence.schema.js";

const id = TenantIdSchema;
const timestamp = ConnectorTimestampSchema;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSequence = z.number().int().positive().safe();

export const AuditEventTypeSchema = z.enum([
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
]);

export const AuditResultSchema = z.enum(["SUCCESS", "REJECTED", "FAILED", "UNKNOWN"]);

export const AuditTenantScopeSchema = z.strictObject({
  organizationId: id,
  workspaceId: id,
  storeId: id,
});

export const AuditActorSchema = z.strictObject({
  actorId: id,
  actorKind: z.enum(["USER", "SERVICE", "SYSTEM"]),
  identitySource: z.literal("SERVER"),
});

export const AuditResourceSchema = z.strictObject({
  type: z.enum([
    "ORGANIZATION",
    "WORKSPACE",
    "STORE",
    "PRODUCT",
    "SKU",
    "ORDER",
    "PROPOSAL",
    "EXECUTION",
    "NOTIFICATION",
    "RUN",
    "CONNECTION",
    "EXPORT",
    "SESSION",
  ]),
  id,
});

export const AuditLinksSchema = z.strictObject({
  requestId: id,
  occurrenceId: id,
  runId: id.nullable(),
  evidenceId: id.nullable(),
  actionId: id.nullable(),
  revisionId: id.nullable(),
  approvalId: id.nullable(),
  executionId: id.nullable(),
});

export const AuditReasonSchema = z.enum([
  "REQUESTED",
  "COMPLETED",
  "POLICY_DENIED",
  "VALIDATION_FAILED",
  "EXPIRED",
  "CONFLICT",
  "UPSTREAM_UNAVAILABLE",
]);

const securityDetail = z.strictObject({
  eventType: z.enum([
    "AUTH_LOGIN",
    "AUTH_LOGOUT",
    "AUTHORIZATION",
    "CREDENTIAL_CHANGE",
    "EXPORT",
    "DISCONNECT",
    "DELETE",
  ]),
  redactedMetadata: z.strictObject({
    reasonCode: AuditReasonSchema.nullable(),
  }),
});

const roleDetail = z.strictObject({
  eventType: z.literal("ROLE_CHANGE"),
  redactedMetadata: z.strictObject({
    previousRole: TenantRoleSchema.nullable(),
    nextRole: TenantRoleSchema.nullable(),
  }),
});

const actionDetail = z.strictObject({
  eventType: z.enum([
    "PROPOSAL",
    "APPROVAL",
    "REJECTION",
    "EXECUTION",
    "VERIFICATION",
    "COMPENSATION",
  ]),
  redactedMetadata: z.strictObject({
    actionKind: z.enum(["PRICE", "INVENTORY", "PRODUCT"]),
    oldPriceMinor: MinorAmountSchema.nullable(),
    newPriceMinor: MinorAmountSchema.nullable(),
    reasonCode: AuditReasonSchema.nullable(),
  }),
});

const runDetail = z.strictObject({
  eventType: z.literal("AGENT_RUN"),
  redactedMetadata: z.strictObject({
    runStatus: z.enum(["STARTED", "COMPLETED", "FAILED", "STOPPED"]),
  }),
});

const notificationDetail = z.strictObject({
  eventType: z.enum([
    "NOTIFICATION_INTENT",
    "NOTIFICATION_DELIVERY",
    "NOTIFICATION_READ",
    "NOTIFICATION_PREFERENCE",
    "BRIEF",
  ]),
  redactedMetadata: z.strictObject({
    channel: z.literal("IN_APP"),
    deliveryStatus: z.enum(["PENDING", "DELIVERED", "READ", "FAILED", "NOT_APPLICABLE"]),
  }),
});

const lifecycleMetadata = z.strictObject({
  fromState: EventStateSchema,
  toState: EventStateSchema,
  reason: EventTransitionReasonSchema,
  expectedRevision: positiveSequence,
  revision: positiveSequence,
  evidenceReference: EventEvidenceReferenceSchema,
});
function validLifecycle(value: z.infer<typeof lifecycleMetadata>): boolean {
  if (value.revision !== value.expectedRevision + 1) return false;
  if (value.fromState === "RESOLVED" || value.fromState === "SUPPRESSED") return false;
  if (value.toState === "ACKNOWLEDGED")
    return value.fromState === "OPEN" && value.reason === "ACKNOWLEDGED_BY_OPERATOR";
  if (value.toState === "RESOLVED")
    return value.reason === "CONDITION_CLEARED" || value.reason === "MANUALLY_RESOLVED";
  return (
    value.toState === "SUPPRESSED" &&
    ["FALSE_POSITIVE", "DUPLICATE", "MAINTENANCE"].includes(value.reason)
  );
}
const lifecycleDetail = z.strictObject({
  eventType: z.literal("EVENT_STATE_CHANGE"),
  redactedMetadata: lifecycleMetadata.refine(
    validLifecycle,
    "Invalid lifecycle transition/revision",
  ),
});
export const AuditEventDetailSchema = z.discriminatedUnion("eventType", [
  securityDetail,
  roleDetail,
  actionDetail,
  runDetail,
  notificationDetail,
  lifecycleDetail,
]);

// Only tenant envelopes gain EVENT/ExternalId; legacy AuditResourceSchema stays an object.
const eventResource = z.strictObject({ type: z.literal("EVENT"), id: ExternalIdSchema });

const tenantFields = {
  scopeKind: z.literal("TENANT"),
  scope: AuditTenantScopeSchema,
  actor: AuditActorSchema,
  resource: z.union([AuditResourceSchema, eventResource]).nullable(),
  result: AuditResultSchema,
  occurredAt: timestamp,
  sourceOccurredAt: timestamp.nullable(),
  links: AuditLinksSchema,
  event: AuditEventDetailSchema,
};

function validTenantLifecycle(value: z.infer<z.ZodObject<typeof tenantFields>>): boolean {
  if (value.event.eventType !== "EVENT_STATE_CHANGE") return value.resource?.type !== "EVENT";
  const binding = value.event.redactedMetadata.evidenceReference.binding;
  return (
    value.resource?.type === "EVENT" &&
    value.result === "SUCCESS" &&
    value.actor.actorKind === "USER" &&
    value.sourceOccurredAt === null &&
    EventTimestampSchema.safeParse(value.occurredAt).success &&
    value.scope.organizationId === binding.organizationId &&
    value.scope.workspaceId === binding.workspaceId &&
    value.scope.storeId === binding.storeId &&
    value.links.runId === null &&
    value.links.evidenceId === null &&
    value.links.actionId === null &&
    value.links.revisionId === null &&
    value.links.approvalId === null &&
    value.links.executionId === null
  );
}
export const TenantAuditEventSchema = z
  .strictObject(tenantFields)
  .refine(validTenantLifecycle, "Invalid lifecycle audit envelope")
  .readonly();

const anonymousFields = {
  scopeKind: z.literal("ANONYMOUS_AUTH_SECURITY"),
  scope: z.null(),
  actor: z.null(),
  requestId: id,
  occurredAt: timestamp,
  result: z.enum(["REJECTED", "FAILED"]),
  reason: z.enum([
    "UNKNOWN_IDENTITY",
    "INVALID_CREDENTIALS",
    "EXPIRED_SESSION",
    "RATE_LIMITED",
    "UNAUTHORIZED",
  ]),
  redactedMetadata: z.strictObject({
    attemptClass: z.enum(["LOGIN", "SESSION", "TOKEN"]),
    rateLimited: z.boolean(),
  }),
};

export const AnonymousAuthSecurityEventSchema = z.strictObject(anonymousFields).readonly();

export const AuditAppendInputSchema = z.discriminatedUnion("scopeKind", [
  TenantAuditEventSchema,
  AnonymousAuthSecurityEventSchema,
]);

export const TenantAuditEntrySchema = z
  .strictObject({
    ...tenantFields,
    auditId: id,
    sequence: positiveSequence,
    hashVersion: z.literal(1),
    prevHash: hash.nullable(),
    entryHash: hash,
  })
  .refine(validTenantLifecycle, "Invalid lifecycle audit envelope")
  .readonly();

export const AnonymousAuthSecurityEntrySchema = z
  .strictObject({
    ...anonymousFields,
    auditId: id,
  })
  .readonly();

export const AuditEntrySchema = z.discriminatedUnion("scopeKind", [
  TenantAuditEntrySchema,
  AnonymousAuthSecurityEntrySchema,
]);

export const AuditCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const AuditQuerySchema = z
  .strictObject({
    scope: AuditTenantScopeSchema,
    from: timestamp,
    until: timestamp,
    limit: z.number().int().min(1).max(100),
    cursor: AuditCursorSchema.nullable(),
    eventTypes: z
      .array(AuditEventTypeSchema)
      .max(AuditEventTypeSchema.options.length)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
    actorId: id.nullable(),
  })
  .refine(
    (query) => {
      const duration = Date.parse(query.until) - Date.parse(query.from);
      return duration >= 0 && duration <= 31 * 24 * 60 * 60 * 1000;
    },
    { message: "Audit query window must be within 31 days" },
  )
  .readonly();

export const AuditQueryAccessManifestSchema = z
  .strictObject({
    principalId: id,
    scope: AuditTenantScopeSchema,
    policyVersion: id,
    decision: z.enum(["ALLOW", "DENY"]),
    permittedEventTypes: z
      .array(AuditEventTypeSchema)
      .max(AuditEventTypeSchema.options.length)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
    evaluatedAt: timestamp,
  })
  .readonly();

const integrityFields = {
  chainVisibility: z.enum(["FULL", "PARTIAL"]),
  integrity: z.enum(["PENDING", "CONSISTENT", "MISMATCH", "UNSUPPORTED"]),
  mismatchEvidenceId: id.nullable(),
};

function hasMismatchEvidence(value: {
  integrity: string;
  mismatchEvidenceId: string | null;
}): boolean {
  return value.integrity !== "MISMATCH" || value.mismatchEvidenceId !== null;
}

export const AuditQueryPageSchema = z
  .strictObject({
    scope: AuditTenantScopeSchema,
    items: z.array(TenantAuditEntrySchema).max(100).readonly(),
    nextCursor: AuditCursorSchema.nullable(),
    ...integrityFields,
  })
  .refine(hasMismatchEvidence, {
    message: "MISMATCH requires independent mismatch evidence",
  })
  .readonly();

export const AuditTraceViewSchema = z
  .strictObject({
    traceId: id,
    scope: AuditTenantScopeSchema,
    entries: z.array(TenantAuditEntrySchema).max(100).readonly(),
    ...integrityFields,
  })
  .refine(hasMismatchEvidence, {
    message: "MISMATCH requires independent mismatch evidence",
  })
  .readonly();

export type TenantAuditEvent = z.infer<typeof TenantAuditEventSchema>;
export type AnonymousAuthSecurityEvent = z.infer<typeof AnonymousAuthSecurityEventSchema>;
export type AuditAppendInput = z.infer<typeof AuditAppendInputSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type TenantAuditEntry = z.infer<typeof TenantAuditEntrySchema>;
export type AnonymousAuthSecurityEntry = z.infer<typeof AnonymousAuthSecurityEntrySchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditQueryPage = z.infer<typeof AuditQueryPageSchema>;
export type AuditTraceView = z.infer<typeof AuditTraceViewSchema>;
export type AuditQueryAccessManifest = z.infer<typeof AuditQueryAccessManifestSchema>;

/**
 * The caller must supply its active business-write transaction.
 * Implementations must append within that same transaction.
 * Anonymous events use a separate append-only security sink.
 * A schema or hash chain does not prove identity or non-repudiation.
 */
export interface AuditAppendPort<TTransaction, TSecuritySink> {
  appendTenant(transaction: TTransaction, event: TenantAuditEvent): Promise<TenantAuditEntry>;

  appendAnonymousSecurity(
    securitySink: TSecuritySink,
    event: AnonymousAuthSecurityEvent,
  ): Promise<AnonymousAuthSecurityEntry>;
}
