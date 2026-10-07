import { createHmac, timingSafeEqual } from "node:crypto";
import { SourceStorageError } from "./errors.js";
import type { SourceScope } from "./types.js";
import { exact, integer, scopeKeys, validateScope } from "./validation.js";

export interface ScanCursorState {
  readonly scope: SourceScope;
  readonly certificateHash: string;
  readonly revision: string;
  readonly highEventSeq: string;
  readonly since: string;
  readonly until: string;
  readonly after: {
    readonly kind: string;
    readonly entityKey: string;
    readonly eventSeq: string;
  } | null;
  readonly expiresAt: number;
}

const fields = [
  "scope",
  "certificateHash",
  "revision",
  "highEventSeq",
  "since",
  "until",
  "after",
  "expiresAt",
];
const kinds = ["STORE", "PRODUCT", "ORDER", "REFUND", "INVENTORY", "MARKETING"];
const unsigned = /^(0|[1-9][0-9]*)$/u;
const hash = /^[a-f0-9]{64}$/u;
const part = /^[A-Za-z0-9_-]+$/u;
const MAX_AGE_MS = 15 * 60_000;

function invalid(): never {
  throw new SourceStorageError("SOURCE_INPUT");
}

function secret(key: string): Buffer {
  if (
    typeof key !== "string" ||
    Buffer.byteLength(key, "utf8") < 32 ||
    Buffer.byteLength(key, "utf8") > 4096
  )
    throw new SourceStorageError("SOURCE_CONFIGURATION");
  return Buffer.from(key, "utf8");
}

export function validateScanKey(key: string): void {
  secret(key);
}

function validUInt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    unsigned.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9223372036854775807n
  );
}

function validUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validAfter(value: unknown): boolean {
  if (value === null) return true;
  if (!exact(value, ["kind", "entityKey", "eventSeq"])) return false;
  return (
    kinds.includes(value.kind as string) &&
    typeof value.entityKey === "string" &&
    value.entityKey.length > 0 &&
    value.entityKey.length <= 1024 &&
    validUInt(value.eventSeq)
  );
}

function checkedState(value: unknown, now: number): ScanCursorState {
  if (!exact(value, fields) || !Number.isSafeInteger(now)) invalid();
  validateScope(value.scope);
  if (
    typeof value.certificateHash !== "string" ||
    !hash.test(value.certificateHash) ||
    !validUInt(value.revision) ||
    value.revision === "0" ||
    !validUInt(value.highEventSeq) ||
    !validUtc(value.since) ||
    !validUtc(value.until) ||
    value.since > value.until ||
    !validAfter(value.after) ||
    !integer(value.expiresAt, now + 1, now + MAX_AGE_MS)
  )
    invalid();
  return value as unknown as ScanCursorState;
}

function digest(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload, "ascii").digest();
}

export function createScanCursor(key: string, state: ScanCursorState, now = Date.now()): string {
  const signingKey = secret(key);
  const checked = checkedState(state, now);
  const payload = Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
  const token = `${payload}.${digest(signingKey, payload).toString("base64url")}`;
  if (token.length > 4096) invalid();
  return token;
}

function decoded(token: string, key: Buffer): unknown {
  if (typeof token !== "string" || token.length > 4096) invalid();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((value) => part.test(value))) invalid();
  const [payload, signature] = parts;
  const bytes = Buffer.from(signature, "base64url");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64url") !== signature ||
    !timingSafeEqual(bytes, digest(key, payload))
  )
    invalid();
  const data = Buffer.from(payload, "base64url");
  if (data.toString("base64url") !== payload) invalid();
  try {
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return invalid();
  }
}

export function readScanCursor(
  key: string,
  cursor: string,
  scope: SourceScope,
  now = Date.now(),
): ScanCursorState {
  validateScope(scope);
  const state = checkedState(decoded(cursor, secret(key)), now);
  if (!scopeKeys.every((field) => state.scope[field] === scope[field])) invalid();
  return state;
}
