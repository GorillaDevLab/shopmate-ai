import { describe, expect, it, vi } from "vitest";
import type { MetricBusinessClock, MetricResult, MetricWindowRequest } from "@shopmate/contracts";
import {
  containsMetricTimestamp,
  resolveMetricBusinessDay,
  resolveMetricElapsed,
} from "./metric-window.js";

const now = "2026-10-13T06:00:00.000Z";
const day = {
  periodStart: "2026-10-12T16:00:00.000Z",
  periodEnd: "2026-10-13T16:00:00.000Z",
  timezone: "Asia/Shanghai",
  currency: "CNY",
} as const;
function clock(value = now, revision = 0): MetricBusinessClock {
  return { snapshot: vi.fn(() => ({ now: value, revision })) };
}
function request(businessDate = "2026-10-13", visibleAt = now): MetricWindowRequest {
  return { businessDate, timezone: "Asia/Shanghai", visibleAt };
}
function value<T>(result: MetricResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function error(result: MetricResult<unknown>, code = "INVALID_INPUT") {
  expect(result).toEqual({ ok: false, error: { code, evidenceIds: [] } });
}

describe("Shanghai calendar metadata", () => {
  it("returns full boundaries even when today's end is not observed", () => {
    const snapshot = clock();
    const input = Object.freeze(request());
    expect(value(resolveMetricBusinessDay(snapshot, input))).toEqual(day);
    expect(snapshot.snapshot).toHaveBeenCalledTimes(1);
    expect(input).toEqual(request());
  });

  it("accepts exact midnight metadata and freezes its result", () => {
    const result = value(resolveMetricBusinessDay(clock(), request("2026-10-13", day.periodStart)));
    expect(result).toEqual(day);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["2024-02-29", "2024-02-28T16:00:00.000Z", "2024-02-29T16:00:00.000Z"],
    ["2026-04-30", "2026-04-29T16:00:00.000Z", "2026-04-30T16:00:00.000Z"],
    ["2025-12-31", "2025-12-30T16:00:00.000Z", "2025-12-31T16:00:00.000Z"],
    ["0001-01-01", "0000-12-31T15:54:17.000Z", "0001-01-01T15:54:17.000Z"],
  ])("converts both calendar boundaries for %s", (date, start, end) => {
    expect(value(resolveMetricBusinessDay(clock(), request(date)))).toEqual({
      ...day,
      periodStart: start,
      periodEnd: end,
    });
  });
});

describe("Invalid calendar requests", () => {
  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-1-01",
    "0000-01-01",
    "9999-12-31",
    "bad",
  ])("rejects impossible, malformed or unrepresentable date %s", (date) => {
    error(resolveMetricBusinessDay(clock("9999-12-31T23:59:59.999Z"), request(date)));
  });

  it.each([
    { ...request(), timezone: "UTC" },
    { ...request(), extra: true },
    { ...request(), businessDate: null },
    null,
  ])("rejects invalid runtime request %j", (input) => {
    error(resolveMetricBusinessDay(clock(), input as unknown as MetricWindowRequest));
  });
});

describe("Observed elapsed windows", () => {
  it("clips today's interval to 14:00 Shanghai", () => {
    expect(value(resolveMetricElapsed(clock(), request()))).toEqual({ ...day, periodEnd: now });
  });

  it("returns an entire historical day", () => {
    expect(value(resolveMetricElapsed(clock(), request("2026-10-12")))).toEqual({
      ...day,
      periodStart: "2026-10-11T16:00:00.000Z",
      periodEnd: day.periodStart,
    });
  });

  it("does not expose an empty new day at exact midnight", () => {
    error(resolveMetricElapsed(clock(), request("2026-10-13", day.periodStart)), "WINDOW_MISMATCH");
    error(
      resolveMetricElapsed(clock(day.periodEnd), request("2026-10-14", day.periodEnd)),
      "WINDOW_MISMATCH",
    );
    expect(
      value(resolveMetricElapsed(clock(day.periodEnd), request("2026-10-13", day.periodEnd))),
    ).toEqual(day);
  });
});

describe("Visibility fence and deterministic replay", () => {
  it("rejects a future business day and visibility beyond the injected clock", () => {
    error(resolveMetricBusinessDay(clock(), request("2026-10-14")));
    error(resolveMetricElapsed(clock(), request("2026-10-14")), "WINDOW_MISMATCH");
    error(resolveMetricElapsed(clock(), request("2026-10-13", "2026-10-13T06:00:00.001Z")));
  });

  it("replays an old cutoff and captures the clock once", () => {
    const snapshot = clock();
    const input = request("2026-10-13", "2026-10-12T22:12:13.456Z");
    const result = resolveMetricElapsed(snapshot, input);
    expect(value(result).periodEnd).toBe(input.visibleAt);
    expect(snapshot.snapshot).toHaveBeenCalledTimes(1);
    expect(resolveMetricElapsed(clock("2026-11-01T00:00:00.000Z"), input)).toEqual(result);
  });
});

describe("Clock and timestamp validation", () => {
  it.each(["bad", "2026-10-13T06:00:00+08:00", "2026-10-13T06:00:00.0001Z"])(
    "rejects invalid or lossy timestamp %s",
    (timestamp) => {
      error(resolveMetricElapsed(clock(), request("2026-10-13", timestamp)));
      error(resolveMetricElapsed(clock(timestamp), request()));
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid clock revision %s",
    (revision) => {
      error(resolveMetricElapsed(clock(now, revision), request()));
    },
  );

  it("accepts lossless trailing zeros and canonicalizes milliseconds", () => {
    expect(
      value(resolveMetricElapsed(clock(), request("2026-10-13", "2026-10-13T06:00:00.000000Z")))
        .periodEnd,
    ).toBe(now);
  });
});

describe("Half-open timestamp membership", () => {
  it.each([
    ["2026-10-12T15:59:59.999Z", false],
    [day.periodStart, true],
    ["2026-10-13T15:59:59.999Z", true],
    [day.periodEnd, false],
    ["2026-10-13T16:00:00.001Z", false],
  ])("tests %s at millisecond precision", (timestamp, expected) => {
    expect(value(containsMetricTimestamp(day, timestamp))).toBe(expected);
  });

  it.each(["bad", "2026-10-13T15:59:59.9999Z", "2026-10-13T16:00:00+08:00"])(
    "rejects invalid timestamp %s",
    (timestamp) => {
      error(containsMetricTimestamp(day, timestamp));
    },
  );

  it.each([
    { ...day, periodEnd: day.periodStart },
    { ...day, periodStart: day.periodEnd, periodEnd: day.periodStart },
    { ...day, periodStart: "2026-10-12T16:00:00.0001Z" },
    { ...day, currency: "USD" },
    { ...day, timezone: "UTC" },
    { ...day, extra: true },
  ])("rejects invalid interval %j", (input) => {
    error(containsMetricTimestamp(input as unknown as typeof day, now));
  });
});
