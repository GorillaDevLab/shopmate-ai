import { ConnectorTimestampSchema } from "@shopmate/contracts";
import { z } from "zod";

const FreshnessSchema = z.strictObject({
  businessNow: ConnectorTimestampSchema,
  successfulThrough: ConnectorTimestampSchema.nullable(),
  maxLagMs: z
    .number()
    .int()
    .min(0)
    .max(365 * 86_400_000),
  failed: z.boolean(),
});

export type SyncFreshness = {
  readonly status: "CURRENT" | "STALE" | "UNKNOWN" | "FAILED";
  readonly lagMs: number | null;
};

export class SyncFreshnessInputError extends Error {
  constructor() {
    super("Invalid sync freshness evidence");
    this.name = "SyncFreshnessInputError";
  }
}

/** A missing or delayed source watermark never means zero business activity. */
export function assessFreshness(input: unknown): SyncFreshness {
  const parsed = FreshnessSchema.safeParse(input);
  if (!parsed.success) throw new SyncFreshnessInputError();
  const { businessNow, successfulThrough, maxLagMs, failed } = parsed.data;
  if (successfulThrough === null) return { status: failed ? "FAILED" : "UNKNOWN", lagMs: null };
  const lagMs = Date.parse(businessNow) - Date.parse(successfulThrough);
  if (lagMs < 0) throw new SyncFreshnessInputError();
  if (failed) return { status: "FAILED", lagMs };
  return { status: lagMs <= maxLagMs ? "CURRENT" : "STALE", lagMs };
}
