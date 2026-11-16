import {
  APPROVAL_REAUTH_MAX_AGE_MS,
  APPROVAL_REQUIRED_PERMISSIONS,
  ActionProposalV1Schema,
  ConnectorTimestampSchema,
  ExternalIdSchema,
  TenantIdSchema,
  type ActionProposalV1,
  type CurrentAuthorityReader,
  type HumanApprovalIdentity,
  type SecurityClock,
} from "@shopmate/contracts";
import { z } from "zod";

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH"] as const;

export const HumanApprovalPolicyV1Schema = z
  .strictObject({
    policyVersion: ExternalIdSchema,
    // Never longer than the contract's re-authentication ceiling.
    recentAuthWindowMs: z.number().int().min(1).max(APPROVAL_REAUTH_MAX_AGE_MS),
    selfApprovalForbiddenFrom: z.enum(RISK_ORDER),
  })
  .readonly();
export type HumanApprovalPolicyV1 = z.infer<typeof HumanApprovalPolicyV1Schema>;

export const DEFAULT_HUMAN_APPROVAL_POLICY_V1: HumanApprovalPolicyV1 = Object.freeze({
  policyVersion: "human-approval-v1",
  recentAuthWindowMs: APPROVAL_REAUTH_MAX_AGE_MS,
  selfApprovalForbiddenFrom: "HIGH",
});

const requestSchema = z
  .strictObject({
    actor: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("HUMAN"), identity: z.unknown() }),
      z.strictObject({ kind: z.enum(["AI_AGENT", "RULE", "SYSTEM"]) }),
    ]),
    proposal: ActionProposalV1Schema,
    proposer: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("HUMAN"), principalId: TenantIdSchema }),
      z.strictObject({ kind: z.enum(["AI_AGENT", "RULE"]) }),
    ]),
  })
  .readonly();

/** The HUMAN identity must come from the trusted server authentication adapter. */
export type HumanApprovalRequest = Readonly<{
  actor:
    | Readonly<{ kind: "HUMAN"; identity: HumanApprovalIdentity }>
    | Readonly<{ kind: "AI_AGENT" | "RULE" | "SYSTEM" }>;
  proposal: ActionProposalV1;
  proposer:
    | Readonly<{ kind: "HUMAN"; principalId: string }>
    | Readonly<{ kind: "AI_AGENT" | "RULE" }>;
}>;

// The brand only exists at compile time, so the identity is re-validated at runtime.
const identitySchema = z
  .strictObject({
    principalId: TenantIdSchema,
    sessionId: TenantIdSchema,
    reauthProofId: TenantIdSchema,
    reauthenticatedAt: ConnectorTimestampSchema,
  })
  .readonly();
type VerifiedIdentity = z.infer<typeof identitySchema>;

export type HumanApprovalDenialCode =
  | "INVALID_POLICY"
  | "INVALID_REQUEST"
  | "CLOCK_UNAVAILABLE"
  | "HUMAN_APPROVAL_REQUIRED"
  | "INVALID_IDENTITY"
  | "CRITICAL_APPROVAL_DISABLED"
  | "PROPOSAL_EXPIRED"
  | "SELF_APPROVAL_FORBIDDEN"
  | "REAUTH_REQUIRED"
  | "SESSION_INACTIVE"
  | "PERMISSION_DENIED"
  | "AUTHORITY_UNAVAILABLE";

export type HumanApprovalDecisionV1 =
  | Readonly<{
      allowed: true;
      policyVersion: string;
      principalId: string;
      sessionId: string;
      reauthProofId: string;
      checkedAt: string;
    }>
  | Readonly<{ allowed: false; code: HumanApprovalDenialCode; policyVersion: string | null }>;

export interface HumanApprovalDependencies {
  readonly reader: CurrentAuthorityReader;
  readonly clock: SecurityClock;
}

type Request = z.infer<typeof requestSchema>;
type Context = Readonly<{
  request: Request;
  identity: VerifiedIdentity;
  policy: HumanApprovalPolicyV1;
  now: number;
}>;

function deny(
  code: HumanApprovalDenialCode,
  policyVersion: string | null,
): HumanApprovalDecisionV1 {
  return Object.freeze({ allowed: false, code, policyVersion });
}

function securityNow(clock: SecurityClock): number | null {
  if (clock.timeDomain !== "SECURITY_UTC") return null;
  try {
    const now = ConnectorTimestampSchema.safeParse(clock.now());
    return now.success ? Date.parse(now.data) : null;
  } catch {
    // Without trusted time the re-authentication age cannot be proven.
    return null;
  }
}

/**
 * Deny-by-default ApprovalPolicy. Every call re-reads current authority; nothing is cached,
 * so revocation and permission changes apply to the very next approval attempt.
 */
export async function evaluateHumanApproval(
  input: unknown,
  { reader, clock }: HumanApprovalDependencies,
  candidatePolicy: unknown = DEFAULT_HUMAN_APPROVAL_POLICY_V1,
): Promise<HumanApprovalDecisionV1> {
  const policy = HumanApprovalPolicyV1Schema.safeParse(candidatePolicy);
  if (!policy.success) return deny("INVALID_POLICY", null);
  const version = policy.data.policyVersion;
  const request = requestSchema.safeParse(input);
  if (!request.success) return deny("INVALID_REQUEST", version);
  const now = securityNow(clock);
  if (now === null) return deny("CLOCK_UNAVAILABLE", version);
  const { actor } = request.data;
  if (actor.kind !== "HUMAN") return deny("HUMAN_APPROVAL_REQUIRED", version);
  const identity = identitySchema.safeParse(actor.identity);
  if (!identity.success) return deny("INVALID_IDENTITY", version);
  const context = { request: request.data, identity: identity.data, policy: policy.data, now };
  const local = localDenial(context);
  if (local !== null) return deny(local, version);
  const current = await currentAuthorityDenial(context, reader);
  if (current !== null) return deny(current, version);
  return allow(context);
}

/** Checks that need no I/O run first, so a doomed request never touches the authority store. */
function localDenial({ request, identity, policy, now }: Context): HumanApprovalDenialCode | null {
  const { proposal, proposer } = request;
  if (proposal.riskLevel === "CRITICAL") return "CRITICAL_APPROVAL_DISABLED";
  if (now >= Date.parse(proposal.expiresAt)) return "PROPOSAL_EXPIRED";
  const separated =
    RISK_ORDER.indexOf(proposal.riskLevel) >= RISK_ORDER.indexOf(policy.selfApprovalForbiddenFrom);
  if (separated && proposer.kind === "HUMAN" && proposer.principalId === identity.principalId)
    return "SELF_APPROVAL_FORBIDDEN";
  const age = now - Date.parse(identity.reauthenticatedAt);
  // A future authentication time is as unprovable as a stale one.
  if (age < 0 || age > policy.recentAuthWindowMs) return "REAUTH_REQUIRED";
  return null;
}

/** Only an explicit boolean counts; a throwing or vague adapter cannot prove anything. */
async function provenBoolean(read: () => Promise<boolean>): Promise<boolean | null> {
  try {
    const value: unknown = await read();
    return typeof value === "boolean" ? value : null;
  } catch {
    // Treated as "not proven" by the caller, which then denies.
    return null;
  }
}

async function currentAuthorityDenial(
  { request, identity }: Context,
  reader: CurrentAuthorityReader,
): Promise<HumanApprovalDenialCode | null> {
  const { principalId, sessionId, reauthProofId } = identity;
  const revoked = await provenBoolean(() => reader.isSessionRevoked(sessionId));
  if (revoked === null) return "REAUTH_REQUIRED";
  if (revoked) return "SESSION_INACTIVE";
  const proof = await provenBoolean(() =>
    reader.isReauthProofActive(principalId, sessionId, reauthProofId),
  );
  if (proof !== true) return "REAUTH_REQUIRED";
  const permitted = await provenBoolean(() =>
    reader.hasCurrentPermissions(
      principalId,
      request.proposal.scope,
      APPROVAL_REQUIRED_PERMISSIONS,
    ),
  );
  if (permitted === null) return "AUTHORITY_UNAVAILABLE";
  return permitted ? null : "PERMISSION_DENIED";
}

function allow({ identity, policy, now }: Context): HumanApprovalDecisionV1 {
  return Object.freeze({
    allowed: true,
    policyVersion: policy.policyVersion,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    reauthProofId: identity.reauthProofId,
    checkedAt: new Date(now).toISOString(),
  });
}
