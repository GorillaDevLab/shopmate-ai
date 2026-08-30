import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".mts",
  ".cts",
]);

const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".next",
  "coverage",
  "generated",
]);

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (fullPath === path.join(repoRoot, "packages", "database")) {
        continue;
      }

      files.push(...(await collectSourceFiles(fullPath)));
      continue;
    }

    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

test("non-database packages cannot import Prisma internals directly", async () => {
  const files = [
    ...(await collectSourceFiles(path.join(repoRoot, "apps"))),
    ...(await collectSourceFiles(path.join(repoRoot, "packages"))),
  ];

  const violations = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");

    if (
      source.includes("@prisma/client") ||
      source.includes("@prisma/adapter-pg") ||
      source.includes("generated/prisma")
    ) {
      violations.push(path.relative(repoRoot, file));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Prisma internals must only be accessed through @shopmate/database: ${violations.join(", ")}`,
  );
});
