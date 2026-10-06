import { describe, expect, it } from "vitest";
import { assessFreshness, SyncFreshnessInputError } from "./freshness.js";

const now = "2026-10-03T12:00:00.000Z";
const input = {
  businessNow: now,
  successfulThrough: "2026-10-03T11:50:00.000Z",
  maxLagMs: 900_000,
  failed: false,
};

describe("per-stream sync freshness", () => {
  it("distinguishes no verified watermark from zero sales", () => {
    expect(assessFreshness({ ...input, successfulThrough: null })).toEqual({
      status: "UNKNOWN",
      lagMs: null,
    });
  });

  it("uses business time and treats the configured lag boundary as current", () => {
    expect(assessFreshness(input)).toEqual({ status: "CURRENT", lagMs: 600_000 });
    expect(assessFreshness({ ...input, successfulThrough: "2026-10-03T11:45:00.000Z" })).toEqual({
      status: "CURRENT",
      lagMs: 900_000,
    });
    expect(assessFreshness({ ...input, successfulThrough: "2026-10-03T11:44:59.999Z" })).toEqual({
      status: "STALE",
      lagMs: 900_001,
    });
  });

  it("keeps a failed run visible even when a prior watermark remains current", () => {
    expect(assessFreshness({ ...input, failed: true })).toEqual({
      status: "FAILED",
      lagMs: 600_000,
    });
  });

  it("rejects impossible future watermarks and untrusted thresholds", () => {
    expect(() =>
      assessFreshness({ ...input, successfulThrough: "2026-10-03T12:00:00.001Z" }),
    ).toThrow(SyncFreshnessInputError);
    expect(() => assessFreshness({ ...input, maxLagMs: -1 })).toThrow(SyncFreshnessInputError);
    expect(() => assessFreshness({ ...input, businessNow: "tomorrow" })).toThrow(
      SyncFreshnessInputError,
    );
  });
});
