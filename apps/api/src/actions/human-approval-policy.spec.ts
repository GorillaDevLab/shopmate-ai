import {
  TENANT_ROLE_PERMISSIONS,
  type ActionProposalV1,
  type CurrentAuthorityReader,
  type HumanApprovalIdentity,
  type SecurityClock,
  type TenantRole,
} from "@shopmate/contracts";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_HUMAN_APPROVAL_POLICY_V1,
  evaluateHumanApproval,
  type HumanApprovalRequest,
} from "./human-approval-policy.js";

const clockAt = (now: string): SecurityClock => ({ timeDomain: "SECURITY_UTC", now: () => now });
const clock = clockAt("2026-11-17T02:05:00.000Z");

const proposal: ActionProposalV1 = {
  schemaVersion: 1,
  proposalId: "proposal-1",
  revision: 1,
  payloadHash: "a".repeat(64),
  previousPayloadHash: null,
  origin: "AI_CANDIDATE",
  scope: {
    organizationId: "org-a",
    workspaceId: "workspace-a",
    storeId: "store-a",
    connectionId: "connection-a",
    generation: 1,
  },
  priceChange: {
    kind: "PRICE_SET",
    externalSkuId: "sku-1",
    sourceVersion: "v1",
    oldPriceMinor: 5900,
    newPriceMinor: 6200,
    currency: "CNY",
  },
  evidenceRefs: [{ evidenceId: "evidence-1", evidenceVersion: "1" }],
  riskLevel: "MEDIUM",
  riskRuleVersion: "price-risk-v1",
  createdAt: "2026-11-17T02:00:00.000Z",
  expiresAt: "2026-11-17T02:15:00.000Z",
};

// Test-only stand-in for the trusted server authentication adapter.
function identity(overrides: Record<string, string> = {}): HumanApprovalIdentity {
  return {
    principalId: "user-owner",
    sessionId: "session-1",
    reauthProofId: "proof-1",
    reauthenticatedAt: "2026-11-17T02:02:00.000Z",
    ...overrides,
  } as unknown as HumanApprovalIdentity;
}

function reader(role: TenantRole = "OWNER", overrides: Partial<CurrentAuthorityReader> = {}) {
  const granted = new Set(TENANT_ROLE_PERMISSIONS[role]);
  return {
    hasCurrentPermissions: vi.fn(
      async (_principal: string, _scope: unknown, needed: readonly string[]) =>
        needed.every((permission) => granted.has(permission as never)),
    ),
    isReauthProofActive: vi.fn(async () => true),
    isSessionRevoked: vi.fn(async () => false),
    ...overrides,
  } satisfies CurrentAuthorityReader;
}

function request(overrides: Partial<HumanApprovalRequest> = {}): HumanApprovalRequest {
  return {
    actor: { kind: "HUMAN", identity: identity() },
    proposal,
    proposer: { kind: "AI_AGENT" },
    ...overrides,
  };
}

const denied = (code: string) => ({ allowed: false, code, policyVersion: "human-approval-v1" });

it("allows a current approver with actions:approve, products:write and a recent re-authentication", async () => {
  const authority = reader("OWNER");
  await expect(evaluateHumanApproval(request(), { reader: authority, clock })).resolves.toEqual({
    allowed: true,
    policyVersion: "human-approval-v1",
    principalId: "user-owner",
    sessionId: "session-1",
    reauthProofId: "proof-1",
    checkedAt: "2026-11-17T02:05:00.000Z",
  });
  expect(authority.hasCurrentPermissions).toHaveBeenCalledWith("user-owner", proposal.scope, [
    "actions:approve",
    "products:write",
  ]);
  expect(authority.isSessionRevoked).toHaveBeenCalledWith("session-1");
  expect(authority.isReauthProofActive).toHaveBeenCalledWith("user-owner", "session-1", "proof-1");
});

it("denies roles without current approval permissions", async () => {
  for (const role of ["VIEWER", "ANALYST"] as const) {
    await expect(
      evaluateHumanApproval(request(), { reader: reader(role), clock }),
    ).resolves.toEqual(denied("PERMISSION_DENIED"));
  }
});

it("denies a revoked or expired session and an inactive re-authentication proof", async () => {
  const revoked = reader("OWNER", { isSessionRevoked: vi.fn(async () => true) });
  await expect(evaluateHumanApproval(request(), { reader: revoked, clock })).resolves.toEqual(
    denied("SESSION_INACTIVE"),
  );
  const noProof = reader("OWNER", { isReauthProofActive: vi.fn(async () => false) });
  await expect(evaluateHumanApproval(request(), { reader: noProof, clock })).resolves.toEqual(
    denied("REAUTH_REQUIRED"),
  );
});

it("requires re-authentication when the adapter cannot prove authentication or revocation", async () => {
  const unprovable = [
    reader("OWNER", { isSessionRevoked: vi.fn(async () => Promise.reject(new Error("demo"))) }),
    reader("OWNER", { isReauthProofActive: vi.fn(async () => Promise.reject(new Error("demo"))) }),
    reader("OWNER", { isSessionRevoked: vi.fn(async () => undefined as unknown as boolean) }),
  ];
  for (const authority of unprovable) {
    await expect(evaluateHumanApproval(request(), { reader: authority, clock })).resolves.toEqual(
      denied("REAUTH_REQUIRED"),
    );
  }
  const broken = reader("OWNER", {
    hasCurrentPermissions: vi.fn(async () => Promise.reject(new Error("db down"))),
  });
  await expect(evaluateHumanApproval(request(), { reader: broken, clock })).resolves.toEqual(
    denied("AUTHORITY_UNAVAILABLE"),
  );
});

it("measures re-authentication age only on the security clock, so simulated time cannot extend it", async () => {
  const authority = reader("OWNER");
  const late = clockAt("2026-11-17T02:07:00.001Z");
  await expect(
    evaluateHumanApproval(request(), { reader: authority, clock: late }),
  ).resolves.toEqual(denied("REAUTH_REQUIRED"));
  const future = request({
    actor: { kind: "HUMAN", identity: identity({ reauthenticatedAt: "2026-11-17T02:05:00.001Z" }) },
  });
  await expect(evaluateHumanApproval(future, { reader: authority, clock })).resolves.toEqual(
    denied("REAUTH_REQUIRED"),
  );
  const simulated = { timeDomain: "BUSINESS", now: () => "2026-11-17T02:03:00.000Z" };
  await expect(
    evaluateHumanApproval(request(), {
      reader: authority,
      clock: simulated as unknown as SecurityClock,
    }),
  ).resolves.toEqual(denied("CLOCK_UNAVAILABLE"));
  expect(authority.hasCurrentPermissions).not.toHaveBeenCalled();
});

it("never lets an AI, rule or system actor approve", async () => {
  for (const kind of ["AI_AGENT", "RULE", "SYSTEM"] as const) {
    const authority = reader("OWNER");
    await expect(
      evaluateHumanApproval(request({ actor: { kind } }), { reader: authority, clock }),
    ).resolves.toEqual(denied("HUMAN_APPROVAL_REQUIRED"));
    expect(authority.hasCurrentPermissions).not.toHaveBeenCalled();
  }
});

it("forbids self-approval of high-risk proposals but allows it below the threshold", async () => {
  const self = { kind: "HUMAN" as const, principalId: "user-owner" };
  const high = request({ proposal: { ...proposal, riskLevel: "HIGH" }, proposer: self });
  await expect(evaluateHumanApproval(high, { reader: reader(), clock })).resolves.toEqual(
    denied("SELF_APPROVAL_FORBIDDEN"),
  );
  const peer = { ...high, proposer: { kind: "HUMAN" as const, principalId: "user-admin" } };
  await expect(evaluateHumanApproval(peer, { reader: reader(), clock })).resolves.toMatchObject({
    allowed: true,
  });
  const medium = request({ proposer: self });
  await expect(evaluateHumanApproval(medium, { reader: reader(), clock })).resolves.toMatchObject({
    allowed: true,
  });
  const strict = { ...DEFAULT_HUMAN_APPROVAL_POLICY_V1, selfApprovalForbiddenFrom: "LOW" };
  await expect(evaluateHumanApproval(medium, { reader: reader(), clock }, strict)).resolves.toEqual(
    denied("SELF_APPROVAL_FORBIDDEN"),
  );
});

it("denies CRITICAL and expired proposals before reading any authority", async () => {
  const authority = reader("OWNER");
  const critical = request({ proposal: { ...proposal, riskLevel: "CRITICAL" } });
  await expect(evaluateHumanApproval(critical, { reader: authority, clock })).resolves.toEqual(
    denied("CRITICAL_APPROVAL_DISABLED"),
  );
  const expired = clockAt(proposal.expiresAt);
  await expect(
    evaluateHumanApproval(request(), { reader: authority, clock: expired }),
  ).resolves.toEqual(denied("PROPOSAL_EXPIRED"));
  expect(authority.isSessionRevoked).not.toHaveBeenCalled();
});

it("rejects malformed proposals, forged identities and unsafe policies", async () => {
  const authority = reader("OWNER");
  const forged = request({ actor: { kind: "HUMAN", identity: identity({ principalId: "" }) } });
  await expect(evaluateHumanApproval(forged, { reader: authority, clock })).resolves.toEqual(
    denied("INVALID_IDENTITY"),
  );
  const tampered = request({
    proposal: { ...proposal, approvedBy: "user-owner" } as ActionProposalV1,
  });
  await expect(evaluateHumanApproval(tampered, { reader: authority, clock })).resolves.toEqual(
    denied("INVALID_REQUEST"),
  );
  const tooLong = { ...DEFAULT_HUMAN_APPROVAL_POLICY_V1, recentAuthWindowMs: 10 * 60 * 1000 };
  await expect(
    evaluateHumanApproval(request(), { reader: authority, clock }, tooLong),
  ).resolves.toEqual({ allowed: false, code: "INVALID_POLICY", policyVersion: null });
  expect(authority.hasCurrentPermissions).not.toHaveBeenCalled();
});

it("supports a shorter recent-authentication window", async () => {
  const short = { ...DEFAULT_HUMAN_APPROVAL_POLICY_V1, recentAuthWindowMs: 60 * 1000 };
  await expect(
    evaluateHumanApproval(request(), { reader: reader(), clock }, short),
  ).resolves.toEqual(denied("REAUTH_REQUIRED"));
});
