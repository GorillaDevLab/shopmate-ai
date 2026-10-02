import { URL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma, type TenantRole } from "../generated/prisma/client.js";

export interface TenantBootstrapRequest {
  readonly environment: "LOCAL" | "TEST" | "DEMO";
  readonly userId: string;
  readonly merchantId: string;
  readonly role: TenantRole;
  readonly apply: boolean;
}

export class TenantBootstrapSafetyError extends Error {}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const roles: readonly string[] = ["OWNER", "ADMIN", "OPERATOR", "ANALYST", "VIEWER"];

export function readTenantBootstrapRequest(env: NodeJS.ProcessEnv): TenantBootstrapRequest {
  if (env.NODE_ENV === "production" || !["local", "test", "demo"].includes(env.APP_ENV ?? ""))
    fail("Bootstrap requires an explicit non-production APP_ENV");
  assertDemoDatabase(env.DATABASE_URL);
  const userId = env.TENANT_BOOTSTRAP_USER_ID ?? "";
  const merchantId = env.TENANT_BOOTSTRAP_MERCHANT_ID ?? "";
  const role = env.TENANT_BOOTSTRAP_ROLE ?? "VIEWER";
  if (!idPattern.test(userId) || !idPattern.test(merchantId) || !roles.includes(role))
    fail("Bootstrap identifiers or role are invalid");
  if (
    env.TENANT_BOOTSTRAP_APPLY !== undefined &&
    !["true", "false"].includes(env.TENANT_BOOTSTRAP_APPLY)
  )
    fail("Bootstrap apply flag must be true or false");
  return {
    environment: env.APP_ENV!.toUpperCase() as TenantBootstrapRequest["environment"],
    userId,
    merchantId,
    role: role as TenantRole,
    apply: env.TENANT_BOOTSTRAP_APPLY === "true",
  };
}

function assertDemoDatabase(value: string | undefined): void {
  if (!value) fail("Bootstrap requires an explicit isolated DATABASE_URL");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !/^\/shopmate_tenant_(?:local|test|demo)(?:_[a-z0-9]+)?$/u.test(url.pathname)
  )
    fail("Bootstrap requires a loopback shopmate_tenant_local/test/demo database");
}

export function assertBootstrapEnvironment(
  request: TenantBootstrapRequest,
  marker: string | undefined,
): void {
  if (marker !== request.environment) fail("Database environment marker does not match APP_ENV");
}

export async function bootstrapTenantMembership(env: NodeJS.ProcessEnv) {
  const request = readTenantBootstrapRequest(env);
  // Never reuse an API client whose connection could differ from the validated operator URL.
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL! }),
  });
  try {
    return await client.$transaction((transaction) => runBootstrap(transaction, request));
  } finally {
    await client.$disconnect();
  }
}

async function runBootstrap(
  transaction: Prisma.TransactionClient,
  request: TenantBootstrapRequest,
) {
  const marker = await transaction.tenantBootstrapEnvironment.findUnique({
    where: { id: "singleton" },
  });
  assertBootstrapEnvironment(request, marker?.environment);
  const organization = await transaction.organization.findFirst({
    where: { legacyMerchantId: request.merchantId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!organization) fail("Active merchant organization does not exist");
  const workspace = await transaction.workspace.findFirst({
    where: { organizationId: organization.id, slug: "default", status: "ACTIVE" },
    select: { id: true },
  });
  if (!workspace) fail("Active default workspace does not exist");
  await validateExistingMembership(transaction, request, organization.id, workspace.id);
  if (!request.apply)
    return {
      applied: false,
      organizationId: organization.id,
      workspaceId: workspace.id,
      role: request.role,
    };
  await provisionMembership(transaction, request, organization.id, workspace.id);
  return {
    applied: true,
    organizationId: organization.id,
    workspaceId: workspace.id,
    role: request.role,
  };
}

async function validateExistingMembership(
  transaction: Prisma.TransactionClient,
  request: TenantBootstrapRequest,
  organizationId: string,
  workspaceId: string,
) {
  const membership = await transaction.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: request.userId } },
  });
  if (membership && (membership.role !== request.role || membership.status !== "ACTIVE"))
    fail("Existing membership cannot be changed by bootstrap");
  const grant = await transaction.workspaceMember.findUnique({
    where: {
      organizationId_workspaceId_userId: { organizationId, workspaceId, userId: request.userId },
    },
  });
  if (grant && grant.status !== "ACTIVE")
    fail("Existing workspace grant cannot be reactivated by bootstrap");
}

async function provisionMembership(
  transaction: Prisma.TransactionClient,
  request: TenantBootstrapRequest,
  organizationId: string,
  workspaceId: string,
) {
  const member = await transaction.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId: request.userId } },
    create: { organizationId, userId: request.userId, role: request.role },
    update: {},
  });
  if (member.role !== request.role || member.status !== "ACTIVE")
    fail("Existing membership cannot be changed by bootstrap");
  const grant = await transaction.workspaceMember.upsert({
    where: {
      organizationId_workspaceId_userId: { organizationId, workspaceId, userId: request.userId },
    },
    create: { organizationId, workspaceId, userId: request.userId },
    update: {},
  });
  if (grant.status !== "ACTIVE")
    fail("Existing workspace grant cannot be reactivated by bootstrap");
}

function fail(message: string): never {
  throw new TenantBootstrapSafetyError(message);
}
