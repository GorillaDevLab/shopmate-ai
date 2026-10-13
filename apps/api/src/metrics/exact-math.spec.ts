import type { ExactMinorMath, MinorRounding } from "@shopmate/contracts";
import { expect, it } from "vitest";
import { add, EXACT_MINOR_MATH_VERSION, multiply, ratio, subtract } from "./exact-math.js";

const MAX = Number.MAX_SAFE_INTEGER;
const invalid = { ok: false, error: { code: "INVALID_INPUT", evidenceIds: [] } };
const overflow = { ok: false, error: { code: "OVERFLOW", evidenceIds: [] } };
const arithmetic: Pick<ExactMinorMath, "add" | "subtract" | "multiply" | "ratio"> = {
  add,
  subtract,
  multiply,
  ratio,
};
const badNumbers = [NaN, Infinity, -Infinity, 0.5, -0.5, MAX + 1, -MAX - 1];

it("versions the local arithmetic policy", () => {
  expect(EXACT_MINOR_MATH_VERSION).toBe(1);
});

it.each([
  [[], 0],
  [[10, 20], 30],
  [[-10, 20], 10],
  [[MAX, -MAX], 0],
  [[-0], 0],
])("adds %j exactly", (values, expected) => {
  expect(arithmetic.add(values)).toEqual({ ok: true, value: expected });
});

it.each([[[MAX, 1]], [[-MAX, -1]], [[MAX, 1, -1]]])("rejects unsafe prefixes %j", (values) => {
  expect(add(values)).toEqual(overflow);
});

it.each(badNumbers)("rejects invalid amount %s in every operand", (value) => {
  expect(add([value])).toEqual(invalid);
  expect(subtract(value, 0)).toEqual(invalid);
  expect(subtract(0, value)).toEqual(invalid);
  expect(multiply(value, 0)).toEqual(invalid);
  expect(multiply(0, value)).toEqual(invalid);
  expect(ratio(value, 0, "TOWARD_ZERO")).toEqual(invalid);
  expect(ratio(0, value, "TOWARD_ZERO")).toEqual(invalid);
});

it("validates the whole sum before checking prefixes", () => {
  expect(add([MAX, 1, NaN])).toEqual(invalid);
  expect(add(new Array<number>(1))).toEqual(invalid);
  expect(add(null as unknown as readonly number[])).toEqual(invalid);
});

it.each([
  [10, 30, -20],
  [MAX, MAX - 1, 1],
  [-MAX, -MAX + 1, -1],
  [-0, 0, 0],
])("subtracts %s - %s exactly", (left, right, expected) => {
  expect(subtract(left, right)).toEqual({ ok: true, value: expected });
});

it.each([
  [-MAX, 1],
  [MAX, -1],
])("rejects overflowing subtraction", (left, right) => {
  expect(subtract(left, right)).toEqual(overflow);
});

it.each([
  [-200, 3, -600],
  [MAX, 1, MAX],
  [-MAX, 1, -MAX],
  [MAX, 0, 0],
  [-0, MAX, 0],
])("multiplies %s by %s exactly", (amount, quantity, expected) => {
  expect(multiply(amount, quantity)).toEqual({ ok: true, value: expected });
});

it("rejects negative quantities and unsafe products", () => {
  expect(multiply(0, -1)).toEqual(invalid);
  expect(multiply(MAX, 2)).toEqual(overflow);
  expect(multiply(-MAX, 2)).toEqual(overflow);
  expect(multiply(2, -0)).toEqual({ ok: true, value: 0 });
});

it.each([
  [1, 3, "HALF_AWAY_FROM_ZERO", 3333],
  [1, 32, "HALF_AWAY_FROM_ZERO", 313],
  [1, 32, "TOWARD_ZERO", 312],
  [-1, 32, "HALF_AWAY_FROM_ZERO", -313],
  [-1, 32, "TOWARD_ZERO", -312],
  [1, -32, "HALF_AWAY_FROM_ZERO", -313],
  [-1, -32, "HALF_AWAY_FROM_ZERO", 313],
  [2, 1, "TOWARD_ZERO", 20000],
  [MAX, MAX, "HALF_AWAY_FROM_ZERO", 10000],
  [MAX - 1, MAX, "TOWARD_ZERO", 9999],
  [-0, 1, "HALF_AWAY_FROM_ZERO", 0],
] as const)("scales %s / %s with %s", (numerator, denominator, mode, expected) => {
  expect(ratio(numerator, denominator, mode)).toEqual({
    ok: true,
    value: { value: expected, reason: null },
  });
});

it.each([0, 1, -1, MAX])("preserves zero denominator reason for %s", (numerator) => {
  expect(ratio(numerator, -0, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: { value: null, reason: "ZERO_DENOMINATOR" },
  });
});

it.each([MAX, -MAX])("rejects unsafe rounded ratio %s", (numerator) => {
  expect(ratio(numerator, 1, "TOWARD_ZERO")).toEqual(overflow);
});

it("requires valid explicit rounding before zero denominator handling", () => {
  expect(ratio(1, 0, "HALF_EVEN" as MinorRounding)).toEqual(invalid);
  expect(ratio(1, 1, undefined as unknown as MinorRounding)).toEqual(invalid);
});
