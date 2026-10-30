import { z } from "zod";
import {
  SetPriceCommandSchema,
  VerificationResultSchema,
  VerifyActionQuerySchema,
  WriteReceiptSchema,
  matchesVerificationExpectation,
} from "../commerce/connector-action.schema.js";
import { ConnectorTimestampSchema, ExternalIdSchema } from "../commerce/connector-common.schema.js";
import { TenantIdSchema } from "../tenant/tenant.schema.js";
import {
  ApprovalBindingV1Schema,
  ProposalScopeSchema,
  type ApprovalBindingV1,
  type ProposalScope,
} from "./proposal.schema.js";

const id = TenantIdSchema;
const timestamp = ConnectorTimestampSchema;
const revision = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const ExecutionLeaseV1Schema = z
  .strictObject({
    leaseId: id,
    fencingToken: revision,
    ownerId: id,
    acquiredAt: timestamp,
    leaseUntil: timestamp,
  })
  .refine((lease) => Date.parse(lease.acquiredAt) < Date.parse(lease.leaseUntil), {
    message: "Invalid lease interval",
  })
  .readonly();

export const ExecutionVerificationV1Schema = z
  .strictObject({
    executionId: id,
    checkedAt: timestamp,
    status: z.enum(["PENDING", "UNKNOWN", "VERIFIED", "MISMATCH"]),
    query: VerifyActionQuerySchema,
    result: VerificationResultSchema,
  })
  .refine(
    (value) => {
      const expected = value.result.status === "UNAVAILABLE" ? "UNKNOWN" : value.result.status;
      return (
        value.status === expected &&
        value.executionId === value.query.executionId &&
        value.executionId === value.result.executionId
      );
    },
    { message: "Verification result or execution correlation mismatch" },
  )
  .readonly();

export const ExecutionStateSchema = z.enum([
  "RESERVED",
  "EXECUTING",
  "VERIFYING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
]);

const ExecutionObjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: id,
  idempotencyKey: ExternalIdSchema,
  scope: ProposalScopeSchema,
  externalStoreId: ExternalIdSchema,
  proposalId: id,
  proposalRevision: revision,
  proposalHash: hash,
  approval: ApprovalBindingV1Schema,
  command: SetPriceCommandSchema,
  lease: ExecutionLeaseV1Schema,
  attempt: revision,
  reservedAt: timestamp,
  deadlineAt: timestamp,
  writeRetryPolicy: z.literal("NO_AUTOMATIC_WRITE_RETRY"),
  state: ExecutionStateSchema,
  proposalState: z.enum(["EXECUTING", "SUCCEEDED", "FAILED"]),
  receipt: WriteReceiptSchema.nullable(),
  verification: ExecutionVerificationV1Schema.nullable(),
});

type ExecutionRecord = z.infer<typeof ExecutionObjectSchema>;

function sameScope(a: ProposalScope, b: ProposalScope): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.workspaceId === b.workspaceId &&
    a.storeId === b.storeId &&
    a.connectionId === b.connectionId &&
    a.generation === b.generation
  );
}

function validApproval(record: ExecutionRecord): boolean {
  const { approval, scope } = record;
  return (
    sameScope(scope, approval.scope) &&
    approval.proposalId === record.proposalId &&
    approval.revision === record.proposalRevision &&
    approval.payloadHash === record.proposalHash &&
    Date.parse(approval.approvedAt) <= Date.parse(record.reservedAt) &&
    Date.parse(record.reservedAt) < Date.parse(approval.expiresAt) &&
    Date.parse(record.deadlineAt) <= Date.parse(approval.expiresAt)
  );
}

function validTiming(record: ExecutionRecord): boolean {
  const reserved = Date.parse(record.reservedAt);
  const deadline = Date.parse(record.deadlineAt);
  const lease = record.lease;
  return (
    reserved < deadline &&
    Date.parse(lease.acquiredAt) >= reserved &&
    Date.parse(lease.acquiredAt) < deadline &&
    Date.parse(lease.leaseUntil) <= deadline &&
    (record.receipt === null || Date.parse(record.receipt.receivedAt) >= reserved) &&
    (record.verification === null ||
      (record.receipt !== null &&
        Date.parse(record.verification.checkedAt) >= Date.parse(record.receipt.receivedAt)))
  );
}

function validCommand(record: ExecutionRecord): boolean {
  const command = record.command;
  return (
    command.executionId === record.executionId &&
    command.idempotencyKey === record.idempotencyKey &&
    command.oldPriceMinor > 0 &&
    command.newPriceMinor > 0 &&
    command.oldPriceMinor !== command.newPriceMinor
  );
}

function validReadback(record: ExecutionRecord): boolean {
  const readback = record.verification;
  if (readback === null) return true;
  const expected = readback.query.expected;
  const command = record.command;
  if (readback.executionId !== record.executionId || expected.kind !== "PRICE") return false;
  if (
    expected.externalSkuId !== command.externalSkuId ||
    expected.priceMinor !== command.newPriceMinor ||
    expected.currency !== command.currency
  )
    return false;

  const result = readback.result;
  if (result.status === "PENDING" || result.status === "UNAVAILABLE") {
    return true;
  }
  if (record.receipt === null) return false;
  const observed = Date.parse(result.snapshot.observedAt);
  return (
    result.snapshot.externalStoreId === record.externalStoreId &&
    observed >= Date.parse(record.receipt.receivedAt) &&
    observed <= Date.parse(readback.checkedAt) &&
    matchesVerificationExpectation(result.snapshot, expected)
  );
}

function validState(record: ExecutionRecord): boolean {
  const { receipt, verification, state, proposalState } = record;
  if (receipt === null) {
    return (
      verification === null &&
      (state === "RESERVED" || state === "EXECUTING") &&
      proposalState === "EXECUTING"
    );
  }
  if (receipt.executionId !== record.executionId) return false;
  if (receipt.outcome === "REJECTED") {
    return verification === null && state === "FAILED" && proposalState === "FAILED";
  }
  if (verification?.status === "VERIFIED") {
    return state === "SUCCEEDED" && proposalState === "SUCCEEDED";
  }
  if (verification?.status === "MISMATCH") {
    return state === "FAILED" && proposalState === "FAILED";
  }
  const unknown = receipt.outcome === "UNKNOWN" || verification?.status === "UNKNOWN";
  return state === (unknown ? "UNKNOWN" : "VERIFYING") && proposalState === "EXECUTING";
}

export const ActionExecutionV1Schema = ExecutionObjectSchema.superRefine((record, context) => {
  const checks = [
    [validApproval(record), "Invalid approval binding"],
    [validTiming(record), "Invalid execution deadline or lease"],
    [validCommand(record), "Invalid price command correlation"],
    [validReadback(record), "Invalid independent readback"],
    [validState(record), "Invalid execution/proposal state"],
  ] as const;
  for (const [valid, message] of checks) {
    if (!valid) context.addIssue({ code: "custom", message });
  }
}).readonly();

export type ActionExecutionV1 = z.infer<typeof ActionExecutionV1Schema>;
export type ExecutionLeaseV1 = z.infer<typeof ExecutionLeaseV1Schema>;
export type ExecutionVerificationV1 = z.infer<typeof ExecutionVerificationV1Schema>;

/**
 * The caller must provide its trusted real-time clock.
 * Business/demo time must never authorize an expired write.
 * The authority reader must also be checked by the execution service.
 */
export function executionMayDispatch(candidate: unknown, trustedNow: unknown): boolean {
  const parsed = ActionExecutionV1Schema.safeParse(candidate);
  const now = timestamp.safeParse(trustedNow);
  if (!parsed.success || !now.success) return false;
  const record = parsed.data;
  const current = Date.parse(now.data);
  return (
    record.state === "RESERVED" &&
    current >= Date.parse(record.reservedAt) &&
    current >= Date.parse(record.lease.acquiredAt) &&
    current < Date.parse(record.lease.leaseUntil) &&
    current < Date.parse(record.deadlineAt) &&
    current < Date.parse(record.approval.expiresAt)
  );
}

export interface ExecutionAuthorityReader {
  isApprovalCurrent(
    approval: ApprovalBindingV1,
    scope: ProposalScope,
    trustedNow: string,
  ): Promise<boolean>;

  isConnectionGenerationCurrent(scope: ProposalScope): Promise<boolean>;

  isLeaseCurrent(
    executionId: string,
    leaseId: string,
    fencingToken: number,
    trustedNow: string,
  ): Promise<boolean>;
}

export interface ExecutionRepository {
  get(executionId: string, scope: ProposalScope): Promise<ActionExecutionV1 | null>;

  reserveApproved(execution: ActionExecutionV1): Promise<"RESERVED" | "IDEMPOTENCY_CONFLICT">;

  recordReceipt(
    executionId: string,
    scope: ProposalScope,
    expectedFencingToken: number,
    receipt: z.infer<typeof WriteReceiptSchema>,
  ): Promise<"UPDATED" | "CONFLICT">;

  recordVerification(
    executionId: string,
    scope: ProposalScope,
    expectedFencingToken: number,
    result: ExecutionVerificationV1,
  ): Promise<"UPDATED" | "CONFLICT">;
}

/** Independent readback only; this port cannot issue another write. */
export interface VerificationScheduler {
  scheduleIndependentReadback(
    executionId: string,
    scope: ProposalScope,
    query: z.infer<typeof VerifyActionQuerySchema>,
    notBefore: string,
  ): Promise<"SCHEDULED" | "ALREADY_SCHEDULED">;
}
