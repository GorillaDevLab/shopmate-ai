import { URL } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSource = await readFile(
  new URL("../src/client.ts", import.meta.url),
  "utf8",
);

const indexSource = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

test("Prisma Client uses a shared lifecycle instance", () => {
  assert.match(clientSource, /shopmatePrisma\?: PrismaClient/);
  assert.match(clientSource, /if \(!prismaGlobal\.shopmatePrisma\)/);
  assert.match(clientSource, /return prismaGlobal\.shopmatePrisma/);
});

test("Prisma Client can be disconnected and cleared", () => {
  assert.match(clientSource, /\$disconnect\(\)/);
  assert.match(clientSource, /shopmatePrisma = undefined/);
});

test("database public API does not expose Prisma internals", () => {
  assert.match(indexSource, /getPrismaClient/);
  assert.match(indexSource, /disconnectPrismaClient/);

  assert.doesNotMatch(
    indexSource,
    /from\s+["']@prisma\/client["']/,
  );

  assert.doesNotMatch(
    indexSource,
    /@prisma\/adapter-pg/,
  );

  assert.doesNotMatch(
    indexSource,
    /generated\/prisma/,
  );
});
