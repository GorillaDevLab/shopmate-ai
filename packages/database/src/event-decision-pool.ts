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
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
      OR has_database_privilege(r.oid,current_database(),'CREATE')))
  AND NOT has_table_privilege(session_user,'public.decision_claims','UPDATE')
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
