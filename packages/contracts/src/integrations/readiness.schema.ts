import { z } from "zod";
import {
  CommerceTextSchema,
  ConnectorCapabilitiesSchema,
  ConnectorTimestampSchema,
  ExternalIdSchema,
} from "../commerce/connector-common.schema.js";

// Use the existing connector capability names, not vendor-specific guesses.
export const ConnectorCapabilityNameSchema = ConnectorCapabilitiesSchema.unwrap().keyof();

export const VerificationEvidenceStatusSchema = z.enum(["VERIFIED", "UNKNOWN", "REJECTED"]);

const sourceLinkSchema = z.url().refine((value) => {
  const url = new URL(value);
  const hasSecretParameter = [...url.searchParams.keys()].some((key) =>
    /token|secret|password|api.?key|credential|authorization/iu.test(key),
  );
  return url.protocol === "https:" && !url.username && !url.password && !hasSecretParameter;
});

export const ConnectorVerificationEvidenceSchema = z
  .strictObject({
    status: VerificationEvidenceStatusSchema,
    owner: CommerceTextSchema.pipe(z.string().max(120)).nullable(),
    sourceLink: sourceLinkSchema.nullable(),
    verificationDate: z.iso.date().nullable(),
    scope: CommerceTextSchema.pipe(z.string().max(500)).nullable(),
    validUntil: z.iso.date().nullable(),
  })
  .readonly();

export const VerifiedPermissionManifestSchema = z
  .strictObject({
    id: ExternalIdSchema,
    permissionPackage: ExternalIdSchema.nullable(),
    evidence: ConnectorVerificationEvidenceSchema,
  })
  .readonly();

export const VerifiedFieldManifestSchema = z
  .strictObject({
    id: ExternalIdSchema,
    normalizedEntity: z.enum(["STORE", "PRODUCT", "ORDER", "REFUND", "INVENTORY", "MARKETING"]),
    normalizedField: ExternalIdSchema,
    semanticStatus: z.enum(["MATCHED", "TRANSFORMED", "UNKNOWN", "MISMATCH"]),
    evidence: ConnectorVerificationEvidenceSchema,
  })
  .readonly();

export const ConnectorCapabilityEvidenceSchema = z
  .strictObject({
    name: ConnectorCapabilityNameSchema,
    evidence: ConnectorVerificationEvidenceSchema,
    requiredPermissionIds: z.array(ExternalIdSchema).min(1).max(100).readonly(),
    requiredFieldIds: z.array(ExternalIdSchema).min(1).max(100).readonly(),
  })
  .readonly();

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const ConnectorReadinessManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    provider: ExternalIdSchema,
    adapterApproval: z.literal("UNAPPROVED"),
    adapterMode: z.literal("PREPARATION_ONLY"),
    assessedAt: ConnectorTimestampSchema,
    capabilities: z.array(ConnectorCapabilityEvidenceSchema).max(11).readonly(),
    permissions: z.array(VerifiedPermissionManifestSchema).max(200).readonly(),
    fields: z.array(VerifiedFieldManifestSchema).max(500).readonly(),
  })
  .superRefine((manifest, context) => {
    const sets = [
      manifest.capabilities.map((item) => item.name),
      manifest.permissions.map((item) => item.id),
      manifest.fields.map((item) => item.id),
    ];
    if (sets.some((values) => !unique(values))) {
      context.addIssue({ code: "custom", message: "Duplicate manifest identifiers" });
    }
    if (
      manifest.capabilities.some(
        (item) => !unique(item.requiredPermissionIds) || !unique(item.requiredFieldIds),
      )
    ) {
      context.addIssue({ code: "custom", message: "Duplicate capability dependencies" });
    }
  })
  .readonly();

export const ConnectorCapabilityAssessmentSchema = z
  .strictObject({
    name: ConnectorCapabilityNameSchema,
    evidenceReadiness: z.enum(["READY", "UNSUPPORTED"]),
    adapterMode: z.literal("PREPARATION_ONLY"),
    grantsActionPermission: z.literal(false),
  })
  .readonly();

export type ConnectorReadinessManifestV1 = z.infer<typeof ConnectorReadinessManifestV1Schema>;
export type VerifiedFieldManifest = z.infer<typeof VerifiedFieldManifestSchema>;
export type VerifiedPermissionManifest = z.infer<typeof VerifiedPermissionManifestSchema>;
export type ConnectorCapabilityAssessment = z.infer<typeof ConnectorCapabilityAssessmentSchema>;

type VerificationEvidence = z.infer<typeof ConnectorVerificationEvidenceSchema>;
type CapabilityName = z.infer<typeof ConnectorCapabilityNameSchema>;

function evidenceIsCurrent(evidence: VerificationEvidence, assessedAt: string): boolean {
  const date = assessedAt.slice(0, 10);
  return (
    evidence.status === "VERIFIED" &&
    evidence.owner !== null &&
    evidence.sourceLink !== null &&
    evidence.scope !== null &&
    evidence.verificationDate !== null &&
    evidence.validUntil !== null &&
    evidence.verificationDate <= date &&
    evidence.validUntil >= date &&
    evidence.validUntil >= evidence.verificationDate
  );
}

// Evidence readiness is informational, never runtime authorization.
export function assessConnectorCapability(
  input: unknown,
  name: CapabilityName,
): ConnectorCapabilityAssessment {
  const manifest = ConnectorReadinessManifestV1Schema.parse(input);
  const capability = manifest.capabilities.find((item) => item.name === name);
  const current = (evidence: VerificationEvidence) =>
    evidenceIsCurrent(evidence, manifest.assessedAt);

  const permissionReady = capability?.requiredPermissionIds.every((id) =>
    manifest.permissions.some(
      (item) => item.id === id && item.permissionPackage !== null && current(item.evidence),
    ),
  );
  const fieldReady = capability?.requiredFieldIds.every((id) =>
    manifest.fields.some(
      (item) =>
        item.id === id &&
        (item.semanticStatus === "MATCHED" || item.semanticStatus === "TRANSFORMED") &&
        current(item.evidence),
    ),
  );

  return ConnectorCapabilityAssessmentSchema.parse({
    name,
    evidenceReadiness:
      capability && current(capability.evidence) && permissionReady && fieldReady
        ? "READY"
        : "UNSUPPORTED",
    adapterMode: "PREPARATION_ONLY",
    grantsActionPermission: false,
  });
}
