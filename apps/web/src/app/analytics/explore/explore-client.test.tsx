import type { DashboardInsightPreviewResponse } from "@shopmate/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../../../test/assistant-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/analytics/explore",
}));

const api = vi.hoisted(() => ({
  generateDashboardInsight: vi.fn(),
  executeDashboardInsight: vi.fn(),
}));
vi.mock("../../dashboard-insight-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../dashboard-insight-api")>()),
  ...api,
}));

const saver = vi.hoisted(() => ({ saveChartToAnalytics: vi.fn() }));
vi.mock("./explore-save", () => saver);

import { DashboardInsightApiError } from "../../dashboard-insight-api";
import { ExploreClient } from "./explore-client";

const preview: DashboardInsightPreviewResponse = {
  query: {
    dataset: "sales",
    metric: "revenue",
    aggregation: "sum",
    groupBy: "store",
    dateRange: { start: "2026-08-02", end: "2026-08-31" },
    filters: [],
    order: "desc",
    limit: 8,
    visualization: "bar",
  },
  result: {
    kind: "pie",
    title: "各门店销售额",
    summary: "2026-08-02 至 2026-08-31",
    unit: "currencyMinor",
    slices: [
      { key: "store-a", label: "北京朝阳店", value: 11417900 },
      { key: "store-b", label: "小红书店", value: 5154600 },
    ],
  },
};

async function generate(question = "各门店销售额对比") {
  fireEvent.change(screen.getByLabelText("想看什么图表？"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "生成图表" }));
  return screen.findByRole("article", { name: "各门店销售额" });
}

describe("ExploreClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
  });

  it("offers example prompts before the first question", () => {
    render(<ExploreClient />);
    expect(screen.getByRole("region", { name: "示例问题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成图表" })).toBeDisabled();
  });

  it("generates a chart, shows its data table and config", async () => {
    api.generateDashboardInsight.mockResolvedValue(preview);
    render(<ExploreClient />);
    await generate();
    expect(api.generateDashboardInsight).toHaveBeenCalledWith("各门店销售额对比");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "北京朝阳店" })).toBeInTheDocument();
    expect(within(table).getByText("¥114,179.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
  });

  it("re-runs only the structured query when the config changes", async () => {
    api.generateDashboardInsight.mockResolvedValue(preview);
    api.executeDashboardInsight.mockResolvedValue({
      ...preview.result,
      title: "各门店销售额（饼图）",
    });
    render(<ExploreClient />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "环形图" }));
    await screen.findByRole("article", { name: "各门店销售额（饼图）" });
    expect(api.generateDashboardInsight).toHaveBeenCalledTimes(1);
    expect(api.executeDashboardInsight).toHaveBeenCalledWith(
      expect.objectContaining({ visualization: "pie" }),
      expect.any(AbortSignal),
    );
  });

  it("restores the previous config when a re-run fails", async () => {
    api.generateDashboardInsight.mockResolvedValue(preview);
    api.executeDashboardInsight.mockRejectedValue(
      new DashboardInsightApiError("暂时无法生成经营组件，请重试", 503, true),
    );
    render(<ExploreClient />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "环形图" }));
    expect(await screen.findByText("暂时无法生成经营组件，请重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves the current chart to 经营分析 and links there", async () => {
    api.generateDashboardInsight.mockResolvedValue(preview);
    saver.saveChartToAnalytics.mockResolvedValue(undefined);
    render(<ExploreClient />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "保存到经营分析" }));
    expect(await screen.findByRole("link", { name: "去经营分析查看" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("button", { name: "已保存" })).toBeDisabled();
    expect(saver.saveChartToAnalytics).toHaveBeenCalledWith(preview.query, preview.result);
  });

  it("shows why saving failed and lets the chart be saved again after a change", async () => {
    api.generateDashboardInsight.mockResolvedValue(preview);
    api.executeDashboardInsight.mockResolvedValue(preview.result);
    saver.saveChartToAnalytics.mockRejectedValueOnce(new Error("布局已在其他设备更新"));
    render(<ExploreClient />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "保存到经营分析" }));
    expect(await screen.findByText("布局已在其他设备更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "环形图" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存到经营分析" })).toBeEnabled(),
    );
    expect(screen.queryByText("布局已在其他设备更新")).not.toBeInTheDocument();
  });

  it("shows a retry for generation failures without retrying automatically", async () => {
    api.generateDashboardInsight.mockRejectedValue(
      new DashboardInsightApiError("图表生成等待超时，结果尚未确认，未自动重试。", 504, false),
    );
    render(<ExploreClient />);
    fireEvent.change(screen.getByLabelText("想看什么图表？"), { target: { value: "销售额" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图表" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("未自动重试");
    expect(api.generateDashboardInsight).toHaveBeenCalledTimes(1);
    expect(within(alert).getByRole("button", { name: "重新生成" })).toBeInTheDocument();
  });

  it("offers re-login when the session expired", async () => {
    api.generateDashboardInsight.mockRejectedValue(
      new DashboardInsightApiError("登录已失效，请重新登录", 401),
    );
    render(<ExploreClient />);
    fireEvent.change(screen.getByLabelText("想看什么图表？"), { target: { value: "销售额" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图表" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/login");
    await waitFor(() => expect(api.executeDashboardInsight).not.toHaveBeenCalled());
  });
});
