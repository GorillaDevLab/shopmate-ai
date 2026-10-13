import { describe, expect, it, vi } from "vitest";
import type {
  MetricBusinessClock,
  MetricResult,
  MetricWindowRequest,
  MetricWindowResolver,
  MetricWindow,
} from "@shopmate/contracts";
import {
  containsMetricTimestamp,
  createMetricWindowResolver,
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

const current = { ...day, periodEnd: now };
function resolver(snapshot = clock()): MetricWindowResolver {
  return createMetricWindowResolver(snapshot);
}

describe("Comparison alignment", () => {
  it("matches Tuesday at the same 14h elapsed and 14:00 local cutoff", () => {
    const snapshot = clock();
    const result = value(resolver(snapshot).align(current, "2026-10-06", now));
    expect(result).toEqual({
      current,
      baseline: {
        ...day,
        periodStart: "2026-10-05T16:00:00.000Z",
        periodEnd: "2026-10-06T06:00:00.000Z",
      },
      elapsedHours: 14,
      aligned: true,
      reason: null,
    });
    expect(snapshot.snapshot).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(Object.isFrozen(result.baseline)).toBe(true);
  });

  it("reports a weekday mismatch before a cutoff mismatch", () => {
    const result = value(resolver().align(current, "2026-10-05", now));
    expect(result.aligned).toBe(false);
    expect(result.reason).toBe("WEEKDAY_MISMATCH");
  });
});

describe("Precise comparison duration", () => {
  it("retains seconds and milliseconds in a fractional-hour cutoff", () => {
    const cutoff = "2026-10-13T06:12:13.456Z";
    const result = value(
      resolver(clock(cutoff)).align({ ...day, periodEnd: cutoff }, "2026-10-06", cutoff),
    );
    expect(result.baseline.periodEnd).toBe("2026-10-06T06:12:13.456Z");
    expect(result.elapsedHours).toBe((14 * 3_600_000 + 12 * 60_000 + 13_456) / 3_600_000);
    expect(result.aligned).toBe(true);
  });

  it("aligns complete historical days and canonicalizes harmless trailing zeros", () => {
    const input = { ...day, periodStart: "2026-10-12T16:00:00.000000Z" };
    const result = value(
      resolver(clock("2026-10-14T00:00:00Z")).align(input, "2026-10-06", "2026-10-14T00:00:00Z"),
    );
    expect(result.current).toEqual(day);
    expect(result.baseline.periodEnd).toBe("2026-10-06T16:00:00.000Z");
    expect(result.elapsedHours).toBe(24);
    expect(result.aligned).toBe(true);
    expect(input.periodStart).toBe("2026-10-12T16:00:00.000000Z");
  });

  it("factory supplies observed and calendar methods without reading at creation", () => {
    const snapshot = clock();
    const windows = resolver(snapshot);
    expect(snapshot.snapshot).not.toHaveBeenCalled();
    expect(value(windows.businessDay(request()))).toEqual(day);
    expect(value(windows.elapsed(request()))).toEqual(current);
    expect(snapshot.snapshot).toHaveBeenCalledTimes(2);
  });
});

describe("Comparison input boundaries", () => {
  it.each(["2026-10-13", "2026-10-14", "2026-02-29", "bad", "0000-01-01"])(
    "rejects current/future or invalid candidate %s",
    (date) => {
      error(resolver().align(current, date, now));
    },
  );

  it.each([
    { ...current, periodEnd: day.periodStart },
    { ...current, periodStart: now, periodEnd: day.periodStart },
    { ...current, periodStart: "2026-10-12T16:00:00.001Z" },
    { ...current, periodEnd: "2026-10-14T00:00:00.000Z" },
    { ...current, timezone: "UTC" },
    { ...current, currency: "USD" },
    { ...current, extra: true },
    { ...current, periodEnd: "2026-10-13T06:00:00.0001Z" },
    null,
  ])("rejects malformed or unanchored current window %j", (input) => {
    error(
      resolver(clock("2026-11-01T00:00:00Z")).align(
        input as unknown as MetricWindow,
        "2026-10-06",
        "2026-11-01T00:00:00Z",
      ),
    );
  });
});

describe("Comparison observation fence", () => {
  it.each([
    "2026-10-13T05:59:59.999Z",
    "2026-10-13T06:00:00.001Z",
    "bad",
    "2026-10-13T06:00:00.0001Z",
  ])("rejects current after visibility or visibility after clock %s", (cutoff) => {
    error(resolver().align(current, "2026-10-06", cutoff));
  });

  it("rejects invalid clock revision and timestamp during alignment", () => {
    error(resolver(clock(now, -1)).align(current, "2026-10-06", now));
    error(resolver(clock("bad")).align(current, "2026-10-06", now));
    error(resolver(clock("2026-10-13T06:00:00.0001Z")).align(current, "2026-10-06", now));
  });

  it("replays a fixed comparison regardless of later injected now", () => {
    expect(resolver().align(current, "2026-10-06", now)).toEqual(
      resolver(clock("2027-01-01T00:00:00Z")).align(current, "2026-10-06", now),
    );
  });
});

// Fixtures independently established by native Intl probes of fixed UTC instants.
const autumn = {
  ...day,
  periodStart: "1991-09-14T15:00:00.000Z",
  periodEnd: "1991-09-15T16:00:00.000Z",
};
describe("Shanghai historical offset changes", () => {
  it.each([
    ["1991-09-15", autumn.periodStart, autumn.periodEnd],
    ["1991-09-08", "1991-09-07T15:00:00.000Z", "1991-09-08T15:00:00.000Z"],
    ["1991-04-14", "1991-04-13T16:00:00.000Z", "1991-04-14T15:00:00.000Z"],
  ])("uses independent local-midnight boundaries for %s", (date, start, end) => {
    expect(value(resolver().businessDay(request(date)))).toEqual({
      ...day,
      periodStart: start,
      periodEnd: end,
    });
  });

  it("reports mismatched cutoff for equal14h durations on the same weekday", () => {
    const input = { ...autumn, periodEnd: "1991-09-15T05:00:00.000Z" };
    const result = value(resolver().align(input, "1991-09-08", now));
    expect(result.baseline.periodEnd).toBe("1991-09-08T05:00:00.000Z");
    expect(result.elapsedHours).toBe(14);
    expect(result.reason).toBe("CUTOFF_MISMATCH");
    expect(result.aligned).toBe(false);
  });

  it("clamps a25h current day to the24h candidate day", () => {
    const result = value(resolver().align(autumn, "1991-09-08", now));
    expect(result.baseline.periodEnd).toBe("1991-09-08T15:00:00.000Z");
    expect(result.elapsedHours).toBe(25);
    expect(result.reason).toBe("CUTOFF_MISMATCH");
    expect(result.aligned).toBe(false);
  });
});

describe("Historical comparison mismatch priority", () => {
  it("caps a24h current day at a23h candidate end despite matching midnight cutoffs", () => {
    const input = {
      ...day,
      periodStart: "1991-04-20T15:00:00.000Z",
      periodEnd: "1991-04-21T15:00:00.000Z",
    };
    const result = value(resolver().align(input, "1991-04-14", now));
    expect(result.baseline.periodStart).toBe("1991-04-13T16:00:00.000Z");
    expect(result.baseline.periodEnd).toBe("1991-04-14T15:00:00.000Z");
    expect(result.elapsedHours).toBe(24);
    expect(result.reason).toBe("CUTOFF_MISMATCH");
    expect(result.aligned).toBe(false);
  });

  it("reports weekday mismatch when a cutoff mismatch also exists", () => {
    expect(value(resolver().align(autumn, "1991-09-07", now)).reason).toBe("WEEKDAY_MISMATCH");
  });

  it("reports cutoff mismatch for a23h current day vs a24h candidate", () => {
    const input = {
      ...day,
      periodStart: "1991-04-13T16:00:00.000Z",
      periodEnd: "1991-04-14T15:00:00.000Z",
    };
    const result = value(resolver().align(input, "1991-04-07", now));
    expect(result.elapsedHours).toBe(23);
    expect(result.baseline.periodEnd).toBe("1991-04-07T15:00:00.000Z");
    expect(result.reason).toBe("CUTOFF_MISMATCH");
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
