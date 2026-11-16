import type { ApprovalBindingV1, SecurityClock } from "@shopmate/contracts";
import { expect, it } from "vitest";
import {
  PROPOSAL_TRANSITIONS_V1,
  transitionProposal,
  type ProposalStateV1,
  type ProposalTransitionResult,
} from "./proposal-transition.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const expiresAt = "2026-11-16T01:15:00.000Z";
const clockAt = (now: string): SecurityClock => ({ timeDomain: "SECURITY_UTC", now: () => now });
const clock = clockAt("2026-11-16T01:05:00.000Z");

const draft: ProposalStateV1 = {
  schemaVersion: 1,
  proposalId: "proposal-1",
  status: "DRAFT",
  revision: 1,
  payloadHash: hashA,
  expiresAt,
  approval: null,
};
const pending: ProposalStateV1 = { ...draft, status: "PENDING_APPROVAL" };

function binding(overrides: Partial<ApprovalBindingV1> = {}): ApprovalBindingV1 {
  return {
    schemaVersion: 1,
    approvalId: "approval-1",
    proposalId: "proposal-1",
    revision: 1,
    payloadHash: hashA,
    scope: {
      organizationId: "org-a",
      workspaceId: "workspace-a",
      storeId: "store-a",
      connectionId: "connection-a",
      generation: 1,
    },
    riskLevel: "MEDIUM",
    approvedPrincipalId: "user-a",
    sessionId: "session-a",
    reauthProofId: "proof-a",
    reauthenticatedAt: "2026-11-16T01:03:00.000Z",
    approvedAt: "2026-11-16T01:04:00.000Z",
    expiresAt,
    ...overrides,
  };
}

function stateOf(result: ProposalTransitionResult): ProposalStateV1 {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.state;
}

function approved(): ProposalStateV1 {
  const command = { kind: "APPROVE", expectedRevision: 1, approval: binding() };
  return stateOf(transitionProposal(pending, command, clock));
}

const revision2 = {
  revision: 2,
  payloadHash: hashB,
  previousPayloadHash: hashA,
  expiresAt: "2026-11-16T01:20:00.000Z",
};

it("walks DRAFT → PROPOSED → PENDING_APPROVAL and allows a human rejection", () => {
  const proposed = stateOf(
    transitionProposal(draft, { kind: "SUBMIT", expectedRevision: 1 }, clock),
  );
  expect(proposed.status).toBe("PROPOSED");
  const waiting = stateOf(
    transitionProposal(proposed, { kind: "REQUEST_APPROVAL", expectedRevision: 1 }, clock),
  );
  expect(waiting.status).toBe("PENDING_APPROVAL");
  const rejected = stateOf(
    transitionProposal(waiting, { kind: "REJECT", expectedRevision: 1 }, clock),
  );
  expect(rejected).toEqual({ ...draft, status: "REJECTED" });
  expect(draft.status).toBe("DRAFT");
  expect(Object.isFrozen(rejected)).toBe(true);
});

it("binds an approval to the exact revision and payload hash", () => {
  const state = approved();
  expect(state.status).toBe("APPROVED");
  expect(state.approval).toEqual({ approvalId: "approval-1", revision: 1, payloadHash: hashA });
});

it("sends an edited APPROVED proposal back to approval and drops the old approval", () => {
  const revised = stateOf(
    transitionProposal(
      approved(),
      { kind: "REVISE", expectedRevision: 1, revision: revision2 },
      clock,
    ),
  );
  expect(revised).toMatchObject({ status: "PENDING_APPROVAL", revision: 2, payloadHash: hashB });
  expect(revised.approval).toBeNull();
  const reuse = { kind: "APPROVE", expectedRevision: 2, approval: binding() };
  expect(transitionProposal(revised, reuse, clock)).toEqual({
    ok: false,
    code: "APPROVAL_MISMATCH",
  });
  const stale = { kind: "APPROVE", expectedRevision: 1, approval: binding() };
  expect(transitionProposal(revised, stale, clock)).toEqual({
    ok: false,
    code: "REVISION_CONFLICT",
  });
});

it("keeps the lifecycle stage when an unapproved proposal is revised", () => {
  for (const status of ["DRAFT", "PROPOSED", "PENDING_APPROVAL"] as const) {
    const command = { kind: "REVISE", expectedRevision: 1, revision: revision2 };
    const revised = stateOf(transitionProposal({ ...draft, status }, command, clock));
    expect(revised).toMatchObject({ status, revision: 2, payloadHash: hashB, approval: null });
  }
});

it("rejects skipped stages, terminal states and execution without changing state", () => {
  const cases: [ProposalStateV1, object][] = [
    [draft, { kind: "APPROVE", expectedRevision: 1, approval: binding() }],
    [
      { ...draft, status: "PROPOSED" },
      { kind: "REJECT", expectedRevision: 1 },
    ],
    [
      { ...draft, status: "REJECTED" },
      { kind: "REVISE", expectedRevision: 1, revision: revision2 },
    ],
    [
      { ...draft, status: "EXPIRED" },
      { kind: "SUBMIT", expectedRevision: 1 },
    ],
    [approved(), { kind: "APPROVE", expectedRevision: 1, approval: binding() }],
  ];
  for (const [state, command] of cases) {
    expect(transitionProposal(state, command, clock)).toEqual({
      ok: false,
      code: "ILLEGAL_TRANSITION",
    });
  }
  const execute = { kind: "EXECUTE", expectedRevision: 1 };
  expect(transitionProposal(approved(), execute, clock)).toEqual({
    ok: false,
    code: "INVALID_COMMAND",
  });
  const executing = { ...draft, status: "EXECUTING" };
  const submit = { kind: "SUBMIT", expectedRevision: 1 };
  expect(transitionProposal(executing, submit, clock)).toEqual({
    ok: false,
    code: "INVALID_STATE",
  });
});

it("refuses commands for an old revision", () => {
  const state = { ...pending, revision: 2, payloadHash: hashB };
  const command = { kind: "REJECT", expectedRevision: 1 };
  expect(transitionProposal(state, command, clock)).toEqual({
    ok: false,
    code: "REVISION_CONFLICT",
  });
});

it("refuses approvals that belong to another proposal, payload or expiry", () => {
  const mismatches = [
    binding({ proposalId: "proposal-2" }),
    binding({ payloadHash: hashB }),
    binding({ expiresAt: "2026-11-16T01:14:00.000Z" }),
    binding({
      approvedAt: "2026-11-16T01:06:00.000Z",
      reauthenticatedAt: "2026-11-16T01:05:30.000Z",
    }),
  ];
  for (const approval of mismatches) {
    const command = { kind: "APPROVE", expectedRevision: 1, approval };
    expect(transitionProposal(pending, command, clock)).toEqual({
      ok: false,
      code: "APPROVAL_MISMATCH",
    });
  }
  const invalid = {
    kind: "APPROVE",
    expectedRevision: 1,
    approval: binding({ riskLevel: "CRITICAL" as "HIGH" }),
  };
  expect(transitionProposal(pending, invalid, clock)).toEqual({
    ok: false,
    code: "INVALID_COMMAND",
  });
});

const atExpiry = clockAt(expiresAt);

it("refuses an approval at or after expiry and leaves the proposal pending", () => {
  const command = { kind: "APPROVE", expectedRevision: 1, approval: binding() };
  expect(transitionProposal(pending, command, atExpiry)).toEqual({
    ok: false,
    code: "PROPOSAL_EXPIRED",
  });
  expect(pending.status).toBe("PENDING_APPROVAL");
});

it("expires only once the security clock reaches expiresAt and drops any approval", () => {
  const expire = { kind: "EXPIRE", expectedRevision: 1 };
  expect(transitionProposal(pending, expire, clock)).toEqual({ ok: false, code: "NOT_EXPIRED" });
  const expired = stateOf(transitionProposal(approved(), expire, atExpiry));
  expect(expired).toMatchObject({ status: "EXPIRED", approval: null });
  expect(transitionProposal(expired, expire, atExpiry)).toEqual({
    ok: false,
    code: "ILLEGAL_TRANSITION",
  });
});

it("does not trust any clock other than a valid SECURITY_UTC clock", () => {
  const businessClock = {
    timeDomain: "BUSINESS",
    now: () => expiresAt,
  } as unknown as SecurityClock;
  const broken: SecurityClock = {
    timeDomain: "SECURITY_UTC",
    now: () => {
      throw new Error("clock offline");
    },
  };
  const submit = { kind: "SUBMIT", expectedRevision: 1 };
  for (const candidate of [businessClock, clockAt("not-a-time"), broken]) {
    expect(transitionProposal(draft, submit, candidate)).toEqual({
      ok: false,
      code: "CLOCK_UNAVAILABLE",
    });
  }
});

it("accepts only the next revision chained to the current payload with a future expiry", () => {
  const invalid = [
    { ...revision2, revision: 3 },
    { ...revision2, previousPayloadHash: hashB },
    { ...revision2, payloadHash: hashA },
    { ...revision2, expiresAt: "2026-11-16T01:05:00.000Z" },
  ];
  for (const revision of invalid) {
    const command = { kind: "REVISE", expectedRevision: 1, revision };
    expect(transitionProposal(pending, command, clock)).toEqual({
      ok: false,
      code: "INVALID_REVISION",
    });
  }
});

it("rejects malformed states, including an approval on a non-approved proposal", () => {
  const submit = { kind: "SUBMIT", expectedRevision: 1 };
  const approval = { approvalId: "approval-1", revision: 1, payloadHash: hashA };
  for (const state of [{ ...draft, approval }, { ...draft, extra: true }, null]) {
    expect(transitionProposal(state, submit, clock)).toEqual({
      ok: false,
      code: "INVALID_STATE",
    });
  }
});

it("publishes a transition table that never reaches execution", () => {
  const targets = Object.values(PROPOSAL_TRANSITIONS_V1).flatMap((row) => Object.values(row));
  expect(new Set(targets)).toEqual(
    new Set(["DRAFT", "PROPOSED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "EXPIRED"]),
  );
});
