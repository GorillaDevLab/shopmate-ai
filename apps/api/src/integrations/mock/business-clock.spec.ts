import { describe, expect, it } from "vitest";
import { RealBusinessClock, SimulationClock } from "./business-clock.js";

describe("business clock", () => {
  it("advances simulated time independently of real time", () => {
    const clock = new SimulationClock("2026-01-01T00:00:00Z");
    expect(clock.snapshot()).toEqual({ now: "2026-01-01T00:00:00.000Z", revision: 0 });
    clock.advance(6 * 3_600_000);
    expect(clock.snapshot()).toEqual({ now: "2026-01-01T06:00:00.000Z", revision: 1 });
    expect(Object.isFrozen(clock.snapshot())).toBe(true);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid advance %s without moving time",
    (duration) => {
      const clock = new SimulationClock("2026-01-01T00:00:00Z");
      const before = clock.snapshot();
      expect(() => clock.advance(duration)).toThrow();
      expect(clock.snapshot()).toEqual(before);
    },
  );

  it("does not increment revision on zero advance", () => {
    const clock = new SimulationClock("2026-01-01T00:00:00Z");
    expect(clock.advance(0)).toEqual(clock.snapshot());
    expect(clock.snapshot().revision).toBe(0);
  });

  it.each(["bad", "2026-01-01", "2026-02-30T00:00:00Z"])("rejects %s", (now) => {
    expect(() => new SimulationClock(now)).toThrow();
  });

  it("uses real time for the real business clock", () => {
    const before = Date.now();
    const now = Date.parse(new RealBusinessClock().snapshot().now);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
