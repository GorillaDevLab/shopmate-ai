import assert from "node:assert/strict";
import pg from "pg";
import { URL } from "node:url";
import { isolatedPostgres } from "./isolated-postgres.mjs";
import { loginUrl, migrateSource, sourceEnv, sourceFixtures } from "./mock-platform-fixture.mjs";
import { maintenanceClient } from "./mock-source-control-fixture.mjs";

const portDatabases = {
  hydration: {
    name: "shopmate_tenant_test_hydration_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_hydration_ports"',
  },
  publish: {
    name: "shopmate_tenant_test_publish_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_publish_ports"',
  },
  lease: {
    name: "shopmate_tenant_test_lease_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_lease_ports"',
  },
  append: {
    name: "shopmate_tenant_test_append_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_append_ports"',
  },
  scan: {
    name: "shopmate_tenant_test_scan_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_scan_ports"',
  },
  latest: {
    name: "shopmate_tenant_test_latest_ports",
    sql: 'CREATE DATABASE "shopmate_tenant_test_latest_ports"',
  },
};

export async function leasePortDatabase(source, suite = "lease") {
  assert.ok(Object.hasOwn(portDatabases, suite), "Known isolated source port suite required");
  const database = portDatabases[suite];
  const server = await isolatedPostgres();
  const operator = new pg.Client({ connectionString: server.url });
  await operator.connect();
  await operator.query(database.sql);
  const url = new URL(server.url);
  url.pathname = `/${database.name}`;
  const rawAdmin = new pg.Client({ connectionString: url.toString() });
  const rawWorker = new pg.Client({
    connectionString: loginUrl(url.toString(), "source_worker_login"),
  });
  await rawAdmin.connect();
  await migrateSource(rawAdmin);
  await sourceFixtures(rawAdmin);
  await rawWorker.connect();
  const admin = maintenanceClient(rawAdmin, "source-human");
  const env = sourceEnv(url.toString());
  return {
    server,
    operator,
    rawAdmin,
    admin,
    rawWorker,
    env,
    worker: source.createMockSourceWorker(env),
  };
}

export async function closeLeasePortDatabase(context) {
  const results = await Promise.allSettled([
    context.worker.close(),
    context.rawWorker.end(),
    context.rawAdmin.end(),
    context.operator.end(),
  ]);
  await context.server.stop();
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export async function jobSnapshot(admin, scope) {
  const result = await admin.query(
    'SELECT to_jsonb(j) AS job FROM mock_platform."BuildJob" j WHERE "sessionId"=$1 AND generation=$2 ORDER BY revision',
    [scope.sessionId, scope.generation],
  );
  return result.rows.map((row) => row.job);
}

export async function waitForLeaseExpiry(admin, lease) {
  await admin.query("SET statement_timeout='40s'");
  try {
    const result = await admin.query(
      `SELECT mock_platform.canonical_utc("leaseUntil") AS deadline,
        pg_sleep(GREATEST(0,extract(epoch FROM "leaseUntil"-clock_timestamp()))+0.01)
       FROM mock_platform."BuildJob" WHERE "sessionId"=$1 AND generation=$2 AND revision=$3`,
      [lease.scope.sessionId, lease.scope.generation, lease.revision],
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].deadline, lease.leaseUntil);
    const expired = await admin.query(
      'SELECT "leaseUntil"<=clock_timestamp() AS expired FROM mock_platform."BuildJob" WHERE "sessionId"=$1 AND generation=$2 AND revision=$3',
      [lease.scope.sessionId, lease.scope.generation, lease.revision],
    );
    assert.equal(expired.rows[0].expired, true);
  } finally {
    await admin.query("RESET statement_timeout");
  }
}

export async function publishForIdle(admin, scope) {
  await admin.query('ALTER TABLE mock_platform."BuildJob" DISABLE TRIGGER ALL');
  try {
    await admin.query(
      `UPDATE mock_platform."BuildJob" SET state='PUBLISHED',"publishedAt"=clock_timestamp(),
        "certificateHash"=repeat('a',64) WHERE "sessionId"=$1 AND generation=$2`,
      [scope.sessionId, scope.generation],
    );
  } finally {
    await admin.query('ALTER TABLE mock_platform."BuildJob" ENABLE TRIGGER ALL');
  }
}

export async function deferredFailure(admin, code, action) {
  assert.ok(
    ["SM001", "SM002", "SM003", "SM004", "SM005", "23514", "40P01", "57014", "ZZ999"].includes(
      code,
    ),
  );
  await admin.query(`CREATE FUNCTION mock_platform.test_lease_port_commit() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'Deferred lease port fixture' USING ERRCODE='${code}'; END $$`);
  try {
    await admin.query(`CREATE CONSTRAINT TRIGGER aaa_test_lease_port_commit AFTER UPDATE
      ON mock_platform."BuildJob" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION mock_platform.test_lease_port_commit()`);
    return await action();
  } finally {
    await admin.query(
      'DROP TRIGGER IF EXISTS aaa_test_lease_port_commit ON mock_platform."BuildJob"',
    );
    await admin.query("DROP FUNCTION mock_platform.test_lease_port_commit()");
  }
}

async function installExpiryFunctions(admin) {
  await admin.query(`CREATE FUNCTION mock_platform.test_allow_expiry_wait() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN PERFORM set_config('statement_timeout','40s',true); RETURN NEW; END $$`);
  await admin.query(`CREATE FUNCTION mock_platform.test_wait_lease_expiry() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN
      IF NEW."leaseUntil"-clock_timestamp() NOT BETWEEN interval '29 seconds' AND interval '30 seconds'
        THEN RAISE EXCEPTION 'Fixture requires the unchanged thirty-second lease'; END IF;
      PERFORM pg_catalog.pg_sleep(GREATEST(0,extract(epoch FROM NEW."leaseUntil"-clock_timestamp()))+0.01);
      IF NEW."leaseUntil">clock_timestamp() THEN RAISE EXCEPTION 'Fixture deadline was not reached'; END IF;
      RETURN NEW;
    END $$`);
}

async function installExpiryTriggers(admin) {
  // Only the isolated COMMIT timeout changes; the reviewed lease and live checks stay intact.
  await admin.query(`CREATE TRIGGER zzz_test_allow_expiry_wait BEFORE UPDATE
    ON mock_platform."BuildJob" FOR EACH ROW EXECUTE FUNCTION mock_platform.test_allow_expiry_wait()`);
  await admin.query(`CREATE CONSTRAINT TRIGGER aaa_test_wait_lease_expiry AFTER UPDATE
    ON mock_platform."BuildJob" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION mock_platform.test_wait_lease_expiry()`);
}

async function removeExpiryHooks(admin) {
  await admin.query(
    'DROP TRIGGER IF EXISTS aaa_test_wait_lease_expiry ON mock_platform."BuildJob"',
  );
  await admin.query(
    'DROP TRIGGER IF EXISTS zzz_test_allow_expiry_wait ON mock_platform."BuildJob"',
  );
  await admin.query("DROP FUNCTION IF EXISTS mock_platform.test_wait_lease_expiry()");
  await admin.query("DROP FUNCTION IF EXISTS mock_platform.test_allow_expiry_wait()");
}

export async function deferredLeaseExpiry(admin, action) {
  try {
    await installExpiryFunctions(admin);
    await installExpiryTriggers(admin);
    return await action();
  } finally {
    await removeExpiryHooks(admin);
  }
}
