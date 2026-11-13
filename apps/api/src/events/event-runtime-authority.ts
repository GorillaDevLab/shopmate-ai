import { ForbiddenException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ConnectorBindingSchema,
  DecisionControlSchema,
  SourceVersionSchema,
  TenantContextSchema,
  TenantIdSchema,
  TenantRoleSchema,
  TENANT_ROLE_PERMISSIONS,
  type SecurityClock,
} from "@shopmate/contracts";
import type { RuntimeTransactionClient } from "./event-transaction-lifetime.js";
import { runtimeUnavailable } from "./event-transaction-lifetime.js";

export const runtimeAuthoritySchema = z.strictObject({
  actor: TenantContextSchema.extend({
    permissions: TenantContextSchema.shape.permissions.readonly(),
  }),
  binding: ConnectorBindingSchema,
  generation: z.number().int().min(0).max(2147483647).nullable(),
  revisions: z.array(SourceVersionSchema).max(200).readonly(),
  recipientId: TenantIdSchema.nullable(),
  writable: z.boolean(),
  control: DecisionControlSchema,
});
export type RuntimeAuthority = z.infer<typeof runtimeAuthoritySchema>;
export const runtimeBindingKeys = [
  "organizationId",
  "workspaceId",
  "storeId",
  "connectionId",
  "externalStoreId",
] as const;
const authoritySql = `SELECT m.role, current_setting('app.user_id',true)=$6
  AND public.event_scope_access($1,$2,$3,$4,$5,$7)
  AND public.metric_source_resolve($3)=$8::jsonb
  AND NOT EXISTS(SELECT 1 FROM unnest($9::text[]) AS revisions(value)
    WHERE NOT public.metric_source_revision_current($1,$2,$3,$4,$5,value))
  AND ($10::integer IS NULL OR public.notification_scope_access($1,$2,$3,$4,$5,$11,$10,'ENQUEUE'))
  AS allowed /* runtime:authority */
  FROM public."OrganizationMember" m WHERE m."organizationId"=$1 AND m."userId"=$6`;

export function runtimeLive(input: RuntimeAuthority, clock: SecurityClock): boolean {
  return (
    !input.control.signal.aborted && Date.parse(clock.now()) < Date.parse(input.control.deadlineAt)
  );
}
export async function checkRuntimeAuthority(
  client: RuntimeTransactionClient,
  input: RuntimeAuthority,
  clock: SecurityClock,
): Promise<void> {
  if (!runtimeLive(input, clock)) throw runtimeUnavailable();
  const result = await client.query(authoritySql, [
    ...runtimeBindingKeys.map((key) => input.binding[key]),
    input.actor.userId,
    input.writable,
    JSON.stringify(input.binding),
    [...new Set(input.revisions)],
    input.generation,
    input.recipientId ?? input.actor.userId,
  ]);
  const row = result.rows[0];
  const role = TenantRoleSchema.safeParse(row?.role);
  if (
    result.rows.length !== 1 ||
    !role.success ||
    row?.allowed !== true ||
    role.data !== input.actor.role ||
    !isDeepStrictEqual(TENANT_ROLE_PERMISSIONS[role.data], input.actor.permissions)
  )
    throw new ForbiddenException();
  if (!runtimeLive(input, clock)) throw runtimeUnavailable();
}
export async function initializeRuntime(
  client: RuntimeTransactionClient,
  input: RuntimeAuthority,
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query(
    `SELECT set_config('app.user_id',$1,true),set_config('app.merchant_id',$2,true),
    set_config('app.organization_id',$3,true),set_config('app.workspace_id',$4,true),
    set_config('app.store_id',$5,true),set_config('app.connection_id',$6,true),set_config('app.external_store_id',$7,true)`,
    [
      input.actor.userId,
      input.actor.merchantId,
      ...runtimeBindingKeys.map((key) => input.binding[key]),
    ],
  );
}
