import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { isolatedPostgres } from "../helpers/isolated-postgres.mjs";

const root = new URL("../../", import.meta.url);
const migrations = new URL("prisma/migrations/", root);
const foundation = "20261003000000_tenant_foundation";

async function withFreshDatabase(callback) {
  const server = await isolatedPostgres();
  const admin = new pg.Client({ connectionString: server.url });
  await admin.connect();
  // PostgreSQL cannot bind identifiers; this name is generated locally, never supplied by a user.
  const name = `shopmate_tenant_test_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(server.url);
    url.pathname = `/${name}`;
    await callback(url.toString());
  } finally {
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    await server.stop();
  }
}

function prisma(url, arguments_) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/prisma/build/index.js", root)), ...arguments_],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

test("Prisma deploy installs the complete migration history into an empty PostgreSQL database", async () => {
  await withFreshDatabase(async (url) => {
    prisma(url, ["migrate", "deploy"]);
    assert.match(
      prisma(url, [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
        "--script",
      ]),
      /empty migration/u,
    );
  });
});

test("tenant upgrade stops atomically on preexisting cross-merchant SKU ownership", async () => {
  await withFreshDatabase(async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      for (const name of (await readdir(migrations))
        .filter((value) => /^\d{14}_/u.test(value))
        .sort()) {
        if (name >= foundation) continue;
        await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
      }
      for (const id of ["a", "b"])
        await client.query(
          'INSERT INTO "Merchant" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
          [id],
        );
      await client.query(
        'INSERT INTO "Product" (id,"merchantId",name,price,"updatedAt") VALUES ($1,$2,$1,59,now())',
        ["product-b", "b"],
      );
      await client.query(
        'INSERT INTO "Sku" (id,"merchantId","productId",code,cost,"updatedAt") VALUES ($1,$2,$3,$1,20,now())',
        ["bad-sku", "a", "product-b"],
      );
      await assert.rejects(
        client.query(await readFile(new URL(`${foundation}/migration.sql`, migrations), "utf8")),
        (error) => error.code === "23514",
      );
      await client.query("ROLLBACK");
      assert.equal(
        (await client.query("SELECT to_regclass($1) AS relation", ['public."Organization"']))
          .rows[0].relation,
        null,
      );
      assert.equal(
        (await client.query('SELECT "merchantId" FROM "Sku" WHERE id=$1', ["bad-sku"])).rows[0]
          .merchantId,
        "a",
      );
    } finally {
      await client.end();
    }
  });
});
