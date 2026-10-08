import pg from "pg";
import { sanitized, SourceStorageError } from "./errors.js";
import type { SourceEnvironment } from "./types.js";

export type SourceMode = "reader" | "worker";
export interface SourcePool {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
}
function recoverablePool(connectionString: string): SourcePool {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let pending: SourceStorageError | undefined;
  // pg purges the failed idle client. Report once before an explicit retry reconnects.
  pool.on("error", () => {
    pending = new SourceStorageError("SOURCE_STORAGE");
  });
  return {
    async connect() {
      if (pending) {
        const error = pending;
        pending = undefined;
        throw error;
      }
      return pool.connect();
    },
    async end() {
      pending = undefined;
      try {
        await pool.end();
      } catch (error) {
        throw sanitized(error);
      }
    },
  };
}
export function sourcePool(env: SourceEnvironment, mode: SourceMode): SourcePool {
  const key =
    mode === "reader" ? "MOCK_PLATFORM_READ_DATABASE_URL" : "MOCK_PLATFORM_WORKER_DATABASE_URL";
  const value = env?.[key];
  try {
    if (!value) throw new SourceStorageError("SOURCE_CONFIGURATION");
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname ||
      url.pathname === "/" ||
      url.hash
    )
      throw new SourceStorageError("SOURCE_CONFIGURATION");
    return recoverablePool(value);
  } catch {
    throw new SourceStorageError("SOURCE_CONFIGURATION");
  }
}
export async function verifyCredentials(client: pg.PoolClient, mode: SourceMode): Promise<void> {
  const result = await client.query<{ safe: boolean }>(
    `SELECT session_user=current_user AND
    pg_has_role(session_user,$1,'MEMBER') AND NOT pg_has_role(session_user,$3,'MEMBER') AND NOT EXISTS (
      SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user,r.oid,'MEMBER') AND
      (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR
        r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program') OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND
          (n.nspname IN ('demo','mock_platform','sync_host','commerce') OR (n.nspname='public' AND c.relname=ANY($2::text[])))) OR EXISTS (
        SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid AND n.nspname IN ('public','demo','mock_platform','sync_host','commerce')) OR EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname IN ('demo','mock_platform','sync_host','commerce')))) AS safe`,
    [
      `shopmate_mock_source_${mode}`,
      [
        "Organization",
        "OrganizationMember",
        "Workspace",
        "WorkspaceMember",
        "Store",
        "DemoTenant",
        "TenantBootstrapEnvironment",
        "PlatformConnection",
      ],
      mode === "reader" ? "shopmate_mock_source_worker" : "shopmate_mock_source_reader",
    ],
  );
  if (result.rowCount !== 1 || result.rows[0]?.safe !== true)
    throw new SourceStorageError("SOURCE_CREDENTIALS");
}
