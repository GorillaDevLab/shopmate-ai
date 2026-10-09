import { createHash } from "node:crypto";
import { CursorSchema, type ReadOptions } from "@shopmate/contracts";
import { z } from "zod";
import { MockConnectorError } from "./mock-call.js";
import {
  PersistentSourceScopeSchema,
  PersistentSourceVersionSchema,
  mapPersistentSourceVersion,
  type PersistentSourceRecord,
} from "./persistent-source-mapping.js";

export type PersistentScope = z.infer<typeof PersistentSourceScopeSchema>;
export type PersistentKind = PersistentSourceRecord["kind"];
export type { PersistentSourceRecord } from "./persistent-source-mapping.js";
export interface PersistentReadRequest {
  readonly kind: PersistentKind;
  readonly requestedUntil: string;
  readonly businessNow: string;
  readonly limit: number;
  readonly contextHash: string;
  readonly cursor?: string;
  readonly entityKey?: readonly string[];
}
/** Server-only composition must use the authorized certificate-validating latest reader.
 * The port pins publication and effectiveUntil in a signed, stateless continuation. DTO
 * validation below does not replace the reader's certificate verification or SQL RLS.
 */
export interface PersistentReadPort {
  read(request: PersistentReadRequest, options: ReadOptions): Promise<unknown | null>;
}
export interface PersistentReadBinder {
  bind(
    actor: { readonly userId: string; readonly merchantId: string },
    scope: PersistentScope,
  ): PersistentReadPort;
}
const utc = z.iso
  .datetime({ precision: 3 })
  .refine((value) => !value.startsWith("0000") && new Date(value).toISOString() === value);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const PublicationSchema = z.strictObject({
  scope: PersistentSourceScopeSchema,
  revision: uint.refine((value) => value !== "0"),
  targetClockRevision: z.number().int().min(0).max(2147483647),
  targetTime: utc,
  baseRevision: uint,
  baseHighEventSeq: uint,
  highEventSeq: uint,
  eventCount: uint,
  versionCount: uint,
  processedThrough: utc,
  generatorVersion: z.literal("mock-source-v1"),
  runtimeVersion: z.literal("mock-runtime-v2"),
  codec: z.literal("source-snapshot-v1"),
  publishedAt: utc,
  certificateHash: hash,
});
const PageSchema = z.strictObject({
  publication: PublicationSchema,
  items: z.array(PersistentSourceVersionSchema).max(32),
  nextCursor: CursorSchema.nullable(),
  effectiveUntil: utc,
});
export interface PersistentPage {
  readonly items: readonly PersistentSourceRecord[];
  readonly nextCursor: string | null;
  readonly effectiveUntil: string;
}
export function persistentContext(values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function validatePersistentPage(
  input: unknown,
  scope: PersistentScope,
  request: PersistentReadRequest,
): PersistentPage {
  if (input === null) throw new MockConnectorError("TEMPORARY");
  const parsed = PageSchema.safeParse(input);
  if (!parsed.success) throw new MockConnectorError("INVALID_RESPONSE");
  const page = parsed.data;
  validateEvidence(page, scope, request);
  if (page.publication.processedThrough < page.effectiveUntil)
    throw new MockConnectorError("TEMPORARY");
  const items = page.items.map((item) => {
    const mapped = mapPersistentSourceVersion(scope, item);
    if (
      !mapped.ok ||
      mapped.data.kind !== request.kind ||
      (request.entityKey &&
        JSON.stringify(JSON.parse(item.entityKey)) !== JSON.stringify(request.entityKey))
    )
      throw new MockConnectorError("INVALID_RESPONSE");
    return mapped.data;
  });
  return { items, nextCursor: page.nextCursor, effectiveUntil: page.effectiveUntil };
}
function validateEvidence(
  page: z.infer<typeof PageSchema>,
  scope: PersistentScope,
  request: PersistentReadRequest,
): void {
  const publication = page.publication;
  const sameScope = Object.entries(scope).every(
    ([key, value]) => publication.scope[key as keyof PersistentScope] === value,
  );
  if (
    !sameScope ||
    page.items.length > Math.min(request.limit, 32) ||
    page.effectiveUntil > request.requestedUntil ||
    page.effectiveUntil > request.businessNow ||
    (!request.cursor &&
      page.effectiveUntil !==
        (request.requestedUntil < request.businessNow
          ? request.requestedUntil
          : request.businessNow)) ||
    publication.processedThrough !== publication.targetTime ||
    BigInt(publication.baseRevision) >= BigInt(publication.revision) ||
    BigInt(publication.baseHighEventSeq) > BigInt(publication.highEventSeq) ||
    page.items.some(
      (item) =>
        item.occurredAt > page.effectiveUntil ||
        BigInt(item.eventSeq) > BigInt(publication.highEventSeq) ||
        BigInt(item.releaseRevision) > BigInt(publication.revision),
    )
  )
    throw new MockConnectorError("INVALID_RESPONSE");
}
