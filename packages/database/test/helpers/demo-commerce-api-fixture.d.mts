export class DemoCommerceApiFixture {
  constructor(url: string);
  initialize(): Promise<void>;
  reset(): Promise<void>;
  setRole(role: "OWNER" | "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER"): Promise<void>;
  disableMembership(): Promise<void>;
  suspendOrganization(): Promise<void>;
  suspendWorkspace(): Promise<void>;
  revokeWorkspace(): Promise<void>;
  setMarker(marker: "DEMO" | "PRODUCTION"): Promise<void>;
  removeDemoTenant(): Promise<void>;
  snapshot(storeId: string): Promise<{ session: unknown[]; audit: unknown[] }>;
  close(): Promise<void>;
}
