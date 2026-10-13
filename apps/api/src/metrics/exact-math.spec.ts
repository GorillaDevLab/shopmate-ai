import type { ExactMinorMath, MinorAllocationWeight, MinorRounding } from "@shopmate/contracts";
import { expect, it } from "vitest";
import {
  add,
  allocate,
  EXACT_MINOR_MATH_VERSION,
  exactMinorMath,
  multiply,
  ratio,
  subtract,
} from "./exact-math.js";

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

const fullMath: ExactMinorMath = exactMinorMath;
const equalWeights = [
  { key: "b", weight: 1 },
  { key: "a", weight: 1 },
] as const;

it("exports the complete public ExactMinorMath port", () => {
  expect(Object.keys(fullMath).sort()).toEqual([
    "add",
    "allocate",
    "multiply",
    "ratio",
    "subtract",
  ]);
  expect(fullMath.allocate).toBe(allocate);
});

it.each([
  [100, "TOWARD_ZERO", [33, 67]],
  [-100, "TOWARD_ZERO", [-33, -67]],
  [100, "HALF_AWAY_FROM_ZERO", [33, 67]],
  [-100, "HALF_AWAY_FROM_ZERO", [-33, -67]],
] as const)("conserves %s with weighted %s shares", (amount, rounding, expected) => {
  expect(
    allocate(
      amount,
      [
        { key: "a", weight: 1 },
        { key: "b", weight: 2 },
      ],
      rounding,
    ),
  ).toEqual({
    ok: true,
    value: [
      { key: "a", amountMinor: expected[0] },
      { key: "b", amountMinor: expected[1] },
    ],
  });
});

it.each([
  [1, "TOWARD_ZERO", [0, 1]],
  [-1, "TOWARD_ZERO", [0, -1]],
  [1, "HALF_AWAY_FROM_ZERO", [1, 0]],
  [-1, "HALF_AWAY_FROM_ZERO", [-1, 0]],
  [0, "HALF_AWAY_FROM_ZERO", [0, 0]],
  [-0, "TOWARD_ZERO", [0, 0]],
] as const)("reconciles signed equal shares %s %s by ascending key", (amount, mode, expected) => {
  expect(allocate(amount, equalWeights, mode)).toEqual({
    ok: true,
    value: [
      { key: "b", amountMinor: expected[0] },
      { key: "a", amountMinor: expected[1] },
    ],
  });
});

it("uses locale independent key order and retains caller order", () => {
  const weights = [
    { key: "ä", weight: 1 },
    { key: "Z", weight: 1 },
    { key: "a", weight: 1 },
  ];
  expect(allocate(1, weights, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "ä", amountMinor: 0 },
      { key: "Z", amountMinor: 1 },
      { key: "a", amountMinor: 0 },
    ],
  });
});

it("freezes ascending UTF-16 ordering for supplementary key characters", () => {
  const weights = [
    { key: "\uE000", weight: 1 },
    { key: "\u{10000}", weight: 1 },
  ];
  expect(allocate(1, weights, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "\uE000", amountMinor: 0 },
      { key: "\u{10000}", amountMinor: 1 },
    ],
  });
});

it.each([1, -1])("reconciles many rounded shares for amount %s", (amount) => {
  const weights = ["e", "d", "c", "b", "a"].map((key) => ({ key, weight: 1 }));
  expect(allocate(amount * 4, weights, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "e", amountMinor: 0 },
      { key: "d", amountMinor: amount },
      { key: "c", amountMinor: amount },
      { key: "b", amountMinor: amount },
      { key: "a", amountMinor: amount },
    ],
  });
  expect(allocate(amount * 4, weights, "HALF_AWAY_FROM_ZERO")).toEqual({
    ok: true,
    value: weights.map(({ key }) => ({ key, amountMinor: key === "a" ? 0 : amount })),
  });
});

it.each([1, -1])("prioritizes exact signed errors rather than input order for %s", (sign) => {
  const weights = [
    { key: "a", weight: 3 },
    { key: "b", weight: 2 },
    { key: "c", weight: 1 },
  ];
  expect(allocate(sign * 2, weights, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "a", amountMinor: sign },
      { key: "b", amountMinor: sign },
      { key: "c", amountMinor: 0 },
    ],
  });
});

it.each([MAX, -MAX])("uses exact wide weight sums at safe amount boundary %s", (amount) => {
  const weights = [
    { key: "b", weight: MAX },
    { key: "a", weight: MAX },
  ];
  const smaller = amount > 0 ? 4503599627370495 : -4503599627370495;
  const larger = amount > 0 ? 4503599627370496 : -4503599627370496;
  expect(allocate(amount, weights, "TOWARD_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "b", amountMinor: smaller },
      { key: "a", amountMinor: larger },
    ],
  });
  expect(allocate(amount, weights, "HALF_AWAY_FROM_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "b", amountMinor: larger },
      { key: "a", amountMinor: smaller },
    ],
  });
});

it("never gives zero weights a residual or mutates inputs", () => {
  const weights = Object.freeze([
    Object.freeze({ key: "a", weight: -0 }),
    Object.freeze({ key: "b", weight: MAX }),
  ]);
  expect(allocate(-MAX, weights, "HALF_AWAY_FROM_ZERO")).toEqual({
    ok: true,
    value: [
      { key: "a", amountMinor: 0 },
      { key: "b", amountMinor: -MAX },
    ],
  });
});

it.each(badNumbers)("rejects invalid allocation amount or weight %s", (value) => {
  expect(allocate(value, equalWeights, "TOWARD_ZERO")).toEqual(invalid);
  expect(allocate(0, [{ key: "a", weight: value }], "TOWARD_ZERO")).toEqual(invalid);
});

it.each([
  { weights: [] },
  { weights: [{ key: "a", weight: 0 }] },
  { weights: [{ key: "a", weight: -1 }] },
  { weights: [{ key: "", weight: 1 }] },
  { weights: [{ key: " \t", weight: 1 }] },
  {
    weights: [
      { key: "a", weight: 1 },
      { key: "a", weight: 2 },
    ],
  },
  {
    weights: [
      { key: "a", weight: 0 },
      { key: "a", weight: 1 },
    ],
  },
  { weights: [{ key: 1, weight: 1 }] },
  { weights: [null] },
  { weights: [{}] },
  { weights: null },
  { weights: "a" },
  { weights: new Array(1) },
])("rejects malformed allocation weights %j", ({ weights }) => {
  expect(
    allocate(0, weights as unknown as readonly MinorAllocationWeight[], "TOWARD_ZERO"),
  ).toEqual(invalid);
});

it("validates allocation rounding even for a zero amount", () => {
  expect(allocate(0, equalWeights, "HALF_EVEN" as MinorRounding)).toEqual(invalid);
});
