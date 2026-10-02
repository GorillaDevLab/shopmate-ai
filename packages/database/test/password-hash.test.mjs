import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "../src/password-hash.ts";

test("scrypt password hash verifies the original password", () => {
  const encoded = hashPassword("DemoPassword-123");

  assert.match(encoded, /^scrypt\$1\$16384\$8\$1\$/);
  assert.equal(verifyPassword("DemoPassword-123", encoded), true);
  assert.equal(verifyPassword("WrongPassword-123", encoded), false);
});

test("same password receives a different random salt", () => {
  const first = hashPassword("DemoPassword-123");
  const second = hashPassword("DemoPassword-123");

  assert.notEqual(first, second);
  assert.equal(verifyPassword("DemoPassword-123", first), true);
  assert.equal(verifyPassword("DemoPassword-123", second), true);
});

test("malformed hashes are rejected safely", () => {
  for (const encoded of [
    "",
    "plain-text-password",
    "scrypt$1$16384$8$1$bad",
    "scrypt$2$16384$8$1$abc$def",
  ]) {
    assert.equal(verifyPassword("DemoPassword-123", encoded), false);
  }
});

test("password length is bounded", () => {
  assert.throws(() => hashPassword("short"), /8 至 128/);
  assert.throws(() => hashPassword("x".repeat(129)), /8 至 128/);
});
