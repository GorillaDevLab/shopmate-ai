import { describe, expect, it } from "vitest";

import { resolveReadToolPeriod, shanghaiDateKey } from "./read-tool-period.js";

describe("AI 读取工具默认日期周期", () => {
  it("没有日期时使用当前上海日期作为结束日期", () => {
    const now = new Date("2026-09-10T16:30:00.000Z");

    expect(resolveReadToolPeriod({}, now)).toEqual({
      startDate: undefined,
      endDate: "2026-09-11",
    });
  });

  it("显式结束日期不会被当前日期覆盖", () => {
    const now = new Date("2026-09-10T16:30:00.000Z");

    expect(
      resolveReadToolPeriod(
        {
          endDate: "2026-08-31",
        },
        now,
      ),
    ).toEqual({
      startDate: undefined,
      endDate: "2026-08-31",
    });
  });

  it("上海日期跨 UTC 日期边界正确", () => {
    expect(shanghaiDateKey(new Date("2026-09-10T15:59:59.000Z"))).toBe("2026-09-10");
    expect(shanghaiDateKey(new Date("2026-09-10T16:00:00.000Z"))).toBe("2026-09-11");
  });
});
