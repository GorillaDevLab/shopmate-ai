import { ConnectorTimestampSchema, SourceVersionSchema } from "@shopmate/contracts";
import { z } from "zod";

const SourceOrderSchema = z.strictObject({
  version: SourceVersionSchema.nullable(),
  updatedAt: ConnectorTimestampSchema.nullable(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type SourceOrderDecision = "APPLY" | "DUPLICATE" | "STALE" | "CONFLICT";

export class SyncSourceInputError extends Error {
  constructor() {
    super("Invalid source ordering evidence");
    this.name = "SyncSourceInputError";
  }
}

/** An opaque platform version proves equality, never numeric ordering. */
export function classifySourceOrder(current: unknown, incoming: unknown): SourceOrderDecision {
  const next = SourceOrderSchema.safeParse(incoming);
  const previous = current === null ? null : SourceOrderSchema.safeParse(current);
  if (!next.success || (previous !== null && !previous.success)) throw new SyncSourceInputError();
  if (previous === null) return "APPLY";
  const before = previous.data;
  const after = next.data;
  if (before.updatedAt === null || after.updatedAt === null) {
    return before.updatedAt === after.updatedAt &&
      before.version === after.version &&
      before.payloadHash === after.payloadHash
      ? "DUPLICATE"
      : "CONFLICT";
  }
  const delta = Date.parse(after.updatedAt) - Date.parse(before.updatedAt);
  if (delta > 0) return "APPLY";
  if (delta < 0) return "STALE";
  return before.version === after.version && before.payloadHash === after.payloadHash
    ? "DUPLICATE"
    : "CONFLICT";
}
