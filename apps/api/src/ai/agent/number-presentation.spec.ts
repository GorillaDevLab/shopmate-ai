import { describe, expect, it } from "vitest";
import { protectNumberPresentations } from "./number-presentation.js";

const outputs = [
  {
    status: "ok",
    data: {
      revenueMinor: 123456,
      revenueChangeRatio: 0.123456,
      orderCount: 9876,
      productName: "999元商品",
    },
  },
];

describe("unit-aware number presentation evidence", () => {
  it.each(["销售额约1235元", "销售额1234.56元", "销售额约0.12万元", "增长12.3%", "增长12.3456％"])(
    "accepts a verified presentation: %s",
    (answer) => {
      const result = protectNumberPresentations(answer, outputs);
      expect(result).not.toBeNull();
      expect(result?.restore(result.masked)).toBe(answer);
      expect(result?.masked).not.toMatch(/\d/);
    },
  );
  it.each([
    "销售额1235元",
    "销售额约9999元",
    "销售额9876元",
    "销售额999元",
    "销售额0.12万元",
    "增长98.7%",
    "销售额-1234.56元",
  ])("rejects invented or wrong-unit presentations: %s", (answer) => {
    expect(protectNumberPresentations(answer, outputs)).toBeNull();
  });
  it("does not treat empty, error, or historical outputs as verified amounts", () => {
    for (const status of ["empty", "error", undefined]) {
      expect(
        protectNumberPresentations("销售额约1235元", [{ status, revenueMinor: 123456 }]),
      ).toBeNull();
    }
    expect(protectNumberPresentations("销售额约1235元", [])).toBeNull();
  });
  it("reads currencyMinor chart values without accepting count-valued charts", () => {
    const chart = (unit: string) => [{ status: "ok", data: { unit, slices: [{ value: 123456 }] } }];
    expect(protectNumberPresentations("销售额约1235元", chart("currencyMinor"))).not.toBeNull();
    expect(protectNumberPresentations("销售额约1235元", chart("count"))).toBeNull();
  });
  it("rejects marker injection and keeps unformatted numbers available for normal validation", () => {
    expect(protectNumberPresentations("【已验证数值】", outputs)).toBeNull();
    const result = protectNumberPresentations("销售额约1235元，订单999单", outputs);
    expect(result?.masked).toContain("999单");
  });
});
