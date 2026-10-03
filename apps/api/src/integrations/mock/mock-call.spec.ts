import { afterEach, describe, expect, it, vi } from "vitest";
import { executeMockRead, MockConnectorError } from "./mock-call.js";

const options = () => ({
  requestId: "request-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const ok = { ok: true, data: "safe" } as const;
afterEach(() => vi.useRealTimers());

describe("mock call gate", () => {
  it("returns validated reads without retaining timers", async () => {
    vi.useFakeTimers();
    expect(await executeMockRead(options(), async () => ok)).toEqual(ok);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    null,
    {},
    { requestId: "x", deadlineAt: "bad" },
    { ...options(), organizationId: "foreign" },
    { ...options(), signal: {} },
  ])("rejects malformed call options %j", async (input) => {
    let calls = 0;
    expect(
      await executeMockRead(input, async () => {
        calls += 1;
        return ok;
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(calls).toBe(0);
  });

  it("fails an expired real deadline before doing work", async () => {
    let calls = 0;
    const input = { ...options(), deadlineAt: new Date(Date.now() - 1).toISOString() };
    expect(
      await executeMockRead(input, async () => {
        calls += 1;
        return ok;
      }),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(calls).toBe(0);
  });

  it("propagates caller cancellation into asynchronous work and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let cancelled = false;
    const result = executeMockRead({ ...options(), signal: controller.signal }, async (call) => {
      call.signal!.addEventListener("abort", () => {
        cancelled = true;
      });
      return new Promise<typeof ok>(() => undefined);
    });
    controller.abort();
    expect(await result).toMatchObject({ ok: false, error: { code: "ABORTED" } });
    expect(cancelled).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects an already cancelled signal without work", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    expect(
      await executeMockRead({ ...options(), signal: controller.signal }, async () => {
        calls += 1;
        return ok;
      }),
    ).toMatchObject({ ok: false, error: { code: "ABORTED" } });
    expect(calls).toBe(0);
  });

  it("times out stalled work using real time and cancels its linked signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = executeMockRead(options(), async (call) => {
      signal = call.signal;
      return new Promise<typeof ok>(() => undefined);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds long requested deadlines to the adapter's thirty-second budget", async () => {
    vi.useFakeTimers();
    const result = executeMockRead(
      { ...options(), deadlineAt: "9999-12-31T23:59:59Z" },
      async () => new Promise<typeof ok>(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("never reports late synchronous work as success", async () => {
    vi.useFakeTimers();
    const input = options();
    const result = await executeMockRead(input, async () => {
      vi.setSystemTime(Date.parse(input.deadlineAt) + 1);
      return ok;
    });
    expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("maps specific connector errors and sanitizes unexpected exceptions", async () => {
    expect(
      await executeMockRead(options(), async () => {
        throw new MockConnectorError("NOT_FOUND");
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      await executeMockRead(options(), async () => {
        throw new Error("private provider payload");
      }),
    ).toEqual({ ok: false, error: { code: "TEMPORARY", retryAfterMs: null } });
  });
});
