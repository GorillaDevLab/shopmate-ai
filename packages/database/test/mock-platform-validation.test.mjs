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

test("source worker exposes bounded lease operations", async () => {
  const worker = source.createMockSourceWorker({
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  });
  try {
    for (const method of ["claim", "claimSlice", "renew", "fail", "appendChunk", "publish"])
      assert.equal(typeof worker[method], "function", method);
    for (const method of ["findPublication"])
      assert.equal(Object.hasOwn(worker, method), false, method);
  } finally {
    await worker.close();
  }
});

test("append inputs reject before an unreachable database is contacted", async () => {
  const worker = source.createMockSourceWorker({
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  });
  const actor = { grantId: "g" };
  const lease = {
    scope,
    revision: "1",
    fence: "1",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
  };
  const input = {
    expectedCheckpointHash: "a".repeat(64),
    next: { processedThrough: "2026-01-01T00:00:00.000Z", sealed: true },
    events: [],
  };
  try {
    await assert.rejects(worker.appendChunk({}, lease, input), { code: "SOURCE_INPUT" });
    await assert.rejects(worker.appendChunk(actor, null, input), { code: "SOURCE_INPUT" });
    for (const bad of [
      null,
      {},
      { ...input, extra: true },
      { ...input, events: [null] },
      { ...input, next: { ...input.next, extra: true } },
    ])
      await assert.rejects(worker.appendChunk(actor, lease, bad), { code: "SOURCE_INPUT" });
  } finally {
    await worker.close();
  }
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

async function rejectBadReaderActors(reader) {
  for (const bad of [
    null,
    [],
    { userId: "u" },
    { userId: "bad space", merchantId: "m" },
    { userId: "u", merchantId: "m", bypass: true },
  ])
    await assert.rejects(reader.findGeneration(bad, scope), { code: "SOURCE_INPUT" });
}

async function rejectBadScopes(reader) {
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
    await assert.rejects(reader.findGeneration({ userId: "u", merchantId: "m" }, bad), {
      code: "SOURCE_INPUT",
    });
}

test("strict invalid inputs fail before an unreachable database is contacted", async () => {
  assert.ok(source, "source port must exist");
  const env = {
    MOCK_PLATFORM_READ_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  };
  const reader = source.createMockSourceReader(env);
  const worker = source.createMockSourceWorker(env);
  try {
    await rejectBadReaderActors(reader);
    await rejectBadScopes(reader);
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

test("lease inputs reject before an unreachable database is contacted", async () => {
  const worker = source.createMockSourceWorker({
    MOCK_PLATFORM_WORKER_DATABASE_URL: "postgresql://source@127.0.0.1:1/test",
  });
  const actor = { grantId: "g" };
  const lease = {
    scope,
    revision: "1",
    fence: "1",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
  };
  try {
    await assert.rejects(worker.claim({}, scope), { code: "SOURCE_INPUT" });
    await assert.rejects(worker.claim(actor, null), { code: "SOURCE_INPUT" });
    await assert.rejects(worker.claimSlice({}, scope), { code: "SOURCE_INPUT" });
    await assert.rejects(worker.claimSlice(actor, null), { code: "SOURCE_INPUT" });
    for (const bad of [null, [], {}, { ...lease, extra: true }, { ...lease, scope: null }]) {
      await assert.rejects(worker.renew(actor, bad), { code: "SOURCE_INPUT" });
      await assert.rejects(worker.fail(actor, bad, "INTERRUPTED"), { code: "SOURCE_INPUT" });
    }
    await assert.rejects(worker.renew(actor, { ...lease, ownerId: "bad" }), {
      code: "SOURCE_INPUT",
    });
    await assert.rejects(worker.fail(actor, lease, "PRIVATE_MESSAGE"), { code: "SOURCE_INPUT" });
  } finally {
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

const sourceImport = /(?:from\s*|(?:import|require)\s*(?:\(\s*)?)\s*["'][^"']*mock-platform/u;
function withoutBootstrapValidation(code, bootstrap) {
  if (!bootstrap) return code;
  // Bootstrap metadata checks reuse only pure validators, never source I/O or signing codecs.
  return code
    .replace(
      /^import \{ frozenConfiguration \} from "\.\.\/mock-platform\/configuration\.js";\r?$/gmu,
      "",
    )
    .replace(
      /^import \{ exact, integer, validateScope \} from "\.\.\/mock-platform\/validation\.js";\r?$/gmu,
      "",
    )
    .replace(/^import type \{ SourceScope \} from "\.\.\/mock-platform\/types\.js";\r?$/gmu, "");
}
function withoutScenarioValidation(code, scenario) {
  if (!scenario) return code;
  // Management reuses pure frozen-config validation, without worker/read ports or credentials.
  return code
    .replace(
      /^import \{ frozenConfiguration \} from "\.\/mock-platform\/configuration\.js";\r?$/gmu,
      "",
    )
    .replace(/^import \{ SourceStorageError \} from "\.\/mock-platform\/errors\.js";\r?$/gmu, "");
}
function withoutReadComposition(code, provider) {
  if (!provider) return code;
  return code.replace(
    /import\s*\{([^{}]+)\}\s*from\s*["']@shopmate\/database\/mock-platform-read["'];?/gu,
    (statement, names) => {
      const imports = names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .sort();
      assert.deepEqual(imports, ["createMockSourceReadPorts", "type SourceReadPorts"]);
      return "";
    },
  );
}
test("only the server composition module can import the named read-only factory and types", () => {
  const allowed =
    'import { createMockSourceReadPorts, type SourceReadPorts } from "@shopmate/database/mock-platform-read";';
  assert.doesNotMatch(withoutReadComposition(allowed, true), sourceImport);
  assert.match(withoutReadComposition(allowed, false), sourceImport);
  for (const code of [
    'import * as source from "@shopmate/database/mock-platform-read";',
    'import "@shopmate/database/mock-platform-read";',
    'const source = import("@shopmate/database/mock-platform-read");',
    'import { createMockSourceWorker } from "@shopmate/database/mock-platform";',
  ])
    assert.match(withoutReadComposition(code, true), sourceImport);
  assert.throws(() =>
    withoutReadComposition(
      'import { createMockSourceReadPorts, type SourceReadPorts, sourcePool } from "@shopmate/database/mock-platform-read";',
      true,
    ),
  );
});
test("scenario management can reuse only the two named pure validation imports", () => {
  const pure =
    'import { frozenConfiguration } from "./mock-platform/configuration.js";\nimport { SourceStorageError } from "./mock-platform/errors.js";';
  assert.doesNotMatch(withoutScenarioValidation(pure, true), sourceImport);
  assert.match(withoutScenarioValidation(pure, false), sourceImport);
  for (const code of [
    'import { sourcePool } from "./mock-platform/clients.js";',
    'import { createMockSourceWorker } from "./mock-platform/index.js";',
    'import * as validation from "./mock-platform/configuration.js";',
    'import { frozenConfiguration, sourcePool } from "./mock-platform/configuration.js";',
    'const validation = import("./mock-platform/configuration.js");',
  ])
    assert.match(withoutScenarioValidation(code, true), sourceImport);
});
test("bootstrap metadata can reuse only fixed pure validation and scope type imports", () => {
  const pure =
    'import { frozenConfiguration } from "../mock-platform/configuration.js";\nimport { exact, integer, validateScope } from "../mock-platform/validation.js";\nimport type { SourceScope } from "../mock-platform/types.js";';
  assert.doesNotMatch(withoutBootstrapValidation(pure, true), sourceImport);
  assert.match(withoutBootstrapValidation(pure, false), sourceImport);
  for (const code of [
    'import { createMockSourceWorker } from "../mock-platform/index.js";',
    'import { sourcePool } from "../mock-platform/clients.js";',
    'import { encodeCompactLatest } from "../mock-platform/latest-cursor-codec.js";',
    'import { frozenConfiguration, sourcePool } from "../mock-platform/configuration.js";',
    'import * as validation from "../mock-platform/validation.js";',
    'const validation = import("../mock-platform/configuration.js");',
    'import "../mock-platform/types.js";',
  ])
    assert.match(withoutBootstrapValidation(code, true), sourceImport);
});

test("normal domain modules cannot import the privileged source subpath", async () => {
  for (const directory of ["../../../apps/api/src/", "../../../apps/web/src/", "../src/"]) {
    for (const file of await files(new URL(directory, import.meta.url))) {
      if (file.pathname.includes("/mock-platform/")) continue;
      const provider = file.pathname.endsWith(
        "/apps/api/src/demo-commerce/database-persistent-read-ports.ts",
      );
      const scenario = file.pathname.endsWith("/packages/database/src/demo-scenarios.ts");
      const code = withoutBootstrapValidation(
        withoutScenarioValidation(
          withoutReadComposition(await readFile(file, "utf8"), provider),
          scenario,
        ),
        file.pathname.endsWith("/packages/database/src/sync-host/bootstrap.ts"),
      );
      assert.doesNotMatch(code, sourceImport, file.pathname);
    }
  }
});
