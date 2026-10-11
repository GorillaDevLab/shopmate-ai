import { types } from "node:util";
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
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
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
    remove.mockRestore();
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

describe("hostile call controls", () => {
  it.each([
    "accessor",
    "proxy",
    "symbol",
    "nonenumerable",
    "nonplain",
    "proxied-signal",
    "unbranded-signal",
    "overridden-signal",
  ] as const)("rejects %s without invoking caller code or work", async (kind) => {
    const invoked = vi.fn(),
      work = vi.fn(async () => ok);
    let input: object = options();
    if (kind === "accessor")
      Object.defineProperty(input, "requestId", {
        get() {
          invoked();
          return "request-a";
        },
        enumerable: true,
      });
    if (kind === "proxy")
      input = new Proxy(input, {
        ownKeys(target) {
          invoked();
          return Reflect.ownKeys(target);
        },
        get(target, key) {
          invoked();
          return Reflect.get(target, key);
        },
      });
    if (kind === "symbol")
      Object.defineProperty(input, Symbol("extra"), { value: true, enumerable: true });
    if (kind === "nonenumerable") Object.defineProperty(input, "extra", { value: true });
    if (kind === "nonplain") Object.setPrototypeOf(input, { inherited: true });
    if (kind === "proxied-signal")
      input = {
        ...options(),
        signal: new Proxy(new AbortController().signal, {
          getPrototypeOf(target) {
            invoked();
            return Reflect.getPrototypeOf(target);
          },
        }),
      };
    if (kind === "unbranded-signal")
      input = { ...options(), signal: Object.create(AbortSignal.prototype) };
    if (kind === "overridden-signal") {
      const signal = new AbortController().signal;
      Object.defineProperty(signal, "aborted", {
        get() {
          invoked();
          return false;
        },
      });
      input = { ...options(), signal };
    }
    expect(await executeMockRead(input, work)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(invoked).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});

it("rejects signal symbol accessors before native brand checks or work", async () => {
  const invoked = vi.fn(),
    work = vi.fn(async () => ok),
    signal = new AbortController().signal;
  const slot =
    Object.getOwnPropertySymbols(signal).find((key) => String(key) === "Symbol(kAborted)") ??
    Symbol("hostile");
  Object.defineProperty(signal, slot, {
    get() {
      invoked();
      return false;
    },
  });
  expect(await executeMockRead({ ...options(), signal }, work)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(invoked).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it("rejects proxy-valued signal internals before listener registration", async () => {
  const signal = new AbortController().signal,
    invoked = vi.fn(),
    work = vi.fn(async () => ok);
  const slot = Object.getOwnPropertySymbols(signal).find((key) =>
    types.isMap(Object.getOwnPropertyDescriptor(signal, key)?.value),
  );
  expect(slot).toBeDefined();
  Object.defineProperty(signal, slot!, {
    value: new Proxy(new Map(), {
      get(target, key) {
        invoked();
        return Reflect.get(target, key);
      },
    }),
  });
  expect(await executeMockRead({ ...options(), signal }, work)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(invoked).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it.each(["proxy", "getter", "map-method", "nested-map", "cycle", "oversized"] as const)(
  "rejects hostile listener %s without traps or work",
  async (kind) => {
    const signal = new AbortController().signal,
      invoked = vi.fn(),
      work = vi.fn(async () => ok);
    const slot = Object.getOwnPropertySymbols(signal).find((key) =>
      types.isMap(Object.getOwnPropertyDescriptor(signal, key)?.value),
    );
    const map = Object.getOwnPropertyDescriptor(signal, slot!)!.value as Map<string, unknown>;
    const node = { size: 0, next: undefined, resistStopPropagation: false };
    const proxy = new Proxy(node, {
      get(target, key) {
        invoked();
        return Reflect.get(target, key);
      },
    });
    if (kind === "cycle") Map.prototype.set.call(map, "abort", { ...node, next: node });
    if (kind === "cycle") Object.defineProperty(node, "next", { value: node });
    if (kind === "oversized")
      for (let index = 0; index < 257; index++) Map.prototype.set.call(map, String(index), node);
    if (kind === "proxy") Map.prototype.set.call(map, "abort", proxy);
    if (kind === "getter") {
      Object.defineProperty(node, "next", {
        get() {
          invoked();
          return undefined;
        },
      });
      Map.prototype.set.call(map, "abort", node);
    }
    if (kind === "map-method") Object.defineProperty(map, "get", { value: invoked });
    if (kind === "nested-map") Map.prototype.set.call(map, "abort", new Map([["nested", proxy]]));
    expect(await executeMockRead({ ...options(), signal }, work)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(invoked).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  },
);

it("preserves existing native listeners and native signal factories", async () => {
  const controller = new AbortController(),
    listener = vi.fn();
  controller.signal.addEventListener("abort", listener);
  expect(
    await executeMockRead({ ...options(), signal: controller.signal }, async () => ok),
  ).toEqual(ok);
  const events = Object.getOwnPropertySymbols(controller.signal)
    .map((key) => Object.getOwnPropertyDescriptor(controller.signal, key)!.value)
    .find((value: unknown) => types.isMap(value)) as Map<string, { size: number }>;
  expect(Map.prototype.get.call(events, "abort").size).toBe(1);
  controller.abort();
  expect(listener).toHaveBeenCalledOnce();
  for (const signal of [AbortSignal.any([]), AbortSignal.timeout(5000)])
    expect(await executeMockRead({ ...options(), signal }, async () => ok)).toEqual(ok);
  const reason = new Proxy(
    {},
    {
      get() {
        throw new Error("reason must not be read");
      },
    },
  );
  expect(
    await executeMockRead({ ...options(), signal: AbortSignal.abort(reason) }, async () => ok),
  ).toMatchObject({ ok: false, error: { code: "ABORTED" } });
});
