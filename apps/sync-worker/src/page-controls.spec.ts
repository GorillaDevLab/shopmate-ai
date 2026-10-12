import { expect, it, vi } from "vitest";
import { boundedControls, type PageRunControls } from "./page-controls.js";

it("retains defaults and explicit undefined fields", () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    expect(boundedControls({})).toEqual({ maxPages: 100, deadline: 61000, signal: undefined });
    expect(
      boundedControls({ maxPages: undefined, budgetMs: undefined, signal: undefined }),
    ).toEqual(boundedControls({}));
    expect(boundedControls({ budgetMs: 1000 }, 1200).deadline).toBe(1200);
    expect(boundedControls({ budgetMs: 1000 }, 3000).deadline).toBe(2000);
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([
  { maxPages: 0 },
  { maxPages: 1001 },
  { budgetMs: 0 },
  { budgetMs: 3600001 },
  { maxPages: "1" },
  { signal: {} },
  { extra: undefined },
  { [Symbol("extra")]: true },
  Object.defineProperty({}, "budgetMs", { value: 1000 }),
])("rejects invalid bounded controls %j", (input) => {
  expect(() => boundedControls(input as PageRunControls)).toThrow("SYNC_RUN_INPUT_INVALID");
});

it.each([-1, 0.5, Infinity, NaN])("rejects invalid absolute deadline %s", (deadline) => {
  expect(() => boundedControls({}, deadline)).toThrow("SYNC_RUN_INPUT_INVALID");
});
