import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AuditTenantScopeSchema,
  TenantAuditEntrySchema,
  type TenantAuditEntry,
} from "@shopmate/contracts";

/** v1 = lowercase hex SHA-256(UTF8(domain) || AuditCanonicalBytes.encode(unsignedEntry)). */
export const AUDIT_HASH_DOMAIN = "shopmate.audit.entry.v1\0";
export const AUDIT_HASH_LIMITS = Object.freeze({
  entries: 100,
  bytes: 2_097_152,
  nodes: 24_000,
  depth: 24,
});
export type AuditUnsignedEntry = Omit<TenantAuditEntry, "entryHash">;
type Scope = TenantAuditEntry["scope"];
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Budget = { nodes: number; bytes: number };
const placeholderHash = "0".repeat(64);

export class AuditCanonicalInputError extends Error {
  constructor() {
    super("Invalid audit canonical input");
    this.name = "AuditCanonicalInputError";
  }
}

function reject(): never {
  throw new AuditCanonicalInputError();
}

function boundedCopy(value: unknown, budget: Budget, depth = 0): Json {
  if (++budget.nodes > AUDIT_HASH_LIMITS.nodes || depth > AUDIT_HASH_LIMITS.depth) reject();
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    if (budget.bytes > AUDIT_HASH_LIMITS.bytes) reject();
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) return reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) reject();
  return copyProperties(value, budget, depth);
}

function copyProperties(value: object, budget: Budget, depth: number): Json {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > AUDIT_HASH_LIMITS.nodes - budget.nodes) reject();
  const pairs: [string, Json][] = [];
  for (const key of keys) {
    if (typeof key !== "string") reject();
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) reject();
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable) reject();
    budget.bytes += Buffer.byteLength(key, "utf8");
    if (budget.bytes > AUDIT_HASH_LIMITS.bytes) reject();
    pairs.push([key, boundedCopy(descriptor.value, budget, depth + 1)]);
  }
  if (!Array.isArray(value)) return Object.fromEntries(pairs);
  if (pairs.length !== value.length || pairs.some(([key], index) => key !== String(index)))
    reject();
  return pairs.map(([, item]) => item);
}

function safeCopy(value: unknown): Json {
  try {
    return boundedCopy(value, { nodes: 0, bytes: 0 });
  } catch {
    return reject();
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? reject() : encoded;
}

/** Exact strict v1 tenant entry minus entryHash. Keys use UTF-16 code unit order;
 * arrays retain order, strings/opaque IDs retain their original code points. */
export class AuditCanonicalBytes {
  encode(input: unknown): Uint8Array {
    const value = safeCopy(input);
    if (value === null || typeof value !== "object" || Array.isArray(value) || "entryHash" in value)
      reject();
    const parsed = TenantAuditEntrySchema.safeParse({ ...value, entryHash: placeholderHash });
    if (!parsed.success) reject();
    const { entryHash: excluded, ...unsigned } = parsed.data;
    void excluded;
    return Buffer.from(canonicalJson(unsigned), "utf8");
  }
}

/** P09-004 writer seam: pass exact unsigned entry, store the returned lowercase 64-hex. */
export function hashAuditEntry(input: unknown): string {
  return createHash("sha256")
    .update(AUDIT_HASH_DOMAIN, "utf8")
    .update(new AuditCanonicalBytes().encode(input))
    .digest("hex");
}

export type AuditCheckpoint = Readonly<{
  scope: Scope;
  sequence: number;
  entryHash: string | null;
  hashVersion: 1;
}>;
/** Read-only predecessor anchor for this exact authorized scope. Genesis = 0/null.
 * This port supplies no independent signature or identity/nonrepudiation proof. */
export interface AuditCheckpointPort {
  read(scope: Scope): Promise<unknown>;
}
type Proof = { readonly proof: "LOCAL_ONLY" };
type Diagnostic =
  | {
      status: "LOCAL_CONSISTENT";
      checkedEntries: number;
      startSequence: number;
      endSequence: number;
    }
  | {
      status: "INSUFFICIENT_VISIBILITY";
      reason: "PARTIAL" | "EMPTY_CHAIN";
      checkedEntries: number;
    }
  | { status: "MALFORMED_INPUT"; reason: "SHAPE" | "SCOPE_MISMATCH" | "ENTRY_ORDER" }
  | {
      status: "UNSUPPORTED_VERSION";
      source: "ENTRY" | "CHECKPOINT";
      hashVersion: number;
      index?: number;
    }
  | { status: "ENTRY_HASH_MISMATCH" | "PREDECESSOR_MISMATCH" | "SEQUENCE_GAP"; index: number }
  | { status: "CHECKPOINT_MISSING" | "CHECKPOINT_MISMATCH" | "CHECKPOINT_UNAVAILABLE" };
export type AuditHashVerification = Proof & Diagnostic;
const requestSchema = z.strictObject({
  scope: AuditTenantScopeSchema,
  entries: z.array(z.unknown()).max(AUDIT_HASH_LIMITS.entries),
  chainVisibility: z.enum(["FULL", "PARTIAL"]),
});
const checkpointSchema = z
  .strictObject({
    scope: AuditTenantScopeSchema,
    sequence: z.number().int().nonnegative().safe(),
    entryHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    hashVersion: z.literal(1),
  })
  .refine((value) => (value.sequence === 0) === (value.entryHash === null));
type Request = z.infer<typeof requestSchema>;

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.storeId === right.storeId
  );
}

function unknownVersion(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || !("hashVersion" in value)) return undefined;
  return typeof value.hashVersion === "number" &&
    Number.isSafeInteger(value.hashVersion) &&
    value.hashVersion !== 1
    ? value.hashVersion
    : undefined;
}

function parseEntries(request: Request): TenantAuditEntry[] | AuditHashVerification {
  const entries: TenantAuditEntry[] = [];
  for (const [index, raw] of request.entries.entries()) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("scopeKind" in raw) ||
      raw.scopeKind !== "TENANT"
    )
      return result({ status: "MALFORMED_INPUT", reason: "SHAPE" });
    const hashVersion = unknownVersion(raw);
    if (hashVersion !== undefined)
      return result({ status: "UNSUPPORTED_VERSION", source: "ENTRY", index, hashVersion });
    const parsed = TenantAuditEntrySchema.safeParse(raw);
    if (!parsed.success) return result({ status: "MALFORMED_INPUT", reason: "SHAPE" });
    if (!sameScope(parsed.data.scope, request.scope))
      return result({ status: "MALFORMED_INPUT", reason: "SCOPE_MISMATCH" });
    const { entryHash, ...unsigned } = parsed.data;
    if (hashAuditEntry(unsigned) !== entryHash)
      return result({ status: "ENTRY_HASH_MISMATCH", index });
    entries.push(parsed.data);
  }
  return entries;
}

function result(diagnostic: Diagnostic): AuditHashVerification {
  return { ...diagnostic, proof: "LOCAL_ONLY" };
}

function checkLinks(entries: TenantAuditEntry[], full: boolean): AuditHashVerification | null {
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    const adjacent = current.sequence === previous.sequence + 1;
    if (full && !adjacent) return result({ status: "SEQUENCE_GAP", index });
    if (!full && current.sequence <= previous.sequence)
      return result({ status: "MALFORMED_INPUT", reason: "ENTRY_ORDER" });
    if (adjacent && current.prevHash !== previous.entryHash)
      return result({ status: "PREDECESSOR_MISMATCH", index });
  }
  return null;
}

/** Validates supplied order without sorting/relinking; never proves whole historical completeness. */
export class AuditHashVerifier {
  constructor(private readonly checkpoints: AuditCheckpointPort) {}

  async verify(input: unknown): Promise<AuditHashVerification> {
    let request: Request;
    try {
      const parsed = requestSchema.safeParse(safeCopy(input));
      if (!parsed.success) return result({ status: "MALFORMED_INPUT", reason: "SHAPE" });
      request = parsed.data;
    } catch {
      return result({ status: "MALFORMED_INPUT", reason: "SHAPE" });
    }
    const entries = parseEntries(request);
    if (!Array.isArray(entries)) return entries;
    if (!entries.length)
      return result({
        status: "INSUFFICIENT_VISIBILITY",
        reason: "EMPTY_CHAIN",
        checkedEntries: 0,
      });
    const links = checkLinks(entries, request.chainVisibility === "FULL");
    if (links) return links;
    if (request.chainVisibility === "PARTIAL")
      return result({
        status: "INSUFFICIENT_VISIBILITY",
        reason: "PARTIAL",
        checkedEntries: entries.length,
      });
    return this.checkAnchor(request.scope, entries);
  }

  private async checkAnchor(
    scope: Scope,
    entries: TenantAuditEntry[],
  ): Promise<AuditHashVerification> {
    let raw: Json;
    try {
      raw = safeCopy(await this.checkpoints.read(Object.freeze({ ...scope })));
    } catch {
      return result({ status: "CHECKPOINT_UNAVAILABLE" });
    }
    if (raw === null) return result({ status: "CHECKPOINT_MISSING" });
    const hashVersion = unknownVersion(raw);
    if (hashVersion !== undefined)
      return result({ status: "UNSUPPORTED_VERSION", source: "CHECKPOINT", hashVersion });
    const parsed = checkpointSchema.safeParse(raw);
    if (!parsed.success || !sameScope(parsed.data.scope, scope))
      return result({ status: "CHECKPOINT_MISMATCH" });
    const first = entries[0]!;
    if (parsed.data.sequence !== first.sequence - 1)
      return result({ status: "CHECKPOINT_MISMATCH" });
    if (parsed.data.entryHash !== first.prevHash) return result({ status: "CHECKPOINT_MISMATCH" });
    return result({
      status: "LOCAL_CONSISTENT",
      checkedEntries: entries.length,
      startSequence: first.sequence,
      endSequence: entries.at(-1)!.sequence,
    });
  }
}
