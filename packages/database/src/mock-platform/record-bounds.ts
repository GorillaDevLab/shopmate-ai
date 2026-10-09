import { types } from "node:util";
import { requireInput } from "./record-primitives.js";

interface Frame {
  value: unknown;
  depth: number;
  leave?: object;
}
interface Budget {
  bytes: number;
  nodes: number;
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
}
type StringMode = "record" | "query-json";
function stringSize(value: string, remaining: number, mode: StringMode = "record"): number {
  let bytes = 2;
  requireInput(bytes <= remaining);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    requireInput(code !== 0 && (mode === "query-json" || code < 0xd800 || code > 0xdfff));
    if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else if (character === '"' || character === "\\") bytes += 2;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    requireInput(bytes <= remaining);
  }
  return bytes;
}
function primitiveSize(value: unknown, remaining: number, mode: StringMode): number | null {
  if (value === null || typeof value === "boolean") return value === null ? 4 : value ? 4 : 5;
  if (typeof value === "string") {
    return stringSize(value, remaining, mode);
  }
  if (typeof value === "number") {
    requireInput(Number.isSafeInteger(value));
    return String(value).length;
  }
  return null;
}
function children(value: object, budget: Budget): unknown[] {
  const array = Array.isArray(value);
  requireInput(
    array
      ? Object.getPrototypeOf(value) === Array.prototype
      : Object.getPrototypeOf(value) === Object.prototype,
  );
  const keys = Reflect.ownKeys(value);
  requireInput(keys.length <= budget.maxNodes - budget.nodes + (array ? 1 : 0));
  requireInput(keys.length * 2 <= budget.maxBytes - budget.bytes + (array ? 2 : 0));
  requireInput(keys.every((key) => typeof key === "string"));
  if (array) requireInput(value.length <= 500 && keys.length === value.length + 1);
  const result: unknown[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireInput(
      descriptor && "value" in descriptor && ((array && key === "length") || descriptor.enumerable),
    );
    if (array && key === "length") continue;
    if (array)
      requireInput(
        typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length,
      );
    else {
      requireInput(typeof key === "string");
      budget.bytes += stringSize(key, budget.maxBytes - budget.bytes) + 1;
      requireInput(budget.bytes <= budget.maxBytes);
    }
    result.push(descriptor.value);
  }
  budget.bytes += 2 + Math.max(0, result.length - 1);
  return result;
}
export function validateDataBounds(
  value: unknown,
  maxBytes: number,
  maxNodes = 20000,
  maxDepth = 12,
  stringMode: StringMode = "record",
): void {
  const budget = { bytes: 0, nodes: 0, maxBytes, maxNodes, maxDepth };
  const stack: Frame[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.leave) {
      ancestors.delete(frame.leave);
      continue;
    }
    requireInput(++budget.nodes <= maxNodes && frame.depth <= maxDepth);
    const size = primitiveSize(frame.value, maxBytes - budget.bytes, stringMode);
    if (size !== null) budget.bytes += size;
    else {
      requireInput(
        typeof frame.value === "object" &&
          frame.value !== null &&
          !types.isProxy(frame.value) &&
          !ancestors.has(frame.value),
      );
      ancestors.add(frame.value);
      stack.push({ value: null, depth: 0, leave: frame.value });
      const values = children(frame.value, budget);
      for (const child of values) stack.push({ value: child, depth: frame.depth + 1 });
    }
    requireInput(budget.bytes <= maxBytes);
  }
}
