import pg from "pg";
import type { Pool, PoolClient } from "pg";

export type MetricRuntimePool = Pick<Pool, "connect" | "end">;
export type MetricRuntimeCapability = "runtime" | "definition";
const safeLoginSql = `
 SELECT current_user=session_user AND current_setting('role') IN ('none',session_user)
 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin)
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user,r.oid,'MEMBER') AND (
 r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
 OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files',
 'pg_write_server_files','pg_execute_server_program','shopmate_sync_worker',
 'shopmate_mock_source_worker','shopmate_mock_source_reader')
 OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
 OR has_database_privilege(r.oid,current_database(),'CREATE')))
 AND CASE WHEN $1='runtime' THEN
 pg_has_role(session_user,'shopmate_metric_source','MEMBER')
 AND pg_has_role(session_user,'shopmate_metric_writer','MEMBER')
 AND NOT pg_has_role(session_user,'shopmate_metric_definition_writer','MEMBER')
 ELSE pg_has_role(session_user,'shopmate_metric_definition_writer','MEMBER')
 AND NOT pg_has_role(session_user,'shopmate_metric_source','MEMBER')
 AND NOT pg_has_role(session_user,'shopmate_metric_writer','MEMBER')
 AND NOT pg_has_role(session_user,'shopmate_metric_reader','MEMBER') END AS safe`;

async function checkedClient(pool: Pool, capability: MetricRuntimeCapability): Promise<PoolClient> {
  const client = await pool.connect();
  let failed = false;
  const onError = () => {
    failed = true;
  };
  client.on("error", onError);
  try {
    const result = await client.query(safeLoginSql, [capability]);
    if (failed || result.rows[0]?.safe !== true)
      throw new Error("Unsafe metric database capability");
    return client;
  } catch {
    client.release(true);
    throw new Error("Metric database unavailable");
  } finally {
    client.off("error", onError);
  }
}
/** Pool construction does not connect. Validate session identity on every checkout, before RLS use. */
export function createMetricRuntimePool(
  connectionString: string,
  capability: MetricRuntimeCapability,
): MetricRuntimePool {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  let unavailable = false;
  pool.on("error", () => {
    unavailable = true;
  });
  return {
    connect: async () => {
      if (unavailable) throw new Error("Metric database unavailable");
      return checkedClient(pool, capability);
    },
    end: () => pool.end(),
  } as MetricRuntimePool;
}
