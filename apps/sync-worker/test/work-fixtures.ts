import type { SyncRuntimeBootstrap } from "@shopmate/database/sync-host";
export const context = {
  grantId: "grant-a",
  principalUserId: "user-a",
  provider: "MOCK",
  scope: {
    organizationId: "org-a",
    workspaceId: "ws-a",
    storeId: "store-a",
    connectionId: "conn-a",
    externalStoreId: "ext-a",
    sessionId: "session-a",
    generation: 1,
  },
  initialSince: "2026-01-01T00:00:00.000Z",
} as SyncRuntimeBootstrap;
function grantFixture() {
  const binding = {
    organizationId: context.scope.organizationId,
    workspaceId: context.scope.workspaceId,
    storeId: context.scope.storeId,
    connectionId: context.scope.connectionId,
    externalStoreId: context.scope.externalStoreId,
    generation: context.scope.generation,
  };
  const grant = {
    ...binding,
    provider: "MOCK",
    id: context.grantId,
    principalUserId: context.principalUserId,
    databaseRole: "worker_role",
    status: "ACTIVE",
    initialSince: "2026-01-01T00:00:00",
  };
  return grant;
}
export function rawWork() {
  const grant = grantFixture();
  const {
    id: _id,
    principalUserId: _user,
    databaseRole: _role,
    status: _status,
    initialSince: _since,
    ...binding
  } = grant;
  void _id;
  void _user;
  void _role;
  void _status;
  void _since;
  const job = {
    ...binding,
    provider: "MOCK",
    id: "job-a",
    grantId: grant.id,
    stream: "PRODUCTS",
    since: grant.initialSince,
    until: "2026-01-02T00:00:00.000Z",
    status: "READY",
    cursor: null,
    successfulThrough: null,
    fence: 0,
    leaseOwner: null,
    leaseUntil: null,
    failureCode: null,
    leaseBackendPid: null,
    leaseBackendStart: null,
    receiptCursor: null,
    receivedThrough: null,
    observedAt: null,
    sourceWatermark: null,
    pageCount: 0,
  };
  return { grant, jobs: [job] };
}
