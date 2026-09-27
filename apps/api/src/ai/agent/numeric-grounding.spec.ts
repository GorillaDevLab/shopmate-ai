import { describe, expect, it } from "vitest";

import { extractAnswerNumbers, NumericGrounding } from "./numeric-grounding.js";

// 本期销售额 17,818.20 元，上期 30,000 元；订单 27 单；两家门店 12,000 / 5,818.20 元。
const grounding = new NumericGrounding(["17818.2", "30000", "27", "12000", "5818.2", "-0.4061"]);
const grounded = (text: string) =>
  extractAnswerNumbers(text).every((number) => grounding.isGrounded(number));

describe("NumericGrounding", () => {
  it("accepts exact values, thousands separators and sign-stripped negatives", () => {
    expect(grounded("销售额 ¥17,818.20，共 27 单")).toBe(true);
    expect(grounded("变化 0.4061")).toBe(true);
    expect(grounded("门店合计 1.2万")).toBe(true);
  });

  it("accepts shares, period-over-period changes and multiples derived from two verified values", () => {
    expect(grounded("朝阳店占 67.3%")).toBe(true); // 12000 / 17818.2
    expect(grounded("环比下降 40.6%")).toBe(true); // (30000 − 17818.2) / 30000
    expect(grounded("上期是本期的 1.68 倍")).toBe(true); // 30000 / 17818.2
    expect(grounded("占比 100%")).toBe(true); // 同一数字自比
  });

  it("rounds percentages and 万 values to the precision shown, but not plain numbers", () => {
    expect(grounded("环比下降 41%")).toBe(true); // 40.61%
    expect(grounded("销售额 1.78万")).toBe(true); // 17,818.2
    expect(grounded("销售额 17,818 元")).toBe(false);
    expect(grounded("销售额 1.8万")).toBe(false); // 少于 3 位有效数字，需写“约”
    expect(grounded("销售额 2万")).toBe(false);
    expect(
      grounding.isGrounded({ text: "2万", value: 2, decimals: 0, suffix: "万", approximate: true }),
    ).toBe(true);
  });

  it("still rejects numbers that cannot be traced to the tool results", () => {
    expect(grounded("销售额 18,500 元")).toBe(false);
    expect(grounded("环比下降 25.0%")).toBe(false);
    expect(grounded("共 5 单")).toBe(false);
    expect(grounded("环比下降 45%")).toBe(false);
    expect(grounded("销售额 1.79万")).toBe(false);
  });
});
