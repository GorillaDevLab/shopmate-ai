import { createHash } from "node:crypto";
import {
  EventEvidenceV1Schema,
  type DecisionPortResult,
  type HostEvidenceHash,
} from "@shopmate/contracts";

const timestampKeys = new Set([
  "periodStart",
  "periodEnd",
  "observedAt",
  "sourceWatermark",
  "inboundETA",
  "inventoryObservedAt",
  "listedAt",
  "observedThrough",
  "priceEffectiveAt",
  "lastSuccessAt",
]);

/** Only validated evidence reaches this encoder; arrays retain their declared sequence. */
function canonical(value: unknown, key = ""): string {
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(timestampKeys.has(key) ? new Date(value).toISOString() : value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child, name)}`)
    .join(",")}}`;
}

/** Versioned domain separation keeps this digest distinct from source/metric hashes. */
export class CanonicalHostEvidenceHash implements HostEvidenceHash {
  hash(evidence: unknown): DecisionPortResult<string> {
    try {
      const parsed = EventEvidenceV1Schema.safeParse(evidence);
      if (!parsed.success) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
      const hash = createHash("sha256")
        .update("shopmate:decision-evidence:v1\0", "utf8")
        .update(canonical(parsed.data), "utf8")
        .digest("hex");
      return Object.freeze({ ok: true, value: `sha256:${hash}` });
    } catch {
      // Upstream exact-ratio refinements can throw on malformed numbers; fail closed.
      return Object.freeze({ ok: false, code: "INVALID_INPUT" });
    }
  }
}
