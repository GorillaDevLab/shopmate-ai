import { SourceStorageError } from "./errors.js";
import { types } from "node:util";
import { validateUtc } from "./record-primitives.js";
import type { SourceReadControl } from "./types.js";
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
      // Registration compares callback identity; it does not consume the callback receiver's payload.
      if (key !== "listener" && key !== "callback") pending.push(descriptor.value);
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

export function fixedPortControl(control?: SourceReadControl): SourceReadControl {
  if (control !== undefined) {
    if (
      !control ||
      typeof control !== "object" ||
      types.isProxy(control) ||
      Object.getPrototypeOf(control) !== Object.prototype
    )
      throw new SourceStorageError("SOURCE_INPUT");
    for (const name of Reflect.ownKeys(control)) {
      const descriptor = Object.getOwnPropertyDescriptor(control, name);
      if (
        (name !== "signal" && name !== "deadlineAt") ||
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        throw new SourceStorageError("SOURCE_INPUT");
    }
    if (control.signal !== undefined && !validSignal(control.signal))
      throw new SourceStorageError("SOURCE_INPUT");
  }
  const requested = control?.deadlineAt;
  if (requested !== undefined && !validateUtc(requested))
    throw new SourceStorageError("SOURCE_INPUT");
  const deadline = Math.min(
    requested === undefined ? Infinity : Date.parse(requested),
    Date.now() + 30_000,
  );
  return Object.freeze({ ...control, deadlineAt: new Date(deadline).toISOString() });
}
