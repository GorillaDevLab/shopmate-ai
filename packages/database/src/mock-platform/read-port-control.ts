import { SourceStorageError } from "./errors.js";
import { types } from "node:util";
import { validateUtc } from "./record-primitives.js";
import type { SourceReadControl } from "./types.js";
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
    if (!descriptor || !("value" in descriptor) || types.isProxy(descriptor.value)) return false;
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
