import { describe, expect, it } from "vitest";
import { insightKind } from "./assistant-intent";

describe("助手提问分流", () => {
  it.each([
    "销量是实时的吗",
    "我有几个店铺",
    "为什么这个门店下降",
    "这个饼图是什么意思",
    "这些销售额是怎么计算的",
    "最近周期的销售汇总与每日销售趋势",
  ])("用聊天处理：%s", (prompt) => {
    expect(insightKind(prompt)).toBeUndefined();
  });
  it.each([
    ["生成近30天销售饼图", "pie"],
    ["近30天各门店销售额", "auto"],
    ["画一个销售趋势图", "line"],
  ])("识别明确图表请求：%s", (prompt, kind) => {
    expect(insightKind(prompt)).toBe(kind);
  });
});
