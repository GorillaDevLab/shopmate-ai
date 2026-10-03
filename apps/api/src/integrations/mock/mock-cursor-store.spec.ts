import { afterEach, describe, expect, it, vi } from "vitest";
import { MockCursorStore } from "./mock-cursor-store.js";

afterEach(() => vi.useRealTimers());

describe("bounded opaque cursor registry", () => {
  it("keeps at most 256 handles and never revives an evicted continuation", () => {
    const cursors = new MockCursorStore();
    const oldest = cursors.next("orders", "frame", 1);
    const retained = cursors.next("orders", "frame", 2);
    for (let offset = 3; offset <= 257; offset += 1) cursors.next("orders", "frame", offset);
    expect(() => cursors.read(oldest, "orders")).toThrow("INVALID_INPUT");
    expect(cursors.read(retained, "orders").offset).toBe(2);
    expect(cursors.next("orders", "frame", 1)).not.toBe(oldest);
    expect(() => cursors.read(retained, "orders")).toThrow("INVALID_INPUT");
  });

  it("reuses live retries but replaces expired handles with a fresh lifetime", () => {
    vi.useFakeTimers();
    const cursors = new MockCursorStore();
    const first = cursors.next("orders", "frame", 1);
    expect(cursors.next("orders", "frame", 1)).toBe(first);
    vi.advanceTimersByTime(15 * 60_000);
    expect(() => cursors.read(first, "orders")).toThrow("CONFLICT");
    const replacement = cursors.next("orders", "frame", 1);
    expect(replacement).not.toBe(first);
    expect(() => cursors.read(first, "orders")).toThrow("INVALID_INPUT");
    expect(cursors.read(replacement, "orders").offset).toBe(1);
    cursors.clear();
    expect(() => cursors.read(replacement, "orders")).toThrow("INVALID_INPUT");
  });
});
