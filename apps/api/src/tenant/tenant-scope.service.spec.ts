import { describe, expect, it, vi } from "vitest";
import { AuthPermission, createAuthContext } from "../auth/contracts/index.js";
import { TenantScopeService } from "./tenant-scope.service.js";

const identity = createAuthContext({
  userId: "user-a",
  merchantId: "merchant-a",
  permissions: Object.values(AuthPermission),
});
const membership = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "organization-a",
  workspaceId: "workspace-a",
  role: "OWNER" as const,
};

describe("TenantScopeService", () => {
  it("returns an immutable context with current role permissions", async () => {
    const service = new TenantScopeService({ resolve: vi.fn().mockResolvedValue(membership) });
    const context = await service.resolve(identity);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
    expect(context.permissions).toContain("actions:approve");
  });
  it.each([
    { ...membership, userId: "foreign" },
    { ...membership, merchantId: "foreign" },
    { ...membership, role: "UNKNOWN" },
  ])("rejects invalid repository output %o", async (record) => {
    const service = new TenantScopeService({ resolve: vi.fn().mockResolvedValue(record) });
    await expect(service.resolve(identity)).rejects.toMatchObject({ status: 503 });
  });
  it("rejects mismatched selected workspace", async () => {
    const service = new TenantScopeService({ resolve: vi.fn().mockResolvedValue(membership) });
    await expect(service.resolve(identity, "another")).rejects.toMatchObject({ status: 503 });
  });
  it("validates cookie identity before looking up membership", async () => {
    const resolve = vi.fn();
    const service = new TenantScopeService({ resolve });
    await expect(service.resolve({ ...identity, userId: "invalid user" })).rejects.toMatchObject({
      status: 404,
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
