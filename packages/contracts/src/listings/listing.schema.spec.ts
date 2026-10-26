import { describe, expect, it } from "vitest";
import {
  LISTING_IMPORT_MAX_BYTES,
  LISTING_IMPORT_MAX_ROWS,
  ListingDraftV1Schema,
  ListingImportV1Schema,
  ListingPublishProposalSchema,
  ListingPublishRequestSchema,
  ListingPublishSnapshotSchema,
  ListingValidationV1Schema,
  PublishedProductRefSchema,
} from "./listing.schema.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const time = "2026-10-26T12:00:00Z";

const scope = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  generation: 1,
};

const firstRow = {
  title: "Synthetic Product",
  description: "Synthetic product description",
  category: "Home",
  brand: "Test Brand",
  sellerSkuCode: "SKU-001",
  salePriceMinor: 5900,
  currency: "CNY",
};

function importFixture() {
  return {
    schemaVersion: 1,
    scope,
    source: {
      importId: "import-a",
      fileName: "catalog.csv",
      fileSha256: hashA,
      declaredByteLength: 300,
      encoding: "UTF-8",
      importedAt: time,
    },
    rowCount: 2,
    rows: [firstRow, { ...firstRow, sellerSkuCode: "SKU-002", salePriceMinor: 6200 }],
  };
}

function listing() {
  return {
    title: firstRow.title,
    description: firstRow.description,
    category: firstRow.category,
    brand: firstRow.brand,
    skus: [
      {
        sellerSkuCode: "SKU-001",
        attributes: [],
        salePriceMinor: 5900,
        currency: "CNY",
      },
      {
        sellerSkuCode: "SKU-002",
        attributes: [],
        salePriceMinor: 6200,
        currency: "CNY",
      },
    ],
  };
}

function draftFixture() {
  return {
    schemaVersion: 1,
    draftId: "draft-a",
    scope,
    revision: 1,
    contentHash: hashB,
    previousContentHash: null,
    source: {
      kind: "CSV_IMPORT",
      importId: "import-a",
      fileSha256: hashA,
    },
    listing: listing(),
    createdAt: time,
    updatedAt: "2026-10-26T12:01:00Z",
  };
}

function validationFixture() {
  return {
    schemaVersion: 1,
    draftId: "draft-a",
    scope,
    revision: 1,
    contentHash: hashB,
    evaluatedAt: "2026-10-26T12:02:00Z",
    status: "PASSED",
    errors: [],
  };
}

function snapshotFixture() {
  return {
    schemaVersion: 1,
    draftId: "draft-a",
    draftRevision: 1,
    draftHash: hashB,
    snapshotHash: hashC,
    scope,
    listing: listing(),
    capturedAt: "2026-10-26T12:03:00Z",
    expiresAt: "2026-10-26T12:13:00Z",
  };
}

function proposalFixture() {
  return {
    schemaVersion: 1,
    proposalId: "proposal-a",
    approvalState: "PENDING_HUMAN_APPROVAL",
    snapshot: snapshotFixture(),
    validation: validationFixture(),
    requestedAt: "2026-10-26T12:04:00Z",
  };
}

describe("P12-001 listing contracts", () => {
  it("accepts a bounded normalized UTF-8 CSV import", () => {
    const result = ListingImportV1Schema.parse(importFixture());
    expect(result.rowCount).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(LISTING_IMPORT_MAX_ROWS).toBe(500);
    expect(LISTING_IMPORT_MAX_BYTES).toBe(2_000_000);
  });

  it.each([
    { rowCount: 0 },
    { rowCount: 3 },
    { rows: [] },
    { rows: [firstRow, firstRow] },
    { rows: [{ ...firstRow, currency: "USD" }] },
    { rows: [{ ...firstRow, salePriceMinor: -1 }] },
    { rows: [{ ...firstRow, title: "Another product" }] },
  ])("rejects invalid CSV row input %o", (change) => {
    expect(
      ListingImportV1Schema.safeParse({
        ...importFixture(),
        ...change,
      }).success,
    ).toBe(false);
  });

  it.each([
    { encoding: "GBK" },
    { fileName: "../private.csv" },
    { fileName: "products.xlsx" },
    { declaredByteLength: 0 },
    { declaredByteLength: 2_000_001 },
    { fileSha256: "invalid-hash" },
  ])("rejects invalid CSV source %o", (change) => {
    const input = importFixture();
    expect(
      ListingImportV1Schema.safeParse({
        ...input,
        source: { ...input.source, ...change },
      }).success,
    ).toBe(false);
  });

  it("rejects unauthorized import fields and oversized row lists", () => {
    const input = importFixture();
    for (const field of ["approvedBy", "permissions", "token", "execute"]) {
      expect(
        ListingImportV1Schema.safeParse({
          ...input,
          [field]: "forged",
        }).success,
      ).toBe(false);
    }

    expect(
      ListingImportV1Schema.safeParse({
        ...input,
        rowCount: 501,
        rows: Array.from({ length: 501 }, (_, i) => ({
          ...firstRow,
          sellerSkuCode: `SKU-${i}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("accepts a strict first-revision draft with source provenance", () => {
    const result = ListingDraftV1Schema.parse(draftFixture());
    expect(result.revision).toBe(1);
    expect(result.listing.skus).toHaveLength(2);
    expect(result.scope.storeId).toBe("store-a");
  });

  it("binds human edits to the exact previous revision and hash", () => {
    const edited = {
      ...draftFixture(),
      revision: 2,
      previousContentHash: hashB,
      contentHash: hashC,
      source: {
        kind: "HUMAN_EDIT",
        parentRevision: 1,
        parentContentHash: hashB,
      },
    };
    expect(ListingDraftV1Schema.safeParse(edited).success).toBe(true);

    for (const patch of [
      { revision: 3 },
      { previousContentHash: hashA },
      { contentHash: hashB },
      { source: { ...edited.source, parentRevision: 2 } },
    ]) {
      expect(
        ListingDraftV1Schema.safeParse({
          ...edited,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects missing scope, currency and duplicate seller SKUs", () => {
    const draft = draftFixture();
    for (const patch of [
      { scope: { organizationId: "org-a" } },
      { scope: { ...scope, generation: 0 } },
      { listing: { ...listing(), skus: [listing().skus[0], listing().skus[0]] } },
      { listing: { ...listing(), skus: [{ ...listing().skus[0], currency: "USD" }] } },
    ]) {
      expect(
        ListingDraftV1Schema.safeParse({
          ...draft,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects untrusted draft approval and execution overrides", () => {
    const draft = draftFixture();
    for (const field of [
      "approvedBy",
      "permissions",
      "executionId",
      "externalProductId",
      "tenantId",
      "rawPrompt",
    ]) {
      expect(
        ListingDraftV1Schema.safeParse({
          ...draft,
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    }
  });

  it("records bounded structured validation field paths", () => {
    const failed = {
      ...validationFixture(),
      status: "FAILED",
      errors: [
        {
          path: "skus[0].sellerSkuCode",
          code: "DUPLICATE_SELLER_SKU",
        },
      ],
    };

    expect(ListingValidationV1Schema.safeParse(failed).success).toBe(true);
    expect(
      ListingValidationV1Schema.safeParse({
        ...failed,
        errors: [{ path: "../private", code: "UNSAFE_CONTENT" }],
      }).success,
    ).toBe(false);
    expect(
      ListingValidationV1Schema.safeParse({
        ...failed,
        errors: [{ path: "title", code: "UNKNOWN_CODE" }],
      }).success,
    ).toBe(false);
  });

  it("requires validation status and errors to agree", () => {
    expect(ListingValidationV1Schema.safeParse(validationFixture()).success).toBe(true);

    for (const change of [
      { status: "FAILED", errors: [] },
      { status: "PASSED", errors: [{ path: "title", code: "REQUIRED" }] },
    ]) {
      expect(
        ListingValidationV1Schema.safeParse({
          ...validationFixture(),
          ...change,
        }).success,
      ).toBe(false);
    }
  });

  it("requires full product content and a bounded snapshot TTL", () => {
    expect(ListingPublishSnapshotSchema.safeParse(snapshotFixture()).success).toBe(true);

    for (const patch of [
      { draftHash: "" },
      { snapshotHash: "" },
      { expiresAt: "2026-10-26T12:03:00Z" },
      { expiresAt: "2026-10-26T13:00:00Z" },
      { listing: { title: "Incomplete" } },
      { scope: { ...scope, storeId: null } },
    ]) {
      expect(
        ListingPublishSnapshotSchema.safeParse({
          ...snapshotFixture(),
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("allows only matching passed validation into approval proposal", () => {
    expect(ListingPublishProposalSchema.safeParse(proposalFixture()).success).toBe(true);

    for (const change of [
      { draftId: "other-draft" },
      { revision: 2 },
      { contentHash: hashA },
      { scope: { ...scope, storeId: "other-store" } },
    ]) {
      const proposal = proposalFixture();
      expect(
        ListingPublishProposalSchema.safeParse({
          ...proposal,
          validation: { ...proposal.validation, ...change },
        }).success,
      ).toBe(false);
    }
  });

  it("prevents validation failures from becoming approvable proposals", () => {
    const proposal = proposalFixture();
    expect(
      ListingPublishProposalSchema.safeParse({
        ...proposal,
        validation: {
          ...proposal.validation,
          status: "FAILED",
          errors: [{ path: "title", code: "REQUIRED" }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects expired snapshots, untrusted approval and execution fields", () => {
    const proposal = proposalFixture();

    expect(
      ListingPublishProposalSchema.safeParse({
        ...proposal,
        requestedAt: proposal.snapshot.expiresAt,
      }).success,
    ).toBe(false);

    for (const field of [
      "approvedBy",
      "approvalId",
      "permissions",
      "execute",
      "externalProductId",
    ]) {
      expect(
        ListingPublishProposalSchema.safeParse({
          ...proposal,
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    }
  });

  it("uses a minimal client publication request without identity fields", () => {
    const request = {
      draftId: "draft-a",
      expectedRevision: 1,
      expectedDraftHash: hashB,
    };
    expect(ListingPublishRequestSchema.safeParse(request).success).toBe(true);
    expect(
      ListingPublishRequestSchema.safeParse({
        ...request,
        approvedBy: "human-a",
      }).success,
    ).toBe(false);
    expect(
      ListingPublishRequestSchema.safeParse({
        ...request,
        expectedDraftHash: "invalid",
      }).success,
    ).toBe(false);
  });

  it("preserves unresolved external product IDs as null", () => {
    const unresolved = {
      executionId: "execution-a",
      proposalId: "proposal-a",
      scope,
      status: "UNRESOLVED",
      externalProductId: null,
    };
    expect(PublishedProductRefSchema.safeParse(unresolved).success).toBe(true);
    expect(
      PublishedProductRefSchema.safeParse({
        ...unresolved,
        externalProductId: "fabricated-id",
      }).success,
    ).toBe(false);
  });

  it("requires verified Mock readback evidence for resolved IDs", () => {
    const resolved = {
      executionId: "execution-a",
      proposalId: "proposal-a",
      scope,
      status: "VERIFIED",
      externalProductId: "external-product-a",
      verificationId: "verification-a",
      verifiedAt: time,
      source: "MOCK_READBACK",
    };
    expect(PublishedProductRefSchema.safeParse(resolved).success).toBe(true);

    for (const change of [
      { externalProductId: null },
      { verificationId: null },
      { source: "CLIENT" },
      { verifiedAt: null },
    ]) {
      expect(
        PublishedProductRefSchema.safeParse({
          ...resolved,
          ...change,
        }).success,
      ).toBe(false);
    }
  });
});
