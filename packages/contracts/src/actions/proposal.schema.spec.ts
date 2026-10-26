import { describe, expect, it, vi } from "vitest";
import {
  ActionProposalV1Schema,
  ApprovalBindingV1Schema,
  ApprovalDecisionRequestSchema,
  PROPOSAL_MAX_TTL_MS,
  APPROVAL_REAUTH_MAX_AGE_MS,
  APPROVAL_REQUIRED_PERMISSIONS,
  PROPOSAL_REQUIRED_PERMISSIONS,
  approvalMatchesProposal,
  verifyHumanApprovalAuthority,
  type CurrentAuthorityReader,
  type HumanApprovalIdentity,
} from "./proposal.schema.js";

const created = "2026-10-26T12:00:00Z";
const expiry = "2026-10-26T12:10:00Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  generation: 1,
};

function proposal() {
  return ActionProposalV1Schema.parse({
    schemaVersion: 1,
    proposalId: "proposal-a",
    revision: 1,
    payloadHash: hashA,
    previousPayloadHash: null,
    origin: "AI_CANDIDATE",
    scope,
    priceChange: {
      kind: "PRICE_SET",
      externalSkuId: "sku-a",
      sourceVersion: "source-v1",
      oldPriceMinor: 5900,
      newPriceMinor: 6200,
      currency: "CNY",
    },
    evidenceRefs: [{ evidenceId: "evidence-a", evidenceVersion: "v1" }],
    riskLevel: "LOW",
    riskRuleVersion: "risk-v1",
    createdAt: created,
    expiresAt: expiry,
  });
}

function approval() {
  return ApprovalBindingV1Schema.parse({
    schemaVersion: 1,
    approvalId: "approval-a",
    proposalId: "proposal-a",
    revision: 1,
    payloadHash: hashA,
    scope,
    riskLevel: "LOW",
    approvedPrincipalId: "human-a",
    sessionId: "session-a",
    reauthProofId: "proof-a",
    reauthenticatedAt: "2026-10-26T12:02:00Z",
    approvedAt: "2026-10-26T12:03:00Z",
    expiresAt: expiry,
  });
}

// Synthetic fixture only; real identities must come from the server adapter.
function humanIdentity(changes: Record<string, string> = {}) {
  return {
    principalId: "human-a",
    sessionId: "session-a",
    reauthProofId: "proof-a",
    reauthenticatedAt: "2026-10-26T12:02:00Z",
    ...changes,
  } as unknown as HumanApprovalIdentity;
}

function authorityReader(): CurrentAuthorityReader {
  return {
    hasCurrentPermissions: vi.fn(async () => true),
    isReauthProofActive: vi.fn(async () => true),
    isSessionRevoked: vi.fn(async () => false),
  };
}

describe("P07-001 proposal and approval contracts", () => {
  it("accepts a strict CNY proposal with immutable revision references", () => {
    const result = proposal();
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.priceChange.oldPriceMinor).toBe(5900);
    expect(result.priceChange.newPriceMinor).toBe(6200);
    expect(result.origin).toBe("AI_CANDIDATE");
  });

  it.each([
    { payloadHash: "invalid" },
    { revision: 0 },
    { revision: 2 },
    { previousPayloadHash: hashB },
    { expiresAt: created },
    { expiresAt: "2026-10-26T13:00:00Z" },
    { createdAt: "invalid" },
  ])("rejects invalid revision/hash/TTL %o", (changes) => {
    expect(
      ActionProposalV1Schema.safeParse({
        ...proposal(),
        ...changes,
      }).success,
    ).toBe(false);
  });

  it.each([
    { currency: "USD" },
    { sourceVersion: "" },
    { sourceVersion: null },
    { oldPriceMinor: 0 },
    { newPriceMinor: -1 },
    { newPriceMinor: 62.5 },
    { newPriceMinor: Number.MAX_SAFE_INTEGER + 1 },
    { externalSkuId: "" },
  ])("rejects invalid price/source fields %o", (changes) => {
    const base = proposal();
    expect(
      ActionProposalV1Schema.safeParse({
        ...base,
        priceChange: { ...base.priceChange, ...changes },
      }).success,
    ).toBe(false);
  });

  it("rejects missing scope, generation, evidence, and risk versions", () => {
    const base = proposal();
    for (const patch of [
      { scope: { organizationId: "org-a" } },
      { scope: { ...scope, generation: 0 } },
      { evidenceRefs: [] },
      { riskRuleVersion: "" },
      { evidenceRefs: [base.evidenceRefs[0], base.evidenceRefs[0]] },
    ]) {
      expect(
        ActionProposalV1Schema.safeParse({
          ...base,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects untrusted tenant, permissions and approver overrides", () => {
    for (const field of [
      "approvedBy",
      "actor",
      "permissions",
      "tenantId",
      "organizationId",
      "storeId",
      "token",
      "prompt",
    ]) {
      expect(
        ActionProposalV1Schema.safeParse({
          ...proposal(),
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a valid second immutable revision", () => {
    expect(
      ActionProposalV1Schema.safeParse({
        ...proposal(),
        revision: 2,
        previousPayloadHash: hashA,
        payloadHash: hashB,
      }).success,
    ).toBe(true);
  });

  it("keeps approval requests free of identity and tenant fields", () => {
    const request = {
      decision: "APPROVE",
      proposalId: "proposal-a",
      expectedRevision: 1,
      expectedPayloadHash: hashA,
    };
    expect(ApprovalDecisionRequestSchema.safeParse(request).success).toBe(true);

    for (const field of [
      "approvedBy",
      "actor",
      "humanIdentity",
      "permissions",
      "scope",
      "organizationId",
      "storeId",
    ]) {
      expect(
        ApprovalDecisionRequestSchema.safeParse({
          ...request,
          [field]: "forged",
        }).success,
      ).toBe(false);
    }
  });

  it("supports explicit human rejection without forged approvers", () => {
    expect(
      ApprovalDecisionRequestSchema.safeParse({
        decision: "REJECT",
        proposalId: "proposal-a",
        expectedRevision: 1,
        expectedPayloadHash: hashA,
        reasonCode: "BUSINESS_DECISION",
      }).success,
    ).toBe(true);
  });

  it("requires approval to bind a non-critical revision and recent proof", () => {
    expect(ApprovalBindingV1Schema.safeParse(approval()).success).toBe(true);

    for (const patch of [
      { riskLevel: "CRITICAL" },
      { reauthenticatedAt: "2026-10-26T11:00:00Z" },
      { reauthenticatedAt: "2026-10-26T12:04:00Z" },
      { approvedAt: expiry },
      { reauthProofId: "" },
    ]) {
      expect(
        ApprovalBindingV1Schema.safeParse({
          ...approval(),
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects old revision, changed hash, wrong scope and expired binding", () => {
    expect(approvalMatchesProposal(approval(), proposal(), "2026-10-26T12:04:00Z")).toBe(true);

    for (const patch of [
      { revision: 2 },
      { payloadHash: hashB },
      { scope: { ...scope, storeId: "store-b" } },
      { scope: { ...scope, generation: 2 } },
    ]) {
      expect(
        approvalMatchesProposal({ ...approval(), ...patch }, proposal(), "2026-10-26T12:04:00Z"),
      ).toBe(false);
    }

    expect(approvalMatchesProposal(approval(), proposal(), expiry)).toBe(false);
  });

  it("does not reuse a prior approval after proposal content changes", () => {
    const revised = {
      ...proposal(),
      revision: 2,
      previousPayloadHash: hashA,
      payloadHash: hashB,
    };
    expect(approvalMatchesProposal(approval(), revised, "2026-10-26T12:04:00Z")).toBe(false);
  });

  it("never approves a CRITICAL candidate", () => {
    expect(
      approvalMatchesProposal(
        approval(),
        { ...proposal(), riskLevel: "CRITICAL" },
        "2026-10-26T12:04:00Z",
      ),
    ).toBe(false);
  });

  it("requires current approve and store-write permissions", async () => {
    const reader = authorityReader();
    const allowed = await verifyHumanApprovalAuthority(
      humanIdentity(),
      scope,
      reader,
      "2026-10-26T12:04:00Z",
    );

    expect(allowed).toBe(true);
    expect(reader.hasCurrentPermissions).toHaveBeenCalledWith("human-a", scope, [
      "actions:approve",
      "products:write",
    ]);
    expect(PROPOSAL_REQUIRED_PERMISSIONS).toEqual(["actions:propose"]);
    expect(APPROVAL_REQUIRED_PERMISSIONS).toEqual(["actions:approve", "products:write"]);
  });

  it("denies stale, future and invalid authentication proof times", async () => {
    for (const reauthenticatedAt of ["2026-10-26T11:00:00Z", "2026-10-26T12:06:00Z", "invalid"]) {
      expect(
        await verifyHumanApprovalAuthority(
          humanIdentity({ reauthenticatedAt }),
          scope,
          authorityReader(),
          "2026-10-26T12:04:00Z",
        ),
      ).toBe(false);
    }
    expect(APPROVAL_REAUTH_MAX_AGE_MS).toBe(300000);
    expect(PROPOSAL_MAX_TTL_MS).toBe(900000);
  });

  it("denies revoked sessions, invalid proofs and lost permissions", async () => {
    const scenarios: CurrentAuthorityReader[] = [
      { ...authorityReader(), isSessionRevoked: async () => true },
      { ...authorityReader(), isReauthProofActive: async () => false },
      { ...authorityReader(), hasCurrentPermissions: async () => false },
    ];
    for (const reader of scenarios) {
      expect(
        await verifyHumanApprovalAuthority(humanIdentity(), scope, reader, "2026-10-26T12:04:00Z"),
      ).toBe(false);
    }
  });

  it("fails closed on authority service errors", async () => {
    const reader = {
      ...authorityReader(),
      isReauthProofActive: async () => {
        throw new Error("Authority unavailable");
      },
    };
    expect(
      await verifyHumanApprovalAuthority(humanIdentity(), scope, reader, "2026-10-26T12:04:00Z"),
    ).toBe(false);
  });
});
