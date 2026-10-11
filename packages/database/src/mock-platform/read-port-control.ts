import { SourceStorageError } from "./errors.js";
import { types } from "node:util";
import { validateUtc } from "./record-primitives.js";
import type { SourceReadControl } from "./types.js";
const nativeMapEach = Map.prototype.forEach;
const nativeMapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const signalSample = new AbortController().signal;
signalSample.addEventListener("abort", () => undefined);
const signalSlots = Object.getOwnPropertySymbols(signalSample);
const primitiveSlots = signalSlots.filter((key) => {
  const value: unknown = Object.getOwnPropertyDescriptor(signalSample, key)!.value;
  return typeof value === "number" || typeof value === "boolean";
});
// Node 24 stores opaque abort reasons separately; registration never consumes that slot.
const reasonSlot = signalSlots.find((key) => key.description === "kReason");
const sampleMap = signalSlots
  .map((key) => Object.getOwnPropertyDescriptor(signalSample, key)!.value)
  .find((value: unknown) => types.isMap(value)) as Map<string, { next: object }>;
const listenerPrototype: object = Object.getPrototypeOf(
  Map.prototype.get.call(sampleMap, "abort").next,
);
const mapPrototype: object = Object.getPrototypeOf(sampleMap);
const eventSlot = signalSlots.find(
  (key) => Object.getOwnPropertyDescriptor(signalSample, key)!.value === sampleMap,
);
const sampleRoot: object = Map.prototype.get.call(sampleMap, "abort");
const rootFields = Reflect.ownKeys(sampleRoot);
const listenerFields = Reflect.ownKeys(Object.getOwnPropertyDescriptor(sampleRoot, "next")!.value);
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

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function safePrimitiveSlots(signal: object): boolean {
  return (
    primitiveSlots.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(signal, key);
      if (!descriptor || !("value" in descriptor)) return false;
      const expected: unknown = Object.getOwnPropertyDescriptor(signalSample, key)!.value;
      return typeof expected === "boolean"
        ? typeof descriptor.value === "boolean"
        : descriptor.value === Infinity ||
            boundedInteger(descriptor.value, Number.MAX_SAFE_INTEGER);
    }) && types.isMap(Object.getOwnPropertyDescriptor(signal, eventSlot!)?.value)
  );
}

function nativeRecord(
  value: unknown,
  prototype: object,
  fields: readonly PropertyKey[],
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== prototype
  )
    return null;
  if (!unchangedPrototype(prototype) || Reflect.ownKeys(value).length !== fields.length)
    return null;
  const record: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.writable)
      return null;
    record[key] = descriptor.value;
  }
  return record;
}

function safeEventList(value: unknown, budget: { remaining: number }): boolean {
  const root = nativeRecord(value, Object.prototype, rootFields);
  if (!root || !boundedInteger(root.size, 256) || typeof root.resistStopPropagation !== "boolean")
    return false;
  const seen = new Set<object>();
  let current: unknown = root.next,
    previous: unknown = value;
  if (--budget.remaining < 0) return false;
  while (current !== undefined) {
    const node = nativeRecord(current, listenerPrototype, listenerFields);
    if (
      !node ||
      seen.has(current as object) ||
      --budget.remaining < 0 ||
      node.previous !== previous
    )
      return false;
    if (!boundedInteger(node.flags, 127)) return false;
    // Native registration compares receiver identity; callback payloads remain opaque.
    seen.add(current as object);
    previous = current;
    current = node.next;
  }
  return seen.size === root.size;
}

// Registration calls native Listener methods, so structural lookalikes must never enter its list.
function safeListenerState(map: object, events: boolean): boolean {
  if (
    types.isProxy(map) ||
    Object.getPrototypeOf(map) !== mapPrototype ||
    !unchangedPrototype(mapPrototype) ||
    Reflect.ownKeys(map).length ||
    nativeMapSize.call(map) > 256
  )
    return false;
  let valid = true;
  const budget = { remaining: 256 };
  nativeMapEach.call(map, (entry: unknown, key: unknown) => {
    if (
      typeof key !== "string" ||
      (events ? !safeEventList(entry, budget) : typeof entry !== "function" || types.isProxy(entry))
    )
      valid = false;
  });
  return valid;
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
    if (types.isMap(descriptor.value) && !safeListenerState(descriptor.value, key === eventSlot))
      return false;
  }
  if (!safePrimitiveSlots(signal)) return false;
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
