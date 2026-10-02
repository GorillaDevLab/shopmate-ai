export function prepareTenantApiRuntime(url: string): Promise<string>;
export class TenantApiFixture {
  constructor(url: string);
  initialize(): Promise<void>;
  reset(): Promise<void>;
  setRole(role: "OWNER" | "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER"): Promise<void>;
  disableMembership(): Promise<void>;
  suspendOrganization(): Promise<void>;
  suspendWorkspace(): Promise<void>;
  revokeWorkspace(): Promise<void>;
  close(): Promise<void>;
}
