import type { DashboardChartView, DashboardInsightPreviewResponse } from "@shopmate/contracts";

export function chartFollowupView(prompt: string): DashboardChartView | undefined {
  const match = prompt
    .trim()
    .match(
      /^(?:我想要|我要|换成|改成|切换成|切换为|改为|换个|用)?\s*(饼图|环形图|柱状图|条形图|折线图|面积图)(?:展示|显示|呈现)?[吧呢。！!？?\s]*$/u,
    );
  if (!match) return undefined;
  const views: Record<string, DashboardChartView> = {
    饼图: "pie",
    环形图: "pie",
    柱状图: "bar",
    条形图: "bar",
    折线图: "line",
    面积图: "area",
  };
  return views[match[1]!];
}

export function chartFollowupMessage(
  preview: DashboardInsightPreviewResponse | undefined,
  view: DashboardChartView,
): { content: string; compatible: boolean } {
  if (!preview)
    return {
      content: "请先说明要分析的指标和时间范围，例如：近 30 天各门店销售额。",
      compatible: false,
    };
  const views =
    preview.result.kind === "series"
      ? ["line", "area", "bar"]
      : preview.result.kind === "pie"
        ? preview.query.metric === "averageOrderValue"
          ? ["bar"]
          : ["pie", "bar"]
        : [];
  if (!views.includes(view))
    return {
      content:
        preview.result.kind === "series"
          ? "上一张图是按日期排列的趋势数据，可以切换为折线图、面积图或柱状图。"
          : preview.result.kind === "report"
            ? "上一份结果是经营报告，请指定分组维度后生成图表。"
            : "上一张图是分类对比数据，可以使用柱状图；可相加的指标也支持环形图。折线图需要按日期排列的数据。",
      compatible: false,
    };
  const label = {
    pie: "环形图（饼图）",
    bar: "柱状图",
    line: "折线图",
    area: "面积图",
    report: "报告",
  }[view];
  return { content: `已将上一张图切换为${label}，沿用原来的数据和时间范围。`, compatible: true };
}
