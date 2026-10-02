import { z } from "zod";

export const TenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);
export const TenantRoleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "ANALYST", "VIEWER"]);
export const TenantPermissionSchema = z.enum([
  "tenant:read",
  "organization:manage",
  "products:read",
  "products:write",
  "orders:read",
  "inventory:read",
  "inventory:write",
  "actions:propose",
  "actions:approve",
]);
export const TenantContextSchema = z.strictObject({
  userId: TenantIdSchema,
  merchantId: TenantIdSchema,
  organizationId: TenantIdSchema,
  workspaceId: TenantIdSchema,
  role: TenantRoleSchema,
  permissions: z
    .array(TenantPermissionSchema)
    .max(9)
    .refine((values) => new Set(values).size === values.length),
});
export const TenantResourceSchema = z.strictObject({
  organizationId: TenantIdSchema,
  workspaceId: TenantIdSchema.optional(),
});

export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type TenantPermission = z.infer<typeof TenantPermissionSchema>;
export type TenantContext = Readonly<Omit<z.infer<typeof TenantContextSchema>, "permissions">> & {
  readonly permissions: readonly TenantPermission[];
};
export type TenantResource = Readonly<z.infer<typeof TenantResourceSchema>>;
