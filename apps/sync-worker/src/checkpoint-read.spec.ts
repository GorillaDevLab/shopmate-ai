import { types } from "node:util";
import { describe, expect, it } from "vitest";
import { SourceStorageError } from "@shopmate/database/mock-platform-read";
import { CheckpointReadPort } from "./checkpoint-read.js";

const request = {
  kind: "PRODUCT" as const,
  requestedUntil: "2026-01-02T00:00:00.000Z",
  businessNow: "2026-01-02T00:00:00.000Z",
  limit: 32,
  contextHash: "a".repeat(64),
  cursor: "expired-signed-checkpoint",
};
const options = () => ({
  requestId: "page-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});

describe("durable checkpoint read adapter", () => {
  it("refreshes only a rejected checkpoint and shares the original budget through the retry", async () => {
    const calls: unknown[][] = [];
    const call = { ...options(), signal: new AbortController().signal };
    const reader = {
      async read(input: unknown, control: unknown) {
        calls.push(["read", input, control]);
        if (calls.length === 1) throw new SourceStorageError("SOURCE_INPUT");
        return { items: [], nextCursor: "next" };
      },
      async refreshCheckpoint(input: unknown, control: unknown) {
        calls.push(["refresh", input, control]);
        return "renewed-checkpoint";
      },
    };
    expect(await new CheckpointReadPort(reader).read(request, call)).toEqual({
      items: [],
      nextCursor: "next",
    });
    expect(calls.map((entry) => entry[0])).toEqual(["read", "refresh", "read"]);
    expect(calls[0]![2]).toEqual({ signal: call.signal, deadlineAt: call.deadlineAt });
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(calls[1]![2]).toBe(calls[2]![2]);
    expect(calls[2]![1]).toEqual({ ...request, cursor: "renewed-checkpoint" });
    expect(request.cursor).toBe("expired-signed-checkpoint");
  });

  it("does not recover ordinary storage, integrity or cancellation failures", async () => {
    for (const code of [
      "SOURCE_STORAGE",
      "SOURCE_INTEGRITY",
      "SOURCE_ABORTED",
      "SOURCE_DEADLINE",
    ] as const) {
      let refreshed = false;
      const failure = new SourceStorageError(code);
      const port = new CheckpointReadPort({
        async read() {
          throw failure;
        },
        async refreshCheckpoint() {
          refreshed = true;
          return "other";
        },
      });
      await expect(port.read(request, options())).rejects.toBe(failure);
      expect(refreshed).toBe(false);
    }
  });

  it("preserves denied recovery and refuses tampered checkpoints", async () => {
    for (const outcome of [null, new SourceStorageError("SOURCE_INPUT")]) {
      let reads = 0;
      const port = new CheckpointReadPort({
        async read() {
          reads++;
          throw new SourceStorageError("SOURCE_INPUT");
        },
        async refreshCheckpoint() {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
      if (outcome === null) expect(await port.read(request, options())).toBeNull();
      else await expect(port.read(request, options())).rejects.toBe(outcome);
      expect(reads).toBe(1);
    }
  });

  it("does not recover first reads and rejects hostile requests before invoking getters", async () => {
    let invoked = false,
      reads = 0,
      refreshed = false;
    const port = new CheckpointReadPort({
      async read() {
        reads++;
        throw new SourceStorageError("SOURCE_INPUT");
      },
      async refreshCheckpoint() {
        refreshed = true;
        return "other";
      },
    });
    const first = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "cursor"));
    await expect(port.read(first, options())).rejects.toMatchObject({ code: "SOURCE_INPUT" });
    const hostile = {
      ...first,
      get cursor() {
        invoked = true;
        return "tampered";
      },
    };
    await expect(port.read(hostile, options())).rejects.toMatchObject({ code: "SOURCE_INPUT" });
    expect(invoked).toBe(false);
    expect(reads).toBe(1);
    expect(refreshed).toBe(false);
  });

  it("checks cancellation before I/O and again before refreshed retry", async () => {
    const controller = new AbortController();
    let reads = 0;
    const port = new CheckpointReadPort({
      async read() {
        reads++;
        throw new SourceStorageError("SOURCE_INPUT");
      },
      async refreshCheckpoint() {
        controller.abort();
        return "renewed";
      },
    });
    const call = { ...options(), signal: controller.signal };
    await expect(port.read(request, call)).rejects.toMatchObject({ code: "SOURCE_ABORTED" });
    expect(reads).toBe(1);
    await expect(port.read(request, call)).rejects.toMatchObject({ code: "SOURCE_ABORTED" });
    expect(reads).toBe(1);
    await expect(
      port.read(request, { ...options(), deadlineAt: "2000-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "SOURCE_DEADLINE" });
    expect(reads).toBe(1);
  });
});

it.each(["proxied", "unbranded", "overridden"] as const)(
  "rejects %s signals before checkpoint/source I/O",
  async (kind) => {
    let invoked = false,
      calls = 0;
    let signal: object = new AbortController().signal;
    if (kind === "proxied")
      signal = new Proxy(signal, {
        getPrototypeOf(target) {
          invoked = true;
          return Reflect.getPrototypeOf(target);
        },
      });
    if (kind === "unbranded") signal = Object.create(AbortSignal.prototype);
    if (kind === "overridden")
      Object.defineProperty(signal, "aborted", {
        get() {
          invoked = true;
          return false;
        },
      });
    const port = new CheckpointReadPort({
      async read() {
        calls++;
        return null;
      },
      async refreshCheckpoint() {
        calls++;
        return null;
      },
    });
    await expect(
      port.read(request, { ...options(), signal: signal as AbortSignal }),
    ).rejects.toMatchObject({ code: "SOURCE_INPUT" });
    expect(invoked).toBe(false);
    expect(calls).toBe(0);
  },
);

it("rejects signal symbol accessors before native brand checks or source I/O", async () => {
  let invoked = false,
    reads = 0;
  const signal = new AbortController().signal;
  const slot =
    Object.getOwnPropertySymbols(signal).find((key) => String(key) === "Symbol(kAborted)") ??
    Symbol("hostile");
  Object.defineProperty(signal, slot, {
    get() {
      invoked = true;
      return false;
    },
  });
  const port = new CheckpointReadPort({
    async read() {
      reads++;
      return null;
    },
    async refreshCheckpoint() {
      return null;
    },
  });
  await expect(port.read(request, { ...options(), signal })).rejects.toMatchObject({
    code: "SOURCE_INPUT",
  });
  expect(invoked).toBe(false);
  expect(reads).toBe(0);
});

it.each(["proxy", "getter", "map-method", "nested-map", "cycle", "oversized"] as const)(
  "rejects hostile listener %s before source I/O",
  async (kind) => {
    let traps = 0,
      calls = 0;
    const signal = new AbortController().signal;
    const slot = Object.getOwnPropertySymbols(signal).find((key) =>
      types.isMap(Object.getOwnPropertyDescriptor(signal, key)?.value),
    );
    const map = Object.getOwnPropertyDescriptor(signal, slot!)!.value as Map<string, unknown>;
    const node = { size: 0, next: undefined, resistStopPropagation: false };
    const proxy = new Proxy(node, {
      get(target, key) {
        traps++;
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
          traps++;
          return undefined;
        },
      });
      Map.prototype.set.call(map, "abort", node);
    }
    if (kind === "map-method")
      Object.defineProperty(map, "get", {
        get() {
          traps++;
          return undefined;
        },
      });
    if (kind === "nested-map") Map.prototype.set.call(map, "abort", new Map([["nested", proxy]]));
    const port = new CheckpointReadPort({
      async read() {
        calls++;
        return null;
      },
      async refreshCheckpoint() {
        calls++;
        return null;
      },
    });
    await expect(port.read(request, { ...options(), signal })).rejects.toMatchObject({
      code: "SOURCE_INPUT",
    });
    expect(traps).toBe(0);
    expect(calls).toBe(0);
  },
);

it("accepts native listeners and factories while ignoring arbitrary abort reasons", async () => {
  let notified = 0;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => notified++);
  const port = new CheckpointReadPort({
    async read() {
      return null;
    },
    async refreshCheckpoint() {
      return null;
    },
  });
  for (const signal of [controller.signal, AbortSignal.any([]), AbortSignal.timeout(5000)])
    expect(await port.read(request, { ...options(), signal })).toBeNull();
  controller.abort();
  expect(notified).toBe(1);
  const reason = new Proxy(
    {},
    {
      get() {
        throw new Error("reason must not be read");
      },
    },
  );
  await expect(
    port.read(request, { ...options(), signal: AbortSignal.abort(reason) }),
  ).rejects.toMatchObject({ code: "SOURCE_ABORTED" });
});
