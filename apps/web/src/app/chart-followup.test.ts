import { describe, expect, it } from "vitest";
import { chartFollowupView } from "./chart-followup";

describe("图表追问识别", () => {
  it.each(["我要饼图", "换成饼图", "环形图", "我想要饼图！"])("识别 %s", (prompt) => {
    expect(chartFollowupView(prompt)).toBe("pie");
  });
  it.each(["近30天门店销售额饼图", "换成近7天销售额柱状图", "不要饼图", "比较面积图和饼图"])(
    "不会吞掉新查询或否定：%s",
    (prompt) => {
      expect(chartFollowupView(prompt)).toBeUndefined();
    },
  );
});
