import {
  ApprovalBindingV1Schema,
  ConnectorTimestampSchema,
  TenantIdSchema,
  type ApprovalBindingV1,
  type SecurityClock,
} from "@shopmate/contracts";
import { z } from "zod";

const PROPOSAL_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.number().int().min(1).safe();

const approvalRefSchema = z
  .strictObject({ approvalId: TenantIdSchema, revision: revisionSchema, payloadHash: hashSchema })
  .readonly();

export const ProposalStateV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    proposalId: TenantIdSchema,
    status: z.enum(PROPOSAL_STATUSES),
    revision: revisionSchema,
    payloadHash: hashSchema,
    expiresAt: ConnectorTimestampSchema,
    approval: approvalRefSchema.nullable(),
  })
  .refine(
    ({ status, approval, revision, payloadHash }) =>
      // An approval is only meaningful for the exact revision it was granted on.
      status === "APPROVED"
        ? approval?.revision === revision && approval.payloadHash === payloadHash
        : approval === null,
    { message: "Approval must belong to the current APPROVED revision" },
  )
  .readonly();
export type ProposalStateV1 = z.infer<typeof ProposalStateV1Schema>;

const expected = { expectedRevision: revisionSchema };
const nextRevisionSchema = z
  .strictObject({
    revision: revisionSchema,
    payloadHash: hashSchema,
    previousPayloadHash: hashSchema,
    expiresAt: ConnectorTimestampSchema,
  })
  .readonly();

export const ProposalCommandV1Schema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("SUBMIT"), ...expected }),
    z.strictObject({ kind: z.literal("REQUEST_APPROVAL"), ...expected }),
    z.strictObject({ kind: z.literal("APPROVE"), ...expected, approval: ApprovalBindingV1Schema }),
    z.strictObject({ kind: z.literal("REJECT"), ...expected }),
    z.strictObject({ kind: z.literal("REVISE"), ...expected, revision: nextRevisionSchema }),
    z.strictObject({ kind: z.literal("EXPIRE"), ...expected }),
  ])
  .readonly();
export type ProposalCommandV1 = z.infer<typeof ProposalCommandV1Schema>;

type TransitionRow = Readonly<Partial<Record<ProposalStatus, ProposalStatus>>>;
const OPEN = ["DRAFT", "PROPOSED", "PENDING_APPROVAL", "APPROVED"] as const;

/**
 * ProposalTransitionV1. REJECTED and EXPIRED are terminal; a change after rejection or expiry
 * is a new proposal. Execution is outside this table, so no command can reach it from here.
 */
export const PROPOSAL_TRANSITIONS_V1: Readonly<Record<ProposalCommandV1["kind"], TransitionRow>> =
  Object.freeze({
    SUBMIT: { DRAFT: "PROPOSED" },
    REQUEST_APPROVAL: { PROPOSED: "PENDING_APPROVAL" },
    APPROVE: { PENDING_APPROVAL: "APPROVED" },
    REJECT: { PENDING_APPROVAL: "REJECTED" },
    // Editing keeps the stage, except that approved content must be approved again.
    REVISE: {
      DRAFT: "DRAFT",
      PROPOSED: "PROPOSED",
      PENDING_APPROVAL: "PENDING_APPROVAL",
      APPROVED: "PENDING_APPROVAL",
    },
    EXPIRE: Object.fromEntries(OPEN.map((status) => [status, "EXPIRED"])),
  });

export type ProposalTransitionError =
  | "INVALID_STATE"
  | "INVALID_COMMAND"
  | "CLOCK_UNAVAILABLE"
  | "REVISION_CONFLICT"
  | "ILLEGAL_TRANSITION"
  | "PROPOSAL_EXPIRED"
  | "NOT_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "INVALID_REVISION";

export type ProposalTransitionResult =
  | Readonly<{ ok: true; state: ProposalStateV1 }>
  | Readonly<{ ok: false; code: ProposalTransitionError }>;

function failure(code: ProposalTransitionError): ProposalTransitionResult {
  return Object.freeze({ ok: false, code });
}

function success(state: ProposalStateV1): ProposalTransitionResult {
  const parsed = ProposalStateV1Schema.parse(state);
  return Object.freeze({ ok: true, state: Object.freeze({ ...parsed }) });
}

/** Milliseconds from the server security clock, or null when it cannot be trusted. */
function securityNow(clock: SecurityClock): number | null {
  if (clock.timeDomain !== "SECURITY_UTC") return null;
  try {
    const now = ConnectorTimestampSchema.safeParse(clock.now());
    return now.success ? Date.parse(now.data) : null;
  } catch {
    // A failing clock must stop the transition rather than fall back to a guessed time.
    return null;
  }
}

/** Pure ProposalTransitionV1: never mutates the input and returns the unchanged code on refusal. */
export function transitionProposal(
  state: unknown,
  command: unknown,
  clock: SecurityClock,
): ProposalTransitionResult {
  const current = ProposalStateV1Schema.safeParse(state);
  if (!current.success) return failure("INVALID_STATE");
  const parsed = ProposalCommandV1Schema.safeParse(command);
  if (!parsed.success) return failure("INVALID_COMMAND");
  const now = securityNow(clock);
  if (now === null) return failure("CLOCK_UNAVAILABLE");
  return applyCommand(current.data, parsed.data, now);
}

function applyCommand(
  state: ProposalStateV1,
  command: ProposalCommandV1,
  now: number,
): ProposalTransitionResult {
  if (command.expectedRevision !== state.revision) return failure("REVISION_CONFLICT");
  const next = PROPOSAL_TRANSITIONS_V1[command.kind][state.status];
  if (next === undefined) return failure("ILLEGAL_TRANSITION");
  const expired = now >= Date.parse(state.expiresAt);
  if (command.kind === "EXPIRE")
    return expired ? success({ ...state, status: next, approval: null }) : failure("NOT_EXPIRED");
  if (expired) return failure("PROPOSAL_EXPIRED");
  if (command.kind === "APPROVE") return approve(state, command.approval, now, next);
  if (command.kind === "REVISE") return revise(state, command.revision, now, next);
  return success({ ...state, status: next });
}

function approve(
  state: ProposalStateV1,
  binding: ApprovalBindingV1,
  now: number,
  next: ProposalStatus,
): ProposalTransitionResult {
  const matches =
    binding.proposalId === state.proposalId &&
    binding.revision === state.revision &&
    binding.payloadHash === state.payloadHash &&
    binding.expiresAt === state.expiresAt &&
    Date.parse(binding.approvedAt) <= now;
  if (!matches) return failure("APPROVAL_MISMATCH");
  const approval = {
    approvalId: binding.approvalId,
    revision: binding.revision,
    payloadHash: binding.payloadHash,
  };
  return success({ ...state, status: next, approval });
}

function revise(
  state: ProposalStateV1,
  revision: z.infer<typeof nextRevisionSchema>,
  now: number,
  next: ProposalStatus,
): ProposalTransitionResult {
  const chained =
    revision.revision === state.revision + 1 &&
    revision.previousPayloadHash === state.payloadHash &&
    revision.payloadHash !== state.payloadHash &&
    Date.parse(revision.expiresAt) > now;
  if (!chained) return failure("INVALID_REVISION");
  const { revision: number, payloadHash, expiresAt } = revision;
  return success({
    ...state,
    status: next,
    revision: number,
    payloadHash,
    expiresAt,
    approval: null,
  });
}
