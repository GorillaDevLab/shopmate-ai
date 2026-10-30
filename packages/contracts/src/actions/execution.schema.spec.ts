import { describe, expect, it } from "vitest";
import {
  ActionExecutionV1Schema,
  ExecutionLeaseV1Schema,
  ExecutionVerificationV1Schema,
  executionMayDispatch,
} from "./execution.schema.js";

const hashA = "a".repeat(64);

const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  generation: 1,
};

function approvalFixture() {
  return {
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
    reauthenticatedAt: "2026-10-26T12:00:00Z",
    approvedAt: "2026-10-26T12:01:00Z",
    expiresAt: "2026-10-26T12:10:00Z",
  };
}

function executionFixture() {
  return {
    schemaVersion: 1,
    executionId: "execution-a",
    idempotencyKey: "tenant-a-action-a",
    scope,
    externalStoreId: "external-store-a",
    proposalId: "proposal-a",
    proposalRevision: 1,
    proposalHash: hashA,
    approval: approvalFixture(),
    command: {
      executionId: "execution-a",
      idempotencyKey: "tenant-a-action-a",
      externalSkuId: "sku-a",
      expectedVersion: "product-version-a",
      oldPriceMinor: 5900,
      newPriceMinor: 6200,
      currency: "CNY",
    },
    lease: {
      leaseId: "lease-a",
      fencingToken: 1,
      ownerId: "worker-a",
      acquiredAt: "2026-10-26T12:02:00Z",
      leaseUntil: "2026-10-26T12:04:00Z",
    },
    attempt: 1,
    reservedAt: "2026-10-26T12:02:00Z",
    deadlineAt: "2026-10-26T12:08:00Z",
    writeRetryPolicy: "NO_AUTOMATIC_WRITE_RETRY",
    state: "RESERVED",
    proposalState: "EXECUTING",
    receipt: null,
    verification: null,
  };
}

function acceptedReceipt() {
  return {
    executionId: "execution-a",
    platformRequestId: "platform-request-a",
    receivedAt: "2026-10-26T12:03:00Z",
    outcome: "ACCEPTED",
    failureCode: null,
  };
}

function unknownReceipt() {
  return {
    ...acceptedReceipt(),
    outcome: "UNKNOWN",
    failureCode: "TIMEOUT",
    platformRequestId: null,
  };
}

function verificationFixture(status = "VERIFIED") {
  const actualPriceMinor = status === "MISMATCH" ? 6100 : 6200;
  const result =
    status === "PENDING"
      ? {
          executionId: "execution-a",
          status: "PENDING",
          retryAfterMs: 1000,
        }
      : status === "UNKNOWN"
        ? {
            executionId: "execution-a",
            status: "UNAVAILABLE",
            reason: "TEMPORARY",
          }
        : {
            executionId: "execution-a",
            status,
            snapshot: {
              kind: "PRICE",
              externalStoreId: "external-store-a",
              version: "product-version-b",
              observedAt: "2026-10-26T12:04:00Z",
              externalSkuId: "sku-a",
              expectedPriceMinor: 6200,
              actualPriceMinor,
              currency: "CNY",
            },
          };

  return {
    executionId: "execution-a",
    checkedAt: "2026-10-26T12:05:00Z",
    status,
    query: {
      executionId: "execution-a",
      expected: {
        kind: "PRICE",
        externalSkuId: "sku-a",
        priceMinor: 6200,
        currency: "CNY",
      },
    },
    result,
  };
}

function withReceipt(outcome = "ACCEPTED") {
  return {
    ...executionFixture(),
    receipt: outcome === "UNKNOWN" ? unknownReceipt() : acceptedReceipt(),
    state: outcome === "UNKNOWN" ? "UNKNOWN" : "VERIFYING",
  };
}

function withVerification(status = "VERIFIED", outcome = "ACCEPTED") {
  return {
    ...withReceipt(outcome),
    verification: verificationFixture(status),
    state:
      status === "VERIFIED"
        ? "SUCCEEDED"
        : status === "MISMATCH"
          ? "FAILED"
          : status === "UNKNOWN" || outcome === "UNKNOWN"
            ? "UNKNOWN"
            : "VERIFYING",
    proposalState:
      status === "VERIFIED" ? "SUCCEEDED" : status === "MISMATCH" ? "FAILED" : "EXECUTING",
  };
}

describe("P08-001 execution and verification contracts", () => {
  it("accepts a reserved execution with approval and lease", () => {
    const execution = ActionExecutionV1Schema.parse(executionFixture());
    expect(Object.isFrozen(execution)).toBe(true);
    expect(execution.state).toBe("RESERVED");
    expect(execution.proposalState).toBe("EXECUTING");
  });

  it("never treats ACCEPTED as execution success", () => {
    expect(ActionExecutionV1Schema.safeParse(withReceipt()).success).toBe(true);
    expect(
      ActionExecutionV1Schema.safeParse({
        ...withReceipt(),
        state: "SUCCEEDED",
        proposalState: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it("preserves UNKNOWN without blind retry or premature completion", () => {
    expect(ActionExecutionV1Schema.safeParse(withReceipt("UNKNOWN")).success).toBe(true);

    for (const patch of [
      { state: "SUCCEEDED", proposalState: "SUCCEEDED" },
      { writeRetryPolicy: "RETRY_ON_TIMEOUT" },
      { retryAutomatically: true },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...withReceipt("UNKNOWN"),
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("only confirms success from an independently VERIFIED readback", () => {
    expect(ActionExecutionV1Schema.safeParse(withVerification("VERIFIED")).success).toBe(true);
    expect(ActionExecutionV1Schema.safeParse(withVerification("VERIFIED", "UNKNOWN")).success).toBe(
      true,
    );

    expect(
      ActionExecutionV1Schema.safeParse({
        ...withVerification("VERIFIED"),
        verification: null,
      }).success,
    ).toBe(false);
  });

  it.each(["PENDING", "UNKNOWN"])("retains EXECUTING proposal while readback is %s", (status) => {
    const execution = withVerification(status);
    expect(ActionExecutionV1Schema.safeParse(execution).success).toBe(true);
    expect(execution.proposalState).toBe("EXECUTING");
    expect(
      ActionExecutionV1Schema.safeParse({
        ...execution,
        proposalState: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it("records readback MISMATCH as failed, not succeeded", () => {
    expect(ActionExecutionV1Schema.safeParse(withVerification("MISMATCH")).success).toBe(true);

    expect(
      ActionExecutionV1Schema.safeParse({
        ...withVerification("MISMATCH"),
        state: "SUCCEEDED",
        proposalState: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it("allows an explicit rejected write only as FAILED", () => {
    const rejected = {
      ...withReceipt(),
      receipt: {
        ...acceptedReceipt(),
        outcome: "REJECTED",
        failureCode: "CONFLICT",
      },
      state: "FAILED",
      proposalState: "FAILED",
    };
    expect(ActionExecutionV1Schema.safeParse(rejected).success).toBe(true);
    expect(
      ActionExecutionV1Schema.safeParse({
        ...rejected,
        state: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it("rejects missing approval, scope, and stale revision binding", () => {
    const base = executionFixture();
    for (const patch of [
      { approval: null },
      { scope: { organizationId: "org-a" } },
      { scope: { ...scope, storeId: "store-b" } },
      { scope: { ...scope, generation: 2 } },
      { proposalRevision: 2 },
      { proposalHash: "b".repeat(64) },
      { proposalId: "proposal-b" },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects wrong command execution and idempotency correlation", () => {
    const base = executionFixture();
    for (const patch of [
      { executionId: "execution-b" },
      { idempotencyKey: "another-key" },
      { externalSkuId: "" },
      { expectedVersion: "" },
      { currency: "USD" },
      { oldPriceMinor: 0 },
      { newPriceMinor: -1 },
      { newPriceMinor: Number.MAX_SAFE_INTEGER + 1 },
      { newPriceMinor: 5900 },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          command: { ...base.command, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects relative inventory writes and unapproved commands", () => {
    const base = executionFixture();
    const relativeInventory = {
      executionId: "execution-a",
      idempotencyKey: "tenant-a-action-a",
      externalSkuId: "sku-a",
      deltaAvailable: 5,
      expectedVersion: "version-a",
    };
    expect(
      ActionExecutionV1Schema.safeParse({
        ...base,
        command: relativeInventory,
      }).success,
    ).toBe(false);
    expect(
      ActionExecutionV1Schema.safeParse({
        ...base,
        command: { ...base.command, kind: "INVENTORY_INCREMENT" },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid lease, fencing token, attempt, and deadline", () => {
    const base = executionFixture();
    for (const patch of [
      { lease: { ...base.lease, fencingToken: 0 } },
      { lease: { ...base.lease, leaseUntil: base.lease.acquiredAt } },
      { lease: { ...base.lease, leaseUntil: "2026-10-26T12:09:00Z" } },
      { attempt: 0 },
      { attempt: 2 ** 53 },
      { deadlineAt: base.reservedAt },
      { deadlineAt: "2026-10-26T12:11:00Z" },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          ...patch,
        }).success,
      ).toBe(false);
    }
    expect(ExecutionLeaseV1Schema.safeParse(base.lease).success).toBe(true);
  });

  it("uses trusted real time to block expired dispatch", () => {
    const base = executionFixture();
    expect(executionMayDispatch(base, "2026-10-26T12:03:00Z")).toBe(true);

    for (const time of [
      "2026-10-26T12:01:00Z",
      "2026-10-26T12:04:00Z",
      "2026-10-26T12:08:00Z",
      "not-a-timestamp",
    ]) {
      expect(executionMayDispatch(base, time)).toBe(false);
    }
    expect(executionMayDispatch(withReceipt(), "2026-10-26T12:03:00Z")).toBe(false);
  });

  it("rejects wrong receipt execution identity and chronology", () => {
    const base = withReceipt();
    for (const patch of [{ executionId: "execution-b" }, { receivedAt: "2026-10-26T12:00:00Z" }]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          receipt: { ...acceptedReceipt(), ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("requires readback identity, status, and command correlation", () => {
    const base = withVerification();
    for (const patch of [
      { executionId: "execution-b" },
      { status: "PENDING" },
      {
        query: {
          ...base.verification.query,
          executionId: "execution-b",
        },
      },
      {
        query: {
          ...base.verification.query,
          expected: {
            ...base.verification.query.expected,
            priceMinor: 7000,
          },
        },
      },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          verification: { ...base.verification, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects wrong external store and stale readback snapshots", () => {
    const base = withVerification();
    const result = base.verification.result;
    if (!("snapshot" in result)) throw new Error("Invalid test fixture");

    for (const patch of [
      { externalStoreId: "other-store" },
      { observedAt: "2026-10-26T12:00:00Z" },
      { observedAt: "2026-10-26T12:06:00Z" },
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          verification: {
            ...base.verification,
            result: {
              ...result,
              snapshot: { ...result.snapshot, ...patch },
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it("maps unavailable readback into UNKNOWN, never VERIFIED", () => {
    const verification = verificationFixture("UNKNOWN");
    expect(ExecutionVerificationV1Schema.safeParse(verification).success).toBe(true);
    expect(
      ExecutionVerificationV1Schema.safeParse({
        ...verification,
        status: "VERIFIED",
      }).success,
    ).toBe(false);
  });

  it("rejects forged authorization, automatic retry and unsafe fields", () => {
    const base = executionFixture();
    for (const field of [
      "approvedBy",
      "permissionOverride",
      "autoApprove",
      "retryAutomatically",
      "accessToken",
      "rawPrompt",
    ]) {
      expect(
        ActionExecutionV1Schema.safeParse({
          ...base,
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    }
  });
});
