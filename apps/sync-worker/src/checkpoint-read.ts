import { types } from "node:util";
import { ReadOptionsSchema, type ReadOptions } from "@shopmate/contracts";
import { SourceStorageError } from "@shopmate/database/mock-platform-read";
import type { BoundSourceReadPort } from "@shopmate/database/mock-platform-read";

type ReadControl = Parameters<BoundSourceReadPort["read"]>[1];
interface CheckpointReader {
  read(request: unknown, control?: ReadControl): Promise<unknown | null>;
  refreshCheckpoint(request: unknown, control?: ReadControl): Promise<string | null>;
}
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

export function validReadSignal(signal: unknown): signal is AbortSignal {
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

function dataRecord(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new SourceStorageError("SOURCE_INPUT");
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      throw new SourceStorageError("SOURCE_INPUT");
  }
  return { ...input };
}

function snapshotRequest(input: unknown): Readonly<Record<string, unknown>> {
  const request = dataRecord(input);
  if (request.entityKey !== undefined) {
    const tuple = request.entityKey;
    if (
      !Array.isArray(tuple) ||
      types.isProxy(tuple) ||
      Object.getPrototypeOf(tuple) !== Array.prototype ||
      tuple.length < 2 ||
      tuple.length > 3 ||
      Reflect.ownKeys(tuple).length !== tuple.length + 1
    )
      throw new SourceStorageError("SOURCE_INPUT");
    const copied: string[] = [];
    for (let index = 0; index < tuple.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(tuple, String(index));
      if (!entry || !("value" in entry) || typeof entry.value !== "string")
        throw new SourceStorageError("SOURCE_INPUT");
      copied.push(entry.value);
    }
    request.entityKey = Object.freeze(copied);
  }
  return Object.freeze(request);
}

function sourceControl(input: ReadOptions) {
  const { signal, ...json } = dataRecord(input);
  const parsed = ReadOptionsSchema.safeParse(json);
  if (!parsed.success || (signal !== undefined && !validReadSignal(signal)))
    throw new SourceStorageError("SOURCE_INPUT");
  return Object.freeze({
    deadlineAt: new Date(
      Math.min(Date.parse(parsed.data.deadlineAt), Date.now() + 25_000),
    ).toISOString(),
    ...(signal ? { signal } : {}),
  });
}

function checkControl(control: ReturnType<typeof sourceControl>): void {
  if (control.signal?.aborted) throw new SourceStorageError("SOURCE_ABORTED");
  if (Date.now() >= Date.parse(control.deadlineAt)) throw new SourceStorageError("SOURCE_DEADLINE");
}

export class CheckpointReadPort {
  constructor(private readonly reader: CheckpointReader) {}

  async read(input: unknown, options: ReadOptions): Promise<unknown | null> {
    const request = snapshotRequest(input),
      control = sourceControl(options);
    checkControl(control);
    try {
      const page = await this.reader.read(request, control);
      checkControl(control);
      return page;
    } catch (error) {
      if (
        !(error instanceof SourceStorageError) ||
        error.code !== "SOURCE_INPUT" ||
        typeof request.cursor !== "string"
      )
        throw error;
    }
    // Recovery changes only credential expiry; the durable business cursor changes at page commit.
    checkControl(control);
    const cursor = await this.reader.refreshCheckpoint(request, control);
    checkControl(control);
    if (cursor === null) return null;
    const page = await this.reader.read({ ...request, cursor }, control);
    checkControl(control);
    return page;
  }
}
