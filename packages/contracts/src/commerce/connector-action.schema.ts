import { z } from "zod";
import { TenantIdSchema } from "../tenant/tenant.schema.js";
import {
  CommerceTextSchema,
  ConnectorFailureCodeSchema,
  ConnectorTimestampSchema,
  CurrencySchema,
  ExternalIdSchema,
  MinorAmountSchema,
  QuantitySchema,
  SourceVersionSchema,
} from "./connector-common.schema.js";
import { CommerceAttributesSchema } from "./connector-data.schema.js";

const commandFields = { executionId: TenantIdSchema, idempotencyKey: ExternalIdSchema };
export const SetPriceCommandSchema = z
  .strictObject({
    ...commandFields,
    externalSkuId: ExternalIdSchema,
    expectedVersion: SourceVersionSchema,
    oldPriceMinor: MinorAmountSchema,
    newPriceMinor: MinorAmountSchema,
    currency: CurrencySchema,
  })
  .readonly();
export const SetInventoryCommandSchema = z
  .strictObject({
    ...commandFields,
    externalSkuId: ExternalIdSchema,
    externalLocationId: ExternalIdSchema,
    expectedVersion: SourceVersionSchema,
    oldAvailable: QuantitySchema,
    targetAvailable: QuantitySchema,
  })
  .readonly();
const ListingSkuSchema = z
  .strictObject({
    sellerSkuCode: ExternalIdSchema,
    attributes: CommerceAttributesSchema,
    salePriceMinor: MinorAmountSchema,
    currency: CurrencySchema,
  })
  .readonly();
export const ListingInputSchema = z
  .strictObject({
    title: CommerceTextSchema.pipe(z.string().max(200)),
    description: CommerceTextSchema,
    category: CommerceTextSchema.pipe(z.string().max(200)),
    brand: CommerceTextSchema.pipe(z.string().max(200)).nullable(),
    skus: z
      .array(ListingSkuSchema)
      .min(1)
      .max(500)
      .refine((skus) => new Set(skus.map((sku) => sku.sellerSkuCode)).size === skus.length)
      .readonly(),
  })
  .readonly();
export const CreateProductCommandSchema = z
  .strictObject({ ...commandFields, listing: ListingInputSchema })
  .readonly();
export const UpdateProductCommandSchema = z
  .strictObject({
    ...commandFields,
    externalProductId: ExternalIdSchema,
    expectedVersion: SourceVersionSchema,
    listing: ListingInputSchema,
  })
  .readonly();
const receiptFields = {
  executionId: TenantIdSchema,
  platformRequestId: ExternalIdSchema.nullable(),
  receivedAt: ConnectorTimestampSchema,
};
export const WriteReceiptSchema = z
  .discriminatedUnion("outcome", [
    z.strictObject({ ...receiptFields, outcome: z.literal("ACCEPTED"), failureCode: z.null() }),
    z.strictObject({
      ...receiptFields,
      outcome: z.literal("REJECTED"),
      failureCode: ConnectorFailureCodeSchema,
    }),
    z.strictObject({
      ...receiptFields,
      outcome: z.literal("UNKNOWN"),
      failureCode: ConnectorFailureCodeSchema,
    }),
  ])
  .readonly();
const snapshotFields = {
  externalStoreId: ExternalIdSchema,
  version: SourceVersionSchema.nullable(),
  observedAt: ConnectorTimestampSchema,
};
export const VerifiedActionSnapshotSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...snapshotFields,
      kind: z.literal("PRICE"),
      externalSkuId: ExternalIdSchema,
      expectedPriceMinor: MinorAmountSchema,
      actualPriceMinor: MinorAmountSchema,
      currency: CurrencySchema,
    }),
    z.strictObject({
      ...snapshotFields,
      kind: z.literal("INVENTORY"),
      externalSkuId: ExternalIdSchema,
      externalLocationId: ExternalIdSchema,
      expectedAvailable: QuantitySchema,
      actualAvailable: QuantitySchema,
    }),
    z.strictObject({
      ...snapshotFields,
      kind: z.literal("PRODUCT"),
      externalProductId: ExternalIdSchema,
      expectedListing: ListingInputSchema,
      actualListing: ListingInputSchema.nullable(),
    }),
  ])
  .readonly();
const ExpectedActionStateSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("PRICE"),
      externalSkuId: ExternalIdSchema,
      priceMinor: MinorAmountSchema,
      currency: CurrencySchema,
    }),
    z.strictObject({
      kind: z.literal("INVENTORY"),
      externalSkuId: ExternalIdSchema,
      externalLocationId: ExternalIdSchema,
      available: QuantitySchema,
    }),
    z.strictObject({
      kind: z.literal("PRODUCT"),
      externalProductId: ExternalIdSchema,
      listing: ListingInputSchema,
    }),
  ])
  .readonly();
export const VerifyActionQuerySchema = z
  .strictObject({ executionId: TenantIdSchema, expected: ExpectedActionStateSchema })
  .readonly();
export const VerificationResultSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("VERIFIED"), snapshot: VerifiedActionSnapshotSchema }),
    z.strictObject({ status: z.literal("MISMATCH"), snapshot: VerifiedActionSnapshotSchema }),
    z.strictObject({
      status: z.literal("PENDING"),
      retryAfterMs: z.number().int().min(1).max(86_400_000),
    }),
    z.strictObject({ status: z.literal("UNAVAILABLE"), reason: ConnectorFailureCodeSchema }),
  ])
  .refine(
    (result) =>
      result.status === "PENDING" ||
      result.status === "UNAVAILABLE" ||
      (result.status === "VERIFIED") === snapshotMatches(result.snapshot),
  )
  .readonly();

function snapshotMatches(snapshot: z.infer<typeof VerifiedActionSnapshotSchema>): boolean {
  if (snapshot.kind === "PRICE") return snapshot.expectedPriceMinor === snapshot.actualPriceMinor;
  if (snapshot.kind === "INVENTORY") return snapshot.expectedAvailable === snapshot.actualAvailable;
  return (
    snapshot.actualListing !== null &&
    listingFingerprint(snapshot.expectedListing) === listingFingerprint(snapshot.actualListing)
  );
}
function listingFingerprint(listing: z.infer<typeof ListingInputSchema>): string {
  // Provider ordering is not evidence of a business-state difference.
  const skus = listing.skus
    .map((sku) => ({
      ...sku,
      attributes: [...sku.attributes].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.sellerSkuCode.localeCompare(b.sellerSkuCode));
  return JSON.stringify({ ...listing, skus });
}

export type SetPriceCommand = z.infer<typeof SetPriceCommandSchema>;
export type SetInventoryCommand = z.infer<typeof SetInventoryCommandSchema>;
export type ListingInput = z.infer<typeof ListingInputSchema>;
export type CreateProductCommand = z.infer<typeof CreateProductCommandSchema>;
export type UpdateProductCommand = z.infer<typeof UpdateProductCommandSchema>;
export type WriteReceipt = z.infer<typeof WriteReceiptSchema>;
export type VerifiedActionSnapshot = z.infer<typeof VerifiedActionSnapshotSchema>;
export type VerifyActionQuery = z.infer<typeof VerifyActionQuerySchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
