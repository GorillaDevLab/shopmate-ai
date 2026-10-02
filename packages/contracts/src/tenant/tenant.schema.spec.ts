import { describe, expect, it } from "vitest";
import { TenantContextSchema, TenantResourceSchema, TenantRoleSchema } from "./tenant.schema.js";

export const validTenant = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "VIEWER",
  permissions: ["tenant:read", "products:read"],
};

describe("tenant schemas", () => {
  it("accepts a minimal server-resolved context", () => {
    expect(TenantContextSchema.parse(validTenant)).toEqual(validTenant);
  });
  it.each(["roleOverride", "accessToken", "email"])("rejects unknown %s", (field) => {
    expect(TenantContextSchema.safeParse({ ...validTenant, [field]: "injected" }).success).toBe(
      false,
    );
  });
  it.each(["", " org-a", "../org-a", "a".repeat(129), "<script>"])("rejects unsafe IDs", (id) => {
    expect(TenantContextSchema.safeParse({ ...validTenant, organizationId: id }).success).toBe(
      false,
    );
  });
  it("rejects unknown and repeated permissions", () => {
    for (const permissions of [["execute_sql"], ["tenant:read", "tenant:read"]]) {
      expect(TenantContextSchema.safeParse({ ...validTenant, permissions }).success).toBe(false);
    }
  });
  it("keeps the five roles vendor-neutral", () => {
    expect(TenantRoleSchema.options).toEqual(["OWNER", "ADMIN", "OPERATOR", "ANALYST", "VIEWER"]);
  });
  it("rejects unexpected resource authority fields", () => {
    expect(
      TenantResourceSchema.safeParse({ organizationId: "org-a", approved: true }).success,
    ).toBe(false);
  });
});
