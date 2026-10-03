import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const source = await import("../dist/src/mock-platform/index.js").catch(() => null);
const scope = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: "store",
  sessionId: "session",
  connectionId: "connection",
  externalStoreId: "mock/store.1",
  generation: 0,
};

test("dedicated source factories exist without normal index exports", async () => {
  assert.equal(typeof source?.createMockSourceReader, "function");
  assert.equal(typeof source?.createMockSourceWorker, "function");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.exports["./mock-platform"]);
  assert.doesNotMatch(
    await readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    /mock-platform/u,
  );
});

test("missing, fallback and malformed source URLs fail without leaking secrets", () => {
  assert.ok(source, "source port must exist");
  for (const env of [
    {},
    { DATABASE_URL: "postgresql://secret:token@host/db" },
    { MOCK_PLATFORM_READ_DATABASE_URL: "https://secret:token@host/db" },
  ]) {
    assert.throws(
      () => source.createMockSourceReader(env),
      (e) => e.code === "SOURCE_CONFIGURATION" && !/secret|token/u.test(e.message),
    );
  }
});

test("strict invalid inputs fail before an unreachable database is contacted", async () => {
  assert.ok(source, "source port must exist");
  const env = {
    MOCK_PLATFORM_READ_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  };
  const reader = source.createMockSourceReader(env);
  const worker = source.createMockSourceWorker(env);
  try {
    for (const bad of [
      null,
      [],
      { userId: "u" },
      { userId: "bad space", merchantId: "m" },
      { userId: "u", merchantId: "m", bypass: true },
    ])
      await assert.rejects(reader.findGeneration(bad, scope), (e) => e.code === "SOURCE_INPUT");
    for (const bad of [
      null,
      [],
      { ...scope, generation: -1 },
      { ...scope, generation: 2147483648 },
      { ...scope, generation: 1.1 },
      { ...scope, organizationId: "bad space" },
      { ...scope, externalStoreId: "\n" },
      { ...scope, externalStoreId: "x".repeat(201) },
      { ...scope, extra: true },
    ])
      await assert.rejects(
        reader.findGeneration({ userId: "u", merchantId: "m" }, bad),
        (e) => e.code === "SOURCE_INPUT",
      );
    for (const actor of [{}, { grantId: "g", userId: "u" }, { grantId: "bad space" }])
      await assert.rejects(
        worker.initializeGeneration(actor, scope),
        (e) => e.code === "SOURCE_INPUT",
      );
  } finally {
    await reader.close();
    await worker.close();
  }
});

test("unreachable storage errors contain a source code without connection payloads", async () => {
  assert.ok(source, "source port must exist");
  const reader = source.createMockSourceReader({
    MOCK_PLATFORM_READ_DATABASE_URL: "postgresql://source:private-secret@127.0.0.1:1/test",
  });
  try {
    await assert.rejects(
      reader.findGeneration({ userId: "u", merchantId: "m" }, scope),
      (e) =>
        e.code === "SOURCE_STORAGE" && e.message === "SOURCE_STORAGE" && !Object.hasOwn(e, "cause"),
    );
  } finally {
    await reader.close();
  }
});

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) result.push(...(await files(child)));
    else if (/\.(?:ts|tsx|mjs)$/u.test(entry.name)) result.push(child);
  }
  return result;
}

test("normal domain modules cannot import the privileged source subpath", async () => {
  for (const directory of ["../../../apps/api/src/", "../../../apps/web/src/", "../src/"]) {
    for (const file of await files(new URL(directory, import.meta.url))) {
      if (file.pathname.includes("/mock-platform/")) continue;
      const code = await readFile(file, "utf8");
      assert.doesNotMatch(
        code,
        /(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*mock-platform/u,
        file.pathname,
      );
    }
  }
});
