import { isProxy } from "node:util/types";
import { AuditAppendInputSchema, type AuditAppendInput } from "@shopmate/contracts";

// Text, node and depth caps bound work before the family schemas inspect untrusted data.
const MAX_TEXT_BYTES = 32_768;
const MAX_NODES = 256;
const MAX_DEPTH = 16;
const MAX_KEYS = 64;
type Inspection = { nodes: number; bytes: number; ancestors: WeakSet<object> };

export class AuditRedactionError extends Error {
  constructor() {
    super("Invalid audit input");
    this.name = "AuditRedactionError";
  }
}

function countText(value: string, inspection: Inspection): void {
  if (value.length > MAX_TEXT_BYTES) throw new AuditRedactionError();
  inspection.bytes += Buffer.byteLength(value, "utf8");
  if (inspection.bytes > MAX_TEXT_BYTES) throw new AuditRedactionError();
}

function copyObject(value: object, depth: number, inspection: Inspection): object {
  if (isProxy(value)) throw new AuditRedactionError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new AuditRedactionError();
  if (inspection.ancestors.has(value)) throw new AuditRedactionError();
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_KEYS) throw new AuditRedactionError();
  const copy: Record<string, unknown> = {};
  inspection.ancestors.add(value);
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
      throw new AuditRedactionError();
    countText(key, inspection);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new AuditRedactionError();
    const child: unknown = descriptor.value;
    Object.defineProperty(copy, key, {
      value: snapshot(child, depth + 1, inspection),
      enumerable: true,
    });
  }
  inspection.ancestors.delete(value);
  return copy;
}

function snapshot(value: unknown, depth: number, inspection: Inspection): unknown {
  if (++inspection.nodes > MAX_NODES || depth > MAX_DEPTH) throw new AuditRedactionError();
  if (typeof value === "string") {
    countText(value, inspection);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // No audit family accepts arrays or class instances; reject before schema traversal.
  if (typeof value === "object" && value !== null) return copyObject(value, depth, inspection);
  throw new AuditRedactionError();
}

/** Strict family allowlists reject forbidden data; caller identity authorization remains upstream. */
export class AuditRedactor {
  redact(input: unknown): Readonly<{ redactionVersion: 1; event: AuditAppendInput }> {
    try {
      const copy = snapshot(input, 0, { nodes: 0, bytes: 0, ancestors: new WeakSet() });
      const event = AuditAppendInputSchema.parse(copy);
      return Object.freeze({ redactionVersion: 1, event });
    } catch {
      // Never attach parser issues, input, or a user-thrown cause to the public error.
      throw new AuditRedactionError();
    }
  }
}
