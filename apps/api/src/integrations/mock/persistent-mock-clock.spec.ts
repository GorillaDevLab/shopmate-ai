import { describe, expect, it, vi } from "vitest";
import { MockConnectorError } from "./mock-call.js";
import { PersistentMockClock } from "./persistent-mock-clock.js";

const initial = { now: "2026-01-01T00:00:00Z", revision: 4, generation: 2 };
const later = "2026-01-02T00:00:00Z";
const earlier = "2025-12-31T00:00:00Z";

function refreshedClock(): PersistentMockClock {
  const clock = new PersistentMockClock();
  clock.refresh(initial);
  return clock;
}

function expectFailure(clock: PersistentMockClock, input: unknown, code: string): void {
  const before = clock.snapshot();
  expect(() => clock.refresh(input)).toThrowError(MockConnectorError);
  expect(() => clock.refresh(input)).toThrowError(code);
  expect(clock.snapshot()).toEqual(before);
}

describe("PersistentMockClock", () => {
  it("rejects reading before receiving persisted state", () => {
    expect(() => new PersistentMockClock().snapshot()).toThrowError("INVALID_RESPONSE");
  });

  it("normalizes offset time and returns immutable business-only state", () => {
    const clock = new PersistentMockClock();
    const input = { ...initial, now: "2026-01-01T08:00:00+08:00" };
    const value = clock.refresh(input);
    expect(value).toEqual({ now: "2026-01-01T00:00:00.000Z", revision: 4 });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(clock.snapshot())).toBe(true);
    input.now = later;
    expect(clock.snapshot()).toEqual(value);
    expect(() => Reflect.set(value, "revision", 99)).not.toThrow();
    expect(clock.snapshot().revision).toBe(4);
  });

  it("accepts idempotent refresh with an equivalent timestamp", () => {
    const clock = refreshedClock();
    expect(clock.refresh({ ...initial, now: "2026-01-01T08:00:00+08:00" })).toEqual(
      clock.snapshot(),
    );
  });

  it("advances within one generation only with a newer revision", () => {
    const clock = refreshedClock();
    expect(clock.refresh({ ...initial, now: later, revision: 5 }).revision).toBe(5);
    expect(clock.refresh({ ...initial, now: later, revision: 6 }).revision).toBe(6);
  });

  it("accepts reset backwards with both a newer generation and revision", () => {
    expect(refreshedClock().refresh({ now: earlier, generation: 3, revision: 5 })).toEqual({
      now: "2025-12-31T00:00:00.000Z",
      revision: 5,
    });
  });

  it("allows generation-only change when clock and revision are unchanged", () => {
    const clock = refreshedClock();
    clock.refresh({ ...initial, generation: 3 });
    expectFailure(clock, initial, "AUTH_EXPIRED");
  });

  it.each([
    [{ ...initial, generation: 1 }, "AUTH_EXPIRED"],
    [{ ...initial, generation: 1, revision: 9 }, "AUTH_EXPIRED"],
    [{ ...initial, revision: 3 }, "CONFLICT"],
    [{ ...initial, generation: 3, revision: 3 }, "CONFLICT"],
    [{ ...initial, now: later }, "INVALID_RESPONSE"],
    [{ ...initial, now: earlier, revision: 5 }, "INVALID_RESPONSE"],
    [{ ...initial, generation: 3, now: earlier }, "INVALID_RESPONSE"],
    [{ ...initial, generation: 3, now: later }, "INVALID_RESPONSE"],
  ])("rejects stale or inconsistent state %o with %s", (input, code) => {
    expectFailure(refreshedClock(), input, code);
  });

  it.each([
    undefined,
    null,
    [],
    "state",
    {},
    { ...initial, extra: "secret" },
    { ...initial, now: "invalid" },
    { ...initial, now: "2026-02-30T00:00:00Z" },
    { ...initial, now: "0000-12-31T23:59:59Z" },
    { ...initial, now: "0001-01-01T00:00:00+01:00" },
    { ...initial, now: "9999-12-31T23:59:59-01:00" },
    { ...initial, now: "+010000-01-01T00:00:00Z" },
    ...["4", -1, 0.5, NaN, Infinity, 2_147_483_648].flatMap((value) => [
      { ...initial, revision: value },
      { ...initial, generation: value },
    ]),
  ])("rejects malformed persisted state %o without mutation", (input) => {
    expectFailure(refreshedClock(), input, "INVALID_RESPONSE");
  });

  it.each(["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"])(
    "accepts calendar endpoint %s",
    (now) => {
      expect(new PersistentMockClock().refresh({ now, revision: 0, generation: 0 }).now).toBe(
        new Date(now).toISOString(),
      );
    },
  );

  it("accepts maximum counters", () => {
    expect(
      new PersistentMockClock().refresh({
        ...initial,
        revision: 2_147_483_647,
        generation: 2_147_483_647,
      }).revision,
    ).toBe(2_147_483_647);
  });

  it("never reads wall clock or substitutes real time", () => {
    const realNow = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Wall clock must not be read");
    });
    try {
      const clock = refreshedClock();
      expect(clock.snapshot().now).toBe("2026-01-01T00:00:00.000Z");
      expect(realNow).not.toHaveBeenCalled();
    } finally {
      realNow.mockRestore();
    }
  });
});
