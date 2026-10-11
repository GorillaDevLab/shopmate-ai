import { types } from "node:util";
import {
  ReadOptionsSchema,
  type ConnectorFailureCode,
  type ConnectorResult,
  type ReadOptions,
} from "@shopmate/contracts";

export class MockConnectorError extends Error {
  constructor(readonly code: ConnectorFailureCode) {
    super(code);
    this.name = "MockConnectorError";
  }
}

export function mockFailure(code: ConnectorFailureCode): ConnectorResult<never> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, retryAfterMs: null }) });
}

function optionData(input: unknown): Record<string, unknown> | null {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return null;
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !["signal", "requestId", "deadlineAt"].includes(key) ||
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      return null;
    data[key] = descriptor.value;
  }
  return data;
}
const nativeMapEach = Map.prototype.forEach;
const nativeMapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const signalSample = new AbortController().signal;
signalSample.addEventListener("abort", () => undefined);
const signalSlots = Object.getOwnPropertySymbols(signalSample);
// Node 24 stores opaque abort reasons separately; registration never consumes that slot.
const reasonSlot = signalSlots.find((key) => key.description === "kReason");
const sampleMap = signalSlots
  .map((key) => Object.getOwnPropertyDescriptor(signalSample, key)!.value)
  .find((value: unknown) => types.isMap(value)) as Map<string, { next: object }>;
const listenerPrototype: object = Object.getPrototypeOf(
  Map.prototype.get.call(sampleMap, "abort").next,
);
const mapPrototype: object = Object.getPrototypeOf(sampleMap);
const trustedPrototypes = new Map(
  [mapPrototype, listenerPrototype].map(
    (prototype) => [prototype, Object.getOwnPropertyDescriptors(prototype)] as const,
  ),
);

function unchangedPrototype(prototype: object): boolean {
  const baseline = trustedPrototypes.get(prototype);
  if (!baseline) return prototype === Object.prototype || prototype === null;
  const keys = Reflect.ownKeys(prototype);
  return (
    keys.length === Reflect.ownKeys(baseline).length &&
    keys.every((key) => {
      const current = Object.getOwnPropertyDescriptor(prototype, key),
        original = Reflect.get(baseline, key);
      return (
        current &&
        original &&
        current.value === original.value &&
        current.get === original.get &&
        current.set === original.set
      );
    })
  );
}

function safeNextChain(value: object): boolean {
  const chain = new Set<object>();
  let current: unknown = value;
  while (current !== undefined) {
    if (!current || typeof current !== "object" || types.isProxy(current) || chain.has(current))
      return false;
    if (chain.size >= 256) return false;
    chain.add(current);
    const next = Object.getOwnPropertyDescriptor(current, "next");
    if (!next) return true;
    if (!("value" in next)) return false;
    current = next.value;
  }
  return true;
}

// Native registration walks linked listener records; inspect descriptors without executing caller code.
function safeListenerState(map: object): boolean {
  const pending: unknown[] = [map],
    seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
    if (types.isProxy(value)) return false;
    if (typeof value === "function" || seen.has(value)) continue;
    if (seen.size >= 256) return false;
    seen.add(value);
    const prototype: object = Object.getPrototypeOf(value);
    if (!unchangedPrototype(prototype)) return false;
    const keys = Reflect.ownKeys(value);
    if (types.isMap(value)) {
      if (keys.length || nativeMapSize.call(value) > 256) return false;
      nativeMapEach.call(value, (entry: unknown, key: unknown) => pending.push(key, entry));
      continue;
    }
    if (keys.length > 32 || !safeNextChain(value)) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}

function validSignal(signal: unknown): signal is AbortSignal {
  if (
    !signal ||
    typeof signal !== "object" ||
    types.isProxy(signal) ||
    Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
    !(signal instanceof AbortSignal) ||
    Object.getOwnPropertyNames(signal).length > 0
  )
    return false;
  for (const key of Object.getOwnPropertySymbols(signal)) {
    const descriptor = Object.getOwnPropertyDescriptor(signal, key);
    if (!descriptor || !("value" in descriptor)) return false;
    if (key === reasonSlot) continue;
    if (types.isProxy(descriptor.value)) return false;
    if (types.isMap(descriptor.value) && !safeListenerState(descriptor.value)) return false;
  }
  try {
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal);
    return true;
  } catch {
    return false;
  }
}
function parseOptions(input: unknown): ConnectorResult<ReadOptions> {
  const data = optionData(input);
  if (!data) return mockFailure("INVALID_INPUT");
  const { signal, ...json } = data;
  if (signal !== undefined && !validSignal(signal)) return mockFailure("INVALID_INPUT");
  const parsed = ReadOptionsSchema.safeParse(json);
  return parsed.success
    ? { ok: true, data: { ...parsed.data, signal } }
    : mockFailure("INVALID_INPUT");
}

class CallGate {
  readonly controller = new AbortController();
  readonly failure: Promise<ConnectorResult<never>>;
  readonly deadline: number;
  private code: ConnectorFailureCode | null = null;
  private resolveFailure!: (value: ConnectorResult<never>) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.fail("ABORTED");

  constructor(private readonly caller: ReadOptions) {
    this.deadline = Math.min(Date.parse(caller.deadlineAt), Date.now() + 30_000);
    this.failure = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
    caller.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.fail("TIMEOUT"), Math.max(0, this.deadline - Date.now()));
  }

  currentFailure(): ConnectorResult<never> | null {
    if (this.caller.signal?.aborted) this.fail("ABORTED");
    if (Date.now() >= this.deadline) this.fail("TIMEOUT");
    return this.code ? mockFailure(this.code) : null;
  }

  options(): ReadOptions {
    return Object.freeze({
      ...this.caller,
      deadlineAt: new Date(this.deadline).toISOString(),
      signal: this.controller.signal,
    });
  }

  close(): void {
    clearTimeout(this.timer);
    this.caller.signal?.removeEventListener("abort", this.onAbort);
  }

  private fail(code: ConnectorFailureCode): void {
    if (this.code) return;
    this.code = code;
    this.controller.abort();
    this.resolveFailure(mockFailure(code));
  }
}

/** Async work is raced; CPU-bound source generation is checked again before returning data. */
export async function executeMockRead<T>(
  input: unknown,
  operation: (options: ReadOptions) => Promise<ConnectorResult<T>>,
): Promise<ConnectorResult<T>> {
  const parsed = parseOptions(input);
  if (!parsed.ok) return parsed;
  const gate = new CallGate(parsed.data);
  try {
    const before = gate.currentFailure();
    if (before) return before;
    const result = await Promise.race([gate.failure, operation(gate.options())]);
    return gate.currentFailure() ?? result;
  } catch (error) {
    return (
      gate.currentFailure() ??
      mockFailure(error instanceof MockConnectorError ? error.code : "TEMPORARY")
    );
  } finally {
    gate.close();
  }
}
