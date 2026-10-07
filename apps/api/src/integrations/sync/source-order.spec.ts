import { describe, expect, it } from "vitest";
import { classifySourceOrder, SyncSourceInputError } from "./source-order.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const first = { version: "v1", updatedAt: "2026-10-03T08:00:00+08:00", payloadHash: hashA };

describe("source version ordering", () => {
  it("accepts a first observation and a newer timestamp", () => {
    expect(classifySourceOrder(null, first)).toBe("APPLY");
    expect(
      classifySourceOrder(first, {
        version: "v2",
        updatedAt: "2026-10-03T00:00:01Z",
        payloadHash: hashB,
      }),
    ).toBe("APPLY");
  });

  it("deduplicates the same instant and payload across time zones", () => {
    expect(
      classifySourceOrder(first, {
        ...first,
        updatedAt: "2026-10-03T00:00:00Z",
      }),
    ).toBe("DUPLICATE");
  });

  it("does not let an older observation replace current data", () => {
    expect(
      classifySourceOrder(first, {
        version: "v9",
        updatedAt: "2026-10-02T23:59:59Z",
        payloadHash: hashB,
      }),
    ).toBe("STALE");
  });

  it("quarantines equal-time disagreement because platform versions are opaque", () => {
    expect(classifySourceOrder(first, { ...first, payloadHash: hashB })).toBe("CONFLICT");
    expect(classifySourceOrder(first, { ...first, version: "v2" })).toBe("CONFLICT");
  });

  it("never guesses order when the source time is missing", () => {
    const unknown = { ...first, updatedAt: null };
    expect(classifySourceOrder(null, unknown)).toBe("APPLY");
    expect(classifySourceOrder(unknown, unknown)).toBe("DUPLICATE");
    expect(classifySourceOrder(unknown, first)).toBe("CONFLICT");
    expect(classifySourceOrder(first, unknown)).toBe("CONFLICT");
  });

  it("rejects untrusted versions, dates and hashes", () => {
    expect(() => classifySourceOrder(null, { ...first, version: " v1" })).toThrow(
      SyncSourceInputError,
    );
    expect(() => classifySourceOrder(null, { ...first, updatedAt: "yesterday" })).toThrow(
      SyncSourceInputError,
    );
    expect(() => classifySourceOrder(null, { ...first, payloadHash: "raw payload" })).toThrow(
      SyncSourceInputError,
    );
  });
});
