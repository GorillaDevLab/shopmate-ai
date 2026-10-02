import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const VERSION = "1";
const KEY_LENGTH = 64;
const N = 16_384;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  validatePassword(password);

  const salt = randomBytes(16);
  const digest = derive(password, salt);

  return [
    "scrypt",
    VERSION,
    String(N),
    String(R),
    String(P),
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (typeof password !== "string" || typeof encoded !== "string") {
    return false;
  }

  const parts = encoded.split("$");
  if (parts.length !== 7) return false;

  const [algorithm, version, rawN, rawR, rawP, rawSalt, rawDigest] = parts;

  if (algorithm !== "scrypt" || version !== VERSION) return false;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  if (n !== N || r !== R || p !== P) return false;

  try {
    const salt = Buffer.from(rawSalt, "base64url");
    const expected = Buffer.from(rawDigest, "base64url");

    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;

    const actual = derive(password, salt);

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: 64 * 1024 * 1024,
  });
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new Error("密码长度必须为 8 至 128 个字符");
  }
}
