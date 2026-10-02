import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";

export function requireIsolatedDatabaseUrl(value) {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !/^\/shopmate_tenant_test(?:_[a-z0-9]+)?$/u.test(url.pathname)
  ) {
    throw new Error("Tenant tests require a loopback shopmate_tenant_test database");
  }
  return value;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  return address.port;
}

function runPostgres(bin, program, args) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  // A detached PostgreSQL process can keep Windows pipe handles open after pg_ctl exits.
  execFileSync(path.join(bin, program + suffix), args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 45_000,
  });
}

async function startLocalPostgres() {
  const bin =
    process.env.PG_BIN ??
    (process.platform === "win32" ? "C:/Program Files/PostgreSQL/16/bin" : "");
  if (!bin || !existsSync(path.join(bin, process.platform === "win32" ? "initdb.exe" : "initdb"))) {
    throw new Error(
      "Set TEST_DATABASE_URL to an isolated database or PG_BIN to PostgreSQL binaries",
    );
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "shopmate-tenant-pg-"));
  const data = path.join(directory, "data");
  const port = await unusedPort();
  try {
    runPostgres(bin, "initdb", [
      "-D",
      data,
      "-U",
      "tenant_test_admin",
      "--auth=trust",
      "--locale=C",
      "--encoding=UTF8",
    ]);
    runPostgres(bin, "pg_ctl", [
      "-D",
      data,
      "-l",
      path.join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ]);
    const admin = new pg.Client({
      connectionString: `postgresql://tenant_test_admin@127.0.0.1:${port}/postgres`,
    });
    await admin.connect();
    try {
      await admin.query('CREATE DATABASE "shopmate_tenant_test"');
    } finally {
      await admin.end();
    }
    return {
      url: `postgresql://tenant_test_admin@127.0.0.1:${port}/shopmate_tenant_test`,
      stop: () => stopLocalPostgres(bin, data, directory),
    };
  } catch (error) {
    await stopLocalPostgres(bin, data, directory);
    throw error;
  }
}

async function removeTestDirectory(directory) {
  const absolute = path.resolve(directory);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith("shopmate-tenant-pg-")
  ) {
    throw new Error("Refusing to remove a path outside the temporary PostgreSQL test directory");
  }
  await rm(absolute, { recursive: true, force: true });
}

async function stopLocalPostgres(bin, data, directory) {
  if (existsSync(path.join(data, "postmaster.pid"))) {
    runPostgres(bin, "pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  }
  await removeTestDirectory(directory);
}

export async function isolatedPostgres() {
  if (!process.env.TEST_DATABASE_URL) return startLocalPostgres();
  return { url: requireIsolatedDatabaseUrl(process.env.TEST_DATABASE_URL), stop: async () => {} };
}
