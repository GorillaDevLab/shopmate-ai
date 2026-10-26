import { z } from "zod";
import { PROPOSAL_MAX_TTL_MS } from "../actions/proposal.schema.js";
import { ListingInputSchema } from "../commerce/connector-action.schema.js";
import {
  CommerceTextSchema,
  ConnectorTimestampSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
} from "../commerce/connector-common.schema.js";
import { TenantIdSchema } from "../tenant/tenant.schema.js";

export const LISTING_IMPORT_MAX_ROWS = 500;
export const LISTING_IMPORT_MAX_BYTES = 2_000_000;

const id = TenantIdSchema;
const timestamp = ConnectorTimestampSchema;
const revision = z.number().int().min(1).safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const label = CommerceTextSchema.pipe(z.string().max(200));

export const ListingScopeSchema = z
  .strictObject({
    organizationId: id,
    workspaceId: id,
    storeId: id,
    connectionId: id,
    generation: revision,
  })
  .readonly();

export const ListingCsvRowSchema = z
  .strictObject({
    title: label,
    description: CommerceTextSchema,
    category: label,
    brand: label.nullable(),
    sellerSkuCode: ExternalIdSchema,
    salePriceMinor: MinorAmountSchema,
    currency: CurrencySchema,
  })
  .readonly();

const csvSourceSchema = z
  .strictObject({
    importId: id,
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.csv$/u),
    fileSha256: hash,
    declaredByteLength: z.number().int().min(1).max(LISTING_IMPORT_MAX_BYTES),
    encoding: z.literal("UTF-8"),
    importedAt: timestamp,
  })
  .readonly();

function sameProduct(rows: readonly z.infer<typeof ListingCsvRowSchema>[]): boolean {
  const first = rows[0];
  if (!first) return false;
  return rows.every(
    (row) =>
      row.title === first.title &&
      row.description === first.description &&
      row.category === first.category &&
      row.brand === first.brand &&
      row.currency === first.currency,
  );
}

export const ListingImportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: ListingScopeSchema,
    source: csvSourceSchema,
    rowCount: z.number().int().min(1).max(LISTING_IMPORT_MAX_ROWS),
    rows: z.array(ListingCsvRowSchema).min(1).max(LISTING_IMPORT_MAX_ROWS).readonly(),
  })
  .superRefine((input, context) => {
    const codes = input.rows.map((row) => row.sellerSkuCode);
    if (codes.length !== new Set(codes).size) {
      context.addIssue({ code: "custom", message: "Duplicate sellerSkuCode" });
    }
    if (input.rowCount !== input.rows.length || !sameProduct(input.rows)) {
      context.addIssue({ code: "custom", message: "Invalid CSV row group" });
    }
  })
  .readonly();

const importProvenance = z
  .strictObject({
    kind: z.literal("CSV_IMPORT"),
    importId: id,
    fileSha256: hash,
  })
  .readonly();

const editProvenance = z
  .strictObject({
    kind: z.literal("HUMAN_EDIT"),
    parentRevision: revision,
    parentContentHash: hash,
  })
  .readonly();

export const ListingDraftSourceSchema = z
  .discriminatedUnion("kind", [importProvenance, editProvenance])
  .readonly();

export const ListingDraftV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    draftId: id,
    scope: ListingScopeSchema,
    revision,
    contentHash: hash,
    previousContentHash: hash.nullable(),
    source: ListingDraftSourceSchema,
    listing: ListingInputSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine((draft, context) => {
    const initial = draft.revision === 1;
    const validAncestry = initial
      ? draft.previousContentHash === null && draft.source.kind === "CSV_IMPORT"
      : draft.previousContentHash !== null && draft.source.kind === "HUMAN_EDIT";
    if (!validAncestry) {
      context.addIssue({ code: "custom", message: "Invalid revision ancestry" });
    }
    if (
      draft.source.kind === "HUMAN_EDIT" &&
      (draft.source.parentRevision !== draft.revision - 1 ||
        draft.source.parentContentHash !== draft.previousContentHash ||
        draft.contentHash === draft.previousContentHash)
    ) {
      context.addIssue({ code: "custom", message: "Invalid edit provenance" });
    }
    if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) {
      context.addIssue({ code: "custom", message: "Invalid draft timestamps" });
    }
  })
  .readonly();

export const ListingValidationErrorSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z][A-Za-z0-9]*(?:\[[0-9]{1,3}\]|\.[A-Za-z][A-Za-z0-9]*)*$/u),
    code: z.enum([
      "REQUIRED",
      "INVALID_FORMAT",
      "DUPLICATE_SELLER_SKU",
      "INVALID_PRICE",
      "INVALID_CURRENCY",
      "UNSAFE_CONTENT",
      "UNSUPPORTED_CATEGORY",
      "SOURCE_UNVERIFIED",
    ]),
  })
  .readonly();

export const ListingValidationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    draftId: id,
    scope: ListingScopeSchema,
    revision,
    contentHash: hash,
    evaluatedAt: timestamp,
    status: z.enum(["PASSED", "FAILED"]),
    errors: z.array(ListingValidationErrorSchema).max(100).readonly(),
  })
  .refine(
    (value) => (value.status === "PASSED" ? value.errors.length === 0 : value.errors.length > 0),
    { message: "Validation status and errors disagree" },
  )
  .readonly();

export const ListingPublishSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    draftId: id,
    draftRevision: revision,
    draftHash: hash,
    snapshotHash: hash,
    scope: ListingScopeSchema,
    listing: ListingInputSchema,
    capturedAt: timestamp,
    expiresAt: timestamp,
  })
  .refine(
    (value) => {
      const ttl = Date.parse(value.expiresAt) - Date.parse(value.capturedAt);
      return ttl > 0 && ttl <= PROPOSAL_MAX_TTL_MS;
    },
    { message: "Invalid publication snapshot TTL" },
  )
  .readonly();

export const ListingPublishRequestSchema = z
  .strictObject({
    draftId: id,
    expectedRevision: revision,
    expectedDraftHash: hash,
  })
  .readonly();

function scopesMatch(
  a: z.infer<typeof ListingScopeSchema>,
  b: z.infer<typeof ListingScopeSchema>,
): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.workspaceId === b.workspaceId &&
    a.storeId === b.storeId &&
    a.connectionId === b.connectionId &&
    a.generation === b.generation
  );
}

export const ListingPublishProposalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    proposalId: id,
    approvalState: z.literal("PENDING_HUMAN_APPROVAL"),
    snapshot: ListingPublishSnapshotSchema,
    validation: ListingValidationV1Schema,
    requestedAt: timestamp,
  })
  .refine(
    (proposal) => {
      const { snapshot, validation } = proposal;
      return (
        validation.status === "PASSED" &&
        snapshot.draftId === validation.draftId &&
        snapshot.draftRevision === validation.revision &&
        snapshot.draftHash === validation.contentHash &&
        scopesMatch(snapshot.scope, validation.scope) &&
        Date.parse(validation.evaluatedAt) <= Date.parse(snapshot.capturedAt) &&
        Date.parse(proposal.requestedAt) >= Date.parse(snapshot.capturedAt) &&
        Date.parse(proposal.requestedAt) < Date.parse(snapshot.expiresAt)
      );
    },
    { message: "Publication requires matching passed validation" },
  )
  .readonly();

const publishedRefFields = {
  executionId: id,
  proposalId: id,
  scope: ListingScopeSchema,
};

export const PublishedProductRefSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      ...publishedRefFields,
      status: z.literal("UNRESOLVED"),
      externalProductId: z.null(),
    }),
    z.strictObject({
      ...publishedRefFields,
      status: z.literal("VERIFIED"),
      externalProductId: ExternalIdSchema,
      verificationId: id,
      verifiedAt: timestamp,
      source: z.literal("MOCK_READBACK"),
    }),
  ])
  .readonly();

export type ListingImportV1 = z.infer<typeof ListingImportV1Schema>;
export type ListingDraftV1 = z.infer<typeof ListingDraftV1Schema>;
export type ListingValidationV1 = z.infer<typeof ListingValidationV1Schema>;
export type ListingPublishSnapshot = z.infer<typeof ListingPublishSnapshotSchema>;
export type ListingPublishProposal = z.infer<typeof ListingPublishProposalSchema>;
export type PublishedProductRef = z.infer<typeof PublishedProductRefSchema>;

/**
 * Only a trusted internal Mock execution/readback adapter may return
 * a VERIFIED external product reference. Never fabricate an identifier.
 */
export interface PublishedRefResolver {
  resolve(
    executionId: string,
    proposalId: string,
    scope: z.infer<typeof ListingScopeSchema>,
  ): Promise<PublishedProductRef>;
}
