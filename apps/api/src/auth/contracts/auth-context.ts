export const AuthPermission = {
  ProductsRead: "products:read",
  ProductsWrite: "products:write",
  OrdersRead: "orders:read",
  InventoryWrite: "inventory:write",
} as const;

export type AuthPermission = (typeof AuthPermission)[keyof typeof AuthPermission];

export interface AuthenticatedIdentity {
  readonly userId: string;
  readonly merchantId: string;
  readonly permissions: readonly AuthPermission[];
}

export interface AuthContext {
  readonly userId: string;
  readonly merchantId: string;
  readonly permissions: readonly AuthPermission[];
}

export function createAuthContext(identity: AuthenticatedIdentity): Readonly<AuthContext> {
  return Object.freeze({
    userId: identity.userId,
    merchantId: identity.merchantId,
    permissions: Object.freeze([...identity.permissions]),
  });
}
