import {
  TenantContextSchema,
  TenantPermissionSchema,
  TenantResourceSchema,
  type TenantPermission,
  type TenantRole,
} from "./tenant.schema.js";

const readPermissions = ["tenant:read", "products:read", "orders:read", "inventory:read"] as const;
const analysisPermissions = [...readPermissions, "actions:propose"] as const;
const operatorPermissions = [...analysisPermissions, "products:write", "inventory:write"] as const;
const adminPermissions = [
  ...operatorPermissions,
  "organization:manage",
  "actions:approve",
  "demo:manage",
] as const;

export const TENANT_ROLE_PERMISSIONS: Readonly<Record<TenantRole, readonly TenantPermission[]>> =
  Object.freeze({
    OWNER: Object.freeze([...adminPermissions]),
    ADMIN: Object.freeze([...adminPermissions]),
    OPERATOR: Object.freeze([...operatorPermissions]),
    ANALYST: Object.freeze([...analysisPermissions]),
    VIEWER: Object.freeze([...readPermissions]),
  });

export function canAccessTenantResource(
  context: unknown,
  resource: unknown,
  permission: unknown,
): boolean {
  const actor = TenantContextSchema.safeParse(context);
  const target = TenantResourceSchema.safeParse(resource);
  const action = TenantPermissionSchema.safeParse(permission);
  if (!actor.success || !target.success || !action.success) return false;
  return (
    actor.data.organizationId === target.data.organizationId &&
    (!target.data.workspaceId || actor.data.workspaceId === target.data.workspaceId) &&
    actor.data.permissions.includes(action.data)
  );
}
