import { describe, expect, it } from "vitest";
import { canAccessTenantResource, TENANT_ROLE_PERMISSIONS } from "./tenant-policy.js";
import { TenantContextSchema, type TenantRole } from "./tenant.schema.js";

function context(role: TenantRole = "VIEWER") {
  return TenantContextSchema.parse({
    userId: "user-a",
    merchantId: "merchant-a",
    organizationId: "org-a",
    workspaceId: "workspace-a",
    role,
    permissions: [...TENANT_ROLE_PERMISSIONS[role]],
  });
}

describe("tenant resource authorization", () => {
  it("allows an assigned reader to read its selected workspace", () => {
    expect(
      canAccessTenantResource(
        context(),
        { organizationId: "org-a", workspaceId: "workspace-a" },
        "products:read",
      ),
    ).toBe(true);
  });
  it("rejects a foreign organization even for owner", () => {
    expect(
      canAccessTenantResource(context("OWNER"), { organizationId: "org-b" }, "tenant:read"),
    ).toBe(false);
  });
  it("rejects a different workspace in the same organization", () => {
    expect(
      canAccessTenantResource(
        context("OWNER"),
        { organizationId: "org-a", workspaceId: "workspace-b" },
        "tenant:read",
      ),
    ).toBe(false);
  });
  it.each(["VIEWER", "ANALYST", "OPERATOR"] as const)("%s cannot approve actions", (role) => {
    expect(
      canAccessTenantResource(context(role), { organizationId: "org-a" }, "actions:approve"),
    ).toBe(false);
  });
  it.each(["OWNER", "ADMIN"] as const)("%s may reach the approval policy", (role) => {
    expect(
      canAccessTenantResource(context(role), { organizationId: "org-a" }, "actions:approve"),
    ).toBe(true);
  });
  it("viewer cannot propose or change products", () => {
    for (const action of ["actions:propose", "products:write"] as const) {
      expect(canAccessTenantResource(context(), { organizationId: "org-a" }, action)).toBe(false);
    }
  });
  it("denies malformed contexts and resources at runtime", () => {
    expect(
      canAccessTenantResource(
        { ...context(), permissions: ["execute_sql"] },
        { organizationId: "org-a" },
        "tenant:read",
      ),
    ).toBe(false);
    expect(
      canAccessTenantResource(context(), { organizationId: "org-a", role: "OWNER" }, "tenant:read"),
    ).toBe(false);
  });
  it("role labels alone cannot manufacture a missing permission", () => {
    expect(
      canAccessTenantResource(
        { ...context("OWNER"), permissions: [] },
        { organizationId: "org-a" },
        "actions:approve",
      ),
    ).toBe(false);
  });
  it("role templates are immutable and cannot grant permissions across requests", () => {
    expect(Object.isFrozen(TENANT_ROLE_PERMISSIONS)).toBe(true);
    expect(Object.values(TENANT_ROLE_PERMISSIONS).every(Object.isFrozen)).toBe(true);
  });
});
