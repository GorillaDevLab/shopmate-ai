export interface DemoActor {
  readonly userId: string;
  readonly merchantId: string;
}

export interface DemoStoreAccess extends DemoActor {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly role: "OWNER" | "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
}

export interface DemoConnectionRecord extends DemoStoreAccess {
  readonly id: string;
  readonly connectionId: string;
  readonly externalStoreId: string;
  readonly config: unknown;
  readonly configHash: string;
  readonly generatorVersion: string;
  readonly clockNow: Date;
  readonly clockRevision: number;
  readonly revision: number;
  readonly generation: number;
  readonly status: "ACTIVE" | "DISCONNECTED";
  readonly environmentMarker: "DEMO";
  readonly demoTenant: true;
}

export type DemoMutationResult =
  | { readonly status: "WRITTEN"; readonly record: DemoConnectionRecord }
  | { readonly status: "NOT_FOUND" | "CONFLICT" };

export interface DemoSourceInput {
  readonly config: unknown;
  readonly configHash: string;
  readonly generatorVersion: string;
  readonly clockNow: Date;
}

export interface DemoCreateInput extends DemoSourceInput {
  readonly id: string;
  readonly connectionId: string;
  readonly externalStoreId: string;
}

export interface DemoAdvanceInput {
  readonly expectedRevision: number;
  readonly durationMs: number;
}

export interface DemoResetInput extends DemoSourceInput {
  readonly expectedRevision: number;
}
