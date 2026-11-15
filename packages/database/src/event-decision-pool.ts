import pg from "pg";
import type { PoolClient, Pool } from "pg";

export interface EventDecisionPool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
const capabilities = [
  "shopmate_event_writer",
  "shopmate_decision_writer",
  "shopmate_metric_reader",
  "shopmate_metric_source",
  "shopmate_audit_writer",
  "shopmate_notification_enqueuer",
];
const forbidden = [
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "shopmate_sync_worker",
  "shopmate_mock_source_worker",
  "shopmate_mock_source_reader",
  "shopmate_metric_writer",
  "shopmate_metric_definition_writer",
  "shopmate_notification_worker",
  "shopmate_notification_guard",
  "shopmate_auth_security_writer",
  "shopmate_audit_chain",
  "shopmate_audit_service_writer",
];
// Freeze the existing six-capability write union, including the enqueuer's column boundary.
// Comparing effective privileges also catches unnamed roles and direct ACL equivalents.
const writeBoundarySql = `WITH permitted(relation,inserts,updates) AS (VALUES
  ('public.events'::regclass,ARRAY['*'],ARRAY['state','revision','lastSeenAt','currentEvidenceId','currentEvidenceVersion','currentEvidenceHash']),
  ('public.event_evidence'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.event_evidence_metrics'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.decision_runs'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.decision_records'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.decision_comparisons'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.audit_logs'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.audit_checkpoints'::regclass,ARRAY['*'],ARRAY[]::text[]),
  ('public.notification_outbox'::regclass,
    ARRAY['intentId','organizationId','workspaceId','storeId','connectionId','externalStoreId','recipientUserId',
      'eventId','eventState','eventRevision','channel','decisionRunId','route','eventType','severity','createdAt',
      'notBefore','evidenceId','evidenceVersion','evidenceHash','entityKind','entityId','definitionVersion',
      'baselineVersion','connectionGeneration','nextAttemptAt'],ARRAY[]::text[])
), available AS (SELECT oid FROM pg_roles WHERE pg_has_role(session_user,oid,'MEMBER')),
relations AS (SELECT c.oid,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
SELECT NOT EXISTS(SELECT 1 FROM available r CROSS JOIN relations c
  WHERE (c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE'))
    OR (c.relkind IN ('r','p','v','m','f') AND (
      has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')
      OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS v(privilege)
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(r.oid,c.oid,a.attnum,v.privilege)
          AND NOT EXISTS(SELECT 1 FROM permitted p WHERE p.relation=c.oid
            AND (CASE v.privilege WHEN 'INSERT' THEN '*'=ANY(p.inserts) OR a.attname=ANY(p.inserts)
              WHEN 'UPDATE' THEN a.attname=ANY(p.updates) ELSE false END))))))
  AS writes_safe`;
const safeSql = `SELECT current_user=session_user
  AND current_setting('role') IN ('none',session_user)
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin)
  AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) AS required(name)
    WHERE NOT pg_has_role(session_user,name,'MEMBER'))
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user,r.oid,'MEMBER')
    AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR r.rolname=ANY($2::text[])
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_'
        AND has_schema_privilege(r.oid,n.oid,'CREATE'))
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
      OR has_database_privilege(r.oid,current_database(),'CREATE')))
  AND NOT has_any_column_privilege(session_user,'public.decision_claims','UPDATE')
  AND has_column_privilege(session_user,'public."OrganizationMember"','role','SELECT')
  AS safe`;

async function checked(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  let failed = false;
  const onError = () => {
    failed = true;
  };
  client.on("error", onError);
  try {
    const result = await client.query(safeSql, [capabilities, forbidden]);
    if (failed || result.rows.length !== 1 || result.rows[0]?.safe !== true)
      throw new Error("Unsafe event decision capability");
    const writes = await client.query(writeBoundarySql);
    if (failed || writes.rows.length !== 1 || writes.rows[0]?.writes_safe !== true)
      throw new Error("Unsafe event decision write capability");
    return client;
  } catch {
    client.release(true);
    throw new Error("Event decision database unavailable");
  } finally {
    client.off("error", onError);
  }
}
/** Lazy capability-specific pool; membership and metric writer credentials cannot substitute. */
export function createEventDecisionPool(connectionString: string): EventDecisionPool {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  let failed = false;
  pool.on("error", () => {
    failed = true;
  });
  return {
    async connect() {
      if (failed) throw new Error("Event decision database unavailable");
      return checked(pool);
    },
    end: () => pool.end(),
  };
}
