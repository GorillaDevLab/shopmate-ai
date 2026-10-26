import { z } from "zod";
import {
  ConnectorTimestampSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
  SourceVersionSchema,
} from "../commerce/connector-common.schema.js";
import { TenantIdSchema, type TenantPermission } from "../tenant/tenant.schema.js";

export const PROPOSAL_MAX_TTL_MS = 15 * 60 * 1000;
export const APPROVAL_REAUTH_MAX_AGE_MS = 5 * 60 * 1000;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.number().int().min(1).safe();

export const ProposalScopeSchema = z
  .strictObject({
    organizationId: TenantIdSchema,
    workspaceId: TenantIdSchema,
    storeId: TenantIdSchema,
    connectionId: TenantIdSchema,
    generation: revisionSchema,
  })
  .readonly();

export const ProposalPriceChangeSchema = z
  .strictObject({
    kind: z.literal("PRICE_SET"),
    externalSkuId: ExternalIdSchema,
    sourceVersion: SourceVersionSchema,
    oldPriceMinor: MinorAmountSchema.min(1),
    newPriceMinor: MinorAmountSchema.min(1),
    currency: CurrencySchema,
  })
  .readonly();

export const ProposalEvidenceRefSchema = z
  .strictObject({
    evidenceId: TenantIdSchema,
    evidenceVersion: ExternalIdSchema,
  })
  .readonly();

const evidenceRefsSchema = z
  .array(ProposalEvidenceRefSchema)
  .min(1)
  .max(20)
  .refine((values) => new Set(values.map((value) => value.evidenceId)).size === values.length)
  .readonly();

export const ProposalRiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const ActionProposalV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    proposalId: TenantIdSchema,
    revision: revisionSchema,
    payloadHash: hashSchema,
    previousPayloadHash: hashSchema.nullable(),
    origin: z.enum(["AI_CANDIDATE", "HUMAN_DRAFT", "RULE_CANDIDATE"]),
    scope: ProposalScopeSchema,
    priceChange: ProposalPriceChangeSchema,
    evidenceRefs: evidenceRefsSchema,
    riskLevel: ProposalRiskLevelSchema,
    riskRuleVersion: ExternalIdSchema,
    createdAt: ConnectorTimestampSchema,
    expiresAt: ConnectorTimestampSchema,
  })
  .superRefine((proposal, ctx) => {
    const start = Date.parse(proposal.createdAt);
    const end = Date.parse(proposal.expiresAt);
    if (end <= start || end - start > PROPOSAL_MAX_TTL_MS) {
      ctx.addIssue({ code: "custom", message: "Invalid proposal TTL" });
    }
    if ((proposal.revision === 1) !== (proposal.previousPayloadHash === null)) {
      ctx.addIssue({ code: "custom", message: "Invalid revision ancestry" });
    }
  })
  .readonly();

const decisionFields = {
  proposalId: TenantIdSchema,
  expectedRevision: revisionSchema,
  expectedPayloadHash: hashSchema,
};

export const ApprovalDecisionRequestSchema = z
  .discriminatedUnion("decision", [
    z.strictObject({
      ...decisionFields,
      decision: z.literal("APPROVE"),
    }),
    z.strictObject({
      ...decisionFields,
      decision: z.literal("REJECT"),
      reasonCode: z.enum(["NOT_ACCEPTABLE", "INSUFFICIENT_EVIDENCE", "BUSINESS_DECISION"]),
    }),
  ])
  .readonly();

export const ApprovalBindingV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    approvalId: TenantIdSchema,
    proposalId: TenantIdSchema,
    revision: revisionSchema,
    payloadHash: hashSchema,
    scope: ProposalScopeSchema,
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
    approvedPrincipalId: TenantIdSchema,
    sessionId: TenantIdSchema,
    reauthProofId: TenantIdSchema,
    reauthenticatedAt: ConnectorTimestampSchema,
    approvedAt: ConnectorTimestampSchema,
    expiresAt: ConnectorTimestampSchema,
  })
  .refine(
    (binding) => {
      const approved = Date.parse(binding.approvedAt);
      const reauth = Date.parse(binding.reauthenticatedAt);
      const expiry = Date.parse(binding.expiresAt);
      return (
        reauth <= approved && approved - reauth <= APPROVAL_REAUTH_MAX_AGE_MS && approved < expiry
      );
    },
    { message: "Invalid approval authentication or expiry" },
  )
  .readonly();

export type ProposalScope = z.infer<typeof ProposalScopeSchema>;
export type ActionProposalV1 = z.infer<typeof ActionProposalV1Schema>;
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;
export type ApprovalBindingV1 = z.infer<typeof ApprovalBindingV1Schema>;

// This brand has no public constructor or parser.
// Only a trusted server authentication adapter may issue this type.
declare const verifiedHumanIdentity: unique symbol;

export type HumanApprovalIdentity = Readonly<{
  principalId: string;
  sessionId: string;
  reauthProofId: string;
  reauthenticatedAt: string;
  readonly [verifiedHumanIdentity]: true;
}>;

export const PROPOSAL_REQUIRED_PERMISSIONS = [
  "actions:propose",
] as const satisfies readonly TenantPermission[];

export const APPROVAL_REQUIRED_PERMISSIONS = [
  "actions:approve",
  "products:write",
] as const satisfies readonly TenantPermission[];

export interface HumanApprovalIdentityResolver<TServerSession> {
  resolveVerifiedHuman(trustedServerSession: TServerSession): Promise<HumanApprovalIdentity | null>;
}

export interface CurrentAuthorityReader {
  hasCurrentPermissions(
    principalId: string,
    scope: ProposalScope,
    permissions: readonly TenantPermission[],
  ): Promise<boolean>;

  isReauthProofActive(principalId: string, sessionId: string, proofId: string): Promise<boolean>;

  isSessionRevoked(sessionId: string): Promise<boolean>;
}

export interface ProposalRepository {
  getCurrent(proposalId: string, scope: ProposalScope): Promise<ActionProposalV1 | null>;

  appendRevision(
    revision: ActionProposalV1,
    expectedPreviousRevision: number | null,
  ): Promise<"APPENDED" | "REVISION_CONFLICT">;

  appendApproval(approval: ApprovalBindingV1): Promise<"APPENDED" | "REVISION_CONFLICT">;
}

export function approvalMatchesProposal(
  candidateApproval: unknown,
  candidateProposal: unknown,
  trustedNow: unknown,
): boolean {
  const approval = ApprovalBindingV1Schema.safeParse(candidateApproval);
  const proposal = ActionProposalV1Schema.safeParse(candidateProposal);
  const now = ConnectorTimestampSchema.safeParse(trustedNow);
  if (!approval.success || !proposal.success || !now.success) return false;

  const a = approval.data;
  const p = proposal.data;
  const time = Date.parse(now.data);
  const sameScope = Object.keys(p.scope).every(
    (key) => a.scope[key as keyof ProposalScope] === p.scope[key as keyof ProposalScope],
  );

  return (
    p.riskLevel !== "CRITICAL" &&
    a.riskLevel === p.riskLevel &&
    a.proposalId === p.proposalId &&
    a.revision === p.revision &&
    a.payloadHash === p.payloadHash &&
    sameScope &&
    a.expiresAt === p.expiresAt &&
    Date.parse(a.approvedAt) >= Date.parse(p.createdAt) &&
    time >= Date.parse(a.approvedAt) &&
    time < Date.parse(p.expiresAt)
  );
}

// Call only from the server with its trusted clock and identity resolver.
export async function verifyHumanApprovalAuthority(
  identity: HumanApprovalIdentity,
  scope: ProposalScope,
  reader: CurrentAuthorityReader,
  trustedNow: string,
): Promise<boolean> {
  const now = ConnectorTimestampSchema.safeParse(trustedNow);
  const reauth = ConnectorTimestampSchema.safeParse(identity.reauthenticatedAt);
  if (!now.success || !reauth.success) return false;

  const elapsed = Date.parse(now.data) - Date.parse(reauth.data);
  if (elapsed < 0 || elapsed > APPROVAL_REAUTH_MAX_AGE_MS) return false;

  try {
    if (await reader.isSessionRevoked(identity.sessionId)) return false;
    if (
      !(await reader.isReauthProofActive(
        identity.principalId,
        identity.sessionId,
        identity.reauthProofId,
      ))
    )
      return false;
    return reader.hasCurrentPermissions(identity.principalId, scope, APPROVAL_REQUIRED_PERMISSIONS);
  } catch {
    return false;
  }
}
