import { describe, expect, it } from "vitest";
import {
  ConnectorReadinessManifestV1Schema,
  VerifiedFieldManifestSchema,
  assessConnectorCapability,
} from "./readiness.schema.js";

const evidence = {
  status: "VERIFIED" as const,
  owner: "integration-reviewer",
  sourceLink: "https://docs.example.org/verification",
  verificationDate: "2026-10-15",
  scope: "Synthetic product read capability",
  validUntil: "2026-11-15",
};

function fixture() {
  return ConnectorReadinessManifestV1Schema.parse({
    schemaVersion: 1,
    provider: "synthetic",
    adapterApproval: "UNAPPROVED",
    adapterMode: "PREPARATION_ONLY",
    assessedAt: "2026-10-22T00:00:00Z",
    capabilities: [
      {
        name: "readProducts",
        evidence,
        requiredPermissionIds: ["products:read"],
        requiredFieldIds: ["product.title"],
      },
    ],
    permissions: [
      {
        id: "products:read",
        permissionPackage: "synthetic-package",
        evidence,
      },
    ],
    fields: [
      {
        id: "product.title",
        normalizedEntity: "PRODUCT",
        normalizedField: "title",
        semanticStatus: "MATCHED",
        evidence,
      },
    ],
  });
}

function withCapabilityEvidence(patch: Record<string, unknown>) {
  const manifest = fixture();
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((item) => ({
      ...item,
      evidence: { ...item.evidence, ...patch },
    })),
  };
}

describe("P13-001 connector readiness contract", () => {
  it("parses a strict versioned manifest without exposing action permissions", () => {
    const manifest = fixture();
    const result = assessConnectorCapability(manifest, "readProducts");

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(result).toEqual({
      name: "readProducts",
      evidenceReadiness: "READY",
      adapterMode: "PREPARATION_ONLY",
      grantsActionPermission: false,
    });
  });

  it("maps UNKNOWN and REJECTED evidence to UNSUPPORTED", () => {
    for (const status of ["UNKNOWN", "REJECTED"]) {
      const result = assessConnectorCapability(withCapabilityEvidence({ status }), "readProducts");
      expect(result.evidenceReadiness).toBe("UNSUPPORTED");
    }
  });

  it.each([
    { owner: null },
    { sourceLink: null },
    { verificationDate: null },
    { scope: null },
    { validUntil: null },
    { validUntil: "2026-10-01" },
    { verificationDate: "2026-11-01" },
    { verificationDate: "2026-10-15", validUntil: "2026-10-14" },
  ])("does not upgrade incomplete or stale evidence %o", (patch) => {
    const result = assessConnectorCapability(withCapabilityEvidence(patch), "readProducts");
    expect(result.evidenceReadiness).toBe("UNSUPPORTED");
    expect(result.grantsActionPermission).toBe(false);
  });

  it("does not upgrade when permission evidence is absent or unverified", () => {
    const manifest = fixture();

    expect(
      assessConnectorCapability({ ...manifest, permissions: [] }, "readProducts").evidenceReadiness,
    ).toBe("UNSUPPORTED");

    const unverified = manifest.permissions.map((item) => ({
      ...item,
      evidence: { ...item.evidence, status: "UNKNOWN" },
    }));
    expect(
      assessConnectorCapability({ ...manifest, permissions: unverified }, "readProducts")
        .evidenceReadiness,
    ).toBe("UNSUPPORTED");

    expect(
      assessConnectorCapability(
        {
          ...manifest,
          permissions: manifest.permissions.map((item) => ({
            ...item,
            permissionPackage: null,
          })),
        },
        "readProducts",
      ).evidenceReadiness,
    ).toBe("UNSUPPORTED");
  });

  it("requires verified normalized field semantics and evidence", () => {
    const manifest = fixture();

    for (const semanticStatus of ["UNKNOWN", "MISMATCH"]) {
      const fields = manifest.fields.map((item) => ({ ...item, semanticStatus }));
      expect(
        assessConnectorCapability({ ...manifest, fields }, "readProducts").evidenceReadiness,
      ).toBe("UNSUPPORTED");
    }

    expect(
      assessConnectorCapability({ ...manifest, fields: [] }, "readProducts").evidenceReadiness,
    ).toBe("UNSUPPORTED");

    expect(
      VerifiedFieldManifestSchema.safeParse({
        ...manifest.fields[0],
        evidence: { ...evidence, sourceLink: null },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown capabilities and unlisted sensitive fields", () => {
    const manifest = fixture();

    expect(
      ConnectorReadinessManifestV1Schema.safeParse({
        ...manifest,
        capabilities: [{ ...manifest.capabilities[0], name: "readPayouts" }],
      }).success,
    ).toBe(false);

    for (const field of ["endpoint", "sdk", "apiKey", "accessToken"]) {
      expect(
        ConnectorReadinessManifestV1Schema.safeParse({
          ...manifest,
          [field]: "unverified-secret-or-api",
        }).success,
      ).toBe(false);
      expect(
        ConnectorReadinessManifestV1Schema.safeParse({
          ...manifest,
          capabilities: [
            {
              ...manifest.capabilities[0],
              evidence: { ...evidence, [field]: "unverified-secret-or-api" },
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects forged approval, active adapter mode and readiness fields", () => {
    const manifest = fixture();

    expect(
      ConnectorReadinessManifestV1Schema.safeParse({
        ...manifest,
        adapterApproval: "APPROVED",
      }).success,
    ).toBe(false);

    expect(
      ConnectorReadinessManifestV1Schema.safeParse({
        ...manifest,
        adapterMode: "LIVE",
      }).success,
    ).toBe(false);

    expect(
      ConnectorReadinessManifestV1Schema.safeParse({
        ...manifest,
        readiness: "READY",
      }).success,
    ).toBe(false);
  });

  it("rejects secret-bearing source URLs and invalid dates", () => {
    for (const patch of [
      { sourceLink: "http://docs.example.org/verification" },
      { sourceLink: "https://user:pass@docs.example.org/verification" },
      { sourceLink: "https://docs.example.org/verification?apiKey=secret" },
      { verificationDate: "not-a-date" },
    ]) {
      expect(
        ConnectorReadinessManifestV1Schema.safeParse(withCapabilityEvidence(patch)).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate capability, permission and field identifiers", () => {
    const manifest = fixture();

    for (const patch of [
      { capabilities: [manifest.capabilities[0], manifest.capabilities[0]] },
      { permissions: [manifest.permissions[0], manifest.permissions[0]] },
      { fields: [manifest.fields[0], manifest.fields[0]] },
    ]) {
      expect(
        ConnectorReadinessManifestV1Schema.safeParse({
          ...manifest,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps unlisted capabilities unsupported and never grants writes", () => {
    const result = assessConnectorCapability(fixture(), "writePrice");

    expect(result.evidenceReadiness).toBe("UNSUPPORTED");
    expect(result.adapterMode).toBe("PREPARATION_ONLY");
    expect(result.grantsActionPermission).toBe(false);
  });
});
