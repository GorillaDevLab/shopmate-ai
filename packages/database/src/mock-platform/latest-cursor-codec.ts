import { createHmac, timingSafeEqual } from "node:crypto";
import { SourceStorageError } from "./errors.js";
import { positiveUInt, validateUtc } from "./record-primitives.js";
import { validateScanKey } from "./scan-cursor.js";
import { exact, integer } from "./validation.js";

export interface CompactLatestState {
  readonly v: 1;
  readonly s: string;
  readonly q: string;
  readonly c: string;
  readonly r: string;
  readonly h: string;
  readonly t: string;
  readonly a: string;
  readonly e: number;
}
const fields = ["v", "s", "q", "c", "r", "h", "t", "a", "e"];
const part = /^[A-Za-z0-9_-]+$/u;
const hash = /^[a-f0-9]{64}$/u;
const digest = /^[A-Za-z0-9_-]{43}$/u;

function invalid(): never {
  throw new SourceStorageError("SOURCE_INPUT");
}

function checked(value: unknown, now: number): CompactLatestState {
  if (!exact(value, fields) || !Number.isSafeInteger(now)) invalid();
  if (
    value.v !== 1 ||
    typeof value.s !== "string" ||
    !digest.test(value.s) ||
    typeof value.q !== "string" ||
    !digest.test(value.q) ||
    typeof value.c !== "string" ||
    !hash.test(value.c) ||
    !positiveUInt(value.r) ||
    !positiveUInt(value.h) ||
    !positiveUInt(value.a) ||
    BigInt(value.a) > BigInt(value.h) ||
    !validateUtc(value.t) ||
    !integer(value.e, now + 1, now + 15 * 60_000)
  )
    invalid();
  return value as unknown as CompactLatestState;
}

function signature(key: string, payload: string): Buffer {
  return createHmac("sha256", key)
    .update("mock-source-latest-compact-v1\n")
    .update(payload, "ascii")
    .digest();
}

export function encodeCompactLatest(key: string, state: CompactLatestState, now: number): string {
  validateScanKey(key);
  const payload = Buffer.from(JSON.stringify(checked(state, now)), "utf8").toString("base64url");
  const token = `${payload}.${signature(key, payload).toString("base64url")}`;
  if (token.length > 1024) invalid();
  return token;
}

function parsed(payload: string): unknown {
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.toString("base64url") !== payload) invalid();
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
}

export function decodeCompactLatest(key: string, token: string, now: number): CompactLatestState {
  validateScanKey(key);
  if (typeof token !== "string" || token.length > 1024) invalid();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((value) => part.test(value))) invalid();
  const [payload, mac] = parts;
  const bytes = Buffer.from(mac, "base64url");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64url") !== mac ||
    !timingSafeEqual(bytes, signature(key, payload))
  )
    invalid();
  return checked(parsed(payload), now);
}
