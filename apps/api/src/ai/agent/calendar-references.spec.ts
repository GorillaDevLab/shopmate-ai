import { describe, expect, it } from "vitest";

import { stripCalendarReferences } from "./calendar-references.js";

const august = ["2026-08-01", "2026-08-31"];
const strip = (text: string, dates = august) => stripCalendarReferences(text, dates);

describe("stripCalendarReferences", () => {
  it("removes month/day references inside the queried period", () => {
    expect(strip("8月17日销售额为 0")).not.toContain("17");
    expect(strip("8/17 断档")).not.toContain("17");
    expect(strip("8月17号")).not.toMatch(/\d/);
  });

  it("keeps specific dates outside the queried period so they fail number verification", () => {
    expect(strip("9月17日")).toContain("17");
    expect(strip("7/30 数据")).toContain("30");
    expect(strip("8月17日", [])).toContain("17");
  });

  it("treats bare months and days of month as calendar words", () => {
    expect(strip("8月份和7月比")).not.toMatch(/\d/);
    expect(strip("上半月 1–15日")).not.toContain("15");
  });

  it("does not hide period lengths, business numbers or daily averages", () => {
    expect(strip("近 7 日")).toContain("7");
    expect(strip("共 27 单，279 件")).toContain("27");
    expect(strip("5日均销售")).toContain("5");
    expect(strip("13个月")).toContain("13");
  });
});
